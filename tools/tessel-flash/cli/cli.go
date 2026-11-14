// Package cli is tessel-flash's command line, menu and serial port; the protocol lives in core.
package cli

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/RabHanz/tessaya/tools/tessel-flash/core"
)

var Version = "dev"

const usage = `tessel-flash: update, repair and configure a Tessel over its USB cable.

  tessel-flash                     interactive menu
  tessel-flash ports               list serial ports, mark the likely Tessel
  tessel-flash detect              console, bootrom or silent; firmware version and status
  tessel-flash flash [--version X | --file F [--sig S]] [--allow-unsigned]
                                   verify, back up the settings, write, verify, reboot, watch the boot
  tessel-flash recover [--probe]   link a stuck or boot-looping chip and write the recommended image
                                   (--probe: link and reboot only)
  tessel-flash backup              save the settings area (0x7E7000-0x800000)
  tessel-flash restore FILE        write a settings backup back
  tessel-flash config get | wifi SSID PASS | endpoints URL... | key HEX | setup
  tessel-flash console             raw console, DTR/RTS low
  tessel-flash version

Flags (anywhere): --port P  --json  --link-wait S (120)  --kick  --baud N (460800)  --trace FILE
                  --index URL|FILE  --dir DIR  --force  --confirm-unsigned "flash unsigned"
Exit codes: 0 ok, 2 refused, 3 no link, 1 failure.`

type opts struct {
	port, trace, index, dir, version, file, sig, confirmUnsigned string
	json, kick, allowUnsigned, force, probe                      bool
	linkWait, baud                                               int
}

type app struct {
	o     opts
	out   *out
	in    *bufio.Reader
	tty   bool
	store dirStore
	trace *tracer
}

