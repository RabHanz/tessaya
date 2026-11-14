// @effect-diagnostics nodeBuiltinImport:off
/**
 * Her wake-word models (tessaya-ops research/WAKE-AUTOTRAIN-DESIGN.md, "Interface with the spine (P3b)"): the trainer's
 * requests from the persona registry, its reports and uploads, her server's signature over each model that met its
 * bar, and the way back (rollback, cancel). The trainer never holds a key; vessels load only what this server signed.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  acceptWakeUpload,
  applyWakeStatus,
  cancelWake,
  EMPTY_WAKE_STORE,
  parseWakeStore,
  rollbackWake,
  wakeKey,
  wakeRequests,
  WAKE_TARGETS,
  type WakeArtifact,
  type WakeRequest,
  type WakeStatus,
  type WakeStore,
  type WakeTarget,
} from "@t3tools/baton-shared/wakeModels";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { wakeTrainingOn } from "@t3tools/baton-shared/household";

import * as ServerConfig from "../config.ts";
import { MemberPreferences } from "../baton/MemberPreferences.ts";
import { PACK_DIR_NAME, readPack } from "../baton/OperatingSystemPack.ts";

export type Refused = { readonly refused: string };

export class TessayaWake extends Context.Service<
  TessayaWake,
  {
    /** What the trainer should train now; the store notes each persona's word so a rename is seen once. */
    readonly requests: Effect.Effect<ReadonlyArray<WakeRequest>>;
    readonly store: Effect.Effect<WakeStore>;
    readonly status: (
      input: WakeStatus,
      trainerId: string,
    ) => Effect.Effect<Refused | { ok: true }>;
    readonly upload: (
      word: string,
      version: number,
      target: WakeTarget,
      bytes: Uint8Array,
    ) => Effect.Effect<Refused | { readonly current: boolean }>;
    /** The current signed model for a target, with what a vessel needs to check it. */
    readonly model: (
      word: string,
      target: WakeTarget,
    ) => Effect.Effect<{
      readonly version: number;
      readonly artifact: WakeArtifact;
      readonly bytes: Uint8Array;
    } | null>;
    /** The public half of her signing key, for vessels to check models with. */
    readonly publicKey: Effect.Effect<string>;
    readonly rollback: (word: string, version: number) => Effect.Effect<Refused | { ok: true }>;
    readonly cancel: (word: string) => Effect.Effect<Refused | { ok: true }>;
    /** A member's kept enrolment clips, only while their wakeTraining switch is on (checked on every call). */
    readonly voices: (personId: string) => Effect.Effect<
      | Refused
      | {
          readonly personId: string;
          readonly consent: true;
          readonly clips: ReadonlyArray<{ readonly id: string; readonly ms: number }>;
        }
    >;
    /** One clip as a 16 kHz mono PCM16 WAV; null when there is no such clip. */
    readonly voiceClip: (
      personId: string,
      clipId: string,
    ) => Effect.Effect<Refused | Uint8Array | null>;
    /** Enrolment audio (16 kHz PCM16) kept for training, only with that member's switch on. */
    readonly keepEnrolment: (
      personId: string,
      clips: ReadonlyArray<Int16Array>,
    ) => Effect.Effect<{ readonly kept: number }>;
  }
>()("t3/tessaya/TessayaWake") {}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const writeFile = (file: string, body: string | Uint8Array, mode = 0o644) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, body, { mode });
  NodeFS.renameSync(tmp, file);
};

const RATE = 16_000;
const PERSON = /^[\w-]{1,60}$/;
const CLIP = /^[0-9a-f]{16}$/;

