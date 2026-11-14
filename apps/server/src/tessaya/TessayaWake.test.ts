// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { wakeSignatureOk } from "@t3tools/baton-shared/wakeModels";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { PACK_DIR_NAME } from "../baton/OperatingSystemPack.ts";
import { MemberPreferences } from "../baton/MemberPreferences.ts";
import * as TessayaWake from "./TessayaWake.ts";
import { wakeAccess } from "./TessayaWakeRoutes.ts";

const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-wake-" }).pipe(
  Layer.provide(NodeServices.layer),
);
const sha = (b: Uint8Array) => NodeCrypto.createHash("sha256").update(b).digest("hex");

it.effect(
  "a renamed persona's word is trained, uploaded, signed here and served; then rolled back or cancelled",
  () =>
    Effect.gen(function* () {
      const { dbPath } = yield* ServerConfig.ServerConfig;
      const roles = NodePath.join(NodePath.dirname(dbPath), PACK_DIR_NAME, "roles");
      NodeFS.mkdirSync(roles, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(roles, "nova.md"),
        "---\nname: Nova\nwake: Nova\nvoice: eve\n---\nbrief",
      );
      const wake = yield* TessayaWake.TessayaWake;
      expect((yield* wake.requests).map((r) => [r.word, r.reason])).toEqual([["nova", "new"]]);
      expect(
        yield* wake.status({ word: "nova", version: 1, status: "training" }, "kaggle-1"),
      ).toEqual({ ok: true });
      expect(yield* wake.requests).toEqual([]);
      const bytes = new TextEncoder().encode("model-bytes");
      const artifacts = [
        {
          target: "room" as const,
          format: "openwakeword-onnx" as const,
          sha256: sha(bytes),
          threshold: 0.9,
        },
      ];
      expect(
        yield* wake.status(
          { word: "nova", version: 1, status: "trained", eval: { barMet: true }, artifacts },
          "kaggle-2",
        ),
      ).toEqual({ refused: "Another trainer has this word." });
      yield* wake.status(
        { word: "nova", version: 1, status: "trained", eval: { barMet: true }, artifacts },
        "kaggle-1",
      );
      expect(yield* wake.upload("nova", 1, "room", new TextEncoder().encode("other"))).toEqual({
        refused: "The bytes do not match the reported sha256.",
      });
      expect(yield* wake.upload("nova", 1, "room", bytes)).toEqual({ current: true });
      const served = (yield* wake.model("nova", "room"))!;
      expect(served.version).toBe(1);
      expect(wakeSignatureOk(yield* wake.publicKey, "nova", 1, served.artifact, served.bytes)).toBe(
        true,
      );
      expect(yield* wake.rollback("nova", 9)).toEqual({ refused: "That version is not kept." });
      expect(yield* wake.cancel("nova")).toEqual({ ok: true });
      expect(
        yield* wake.status({ word: "nova", version: 2, status: "training" }, "kaggle-1"),
      ).toEqual({
        refused: "He cancelled training for this word.",
      });
      const nova = (yield* wake.overview) as ReadonlyArray<{ word: string }>;
      expect(nova.find((w) => w.word === "nova")).toMatchObject({
        personaId: "nova",
        model: "trained",
        current: 1,
        cancelled: true,
        versions: [{ version: 1, status: "trained", barMet: true, signed: true }],
      });
      // The way back from a cancel: asked for again, and a trainer may take it.
      expect(yield* wake.retrain("nova")).toEqual({ ok: true });
      expect((yield* wake.requests).map((r) => [r.word, r.reason])).toEqual([["nova", "retrain"]]);
      expect(
        yield* wake.status({ word: "nova", version: 2, status: "training" }, "kaggle-1"),
      ).toEqual({ ok: true });
      expect(yield* wake.retrain("zed")).toEqual({ refused: "No persona answers to that word." });
    }).pipe(Effect.provide(TessayaWake.layer.pipe(Layer.provideMerge(config)))),
);

