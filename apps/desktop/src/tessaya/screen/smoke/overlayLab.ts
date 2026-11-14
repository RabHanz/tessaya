// @effect-diagnostics globalDate:off globalRandom:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * Runs the real companion on Windows with a scripted `claude` and silent speech, and writes what
 * the overlay actually showed, every 50 ms, per display, to timeline.jsonl. It exists because a
 * screenshot cannot prove this: the overlay is excluded from capture. See docs/baton/SCREEN.md.
 */
/* oxlint-disable t3code/no-global-process-runtime -- standalone lab harness, no Effect runtime */
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { startScreenCompanion } from "../ScreenCompanion.ts";
import { createPocketEngine } from "../../voice/pocketVoice.ts";
import { createVoicePill } from "../../voice/voicePill.ts";
import { createVoicePlayer } from "../../voice/voicePlayer.ts";
import { createSpeaker, labVoice } from "../../voice/voiceSpeaker.ts";

const out = process.env["LAB_OUT"] ?? NodePath.join(process.cwd(), "lab-out");
const scenarios = (process.env["LAB_SCENARIOS"] ?? "look,other,teach,written,pill").split(",");
const showToCapture = process.env["LAB_VISIBLE"] === "1";
const stateDir = NodePath.join(out, "state");
NodeFS.mkdirSync(stateDir, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(stateDir, "baton-screen.json"),
  JSON.stringify({
    captureApproval: "always",
    claudeBinary: process.env["LAB_CLAUDE"] ?? "claude",
    speak: true,
  }),
);

