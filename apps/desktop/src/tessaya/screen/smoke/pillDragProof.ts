// @effect-diagnostics globalDate:off globalRandom:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * Drags the real pill window with the real mouse (SendInput through the input driver): press on the capsule, move in
 * steps, release. The window must end up where the pointer left it, and a second pill built over the same state
 * folder (a restart) must come up in that place. Records the desktop and writes results.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { hiddenForCapture } from "../../captureProtection.ts";
import { createTessayaHome } from "../../home/tessayaHome.ts";
import { STATES } from "../../home/pageStates.ts";
import { createInputDriver } from "../inputDriver.ts";
import { createVoicePill } from "../../voice/voicePill.ts";

const out = process.env["PROOF_OUT"] ?? NodePath.join(process.cwd(), "pill-drag-out");
NodeFS.mkdirSync(out, { recursive: true });
const progress = (m: string) =>
  NodeFS.appendFileSync(NodePath.join(out, "progress.log"), `${new Date().toISOString()} ${m}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
setTimeout(() => (progress("timed out"), Electron.app.exit(3)), 9 * 60_000).unref();

const clip = NodeChildProcess.spawn(
  "ffmpeg",
  [
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    "15",
    "-i",
    "desktop",
    "-vf",
    "scale=-2:720",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "26",
    "-pix_fmt",
    "yuv420p",
    NodePath.join(out, "drag.mp4"),
  ],
  { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
);
clip.on("error", () => undefined);
clip.stdin.on("error", () => undefined);
const stopClip = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => (clip.kill(), resolve()), 15_000);
    clip.on("exit", () => (clearTimeout(timer), resolve()));
    clip.stdin.write("q");
  });

type Mode =
  | "move handle"
  | "always-on rest"
  | "speaking"
  | "listening (Wake now)"
  | "listening after a screen look";
const makePill = (stateDir: string, mode: Mode) =>
  createVoicePill({
    cueGain: () => 0,
    rest: () => mode === "always-on rest",
    edge: () => "bottom",
    captureDir: out,
    stateDir,
    holdEscape: () => () => undefined,
    onDismiss: () => progress("dismissed"),
    onDrag: (o) => progress(`drag outcome ${JSON.stringify(o)}`),
  });
const show = (pill: ReturnType<typeof createVoicePill>, mode: Mode) => {
  // Locked by default: every drag below is made with Move pill on.
  pill.setMoving(true);
  if (mode === "move handle") return;
  if (mode === "always-on rest") pill.setRest(true);
  else if (mode === "speaking") {
    pill.on({ type: "speaking", active: true });
    pill.micLevel(0.3);
  } else {
    pill.on({ type: "wake", word: null });
    pill.on({ type: "window_open" });
    pill.micLevel(0.3);
  }
};

const pillWindow = async () => {
  for (const win of Electron.BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const isPill = await win.webContents
      .executeJavaScript("typeof window.pill==='object'")
      .catch(() => false);
    if (isPill === true) return win;
  }
  throw new Error("the pill window is not there");
};
const capsuleCentre = async (win: Electron.BrowserWindow, grip = false) => {
  const r = (await win.webContents.executeJavaScript(
    "(()=>{const r=document.getElementById('p').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width}})()",
  )) as { x: number; y: number; w: number };
  const b = win.getBounds();
  return { x: b.x + r.x - (grip ? r.w / 2 - 8 : 0), y: b.y + r.y };
};

setInterval(() => progress("beat"), 1000);
void Electron.app.whenReady().then(async () => {
  const driver = createInputDriver({
    platform: "win32",
    toPhysical: (p) => Electron.screen.dipToScreenPoint(p),
    clipboard: Electron.clipboard,
  });
  // The app always has a main window; without one the pill's own close-with-the-last-window rule would end the run.
  Electron.app.on("window-all-closed", () => undefined);
  // The real Home window, focused, as when Wake now is pressed there.
  const base = STATES["empty"]!;
  createTessayaHome({
    stateDir: out,
    state: () =>
      ({
        status: { label: "Listening", tone: "good", device: "", mark: "", brandMark: "" },
        controls: base.controls,
        ...(base.extra === undefined ? {} : { extra: base.extra }),
      }) as never,
    apply: () => undefined,
    openSessions: () => undefined,
    appearance: () => "dark",
  }).open();
  await sleep(4000);
  const home = Electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  home?.setBounds({ x: 0, y: 0, width: 800, height: 500 });
  home?.show();
  home?.focus();
  const lines: string[] = [];
  let allOk = true;
  for (const [mode, grip] of [
    ["move handle", false],
    ["always-on rest", false],
    ["speaking", false],
    ["listening (Wake now)", false],
    ["listening (Wake now)", true],
    ["listening after a screen look", false],
  ] as const) {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pill-drag-"));
    let pill = makePill(stateDir, mode);
    pill.warm();
    await sleep(2500);
    show(pill, mode);
    await sleep(2000);
    // Tessaya looks at the screen on a turn: its windows are hidden for the grab and shown again.
    if (mode === "listening after a screen look") {
      await hiddenForCapture(async () => sleep(300), "win32");
      await sleep(500);
    }
    let win = await pillWindow();
    const before = win.getBounds();
    const from = await capsuleCentre(win, grip);
    const to = { x: from.x - 260, y: from.y - 140 };
    // The laptop's sequence: the cursor arrives, 150 ms of hover, button down, about 20 small moves over 600 ms, button up.
    await driver.moveAt(from);
    await sleep(150);
    await driver.pressAt(from);
    for (let i = 1; i <= 20; i += 1) {
      await driver.moveAt({
        x: from.x + ((to.x - from.x) * i) / 20,
        y: from.y + ((to.y - from.y) * i) / 20,
      });
      await sleep(30);
    }
    await driver.releaseAt(to);
    await sleep(1200);
    const after = win.getBounds();
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    pill.dispose();
    await sleep(800);
    pill = makePill(stateDir, mode);
    pill.warm();
    await sleep(2500);
    show(pill, mode);
    await sleep(2000);
    win = await pillWindow();
    const again = win.getBounds();
    const kept = Math.hypot(again.x - after.x, again.y - after.y);
    const ok = moved > 100 && kept < 4;
    allOk = allOk && ok;
    lines.push(
      `| ${mode}, from the ${grip ? "left grip" : "middle"} | ${Math.round(moved)} px | ${Math.round(kept)} px | ${ok ? "ok" : "FAILED"} |`,
    );
    pill.dispose();
    await sleep(800);
  }
  await stopClip();
  const ok = allOk;
  const text = [
    `### Pill drag with the real mouse: ${ok ? "works and the place is kept" : "FAILED"}`,
    "| pill state | moved by the drag (needs 100+) | off after a restart (needs under 4) | result |",
    "| --- | --- | --- | --- |",
    ...lines,
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(out, "results.md"), text);
  console.log(text);
  Electron.app.exit(ok ? 0 : 1);
});
