#!/usr/bin/env node
/* oxlint-disable t3code/namespace-node-imports -- standalone CI script, run outside the workspace */
// Drives an installed Tessaya over its DevTools port and screenshots the pages a release changed, plus a whole-desktop
// capture per step (webviews included). Run with the app started with --remote-debugging-port=9229:
// node release-smoke.mjs <path to Tessaya.exe>
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const exe = process.argv[2];
const out = process.env.PROOF_OUT ?? "release-smoke-out";
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const row = (step, ok, detail) =>
  rows.push({ step, ok, detail: String(detail).replace(/\s+/g, " ").slice(0, 160) });

const desktop = (name) => {
  const file = join(out, `${name}-desktop.png`).replace(/'/g, "''");
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
          "$m=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($m).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); " +
          `$m.Save('${file}')`,
      ],
      { timeout: 30_000 },
    );
  } catch (error) {
    row(`${name}: desktop capture`, false, error.message);
  }
};

const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
const pages = () => browser.contexts().flatMap((c) => c.pages());
const describe = async () =>
  Promise.all(
    pages().map(async (p) => `${await p.title().catch(() => "?")} <${p.url().slice(0, 80)}>`),
  );
const waitFor = async (test, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const found = pages().find(test);
    if (found) return found;
  }
  return null;
};
const text = (page) => page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
const shot = async (name, page, expect) => {
  await sleep(2500);
  if (page)
    await page
      .screenshot({ path: join(out, `${name}.png`) })
      .catch((e) => row(`${name}: page capture`, false, e.message));
  desktop(name);
  const body = page ? await text(page) : "";
  const ok = expect === undefined || expect.test(body);
  row(name, ok, ok ? body.slice(0, 120) : `expected ${expect} in: ${body.slice(0, 120)}`);
};
const click = async (page, label) => {
  // The last visible match: a settings dialog's own list sits after (above) the sidebar's.
  const target = page.getByText(label, { exact: true }).filter({ visible: true }).last();
  try {
    await target.click({ timeout: 8_000 });
    return true;
  } catch {
    row(`click "${label}"`, false, "not found or not clickable");
    return false;
  }
};

const atStart = await describe();
console.log("windows at start:", atStart);
// T3's window is the t3code://app hash router (or the server origin in a browser); Tessaya's is baton-window*.html.
const isT3 = (p) =>
  /^(t3code:\/\/app|https?:\/\/(127\.0\.0\.1|localhost))/.test(p.url()) &&
  !p.url().includes("/tessaya/");
const isTessaya = (p) => /baton-window[^/]*\.html/.test(p.url());

// Tessaya's window, opened at Devices › Hardware by a second launch with a link (as from a notification or Ctrl+K).
spawn(exe, ["tessaya://settings/hardware"], { detached: true, stdio: "ignore" }).unref();
const tessaya = await waitFor(isTessaya);
row(
  "Tessaya's window opens from tessaya://settings/hardware",
  tessaya !== null,
  (await describe()).join(" | "),
);
if (tessaya) {
  await tessaya.bringToFront().catch(() => undefined);
  // A fresh install opens on the setup tour; he can skip it the same way.
  for (const skip of ["Skip the rest", "Skip", "Not now", "Later"]) {
    await tessaya
      .getByText(skip, { exact: true })
      .filter({ visible: true })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
  }
  // A fresh install also starts T3's own first run ("Connect your computers"), which an inline T3 page shows too.
  await sleep(1500);
  spawn(exe, ["tessaya://settings/hardware"], { detached: true, stdio: "ignore" }).unref();
  await shot("tessaya-devices-hardware", tessaya, /Hardware/);
  // The inline page is T3's /tessaya/hardware in a webview: the page alone, never T3's first-run wizard or shell.
  const inline = await waitFor((p) => /tessaya\/hardware/.test(p.url()), 15_000);
  const inlineText = inline ? await text(inline) : "";
  row(
    "inline Hardware page is the page alone (no T3 wizard or sidebar)",
    inline !== null &&
      /Hardware/.test(inlineText) &&
      !/Connect your computers|Add project/.test(inlineText),
    inline ? `${inline.url()} :: ${inlineText.slice(0, 100)}` : "no inline page found",
  );
  if ((await click(tessaya, "Devices")) && (await click(tessaya, "Hardware"))) {
    await shot("tessaya-devices-hardware-clicked", tessaya, /Hardware/);
  }
  if ((await click(tessaya, "Settings")) && (await click(tessaya, "Home and devices"))) {
    await shot("tessaya-settings-home-and-devices", tessaya, /Hardware/);
    if (await click(tessaya, "Hardware"))
      await shot("tessaya-settings-hardware", tessaya, /Hardware/);
  }
}

