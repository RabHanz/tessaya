// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * A real run of the screen companion (D84) against a real window: look and teach, with
 * his `claude` answering. Approval boxes are answered "yes" and logged, the "user" in teach mode
 * is xdotool, and full-screen frames are saved. How to run it: docs/baton/SCREEN.md.
 */
/* oxlint-disable t3code/no-global-process-runtime -- standalone smoke harness, no Effect runtime */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as Electron from "electron";

import { captureScreens } from "../screenCapture.ts";
import { startScreenCompanion } from "../ScreenCompanion.ts";

const out = process.env["BATON_SMOKE_OUT"] ?? NodePath.join(process.cwd(), "screen-smoke");
const stateDir = NodePath.join(out, "state");
const only = process.env["BATON_SMOKE_ONLY"]?.split(",") ?? ["look", "teach"];
const log = (...parts: unknown[]) =>
  console.log(`[smoke ${new Date().toISOString().slice(11, 19)}]`, ...parts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Signup</title><style>
body{font:18px system-ui,sans-serif;background:#f7f7f8;color:#18181b;margin:0;padding:48px}
h1{font-size:28px;margin:0 0 24px}label{display:block;margin:18px 0 6px;font-weight:600}
input{font:18px system-ui;padding:10px 12px;width:360px;border:1px solid #a1a1aa;border-radius:8px}
button{margin-top:28px;font:600 18px system-ui;padding:12px 26px;border:0;border-radius:8px;background:#16a34a;color:#fff}
#done{margin-top:28px;font-size:22px;color:#16a34a;font-weight:700}
</style></head><body><h1>Join the waiting list</h1>
<label for="n">Your name</label><input id="n" autocomplete="off">
<label for="e">Email</label><input id="e" autocomplete="off">
<div><button id="b" onclick="document.getElementById('done').textContent='Submitted: '+document.getElementById('n').value">Submit</button></div>
<div id="done"></div></body></html>`;

const xdotool = (...args: string[]) =>
  new Promise<void>((resolve, reject) =>
    NodeChildProcess.execFile("xdotool", args, (e) => (e ? reject(e) : resolve())),
  );

const frame = async (name: string) => {
  // The overlay is deliberately in this one: the frame shows what he would see.
  const [screen] = await captureScreens();
  const path = NodePath.join(out, `${name}.jpg`);
  NodeFS.writeFileSync(path, screen!.jpeg);
  log("frame", path);
};

const main = async () => {
  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "baton-screen.json"),
    JSON.stringify({
      captureApproval: "ask",
      speak: false,
      model: process.env["BATON_SMOKE_MODEL"] ?? "sonnet",
    }),
  );
  // Every approval box is answered yes, and what it said is logged.
  const dialogs: string[] = [];
  (Electron.dialog as { showMessageBox: unknown }).showMessageBox = async (
    options: Electron.MessageBoxOptions,
  ) => {
    dialogs.push(`${options.message}\n${options.detail ?? ""}\n[${options.buttons?.join(" | ")}]`);
    log("approval box:", options.message, "→", options.buttons?.[0]);
    return { response: 0, checkboxChecked: false };
  };

  const app = new Electron.BrowserWindow({
    x: 120,
    y: 80,
    width: 760,
    height: 620,
    title: "Signup",
  });
  await app.loadURL(`data:text/html,${encodeURIComponent(FORM)}`);
  app.focus();
  const doneText = () =>
    app.webContents.executeJavaScript("document.getElementById('done').textContent");
  const nameValue = () => app.webContents.executeJavaScript("document.getElementById('n').value");
  const reset = () =>
    app.webContents.executeJavaScript(
      "document.getElementById('n').value='';document.getElementById('done').textContent=''",
    );

  const clickOn = async (id: string) => {
    const [x, y] = (await app.webContents.executeJavaScript(
      `(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`,
    )) as [number, number];
    const content = app.getContentBounds();
    await xdotool(
      "mousemove",
      String(Math.round(content.x + x)),
      String(Math.round(content.y + y)),
    );
    await xdotool("click", "1");
  };

  const companion = startScreenCompanion({
    holdEscape: () => () => undefined,
    stateDir,
    platform: process.platform,
    env: process.env,
    speak: async () => undefined,
  });
  const results: Record<string, string> = {};

  if (only.includes("fingerprint")) {
    const { screenFingerprint } = await import("../screenCapture.ts");
    const { screensDifference } = await import("@t3tools/tessaya-shared/screenCompanion");
    const a = await screenFingerprint();
    const a2 = await screenFingerprint();
    await clickOn("n");
    await xdotool("type", "--delay", "40", "Robin");
    await sleep(500);
    const b = await screenFingerprint();
    results["fingerprint"] =
      `displays ${a.length}; same screen ${screensDifference(a, a2)}; after typing ${screensDifference(a, b)}`;
    await reset();
  }

  if (only.includes("look")) {
    const t0 = Date.now();
    void companion.said(`look: ${"where do I type my name on this form?"}`, { direct: false });
    await sleep(14_000);
    await frame("01-look-points-at-name-field");
    results["look"] =
      `answered and pointed within ~${Math.round((Date.now() - t0) / 1000)} s (frame 01)`;
  }

  if (only.includes("teach")) {
    await reset();
    void companion.said("teach: how to sign up on this form with the name Robin", {
      direct: false,
    });
    await sleep(15_000);
    await frame("02-teach-step-1");
    // The "user" does step 1: click the name field and type.
    await clickOn("n");
    await xdotool("type", "--delay", "40", "Robin");
    log("user typed the name; waiting for the companion to notice");
    await sleep(18_000);
    await frame("03-teach-step-2-after-noticing");
    // Whatever step 2 asked (email is optional; submit is the goal), the user submits.
    await clickOn("b");
    log("user clicked submit");
    await sleep(18_000);
    await frame("04-teach-after-submit");
    results["teach"] =
      `name typed: ${await nameValue()}; page says: ${await doneText()}; companion still teaching: ${companion.active()}`;
    companion.stop();
    await sleep(1000);
  }

  NodeFS.writeFileSync(NodePath.join(out, "dialogs.txt"), dialogs.join("\n\n---\n\n"));
  NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(results, null, 2));
  log("results", results);
  companion.dispose();
  Electron.app.quit();
};

void Electron.app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    Electron.app.exit(1);
  }),
);