/** 16 kHz mono PCM16 as a WAV file. */
const wavOf = (pcm: Uint8Array): Uint8Array => {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const userdata = NodePath.dirname(config.dbPath);
  const pack = NodePath.join(userdata, PACK_DIR_NAME);
  const storeFile = NodePath.join(pack, "wake-models.json");
  const askedDir = NodePath.join(pack, "wake-requests");
  const modelFile = (word: string, version: number, target: WakeTarget) =>
    NodePath.join(pack, "wake", word, String(version), `${target}.bin`);
  const keyFile = NodePath.join(config.secretsDir, "wake-model-key.pem");
  const voicesDir = (personId: string) => NodePath.join(userdata, "wake-voices", personId);
  const prefs = yield* Effect.serviceOption(MemberPreferences);
  const consented = (personId: string) =>
    Option.isNone(prefs)
      ? Effect.succeed(false)
      : Effect.map(prefs.value.of(personId), (p) => wakeTrainingOn(personId, p.wakeTraining));
  const forgetVoices = (personId: string) =>
    Effect.sync(() => NodeFS.rmSync(voicesDir(personId), { recursive: true, force: true }));
  // His switch going off deletes the audio at once, not at the next training job.
  if (Option.isSome(prefs))
    yield* prefs.value.listen((member) =>
      PERSON.test(member)
        ? Effect.flatMap(consented(member), (on) => (on ? Effect.void : forgetVoices(member)))
        : Effect.void,
    );
  const noConsent: Refused = {
    refused: "That member has not agreed to their voice being used for training.",
  };
  // One writer at a time: a report and an upload for the same word must not lose each other's change.
  const lock = yield* Semaphore.make(1);

  const load = () => parseWakeStore(readJson(storeFile) ?? EMPTY_WAKE_STORE);
  const save = (store: WakeStore) => writeFile(storeFile, `${JSON.stringify(store, null, 2)}\n`);
  const privateKey = () => {
    if (!NodeFS.existsSync(keyFile)) {
      const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 0o600);
    }
    return NodeCrypto.createPrivateKey(NodeFS.readFileSync(keyFile, "utf8"));
  };
  const sign = (data: string) =>
    NodeCrypto.sign("sha256", Buffer.from(data), privateKey()).toString("base64");
  const asked = (): ReadonlyArray<WakeRequest> => {
    let names: string[] = [];
    try {
      names = NodeFS.readdirSync(askedDir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    return names.flatMap((n) => {
      const r = readJson(NodePath.join(askedDir, n)) as Partial<WakeRequest> | null;
      const word = typeof r?.word === "string" ? wakeKey(r.word) : null;
      const reason = r?.reason;
      return word === null ||
        (reason !== "new" && reason !== "rename" && reason !== "retrain" && reason !== "real-data")
        ? []
        : [
            {
              word,
              personaId: typeof r?.personaId === "string" ? r.personaId : "",
              previous: typeof r?.previous === "string" ? r.previous : null,
              requestedAt: typeof r?.requestedAt === "number" ? r.requestedAt : 0,
              reason,
            },
          ];
    });
  };
  const locked = <A>(f: (now: number) => A) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Effect.sync(() => f(now))),
      lock.withPermits(1),
    );

  const requests = locked((now) => {
    const found = wakeRequests(readPack(userdata).personas, load(), asked(), now);
    save(found.store);
    // Each request is also a file, so another reader (the ML lane's watcher) sees the same list.
    for (const r of found.requests)
      writeFile(NodePath.join(askedDir, `${r.word}.json`), `${JSON.stringify(r)}\n`);
    return found.requests;
  }).pipe(Effect.withSpan("TessayaWake.requests"));

  const status = Effect.fn("TessayaWake.status")(function* (input: WakeStatus, trainerId: string) {
    return yield* locked((now): Refused | { ok: true } => {
      const done = applyWakeStatus(load(), input, trainerId, now);
      if ("refused" in done) return done;
      save(done.store);
      return { ok: true };
    });
  });

  const upload = Effect.fn("TessayaWake.upload")(function* (
    word: string,
    version: number,
    target: WakeTarget,
    bytes: Uint8Array,
  ) {
    return yield* locked((): Refused | { readonly current: boolean } => {
      const k = wakeKey(word);
      if (k === null || !WAKE_TARGETS.includes(target)) return { refused: "No such model." };
      const sha = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const done = acceptWakeUpload(load(), k, version, target, sha, sign);
      if ("refused" in done) return done;
      writeFile(modelFile(k, version, target), bytes);
      save(done.store);
      for (const v of done.dropped)
        NodeFS.rmSync(NodePath.join(pack, "wake", k, String(v)), { recursive: true, force: true });
      if (done.current) NodeFS.rmSync(NodePath.join(askedDir, `${k}.json`), { force: true });
      return { current: done.current };
    });
  });

  const model = Effect.fn("TessayaWake.model")(function* (word: string, target: WakeTarget) {
    const k = wakeKey(word);
    if (k === null) return null;
    const r = load().words[k];
    const v = r?.versions.find((x) => x.version === r.current);
    const artifact = v?.artifacts.find((a) => a.target === target && a.signature !== undefined);
    if (v === undefined || artifact === undefined) return null;
    const bytes = yield* Effect.sync(() => {
      try {
        return new Uint8Array(NodeFS.readFileSync(modelFile(k, v.version, target)));
      } catch {
        return null;
      }
    });
    return bytes === null ? null : { version: v.version, artifact, bytes };
  });

  const publicKey = Effect.sync(() =>
    NodeCrypto.createPublicKey(privateKey()).export({ type: "spki", format: "pem" }).toString(),
  ).pipe(lock.withPermits(1), Effect.withSpan("TessayaWake.publicKey"));

  const rollback = Effect.fn("TessayaWake.rollback")(function* (word: string, version: number) {
    return yield* locked((): Refused | { ok: true } => {
      const k = wakeKey(word);
      if (k === null) return { refused: "That is not a wake word." };
      const done = rollbackWake(load(), k, version);
      if ("refused" in done) return done;
      save(done.store);
      return { ok: true };
    });
  });

  const cancel = Effect.fn("TessayaWake.cancel")(function* (word: string) {
    return yield* locked((): Refused | { ok: true } => {
      const k = wakeKey(word);
      if (k === null) return { refused: "That is not a wake word." };
      save(cancelWake(load(), k));
      NodeFS.rmSync(NodePath.join(askedDir, `${k}.json`), { force: true });
      return { ok: true };
    });
  });

  const voices = Effect.fn("TessayaWake.voices")(function* (personId: string) {
    if (!PERSON.test(personId) || !(yield* consented(personId))) return noConsent;
    const clips = yield* Effect.sync(() => {
      try {
        return NodeFS.readdirSync(voicesDir(personId))
          .filter((n) => CLIP.test(n.replace(/\.pcm$/, "")) && n.endsWith(".pcm"))
          .map((n) => ({
            id: n.slice(0, -4),
            ms: Math.round(
              (NodeFS.statSync(NodePath.join(voicesDir(personId), n)).size / 2 / RATE) * 1000,
            ),
          }));
      } catch {
        return [];
      }
    });
    return { personId, consent: true as const, clips };
  });

  const voiceClip = Effect.fn("TessayaWake.voiceClip")(function* (
    personId: string,
    clipId: string,
  ) {
    if (!PERSON.test(personId) || !(yield* consented(personId))) return noConsent;
    if (!CLIP.test(clipId)) return null;
    return yield* Effect.sync(() => {
      try {
        return wavOf(
          new Uint8Array(NodeFS.readFileSync(NodePath.join(voicesDir(personId), `${clipId}.pcm`))),
        );
      } catch {
        return null;
      }
    });
  });

  const keepEnrolment = Effect.fn("TessayaWake.keepEnrolment")(function* (
    personId: string,
    clips: ReadonlyArray<Int16Array>,
  ) {
    if (!PERSON.test(personId) || !(yield* consented(personId))) return { kept: 0 };
    return yield* Effect.sync(() => {
      for (const pcm of clips)
        writeFile(
          NodePath.join(voicesDir(personId), `${NodeCrypto.randomBytes(8).toString("hex")}.pcm`),
          new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
          0o600,
        );
      return { kept: clips.length };
    });
  });

  return TessayaWake.of({
    voices,
    voiceClip,
    keepEnrolment,
    requests,
    store: Effect.sync(load),
    status,
    upload,
    model,
    publicKey,
    rollback,
    cancel,
  });
});

export const layer = Layer.effect(TessayaWake, make);
