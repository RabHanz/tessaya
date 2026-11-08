// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
// The real hands on a Windows desktop, without Electron: the same tool table the assistant uses
// (batonTools.ts), the same input driver (inputDriver.ts) and the same UI Automation sidecar
// (native/baton-dictation) behind it. Used by the hands-loop CI run (scripts/tessaya/hands-ci/run.ts).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import {
  buildBatonTools,
  treeText,
  type ToolHost,
} from "../../../apps/desktop/src/baton/agent/batonTools.ts";
import { withFailureGuard } from "../../../apps/desktop/src/baton/agent/failureGuard.ts";
import { createInputDriver } from "../../../apps/desktop/src/baton/screen/inputDriver.ts";
import { startSidecar } from "./sidecarClient.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ps = (script: string, timeoutMs = 60_000): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout.trim()),
    );
  });

// One long-lived PowerShell for the clipboard: a new process per read or write took about a second, long
// enough for the paste's own restore to race with a copy made right after typing, which a real (synchronous)
// clipboard does not do.
const CLIP_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$u = [System.Text.Encoding]::UTF8
function Enc($t) { if ($t -eq $null) { '' } else { [Convert]::ToBase64String($u.GetBytes($t)) } }
function Dec($b) { $u.GetString([Convert]::FromBase64String($b)) }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'get' { [Console]::Out.WriteLine('ok ' + (Enc (Get-Clipboard -Raw))) }
      'set' { Set-Clipboard -Value (Dec $p[1]); [Console]::Out.WriteLine('ok') }
      'clear' { [System.Windows.Forms.Clipboard]::Clear(); [Console]::Out.WriteLine('ok') }
      'replace' {
        if ((Get-Clipboard -Raw) -ceq (Dec $p[1])) { if ($p[2] -eq '') { [System.Windows.Forms.Clipboard]::Clear() } else { Set-Clipboard -Value (Dec $p[2]) } }
        [Console]::Out.WriteLine('ok')
      }
    }
  } catch { [Console]::Out.WriteLine('err ' + $_.Exception.Message) }
}
`;
const clipProc = NodeChildProcess.spawn(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-STA", "-Command", CLIP_SCRIPT],
  {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  },
);
const clipWaiting: Array<(line: string) => void> = [];
NodeReadline.createInterface({ input: clipProc.stdout }).on("line", (line) =>
  clipWaiting.shift()?.(line),
);
let clipChain: Promise<unknown> = Promise.resolve();
const clip = (command: string): Promise<string> => {
  const turn = clipChain.then(
    () =>
      new Promise<string>((resolve, reject) => {
        clipWaiting.push((line) =>
          line.startsWith("ok") ? resolve(line.slice(3)) : reject(new Error(line)),
        );
        clipProc.stdin.write(`${command}\n`);
      }),
  );
  clipChain = turn.catch(() => undefined);
  return turn;
};
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const clipboard = {
  readText: async () => Buffer.from(await clip("get").catch(() => ""), "base64").toString("utf8"),
  writeText: async (text: string) => {
    await (text === "" ? clip("clear") : clip(`set ${b64(text)}`));
  },
  replaceIf: async (expected: string, next: string) => {
    await clip(`replace ${b64(expected)} ${b64(next)}`).catch(() => undefined);
  },
};

const sidecarExe = process.env["SIDECAR"] ?? "tessaya-voice.exe";
// One long-lived sidecar, as the app runs it: tree line numbers live in it from one ui_tree to the next click.
let served: ReturnType<typeof startSidecar> | null = null;
const side = (message: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (served ??= startSidecar(sidecarExe)).call<Record<string, unknown>>(message);

const driver = createInputDriver({ platform: "win32", toPhysical: (p) => p, clipboard });

const SHOT_SCRIPT = (file: string) => `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)
"$($b.Width)x$($b.Height)"
`;

/** How many pixels (sampled) differ between two screenshots; the screenshot-based check. */
export const changedPixels = (a: string, b: string): Promise<number> =>
  ps(
    `Add-Type -ReferencedAssemblies System.Drawing @"
using System.Drawing;
public static class Diff { public static int Count(string a, string b) {
  using (var x = new Bitmap(a)) using (var y = new Bitmap(b)) {
    int n = 0; int w = System.Math.Min(x.Width, y.Width), h = System.Math.Min(x.Height, y.Height);
    for (int i = 0; i < w; i += 3) for (int j = 0; j < h; j += 3) if (x.GetPixel(i, j).ToArgb() != y.GetPixel(i, j).ToArgb()) n++;
    return n; } } }