// Voice ID's guided enrolment card. The read needs a microphone, which a CI runner lacks: then it is skipped, not failed.
if (
  tessaya &&
  (await click(tessaya, "Settings")) &&
  (await click(tessaya, "Voice and wake words"))
) {
  const voiceId = tessaya.getByRole("switch", { name: "Voice ID", exact: true });
  if ((await voiceId.getAttribute("aria-checked").catch(() => null)) === "false")
    await voiceId.click({ timeout: 8_000 }).catch((e) => row("turn Voice ID on", false, e.message));
  const enrol = tessaya.getByRole("button", { name: "Make my voice profile" });
  await enrol.waitFor({ timeout: 90_000 }).catch(() => undefined);
  await shot("tessaya-settings-voice-id", tessaya, /Voice ID/);
  // The row is drawn disabled (no attribute) until voice is on, which needs a microphone.
  const noMic = /Turn on voice first/.test(await text(tessaya));
  if ((await enrol.count()) > 0 && !noMic) {
    const opened = await enrol
      .click({ timeout: 8_000 })
      .then(() => true)
      .catch((e) => (row("click Make my voice profile", false, e.message), false));
    if (opened) await shot("tessaya-voice-id-enrol-card", tessaya, /Read these aloud/);
  } else
    rows.push({
      step: "Voice ID enrol card opens",
      ok: null,
      detail: noMic
        ? "skipped: voice is off, there is no microphone on this machine"
        : "skipped: no enrol button (voice model not ready)",
    });
}

// The pill and the desktop mascot run isolated pages whose one bridge is their preload: without it the pill's clicks and
// waveform go nowhere and the mascot's page script throws (0.1.118 lacked her page, 0.1.119 her preload).
const pill = pages().find(
  (p) => p.url().startsWith("data:text/html") && p.url().includes("data-design"),
);
// The pill's window is built when it is first raised or shown at rest, so a runner may have none yet.
if (pill === undefined)
  rows.push({ step: "the pill's page has its preload", ok: null, detail: "skipped: no pill page" });
