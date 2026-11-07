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
    // [logical cores, memory, warm-up ms, the reason it is weak (null: it is not)]
    // His laptop (i7-8550U, 16 GB): starts measured 1-14 s.
    [8, 15.8 * GB, 13_602, null],
    [8, 15.8 * GB, undefined, null],
    [4, 15.8 * GB, undefined, "4 cores"],
    [2, 7.8 * GB, undefined, "2 cores"],
    [8, 7.8 * GB, undefined, "8 GB of memory"],
    [8, 15.8 * GB, 45_000, "a 45 s start"],
  ] as const)("%i cores, %d bytes, %o ms: %o", (cpus, memoryBytes, warmMs, reason) => {
    expect(weakMachine({ cpus, memoryBytes, warmMs })).toBe(reason);
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
  ] as const)("%j: %s", (settings, picks) => {
    expect(machinePicksFast(settings, "4 cores")).toBe(picks);
    expect(machinePicksFast(settings, null)).toBe(false);
  });
});
