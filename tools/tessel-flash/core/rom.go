package core

// The BK72xx bootrom protocol, ported from bk7231tools 2.1.2 (MIT, Kuba Szczodrzyński): only the commands the R1's
// cable flash uses. The R1's BK7258 bootloader is not in bk7231tools' CRC table, so the protocol is always guessed
// from the CRC range convention, as bk7231tools does for an unknown bootloader.

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"time"
)

type Protocol int

const (
	ProtoUnknown Protocol = iota
	// ProtoFull is the BootROM protocol: CRC ranges end-inclusive, registers, flash ID and status registers.
	ProtoFull
	// ProtoBasic is a Beken bootloader's minimal set.
	ProtoBasic
)

func (p Protocol) String() string {
	return [...]string{"unknown", "full", "basic"}[p]
}

var (
	cmdPre   = []byte{0x01, 0xe0, 0xfc}
	respPre  = []byte{0x04, 0x0e}
	respLong = []byte{0xf4}
)

const (
	erase4K       = 0x20
	crc32FF4K     = 0xF154670A
	readRetries   = 20
	writeRetries  = 3
	crcSpeedBps   = 400_000
	chipIDReg     = 0x800000
	cmdTimeout    = time.Second
	srUnprotect   = 0b0100000001111100
	linkTryTimout = 5 * time.Millisecond
)

// flashSRSize: flash IDs bk7231tools knows how to unprotect, and their status register size.
var flashSRSize = map[[3]byte]int{
	{0x0b, 0x40, 0x14}: 2, {0x0b, 0x40, 0x15}: 2, {0x0b, 0x40, 0x16}: 2, {0x0b, 0x40, 0x17}: 2,
	{0x0b, 0x60, 0x17}: 2, {0x0e, 0x40, 0x16}: 2, {0x1c, 0x31, 0x13}: 1, {0x1c, 0x41, 0x16}: 1,
	{0x1c, 0x70, 0x15}: 1, {0x1c, 0x70, 0x16}: 1, {0x20, 0x40, 0x16}: 2, {0x51, 0x40, 0x13}: 1,
	{0x51, 0x40, 0x14}: 1, {0x5e, 0x40, 0x14}: 1, {0x85, 0x42, 0x15}: 1, {0x85, 0x20, 0x15}: 2,
	{0x85, 0x60, 0x13}: 2, {0x85, 0x60, 0x14}: 2, {0x85, 0x60, 0x16}: 2, {0x85, 0x60, 0x17}: 2,
	{0xc2, 0x23, 0x14}: 2, {0xc2, 0x23, 0x15}: 2, {0xc8, 0x40, 0x13}: 1, {0xc8, 0x40, 0x14}: 2,
	{0xc8, 0x40, 0x15}: 2, {0xc8, 0x40, 0x16}: 1, {0xc8, 0x65, 0x15}: 2, {0xc8, 0x65, 0x16}: 2,
	{0xc8, 0x65, 0x17}: 2, {0xcd, 0x60, 0x14}: 2, {0xe0, 0x40, 0x13}: 1, {0xe0, 0x40, 0x14}: 1,
	{0xeb, 0x60, 0x15}: 2, {0xef, 0x40, 0x16}: 2, {0xef, 0x40, 0x18}: 2,
}

// ROM is a linked bootrom.
type ROM struct {
	c            *conn
	rep          Reporter
	Proto        Protocol
	FlashSize    int
	FlashID      []byte
	ChipID       uint32
	TransferBaud int
	LinkBaud     int
	bypass       bool
	eraseChecked bool
}

func newROM(p Port, clk Clock, rep Reporter, transfer int) *ROM {
	return &ROM{c: newConn(p, clk), rep: rep, TransferBaud: transfer, bypass: true}
}

// ChipInfo is a one-line description for logs and the audit.
func (r *ROM) ChipInfo() string {
	return fmt.Sprintf("protocol %s, chip id 0x%x, flash id %x, flash 0x%X", r.Proto, r.ChipID, r.FlashID, r.FlashSize)
}

func le32(v uint32) []byte { return binary.LittleEndian.AppendUint32(nil, v) }

