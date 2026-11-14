// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * Proves the screenshot-to-screen mapping on a real display setup. It draws numbered markers at
 * known desktop positions, captures with the product's own code, finds each marker in the image,
 * and maps it back with `toDesktop`; then asks the real model for the same markers. Every number
 * is an error in pixels against a position we chose. Run under the lab shell; see SCREEN.md.
 */
/* oxlint-disable t3code/no-global-process-runtime -- standalone lab harness, no Effect runtime */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { LOOK_PROMPT, parseReply, toDesktop } from "@t3tools/tessaya-shared/screenCompanion";
import * as Electron from "electron";

import { startVisionSession } from "../claudeVision.ts";
import { captureScreens } from "../screenCapture.ts";

const out = process.env["LAB_OUT"] ?? process.cwd();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report = NodeFS.createWriteStream(NodePath.join(out, "timeline.jsonl"));
const write = (value: unknown) => report.write(`${JSON.stringify(value)}\n`);

const page = (marks: ReadonlyArray<{ n: number; x: number; y: number }>) =>
  `data:text/html,${encodeURIComponent(
    `<!doctype html><body style="margin:0;background:transparent;overflow:hidden">${marks
      .map(
        (m) =>
          `<div style="position:absolute;left:${m.x - 14}px;top:${m.y - 14}px;width:28px;height:28px;border-radius:50%;background:#ff00ff;color:#fff;font:bold 16px/28px sans-serif;text-align:center">${m.n}</div>`,
      )
      .join("")}</body>`,
  )}`;

const main = async () => {
  await Electron.app.whenReady();
  // The markers close before the model runs, and the app must outlive them.
  Electron.app.on("window-all-closed", () => {});
  const windows: Electron.BrowserWindow[] = [];
  const truth = new Map<number, Array<{ n: number; x: number; y: number }>>();
  let n = 0;
  for (const display of Electron.screen.getAllDisplays()) {
    const { width, height } = display.bounds;
    const marks = [0.08, 0.5, 0.92].flatMap((fy) =>
      [0.08, 0.5, 0.92].map((fx) => ({
        n: ++n,
        x: Math.round(width * fx),
        y: Math.round(height * fy),
      })),
    );
    truth.set(display.id, marks);
    write({ display: display.id, bounds: display.bounds, scale: display.scaleFactor });
    const win = new Electron.BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      enableLargerThanScreen: true,
    });
    win.setIgnoreMouseEvents(true);
    // Set, the markers must be absent from the capture: the proof the overlay stays out of it.
    if (process.env["LAB_PROTECT"] === "1") win.setContentProtection(true);
    await win.loadURL(page(marks));
    win.setBounds(display.bounds);
    win.showInactive();
    win.setAlwaysOnTop(true, "screen-saver");
    win.setBounds(display.bounds);
    write({ asked: display.bounds, got: win.getBounds(), visible: win.isVisible() });
    windows.push(win);
  }
  await sleep(900);
  const captured = await captureScreens();
  for (const win of windows) win.destroy();
  write({ captured: captured.map((c) => c.shot) });

  const claude = process.env["LAB_REAL_CLAUDE"] ?? "claude";
  for (const { shot, jpeg } of captured) {
    NodeFS.writeFileSync(NodePath.join(out, `grid-screen${shot.screen}.jpg`), jpeg);
    const display = Electron.screen
      .getAllDisplays()
      .find((d) => d.bounds.x === shot.bounds.x && d.bounds.y === shot.bounds.y)!;
    const image = Electron.nativeImage.createFromBuffer(jpeg);
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap(); // BGRA
    for (const mark of truth.get(display.id) ?? []) {
      const expected = {
        x: (mark.x * width) / shot.bounds.width,
        y: (mark.y * height) / shot.bounds.height,
      };
      const span = 40;
      let sx = 0;
      let sy = 0;
      let count = 0;
      for (
        let y = Math.max(0, Math.round(expected.y) - span);
        y < Math.min(height, expected.y + span);
        y++
      ) {
        for (
          let x = Math.max(0, Math.round(expected.x) - span);
          x < Math.min(width, expected.x + span);
          x++
        ) {
          const i = (y * width + x) * 4;
          if (bitmap[i + 2]! > 190 && bitmap[i + 1]! < 90 && bitmap[i]! > 190) {
            sx += x;
            sy += y;
            count += 1;
          }
        }
      }
      if (count === 0) {
        write({ screen: shot.screen, mark: mark.n, found: false });
        continue;
      }
      const back = toDesktop({ x: sx / count, y: sy / count }, shot);
      write({
        screen: shot.screen,
        mark: mark.n,
        imagePx: [Math.round(sx / count), Math.round(sy / count)],
        mappingErrorDip: Math.round(
          Math.hypot(back.x - (shot.bounds.x + mark.x), back.y - (shot.bounds.y + mark.y)),
        ),
      });
    }
  }
  if (process.env["LAB_GRID_MODEL"] === "1") {
    for (const { shot, jpeg } of captured) {
      const display = Electron.screen
        .getAllDisplays()
        .find((d) => d.bounds.x === shot.bounds.x && d.bounds.y === shot.bounds.y)!;
      for (const mark of (truth.get(display.id) ?? []).filter((_, i) => i % 2 === 0)) {
        // A fresh session each time, so one marker's answer cannot help the next.
        const vision = startVisionSession({
          claudeBinary: claude,
          model: "sonnet",
          systemPrompt: LOOK_PROMPT,
          workDir: NodePath.join(out, "state"),
          env: process.env,
          platform: process.platform,
          timeoutMs: 40_000,
        });
        const started = Date.now();
        const raw = await vision
          .ask([
            { type: "text", text: `screen ${shot.screen}, image ${shot.width}x${shot.height}` },
            { type: "image", mediaType: "image/jpeg", data: jpeg },
            { type: "text", text: `point at the magenta circle numbered ${mark.n}` },
          ])
          .catch((error: Error) => `[failed ${error.message}]`);
        vision.dispose();
        const point = parseReply(raw).point;
        const landed = point === null ? null : toDesktop(point, shot);
        write({
          screen: shot.screen,
          mark: mark.n,
          model: point,
          raw: point === null ? raw.slice(0, 120) : undefined,
          modelErrorDip:
            landed === null
              ? null
              : Math.round(
                  Math.hypot(
                    landed.x - (shot.bounds.x + mark.x),
                    landed.y - (shot.bounds.y + mark.y),
                  ),
                ),
          ms: Date.now() - started,
        });
      }
    }
  }
  report.end(() => Electron.app.exit(0));
};

void main().catch((error: unknown) => {
  write({ error: String(error) });
  report.end(() => Electron.app.exit(1));
});
