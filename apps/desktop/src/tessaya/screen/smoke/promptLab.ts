// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off globalConsole:off
/**
 * The Run it box with the worst plan it can be given, in real Chromium: a long spoken reply, 20
 * steps and padding that once ran off the side. Nothing is pressed and no model runs.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { createCompanionWindows } from "../companionWindows.ts";

const out = process.env["LAB_OUT"] ?? process.cwd();
const write = (value: unknown) =>
  NodeFS.appendFileSync(NodePath.join(out, "timeline.jsonl"), `${JSON.stringify(value)}\n`);

const main = async () => {
  await Electron.app.whenReady();
  const windows = createCompanionWindows({
    output: () => "written",
    setOutput: () => undefined,
    onAsk: () => undefined,
  });
  const steps = Array.from(
    { length: 20 },
    (_, i) => `${i + 1}. Type “${"step ".repeat(30)}${i === 19 ? "THE LAST STEP" : ""}”`,
  ).join("\n");
  const spoken = "I can see the window you mean, and here is what I would do. ".repeat(30);
  const unbroken = "x".repeat(1_800);
  const answer = windows.ask({
    title: "Worst plan",
    detail: `${spoken}\n\n${steps}\n\n${unbroken}`,
    buttons: ["Run it", "Not now"],
    cancel: 1,
    expiresMs: 25_000,
  });
  const [box] = await (async () => {
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const open = Electron.BrowserWindow.getAllWindows().filter((w) => w.isVisible());
      if (open.length > 0) return open;
    }
    throw new Error("the box never opened");
  })();
  const read = () =>
    box!.webContents
      .executeJavaScript(`(()=>{const d=document.getElementById('d');const m=document.querySelector('button');
      return {disabled:m.disabled,focused:document.activeElement===m,sideways:d.scrollWidth>d.clientWidth,
      below:d.scrollHeight-d.scrollTop-d.clientHeight,height:innerHeight}})()`);
  write({ opened: await read() });
  await box!.webContents.executeJavaScript(
    `(()=>{const m=document.querySelector('button');m.click()})()`,
  );
  await new Promise((r) => setTimeout(r, 300));
  write({ pressedEarly: box!.isDestroyed() ? "closed" : "still open" });
  await box!.webContents.executeJavaScript(
    `(()=>{const d=document.getElementById('d');d.scrollTop=d.scrollHeight})()`,
  );
  await new Promise((r) => setTimeout(r, 300));
  write({ scrolled: await read() });
  await box!.webContents.executeJavaScript(`document.querySelectorAll('button')[1].click()`);
  write({ answer: await answer });
  windows.dispose();
  Electron.app.exit(0);
};

void main().catch((error: unknown) => {
  write({ error: String(error) });
  Electron.app.exit(1);
});
