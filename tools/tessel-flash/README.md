# tessel-flash

Called `r1flash` up to release 0.1.1; those releases keep that name.

Update, repair and configure a Tessel over its USB cable. One file, no Tessaya install needed. Download the
binary for your system from the latest `tessel-flash-v*` release and run it. With no arguments it opens a menu.

```
tessel-flash                     menu
tessel-flash ports               list serial ports, mark the likely Tessel
tessel-flash detect              is its firmware running, is it in its loader, or is it silent?
tessel-flash flash [--version X] install a signed release (the recommended one by default)
tessel-flash flash --file F      install an image file (signed with F.sig, or --allow-unsigned)
tessel-flash recover [--probe]   repair a stuck or boot-looping Tessel
tessel-flash backup | restore FILE    save or put back its settings
tessel-flash config get | wifi SSID PASS | endpoints URL... | key HEX | setup
tessel-flash console             its serial console
```

Add `--json` for one JSON event per line (what the Tessaya desktop app reads) and `--trace FILE` to record every
byte on the port. Exit codes: 0 ok, 2 refused, 3 no link with the loader, 1 failure.

**Getting it into its loader.** When tessel-flash says it is waiting for the loader, unplug and replug the Tessel's battery,
or reboot it from Tessaya's Hardware page. `--kick` asks its console to reboot instead. That can make it reboot
before the loader links, so it is off by default.

**Safety.** Release images are checked against the release key before anything is written. The settings area
(0x7E7000 to 0x800000) is backed up first and put back if the write touched it. A dropped link resumes at the last
256 KB written. A running Tessel in a conversation or call is never flashed unless you pass `--force`. Backups, the image
cache and a log of every run live in your user config folder, under `tessel-flash` (an `r1flash` folder from before moves there on first run).

**Drivers.**

- **Windows 10/11:** the CH340 driver usually installs by itself. If Device Manager shows no COM port, install WCH's
  CH341SER.
- **macOS 11+:** the CH340 driver is built in. CP210x boards need the Silicon Labs VCP driver.
- **Linux:** add yourself to `dialout` (Debian, Ubuntu) or `uucp` (Arch). On Ubuntu 22.04+, remove `brltty` if the
  port vanishes when the Tessel is plugged in.
- The binaries are not code-signed yet. On Windows choose "More info, Run anyway". On macOS run
  `xattr -d com.apple.quarantine tessel-flash` once.

The bootrom protocol is a Go port of [bk7231tools](https://github.com/tuya-cloudcutter/bk7231tools) 2.1.2 (MIT,
Kuba Szczodrzyński). `core/` has no OS dependencies and also builds for `GOOS=js GOARCH=wasm`.
