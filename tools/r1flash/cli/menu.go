package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/RabHanz/tessaya/tools/r1flash/core"
)

// menu is the terminal UI: numbered choices that run the same commands as the CLI.
func (a *app) menu() int {
	fmt.Fprintln(a.out.w, "r1flash "+Version+": update, repair and configure a Tessaya R1 over USB.")
	if a.o.port == "" {
		if name := a.choosePort(); name == "" {
			return 2
		} else {
			a.o.port = name
		}
	}
	items := []struct {
		label string
		run   func() int
	}{
		{"Update or repair (the recommended signed release)", func() int { return a.flash(false) }},
		{"Repair a stuck or boot-looping R1", func() int { return a.flash(true) }},
		{"Install another signed release", func() int {
			v := a.chooseVersion()
			if v == "" {
				return 0
			}
			a.o.version = v
			defer func() { a.o.version = "" }()
			return a.flash(false)
		}},
		{"Flash an image file", func() int {
			a.o.file = a.ask("Image file: ")
			defer func() { a.o.file = "" }()
			if a.o.file == "" {
				return 0
			}
			a.o.allowUnsigned = true // still asks for the typed confirmation when it is not signed
			defer func() { a.o.allowUnsigned = false }()
			return a.flash(false)
		}},
		{"What is on the port?", a.detect},
		{"Back up its settings", a.backup},
		{"Restore its settings", func() int {
			f := a.chooseBackup()
			if f == "" {
				return 0
			}
			return a.restore(f)
		}},
		{"Set its Wi-Fi", func() int {
			ssid := a.ask("Wi-Fi name: ")
			if ssid == "" {
				return 0
			}
			return a.config([]string{"wifi", ssid, a.ask("Password: ")})
		}},
		{"Set its server endpoints", func() int {
			urls := strings.Fields(a.ask("Broker URLs (space-separated): "))
			if len(urls) == 0 {
				return 0
			}
			return a.config(append([]string{"endpoints"}, urls...))
		}},
		{"Open setup mode (pair it again)", func() int { return a.config([]string{"setup"}) }},
		{"Console", a.console},
	}
	for {
		fmt.Fprintf(a.out.w, "\nR1 on %s\n", a.o.port)
		for i, it := range items {
			fmt.Fprintf(a.out.w, "  %2d  %s\n", i+1, it.label)
		}
		fmt.Fprintln(a.out.w, "   0  Quit")
		n, err := strconv.Atoi(a.ask("Choose: "))
		if err != nil || n == 0 {
			return 0
		}
		if n >= 1 && n <= len(items) {
			items[n-1].run()
		}
	}
}

func (a *app) ask(prompt string) string {
	fmt.Fprint(a.out.w, prompt)
	line, err := a.in.ReadString('\n')
	if err != nil && line == "" {
		return ""
	}
	return strings.TrimSpace(line)
}

func (a *app) choosePort() string {
	ports, err := listPorts()
	if err != nil || len(ports) == 0 {
		fmt.Fprintln(a.out.w, "No serial ports. "+noPortHint())
		return ""
	}
	var r1 []portInfo
	for _, p := range ports {
		if p.R1 {
			r1 = append(r1, p)
		}
	}
	if len(r1) == 1 {
		return r1[0].Name
	}
	if len(r1) == 0 {
		fmt.Fprintln(a.out.w, "No R1 found. "+noPortHint())
		r1 = ports
	}
	for i, p := range r1 {
		fmt.Fprintf(a.out.w, "  %d  %s  %s\n", i+1, p.Name, p.Desc)
	}
	n, err := strconv.Atoi(a.ask("Which port? "))
	if err != nil || n < 1 || n > len(r1) {
		return ""
	}
	return r1[n-1].Name
}

func (a *app) chooseVersion() string {
	pub, _ := core.ParsePublicKey(core.ReleasePublicKey)
	body, err := fetch(a.o.index)
	if err != nil {
		fmt.Fprintln(a.out.w, err)
		return ""
	}
	sig, err := fetch(a.o.index + ".sig")
	if err != nil {
		fmt.Fprintln(a.out.w, err)
		return ""
	}
	ix, err := core.ParseIndex(body, string(sig), pub)
	if err != nil {
		fmt.Fprintln(a.out.w, err)
		return ""
	}
	var vs []string
	for _, r := range ix.Releases {
		if r.AllApp != nil {
			vs = append(vs, r.Version)
		}
	}
	if len(vs) == 0 {
		fmt.Fprintln(a.out.w, "No release has a cable image yet.")
		return ""
	}
	for i, v := range vs {
		mark := ""
		if v == ix.Recommended {
			mark = "  (recommended)"
		}
		fmt.Fprintf(a.out.w, "  %d  %s%s\n", i+1, v, mark)
	}
	n, err := strconv.Atoi(a.ask("Which release? "))
	if err != nil || n < 1 || n > len(vs) {
		return ""
	}
	return vs[n-1]
}

func (a *app) chooseBackup() string {
	files, _ := filepath.Glob(filepath.Join(a.store.dir, "settings-*.bin"))
	if len(files) == 0 {
		fmt.Fprintln(a.out.w, "No backups in "+a.store.dir)
		return ""
	}
	sort.Sort(sort.Reverse(sort.StringSlice(files)))
	for i, f := range files {
		st, _ := os.Stat(f)
		fmt.Fprintf(a.out.w, "  %d  %s  %s\n", i+1, filepath.Base(f), st.ModTime().Format("2 Jan 15:04"))
	}
	n, err := strconv.Atoi(a.ask("Which backup? "))
	if err != nil || n < 1 || n > len(files) {
		return ""
	}
	return files[n-1]
}
