package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/RabHanz/tessaya/tools/tessel-flash/core"
)

// out is both the reporter the core writes to and the CLI's own output: NDJSON with --json, plain lines otherwise.
type out struct {
	w        io.Writer
	json     bool
	lastPct  int
	progress bool
}

func (o *out) emit(ev map[string]any) {
	b, _ := json.Marshal(ev)
	fmt.Fprintln(o.w, string(b))
}

func (o *out) endProgress() {
	if o.progress {
		fmt.Fprintln(o.w)
		o.progress = false
	}
}

func (o *out) Phase(phase, msg string) {
	if o.json {
		o.emit(map[string]any{"ev": "phase", "phase": phase, "msg": msg})
		return
	}
	o.endProgress()
	fmt.Fprintf(o.w, "• %s\n", msg)
}

func (o *out) Progress(phase string, done, total int) {
	pct := done * 100 / max(total, 1)
	if pct == o.lastPct && done != total {
		return
	}
	o.lastPct = pct
	if o.json {
		o.emit(map[string]any{"ev": "progress", "phase": phase, "done": done, "total": total})
		return
	}
	bar := strings.Repeat("#", pct/4) + strings.Repeat("-", 25-pct/4)
	fmt.Fprintf(o.w, "\r  [%s] %3d%%", bar, pct)
	o.progress = true
}

func (o *out) Log(msg string) {
	if o.json {
		o.emit(map[string]any{"ev": "log", "msg": msg})
		return
	}
	o.endProgress()
	fmt.Fprintf(o.w, "  %s\n", msg)
}

// result is the last event of every command; its code also sets the exit status.
type result struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code"`
	Msg     string `json:"msg"`
	Version string `json:"version,omitempty"`
	SHA256  string `json:"sha256,omitempty"`
	Signed  *bool  `json:"signed,omitempty"`
	Backup  string `json:"backup,omitempty"`
}

func resultOf(err error, okMsg string) result {
	var ref *core.Refused
	switch {
	case err == nil:
		return result{OK: true, Code: "ok", Msg: okMsg}
	case errors.As(err, &ref):
		return result{Code: "refused", Msg: err.Error()}
	case errors.Is(err, core.ErrNoLink):
		return result{Code: "no-link", Msg: "No link with the Tessel's loader. Unplug and replug the Tessel's battery while tessel-flash waits, or reboot it from Tessaya, then try again."}
	}
	return result{Code: "failed", Msg: err.Error()}
}

func (r result) exit() int {
	switch r.Code {
	case "ok":
		return 0
	case "refused":
		return 2
	case "no-link":
		return 3
	}
	return 1
}

func (o *out) result(r result) int {
	if o.json {
		b, _ := json.Marshal(r)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		m["ev"] = "result"
		o.emit(m)
	} else {
		o.endProgress()
		mark := "✓"
		if !r.OK {
			mark = "✗"
		}
		fmt.Fprintf(o.w, "%s %s\n", mark, r.Msg)
	}
	return r.exit()
}

// dirStore keeps backups, the resume marker, the image cache and the audit log in tessel-flash's data folder.
type dirStore struct{ dir string }

func dataDir(flag string) (string, error) {
	if flag != "" {
		return flag, os.MkdirAll(flag, 0o755)
	}
	old, dir := "", ""
	if base, err := os.UserConfigDir(); err == nil {
		old, dir = filepath.Join(base, "r1flash"), filepath.Join(base, "tessel-flash")
	} else {
		home, _ := os.UserHomeDir()
		old, dir = filepath.Join(home, ".r1flash"), filepath.Join(home, ".tessel-flash")
	}
	// The tool was r1flash: its folder (backups, the resume marker) moves once, or stays in use if it cannot move.
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		if _, err := os.Stat(old); err == nil && os.Rename(old, dir) != nil {
			return old, nil
		}
	}
	return dir, os.MkdirAll(dir, 0o755)
}

func (s dirStore) Read(n string) ([]byte, error) { return os.ReadFile(filepath.Join(s.dir, n)) }
func (s dirStore) Write(n string, b []byte) error {
	return os.WriteFile(filepath.Join(s.dir, n), b, 0o644)
}
func (s dirStore) Remove(n string) error { return os.Remove(filepath.Join(s.dir, n)) }

// audit appends one line per run that touches the device. Times are UTC, like every log.
func (s dirStore) audit(fields map[string]any) {
	fields["at"] = time.Now().UTC().Format(time.RFC3339)
	b, _ := json.Marshal(fields)
	f, err := os.OpenFile(filepath.Join(s.dir, "r1flash.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintln(f, string(b))
}