// Run is the whole program; it returns the exit code.
func Run(args []string, stdin io.Reader, stdout io.Writer, tty bool) int {
	fs := flag.NewFlagSet("tessel-flash", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var o opts
	fs.StringVar(&o.port, "port", "", "")
	fs.BoolVar(&o.json, "json", false, "")
	fs.IntVar(&o.linkWait, "link-wait", 120, "")
	fs.BoolVar(&o.kick, "kick", false, "")
	fs.IntVar(&o.baud, "baud", core.TransferBaud, "")
	fs.StringVar(&o.trace, "trace", "", "")
	fs.StringVar(&o.index, "index", core.IndexURL, "")
	fs.StringVar(&o.dir, "dir", "", "")
	fs.StringVar(&o.version, "version", "", "")
	fs.StringVar(&o.file, "file", "", "")
	fs.StringVar(&o.sig, "sig", "", "")
	fs.BoolVar(&o.allowUnsigned, "allow-unsigned", false, "")
	fs.StringVar(&o.confirmUnsigned, "confirm-unsigned", "", "")
	fs.BoolVar(&o.force, "force", false, "")
	fs.BoolVar(&o.probe, "probe", false, "")
	var pos []string
	for rest := args; ; {
		if err := fs.Parse(rest); err != nil {
			fmt.Fprintln(stdout, err.Error()+"\n\n"+usage)
			return 2
		}
		if rest = fs.Args(); len(rest) == 0 {
			break
		}
		pos, rest = append(pos, rest[0]), rest[1:]
	}
	a := &app{o: o, out: &out{w: stdout, json: o.json, lastPct: -1}, in: bufio.NewReader(stdin), tty: tty && !o.json}
	dir, err := dataDir(o.dir)
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	a.store = dirStore{dir}
	if a.trace, err = newTracer(o.trace); err != nil {
		return a.out.result(resultOf(err, ""))
	}
	defer a.trace.Close()
	if len(pos) == 0 {
		if !a.tty {
			fmt.Fprintln(stdout, usage)
			return 2
		}
		return a.menu()
	}
	return a.command(pos)
}

func (a *app) command(pos []string) int {
	switch cmd, args := pos[0], pos[1:]; cmd {
	case "ports":
		return a.ports()
	case "detect":
		return a.detect()
	case "flash":
		return a.flash(false)
	case "recover":
		return a.flash(true)
	case "backup":
		return a.backup()
	case "restore":
		if len(args) != 1 {
			return a.usage("restore needs the backup file")
		}
		return a.restore(args[0])
	case "config":
		return a.config(args)
	case "console":
		return a.console()
	case "version":
		return a.out.result(result{OK: true, Code: "ok", Msg: "tessel-flash " + Version})
	case "help", "-h", "--help":
		fmt.Fprintln(a.out.w, usage)
		return 0
	}
	return a.usage("unknown command " + pos[0])
}

func (a *app) usage(msg string) int {
	if a.o.json {
		return a.out.result(result{Code: "refused", Msg: msg})
	}
	fmt.Fprintln(a.out.w, msg+"\n\n"+usage)
	return 2
}

func (a *app) ports() int {
	ports, err := listPorts()
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	if a.o.json {
		a.out.emit(map[string]any{"ev": "ports", "ports": ports})
	} else {
		for _, p := range ports {
			mark := " "
			if p.R1 {
				mark = "*"
			}
			fmt.Fprintf(a.out.w, "%s %-28s %s:%s %s\n", mark, p.Name, p.VID, p.PID, p.Desc)
		}
	}
	for _, p := range ports {
		if p.R1 {
			return a.out.result(result{OK: true, Code: "ok", Msg: "* marks a USB serial bridge a Tessel uses"})
		}
	}
	return a.out.result(result{OK: true, Code: "ok", Msg: "no Tessel found: " + noPortHint()})
}

// pickPort is --port, or the only USB-UART bridge plugged in.
func (a *app) pickPort() (string, error) {
	if a.o.port != "" {
		return a.o.port, nil
	}
	ports, err := listPorts()
	if err != nil {
		return "", err
	}
	var r1 []string
	for _, p := range ports {
		if p.R1 {
			r1 = append(r1, p.Name)
		}
	}
	switch len(r1) {
	case 1:
		a.out.Log("using " + r1[0])
		return r1[0], nil
	case 0:
		return "", &core.Refused{Msg: "no Tessel found: " + noPortHint()}
	}
	return "", &core.Refused{Msg: "several USB serial ports (" + strings.Join(r1, ", ") + "): pick one with --port"}
}

func (a *app) open() (*realPort, error) {
	name, err := a.pickPort()
	if err != nil {
		return nil, err
	}
	return openPort(name, a.trace)
}

func (a *app) detect() int {
	p, err := a.open()
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	defer p.Close()
	d, err := core.Detect(p, realClock{}, a.out)
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	a.emitDetect(d)
	msg := map[string]string{
		"console": "The Tessel's firmware is running" + map[bool]string{true: " (" + d.FW + ")", false: ""}[d.FW != ""] + ".",
		"bootrom": "The Tessel is in its loader, ready to flash.",
		"silent":  "The Tessel is silent: it may be off, boot-looping or bricked. `tessel-flash recover` repairs it.",
	}[d.State]
	return a.out.result(result{OK: true, Code: "ok", Msg: msg, Version: d.FW})
}

func (a *app) emitDetect(d core.Detection) {
	if !a.o.json {
		for _, l := range d.Lines {
			a.out.Log(l)
		}
		return
	}
	var fw, status any
	if d.FW != "" {
		fw = d.FW
	}
	if d.Status != nil {
		status = d.Status
	}
	a.out.emit(map[string]any{"ev": "detect", "state": d.State, "fw": fw, "status": status})
}

// link waits for the loader; for a person at the terminal it says how to get the R1 there.
func (a *app) link(p *realPort) (*core.ROM, error) {
	if !a.o.json {
		a.out.Log(fmt.Sprintf("Unplug and replug the Tessel's battery now (or reboot it from Tessaya). Waiting %d s for its loader.", a.o.linkWait))
	}
	return core.Link(p, realClock{}, a.out, core.LinkOpts{
		Wait: time.Duration(a.o.linkWait) * time.Second, Kick: a.o.kick, TransferBaud: a.o.baud,
	})
}

// holdInterrupts keeps Ctrl-C from cutting a linked write: stopping now would need the cable again.
func (a *app) holdInterrupts() func() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ch:
				a.out.Log("writing; stopping or unplugging now needs the cable again. tessel-flash finishes first.")
			case <-done:
				return
			}
		}
	}()
	return func() { signal.Stop(ch); close(done) }
}

