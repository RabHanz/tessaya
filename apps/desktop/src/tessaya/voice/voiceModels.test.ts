// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  ensureModel,
  machinePicksFast,
  modelPresent,
  PARAKEET_FAST_MODEL,
  slowStartsAfter,
  verifyPersonalModel,
  wakeModelFor,
  weakMachine,
} from "./voiceModels.ts";

const bytes = Buffer.from("parakeet");
const model = (sha256: string) => ({
  file: "m.gguf",
  url: "https://example.invalid/m.gguf",
  size: bytes.length,
  sha256,
});
const good = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const fetchImpl = (async () => new Response(bytes)) as unknown as typeof fetch;
const instant = { attempts: 1, retryDelayMs: 0 };
const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-model-"));

describe("ensureModel", () => {
  it("publishes the file only after the hash matches", async () => {
    const dir = tempDir();
    const path = await ensureModel({ dir, model: model(good), onProgress: () => {}, fetchImpl });
    expect(NodeFS.readFileSync(path)).toEqual(bytes);
  });

  it("leaves nothing behind on a bad hash", async () => {
    const dir = tempDir();
    await expect(
      ensureModel({
        dir,
        model: model("0".repeat(64)),
        onProgress: () => {},
        fetchImpl,
        ...instant,
      }),
    ).rejects.toThrow("checksum");
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });

  it("does not download what is already there", async () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, "m.gguf"), bytes);
    const never = (async () => {
      throw new Error("no network");
    }) as unknown as typeof fetch;
    await expect(
      ensureModel({ dir, model: model(good), onProgress: () => {}, fetchImpl: never }),
    ).resolves.toContain("m.gguf");
  });

  it("replaces a right-sized file whose bytes are wrong", async () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, "m.gguf"), "x".repeat(bytes.length));
    const path = await ensureModel({ dir, model: model(good), onProgress: () => {}, fetchImpl });
    expect(NodeFS.readFileSync(path)).toEqual(bytes);
  });

  it("gives one download to two callers", async () => {
    const dir = tempDir();
    let calls = 0;
    const counted = (async () => {
      calls += 1;
      return new Response(bytes);
    }) as unknown as typeof fetch;
    const input = { dir, model: model(good), onProgress: () => {}, fetchImpl: counted };
    await Promise.all([ensureModel(input), ensureModel(input)]);
    expect(calls).toBe(1);
  });

  it("retries a failed download", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("network");
      return new Response(bytes);
    }) as unknown as typeof fetch;
    const dir = tempDir();
    await ensureModel({
      dir,
      model: model(good),
      onProgress: () => {},
      fetchImpl: flaky,
      attempts: 2,
      retryDelayMs: 0,
    });
    expect(calls).toBe(2);
  });

  it("gives up on a stalled download and leaves nothing behind", async () => {
    const stalled = (async () =>
      new Response(new ReadableStream({ start: () => {} }))) as unknown as typeof fetch;
    const dir = tempDir();
    await expect(
      ensureModel({
        dir,
        model: model(good),
        onProgress: () => {},
        fetchImpl: stalled,
        stallMs: 20,
        ...instant,
      }),
    ).rejects.toThrow("stalled");
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });

  it("names a model that is present only at its full size", () => {
    const dir = tempDir();
    expect(modelPresent(dir, model(good))).toBe(false);
    NodeFS.writeFileSync(NodePath.join(dir, "m.gguf"), bytes);
    expect(modelPresent(dir, model(good))).toBe(true);
  });
});

describe("the wake path's model", () => {
  it.each([
    // [his languages, his dictation model, the model the wake path asks for (null: dictation's)]
    [["en"], "v3", PARAKEET_FAST_MODEL],
    [["en-GB"], "v3", PARAKEET_FAST_MODEL],
    [["EN", "en-US"], "v3", PARAKEET_FAST_MODEL],
    [["en", "de"], "v3", null],
    [["fr"], "v3", null],
    // None set: nothing says it is only English.
    [[], "v3", null],
    // Dictation already on the fast model: the wake path shares it, and is never moved back to v3.
    [["en"], "fast", null],
    [[], "fast", null],
    [["de"], "fast", null],
  ] as const)("%j with %s dictation asks for %o", (languages, speechModel, model) => {
    expect(wakeModelFor(languages, speechModel)).toBe(model);
  });
});

