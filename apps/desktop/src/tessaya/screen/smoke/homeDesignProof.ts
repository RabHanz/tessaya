// @effect-diagnostics globalDate:off globalRandom:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * The Home window's look, on a real Windows desktop: a frame of every page and the New session sheet and settings dialog, dark and
 * light, with glass on, off and reduced (and Motion reduced); short clips of the signature motions (page entrance, sidebar spring and
 * status morph, the New session sheet, the first-run reveal); and the cost of it all: idle CPU, CPU and frame times while pages
 * switch, and the most animations running at once. Run against main and against a branch, the two sets are the before and the after.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { createTessayaHome } from "../../home/tessayaHome.ts";
import { applyLookScript } from "../../home/look.ts";
import { proofState } from "./homeProofState.ts";

const out = process.env["PROOF_OUT"] ?? NodePath.join(process.cwd(), "home-design-out");
NodeFS.mkdirSync(out, { recursive: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
setTimeout(() => Electron.app.exit(3), 14 * 60_000).unref();

const startClip = (id: string) => {
  const child = NodeChildProcess.spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "gdigrab",
      "-framerate",
      "30",
      "-i",
      "desktop",
      "-vf",
      "crop=1024:740:0:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      NodePath.join(out, `${id}.mp4`),
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

const PAGES = [
  "home",
  "now",
  "sessions",
  "sessions-new",
  "approvals",
  "jobs",
  "cloud",
  "dictation",
  "history",
  "snippets",
  "transforms",
  "style",
  "scratchpad",
  "insights",
  "memory",
  "vault",
  "tools",
  "assistant",
  "voice",
  "screen",
  "usage",
  "trust",
  "checks",
  "help",
  "settings",
  "palette",
];
const KEY_PAGES = ["home", "sessions-new", "approvals", "settings", "palette"];
const LOOKS: ReadonlyArray<{ name: string; classes: string[]; pages: string[] }> = [
  { name: "glass", classes: [], pages: PAGES },
  { name: "glass-off", classes: ["glass-off"], pages: KEY_PAGES },
  {
    name: "glass-reduced-motion-reduced",
    classes: ["glass-reduced", "motion-reduced"],
    pages: KEY_PAGES,
  },
];

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

void Electron.app.whenReady().then(async () => {
  let creating = false;
  let label = "Listening";
  const state = () => ({
    ...proofState({ creating }),
    status: {
      label,
      tone: label === "Muted" ? "off" : "good",
      device: "Headset",
      mark: "",
      brandMark: "",
    },
  });
  const home = createTessayaHome({
    stateDir: out,
    state: () => state() as never,
    apply: () => undefined,
    openSessions: () => undefined,
    appearance: () => "dark",
  });
  home.open();
  await sleep(4500);
  const win = Electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win === undefined) throw new Error("the Home window did not open");
  win.setBounds({ x: 0, y: 0, width: 1024, height: 740 });
  win.show();
  win.focus();
  // The runner's Windows asks for reduced motion, which switches every animation off; the proof measures the full-motion window.
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  const js = (code: string) => win.webContents.executeJavaScript(code) as Promise<unknown>;
  const lines: string[] = ["# Home design proof", ""];
  const log = (s: string) => (lines.push(s), console.log(s));
  await sleep(1500);
  log(
    `root classes: \`${String(await js("document.documentElement.className"))}\` (live must be there for motion)`,
  );

  const settle = async (ms = 1000) => sleep(ms);
  const show = async (page: string) => {
    await js("if(typeof palClose==='function'&&palOpen)palClose();if(modal)closeModal();0");
    const wantNew = page === "sessions-new";
    if (creating !== wantNew) {
      creating = wantNew;
      home.refresh();
      await sleep(300);
    }
    if (page === "settings") await js("modal='general';render();0");
    else if (page === "palette") await js("go('home');palOpenNow();0");
    else await js(`go(${JSON.stringify(wantNew ? "sessions" : page)});0`);
    await settle();
  };

  // 1. Frames.
  for (const theme of ["dark", "light"] as const) {
    await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};0`);
    for (const look of LOOKS) {
      await js(applyLookScript(look.classes));
      await sleep(300);
      for (const page of look.pages) {
        await show(page);
        NodeFS.writeFileSync(
          NodePath.join(out, `frame-${theme}-${look.name}-${page}.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
    }
  }
  await js(applyLookScript([]));
  await js("document.documentElement.dataset.theme='dark';0");
  await show("home");
  log(`frames: ${NodeFS.readdirSync(out).filter((f) => f.endsWith(".png")).length}`);

  // 2. Cost: idle, then page switching.
  const cpu = async (ms: number) => {
    Electron.app.getAppMetrics();
    const samples: number[] = [];
    for (let t = 0; t < ms; t += 500) {
      await sleep(500);
      samples.push(Electron.app.getAppMetrics().reduce((n, m) => n + m.cpu.percentCPUUsage, 0));
    }
    return {
      mean: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length),
      max: Math.max(...samples),
    };
  };
  const idle = await cpu(10_000);
  const idleAnims = (await js("document.getAnimations().length")) as number;
  await js(
    "window.__ft={d:[],peak:0,last:0,on:true};const f=t=>{const z=window.__ft;if(!z.on)return;if(z.last)z.d.push(t-z.last);z.last=t;const n=document.getAnimations().length;if(n>z.peak)z.peak=n;requestAnimationFrame(f)};requestAnimationFrame(f);0",
  );
  const cycle = [
    "sessions",
    "dictation",
    "memory",
    "voice",
    "home",
    "approvals",
    "history",
    "trust",
  ];
  const busy = (async () => {
    for (let round = 0; round < 3; round += 1)
      for (const p of cycle) {
        await js(`go(${JSON.stringify(p)});0`);
        await sleep(450);
      }
  })();
  const moving = await cpu(11_000);
  await busy;
  const ft = (await js("window.__ft.on=false;({d:window.__ft.d,peak:window.__ft.peak})")) as {
    d: number[];
    peak: number;
  };
  const metrics = {
    idleCpuMeanPercent: Number(idle.mean.toFixed(2)),
    idleCpuMaxPercent: Number(idle.max.toFixed(2)),
    idleAnimationsRunning: idleAnims,
    switchingCpuMeanPercent: Number(moving.mean.toFixed(2)),
    switchingCpuMaxPercent: Number(moving.max.toFixed(2)),
    frames: ft.d.length,
    frameMsP50: Number(percentile(ft.d, 0.5).toFixed(1)),
    frameMsP95: Number(percentile(ft.d, 0.95).toFixed(1)),
    frameMsMax: Number(Math.max(0, ...ft.d).toFixed(1)),
    framesOver20ms: ft.d.filter((x) => x > 20).length,
    framesOver34ms: ft.d.filter((x) => x > 34).length,
    peakAnimationsAtOnce: ft.peak,
  };
  // Which part costs what: the same page switching with one thing switched off by an injected rule.
  const experiments: Record<string, number> = {};
  for (const [name, css] of [
    ["control", ""],
    [
      "no-blur",
      "#side::before,.state,#top .search,#modal,.palbox,.pop{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}",
    ],
    ["no-entrance", "#page.enter>*,#page.enter>.group>*{animation:none!important}"],
    ["no-wash", "#app::before,#page::before{display:none!important}"],
    [
      "no-blur-no-entrance",
      "#side::before,.state,#top .search{backdrop-filter:none!important}#page.enter>*,#page.enter>.group>*{animation:none!important}",
    ],
  ] as const) {
    await js(
      `(()=>{let e=document.getElementById('exp');if(!e){e=document.createElement('style');e.id='exp';document.head.appendChild(e)}e.textContent=${JSON.stringify(css)}})();0`,
    );
    await sleep(500);
    const run = (async () => {
      for (const p of cycle) {
        await js(`go(${JSON.stringify(p)});0`);
        await sleep(450);
      }
    })();
    const r = await cpu(4000);
    await run;
    experiments[name] = Number(r.mean.toFixed(2));
  }
  await js("document.getElementById('exp').textContent='';0");
  Object.assign(metrics, { experimentsSwitchingCpuMeanPercent: experiments });
  NodeFS.writeFileSync(NodePath.join(out, "metrics.json"), JSON.stringify(metrics, null, 2));
  for (const [k, v] of Object.entries(metrics))
    log(`- ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);

  // 3. Clips of the signature motions.
  await show("home");
  let stop = startClip("pages-entrance");
  await sleep(800);
  for (const p of ["sessions", "dictation", "memory", "home", "voice", "approvals", "home"]) {
    await js(`go(${JSON.stringify(p)});0`);
    await sleep(1100);
  }
  await stop();

  await show("home");
  stop = startClip("sidebar-spring-and-status-morph");
  await sleep(600);
  for (const [p, l] of [
    ["now", "Muted"],
    ["sessions", "Listening"],
    ["history", "Muted"],
    ["trust", "Listening"],
    ["home", "Listening"],
  ] as const) {
    await js(`go(${JSON.stringify(p)});0`);
    label = l;
    home.refresh();
    await sleep(1300);
  }
  await stop();

  await show("sessions");
  stop = startClip("new-session-sheet");
  await sleep(700);
  creating = true;
  home.refresh();
  await sleep(1600);
  creating = false;
  home.refresh();
  await sleep(1000);
  await js("modal='general';render();0");
  await sleep(1300);
  await js("closeModal();0");
  await sleep(900);
  await js("palOpenNow();0");
  await sleep(1300);
  await js("palClose();0");
  await sleep(600);
  await stop();

  stop = startClip("first-run-reveal");
  await sleep(500);
  win.webContents.reload();
  await sleep(3500);
  await stop();

  NodeFS.writeFileSync(NodePath.join(out, "results.md"), `${lines.join("\n")}\n`);
  Electron.app.exit(0);
});
