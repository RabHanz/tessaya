#!/usr/bin/env node
/* oxlint-disable t3code/namespace-node-imports -- standalone CI script, run outside the workspace */
// Release smoke on an installed Tessaya (Windows CI): drives the real app over its DevTools port and screenshots the
// pages a release changed. Tessaya's window: Devices › Hardware (opened by a tessaya:// link) and Settings › Home and
// devices › Hardware. T3's window: the old settings routes that now show "moved to Tessaya". Each step also saves a
// capture of the whole desktop, which is what he would see, webviews included.
// Run: node release-smoke.mjs <path to Tessaya.exe>   (the app already running with --remote-debugging-port=9229)
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const exe = process.argv[2];
const out = process.env.PROOF_OUT ?? "release-smoke-out";
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const row = (step, ok, detail) => rows.push({ step, ok, detail: String(detail).replace(/\s+/g, " ").slice(0, 160) });

const desktop = (name) => {
  const file = join(out, `${name}-desktop.png`).replace(/'/g, "''");
  try {
    execFileSync("powershell", ["-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
      "$m=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($m).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); " +
      `$m.Save('${file}')`], { timeout: 30_000 });
  } catch (error) {
    row(`${name}: desktop capture`, false, error.message);
  }
};

const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
const pages = () => browser.contexts().flatMap((c) => c.pages());
const describe = async () =>
  Promise.all(pages().map(async (p) => `${await p.title().catch(() => "?")} <${p.url().slice(0, 80)}>`));
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
  if (page) await page.screenshot({ path: join(out, `${name}.png`) }).catch((e) => row(`${name}: page capture`, false, e.message));
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
const isT3 = (p) => /^(t3code:\/\/app|https?:\/\/(127\.0\.0\.1|localhost))/.test(p.url()) && !p.url().includes("/tessaya/");
const isTessaya = (p) => /baton-window[^/]*\.html/.test(p.url());

// Tessaya's window, opened at Devices › Hardware by a second launch with a link (as from a notification or Ctrl+K).
spawn(exe, ["tessaya://settings/hardware"], { detached: true, stdio: "ignore" }).unref();
const tessaya = await waitFor(isTessaya);
row("Tessaya's window opens from tessaya://settings/hardware", tessaya !== null, (await describe()).join(" | "));
if (tessaya) {
  await tessaya.bringToFront().catch(() => undefined);
  // A fresh install opens on the setup tour; he can skip it the same way.
  for (const skip of ["Skip the rest", "Skip", "Not now", "Later"]) {
    await tessaya.getByText(skip, { exact: true }).filter({ visible: true }).first().click({ timeout: 2_000 }).catch(() => undefined);
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
    inline !== null && /Hardware/.test(inlineText) && !/Connect your computers|Add project/.test(inlineText),
    inline ? `${inline.url()} :: ${inlineText.slice(0, 100)}` : "no inline page found",
  );
  if ((await click(tessaya, "Devices")) && (await click(tessaya, "Hardware"))) {
    await shot("tessaya-devices-hardware-clicked", tessaya, /Hardware/);
  }
  if ((await click(tessaya, "Settings")) && (await click(tessaya, "Home and devices"))) {
    await shot("tessaya-settings-home-and-devices", tessaya, /Hardware/);
    if (await click(tessaya, "Hardware")) await shot("tessaya-settings-hardware", tessaya, /Hardware/);
  }
}

// T3's window: the moved settings pages answer with a card that opens Tessaya. Since #803 it opens only when asked.
row("windows at start (#803: Tessaya's alone)", true, atStart.join(" | "));
if (!pages().some(isT3) && tessaya) await click(tessaya, "Open T3 sessions");
const t3 = await waitFor(isT3);
row("T3's window is open", t3 !== null, (await describe()).join(" | "));
if (t3) {
  const at = (route) => (t3.url().startsWith("t3code:") ? `t3code://app/#/settings/${route}` : `${new URL(t3.url()).origin}/settings/${route}`);
  await t3.bringToFront().catch(() => undefined);
  for (const route of ["hardware", "home", "apis"]) {
    await t3.goto(at(route)).catch((e) => row(`T3 /settings/${route}`, false, e.message));
    await shot(`t3-settings-${route}-moved`, t3, /moved[\s\S]*Open in Tessaya/i);
  }
  await t3.goto(at("tessaya")).catch(() => undefined);
  await shot("t3-settings-tessaya", t3, /Tessaya/);
}

const failed = rows.filter((r) => !r.ok);
const md = [
  "| step | ok | detail |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.step} | ${r.ok ? "yes" : "**no**"} | ${r.detail.replace(/\|/g, "/")} |`),
].join("\n");
writeFileSync(join(out, "results.md"), `${md}\n`);
console.log(md);
await browser.close().catch(() => undefined);
process.exit(failed.length > 0 ? 1 : 0);