describe("a weak machine", () => {
  const GB = 2 ** 30;
  it.each([
    // [fresh install, logical cores, memory, slow starts in a row, the reason it is weak (null: it is not)]
    [true, 8, 15.8 * GB, 0, null],
    [true, 4, 15.8 * GB, 0, "4 logical cores"],
    [true, 2, 7.8 * GB, 0, "2 logical cores"],
    [true, 8, 7.8 * GB, 0, "8 GB of memory"],
    [true, 8, 10 * GB, 0, null],
    // An existing install may have chosen v3 before the choice was recorded: only slow starts move it.
    [false, 2, 7.8 * GB, 0, null],
    [false, 8, 15.8 * GB, 1, null],
    [false, 8, 15.8 * GB, 2, "2 slow starts in a row"],
  ] as const)(
    "fresh %s, %i cores, %d bytes, %i slow: %o",
    (freshInstall, cpus, memoryBytes, slowStarts, reason) => {
      expect(weakMachine({ freshInstall, cpus, memoryBytes, slowStarts })).toBe(reason);
    },
  );

  it.each([
    // [slow starts so far, this start's load ms, it downloaded the model first, slow starts after]
    [0, 45_000, false, 1],
    [1, 45_000, false, 2],
    [0, 30_000, false, 0],
    // His laptop's worst start.
    [1, 13_602, false, 0],
    // The first start after the download reads a cold disk past the virus scanner.
    [0, 90_000, true, 0],
    [1, 90_000, true, 1],
  ] as const)("%i, then %i ms (downloaded %s): %i", (previous, loadMs, downloaded, after) => {
    expect(slowStartsAfter(previous, loadMs, downloaded)).toBe(after);
  });

  it.each([
    // [his settings, picks the fast model]
    [{ speechModel: "v3", languages: ["en"] }, true],
    [{ speechModel: "v3", languages: ["en-GB"] }, true],
    // He chose v3 himself: his choice wins.
    [{ speechModel: "v3", speechModelPicked: "you", languages: ["en"] }, false],
    // The fast model hears only English.
    [{ speechModel: "v3", languages: ["en", "de"] }, false],
    [{ speechModel: "fast", languages: ["en"] }, false],
    // Already moved: never picked again.
    [{ speechModel: "fast", speechModelPicked: "machine", languages: ["en"] }, false],
  ] as const)("%j: %s", (settings, picks) => {
    expect(machinePicksFast(settings, "4 logical cores")).toBe(picks);
    expect(machinePicksFast(settings, null)).toBe(false);
  });
});

describe("his personal model", () => {
  const put = (manifest: unknown, file = "mine.gguf", data = bytes) => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, file), data);
    NodeFS.writeFileSync(NodePath.join(dir, "manifest.json"), JSON.stringify(manifest));
    return dir;
  };

  it("is offered only when the file matches its manifest, and never deleted when it does not", async () => {
    const ok = put({ name: "mine.gguf", size: bytes.length, sha256: good });
    expect(await verifyPersonalModel(ok)).toEqual({
      ok: true,
      path: NodePath.join(ok, "mine.gguf"),
    });
    const bad = put({ name: "mine.gguf", size: bytes.length, sha256: "0".repeat(64) });
    expect(await verifyPersonalModel(bad)).toEqual({ ok: false, why: "checksum" });
    expect(NodeFS.existsSync(NodePath.join(bad, "mine.gguf"))).toBe(true);
    expect(await verifyPersonalModel(put({ name: "mine.gguf", size: 1, sha256: good }))).toEqual({
      ok: false,
      why: "size",
    });
    expect(await verifyPersonalModel(tempDir())).toEqual({ ok: false, why: "none" });
  });

  it("refuses a manifest that points outside its folder or is not a model", async () => {
    for (const name of ["../mine.gguf", "mine.bin", 7])
      expect(await verifyPersonalModel(put({ name, size: bytes.length, sha256: good }))).toEqual({
        ok: false,
        why: "manifest",
      });
  });
});