type image struct {
	data    []byte
	version string
	sha     string
	signed  bool
}

func (a *app) flash(recover bool) int {
	var img image
	if !(recover && a.o.probe) {
		var err error
		if img, err = a.resolveImage(); err != nil {
			return a.out.result(resultOf(err, ""))
		}
	}
	p, err := a.open()
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	defer p.Close()
	if !recover && !a.o.force {
		if err := a.preflight(p); err != nil {
			return a.out.result(resultOf(err, ""))
		}
	}
	rom, err := a.link(p)
	audit := map[string]any{"cmd": map[bool]string{true: "recover", false: "flash"}[recover], "port": p.name}
	if err != nil {
		a.store.audit(merge(audit, map[string]any{"result": err.Error()}))
		return a.out.result(resultOf(err, ""))
	}
	audit["chip"] = rom.ChipInfo()
	if recover && a.o.probe {
		err = rom.Reboot()
		a.store.audit(merge(audit, map[string]any{"result": errText(err), "probe": true}))
		return a.out.result(resultOf(err, "The loader answered; the Tessel was rebooted into its firmware. Nothing was written."))
	}
	release := a.holdInterrupts()
	backup, err := rom.Flash(img.data, a.store, time.Now().UTC().Format("20060102-150405"))
	release()
	a.store.audit(merge(audit, map[string]any{"sha256": img.sha, "version": img.version, "signed": img.signed, "backup": backup, "result": errText(err)}))
	if err != nil {
		r := resultOf(err, "")
		r.Backup = a.backupPath(backup)
		return a.out.result(r)
	}
	a.out.Phase("boot", "waiting for it to start")
	fw, seen := core.WatchBoot(p, realClock{}, 90*time.Second)
	msg := "Written and restarted."
	switch {
	case seen && fw != "":
		msg = "Written; it started on " + fw + "."
	case seen:
		msg = "Written; it started."
	case img.version != "":
		msg = "Written and restarted; no boot text seen on the cable. Tessaya's Hardware page shows when it is back on " + img.version + "."
	}
	if fw == "" {
		fw = img.version
	}
	a.out.Phase("done", msg)
	signed := img.signed
	return a.out.result(result{OK: true, Code: "ok", Msg: msg, Version: fw, SHA256: img.sha, Signed: &signed, Backup: a.backupPath(backup)})
}

func (a *app) backupPath(name string) string {
	if name == "" {
		return ""
	}
	return filepath.Join(a.store.dir, name)
}

// preflight asks a running firmware whether it is busy: never flash during a conversation or a call.
func (a *app) preflight(p *realPort) error {
	lines, err := core.ConsoleLines(p, realClock{}, core.AP("r1cfg status"), 1500*time.Millisecond)
	if err != nil {
		return err
	}
	st := core.JSONLine(lines)
	if st == nil {
		return nil
	}
	if why := core.Live(st); why != "" {
		return &core.Refused{Msg: "refusing: " + why + ". Try again when it ends (--force overrides)."}
	}
	if pct := core.LowBattery(st, 15); pct >= 0 {
		a.out.Log(fmt.Sprintf("warning: battery at %.0f%% and not charging; keep the cable in until it is done", pct))
	}
	return nil
}

