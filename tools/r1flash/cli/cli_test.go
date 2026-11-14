package cli

import (
	"bufio"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/RabHanz/tessaya/tools/r1flash/core"
)

func TestUnsignedImagesNeedTheTypedConfirmation(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "custom.bin")
	if err := os.WriteFile(file, []byte("a dev build"), 0o644); err != nil {
		t.Fatal(err)
	}
	try := func(o opts, typed string) error {
		o.file = file
		a := &app{o: o, out: &out{w: &bytes.Buffer{}}, in: bufio.NewReader(strings.NewReader(typed)), tty: typed != ""}
		_, err := a.resolveImage()
		return err
	}
	var ref *core.Refused
	if err := try(opts{}, ""); !errors.As(err, &ref) {
		t.Fatalf("unsigned without --allow-unsigned: %v", err)
	}
	if err := try(opts{allowUnsigned: true}, ""); !errors.As(err, &ref) {
		t.Fatalf("unsigned without the confirmation: %v", err)
	}
	if err := try(opts{allowUnsigned: true}, "yes\n"); !errors.As(err, &ref) {
		t.Fatalf("a wrong confirmation: %v", err)
	}
	if err := try(opts{allowUnsigned: true}, "flash unsigned\n"); err != nil {
		t.Fatal(err)
	}
	if err := try(opts{allowUnsigned: true, confirmUnsigned: "flash unsigned"}, ""); err != nil {
		t.Fatal(err)
	}
}

func TestExitCodesAndJSONResult(t *testing.T) {
	var buf bytes.Buffer
	code := Run([]string{"flash", "--json", "--version", "smp-0.0.1", "--index", filepath.Join(t.TempDir(), "missing.json")}, strings.NewReader(""), &buf, false)
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if code != 1 || !strings.Contains(lines[len(lines)-1], `"ev":"result"`) {
		t.Fatalf("code %d, output %s", code, buf.String())
	}
	for in, want := range map[error]int{nil: 0, &core.Refused{Msg: "x"}: 2, core.ErrNoLink: 3, errors.New("x"): 1} {
		if got := resultOf(in, "").exit(); got != want {
			t.Errorf("%v: exit %d, want %d", in, got, want)
		}
	}
}
