/* oxlint-disable t3code/namespace-node-imports -- Baton file predating the rule (D82) */
// Renders Baton's mark (apps/desktop/src/tessaya/voice/trayMark.ts) to the app and installer icons into assets/baton/
// and a sheet of every tray state. Run: node scripts/tessaya/export-icons.mjs [frames-dir]
// Needs playwright's chromium and ImageMagick `convert`. macOS .icns is still made by the build.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { markSvg } from "../../apps/desktop/src/tessaya/voice/trayMark.ts";

const require = createRequire(import.meta.url);
// pnpm does not hoist playwright-core to the root.
const pnpm = "node_modules/.pnpm";
const core = readdirSync(pnpm).find((d) => d.startsWith("playwright-core@"));
const { chromium } = require(join(process.cwd(), pnpm, core, "node_modules/playwright-core"));
const BRAND = "#1f6f5b";
const ALL = [true, true, true];
const STATES = [
  ["sleeping", "#6b7280"],
  ["listening", "#22c55e"],
  ["command", "#3b82f6"],
  ["conversation", "#6366f1"],
  ["direct", "#f59e0b"],
  ["dictating", "#14b8a6"],
  ["muted", "#ef4444"],
];
const framesDir = process.argv[2];
// Baton-owned; apply-release-branding.sh copies these over assets/prod at release time.
const prod = "assets/baton";
mkdirSync(prod, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const png = async (svg, size, path, pad = 0) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent"><div style="margin:${pad}px;width:${size - 2 * pad}px;height:${size - 2 * pad}px">${svg.replace("<svg ", '<svg width="100%" height="100%" ')}</div>`,
  );
  await page.screenshot({ path, omitBackground: true });
};
const app = markSvg({ color: BRAND, caps: ALL, muted: false });
writeFileSync(join(prod, "logo.svg"), app);
await png(app, 1024, join(prod, "black-universal-1024.png"));
await png(app, 1024, join(prod, "black-macos-1024.png"), 100);
await png(app, 180, join(prod, "t3-black-web-apple-touch-180.png"));
await png(app, 32, join(prod, "t3-black-web-favicon-32x32.png"));
await png(app, 16, join(prod, "t3-black-web-favicon-16x16.png"));
const tmp = join(process.env.TMPDIR ?? "/tmp", "baton-ico");
mkdirSync(tmp, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
for (const s of sizes) await png(app, s, join(tmp, `${s}.png`));
const ico = (out) => execFileSync("convert", [...sizes.map((s) => join(tmp, `${s}.png`)), out]);
ico(join(prod, "t3-black-windows.ico"));
ico(join(prod, "t3-black-web-favicon.ico"));

if (framesDir) {
  mkdirSync(framesDir, { recursive: true });
  const cell = (svg, size) =>
    `<img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`;
  const rows = STATES.map(([name, color]) => {
    const muted = name === "muted";
    const one = (caps) => markSvg({ color, caps, muted });
    return `<tr><td>${name}</td><td>${cell(one(ALL), 96)}</td><td>${cell(one([true, false, false]), 96)}</td><td>${cell(one([false, false, false]), 96)}</td><td>${cell(one(ALL), 32)}</td><td>${cell(one(ALL), 16)}</td></tr>`;
  }).join("");
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.setContent(`<body style="margin:24px;font:14px system-ui;background:#f5f2ec"><table cellpadding=8><tr><th></th><th>all on</th><th>listening only</th><th>all off</th><th>32 px</th><th>16 px</th></tr>${rows}</table><p>App icon: ${cell(app, 128)}</p>
<div style="background:#1f1f1f;padding:12px;display:inline-block;color:#fff">dark tray ${STATES.map(([, c], i) => cell(markSvg({ color: c, caps: ALL, muted: i === 6 }), 24)).join(" ")}</div>`);
  await page.screenshot({ path: join(framesDir, "mark-states.png"), fullPage: true });
}
await browser.close();