// fix offsets addresses past the flash size, which bypasses the bootloader's own write protection (bk7231tools'
// boot_protection_bypass).
func (r *ROM) fix(a uint32) uint32 {
	if r.FlashSize == 0 || !r.bypass {
		return a
	}
	return a + uint32(r.FlashSize)
}

func (r *ROM) supports(code byte, long bool) bool {
	if r.Proto != ProtoBasic {
		return true
	}
	if long {
		return code == 0x06 || code == 0x07 || code == 0x09 || code == 0x0f
	}
	return code == 0x00 || code == 0x0e || code == 0x0f || code == 0x10
}

func encode(code byte, long bool, data []byte) []byte {
	out := append([]byte{}, cmdPre...)
	size := len(data) + 1
	if size >= 0xff || long {
		out = append(out, 0xff, 0xf4, byte(size), byte(size>>8))
	} else {
		out = append(out, byte(size))
	}
	out = append(out, code)
	return append(out, data...)
}

type req struct {
	code     byte
	long     bool
	data     []byte
	resp     int // the response code to wait for; -1 for none
	sameFrom int // response[sameFrom:sameTo] must equal data[:sameTo-sameFrom]
	sameTo   int
	status   bool // the response's first byte is a status that must be 0
	after    func() error
}

func (r *ROM) do(q req) ([]byte, error) {
	if !r.supports(q.code, q.long) {
		return nil, fmt.Errorf("command 0x%02x not in the %s protocol", q.code, r.Proto)
	}
	if err := r.c.write(encode(q.code, q.long, q.data)); err != nil {
		return nil, err
	}
	if q.after != nil {
		if err := q.after(); err != nil {
			return nil, err
		}
	}
	if q.resp < 0 {
		return nil, nil
	}
	var size int
	for {
		d, err := r.c.readUntil(respPre)
		if err != nil {
			return nil, err
		}
		if !bytes.HasSuffix(d, respPre) {
			return nil, perr("no response")
		}
		s, err := r.c.readByte()
		if err != nil {
			return nil, err
		}
		if q.long != (s == 0xff) {
			continue
		}
		if d, err = r.c.readUntil(cmdPre); err != nil {
			return nil, err
		} else if !bytes.Equal(d, cmdPre) {
			continue
		}
		var code int
		if q.long {
			if d, err = r.c.readUntil(respLong); err != nil {
				return nil, err
			} else if !bytes.Equal(d, respLong) {
				continue
			}
			h, err := r.c.readN(3)
			if err != nil {
				return nil, err
			}
			if len(h) < 3 {
				return nil, perr("no response")
			}
			size = int(binary.LittleEndian.Uint16(h)) - 1
			code = int(h[2])
		} else {
			b, err := r.c.readByte()
			if err != nil {
				return nil, err
			}
			code = int(b)
			size = int(s) - 4
		}
		if code == q.resp && size >= 0 {
			break
		}
	}
	resp, err := r.c.readN(size)
	if err != nil {
		return nil, err
	}
	if len(resp) != size {
		return nil, perr("incomplete response: %d of %d bytes", len(resp), size)
	}
	if q.sameTo > 0 {
		n := q.sameTo - q.sameFrom
		if len(resp) < q.sameTo || len(q.data) < n || !bytes.Equal(resp[q.sameFrom:q.sameTo], q.data[:n]) {
			return nil, perr("invalid response payload")
		}
	}
	if q.status && (len(resp) == 0 || resp[0] != 0) {
		return nil, perr("non-zero status in the response")
	}
	return resp, nil
}

func (r *ROM) linkCheck() (bool, error) {
	resp, err := r.do(req{code: 0x00, resp: 0x01})
	if err != nil {
		if isProto(err) {
			return false, nil
		}
		return false, err
	}
	return len(resp) == 1 && resp[0] == 0, nil
}