it("lets only the trainer train, any paired vessel or R1 fetch, and a settings writer roll back or cancel", () => {
  const trainer = new Set(["tessaya:wake-trainer"]);
  const owner = new Set(["settings:write", "orchestration:read"]);
  const vessel = new Set(["orchestration:read"]);
  for (const route of ["GET requests", "POST status", "PUT models", "GET voices"]) {
    expect(wakeAccess(route, trainer, false)).toBeNull();
    expect(wakeAccess(route, owner, false)?.status).toBe(403);
    expect(wakeAccess(route, null, true)?.status).toBe(403);
  }
  expect(wakeAccess("GET models", null, false)?.status).toBe(401);
  expect(wakeAccess("GET models", null, true)).toBeNull();
  expect(wakeAccess("GET models", vessel, false)).toBeNull();
  expect(wakeAccess("GET status", vessel, false)).toBeNull();
  expect(wakeAccess("GET status", null, false)?.status).toBe(401);
  // Enrolment audio: an R1's, or a session that may change settings (his desktop); never a plain vessel's.
  expect(wakeAccess("POST enrolment", null, true)).toBeNull();
  expect(wakeAccess("POST enrolment", owner, false)).toBeNull();
  expect(wakeAccess("POST enrolment", vessel, false)?.status).toBe(401);
  for (const route of ["POST rollback", "POST cancel", "POST retrain"]) {
    expect(wakeAccess(route, owner, false)).toBeNull();
    expect(wakeAccess(route, vessel, false)?.status).toBe(403);
    expect(wakeAccess(route, trainer, false)?.status).toBe(403);
  }
  expect(wakeAccess("GET key", null, false)).toBeNull();
});

it.effect(
  "keeps enrolment audio only while that member's switch is on: on for the owner, opt-in for others, deleted when off",
  () => {
    const prefs = new Map<string, Record<string, string>>();
    let told: (member: string) => Effect.Effect<void> = () => Effect.void;
    const preferences = Layer.mock(MemberPreferences)({
      of: (member: string) => Effect.succeed(prefs.get(member) ?? {}),
      listen: (listener) => Effect.sync(() => void (told = (m) => listener(m, null))),
    });
    return Effect.gen(function* () {
      const wake = yield* TessayaWake.TessayaWake;
      const speech = [Int16Array.from({ length: 16_000 }, (_, i) => i % 300)];
      // The owner is on until he says off; Maya is off until she says on.
      expect(yield* wake.keepEnrolment("owner", speech)).toEqual({ kept: 1 });
      expect(yield* wake.keepEnrolment("maya", speech)).toEqual({ kept: 0 });
      expect(yield* wake.voices("maya")).toEqual({
        refused: "That member has not agreed to their voice being used for training.",
      });
      prefs.set("maya", { wakeTraining: "yes, use my voice" });
      yield* wake.keepEnrolment("maya", speech);
      const hers = yield* wake.voices("maya");
      expect("clips" in hers && hers.clips.map((c) => c.ms)).toEqual([1000]);
      const his = yield* wake.voices("owner");
      if (!("clips" in his)) throw new Error("the owner's clips should be listed");
      const wav = (yield* wake.voiceClip("owner", his.clips[0]!.id)) as Uint8Array;
      expect([new TextDecoder().decode(wav.slice(0, 4)), wav.byteLength]).toEqual([
        "RIFF",
        44 + 32_000,
      ]);
      // His switch goes off: refused at once, and the audio is gone, not just hidden.
      prefs.set("owner", { wakeTraining: "off" });
      yield* told("owner");
      expect("refused" in (yield* wake.voices("owner"))).toBe(true);
      prefs.set("owner", { wakeTraining: "on" });
      expect(yield* wake.voices("owner")).toEqual({ personId: "owner", consent: true, clips: [] });
    }).pipe(
      Effect.provide(
        TessayaWake.layer.pipe(Layer.provideMerge(config), Layer.provide(preferences)),
      ),
    );
  },
);
