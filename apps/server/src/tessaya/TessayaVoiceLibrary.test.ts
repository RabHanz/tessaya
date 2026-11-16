// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { dialsOf } from "@t3tools/tessaya-shared/affect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { VoiceClip, VoiceLibraryView } from "@t3tools/tessaya-contracts";
import { cloneGrant, withGrant } from "@t3tools/tessaya-shared/consent";
import { pronounce } from "@t3tools/tessaya-shared/pronounce";
import { PREVIEW_LINE } from "@t3tools/tessaya-shared/voiceLibrary";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { BrainUsage, type UsageRow } from "./BrainUsage.ts";
import { Consent } from "./consent.ts";
import { TessayaExpression } from "./TessayaExpression.ts";
import { TessayaMood } from "./TessayaMood.ts";
import * as TessayaVoiceLibrary from "./TessayaVoiceLibrary.ts";
import { writeWav } from "./voiceClip.ts";

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

/** The one consent store, in memory: what cloning records and what speaking in a clone checks. */
const memoryConsent = (keys: Array<string>) =>
  Layer.succeed(
    Consent,
    Consent.of({
      read: Effect.sync(() => [...keys]),
      set: (key, allow) =>
        Effect.sync(() => {
          const next = withGrant(keys, key, allow);
          keys.splice(0, keys.length, ...next);
          return next;
        }),
    }),
  );