"@
[Diff]::Count('${a}','${b}')`,
  ).then((s) => Number(s));

/** For tests that read or set the clipboard themselves, through the same helper. */
export const clipboardText = () => clipboard.readText();
export const setClipboardText = (text: string) => clipboard.writeText(text);

/** What the bake-off counts besides time: the size of what the tree calls returned. */
export const stats = { treeBytes: 0, clicks: 0, misclicks: 0 };
const GUARD = process.env["HANDS_GUARD"] === "1";

export interface Host {
  readonly call: (name: string, args: Record<string, unknown>) => Promise<string>;
  readonly shot: (name: string) => Promise<string>;
  readonly outDir: string;
  readonly dispose: () => void;
}

export const makeHost = (outDir: string): Host => {
  NodeFS.mkdirSync(outDir, { recursive: true });
  let shots = 0;
  const here = { x: 512, y: 384 };
  let lastTree = 0;
  const located = async (target: string | number) => {
    const found = await side({
      cmd: "locate",
      label: typeof target === "number" ? "" : target,
      ...here,
      foreground: true,
      ...(typeof target === "number" ? { ref: target, tree: lastTree } : {}),
    });
    if (found["stale"] === true)
      throw new Error(
        `The window changed since ui_tree, so line ${target} may be another control now. Read ui_tree again.`,
      );
    return found["found"] === true
      ? {
          x: Number(found["x"]),
          y: Number(found["y"]),
          name: String(found["name"] ?? target),
          coveredBy: typeof found["covered_by"] === "string" ? found["covered_by"] : null,
        }
      : null;
  };
  const shot = async (name: string) => {
    const file = NodePath.join(outDir, `${String(++shots).padStart(2, "0")}-${name}.png`);
    await ps(SHOT_SCRIPT(file.replaceAll("'", "''")));
    return file;
  };
  const host: ToolHost = {
    windowKey: async () => String((await side({ cmd: "foreground" }))["window"]),
    capture: async () => {
      const file = await shot("capture");
      return {
        text: `screen 1, image (see ${NodePath.basename(file)})`,
        images: [{ data: NodeFS.readFileSync(file).toString("base64"), mimeType: "image/png" }],
      };
    },
    uiTree: async (_window, find) => {
      const tree = await side({
        cmd: "ui_tree",
        number: true,
        ...(find === undefined ? {} : { find }),
      });
      if (typeof tree["error"] === "string")
        throw new Error(`The window's controls can't be read: ${tree["error"]}`);
      lastTree = typeof tree["tree"] === "number" ? tree["tree"] : 0;
      const text = treeText(tree as Parameters<typeof treeText>[0]);
      stats.treeBytes += text.length;
      return text;
    },
    focusState: async () => {
      const state = await side({ cmd: "focus_state" });
      return typeof state["error"] === "string"
        ? null
        : {
            window: String(state["window"] ?? ""),
            focus: typeof state["focus"] === "string" ? state["focus"] : null,
          };
    },
    clickElement: async (label, double) => {
      const found = await located(label);
      if (found === null)
        throw new Error(
          `No control is named "${label}" in the window with the keyboard. Take a screenshot and click by position.`,
        );
      if (GUARD && found.coveredBy !== null)
        throw new Error(
          `"${found.name}" is covered by "${found.coveredBy}", so a click would land there. Take a screenshot, deal with what covers it, then click.`,
        );
      stats.clicks += 1;
      // A click that goes ahead onto something else is a misclick, whatever the variant.
      if (found.coveredBy !== null) stats.misclicks += 1;
      await driver.clickAt(found, "left", double ? 2 : 1);
      return `Clicked ${found.name}.`;
    },
    waitFor: async (label, seconds) => {
      const until = Date.now() + seconds * 1000;
      do {
        const found = await located(label);
        if (found !== null) return `${found.name} is there.`;
        await sleep(400);
      } while (Date.now() < until);
      return `No control named "${label}" appeared in ${seconds} seconds.`;
    },
    click: async (a) => (
      await driver.clickAt({ x: a.x, y: a.y }, a.button ?? "left", a.double === true ? 2 : 1),
      "Clicked."
    ),
    scroll: async (n) => (await driver.scrollAt(null, n), "Scrolled."),
    drag: async (a) => {
      await driver.pressAt({ x: a.x, y: a.y });
      await sleep(150);
      await driver.releaseAt({ x: a.toX, y: a.toY });
      return "Dragged.";
    },
    type: async (text) => (await driver.type(text), "Typed."),
    press: async (keys) => (await driver.press(keys), "Pressed."),
    sessions: async () => "none",
    session: async () => "none",
    send: async () => "none",
    fleet: async () => "none",
    dictation: async () => "none",
    assistantModel: async () => "none",
    memory: async () => "none",
    conversationSearch: async () => "none",
    remember: async () => "none",
    forget: async () => "none",
    jobs: async () => "none",
    target: async () => "noted",
  };
  const tools = new Map(withFailureGuard(buildBatonTools(host)).map((t) => [t.name, t]));
  return {
    outDir,
    shot,
    call: async (name, args) => {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`No tool named ${name}.`);
      const out = await tool.run(args);
      return out.text ?? "";
    },
    dispose: () => (driver.dispose(), clipProc.kill(), served?.kill()),
  };
};
