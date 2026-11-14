// @effect-diagnostics globalDate:off globalRandom:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * Clicks every control of the real Home window on a Windows desktop, with the real mouse (SendInput through the input
 * driver), and records whether each one did something visible: the sidebar items, the header controls, and the tabs of
 * every settings dialog they open. The rectangles come from the page; the click is the system's, so the window's drag
 * regions and hit-testing are exercised, which a fake DOM cannot do. Writes results.md (a table) and a recording.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { createTessayaHome } from "../../home/tessayaHome.ts";
import { STATES } from "../../home/pageStates.ts";
import { createInputDriver } from "../inputDriver.ts";
import { createPointerOverlay } from "../pointerOverlay.ts";

const out = process.env["PROOF_OUT"] ?? NodePath.join(process.cwd(), "home-click-out");
NodeFS.mkdirSync(out, { recursive: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

setTimeout(() => Electron.app.exit(3), 15 * 60_000).unref();

interface Row {
  readonly group: string;
  readonly control: string;
  readonly result: "ok" | "no effect" | "not found" | "off screen" | "past the work area";
  readonly effect: string;
}

// HOME_CLICK_LAPTOP=1 makes the run look like the laptop: full motion (so the splash and fade play), and the
// window's own Mica where the runner's Windows has it. The click is still the system's real mouse.
const laptop = process.env["HOME_CLICK_LAPTOP"] === "1";
if (laptop) {
  (
    Electron.systemPreferences as unknown as { getAnimationSettings: () => object }
  ).getAnimationSettings = () => ({ prefersReducedMotion: false });
}

void Electron.app.whenReady().then(async () => {
  const driver = createInputDriver({
    platform: "win32",
    toPhysical: (p) => Electron.screen.dipToScreenPoint(p),
    clipboard: Electron.clipboard,
  });
  const base = STATES["empty"]!;
  const state = {
    status: { label: "Listening", tone: "good", device: "", mark: "", brandMark: "" },
    controls: base.controls,
    ...(base.extra === undefined ? {} : { extra: base.extra }),
  };
  // The laptop's remembered size goes where Home reads it, so the window is placed the way Home places it on the device;
  // the runner's 768-tall screen is shorter than that, which is what catches a window running under the taskbar.
  NodeFS.writeFileSync(
    NodePath.join(out, "baton-window.json"),
    JSON.stringify(
      laptop ? { x: 0, y: 0, width: 1138, height: 767 } : { x: 0, y: 0, width: 1024, height: 740 },
    ),
  );
  createTessayaHome({
    stateDir: out,
    state: () => state as never,
    apply: () => undefined,
    openSessions: () => undefined,
    appearance: () => "dark",
  }).open();
  await sleep(laptop ? 9000 : 4000);
  const win = Electron.BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && w.getTitle() === "Tessaya",
  );
  if (win === undefined) throw new Error("the Home window did not open");
  win.show();
  win.focus();
  await sleep(1500);
  const js = (code: string) => win.webContents.executeJavaScript(code) as Promise<unknown>;
  const errors: string[] = [];
  win.webContents.on("console-message", (details: unknown, ...legacy: unknown[]) => {
    const d = details as { level?: unknown; message?: string };
    const level = typeof d.level === "number" ? d.level : legacy[0];
    const text = String(d.message ?? legacy[1]);
    // The harness registers no history handler; that is not the page failing.
    if ((level === 3 || level === "error") && !text.includes("No handler registered"))
      errors.push(text);
  });
  await js("window.__errs=[];window.addEventListener('error',e=>window.__errs.push(e.message))");
  await js(
    "window.__mut=0;new MutationObserver(m=>{window.__mut+=m.length}).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});0",
  );
  const sig = () =>
    js(
      "JSON.stringify([typeof cur==='undefined'?'':cur, typeof modal==='undefined'?'':modal, (document.getElementById('page')||{}).innerText?.length, ((document.querySelector('#page h1')||{}).textContent||''), !!document.getElementById('modal'), document.activeElement&&document.activeElement.tagName+':'+document.activeElement.id, window.__mut])",
    ) as Promise<string>;
  interface Found {
    name: string;
    x: number;
    y: number;
    ok: boolean;
  }
  // Fresh every time, and scrolled into view: a click moves things, and a long sidebar scrolls.
  const find = (selector: string, only?: number) =>
    js(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e,i)=>{if(${only ?? -1}>=0&&i!==${only ?? -1})return {name:'',x:0,y:0,ok:false};e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const name=(e.getAttribute('aria-label')||e.textContent||e.id||e.tagName).trim().slice(0,32);return {name,x:r.x+r.width/2,y:r.y+r.height/2,ok:r.width>2&&r.height>2&&r.x>=0&&r.y>=0&&r.x<innerWidth&&r.y<innerHeight}})`,
    ) as Promise<Found[]>;
  const nth = async (selector: string, i: number) => {
    await sleep(250);
    return (await find(selector, i))[i];
  };
  const rows: Row[] = [];
  const facts = `windows ${process.getSystemVersion()}, scale ${Electron.screen.getPrimaryDisplay().scaleFactor}, root classes "${String(await js("document.documentElement.className"))}", windows open ${Electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length}, opacity ${win.getOpacity()}, window ${JSON.stringify(win.getBounds())} in ${JSON.stringify(Electron.screen.getPrimaryDisplay().workArea)}`;
  console.log(facts);
  const [wb, wa] = [win.getBounds(), Electron.screen.getDisplayMatching(win.getBounds()).workArea];
  // A window running under the taskbar loses every press on its bottom rows to the taskbar.
  if (
    wb.x < wa.x ||
    wb.y < wa.y ||
    wb.x + wb.width > wa.x + wa.width ||
    wb.y + wb.height > wa.y + wa.height
  )
    rows.push({
      group: "window",
      control: "Home",
      result: "past the work area",
      effect: JSON.stringify({ wb, wa }),
    });
  const press = async (group: string, c: Found) => {
    if (!c.ok) return rows.push({ group, control: c.name, result: "off screen", effect: "" });
    const before = await sig();
    const hit = (await js(
      `(()=>{const e=document.elementFromPoint(${c.x},${c.y});return e?e.tagName+"."+e.className+"#"+e.id+" in "+(e.parentElement?e.parentElement.tagName+"."+e.parentElement.className:""):"none"})()`,
    )) as string;
    const bounds = win.getContentBounds();
    await driver.clickAt({ x: bounds.x + c.x, y: bounds.y + c.y }, "left", 1);
    await sleep(900);
    const after = await sig();
    // A sidebar item must redraw the page, not only change which one is current.
    const redrew = before.split(",")[3] !== after.split(",")[3];
    const needsRedraw =
      group.startsWith("sidebar") &&
      !["Home", "Open T3 sessions", "Settings"].includes(c.name) &&
      !c.name.startsWith("Settings for");
    if (needsRedraw && !redrew && before !== after) {
      rows.push({
        group,
        control: c.name,
        result: "no effect",
        effect: `page did not redraw; under the pointer at ${Math.round(c.x)},${Math.round(c.y)}: ${hit}; errors ${String(await js("JSON.stringify(window.__errs||[])"))}`,
      });
      return;
    }
    rows.push({
      group,
      control: c.name,
      result: before === after ? "no effect" : "ok",
      effect: before === after ? "" : "page changed",
    });
  };

  const stopClip = startClip("home-click");
  const began = Date.now();
  await sleep(1500);

  // The sidebar: each item opens its page. Every area open, or a folded area's pages would go unclicked.
  await js("AREAS.forEach(a=>openAreas.add(a.id));render();0");
  const sideCount = (await find("#side .nav")).length;
  for (let i = 0; i < sideCount; i += 1) {
    const c = await nth("#side .nav", i);
    if (c !== undefined) await press("sidebar", c);
    await js("closeModal();go('home');0");
    await sleep(400);
  }

  // After the assistant has looked at the screen (its layer shown, every window excluded for the grab and put back) the layer
  // must still let a real click through to the window under it: a full-display layer that stops being click-through eats everything.
  const overlay = createPointerOverlay("win32");
  await overlay.point({ x: 520, y: 320 }, "look").catch(() => false);
  await sleep(1500);
  for (let look = 0; look < 3; look += 1) {
    await overlay.hiddenFor(() => sleep(150));
    await sleep(300);
  }
  for (const i of [2, 3, 6]) {
    const c = await nth("#side .nav", i);
    if (c !== undefined) await press("sidebar after a screen look", c);
    await js("closeModal();go('home');0");
    await sleep(400);
  }
  await overlay.clear();
  overlay.dispose();

  // The header: each control does something; one that opens a dialog gets every dialog tab clicked, then is closed.
  const headerSel = "#top button, #top a, #top input, #top select";
  const headerCount = (await find(headerSel)).length;
  for (let i = 0; i < headerCount; i += 1) {
    const c = await nth(headerSel, i);
    if (c === undefined) {
      rows.push({ group: "header", control: `#${i}`, result: "not found", effect: "" });
      continue;
    }
    await press("header", c);
    if (await js("typeof modal!=='undefined'&&!!modal")) {
      await sleep(700);
      const tabs = (await find("#mnav button")).length;
      for (let t = 0; t < tabs; t += 1) {
        const tab = await nth("#mnav button", t);
        if (tab !== undefined) await press("dialog tab", tab);
      }
    }
    await js("closeModal();go('home');0");
    await sleep(400);
  }
  // The dialogs that no header control opens in this state.
  for (const m of ["general", "system", "keys", "account", "updates", "about"]) {
    await js(`modal=${JSON.stringify(m)};render();0`);
    await sleep(800);
    const tabs = (await find("#mnav button")).length;
    for (let t = 0; t < tabs; t += 1) {
      const tab = await nth("#mnav button", t);
      if (tab !== undefined) await press(`dialog ${m}`, tab);
    }
    await js("closeModal();0");
    await sleep(300);
  }
  const seconds = (Date.now() - began) / 1000;
  await stopClip(seconds);

  const dead = rows.filter((r) => r.result !== "ok");
  NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(rows, null, 2));
  NodeFS.writeFileSync(
    NodePath.join(out, "results.md"),
    [
      `${facts}\n\n### Home click-through: ${rows.length} controls, ${rows.length - dead.length} with a visible effect`,
      "| group | control | result | effect |",
      "| --- | --- | --- | --- |",
      ...rows.map(
        (r) => `| ${r.group} | ${r.control.replaceAll("|", "/")} | ${r.result} | ${r.effect} |`,
      ),
    ].join("\n"),
  );
  if (errors.length > 0)
    NodeFS.appendFileSync(
      NodePath.join(out, "results.md"),
      `\n\nPage errors:\n${errors.join("\n")}\n`,
    );
  console.log(
    `controls ${rows.length}, without effect ${dead.length}, page errors ${errors.length}`,
  );
  Electron.app.exit(dead.length > 0 || errors.length > 0 ? 1 : 0);
});
