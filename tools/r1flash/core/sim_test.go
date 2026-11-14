package core

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"strings"
	"time"
)

// simClock advances only when the simulator says time passed: no test waits on the wall clock.
type simClock struct{ t time.Time }

func (c *simClock) Now() time.Time        { return c.t }
func (c *simClock) Sleep(d time.Duration) { c.t = c.t.Add(d) }

var errGone = errors.New("port gone")

// sim is the R1 on a USB cable: its firmware console, its bootrom (the BootROM or a basic bootloader protocol), and
// the CH340 that drops off USB on a board reset.
type sim struct {
	clk     *simClock
	mem     []byte
	full    bool
	mid     [3]byte
	sr      int
	mode    string // fw, rom, dead
	romBaud int
	port    int
	timeout time.Duration
	in, out []byte
	pending []byte // the baud switch's reply, sent at the new rate
	console []byte

	reenum   bool // a reset re-enumerates the USB bridge: reads and writes fail until Reopen
	gone     bool
	reopens  int
	status   string
	bootText string
	booting  []byte // printed once the console is read at its rate

	// windows: in the dead (boot-looping) mode the ROM listens for windowLen out of every windowEvery.
	windowEvery, windowLen time.Duration
	start                  time.Time

	dropAfter int // after this many 4K writes the link dies (-1: never)
	dropped   bool
	clobber   bool
	writes    []uint32
	maxBaud   int
	rebooted  int
}

func newSim() *sim {
	clk := &simClock{t: time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)}
	s := &sim{
		clk: clk, mem: bytes.Repeat([]byte{0xff}, R1FlashSize), full: true, mid: [3]byte{0x0b, 0x40, 0x17}, sr: 0x1c,
		mode: "rom", romBaud: ConsoleBaud, port: ConsoleBaud, timeout: time.Second, dropAfter: -1, start: clk.t,
		status: `{"fw":"smp-0.3.95","session":false,"call":false,"battery":80,"charging":true}`,
	}
	// a bootloader and an app header, so the protocol guess has data to compare
	for i := 0; i < 0x200; i++ {
		s.mem[i] = byte(i * 7)
		s.mem[0x11000+i] = byte(i*13 + 1)
	}
	copy(s.mem[SettingsStart:], "freya.cfg-sample")
	return s
}

func (s *sim) inWindow() bool {
	if s.mode != "dead" || s.windowEvery == 0 {
		return s.mode == "rom"
	}
	return s.clk.t.Sub(s.start)%s.windowEvery < s.windowLen
}

func (s *sim) Read(p []byte) (int, error) {
	if s.gone {
		return 0, errGone
	}
	if s.booting != nil && s.port == ConsoleBaud {
		s.out, s.booting = append(s.out, s.booting...), nil
	}
	if len(s.out) > 0 {
		n := copy(p, s.out)
		s.out = s.out[n:]
		return n, nil
	}
	s.clk.Sleep(s.timeout)
	return 0, nil
}

func (s *sim) Write(p []byte) (int, error) {
	if s.gone {
		return 0, errGone
	}
	switch {
	case s.mode == "fw":
		if s.port == ConsoleBaud {
			s.console = append(s.console, p...)
			s.runConsole()
		}
	case s.inWindow() && !s.dropped:
		if s.mode == "dead" {
			s.mode = "rom" // the link caught the window: the ROM stays
		}
		if s.port == s.romBaud {
			s.in = append(s.in, p...)
			s.runROM()
		}
	}
	return len(p), nil
}

func (s *sim) SetBaud(b int) error {
	if s.gone {
		return errGone
	}
	s.port = b
	s.out = nil // bytes in flight at the old rate are garbage
	if s.pending != nil && b == s.romBaud {
		s.out, s.pending = s.pending, nil
	}
	s.maxBaud = max(s.maxBaud, b)
	return nil
}
func (s *sim) SetDTR(bool) error                    { return nil }
func (s *sim) SetRTS(bool) error                    { return nil }
func (s *sim) SetReadTimeout(d time.Duration) error { s.timeout = d; return nil }
func (s *sim) Close() error                         { return nil }
func (s *sim) Reopen() error                        { s.gone = false; s.reopens++; s.out = nil; return nil }

func (s *sim) reset(to string) {
	s.mode, s.romBaud, s.in, s.out = to, ConsoleBaud, nil, nil
	s.gone = s.reenum
}

func (s *sim) runConsole() {
	for {
		i := bytes.IndexByte(s.console, '\n')
		if i < 0 {
			return
		}
		line := strings.TrimSpace(string(s.console[:i]))
		s.console = s.console[i+1:]
		switch {
		case line == "reboot":
			s.reset("rom")
		case line == "r1cfg status":
			s.out = append(s.out, s.status+"\r\n"...)
		case strings.HasPrefix(line, "r1cfg ") || strings.HasPrefix(line, "r1ep "):
			s.out = append(s.out, `{"ok":true}`+"\r\n"...)
		}
	}
}

func (s *sim) addr(a uint32) int { return int(a) % len(s.mem) }

