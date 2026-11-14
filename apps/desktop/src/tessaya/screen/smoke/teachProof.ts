// @effect-diagnostics globalDate:off globalRandom:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * The CI proof of teach (design: the maintainers' research notes): the real companion and the
 * real overlay on a Windows desktop, a scripted `claude` (scripts/tessaya/teach-proof/fake-claude.mjs), and Notepad's
 * font size as the task. The harness is the "user": it clicks and types through the real input driver when the card
 * says it is waiting, and presses Go ahead on the real approval card. The desktop is recorded with ffmpeg.
 */
/* oxlint-disable t3code/no-global-process-runtime -- standalone proof harness, no Effect runtime */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { createVoicePill } from "../../voice/voicePill.ts";
import { createInputDriver } from "../inputDriver.ts";
import { startDictationSidecar } from "../../voice/dictationSidecar.ts";
import { startScreenCompanion } from "../ScreenCompanion.ts";

let pointedAt = 0;
const out = process.env["PROOF_OUT"] ?? NodePath.join(process.cwd(), "teach-proof-out");
const fake = process.env["PROOF_FAKE"] ?? "";
const stateDir = NodePath.join(out, "state");
NodeFS.mkdirSync(stateDir, { recursive: true });
// The overlay windows are visible to capture only when this is set (captureProtection.ts).
process.env["BATON_TEST_DIR"] = out;

const shim = NodePath.join(out, "claude.cmd");
NodeFS.writeFileSync(shim, `@echo off\r\nnode "${fake}" %*\r\n`);
NodeFS.writeFileSync(
  NodePath.join(stateDir, "baton-screen.json"),
  JSON.stringify({ captureApproval: "always", claudeBinary: shim, speak: true }),
);

const timeline = NodeFS.createWriteStream(NodePath.join(out, "timeline.jsonl"));
const t0 = Date.now();
const note = (event: string, data: object = {}) =>
  timeline.write(`${JSON.stringify({ t: Date.now() - t0, event, ...data })}\n`);
// One clip per scenario, as the hands loop does (scripts/tessaya/hands-ci/record.ts): 10 fps, 720p, a six-frame sheet.
const startClip = (id: string) => {
  const file = NodePath.join(out, `${id}.mp4`);
  const child = NodeChildProcess.spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "gdigrab",
      "-framerate",
      "10",
      "-i",
      "desktop",
      "-vf",
      "scale=-2:720",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      file,
    ],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
  );
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  return async (seconds: number) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => (child.kill(), resolve()), 15_000);
      child.on("exit", () => (clearTimeout(timer), resolve()));
      child.on("error", () => resolve());
      child.stdin.write("q");
    });
    await new Promise<void>((resolve) =>
      NodeChildProcess.execFile(
        "ffmpeg",
        [
          "-y",
          "-i",
          file,
          "-vf",
          `fps=${(6 / Math.max(seconds, 1)).toFixed(4)},scale=426:-2,tile=3x2`,
          "-frames:v",
          "1",
          NodePath.join(out, `${id}-sheet.png`),
        ],
        { windowsHide: true, timeout: 60_000 },
        () => resolve(),
      ),
    );
  };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ps = (script: string) =>
  new Promise<string>((resolve) => {
    // A file, not -Command: the here-string in it must reach PowerShell exactly as written.
    const file = NodePath.join(out, `step-${Date.now()}.ps1`);
    NodeFS.writeFileSync(file, script);
    NodeChildProcess.execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      { windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error !== null)
          note("ps.failed", { message: error.message, stderr: String(stderr).slice(0, 400) });
        resolve(String(stdout).trim());
      },
    );
  });
const locate = (name: string) =>
  new Promise<{ x: number; y: number } | null>((resolve) =>
    NodeChildProcess.execFile(
      "node",
      [fake, "--locate", name],
      { windowsHide: true, timeout: 30_000 },
      (_e, stdout) => {
        try {
          resolve(JSON.parse(String(stdout).trim()));
        } catch {
          resolve(null);
        }
      },
    ),
  );

/** A window that is hidden may never answer a script; a missing answer is null. */
const evalIn = (win: Electron.BrowserWindow, script: string): Promise<unknown> =>
  Promise.race([
    win.webContents.executeJavaScript(script).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
  ]);

