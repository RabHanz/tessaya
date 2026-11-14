// Package core is tessel-flash's protocol logic: the BK7258 bootrom protocol, the flash flow, the firmware console and the
// signed release list. It has no OS dependencies (the CLI supplies the port, clock and file store), so it also builds
// for GOOS=js GOARCH=wasm, for a later Web Serial client.
package core

import (
	"errors"
	"fmt"
	"time"
)

// Port is a serial port. Read returns 0, nil when the read timeout passes with no data. Reopen opens the same port
// again after the USB bridge dropped off the bus (a board reset re-enumerates the CH340).
type Port interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	SetBaud(baud int) error
	SetDTR(on bool) error
	SetRTS(on bool) error
	SetReadTimeout(d time.Duration) error
	Close() error
	Reopen() error
}

type Clock interface {
	Now() time.Time
	Sleep(d time.Duration)
}

// Store keeps settings backups and the resume marker, by file name.
type Store interface {
	Read(name string) ([]byte, error)
	Write(name string, data []byte) error
	Remove(name string) error
}

// Reporter receives what a run does. Phases: detect, link, backup, write, verify, reboot, boot, done.
type Reporter interface {
	Phase(phase, msg string)
	Progress(phase string, done, total int)
	Log(msg string)
}

// ErrNoLink: the bootrom never answered in the link window.
var ErrNoLink = errors.New("no link with the Tessel's loader")

// Refused is a safety refusal: nothing was written.
type Refused struct{ Msg string }

func (e *Refused) Error() string { return e.Msg }

func refuse(format string, a ...any) error { return &Refused{fmt.Sprintf(format, a...)} }

// protoErr is a protocol failure worth retrying (no response, a short or mismatched reply, a bad CRC).
type protoErr struct{ msg string }

func (e *protoErr) Error() string { return e.msg }

func perr(format string, a ...any) error { return &protoErr{fmt.Sprintf(format, a...)} }

func isProto(err error) bool {
	var p *protoErr
	return errors.As(err, &p)
}