const line = NodeFS.createWriteStream(NodePath.join(out, "timeline.jsonl"));
const t0 = Date.now();
const note = (event: string, data: object = {}) =>
  line.write(`${JSON.stringify({ t: Date.now() - t0, event, ...data })}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(()=>{const q=s=>document.querySelector(s),o=e=>e?Number(getComputedStyle(e).opacity):null;
const c=q('#card');const p=q('#ptr');const r=p?p.getBoundingClientRect():null;
return {vis:document.visibilityState,ptr:p?(p.classList.contains('on')?1:0):null,px:r?Math.round(r.x):0,py:r?Math.round(r.y):0,tag:o(q('#tag'))>0.5?1:0,
tagText:q('#tag')?.textContent||'',card:c?(c.classList.contains('on')?1:0):null,cx:c?c.style.left:'',cy:c?c.style.top:'',kicker:(q('#k')?.textContent||''),pg:(q('#pg')?.textContent||''),text:(q('#t')?.textContent||'').slice(0,70),
pill:q('#p')?{cls:q('#p').className,label:q('#t')?.textContent,cap:q('#c')?.textContent,tone:q('#p').dataset.tone}:null}})()`;

/** Prints a line when anything an eye would notice changes, so the file reads as a story. */
const watchOverlays = () => {
  const last = new Map<number, string>();
  let pollBusy = false;
  return setInterval(() => {
    if (pollBusy) return;
    pollBusy = true;
    const windows = Electron.BrowserWindow.getAllWindows();
    void Promise.all(
      windows.map(async (win) => {
        if (win.isDestroyed()) return;
        if (showToCapture) win.setContentProtection(false);
        const state = await win.webContents.executeJavaScript(PROBE).catch(() => null);
        if (state === null) return;
        const key = JSON.stringify({ ...state, px: 0, py: 0 });
        if (last.get(win.id) !== key) {
          last.set(win.id, key);
          note("overlay", { win: win.id, visible: win.isVisible(), ...state });
        }
      }),
    ).finally(() => (pollBusy = false));
  }, 50);
};

/** Every state of the pill in turn, for frames and the wake-to-pill number. */
const pillTour = async (
  pill: ReturnType<typeof createVoicePill>,
  log: (event: string, data?: object) => void,
  wait: (ms: number) => Promise<unknown>,
) => {
  const hold = (ms: number, level: ((v: number) => void) | null = null) =>
    level === null
      ? wait(ms)
      : (async () => {
          const pulse = setInterval(() => level(0.25 + Math.random() * 0.7), 45);
          await wait(ms);
          clearInterval(pulse);
        })();
  for (let i = 0; i < 12; i++) {
    log("wake");
    pill.on({ type: "wake", word: "Alfred" });
    await hold(220);
    pill.on({ type: "dismissed" });
    await hold(500);
  }
  pill.on({ type: "wake", word: "Alfred" });
  await hold(1500, pill.micLevel);
  pill.on({ type: "target", name: "to Scheduler" });
  await hold(1200, pill.micLevel);
  pill.on({ type: "heard", text: "what needs me today" });
  await hold(1600);
  pill.on({ type: "speaking", active: true });
  await hold(1600, pill.speechLevel);
  pill.on({ type: "speaking", active: false });
  await hold(700);
  pill.on({ type: "activity", label: "Driving", caption: "Step 2 of 4" });
  await hold(1500);
  pill.on({ type: "activity", label: null });
  pill.on({ type: "dictating", caption: "Esc cancels" });
  await hold(1500, pill.micLevel);
  pill.on({ type: "dictating", caption: null });
  pill.on({ type: "done", label: "Pasted" });
  await hold(1300);
  pill.on({ type: "muted", on: true });
  await hold(1300);
  pill.on({ type: "wake", word: null });
  pill.on({ type: "window_closed" });
  await hold(2000);
  pill.on({ type: "wake", word: "Freya" });
  await hold(4800);
  pill.on({ type: "dismissed" });
  await hold(600);
};

Electron.app.whenReady().then(async () => {
  const displays = Electron.screen.getAllDisplays();
  note("displays", {
    list: displays.map((d) => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor })),
    cursor: Electron.screen.getCursorScreenPoint(),
  });
  const pill = createVoicePill({
    cueGain: () => 0,
    rest: () => false,
    edge: () => "bottom",
    stateDir: NodeOS.tmpdir(),
    holdEscape: () => () => undefined,
    onDismiss: () => undefined,
    onShown: (ms) => note("pill.shown", { ms: Math.round(ms) }),
  });
  pill.warm();
  // LAB_POCKET is a prepared voice folder: the real voice, aloud. Otherwise silent stand-in speech.
  const pocketRoot = process.env["LAB_POCKET"];
  const engine =
    pocketRoot === undefined
      ? null
      : createPocketEngine({
          root: pocketRoot,
          platform: process.platform,
          arch: process.arch,
          onProgress: (message) => note("voice.progress", { message }),
        });
  const speaker =
    engine === null
      ? null
      : createSpeaker({
          os: {
            name: "os",
            speak: async () => {
              note("FELL.BACK.TO.OS");
            },
          },
          voice: () => labVoice(engine.synthesise("anna")),
          player: createVoicePlayer((level) => pill.speechLevel(level)),
          silent: () => writtenNow,
          onActive: (active) => {
            note(active ? "speak.start" : "speak.end");
            pill.on({ type: "speaking", active });
          },
        });
  let writtenNow = false;
  // Speech that takes as long as the real voice, with no sound: 13 characters a second.
  const companion = startScreenCompanion({
    holdEscape: () => () => undefined,
    onActivity: (label, caption) =>
      pill.on({ type: "activity", label, ...(caption === undefined ? {} : { caption }) }),
    stateDir,
    platform: process.platform,
    env: process.env,
    ...(speaker === null ? {} : { stopSpeech: speaker.cancel }),
    speak: async (text) => {
      if (speaker !== null) return speaker.speak(text);
      note("speak.start", { chars: text.length });
      pill.on({ type: "speaking", active: true });
      const pulse = setInterval(() => pill.speechLevel(0.35 + Math.random() * 0.6), 45);
      await sleep(text.length * 77);
      clearInterval(pulse);
      pill.on({ type: "speaking", active: false });
      note("speak.end");
    },
    onTurnEnd: () => note("turn.end"),
    onTimings: (timings) => note("timings", timings),
  });
  const watcher = watchOverlays();
  const spoken: Record<string, [string, number]> = {
    look: ["where is the export button on this screen", 24_000],
    other: ["what is on my other screen", 24_000],
    teach: ["teach me how to change the wallpaper", 40_000],
    long: ["give me the long answer about this screen", 40_000],
    real: ["What is on my main screen right now? Answer in two short sentences.", 35_000],
    realwritten: ["Describe what is on my main screen in about nine sentences.", 60_000],
  };
  for (const name of scenarios) {
    if (name === "written") {
      writtenNow = true;
      companion.applySetting("s.output", "written");
      continue;
    }
    if (name === "pill") {
      await pillTour(pill, note, sleep);
      continue;
    }
    const scenario = spoken[name];
    if (scenario === undefined) continue;
    note("scenario", { name });
    await companion.said(scenario[0], { direct: false });
    await sleep(scenario[1]);
    companion.stop();
    await sleep(800);
  }
  clearInterval(watcher);
  note("done");
  line.end(() => {
    NodeFS.writeFileSync(NodePath.join(out, "finished.flag"), "1");
    companion.dispose();
    Electron.app.quit();
  });
});
