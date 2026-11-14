package core

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func image(n int) []byte {
	img := make([]byte, n)
	for i := range img {
		img[i] = byte(i*31 + i/4096)
	}
	// an all-0xFF sector is erased but not written
	if n >= 0x4000 {
		copy(img[0x3000:0x4000], bytes.Repeat([]byte{0xff}, 0x1000))
	}
	return img
}

func link(t *testing.T, s *sim, rep *logRep, o LinkOpts) *ROM {
	t.Helper()
	if o.Wait == 0 {
		o.Wait = 30 * time.Second
	}
	r, err := Link(s, s.clk, rep, o)
	if err != nil {
		t.Fatalf("link: %v\n%s", err, strings.Join(rep.lines, "\n"))
	}
	return r
}

func settings(s *sim) []byte { return s.mem[SettingsStart : SettingsStart+SettingsLen] }

func TestFlashFromTheConsole(t *testing.T) {
	s := newSim()
	s.mode, s.reenum = "fw", true
	rep := &logRep{}
	before := append([]byte(nil), settings(s)...)
	r := link(t, s, rep, LinkOpts{Kick: true})
	if s.reopens == 0 {
		t.Fatal("the CH340 re-enumerated on the reset, but the port was never reopened")
	}
	if r.Proto != ProtoFull || r.FlashSize != R1FlashSize || r.ChipID != 0x7258 || s.maxBaud != TransferBaud {
		t.Fatalf("linked as %s at %d baud", r.ChipInfo(), s.maxBaud)
	}
	img := image(0x90000)
	st := memStore{}
	backup, err := r.Flash(img, st, "t")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(s.mem[:len(img)], img) || !bytes.Equal(settings(s), before) || !bytes.Equal(st[backup], before) {
		t.Fatal("image or settings wrong after the flash")
	}
	if s.mode != "fw" || s.rebooted != 1 || len(st) != 1 {
		t.Fatalf("mode %s, rebooted %d, store %v", s.mode, s.rebooted, len(st))
	}
	for _, a := range s.writes {
		if a == 0x3000 {
			t.Fatal("an empty sector was written")
		}
	}
	if s.protected() {
		t.Fatal("flash left protected")
	}
}

func TestStuckROMLinksAtTheTransferRate(t *testing.T) {
	s := newSim()
	s.romBaud = TransferBaud // a link that switched the ROM's rate, then failed
	rep := &logRep{}
	r := link(t, s, rep, LinkOpts{})
	if r.LinkBaud != TransferBaud || !rep.has("linked at 460800") {
		t.Fatalf("linked at %d", r.LinkBaud)
	}
	if _, err := r.Flash(image(0x2000), memStore{}, "t"); err != nil {
		t.Fatal(err)
	}
}

func TestBootLoopShowsTheROMOnlyInShortWindows(t *testing.T) {
	s := newSim()
	s.mode, s.windowEvery, s.windowLen = "dead", 5*time.Second, 40*time.Millisecond
	s.start = s.clk.t.Add(-time.Second) // the next window opens 4 s in
	rep := &logRep{}
	r := link(t, s, rep, LinkOpts{Wait: 20 * time.Second})
	if _, err := r.Flash(image(0x2000), memStore{}, "t"); err != nil {
		t.Fatal(err)
	}
}

func TestNoLinkInTheWindow(t *testing.T) {
	s := newSim()
	s.mode = "dead"
	if _, err := Link(s, s.clk, &logRep{}, LinkOpts{Wait: 10 * time.Second}); !errors.Is(err, ErrNoLink) {
		t.Fatalf("got %v", err)
	}
}