const withLibrary = <A, E>(
  body: (userdata: string) => Effect.Effect<A, E, TessayaVoiceLibrary.TessayaVoiceLibrary>,
  grants: Array<string> = [],
  rows: Array<UsageRow> = [],
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
          Layer.provide(memoryConsent(grants)),
          Layer.provide(
            Layer.mock(BrainUsage)({ record: (row) => Effect.sync(() => void rows.push(row)) }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const call = (kind: "read" | "act" | "owner", op: string, args: Record<string, unknown> = {}) =>
  TessayaVoiceLibrary.serveVoiceCall({ kind, op, args });

it.layer(NodeServices.layer)("the voice library a server serves", (it) => {
  it.effect("records each cloud line the Google key paid for, with its tokens", () => {
    const rows: Array<UsageRow> = [];
    return withLibrary(
      () =>
        Effect.gen(function* () {
          assert.isTrue((yield* call("act", "setGoogleKey", { key: "test-key" })).ok);
          const reply = {
            steps: [{ content: [{ type: "audio", data: Buffer.alloc(100).toString("base64") }] }],
            usage: { total_input_tokens: 12, total_output_tokens: 300 },
          };
          using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(reply));
          assert.isTrue(
            (yield* call("act", "say", { engine: "gemini", voice: "en-gb-advisor-1", text: "Hi." }))
              .ok,
          );
          expect(rows).toEqual([
            expect.objectContaining({
              role: "speech",
              provider: "google",
              billing: "apiKey",
              input: 12,
              output: 300,
              attribution: { feature: "voice-cloud", origin: "user" },
            }),
          ]);
        }),
      [],
      rows,
    );
  });

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

  it.effect(
    "words a vessel's moment through the one expression service, in the persona asked",
    () =>
      withLibrary(() =>
        Effect.gen(function* () {
          const asked: Array<unknown> = [];
          const lines = Layer.succeed(TessayaExpression, {
            express: (event, input) =>
              Effect.sync(() => {
                asked.push([event, input?.persona]);
                return {
                  event,
                  persona: input?.persona ?? "executive",
                  text: "Gently, if you please.",
                  mood: "surprised" as const,
                  gesture: "giggleOnce" as const,
                  intensity: 0.4,
                  priority: "ambient" as const,
                  source: "cache" as const,
                  lineId: "x",
                };
              }),
            ahead: () => Effect.succeed({ on: false, lines: {} }),
            writeAhead: () => Effect.succeed(0),
          });
          const said = yield* call("act", "express", {
            event: "moment.poked",
            persona: "butler",
          }).pipe(Effect.provide(lines));
          assert.deepStrictEqual(asked, [["moment.poked", "butler"]]);
          assert.strictEqual((said.value as { text: string }).text, "Gently, if you please.");
          // Not one of her moments, and a server without the service, say nothing.
          assert.isFalse(
            (yield* call("act", "express", { event: "rm -rf" }).pipe(Effect.provide(lines))).ok,
          );
          assert.deepStrictEqual(yield* call("act", "express", { event: "moment.poked" }), {
            ok: true,
            value: null,
          });
        }),
      ),
  );

  it.effect(
    "tells a vessel a persona's mood to wear at rest, and nothing without the service",
    () =>
      withLibrary(() =>
        Effect.gen(function* () {
          const asked: Array<string | undefined> = [];
          const mood = Layer.succeed(TessayaMood, {
            view: (persona) =>
              Effect.sync(() => {
                asked.push(persona);
                return {
                  label: "proud" as const,
                  intensity: 0.6,
                  energy: 0.5,
                  awayHours: null,
                  guilt: "off" as const,
                  why: [],
                };
              }),
            note: () => Effect.void,
            hisWords: () => Effect.void,
            heard: () => Effect.void,
            atDevice: () => Effect.die("not asked"),
            inner: () =>
              Effect.succeed({
                general: {
                  label: "neutral" as const,
                  intensity: 0,
                  energy: 0.8,
                  awayHours: null,
                  guilt: "off" as const,
                  why: [],
                },
                people: [],
                dials: dialsOf("butler", 1, undefined),
              }),
            roomView: () => Effect.die("not asked"),
            forget: () => Effect.void,
            reset: () => Effect.void,
            moves: Stream.empty,
            changes: () => Stream.empty,
          });
          const felt = yield* call("read", "mood", { persona: "butler" }).pipe(
            Effect.provide(mood),
          );
          assert.deepStrictEqual(felt, {
            ok: true,
            value: { label: "proud", intensity: 0.6, people: [] },
          });
          assert.deepStrictEqual(asked, ["butler"]);
          assert.deepStrictEqual(yield* call("read", "mood"), { ok: true, value: null });
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

  it.effect("clones only with his consent, from a clean clip, and only by the owner's door", () =>
    withLibrary(() =>
      Effect.gen(function* () {
        const clip = (seconds: number) => {
          const samples = new Int16Array(seconds * 24_000);
          for (let i = 0; i < samples.length; i++)
            samples[i] =
              (i / 24_000) % 0.5 < 0.3 ? Math.round(8_000 * Math.sin(i / 21)) : (i % 7) - 3;
          return Buffer.from(writeWav({ rate: 24_000, samples })).toString("base64");
        };
        const error = (reply: { readonly error?: string }) => reply.error;
        // An act call cannot reach cloning at all.
        assert.isFalse((yield* call("act", "clone", { wav: clip(8), consent: true })).ok);
        expect(error(yield* call("owner", "clone", { wav: clip(8), consent: false }))).toMatch(
          /your voice, or that you have their permission/,
        );
        expect(
          error(yield* call("owner", "clone", { wav: "bm90IGEgd2F2", consent: true })),
        ).toMatch(/16-bit PCM WAV/);
        expect(error(yield* call("owner", "clone", { wav: clip(3), consent: true }))).toMatch(
          /at least 5 seconds/,
        );
        // A good clip on a machine without Pocket says so, and records no consent.
        expect(error(yield* call("owner", "clone", { wav: clip(8), consent: true }))).toMatch(
          /not installed on this machine yet/,
        );
      }),
    ),
  );

  it.effect(
    "speaks in a clone only for the owner and only while his consent stands; routes each engine",
    () => {
      const id = "0b6c1a52-3a0e-4f7e-9d43-5c1a4e1f2b3c";
      const grants: Array<string> = [];
      return withLibrary(
        (userdata) =>
          Effect.gen(function* () {
            const say = (kind: "act" | "owner", args: Record<string, unknown>) =>
              Effect.map(call(kind, "say", { text: "Hello there.", ...args }), (r) => r.error);
            assert.strictEqual(
              yield* say("act", { engine: "clone", voice: id }),
              "Only the owner can speak in a cloned voice.",
            );
            assert.strictEqual(
              yield* say("owner", { engine: "clone", voice: "../../secrets" }),
              "There is no clone by that name.",
            );
            const clones = NodePath.join(userdata, "voice", "clones");
            NodeFS.mkdirSync(clones, { recursive: true });
            NodeFS.writeFileSync(NodePath.join(clones, `${id}.safetensors`), "embedding");
            NodeFS.writeFileSync(
              NodePath.join(clones, `${id}.json`),
              JSON.stringify({ id, name: "Me", createdAt: "2026-11-16T01:00:00.000Z" }),
            );
            assert.strictEqual(
              yield* say("owner", { engine: "clone", voice: id }),
              "The consent for that clone was withdrawn.",
            );
            const library = () =>
              Effect.map(call("read", "library"), (r) => (r.value as VoiceLibraryView).clones);
            assert.deepStrictEqual(yield* library(), []);
            grants.push(cloneGrant(id));
            assert.deepStrictEqual(
              (yield* library())?.map((c) => c.name),
              ["Me"],
            );
            // With consent it goes to Pocket, which this machine lacks.
            assert.strictEqual(
              yield* say("owner", { engine: "clone", voice: id }),
              "Tessaya's voice is not installed here.",
            );
            assert.strictEqual(
              yield* say("act", { engine: "pocket", voice: "anna" }),
              "Tessaya's voice is not installed on this machine.",
            );
            assert.strictEqual(
              yield* say("act", { engine: "pocket", voice: "nobody" }),
              "That voice is not in the library.",
            );
            // No engine is the desktop speaker's cloud voice, as before.
            expect(yield* say("act", { voice: "en-gb-advisor-1" })).toMatch(/Save a Google key/);
            // Deleting the clone removes its files and its consent.
            assert.isTrue((yield* call("owner", "deleteClone", { id })).ok);
            assert.deepStrictEqual(grants, []);
            assert.deepStrictEqual(NodeFS.readdirSync(clones), []);
          }),
        grants,
      );
    },
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
