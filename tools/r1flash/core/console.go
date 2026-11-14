package core

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The firmware's UART console at 115,200, DTR and RTS low so opening it does not reset the board. `r1cfg` (one-line
// JSON replies) is the firmware ask U2; `r1ep set` exists since 0.3.61.

// AP addresses the application core. The UART is the CP's console: it runs the AP's commands (r1cfg, r1ep) only
// behind ap_cmd, and prints a prompt character before each reply.
func AP(line string) string { return "ap_cmd " + line }

var fwRe = regexp.MustCompile(`smp-\d+\.\d+\.\d+`)

// ConsoleLines sends one line (unless empty) and collects what the console prints for wait.
func ConsoleLines(p Port, clk Clock, line string, wait time.Duration) ([]string, error) {
	_ = p.SetDTR(false)
	_ = p.SetRTS(false)
	c := newConn(p, clk)
	if err := c.setBaud(ConsoleBaud); err != nil {
		return nil, err
	}
	c.timeout = 100 * time.Millisecond
	c.drain()
	if line != "" {
		if err := c.write([]byte("\r\n" + line + "\r\n")); err != nil {
			return nil, err
		}
	}
	deadline := clk.Now().Add(wait)
	for clk.Now().Before(deadline) {
		if _, err := c.fill(); err != nil {
			return nil, err
		}
	}
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(string(c.buf), "\r", ""), "\n") {
		if l = strings.TrimSpace(l); l != "" && l != line {
			out = append(out, l)
		}
	}
	return out, nil
}

// JSONLine is the last line that parses as a JSON object.
func JSONLine(lines []string) map[string]any {
	for i := len(lines) - 1; i >= 0; i-- {
		var m map[string]any
		j := strings.IndexByte(lines[i], '{') // after the console's prompt character
		if j >= 0 && j <= 2 && json.Unmarshal([]byte(lines[i][j:]), &m) == nil {
			return m
		}
	}
	return nil
}

// Firmware is the version the console printed, from r1cfg status or any smp-x.y.z in its text.
func Firmware(lines []string, status map[string]any) string {
	if fw, ok := status["fw"].(string); ok && fw != "" {
		return fw
	}
	for _, l := range lines {
		if m := fwRe.FindString(l); m != "" {
			return m
		}
	}
	return ""
}

// Detection is what is on the port: the firmware console, the bootrom, or nothing.
type Detection struct {
	State  string // console, bootrom, silent
	FW     string
	Status map[string]any
	Lines  []string
}

// Detect asks the console for its status; with no console, it tries one short link at both rates.
func Detect(p Port, clk Clock, rep Reporter) (Detection, error) {
	rep.Phase("detect", "looking at the port")
	lines, err := ConsoleLines(p, clk, AP("r1cfg status"), 1500*time.Millisecond)
	if err != nil {
		return Detection{}, err
	}
	if len(lines) > 0 {
		st := JSONLine(lines)
		return Detection{State: "console", FW: Firmware(lines, st), Status: st, Lines: lines}, nil
	}
	for _, rate := range []int{ConsoleBaud, TransferBaud} {
		r := newROM(p, clk, rep, TransferBaud)
		if err := r.c.setBaud(rate); err != nil {
			return Detection{}, err
		}
		if ok, err := r.waitForLink(time.Second); err != nil {
			return Detection{}, err
		} else if ok {
			return Detection{State: "bootrom"}, nil
		}
	}
	return Detection{State: "silent"}, nil
}

// Live is why the firmware's status says it is busy (a conversation or a call), or "".
func Live(status map[string]any) string {
	for _, k := range []string{"session", "call"} {
		if v, ok := status[k].(bool); ok && v {
			return "it is in a " + map[string]string{"session": "conversation", "call": "call"}[k]
		}
	}
	return ""
}

// LowBattery is the battery percentage when it is under min% and not charging, or -1.
func LowBattery(status map[string]any, minPct float64) float64 {
	pct, ok := status["battery"].(float64)
	if charging, _ := status["charging"].(bool); !ok || charging || pct >= minPct {
		return -1
	}
	return pct
}

// QuoteArg quotes a console argument that has spaces or quotes.
func QuoteArg(s string) string {
	if strings.ContainsAny(s, " \t\"") || s == "" {
		return strconv.Quote(s)
	}
	return s
}

var bootRe = regexp.MustCompile(`READY|announce:`)

// WatchBoot reads the console after a reboot until READY or an announce (or wait passes), reopening the port when
// the USB bridge re-enumerates. The UART text is evidence only; the hub's announce is the verdict.
func WatchBoot(p Port, clk Clock, wait time.Duration) (fw string, seen bool) {
	deadline := clk.Now().Add(wait)
	var text strings.Builder
	c := newConn(p, clk)
	c.timeout = 200 * time.Millisecond
	ready := false
	for clk.Now().Before(deadline) {
		if !ready {
			if err := c.setBaud(ConsoleBaud); err != nil {
				_ = p.Reopen()
				clk.Sleep(200 * time.Millisecond)
				continue
			}
			_ = p.SetDTR(false)
			_ = p.SetRTS(false)
			ready = true
		}
		if _, err := c.fill(); err != nil {
			ready = false
			_ = p.Reopen()
			clk.Sleep(200 * time.Millisecond)
			continue
		}
		text.Write(c.buf)
		c.buf = nil
		s := text.String()
		if fw == "" {
			fw = fwRe.FindString(s)
		}
		if bootRe.MatchString(s) {
			return fw, true
		}
	}
	return fw, false
}
