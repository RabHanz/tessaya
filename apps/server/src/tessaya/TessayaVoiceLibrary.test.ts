// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { VoiceClip, VoiceLibraryView } from "@t3tools/tessaya-contracts";
import { pronounce } from "@t3tools/tessaya-shared/pronounce";
import { PREVIEW_LINE } from "@t3tools/tessaya-shared/voiceLibrary";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as TessayaVoiceLibrary from "./TessayaVoiceLibrary.ts";

const memorySecrets = () => {
  const kept = new Map<string, Uint8Array>();
  return Layer.succeed(
    ServerSecretStore,
    ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(kept.get(name))),
      set: (name, value) => Effect.sync(() => void kept.set(name, value)),
      create: (name, value) => Effect.sync(() => void kept.set(name, value)),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: (name) => Effect.sync(() => void kept.delete(name)),
    }),
  );
};

const withLibrary = <A, E>(
  body: (userdata: string) => Effect.Effect<A, E, TessayaVoiceLibrary.TessayaVoiceLibrary>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-voice-library-" });
    const { stateDir } = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), base)),
    );
    return yield* body(stateDir).pipe(
      Effect.provide(
        TessayaVoiceLibrary.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), base)),
          Layer.provide(memorySecrets()),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const call = (kind: "read" | "act", op: string, args: Record<string, unknown> = {}) =>
  TessayaVoiceLibrary.serveVoiceCall({ kind, op, args });

it.layer(NodeServices.layer)("the voice library a server serves", (it) => {
  it.effect("lists every voice, cloud voices only once a Google key is saved", () =>
    withLibrary(() =>
      Effect.gen(function* () {
        const before = (yield* call("read", "library")).value as VoiceLibraryView;
        assert.strictEqual(before.pocket.length, 27);
        assert.strictEqual(before.cloud, null);
        assert.deepStrictEqual(before.previews, { pocket: false, cloud: false });
        assert.strictEqual(
          before.pocket.find((v) => v.id === "jean")?.licenceLabel,
          "Personal use",
        );
        assert.isTrue((yield* call("act", "setGoogleKey", { key: "  test-key  " })).ok);
        const after = (yield* call("read", "library")).value as VoiceLibraryView;
        assert.strictEqual(after.cloud?.length, 116);
        assert.isTrue(after.previews.cloud);
      }),
    ),
  );

  it.effect("writes a persona's voices into his own pack file and reads them back", () =>
    withLibrary((userdata) =>
      Effect.gen(function* () {
        assert.isTrue(
          (yield* call("act", "setPersona", {
            persona: "companion",
            engine: "pocket",
            voice: "jane",
          })).ok,
        );
        assert.isTrue(
          (yield* call("act", "setPersona", {
            persona: "companion",
            engine: "gemini",
            voice: "en-gb-assistant-1",
          })).ok,
        );
        const file = NodeFS.readFileSync(
          NodePath.join(userdata, "operating-system", "roles", "companion.md"),
          "utf8",
        );
        expect(file).toMatch(/^voice: jane$/m);
        expect(file).toMatch(/^cloud voice: en-gb-assistant-1$/m);
        const freya = ((yield* call("read", "library")).value as VoiceLibraryView).personas.find(
          (p) => p.name === "Freya",
        );
        assert.deepStrictEqual(
          { voice: freya?.voice, cloud: freya?.cloudVoice, speaks: freya?.speaks },
          { voice: "jane", cloud: "en-gb-assistant-1", speaks: "jane" },
        );
        const refused = yield* call("act", "setPersona", {
          persona: "companion",
          engine: "pocket",
          voice: "nobody",
        });
        assert.deepStrictEqual(refused, { ok: false, error: "That voice is not in the library." });
        assert.isFalse(
          (yield* call("act", "setPersona", { persona: "../x", engine: "pocket", voice: null })).ok,
        );
      }),
    ),
  );

  it.effect("answers a preview from its cache, and says plainly when Pocket is not here", () =>
    withLibrary((userdata) =>
      Effect.gen(function* () {
        const missing = yield* call("read", "preview", { engine: "pocket", voice: "anna" });
        assert.deepStrictEqual(missing, {
          ok: false,
          error: "Tessaya's voice is not installed on this machine.",
        });
        // Once made, a preview comes from the cache: here Pocket is absent and the cached clip still plays.
        const line = pronounce(PREVIEW_LINE);
        const hash = NodeCrypto.createHash("sha256").update(line).digest("hex").slice(0, 10);
        const previews = NodePath.join(userdata, "voice", "previews");
        NodeFS.mkdirSync(previews, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(previews, `pocket-anna-${hash}.wav`), "RIFF-cached");
        const cached = yield* call("read", "preview", { engine: "pocket", voice: "anna" });
        assert.isTrue(cached.ok);
        assert.strictEqual(
          Buffer.from((cached.value as VoiceClip).base64, "base64").toString(),
          "RIFF-cached",
        );
        assert.isFalse((yield* call("read", "preview", { engine: "pocket", voice: "nobody" })).ok);
      }),
    ),
  );
});

describe("the preview cache", () => {
  it.effect("makes a clip once, then serves it from disk; a failed make leaves nothing", () =>
    Effect.promise(async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-voice-cache-"));
      const file = NodePath.join(dir, "previews", "pocket-anna.wav");
      let made = 0;
      const make = async () => {
        made += 1;
        return Buffer.from("RIFF-one");
      };
      expect((await TessayaVoiceLibrary.cachedClip(file, make)).toString()).toBe("RIFF-one");
      expect((await TessayaVoiceLibrary.cachedClip(file, make)).toString()).toBe("RIFF-one");
      expect(made).toBe(1);
      const other = NodePath.join(dir, "previews", "pocket-eve.wav");
      await expect(
        TessayaVoiceLibrary.cachedClip(other, async () => {
          throw new Error("no");
        }),
      ).rejects.toThrow("no");
      expect(NodeFS.readdirSync(NodePath.join(dir, "previews"))).toEqual(["pocket-anna.wav"]);
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }),
  );

  it.effect("reads Gemini's audio whether it comes as a WAV or as bare PCM", () =>
    Effect.sync(() => {
      const pcm = Buffer.alloc(100);
      const bare = TessayaVoiceLibrary.geminiAudio({
        steps: [{ content: [{ type: "audio", data: pcm.toString("base64") }] }],
      }) as Buffer;
      expect(bare.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(bare.readUInt32LE(24)).toBe(24_000);
      expect(bare.length).toBe(144);
      expect(TessayaVoiceLibrary.geminiAudio({ steps: [] })).toBeNull();
    }),
  );
});
