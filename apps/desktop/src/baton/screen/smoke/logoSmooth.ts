// @effect-diagnostics globalDate:off globalRandom:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * Watches the sidebar logo of the real Home window for 16 s while the sidebar is rebuilt four times. It samples the
 * mark's animation clock (a restart would send it backwards), checks it is the same element (never taken out of the page) throughout, and diffs
 * consecutive captures of its rectangle (a jump would show as one large change). Writes results.md and a recording.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { createBatonHome } from "../../home/batonHome.ts";
import { STATES } from "../../home/pageStates.ts";
import { brandMarkSvg } from "../../voice/trayMark.ts";

const out = process.env["PROOF_OUT"] ?? NodePath.join(process.cwd(), "logo-smooth-out");
NodeFS.mkdirSync(out, { recursive: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
setTimeout(() => Electron.app.exit(3), 5 * 60_000).unref();

const startClip = () => {
  const child = NodeChildProcess.spawn(
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
      "crop=360:140:0:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      NodePath.join(out, "logo.mp4"),
    ],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
  );
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  return () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => (child.kill(), resolve()), 15_000);
      child.on("exit", () => (clearTimeout(timer), resolve()));
      child.on("error", () => resolve());
      child.stdin.write("q");
    });
};

void Electron.app.whenReady().then(async () => {
  const base = STATES["empty"]!;
  const state = {
    status: { label: "Listening", tone: "good", device: "", mark: "", brandMark: brandMarkSvg() },
    controls: base.controls,
    ...(base.extra === undefined ? {} : { extra: base.extra }),
  };
  createBatonHome({
    stateDir: out,
    state: () => state as never,
    apply: () => undefined,
    openSessions: () => undefined,
    appearance: () => "dark",
  }).open();
  await sleep(4000);
  const win = Electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win === undefined) throw new Error("the Home window did not open");
  win.setBounds({ x: 0, y: 0, width: 1024, height: 740 });
  win.show();
  win.focus();
  await sleep(1500);
  const js = (code: string) => win.webContents.executeJavaScript(code) as Promise<unknown>;
  // A CI desktop may report reduced motion, which switches the animation off; the real window is watched with it allowed.
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await sleep(500);
  const live = (await js("document.documentElement.classList.contains('live')")) as boolean;
  await js("window.__mark=document.getElementById('mark');0");
  const rect = (await js(
    "(()=>{const r=document.getElementById('mark').getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()",
  )) as Electron.Rectangle;

  const stopClip = startClip();
  await sleep(1000);
  const started = Date.now();
  const clocks: number[] = [];
  const diffs: number[] = [];
  let same = true;
  let previous: Buffer | null = null;
  let rebuilds = 0;
  while (Date.now() - started < 16_000) {
    const elapsed = Date.now() - started;
    if (elapsed > (rebuilds + 1) * 3000 && rebuilds < 4) {
      rebuilds += 1;
      await js("go('sessions');go('home');0");
    }
    const probe = (await js(
      "({same:document.getElementById('mark')===window.__mark,t:(document.getElementById('mark').getAnimations()[0]||{}).currentTime??-1})",
    )) as { same: boolean; t: number };
    same = same && probe.same;
    clocks.push(probe.t);
    const shot = await win.webContents.capturePage(rect);
    const frame = shot.toBitmap();
    if (elapsed < 200) {
      NodeFS.writeFileSync(NodePath.join(out, "first.png"), shot.toPNG());
      console.log(
        `first frame ${shot.getSize().width}x${shot.getSize().height}, bytes set ${frame.filter((b) => b !== 0).length}, rect ${JSON.stringify(rect)}`,
      );
    }
    if (elapsed > 9000 && elapsed < 9200)
      NodeFS.writeFileSync(NodePath.join(out, "mid.png"), shot.toPNG());
    if (previous !== null && previous.length === frame.length) {
      let sum = 0;
      for (let i = 0; i < frame.length; i += 1) sum += Math.abs(frame[i]! - previous[i]!);
      diffs.push(sum / frame.length);
    }
    previous = frame;
    await sleep(60);
  }
  await stopClip();

  const restarts = clocks.filter((t, i) => i > 0 && t < clocks[i - 1]!).length;
  const maxDiff = Math.max(0, ...diffs);
  const moved =
    clocks.filter((t) => t >= 0).length > clocks.length / 2 && Math.max(0, ...clocks) > 5000;
  const changing = diffs.some((d) => d > 0);
  const verdict = live && same && moved && changing && restarts === 0 && maxDiff < 4;
  const lines = [
    `### Sidebar logo: ${verdict ? "smooth" : "NOT smooth"}`,
    `- window in front (html.live): ${live}`,
    `- same element (never taken out of the page) through ${rebuilds} sidebar rebuilds: ${same}`,
    `- animation running (clock passed ${Math.round(Math.max(0, ...clocks))} ms) and the logo pixels changing: ${moved && changing}`,
    `- animation clock restarts: ${restarts} of ${clocks.length} samples`,
    `- frames compared: ${diffs.length}; largest change between neighbouring frames: ${maxDiff.toFixed(2)} of 255 (a jump would be well above 4)`,
  ];
  NodeFS.writeFileSync(NodePath.join(out, "results.md"), lines.join("\n"));
  NodeFS.writeFileSync(NodePath.join(out, "series.json"), JSON.stringify({ clocks, diffs }));
  console.log(lines.join("\n"));
  Electron.app.exit(verdict ? 0 : 1);
});
