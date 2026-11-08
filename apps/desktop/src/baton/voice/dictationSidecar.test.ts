// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  pasteVerdictOf,
  focusedFrom,
  busyAfter,
  recordingAfter,
  resolveDictationBinary,
  restartDelayMs,
  startDictationSidecar,
  type DictationEvent,
  type DictationSidecar,
  makeSidecarStt,
} from "./dictationSidecar.ts";

describe("recordingAfter", () => {
  it("keeps a second recording live through the first one's cloud result, a notice and a reconfigure", () => {
    const events: ReadonlyArray<DictationEvent["ev"]> = [
      "recording",
      "transcribing",
      "recording",
      "text",
      "unread",
      "configured",
      "ready",
    ];
    expect(events.reduce((was, ev) => recordingAfter(ev, was), false)).toBe(true);
    expect(recordingAfter("idle", true)).toBe(false);
    expect(recordingAfter("error", true)).toBe(false);
    // Busy also while it writes the recording out: a wake must not end a short dictation's Finishing pill.
    expect(busyAfter("transcribing", false)).toBe(true);
    expect(busyAfter("text", true)).toBe(true);
    expect(busyAfter("idle", true)).toBe(false);
    expect(busyAfter("error", true)).toBe(false);
  });
});

describe("restartDelayMs", () => {
  it("backs off to a minute and no further", () => {
    expect([1, 2, 3, 7, 50].map(restartDelayMs)).toEqual([1_000, 2_000, 4_000, 60_000, 60_000]);
  });
});

describe("resolveDictationBinary", () => {
  it("is null where it was not built", () => {
    expect(
      resolveDictationBinary({
        resourcesPath: "/r",
        platform: "linux",
        env: {},
        exists: () => false,
      }),
    ).toBe(null);
  });

  it("names the binary for the platform", () => {
    const found = (platform: string) =>
      resolveDictationBinary({ resourcesPath: "/r", platform, env: {}, exists: () => true });
    expect(found("win32")?.endsWith("tessaya-voice.exe")).toBe(true);
    expect(found("darwin")?.endsWith("tessaya-voice")).toBe(true);
  });

  it("still finds an install that ships the old name", () => {
    const old = NodePath.join("/r", "baton-voice", "baton-dictation.exe");
    expect(
      resolveDictationBinary({
        resourcesPath: "/r",
        platform: "win32",
        env: {},
        exists: (path) => path === old,
      }),
    ).toBe(old);
  });
});

describe("the keyboard's window, through the real parser", () => {
  const reading = (window: number) =>
    focusedFrom({ ev: "foreground", app: "notepad.exe", title: "a", rect: null, window });

  it("keeps the window and drops a zero", () => {
    expect(reading(7).window).toBe(7);
    expect(reading(0).window).toBeUndefined();
  });
});

describe("a slow model load, through a real child process", () => {
  // A stand-in for tessaya-voice: it answers `load` with a few "loading" lines and then model_ready, and answers a
  // `transcribe` that arrived during the load only after it, as the real engine thread does.
  const fake = () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-sidecar-"));
    const file = NodePath.join(dir, "fake.mjs");
    NodeFS.writeFileSync(
      file,
      `#!/usr/bin/env node
import readline from "node:readline";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let queue = [];
let loaded = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.cmd === "load") {
    let n = 0;
    const t = setInterval(() => {
      out({ ev: "loading", elapsedMs: ++n * 100 });
      if (n === 4) { clearInterval(t); loaded = true; out({ ev: "model_ready", id: m.id, loadMs: 400 }); for (const q of queue) out({ ev: "text", id: q, text: "heard it" }); queue = []; }
    }, 100);
  } else if (m.cmd === "transcribe") { if (loaded) out({ ev: "text", id: m.id, text: "heard it", model: m.model ?? "dictation.gguf" }); else queue.push(m.id); }
});
`,
      { mode: 0o755 },
    );
    return file;
  };

  it("tells loading from a hang, loads on request, and answers a phrase that arrived mid-load", async () => {
    const events: DictationEvent[] = [];
    const models: Array<string | null> = [];
    const sidecar = startDictationSidecar({
      binary: fake(),
      onEvent: (e) => void events.push(e),
      onRecognised: (timing) => void models.push(timing.model),
    });
    try {
      const early = sidecar.transcribe("x.wav");
      const ready = sidecar.preload();
      expect(await ready).toBe(400);
      expect(await early).toBe("heard it");
      expect(events.filter((e) => e.ev === "loading").length).toBeGreaterThanOrEqual(3);
      expect(await sidecar.transcribe("y.wav")).toBe("heard it");
      // The wake path asks for its own model, and the log names the one that recognised each clip.
      expect(await sidecar.transcribe("z.wav", "/m/fast.gguf")).toBe("heard it");
      expect(models.slice(-2)).toEqual(["dictation.gguf", "/m/fast.gguf"]);
    } finally {
      sidecar.dispose();
    }
  });
});

describe("the wake path's own model", () => {
  const rig = (failure: string) => {
    const asked: Array<string | null> = [];
    const failed: string[] = [];
    const sidecar = {
      transcribe: async (_wav: string, model?: string | null) => {
        asked.push(model ?? null);
        if (model != null) throw new Error(failure);
        return "what time is it";
      },
    } as unknown as DictationSidecar;
    const stt = makeSidecarStt(
      sidecar,
      undefined,
      undefined,
      undefined,
      () => "/m/fast.gguf",
      (file) => void failed.push(file),
    );
    return { stt, asked, failed };
  };

  it.each(["load: bad model", "Dictation stopped."])(
    "falls back to dictation's model for a clip its own failed on (%s), and says so",
    async (failure) => {
      const r = rig(failure);
      expect(await r.stt.transcribe(new Int16Array(1_600))).toBe("what time is it");
      expect(r.asked).toEqual(["/m/fast.gguf", null]);
      expect(r.failed).toEqual(["/m/fast.gguf"]);
    },
  );

  it("takes a sidecar that did not answer in time for a busy machine, not a bad model", async () => {
    const r = rig("Dictation did not answer.");
    await expect(r.stt.transcribe(new Int16Array(1_600))).rejects.toThrow(
      "Dictation did not answer.",
    );
    expect(r.asked).toEqual(["/m/fast.gguf"]);
    expect(r.failed).toEqual([]);
  });
});

describe("pasteVerdictOf", () => {
  it("keeps the helper's reasons and calls anything else refused", () => {
    for (const why of ["ok", "gone", "changed", "secret"] as const)
      expect(pasteVerdictOf(why)).toBe(why);
    for (const why of ["late", "weird", undefined, 3]) expect(pasteVerdictOf(why)).toBe("refused");
  });
});