func TestLinkDropResumesAtTheLastChunk(t *testing.T) {
	s := newSim()
	img := image(0x100000) // 4 chunks of 256 KB, 256 sectors
	s.dropAfter = 240      // about 94%
	st := memStore{}
	r := link(t, s, &logRep{}, LinkOpts{})
	if _, err := r.Flash(img, st, "a"); err == nil {
		t.Fatal("the flash should fail when the link drops")
	}
	prog := "progress-" + shortHash(img) + ".txt"
	if n, _ := strconv.Atoi(string(st[prog])); n != 3*chunk {
		t.Fatalf("resume marker %q", st[prog])
	}
	// the cable is replugged; the ROM is back
	s.dropped, s.dropAfter, s.writes, s.in, s.out = false, -1, nil, nil, nil
	s.mode, s.romBaud = "rom", ConsoleBaud
	r = link(t, s, &logRep{}, LinkOpts{})
	if _, err := r.Flash(img, st, "b"); err != nil {
		t.Fatal(err)
	}
	if s.writes[0] < 3*chunk {
		t.Fatalf("restarted at 0x%X instead of resuming", s.writes[0])
	}
	if !bytes.Equal(s.mem[:len(img)], img) {
		t.Fatal("image wrong after resume")
	}
	if _, ok := st[prog]; ok {
		t.Fatal("resume marker left behind")
	}
}

func TestSettingsClobberedByTheWriteAreRestored(t *testing.T) {
	s := newSim()
	s.clobber = true
	before := append([]byte(nil), settings(s)...)
	rep := &logRep{}
	r := link(t, s, rep, LinkOpts{})
	if _, err := r.Flash(image(0x2000), memStore{}, "t"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(settings(s), before) || !rep.has("restoring the backup") {
		t.Fatal("settings not restored")
	}
}

func TestRefusals(t *testing.T) {
	for _, tc := range []struct {
		name string
		mid  [3]byte
		img  []byte
	}{
		{"unknown flash id", [3]byte{0x12, 0x34, 0x17}, image(0x2000)},
		{"4 MiB flash", [3]byte{0x0b, 0x40, 0x16}, image(0x2000)},
		{"image reaches the settings", [3]byte{0x0b, 0x40, 0x17}, image(SettingsStart + 1)},
		{"empty image", [3]byte{0x0b, 0x40, 0x17}, bytes.Repeat([]byte{0xff}, 0x1000)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newSim()
			s.mid = tc.mid
			r := link(t, s, &logRep{}, LinkOpts{})
			var ref *Refused
			if _, err := r.Flash(tc.img, memStore{}, "t"); !errors.As(err, &ref) {
				t.Fatalf("got %v", err)
			}
			if len(s.writes) != 0 {
				t.Fatal("wrote after a refusal")
			}
		})
	}
}

