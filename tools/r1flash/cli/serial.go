package cli

import (
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
	"go.bug.st/serial/enumerator"
)

// realPort opens a port with DTR and RTS low, so opening it does not reset the board, and reopens it by name after
// the USB bridge re-enumerates.
type realPort struct {
	name    string
	baud    int
	timeout time.Duration
	p       serial.Port
	trace   *tracer
}

func openPort(name string, trace *tracer) (*realPort, error) {
	r := &realPort{name: name, baud: 115200, timeout: time.Second, trace: trace}
	if err := r.open(); err != nil {
		return nil, explainOpen(name, err)
	}
	return r, nil
}

func (r *realPort) open() error {
	p, err := serial.Open(r.name, &serial.Mode{BaudRate: r.baud, InitialStatusBits: &serial.ModemOutputBits{}})
	if err != nil {
		return err
	}
	_ = p.SetDTR(false)
	_ = p.SetRTS(false)
	_ = p.SetReadTimeout(r.timeout)
	r.p = p
	r.trace.note("open %s at %d", r.name, r.baud)
	return nil
}

func (r *realPort) Read(b []byte) (int, error) {
	if r.p == nil {
		return 0, fmt.Errorf("%s is closed", r.name)
	}
	n, err := r.p.Read(b)
	if n > 0 {
		r.trace.bytes("<", b[:n])
	}
	return n, err
}

func (r *realPort) Write(b []byte) (int, error) {
	if r.p == nil {
		return 0, fmt.Errorf("%s is closed", r.name)
	}
	r.trace.bytes(">", b)
	n, err := r.p.Write(b)
	if err == nil {
		err = r.p.Drain()
	}
	return n, err
}

func (r *realPort) SetBaud(b int) error {
	if r.p == nil {
		return fmt.Errorf("%s is closed", r.name)
	}
	r.trace.note("baud %d", b)
	if err := r.p.SetMode(&serial.Mode{BaudRate: b}); err != nil {
		return err
	}
	r.baud = b
	return nil
}

func (r *realPort) SetDTR(on bool) error {
	if r.p == nil {
		return nil
	}
	return r.p.SetDTR(on)
}

func (r *realPort) SetRTS(on bool) error {
	if r.p == nil {
		return nil
	}
	return r.p.SetRTS(on)
}

func (r *realPort) SetReadTimeout(d time.Duration) error {
	r.timeout = d
	if r.p == nil {
		return nil
	}
	return r.p.SetReadTimeout(d)
}

func (r *realPort) Close() error {
	if r.p == nil {
		return nil
	}
	err := r.p.Close()
	r.p = nil
	return err
}

func (r *realPort) Reopen() error {
	_ = r.Close()
	return r.open()
}

type realClock struct{}

func (realClock) Now() time.Time        { return time.Now() }
func (realClock) Sleep(d time.Duration) { time.Sleep(d) }

// tracer writes every byte each way, timestamped, for a recorded trace of a real session (--trace).
type tracer struct {
	mu sync.Mutex
	w  io.WriteCloser
}

func newTracer(path string) (*tracer, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	return &tracer{w: f}, nil
}

func (t *tracer) line(s string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	fmt.Fprintf(t.w, "%s %s\n", time.Now().UTC().Format("15:04:05.000000"), s)
}

func (t *tracer) note(f string, a ...any) { t.line("# " + fmt.Sprintf(f, a...)) }
func (t *tracer) bytes(dir string, b []byte) {
	if t != nil {
		t.line(dir + " " + hex.EncodeToString(b))
	}
}
func (t *tracer) Close() {
	if t != nil {
		_ = t.w.Close()
	}
}

// USB-UART bridges an R1 board may carry: WCH CH34x, Silicon Labs CP210x, FTDI.
var bridgeVIDs = map[string]string{"1A86": "CH34x", "10C4": "CP210x", "0403": "FTDI"}

type portInfo struct {
	Name string `json:"name"`
	VID  string `json:"vid"`
	PID  string `json:"pid"`
	R1   bool   `json:"r1"`
	Desc string `json:"desc"`
}

func listPorts() ([]portInfo, error) {
	list, err := enumerator.GetDetailedPortsList()
	if err != nil {
		return nil, err
	}
	out := []portInfo{}
	for _, p := range list {
		vid, pid := strings.ToUpper(p.VID), strings.ToUpper(p.PID)
		bridge, ok := bridgeVIDs[vid]
		desc := strings.TrimSpace(p.Product)
		if ok && desc == "" {
			desc = bridge + " USB serial"
		}
		// macOS lists each port twice; the call-out device is the one to open.
		if runtime.GOOS == "darwin" && strings.HasPrefix(p.Name, "/dev/tty.") {
			continue
		}
		out = append(out, portInfo{Name: p.Name, VID: vid, PID: pid, R1: ok, Desc: desc})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// explainOpen turns an open failure into what to do about it.
func explainOpen(name string, err error) error {
	msg := err.Error()
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "busy") || strings.Contains(low, "access is denied") || strings.Contains(low, "in use"):
		return fmt.Errorf("%s is in use by another program (a serial monitor, another flasher); close it and try again", name)
	case strings.Contains(low, "permission denied"):
		group := "dialout"
		if _, e := os.Stat("/etc/arch-release"); e == nil {
			group = "uucp"
		}
		return fmt.Errorf("no permission to open %s: run `sudo usermod -aG %s $USER`, then log out and back in", name, group)
	}
	return fmt.Errorf("opening %s: %s", name, msg)
}

// noPortHint explains why no R1 port shows up, per OS.
func noPortHint() string {
	switch runtime.GOOS {
	case "linux":
		if ch340WithoutTTY() {
			return "a CH340 is plugged in but has no port: brltty has claimed it. Remove it with `sudo apt remove brltty` and replug the R1."
		}
		return "plug the R1 in with a data USB cable (some cables carry power only); the CH340 and CP210x drivers are in the kernel."
	case "darwin":
		return "plug the R1 in with a data USB cable. macOS 11+ has the CH340 driver built in; a CP210x board needs the Silicon Labs VCP driver."
	case "windows":
		return "plug the R1 in with a data USB cable. If Device Manager shows it without a COM port, install WCH's CH341SER driver (or Silicon Labs' CP210x driver)."
	}
	return "plug the R1 in with a data USB cable."
}

func ch340WithoutTTY() bool {
	dirs, _ := os.ReadDir("/sys/bus/usb/devices")
	for _, d := range dirs {
		base := "/sys/bus/usb/devices/" + d.Name()
		vid, _ := os.ReadFile(base + "/idVendor")
		pid, _ := os.ReadFile(base + "/idProduct")
		if strings.TrimSpace(string(vid)) == "1a86" && strings.TrimSpace(string(pid)) == "7523" {
			ports, _ := listPorts()
			for _, p := range ports {
				if p.VID == "1A86" {
					return false
				}
			}
			return true
		}
	}
	return false
}