func (a *app) resolveImage() (image, error) {
	pub, err := core.ParsePublicKey(core.ReleasePublicKey)
	if err != nil {
		return image{}, err
	}
	if a.o.file != "" {
		return a.localImage()
	}
	a.out.Log("reading the signed release list")
	body, err := fetch(a.o.index)
	if err != nil {
		return image{}, err
	}
	sig, err := fetch(a.o.index + ".sig")
	if err != nil {
		return image{}, err
	}
	ix, err := core.ParseIndex(body, string(sig), pub)
	if err != nil {
		return image{}, err
	}
	rel, err := ix.CableImage(a.o.version)
	if err != nil {
		return image{}, err
	}
	cache := filepath.Join(a.store.dir, "cache", strings.ToLower(rel.AllApp.SHA256)+".bin")
	data, err := os.ReadFile(cache)
	if err != nil || core.CheckArtifact(data, rel.AllApp, pub) != nil {
		a.out.Log("downloading " + rel.Version)
		if data, err = fetch(rel.AllApp.URL); err != nil {
			return image{}, err
		}
		if err := core.CheckArtifact(data, rel.AllApp, pub); err != nil {
			return image{}, err
		}
		_ = os.MkdirAll(filepath.Dir(cache), 0o755)
		_ = os.WriteFile(cache, data, 0o644)
	}
	a.out.Log(rel.Version + ": sha256 and signature verified")
	return image{data: data, version: rel.Version, sha: strings.ToLower(rel.AllApp.SHA256), signed: true}, nil
}

func (a *app) localImage() (image, error) {
	data, err := os.ReadFile(a.o.file)
	if err != nil {
		return image{}, err
	}
	h := sha256.Sum256(data)
	img := image{data: data, sha: hex.EncodeToString(h[:])}
	sig := a.o.sig
	if sig == "" {
		if b, err := os.ReadFile(a.o.file + ".sig"); err == nil {
			sig = string(b)
		}
	} else if b, err := os.ReadFile(sig); err == nil {
		sig = string(b)
	}
	key, _ := core.ParsePublicKey(core.ReleasePublicKey)
	if sig != "" && core.VerifySig(key, data, sig) {
		img.signed = true
		a.out.Log("signature verified against the release key")
		return img, nil
	}
	if !a.o.allowUnsigned {
		return image{}, &core.Refused{Msg: "refusing: " + filepath.Base(a.o.file) + " is not signed by the release key (--allow-unsigned flashes it anyway, over USB only)"}
	}
	confirm := a.o.confirmUnsigned
	if confirm == "" && a.tty {
		fmt.Fprint(a.out.w, "This image is NOT signed. The chip checks nothing. Type 'flash unsigned' to go on: ")
		line, _ := a.in.ReadString('\n')
		confirm = strings.TrimSpace(line)
	}
	if confirm != "flash unsigned" {
		return image{}, &core.Refused{Msg: "refusing: an unsigned image needs --confirm-unsigned \"flash unsigned\""}
	}
	a.out.Log("UNSIGNED image " + img.sha[:16] + ": flashing on your confirmation")
	return img, nil
}

func fetch(u string) ([]byte, error) {
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return os.ReadFile(u)
	}
	c := &http.Client{Timeout: 3 * time.Minute}
	resp, err := c.Get(u)
	if err != nil {
		return nil, fmt.Errorf("download failed (are you online?): %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download of %s failed: HTTP %d", u, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 16<<20))
}

func (a *app) backup() int {
	p, err := a.open()
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	defer p.Close()
	rom, err := a.link(p)
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	name, err := rom.Backup(a.store, time.Now().UTC().Format("20060102-150405"))
	a.store.audit(map[string]any{"cmd": "backup", "port": p.name, "chip": rom.ChipInfo(), "backup": name, "result": errText(err)})
	r := resultOf(err, "Settings saved.")
	r.Backup = a.backupPath(name)
	return a.out.result(r)
}

func (a *app) restore(file string) int {
	data, err := os.ReadFile(file)
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	p, err := a.open()
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	defer p.Close()
	rom, err := a.link(p)
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	release := a.holdInterrupts()
	err = rom.Restore(data)
	release()
	a.store.audit(map[string]any{"cmd": "restore", "port": p.name, "chip": rom.ChipInfo(), "file": file, "result": errText(err)})
	return a.out.result(resultOf(err, "Settings restored; it restarted."))
}