func TestBasicBootloaderProtocol(t *testing.T) {
	s := newSim()
	s.full, s.sr = false, 0
	r := link(t, s, &logRep{}, LinkOpts{})
	if r.Proto != ProtoBasic || r.FlashSize != R1FlashSize {
		t.Fatalf("got %s", r.ChipInfo())
	}
	img := image(0x5000)
	if _, err := r.Flash(img, memStore{}, "t"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(s.mem[:len(img)], img) {
		t.Fatal("image wrong")
	}
}

func TestBackupAndRestore(t *testing.T) {
	s := newSim()
	st := memStore{}
	name, err := link(t, s, &logRep{}, LinkOpts{}).Backup(st, "t")
	if err != nil || !bytes.Equal(st[name], settings(s)) {
		t.Fatalf("backup: %v", err)
	}
	copy(s.mem[SettingsStart:], "something else")
	s.mode = "rom"
	if err := link(t, s, &logRep{}, LinkOpts{}).Restore(st[name]); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(settings(s), st[name]) || s.mode != "fw" {
		t.Fatal("restore did not put the backup back")
	}
}

func TestConsoleDetectAndStatus(t *testing.T) {
	s := newSim()
	s.mode = "fw"
	s.status = `{"fw":"smp-0.3.95","session":true,"call":false,"battery":12,"charging":false}`
	d, err := Detect(s, s.clk, &logRep{})
	if err != nil || d.State != "console" || d.FW != "smp-0.3.95" {
		t.Fatalf("%+v %v", d, err)
	}
	if Live(d.Status) == "" || LowBattery(d.Status, 15) != 12 {
		t.Fatal("status guards missed a live conversation or a low battery")
	}
	s.mode = "rom"
	if d, _ := Detect(s, s.clk, &logRep{}); d.State != "bootrom" {
		t.Fatalf("got %s", d.State)
	}
	s.mode = "dead"
	if d, _ := Detect(s, s.clk, &logRep{}); d.State != "silent" {
		t.Fatalf("got %s", d.State)
	}
}

func TestWatchBootAfterTheReset(t *testing.T) {
	s := newSim()
	s.reenum, s.bootText = true, "boot smp-0.3.95\r\nREADY\r\n"
	r := link(t, s, &logRep{}, LinkOpts{})
	if _, err := r.Flash(image(0x2000), memStore{}, "t"); err != nil {
		t.Fatal(err)
	}
	if fw, ok := WatchBoot(s, s.clk, 90*time.Second); !ok || fw != "smp-0.3.95" {
		t.Fatalf("boot watch: %q %v", fw, ok)
	}
}

func TestSignatureVectors(t *testing.T) {
	raw, err := os.ReadFile("../testdata/sig-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Cases []struct {
			Name, PublicKey, File, DataHex, Sig, SHA256 string
			FlipByte                                    *int
			Valid                                       bool
		}
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cases {
		pub, err := ParsePublicKey(c.PublicKey)
		if err != nil {
			t.Fatal(err)
		}
		var data []byte
		if c.File != "" {
			if data, err = os.ReadFile(filepath.Join("../testdata", c.File)); err != nil {
				t.Fatal(err)
			}
		} else if data, err = hex.DecodeString(c.DataHex); err != nil {
			t.Fatal(err)
		}
		if c.SHA256 != "" {
			if h := sha256.Sum256(data); hex.EncodeToString(h[:]) != c.SHA256 {
				t.Fatalf("%s: sha256 differs", c.Name)
			}
		}
		if c.FlipByte != nil {
			data[*c.FlipByte] ^= 1
		}
		if VerifySig(pub, data, c.Sig) != c.Valid {
			t.Errorf("%s: want valid=%v", c.Name, c.Valid)
		}
	}
	if pub, _ := ParsePublicKey(ReleasePublicKey); pub == nil {
		t.Fatal("release key does not parse")
	}
}

func sign(t *testing.T, key *ecdsa.PrivateKey, data []byte) string {
	h := sha256.Sum256(data)
	r, s, err := ecdsa.Sign(rand.Reader, key, h[:])
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...))
}

func TestReleaseList(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	img := []byte("cable image 0.3.98")
	h := sha256.Sum256(img)
	art := &Artifact{URL: "x", Size: len(img), SHA256: hex.EncodeToString(h[:]), Sig: sign(t, key, img)}
	ix := Index{V: 1, Recommended: "smp-0.3.98", Releases: []Release{
		{Version: "smp-0.3.95", AllApp: nil},
		{Version: "smp-0.3.98", AllApp: art},
	}}
	body, _ := json.Marshal(ix)
	sig := sign(t, key, body)
	got, err := ParseIndex(body, sig, &key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if r, err := got.CableImage(""); err != nil || r.Version != "smp-0.3.98" {
		t.Fatalf("recommended: %v %v", r, err)
	}
	var ref *Refused
	if _, err := got.CableImage("smp-0.3.95"); !errors.As(err, &ref) || !strings.Contains(err.Error(), "no cable image") {
		t.Fatalf("a release without a cable image: %v", err)
	}
	if err := CheckArtifact(img, art, &key.PublicKey); err != nil {
		t.Fatal(err)
	}
	if err := CheckArtifact(append([]byte("x"), img[1:]...), art, &key.PublicKey); err == nil {
		t.Fatal("a changed image passed")
	}
	// moving a version label onto another release's image breaks the list's signature
	swapped := bytes.Replace(body, []byte("smp-0.3.95"), []byte("smp-0.3.99"), 1)
	if _, err := ParseIndex(swapped, sig, &key.PublicKey); !errors.As(err, &ref) {
		t.Fatalf("a changed list passed: %v", err)
	}
	if VerifySig(&key.PublicKey, img, hex.EncodeToString(new(big.Int).Bytes())) {
		t.Fatal("an empty signature passed")
	}
}
