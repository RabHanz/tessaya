// @effect-diagnostics globalDate:off globalRandom:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * Loads the pill's own page in a real window and walks it through every state, including the resting always-on
 * capsule reached after a listening state. In each state the icon, if it is on screen, must have loaded
 * (naturalWidth > 0); a picture of the pill is saved for each. Writes results.md.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { PILL_DOCUMENT } from "../../voice/voicePill.ts";

const out = process.env["PROOF_OUT"] ?? NodePath.join(process.cwd(), "pill-icon-out");
NodeFS.mkdirSync(out, { recursive: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
setTimeout(() => Electron.app.exit(3), 3 * 60_000).unref();

const view = (phase: string, label: string) => ({
  phase,
  label,
  tone: "voice",
  wave: "live",
  caption: "",
});
const STEPS: ReadonlyArray<readonly [string, string]> = [
  ["start (nothing shown)", ""],
  ["listening", `window.pill.show(${JSON.stringify(view("listening", "Listening"))})`],
  ["always-on rest after listening", "window.pill.rest('sleeping')"],
  ["thinking", `window.pill.show(${JSON.stringify(view("thinking", "Thinking"))})`],
  ["always-on rest after thinking", "window.pill.rest('muted')"],
  ["speaking", `window.pill.show(${JSON.stringify(view("speaking", "Speaking"))})`],
  ["idle", `window.pill.show(${JSON.stringify(view("idle", "Ready"))})`],
  ["always-on rest, off", "window.pill.rest('off')"],
  ["dictating", `window.pill.show(${JSON.stringify(view("dictating", "Dictating"))})`],
  ["hidden", "window.pill.hide()"],
];

void Electron.app.whenReady().then(async () => {
  const win = new Electron.BrowserWindow({
    width: 420,
    height: 120,
    show: true,
    frame: false,
    transparent: false,
    backgroundColor: "#808080",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PILL_DOCUMENT)}`);
  await sleep(800);
  const js = (code: string) => win.webContents.executeJavaScript(code) as Promise<unknown>;
  const rows: string[] = [];
  let bad = 0;
  for (const [index, [name, code]] of STEPS.entries()) {
    if (code !== "") await js(`${code};0`);
    await sleep(2300);
    const probe = (await js(
      "(()=>{const m=document.getElementById('mk');const shown=getComputedStyle(m).display!=='none'&&m.getBoundingClientRect().width>0;return {shown,complete:m.complete,w:m.naturalWidth,src:m.getAttribute('src')===null?'none':'set'}})()",
    )) as { shown: boolean; complete: boolean; w: number; src: string };
    const ok = !probe.shown || (probe.complete && probe.w > 0);
    if (!ok) bad += 1;
    NodeFS.writeFileSync(
      NodePath.join(
        out,
        `${String(index).padStart(2, "0")}-${name.replaceAll(/[^a-z]+/gi, "-")}.png`,
      ),
      (await win.webContents.capturePage()).toPNG(),
    );
    rows.push(
      `| ${name} | ${probe.shown ? "on screen" : "not shown"} | src ${probe.src} | ${probe.w} | ${ok ? "ok" : "BROKEN ICON"} |`,
    );
  }
  const text = [
    `### Pill icon in every state: ${bad === 0 ? "all fine" : `${bad} broken`}`,
    "| state | icon | source | naturalWidth | result |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(out, "results.md"), text);
  console.log(text);
  Electron.app.exit(bad === 0 ? 0 : 1);
});