else {
  const bridge = await pill.evaluate(() => typeof window.pillIpc).catch((e) => e.message);
  row("the pill's page has its preload (window.pillIpc)", bridge === "object", bridge);
}
if (tessaya) {
  const turnsLog = join(homedir(), ".t3", "userdata", "logs", "voice-turns.ndjson");
  const logged = () => (existsSync(turnsLog) ? readFileSync(turnsLog, "utf8").length : 0);
  const from = logged();
  // The page's own setter, as its "Show her on the desktop" switch calls it.
  await tessaya
    .evaluate(() => require("electron").ipcRenderer.invoke("baton-home:set", "v.mascot", true))
    .catch((e) => row("turn the desktop companion on", false, e.message));
  const stage = await waitFor((p) => p.url().endsWith("/companion/stage.html"), 20_000);
  await sleep(3000);
  const drawn = stage
    ? await stage
        .evaluate(() => ({
          ipc: typeof window.mascotIpc,
          mascot: typeof window.mascot,
          rig: document.querySelectorAll("#c *").length,
        }))
        .catch((e) => ({ error: e.message }))
    : null;
  const failures = (existsSync(turnsLog) ? readFileSync(turnsLog, "utf8").slice(from) : "")
    .split("\n")
    .filter((line) => line.includes("mascot_load_failed"));
  row(
    "the desktop mascot loads and draws",
    drawn !== null &&
      drawn.ipc === "object" &&
      drawn.mascot === "object" &&
      drawn.rig > 0 &&
      failures.length === 0,
    `${stage ? stage.url().slice(-40) : "no stage page"} ${JSON.stringify(drawn)} ${failures.join(" ")}`,
  );
  if (stage) await shot("desktop-mascot", stage);
  // Picked up, carried up the screen and let go: she keeps her size and lands with her feet inside the work area
  // (0.1.120 grew on Windows while dragged and sank through the taskbar by the growth).
  if (stage) {
    const where = () =>
      stage.evaluate(() => ({
        x: window.screenX,
        y: window.screenY,
        w: window.outerWidth,
        h: window.outerHeight,
        top: screen.availTop,
        bottom: screen.availTop + screen.availHeight,
        left: screen.availLeft,
        right: screen.availLeft + screen.availWidth,
      }));
    const cursor = (x, y) =>
      execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)})`,
      ]);
    try {
      const before = await where();
      cursor(before.x + before.w / 2, before.y + before.h * 0.6);
      await stage.evaluate(() => window.mascotIpc.send("baton-mascot:press"));
      for (let i = 1; i <= 10; i++) {
        cursor(before.x + before.w / 2 - i * 30, before.y + before.h * 0.6 - i * 40);
        await sleep(50);
      }
      await stage.evaluate(() => window.mascotIpc.send("baton-mascot:release"));
      // Let go mid-flick, she flies, bounces and slides before she rests.
      await sleep(6000);
      const after = await where();
      const feet = after.y + after.h * ((112 + 168) / 320);
      row(
        "the mascot keeps her size and lands inside the work area after a drag",
        after.w === before.w &&
          after.h === before.h &&
          // On the floor, or on the top of a window inside the work area: never below it.
          feet >= after.top &&
          feet <= after.bottom + 3 &&
          after.x + after.w / 2 >= after.left &&
          after.x + after.w / 2 <= after.right,
        `before ${JSON.stringify(before)} after ${JSON.stringify(after)} feet ${feet}`,
      );
    } catch (error) {
      row("drag the mascot", false, error.message);
    }
    // At rest she costs next to nothing: her page's main-thread work over 10 s (blinks only).
    try {
      const cdp = await stage.context().newCDPSession(stage);
      await cdp.send("Performance.enable");
      const busy = async () =>
        (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration")
          .value;
      const from = await busy();
      await sleep(10_000);
      const used = (await busy()) - from;
      row(
        "the mascot at rest uses under 1% of a core",
        used < 0.1,
        `${(used * 1000).toFixed(0)} ms busy in 10 s`,
      );
    } catch (error) {
      row("measure the mascot at rest", false, error.message);
    }
  }
}

// T3's window opens only when asked: the moved settings pages there answer with a card that opens Tessaya.
row("windows at start (Tessaya's alone)", true, atStart.join(" | "));
if (!pages().some(isT3) && tessaya) await click(tessaya, "Open T3 sessions");
const t3 = await waitFor(isT3);
row("T3's window is open", t3 !== null, (await describe()).join(" | "));
if (t3) {
  const at = (route) =>
    t3.url().startsWith("t3code:")
      ? `t3code://app/#/settings/${route}`
      : `${new URL(t3.url()).origin}/settings/${route}`;
  await t3.bringToFront().catch(() => undefined);
  for (const route of ["hardware", "home", "apis"]) {
    await t3.goto(at(route)).catch((e) => row(`T3 /settings/${route}`, false, e.message));
    await shot(`t3-settings-${route}-moved`, t3, /moved[\s\S]*Open in Tessaya/i);
  }
  await t3.goto(at("tessaya")).catch(() => undefined);
  await shot("t3-settings-tessaya", t3, /Tessaya/);
}

const failed = rows.filter((r) => r.ok === false);
const md = [
  "| step | ok | detail |",
  "|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.step} | ${r.ok === null ? "skipped" : r.ok ? "yes" : "**no**"} | ${r.detail.replace(/\|/g, "/")} |`,
  ),
].join("\n");
writeFileSync(join(out, "results.md"), `${md}\n`);
console.log(md);
await browser.close().catch(() => undefined);
process.exit(failed.length > 0 ? 1 : 0);
