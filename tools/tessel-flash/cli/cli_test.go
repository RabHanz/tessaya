package cli

import (
	"bufio"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/RabHanz/tessaya/tools/tessel-flash/core"
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

func TestDataDirMovesTheR1flashFolderOnce(t *testing.T) {
	cfg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfg)
	t.Setenv("HOME", cfg)
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(base, "r1flash")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "backup.bin"), []byte("settings"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir, err := dataDir("")
	if err != nil || dir != filepath.Join(base, "tessel-flash") {
		t.Fatalf("dataDir = %q, %v", dir, err)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "backup.bin")); err != nil || string(b) != "settings" {
		t.Fatalf("backup after the move = %q, %v", b, err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("old folder still there: %v", err)
	}
	// A second run finds the new folder and leaves it be.
	if again, err := dataDir(""); err != nil || again != dir {
		t.Fatalf("second dataDir = %q, %v", again, err)
	}
}