// waitForLink spams the link check until the ROM answers or d passes.
func (r *ROM) waitForLink(d time.Duration) (bool, error) {
	deadline := r.c.clk.Now().Add(d)
	prev := r.c.timeout
	r.c.timeout = linkTryTimout
	defer func() { r.c.timeout = prev }()
	for r.c.clk.Now().Before(deadline) {
		ok, err := r.linkCheck()
		if err != nil {
			return false, err
		}
		if ok {
			r.c.drain()
			return true, nil
		}
	}
	r.c.drain()
	return false, nil
}

func (r *ROM) setBaud(b int) error {
	data := append(le32(uint32(b)), 20)
	_, err := r.do(req{code: 0x0f, data: data, resp: 0x0f, sameFrom: 0, sameTo: 5, after: func() error {
		r.c.clk.Sleep(10 * time.Millisecond)
		return r.c.setBaud(b)
	}})
	return err
}

// Reboot leaves the bootrom and starts the firmware.
func (r *ROM) Reboot() error {
	_, err := r.do(req{code: 0x0e, data: []byte{0xa5}, resp: -1})
	return err
}

func (r *ROM) readReg(a uint32) (uint32, error) {
	resp, err := r.do(req{code: 0x03, data: le32(a), resp: 0x03, sameFrom: 0, sameTo: 4})
	if err != nil {
		return 0, err
	}
	if len(resp) != 8 {
		return 0, perr("bad register response")
	}
	return binary.LittleEndian.Uint32(resp[4:]), nil
}

// checkCRC returns the CRC-32 of [start, end) as binascii.crc32 computes it.
func (r *ROM) checkCRC(start, end uint32) (uint32, error) {
	if start >= end {
		return 0, fmt.Errorf("bad CRC range 0x%X-0x%X", start, end)
	}
	prev := r.c.timeout
	if need := time.Duration(float64(end-start) / crcSpeedBps * float64(time.Second)); need > prev {
		r.c.timeout = need.Round(time.Second) + time.Second
	}
	if r.Proto == ProtoFull {
		end--
	}
	resp, err := r.do(req{code: 0x10, data: append(le32(r.fix(start)), le32(r.fix(end))...), resp: 0x10})
	r.c.timeout = prev
	if err != nil {
		return 0, err
	}
	if len(resp) != 4 {
		return 0, perr("bad CRC response")
	}
	// Bootloaders other than the BootROM protect the flash after a CRC until the next link check.
	if r.Proto != ProtoFull {
		if _, err := r.waitForLink(cmdTimeout); err != nil {
			return 0, err
		}
	}
	return binary.LittleEndian.Uint32(resp) ^ 0xFFFFFFFF, nil
}

func (r *ROM) checkData(start uint32, data []byte) error {
	chip, err := r.checkCRC(start, start+uint32(len(data)))
	if err != nil {
		return err
	}
	if calc := crc32.ChecksumIEEE(data); chip != calc {
		return perr("chip CRC %08X does not match %08X at 0x%X", chip, calc, start)
	}
	return nil
}

func (r *ROM) read4K(start uint32, crc bool) ([]byte, error) {
	for attempt := 0; ; attempt++ {
		data, err := r.read4KOnce(start, crc)
		if err == nil || !isProto(err) || attempt >= readRetries {
			return data, err
		}
		r.rep.Log(fmt.Sprintf("read at 0x%X failed (%v), retrying", start, err))
	}
}

func (r *ROM) read4KOnce(start uint32, crc bool) ([]byte, error) {
	resp, err := r.do(req{code: 0x09, long: true, data: le32(r.fix(start)), resp: 0x09, sameFrom: 1, sameTo: 5, status: true})
	if err != nil {
		return nil, err
	}
	if len(resp) != 5+0x1000 {
		return nil, perr("read returned %d bytes", len(resp)-5)
	}
	data := resp[5:]
	if crc {
		if err := r.checkData(start, data); err != nil {
			return nil, err
		}
	}
	return data, nil
}

