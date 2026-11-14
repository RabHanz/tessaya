package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
)

// The R1's flash map, as the bench flasher (r1flash.py) holds it: 8 MiB; usr_config, the AP easyflash (device id,
// broker, Wi-Fi), RF calibration and net params live at 0x7E7000-0x800000; the image ends near 0x440000.
const (
	R1FlashSize   = 0x800000
	SettingsStart = 0x7E7000
	SettingsLen   = 0x19000
	chunk         = 0x40000
)

// CheckImage refuses an empty image or one that would reach the settings area.
func CheckImage(img []byte) error {
	if len(img) < 0x10 || bytes.Equal(img[:0x10], bytes.Repeat([]byte{0xff}, 0x10)) {
		return refuse("refusing: the image is empty")
	}
	if len(img) > SettingsStart {
		return refuse("refusing: the image reaches the settings area")
	}
	return nil
}

func (r *ROM) checkChip() error {
	if r.FlashSize != R1FlashSize {
		return refuse("refusing: the flash is 0x%X; the R1 has 8 MiB", r.FlashSize)
	}
	if !r.KnownFlash() {
		return refuse("refusing: flash ID %x is not one r1flash knows how to unprotect", r.FlashID)
	}
	return nil
}

func shortHash(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:8])
}

// rebootOnError leaves the ROM after any failure, so the chip is never left silent in the loader.
func (r *ROM) rebootOnError(err *error) {
	if *err != nil {
		if e := r.Reboot(); e != nil {
			r.rep.Log("reboot after failure: " + e.Error())
		}
	}
}

// Backup reads the settings area into the store; it returns the file name.
func (r *ROM) Backup(st Store, stamp string) (name string, err error) {
	defer r.rebootOnError(&err)
	if err = r.checkChip(); err != nil {
		return "", err
	}
	r.rep.Phase("backup", "saving its settings")
	data, err := r.Read(SettingsStart, SettingsLen)
	if err != nil {
		return "", err
	}
	name = "settings-" + stamp + ".bin"
	if err = st.Write(name, data); err != nil {
		return "", err
	}
	state := "has data"
	if bytes.Equal(data, bytes.Repeat([]byte{0xff}, SettingsLen)) {
		state = "empty"
	}
	r.rep.Log(fmt.Sprintf("backup %s %s %s", name, shortHash(data), state))
	r.rep.Phase("reboot", "restarting")
	return name, r.Reboot()
}

// Flash backs up the settings, writes the image at 0x0 in 256 KB chunks (resuming after a dropped link), checks the
// settings are untouched (restoring them if not) and reboots. It returns the backup's file name.
func (r *ROM) Flash(img []byte, st Store, stamp string) (backup string, err error) {
	if err = CheckImage(img); err != nil {
		return "", err
	}
	if err = r.checkChip(); err != nil {
		return "", err
	}
	defer r.rebootOnError(&err)
	r.rep.Phase("backup", "saving its settings")
	before, err := r.Read(SettingsStart, SettingsLen)
	if err != nil {
		return "", err
	}
	backup = "settings-" + stamp + ".bin"
	if err = st.Write(backup, before); err != nil {
		return "", err
	}
	r.rep.Log(fmt.Sprintf("backup %s %s", backup, shortHash(before)))

	prog := "progress-" + shortHash(img) + ".txt"
	done := 0
	if b, e := st.Read(prog); e == nil {
		if n, e := strconv.Atoi(string(bytes.TrimSpace(b))); e == nil && n > 0 && n < len(img) && n%chunk == 0 {
			done = n
			r.rep.Log(fmt.Sprintf("resuming at 0x%X", done))
		}
	}
	r.rep.Phase("write", fmt.Sprintf("writing %d bytes at 0x0", len(img)))
	for off := done; off < len(img); off += chunk {
		end := min(off+chunk, len(img))
		if err = r.program(uint32(off), img[off:end], func(n int) { r.rep.Progress("write", off+n, len(img)) }); err != nil {
			return backup, err
		}
		if err = st.Write(prog, []byte(strconv.Itoa(end))); err != nil {
			return backup, err
		}
	}
	_ = st.Remove(prog)

	r.rep.Phase("verify", "checking its settings are untouched")
	after, err := r.Read(SettingsStart, SettingsLen)
	if err != nil {
		return backup, err
	}
	if !bytes.Equal(after, before) {
		r.rep.Log("the write changed the settings: restoring the backup")
		if err = r.restore(before); err != nil {
			return backup, fmt.Errorf("RESTORE FAILED: keep the cable on and run restore %s: %w", backup, err)
		}
	}
	r.rep.Phase("reboot", "restarting")
	return backup, r.Reboot()
}

func (r *ROM) restore(data []byte) error {
	if err := r.program(SettingsStart, data, nil); err != nil {
		return err
	}
	back, err := r.Read(SettingsStart, SettingsLen)
	if err != nil {
		return err
	}
	if !bytes.Equal(back, data) {
		return fmt.Errorf("the settings read back differ")
	}
	return nil
}

// Restore writes a settings backup back and reboots.
func (r *ROM) Restore(data []byte) (err error) {
	if len(data) != SettingsLen {
		return refuse("refusing: not a settings backup (%d bytes, want %d)", len(data), SettingsLen)
	}
	if err = r.checkChip(); err != nil {
		return err
	}
	defer r.rebootOnError(&err)
	r.rep.Phase("write", "restoring its settings")
	if err = r.restore(data); err != nil {
		return err
	}
	r.rep.Phase("reboot", "restarting")
	return r.Reboot()
}
