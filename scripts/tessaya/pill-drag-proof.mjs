#!/usr/bin/env node
/* oxlint-disable t3code/namespace-node-imports -- Baton file predating the rule (D82) */
// Proves a pill drag survives the cursor outrunning the capsule: pointerdown, then 30 moves of 20 px
// in x and y while the capsule slides away behind the cursor, must keep the drag going until the
// pointer is released. Run: node scripts/tessaya/pill-drag-proof.mjs [path-to-a-voicePill.ts]
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const file =
  process.argv[2] ??
  fileURLToPath(new URL("../../apps/desktop/src/tessaya/voice/voicePill.ts", import.meta.url));
const { PILL_DOCUMENT } = await import(file);
const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1600, height: 1400 } })
).newPage();
await page.addInitScript(() => {
  window.__sent = [];
  window.require = () => ({ ipcRenderer: { send: (...a) => window.__sent.push(a) } });
  window.__moves = [];
  addEventListener("pointermove", (e) => window.__moves.push([e.clientX, e.clientY]), true);
});
await page.goto("about:blank");
await page.setContent(PILL_DOCUMENT);
await page.evaluate(() => {
  window.__sent ??= [];
  window.__moves = [];
  addEventListener("pointermove", (e) => window.__moves.push([e.clientX, e.clientY]), true);
  if (typeof window.require !== "function")
    window.require = () => ({ ipcRenderer: { send: (...a) => window.__sent.push(a) } });
});
await page.evaluate(() =>
  window.pill.show({
    label: "Listening",
    caption: null,
    phase: "listening",
    tone: "plain",
    wave: "live",
  }),
);
await page.waitForTimeout(300);
const box = await page.locator("#p").boundingBox();
const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
await page.mouse.move(start.x, start.y);
await page.mouse.down();
for (let i = 1; i <= 30; i += 1) {
  await page.mouse.move(start.x + i * 20, start.y + i * 20);
  // The window follows a few frames late: the capsule is where the cursor was, not where it is.
  await page.evaluate((k) => {
    document.getElementById("p").style.transform =
      `translate(${Math.max(0, k - 3) * 20}px, ${Math.max(0, k - 3) * 20}px)`;
  }, i);
}
const before = await page.evaluate(() => window.__sent.map((a) => a.slice(0, 2).join(":")));
await page.mouse.up();
const after = await page.evaluate(() => ({
  sent: window.__sent.map((a) => a.slice(0, 3).join(":")),
  moves: window.__moves.at(-1),
}));
console.log("last pointermove", after.moves, "from", start);
await browser.close();
const endedEarly = before.includes("baton-pill:drag:false");
const started = before.includes("baton-pill:drag:true");
const ended = after.sent.filter((s) => s.startsWith("baton-pill:drag:false"));
const checks = [
  ["the drag started", started],
  ["it stayed active through 30 moves while the capsule lagged", !endedEarly],
  ["it ended once, on release, as 'up'", ended.length === 1 && ended[0].endsWith(":up")],
  [
    "both axes moved",
    after.moves !== undefined && after.moves[0] >= start.x + 500 && after.moves[1] >= start.y + 500,
  ],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