// Read reads [start, start+length) with a CRC check per 4K block.
func (r *ROM) Read(start uint32, length int) ([]byte, error) {
	if r.FlashSize != 0 && int(start)+length > r.FlashSize {
		return nil, fmt.Errorf("read past the flash end")
	}
	out := make([]byte, 0, length)
	block, skip := start&^0xFFF, int(start&0xFFF)
	for len(out) < length {
		data, err := r.read4K(block, true)
		if err != nil {
			return nil, err
		}
		data = data[skip:]
		out = append(out, data[:min(len(data), length-len(out))]...)
		skip = 0
		block += 0x1000
	}
	return out, nil
}

func (r *ROM) write4K(start uint32, data []byte) error {
	if start&0xFFF != 0 || len(data) > 0x1000 {
		return fmt.Errorf("bad 4K write at 0x%X", start)
	}
	block := append(append([]byte(nil), data...), bytes.Repeat([]byte{0xff}, 0x1000-len(data))...)
	for attempt := 0; ; attempt++ {
		_, err := r.do(req{code: 0x07, long: true, data: append(le32(r.fix(start)), block...), resp: 0x07, sameFrom: 1, sameTo: 5, status: true})
		if err == nil {
			err = r.checkData(start, block)
		}
		if err == nil || !isProto(err) || attempt >= writeRetries {
			return err
		}
		r.rep.Log(fmt.Sprintf("write at 0x%X failed (%v), retrying", start, err))
		if err := r.erase(start); err != nil {
			return err
		}
	}
}

func (r *ROM) eraseOnce(start uint32) error {
	_, err := r.do(req{code: 0x0f, long: true, data: append([]byte{erase4K}, le32(r.fix(start))...), resp: 0x0f, sameFrom: 1, sameTo: 6})
	return err
}

// erase clears one 4K sector. The first erase on the BootROM is verified by CRC, since a protected flash ignores it.
func (r *ROM) erase(start uint32) error {
	for attempt := 0; ; attempt++ {
		err := r.eraseVerified(start)
		if err == nil || !isProto(err) || attempt >= writeRetries {
			return err
		}
		r.rep.Log(fmt.Sprintf("erase at 0x%X failed (%v), retrying", start, err))
	}
}

func (r *ROM) eraseVerified(start uint32) error {
	if r.eraseChecked || r.Proto != ProtoFull {
		return r.eraseOnce(start)
	}
	pre, err := r.checkCRC(start, start+0x1000)
	if err != nil {
		return err
	}
	if pre == crc32FF4K {
		return nil
	}
	if err := r.eraseOnce(start); err != nil {
		return err
	}
	post, err := r.checkCRC(start, start+0x1000)
	if err != nil {
		return err
	}
	if post != crc32FF4K {
		return perr("erase failed at 0x%X: the flash is protected", start)
	}
	r.eraseChecked = true
	return nil
}

func (r *ROM) readSR8(cmd byte) (byte, error) {
	resp, err := r.do(req{code: 0x0c, long: true, data: []byte{cmd}, resp: 0x0c, sameFrom: 1, sameTo: 2})
	if err != nil {
		return 0, err
	}
	if len(resp) != 3 {
		return 0, perr("bad status register response")
	}
	return resp[2], nil
}

func (r *ROM) readSR(size int) (int, error) {
	lo, err := r.readSR8(0x05)
	if err != nil || size == 1 {
		return int(lo), err
	}
	hi, err := r.readSR8(0x35)
	return int(lo) | int(hi)<<8, err
}

func (r *ROM) writeSR(sr, size, mask int) error {
	var data []byte
	if size == 1 {
		data = []byte{0x01, byte(sr)}
	} else {
		data = []byte{0x01, byte(sr), byte(sr >> 8)}
	}
	resp, err := r.do(req{code: 0x0d, long: true, data: data, resp: 0x0d, sameFrom: 1, sameTo: len(data) + 1})
	if err != nil {
		return err
	}
	if !bytes.Equal(resp[2:], data[1:]) {
		return perr("status register write not echoed")
	}
	got, err := r.readSR(size)
	if err != nil {
		return err
	}
	if sr&mask != got&mask {
		return fmt.Errorf("writing the flash status register failed: wrote 0x%04X, got 0x%04X", sr, got)
	}
	return nil
}

