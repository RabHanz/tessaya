// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * Real requests through the real assistant on his real displays: real capture, real `claude`,
 * the real overlay and accessibility lookup, with nothing scripted. A scripted model must never
 * run where he can watch it: it pointed at an Export button that did not exist. One JSON line per
 * turn; a drive plan is shown and never run, because the approval box is answered Cancel.
 */
/* oxlint-disable t3code/no-global-process-runtime -- standalone lab harness, no Effect runtime */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { startDictationSidecar } from "../../voice/dictationSidecar.ts";
import { ASK_HOTKEY, startScreenCompanion } from "../ScreenCompanion.ts";

const out = process.env["LAB_OUT"] ?? process.cwd();
const stateDir = NodePath.join(out, "state");
NodeFS.mkdirSync(stateDir, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(stateDir, "baton-screen.json"),
  JSON.stringify({ captureApproval: "always", output: "written" }),
);
const report = NodeFS.createWriteStream(NodePath.join(out, "timeline.jsonl"));
const write = (value: unknown) => report.write(`${JSON.stringify(value)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REQUESTS = (process.env["LAB_REQUESTS"] ?? "")
  .split("|")
  .map((text) => text.trim())
  .filter(Boolean);

const main = async () => {
  await Electron.app.whenReady();
  const sidecar = startDictationSidecar({
    binary: process.env["LAB_SIDECAR"]!,
    onEvent: () => {},
  });
  let ended: (() => void) | null = null;
  const companion = startScreenCompanion({
    stateDir,
    platform: process.platform,
    env: process.env,
    speak: async () => {},
    onTrace: (entry: unknown) => write(entry),
    onTurnEnd: () => ended?.(),
    holdEscape: (onPress: () => void) => {
      // The real key, as the app holds it, pressed below by SendKeys.
      Electron.globalShortcut.register("Escape", onPress);
      return () => Electron.globalShortcut.unregister("Escape");
    },
  } as never);
  write({ askChordHeld: Electron.globalShortcut.isRegistered(ASK_HOTKEY) });
  companion.setActions({
    focus: async () => {
      const asked = Date.now();
      const app = await sidecar.foreground();
      write({ foreground: app, ms: Date.now() - asked });
      if (app.exe.length === 0) return null;
      const rect = app.rect == null ? null : Electron.screen.screenToDipRect(null, app.rect);
      return {
        label: `${app.exe}: ${app.title}`,
        ...(app.window === undefined ? {} : { window: app.window }),
        centre: rect === null ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      };
    },
    windowAt: (point) =>
      sidecar.windowAt(Electron.screen.dipToScreenPoint(point)).catch(() => null),
    locate: async (label, near) => {
      const physical = Electron.screen.dipToScreenPoint(near);
      const found = await sidecar.locate({ label, x: physical.x, y: physical.y }).catch(() => null);
      write({ locate: label, near, found });
      if (found?.found !== true || found.x === undefined || found.y === undefined) return null;
      const real = Electron.screen.screenToDipPoint({ x: found.x, y: found.y });
      if (Math.hypot(real.x - near.x, real.y - near.y) > 160) return null;
      return { ...real, name: found.name ?? label };
    },
  });
  const NOTEPAD_FILE = process.env["LAB_NOTEPAD"];
  if (NOTEPAD_FILE !== undefined) {
    NodeFS.writeFileSync(NOTEPAD_FILE, "");
    NodeChildProcess.spawn("notepad.exe", [NOTEPAD_FILE], { detached: true });
    await sleep(2_500);
  }
  let stopWith: "(esc)" | null = null;
  const stopSoon = () => {
    const how = stopWith;
    stopWith = null;
    if (how === null) return;
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.SendKeys]::SendWait('{ESC}')";
    setTimeout(() => {
      write({ stop: how, at: Date.now() });
      NodeChildProcess.execFile("powershell.exe", ["-NoProfile", "-Command", script], {
        windowsHide: true,
      });
    }, 1_500);
  };
  // "Run it" is pressed the way he would, on the real prompt, and logged.
  const pressRun = setInterval(() => {
    // Without LAB_RUN_PLANS every prompt is declined, so a lab run can never type anything.
    const plans = process.env["LAB_RUN_PLANS"] === "1";
    for (const win of Electron.BrowserWindow.getAllWindows()) {
      void win.webContents
        .executeJavaScript(
          `(()=>{const b=[...document.querySelectorAll('button')].find(x=>${JSON.stringify(plans ? ["run it", "type it", "carry on"] : ["not now"])}.includes(x.textContent.toLowerCase()));if(b){b.click();return true}return false})()`,
        )
        .then((pressed) => {
          if (!pressed) return;
          write({ pressed: plans ? "yes" : "not now", at: Date.now() });
          stopSoon();
        })
        .catch(() => undefined);
    }
  }, 400);
  for (const said of REQUESTS) {
    const started = Date.now();
    write({ said });
    if (said.startsWith("teach:")) {
      // He does the step: a window appears, settles, and the lesson should notice unprompted.
      setTimeout(() => {
        const win = new Electron.BrowserWindow({
          width: 500,
          height: 400,
          x: 200,
          y: 200,
          alwaysOnTop: true,
        });
        void win.loadURL(
          "data:text/html,<body style='background:%23246;color:white'>a step was done",
        );
        write({ userActed: Date.now() });
        setTimeout(() => win.destroy(), 25_000);
      }, 14_000);
    }
    stopWith = said.includes("(esc)") ? "(esc)" : null;
    // His hand on the mouse for the whole turn: real input, and no process starting mid-drive.
    if (said.includes("(mouse)") && process.env["BATON_LAB"] === undefined) {
      throw new Error("(mouse) needs BATON_LAB, or the sidecar drops every nudge and it passes.");
    }
    let swing = 1;
    const hand = said.includes("(mouse)")
      ? setInterval(() => {
          swing = -swing;
          sidecar.nudge(40 * swing, 30 * swing);
        }, 300)
      : null;
    const done = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const result = await companion.said(said.replace(/\((mouse|esc)\)/, "").trim(), {
      direct: false,
    });
    if (result.kind === "handled") {
      await Promise.race([done, sleep(Number(process.env["LAB_TURN_MS"] ?? 45_000))]);
      await sleep(said.startsWith("teach:") ? 45_000 : said.startsWith("drive:") ? 25_000 : 1_500);
    }
    if (hand !== null) clearInterval(hand);
    write({ said, result: result.kind, ms: Date.now() - started });
  }
  clearInterval(pressRun);
  sidecar.dispose();
  companion.dispose();
  report.end(() => Electron.app.exit(0));
};

void main().catch((error: unknown) => {
  write({ error: String(error) });
  report.end(() => Electron.app.exit(1));
});
