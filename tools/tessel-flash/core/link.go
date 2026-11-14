package core

import (
	"fmt"
	"time"
)

const (
	ConsoleBaud  = 115200
	TransferBaud = 460800
)

type LinkOpts struct {
	// Wait is how long to spam the link before giving up.
	Wait time.Duration
	// Try is one link attempt's length (bk7231tools' link_timeout).
	Try time.Duration
	// Kick sends one "reboot" on the firmware console first. Off by default: kicks rebooted the R1 before the ROM
	// could link (firmware 0.3.74); the hub's reboot or a power cycle is the normal way in.
	Kick         bool
	TransferBaud int
}

// Kick asks the firmware console to reboot, so the ROM listens; harmless when the chip is already in the ROM.
func Kick(p Port, clk Clock, rep Reporter) {
	_ = p.SetDTR(false)
	_ = p.SetRTS(false)
	if err := p.SetBaud(ConsoleBaud); err != nil {
		rep.Log("kick: " + err.Error())
		return
	}
	if _, err := p.Write([]byte("\r\nreboot\r\n")); err != nil {
		rep.Log("kick: " + err.Error())
		return
	}
	rep.Log("kick: reboot sent on the console")
}

// Link spams the bootrom link until it answers, as the bench flasher does since 14 Nov:
//   - every sixth try links at the transfer baud, because a link that set the ROM's baud and then failed leaves the
//     ROM there, silent at 115,200, until a link at that baud reboots it (14 Nov 03:50-04:09);
//   - the port is reopened at once when the USB bridge drops off on a board reset, since the ROM listens only briefly
//     after each reset (a boot-looping chip shows it only in those windows);
//   - any failure once linked reboots the chip, so it is never left silent in the ROM.
func Link(p Port, clk Clock, rep Reporter, o LinkOpts) (*ROM, error) {
	if o.Try == 0 {
		o.Try = 2 * time.Second
	}
	if o.TransferBaud == 0 {
		o.TransferBaud = TransferBaud
	}
	if o.Kick {
		Kick(p, clk, rep)
	}
	rep.Phase("link", "waiting for its loader…")
	deadline := clk.Now().Add(o.Wait)
	open, last := true, ""
	for tries := 1; clk.Now().Before(deadline); tries++ {
		if !open {
			if err := p.Reopen(); err != nil {
				clk.Sleep(50 * time.Millisecond)
				continue
			}
			open = true
			_ = p.SetDTR(false)
			_ = p.SetRTS(false)
		}
		rate := ConsoleBaud
		if tries%6 == 0 {
			rate = o.TransferBaud
		}
		r := newROM(p, clk, rep, o.TransferBaud)
		err := r.c.setBaud(rate)
		var ok bool
		if err == nil {
			ok, err = r.waitForLink(o.Try)
		}
		if err != nil {
			if msg := err.Error(); msg != last {
				rep.Log("link attempt: " + msg)
				last = msg
			}
			open = false
			clk.Sleep(50 * time.Millisecond)
			continue
		}
		if !ok {
			continue
		}
		r.LinkBaud = rate
		rep.Log(fmt.Sprintf("linked at %d baud", rate))
		if err := r.finish(); err != nil {
			_ = r.Reboot()
			return nil, fmt.Errorf("linked, then %w; the chip was rebooted out of the loader", err)
		}
		rep.Log("connected: " + r.ChipInfo())
		return r, nil
	}
	return nil, ErrNoLink
}