func (r *ROM) flashID() ([]byte, error) {
	resp, err := r.do(req{code: 0x0e, long: true, data: le32(0x9f), resp: 0x0e})
	if err != nil {
		return nil, err
	}
	if len(resp) != 5 {
		return nil, perr("bad flash ID response")
	}
	return resp[2:5], nil
}

// KnownFlash reports whether the flash's protection can be lifted (only the BootROM protocol needs it).
func (r *ROM) KnownFlash() bool {
	if r.Proto != ProtoFull {
		return true
	}
	_, ok := flashSRSize[[3]byte(r.FlashID)]
	return len(r.FlashID) == 3 && ok
}

func (r *ROM) unprotect() error {
	size, ok := flashSRSize[[3]byte(r.FlashID)]
	if len(r.FlashID) != 3 || !ok {
		return fmt.Errorf("flash ID not known: %x", r.FlashID)
	}
	sr, err := r.readSR(size)
	if err != nil {
		return err
	}
	return r.writeSR(sr&^srUnprotect, size, srUnprotect)
}

// detect guesses the protocol from the CRC range convention and reads the chip ID.
func (r *ROM) detect() error {
	boot, err := r.checkCRC(0, 256)
	if err != nil {
		return err
	}
	r.rep.Log(fmt.Sprintf("bootloader CRC 0x%08X", boot))
	const at = 0x11000
	crc, err := r.checkCRC(at, at+256)
	if err != nil {
		return err
	}
	data, err := r.read4K(at, false)
	if err != nil {
		return err
	}
	switch crc {
	case crc32.ChecksumIEEE(data[:257]):
		r.Proto = ProtoFull
	case crc32.ChecksumIEEE(data[:256]):
		r.Proto = ProtoBasic
	default:
		return perr("CRC mismatch while checking the chip type")
	}
	if r.Proto == ProtoFull {
		if r.ChipID, err = r.readReg(chipIDReg); err != nil {
			return err
		}
	}
	return nil
}

func (r *ROM) detectSize() (int, error) {
	r.bypass = false
	defer func() { r.bypass = true }()
	const at = 0x11000
	start, err := r.read4K(at, false)
	if err != nil {
		return 0, err
	}
	for _, mib := range []int{2, 4, 8, 16} {
		size := mib << 20
		check, err := r.read4K(uint32(size+at), false)
		if err != nil {
			return 0, err
		}
		if bytes.Equal(start, check) {
			return size, nil
		}
	}
	return 0, fmt.Errorf("could not detect the flash size")
}

// finish runs after the first link: the transfer baud, the protocol, the flash ID and size.
func (r *ROM) finish() error {
	if r.c.baud != r.TransferBaud {
		if err := r.setBaud(r.TransferBaud); err != nil {
			return fmt.Errorf("switching to %d baud: %w", r.TransferBaud, err)
		}
	}
	if err := r.detect(); err != nil {
		return err
	}
	if r.supports(0x0e, true) {
		id, err := r.flashID()
		if err != nil {
			return err
		}
		r.FlashID = id
		r.FlashSize = 1 << id[2]
		return nil
	}
	size, err := r.detectSize()
	r.FlashSize = size
	return err
}

// program erases and writes data at addr in 4K sectors, each write CRC-checked; empty sectors are only erased.
func (r *ROM) program(addr uint32, data []byte, progress func(done int)) error {
	if addr&0xFFF != 0 {
		return fmt.Errorf("start 0x%X is not 4K aligned", addr)
	}
	if r.FlashSize != 0 && int(addr)+len(data) > r.FlashSize {
		return fmt.Errorf("data is larger than the flash")
	}
	if r.Proto == ProtoFull {
		if err := r.unprotect(); err != nil {
			return err
		}
	}
	for off := 0; off < len(data); off += 0x1000 {
		block := data[off:min(off+0x1000, len(data))]
		at := addr + uint32(off)
		if err := r.erase(at); err != nil {
			return err
		}
		if len(bytes.Trim(block, "\xff")) != 0 {
			if err := r.write4K(at, block); err != nil {
				return err
			}
		}
		if progress != nil {
			progress(off + len(block))
		}
	}
	return nil
}