/** What the overlay and the pill are showing now. */
const cardKicker = async (): Promise<string> => {
  for (const win of Electron.BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const kicker = await evalIn(
      win,
      "(()=>{const c=document.getElementById('card'),k=document.getElementById('k');return c&&c.classList.contains('on')&&k?k.textContent:''})()",
    );
    if (typeof kicker === "string" && kicker !== "") return kicker;
  }
  return "";
};
const until = async (test: (kicker: string) => boolean, ms: number): Promise<string> => {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    last = await cardKicker();
    if (test(last)) return last;
    await sleep(250);
  }
  return last;
};

const NOTEPAD = `$ErrorActionPreference='Stop';$p=Start-Process "$env:windir\\notepad.exe" -PassThru;Start-Sleep 2;
Add-Type @'
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);}
'@
$p.Refresh();[W]::MoveWindow($p.MainWindowHandle,120,90,820,560,$true)|Out-Null;[W]::SetForegroundWindow($p.MainWindowHandle)|Out-Null;$p.Id`;

// Whatever happens, the run ends and its files are kept.
setTimeout(() => Electron.app.exit(3), (process.env["PROOF_APP"] ? 28 : 8) * 60_000).unref();

void Electron.app.whenReady().then(async () => {
  const driver = createInputDriver({
    platform: "win32",
    toPhysical: (p) => Electron.screen.dipToScreenPoint(p),
    clipboard: Electron.clipboard,
  });
  const clickOn = async (name: string) => {
    const at = await locate(name);
    if (at !== null) await driver.clickAt(Electron.screen.screenToDipPoint(at), "left", 1);
    else {
      // The open Format menu takes its accelerator letter.
      note("locate.failed", { name });
      if (name === "Font...") await driver.press(["f"]);
    }
  };
  const pill = createVoicePill({
    cueGain: () => 1,
    onCuePlayed: (name, result) => note("cue.played", { name, result }),
    rest: () => false,
    edge: () => "bottom",
    stateDir,
    holdEscape: () => () => undefined,
    onDismiss: () => undefined,
  });
  pill.warm();
  const companion = startScreenCompanion({
    holdEscape: () => () => undefined,
    onActivity: (label, caption) =>
      pill.on({ type: "activity", label, ...(caption === undefined ? {} : { caption }) }),
    stateDir,
    platform: process.platform,
    env: process.env,
    // Speech that takes as long as the real voice, with no sound: 13 characters a second.
    speak: async (text) => {
      note("speak", { text });
      pill.on({ type: "speaking", active: true });
      await sleep(text.length * 77);
      pill.on({ type: "speaking", active: false });
    },
    onNote: (kind, fields) => note(`note.${kind}`, fields),
    onTrace: (fields) => {
      note("trace", fields);
      if ("pointedAt" in fields) pointedAt += 1;
    },
    onCue: (cue) => {
      note("cue", { cue });
      pill.cue(cue);
    },
  });

  // The real UI Automation sidecar (built in the workflow) gives the ring its control.
  const sidecarBinary = process.env["SIDECAR"] ?? "";
  const sidecar =
    sidecarBinary === ""
      ? null
      : startDictationSidecar({ binary: sidecarBinary, onEvent: () => undefined });
  const within = <T>(work: Promise<T>, ms = 8000): Promise<T | null> =>
    Promise.race([work.catch(() => null), sleep(ms).then(() => null)]);
  if (sidecar !== null) {
    companion.setActions({
      focus: async () => {
        const app = await within(sidecar.foreground());
        if (app === null || app.exe.length === 0) return null;
        const rect = app.rect == null ? null : Electron.screen.screenToDipRect(null, app.rect);
        return {
          label: `${app.exe}: ${app.title}`,
          ...(app.window === undefined ? {} : { window: app.window }),
          centre:
            rect === null ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        };
      },
      windowAt: (point) => within(sidecar.windowAt(Electron.screen.dipToScreenPoint(point))),
      uiTree: async () => {
        const tree = await within(sidecar.uiTree());
        return tree === null || tree.controls === undefined
          ? null
          : { window: tree.window ?? "", controls: tree.controls };
      },
      locate: async (label, near) => {
        const physical = Electron.screen.dipToScreenPoint(near);
        const found = await within(
          sidecar.locate({ label, x: physical.x, y: physical.y, foreground: true }),
        );
        note("locate", { label, found: found?.found === true, name: found?.name ?? null });
        if (found?.found !== true || found.x === undefined || found.y === undefined) return null;
        const real = Electron.screen.screenToDipPoint({ x: found.x, y: found.y });
        const scale = Electron.screen.getDisplayNearestPoint(real).scaleFactor || 1;
        return {
          ...real,
          name: found.name ?? label,
          ...(found.width === undefined || found.height === undefined
            ? {}
            : { width: found.width / scale, height: found.height / scale }),
        };
      },
    });
  }

  // The quality set: every scenario of one app (PROOF_APP) from scenarios.json, each recorded and checked outside the UI.
  if ((process.env["PROOF_APP"] ?? "") !== "") {
    interface Scenario {
      readonly id: string;
      readonly app: string;
      readonly mode: "teach";
      readonly goal: string;
      readonly launch: string;
      readonly steps?: ReadonlyArray<{
        readonly act: ReadonlyArray<ReadonlyArray<string | number>>;
      }>;
      readonly check: {
        readonly type: string;
        readonly script?: string;
        readonly contains?: string;
      };
      readonly close?: string;
    }
    const all = JSON.parse(
      NodeFS.readFileSync(NodePath.join(NodePath.dirname(fake), "scenarios.json"), "utf8"),
    ) as Scenario[];
    const mine = all.filter((x) => x.app === process.env["PROOF_APP"]);
    const PRELUDE = `Add-Type @'
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern void keybd_event(byte b,byte s,uint f,UIntPtr e);}
'@
# Windows only lets the foreground process hand the focus on; a tapped Alt key lets this script do it.
function Focus($title){[W]::keybd_event(0x12,0,0,[UIntPtr]::Zero);[W]::keybd_event(0x12,0,2,[UIntPtr]::Zero);(New-Object -ComObject WScript.Shell).AppActivate($title)|Out-Null;Start-Sleep -Milliseconds 700}
function Place($name){$p=Get-Process $name -EA 0|Where-Object{$_.MainWindowHandle -ne 0}|Select-Object -First 1;if($p){[W]::MoveWindow($p.MainWindowHandle,100,60,820,560,$true)|Out-Null;[W]::SetForegroundWindow($p.MainWindowHandle)|Out-Null;(New-Object -ComObject WScript.Shell).AppActivate($p.Id)|Out-Null}}
`;
    // Files, not pipes: an app started by the script (Explorer, Edge) would hold a pipe open and the call would never end.
    const run = (script: string) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const base = NodePath.join(
          out,
          `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        );
        NodeFS.writeFileSync(`${base}.ps1`, PRELUDE + script);
        const log = NodeFS.openSync(`${base}.log`, "w");
        const child = NodeChildProcess.spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${base}.ps1`],
          { windowsHide: true, stdio: ["ignore", log, log] },
        );
        const timer = setTimeout(() => child.kill(), 60_000);
        const done = (code: number) => {
          clearTimeout(timer);
          NodeFS.closeSync(log);
          resolve({ code, out: NodeFS.readFileSync(`${base}.log`, "utf8").trim().slice(0, 300) });
        };
        child.on("exit", (code) => done(code ?? 1));
        child.on("error", () => done(1));
      });
    const side = (...args: string[]) =>
      new Promise<string>((resolve) =>
        NodeChildProcess.execFile(
          sidecarBinary,
          args,
          { windowsHide: true, timeout: 20_000, maxBuffer: 8e6 },
          (_e, stdout) => resolve(String(stdout)),
        ),
      );
    const expand = (text: string) =>
      text
        .replaceAll("{TEMPURL}", (process.env["TEMP"] ?? "").replaceAll("\\", "/"))
        .replaceAll("{TEMP}", process.env["TEMP"] ?? "");
    const shot = async (name: string) => {
      const file = NodePath.join(out, `${name}.png`);
      await run(
        `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;$m=New-Object System.Drawing.Bitmap $b.Width,$b.Height;$g=[System.Drawing.Graphics]::FromImage($m);$g.CopyFromScreen($b.Left,$b.Top,0,0,$m.Size);$m.Save('${file}')`,
      );
      return file;
    };
    const judge = async (
      c: Scenario["check"],
      before: string,
    ): Promise<{ pass: boolean; detail: string }> => {
      if (c.type === "ps") {
        const r = await run(c.script ?? "exit 1");
        return { pass: r.code === 0, detail: r.out };
      }
      if (c.type === "tree") {
        const tree = await side("ui_tree");
        const hit = new RegExp(c.contains ?? "$^").test(tree);
        return {
          pass: hit,
          detail: hit ? "found in the window's controls" : `not in: ${tree.slice(0, 160)}`,
        };
      }
      if (c.type === "windows") {
        // Every window title there is, not only the one with the focus, which a runner's own agent may hold.
        const r = await run(
          `$t=@(Get-Process|Where-Object{$_.MainWindowTitle}|ForEach-Object{$_.MainWindowTitle});$t+=@((New-Object -ComObject Shell.Application).Windows()|ForEach-Object{$_.LocationName});$j=$t -join '|';Write-Output $j;if($j -match '${(c.contains ?? "$^").replaceAll("'", "''")}'){exit 0}else{exit 1}`,
        );
        return { pass: r.code === 0, detail: r.out.slice(0, 160) };
      }
      const after = await shot("after");
      const r = await run(
        `Add-Type -ReferencedAssemblies System.Drawing @"
using System.Drawing;
public static class Diff { public static int Count(string a, string b) { using (var x = new Bitmap(a)) using (var y = new Bitmap(b)) { int n = 0; int w = System.Math.Min(x.Width, y.Width), h = System.Math.Min(x.Height, y.Height); for (int i = 0; i < w; i += 3) for (int j = 0; j < h; j += 3) if (x.GetPixel(i, j).ToArgb() != y.GetPixel(i, j).ToArgb()) n++; return n; } } }
"@
$n=[Diff]::Count('${before}','${after}');Write-Output "changed=$n";if($n -gt 100){exit 0}else{exit 1}`,
      );
      return { pass: r.code === 0, detail: r.out };
    };
    const perform = async (acts: ReadonlyArray<ReadonlyArray<string | number>>) => {
      for (const [kind, a, b, c, d] of acts) {
        if (kind === "click") await clickOn(String(a));
        else if (kind === "key") await driver.press([String(a)]);
        else if (kind === "chord") await driver.press(String(a).split("+"));
        else if (kind === "type") await driver.type(expand(String(a)));
        else if (kind === "drag") {
          await driver.pressAt(Electron.screen.screenToDipPoint({ x: Number(a), y: Number(b) }));
          await sleep(300);
          await driver.releaseAt(Electron.screen.screenToDipPoint({ x: Number(c), y: Number(d) }));
        }
        await sleep(700);
      }
    };
    const display = Electron.screen.getPrimaryDisplay();
    process.env["PROOF_SCREEN_W"] = String(Math.round(display.size.width * display.scaleFactor));
    const rows: Array<Record<string, unknown>> = [];
    // A line every 20 s with what the harness is doing, so a stall shows where it is.
    let phase = "start";
    setInterval(() => note("heartbeat", { phase }), 20_000).unref();
    const writeResults = () => {
      NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(rows, null, 2));
      NodeFS.writeFileSync(
        NodePath.join(out, "results.md"),
        [
          `### ${process.env["PROOF_APP"]}`,
          "| scenario | result | seconds | cause |",
          "| --- | --- | --- | --- |",
          ...rows.map(
            (r) =>
              `| ${String(r["id"])} | ${r["pass"] === true ? "pass" : "fail"} | ${String(r["seconds"])} | ${String(
                r["cause"] || r["check"],
              )
                .replaceAll("|", "/")
                .replaceAll("\n", " ")
                .slice(0, 160)} |`,
          ),
        ].join("\n"),
      );
    };
    for (const sc of mine) {
      const began = Date.now();
      note("scenario", { id: sc.id });
      process.env["PROOF_SCENARIO"] = sc.id;
      let cause = "";
      let ended = "";
      let verdict: { pass: boolean; detail: string } = { pass: false, detail: "" };
      let stopClip: (seconds: number) => Promise<void> = async () => undefined;
      // One scenario never takes the whole run with it: a call that hangs is a failure with a cause.
      const body = async () => {
        phase = `${sc.id}: launch`;
        await run(sc.launch);
        await sleep(1500);
        phase = `${sc.id}: before shot`;
        const before = await shot("before");
        phase = `${sc.id}: clip`;
        stopClip = startClip(sc.id);
        await sleep(2000);
        void companion.said(`${sc.mode}: ${sc.goal}`, { direct: false });
        if (sc.mode === "teach") {
          const steps = sc.steps ?? [];
          for (let i = 1; i <= steps.length && cause === ""; i += 1) {
            const k = await until((x) => x.startsWith(`Step ${i}`), 60_000);
            if (!k.startsWith(`Step ${i}`)) {
              cause = `no card for step ${i} (saw "${k}")`;
              break;
            }
            await sleep(2500);
            await perform(steps[i - 1]!.act);
            const moved = await until((x) => !x.startsWith(`Step ${i} `), 20_000);
            if (moved.startsWith(`Step ${i} `) || moved === "") {
              note("noticed.not", { id: sc.id, step: i });
              void companion.said("next", { direct: false });
            }
          }
          ended = await until((x) => /Finished|Stopped/.test(x), 60_000);
        }
        await sleep(3000);
        // Notepad writes its settings when it closes, so a registry check comes after the close.
        if (sc.check.type === "ps" && sc.close !== undefined) {
          await run(sc.close);
          await sleep(1500);
        }
        phase = `${sc.id}: judge`;
        verdict = await judge(sc.check, before);
      };
      const timedOut = await Promise.race([
        body().then(() => false),
        sleep(300_000).then(() => true),
      ]);
      if (timedOut) cause = `hung for 5 minutes (last card "${ended}")`;
      if (cause === "" && !/Finished/.test(ended)) cause = `ended with "${ended}"`;
      if (cause === "" && !verdict.pass) cause = `check failed: ${verdict.detail}`;
      const seconds = Math.round((Date.now() - began) / 1000);
      rows.push({
        id: sc.id,
        mode: sc.mode,
        app: sc.app,
        pass: cause === "" && verdict.pass,
        cause,
        ended,
        check: verdict.detail,
        seconds,
      });
      note("scenario.result", rows.at(-1) as object);
      writeResults();
      phase = `${sc.id}: stop`;
      companion.stop();
      await sleep(1500);
      await Promise.race([stopClip(seconds), sleep(60_000)]);
      if (sc.close !== undefined) await run(sc.close);
    }
    NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(rows, null, 2));
    NodeFS.writeFileSync(
      NodePath.join(out, "results.md"),
      [
        `### ${process.env["PROOF_APP"]}`,
        "| scenario | result | seconds | cause |",
        "| --- | --- | --- | --- |",
        ...rows.map(
          (r) =>
            `| ${String(r["id"])} | ${r["pass"] === true ? "pass" : "fail"} | ${String(r["seconds"])} | ${String(
              r["cause"] || r["check"],
            )
              .replaceAll("|", "/")
              .replaceAll("\n", " ")
              .slice(0, 160)} |`,
        ),
      ].join("\n"),
    );
    timeline.end(() => {
      companion.dispose();
      sidecar?.dispose();
      driver.dispose();
      Electron.app.exit(0);
    });
    return;
  }

  const results: Record<string, unknown> = {};
  // Each of the five cues once, through the pill, and what its page said; a runner may have no sound device.
  for (const cue of ["start", "stepDone", "waiting", "error", "finished"] as const) {
    pill.cue(cue);
    await sleep(700);
  }
  const pid = await ps(NOTEPAD);
  note("notepad", { pid });
  await sleep(1500);
  // Something to look at: a line in the text area, which has the focus.
  await driver.type("Meeting notes: send the quarterly plan to the team on Friday.");
  await sleep(1000);

  // 1. Teach: he does each step when the card says it is waiting for him.
  {
    const stopClip = startClip("teach");
    const began = Date.now();
    await sleep(2500);
    note("scenario", { name: "teach" });
    void companion.said("teach: show me how to change the Notepad font size", { direct: false });
    const steps: string[] = [];
    for (let step = 1; step <= 3; step += 1) {
      const kicker = await until((k) => k.startsWith(`Step ${step}`) && /waiting/.test(k), 60_000);
      steps.push(kicker);
      await sleep(3500);
      if (step === 1) await clickOn("Format");
      else if (step === 2) await clickOn("Font...");
      else {
        await driver.press(["alt", "s"]);
        await driver.type("16");
        await driver.press(["enter"]);
      }
      // The companion should notice by itself; "next" is the fallback and is logged as one.
      const moved = await until((k) => !k.startsWith(`Step ${step} `), 20_000);
      if (moved.startsWith(`Step ${step} `) || moved === "") {
        note("noticed.not", { step });
        void companion.said("next", { direct: false });
      }
    }
    const end = await until((k) => /Finished|Stopped/.test(k), 60_000);
    note("teach.end", { kicker: end });
    await sleep(6000);
    results["teach"] = { steps, end, pointedAt };
    companion.stop();
    await sleep(1500);
    await stopClip((Date.now() - began) / 1000);
  }

  NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(results, null, 2));
  console.log("results", JSON.stringify(results));
  timeline.end(() => {
    companion.dispose();
    sidecar?.dispose();
    driver.dispose();
    Electron.app.exit(0);
  });
});