func (s *sim) reply(code byte, long bool, payload []byte) {
	if long {
		n := len(payload) + 1
		s.out = append(s.out, 0x04, 0x0e, 0xff, 0x01, 0xe0, 0xfc, 0xf4, byte(n), byte(n>>8), code)
	} else {
		s.out = append(s.out, 0x04, 0x0e, byte(4+len(payload)), 0x01, 0xe0, 0xfc, code)
	}
	s.out = append(s.out, payload...)
}

func (s *sim) runROM() {
	for {
		i := bytes.Index(s.in, cmdPre)
		if i < 0 || len(s.in) < i+5 {
			return
		}
		s.in = s.in[i:]
		var code byte
		var data []byte
		long := s.in[3] == 0xff
		if long {
			if len(s.in) < 8 {
				return
			}
			n := int(binary.LittleEndian.Uint16(s.in[5:7]))
			if len(s.in) < 7+n {
				return
			}
			code, data = s.in[7], s.in[8:7+n]
			s.in = s.in[7+n:]
		} else {
			n := int(s.in[3])
			if len(s.in) < 4+n {
				return
			}
			code, data = s.in[4], s.in[5:4+n]
			s.in = s.in[4+n:]
		}
		s.handle(code, long, append([]byte(nil), data...))
		if s.mode != "rom" || s.dropped {
			return
		}
	}
}

func (s *sim) protected() bool { return s.sr&0x7c != 0 }

func (s *sim) handle(code byte, long bool, d []byte) {
	u := func(at int) uint32 { return binary.LittleEndian.Uint32(d[at:]) }
	basicOK := map[byte]bool{0x06: long, 0x07: long, 0x09: long, 0x0f: true, 0x00: !long, 0x0e: !long, 0x10: !long}
	if !s.full && !basicOK[code] {
		return
	}
	switch {
	case !long && code == 0x00:
		s.reply(0x01, false, []byte{0})
	case !long && code == 0x0f:
		s.reply(0x0f, false, d[:5])
		s.pending, s.out = s.out, nil
		s.romBaud = int(u(0))
	case !long && code == 0x03:
		s.reply(0x03, false, append(d[:4:4], binary.LittleEndian.AppendUint32(nil, 0x7258)...))
	case !long && code == 0x0e:
		s.rebooted++
		s.reset("fw")
		s.booting = []byte(s.bootText)
	case !long && code == 0x10:
		a := s.addr(u(0))
		b := a + int(u(4)-u(0))
		if s.full {
			b++
		}
		s.reply(0x10, false, binary.LittleEndian.AppendUint32(nil, crc32.ChecksumIEEE(s.mem[a:b])^0xffffffff))
	case long && code == 0x09:
		a := s.addr(u(0))
		s.reply(0x09, true, append(append([]byte{0}, d[:4]...), s.mem[a:a+0x1000]...))
	case long && code == 0x07:
		if s.dropAfter >= 0 && len(s.writes) >= s.dropAfter {
			s.dropped = true
			return
		}
		a := s.addr(u(0))
		s.writes = append(s.writes, uint32(a))
		if !s.protected() {
			copy(s.mem[a:], d[4:])
			if s.clobber && a == 0 {
				copy(s.mem[SettingsStart:], bytes.Repeat([]byte{0xff}, SettingsLen))
			}
		}
		s.reply(0x07, true, append([]byte{0}, d[:4]...))
	case long && code == 0x0f:
		a := s.addr(u(1))
		if !s.protected() {
			copy(s.mem[a:a+0x1000], bytes.Repeat([]byte{0xff}, 0x1000))
		}
		s.reply(0x0f, true, append([]byte{0}, d[:5]...))
	case long && code == 0x0e:
		s.reply(0x0e, true, []byte{0, 0, s.mid[0], s.mid[1], s.mid[2]})
	case long && code == 0x0c:
		v := s.sr
		if d[0] == 0x35 {
			v >>= 8
		}
		s.reply(0x0c, true, []byte{0, d[0], byte(v)})
	case long && code == 0x0d:
		if len(d) == 2 {
			s.sr = s.sr&^0xff | int(d[1])
		} else {
			s.sr = int(d[1]) | int(d[2])<<8
		}
		s.reply(0x0d, true, append([]byte{0}, d...))
	default:
		panic(fmt.Sprintf("sim: unhandled command 0x%02x long=%v", code, long))
	}
}

type memStore map[string][]byte

func (m memStore) Read(n string) ([]byte, error) {
	if b, ok := m[n]; ok {
		return b, nil
	}
	return nil, errors.New("not found")
}
func (m memStore) Write(n string, b []byte) error { m[n] = append([]byte(nil), b...); return nil }
func (m memStore) Remove(n string) error          { delete(m, n); return nil }

type logRep struct{ lines []string }

func (l *logRep) Phase(p, m string)         { l.lines = append(l.lines, "phase "+p+": "+m) }
func (l *logRep) Progress(string, int, int) {}
func (l *logRep) Log(m string)              { l.lines = append(l.lines, m) }
func (l *logRep) has(s string) bool {
	for _, x := range l.lines {
		if strings.Contains(x, s) {
			return true
		}
	}
	return false
}