func (a *app) config(args []string) int {
	if len(args) == 0 {
		return a.usage("config needs get, wifi, endpoints, key or setup")
	}
	var line string
	switch args[0] {
	case "get":
		line = core.AP("r1cfg status")
	case "wifi":
		if len(args) != 3 {
			return a.usage("config wifi SSID PASS")
		}
		line = core.AP("r1cfg wifi " + core.QuoteArg(args[1]) + " " + core.QuoteArg(args[2]))
	case "endpoints":
		if len(args) < 2 {
			return a.usage("config endpoints URL...")
		}
		line = core.AP("r1ep set " + strings.Join(args[1:], " "))
	case "key":
		if len(args) != 2 {
			return a.usage("config key HEX")
		}
		line = core.AP("r1cfg key " + args[1])
	case "setup":
		line = core.AP("r1cfg setup")
	default:
		return a.usage("unknown config " + args[0])
	}
	p, err := a.open()
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	defer p.Close()
	lines, err := core.ConsoleLines(p, realClock{}, line, 3*time.Second)
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	st := core.JSONLine(lines)
	if args[0] == "get" {
		a.emitDetect(core.Detection{State: "console", FW: core.Firmware(lines, st), Status: st, Lines: lines})
	} else {
		for _, l := range lines {
			a.out.Log(l)
		}
		a.store.audit(map[string]any{"cmd": "config " + args[0], "port": p.name, "result": strings.Join(lines, " | ")})
	}
	switch {
	case len(lines) == 0:
		return a.out.result(result{Code: "failed", Msg: "no answer on the console: is the Tessel's firmware running (try `tessel-flash detect`)?"})
	case st == nil:
		return a.out.result(result{Code: "failed", Msg: "the console did not understand: this firmware may predate the r1cfg command (" + lines[len(lines)-1] + ")"})
	case st["ok"] == false:
		return a.out.result(result{Code: "failed", Msg: fmt.Sprintf("the Tessel refused: %v", st["error"])})
	}
	return a.out.result(result{OK: true, Code: "ok", Msg: "Done."})
}

func (a *app) console() int {
	p, err := a.open()
	if err != nil {
		return a.out.result(resultOf(err, ""))
	}
	defer p.Close()
	if err := p.SetBaud(core.ConsoleBaud); err != nil {
		return a.out.result(resultOf(err, ""))
	}
	_ = p.SetReadTimeout(200 * time.Millisecond)
	if !a.o.json {
		fmt.Fprintln(a.out.w, "console at 115200 on "+p.name+"; type a line and Enter; Ctrl-D or Ctrl-C ends")
	}
	stop := make(chan struct{})
	go func() {
		buf, pending := make([]byte, 1024), ""
		for {
			select {
			case <-stop:
				return
			default:
			}
			n, err := p.Read(buf)
			if err != nil {
				_ = p.Reopen()
				time.Sleep(200 * time.Millisecond)
				continue
			}
			pending += strings.ReplaceAll(string(buf[:n]), "\r", "")
			for {
				i := strings.IndexByte(pending, '\n')
				if i < 0 {
					break
				}
				if a.o.json {
					a.out.emit(map[string]any{"ev": "console", "line": pending[:i]})
				} else {
					fmt.Fprintln(a.out.w, pending[:i])
				}
				pending = pending[i+1:]
			}
		}
	}()
	for {
		line, err := a.in.ReadString('\n')
		if line = strings.TrimRight(line, "\r\n"); line != "" {
			_, _ = p.Write([]byte(line + "\r\n"))
		}
		if err != nil {
			break
		}
	}
	close(stop)
	return a.out.result(result{OK: true, Code: "ok", Msg: "console closed"})
}

func merge(a, b map[string]any) map[string]any {
	for k, v := range b {
		a[k] = v
	}
	return a
}

func errText(err error) string {
	if err == nil {
		return "ok"
	}
	return err.Error()
}
