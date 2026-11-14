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
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
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

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const userdata = NodePath.dirname(config.dbPath);
  const pack = NodePath.join(userdata, PACK_DIR_NAME);
  const storeFile = NodePath.join(pack, "wake-models.json");
  const askedDir = NodePath.join(pack, "wake-requests");
  const modelFile = (word: string, version: number, target: WakeTarget) =>
    NodePath.join(pack, "wake", word, String(version), `${target}.bin`);
  const keyFile = NodePath.join(config.secretsDir, "wake-model-key.pem");
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

  return TessayaWake.of({
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
