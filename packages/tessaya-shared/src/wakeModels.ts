// @effect-diagnostics nodeBuiltinImport:off
/**
 * Wake-word models per persona (tessaya-ops research/WAKE-AUTOTRAIN-DESIGN.md, "Interface with the spine (P3b)"): what
 * her server keeps in `wake-models.json`, the trainer's requests and reports, and the signature every vessel checks
 * before it loads a model. Pure, so the server, the room loop and the desktop share one reading.
 */
import * as NodeCrypto from "node:crypto";

export const WAKE_TARGETS = ["room", "desktop", "r1"] as const;
export type WakeTarget = (typeof WAKE_TARGETS)[number];
export const WAKE_FORMATS = ["openwakeword-onnx", "kws-dscnn-int8", "r1-kws-pack"] as const;
export type WakeFormat = (typeof WAKE_FORMATS)[number];
export type WakeReason = "new" | "rename" | "retrain" | "real-data";
export type WakeModel = "trained" | "training" | "none";

export interface WakeArtifact {
  readonly target: WakeTarget;
  readonly format: WakeFormat;
  readonly sha256: string;
  readonly threshold: number;
  /** Her server's ECDSA signature over `wakeSigned(...)`, once the bytes matched and the bar was met. */
  readonly signature?: string;
}

export interface WakeVersion {
  readonly version: number;
  readonly status: "trained" | "rejected" | "failed";
  readonly reason?: string;
  /** The trainer's numbers, kept as sent for Settings (`barMet`, `provisional`, per-set rates). */
  readonly eval: Readonly<Record<string, unknown>>;
  readonly artifacts: ReadonlyArray<WakeArtifact>;
  readonly at: number;
}

export interface WakeRecord {
  /** The version vessels load; null until one is signed, or after a cancel. */
  readonly current: number | null;
  readonly claim?: { readonly trainerId: string; readonly at: number };
  /** He stopped training this word: no request is offered until the name changes again. */
  readonly cancelled?: boolean;
  readonly versions: ReadonlyArray<WakeVersion>;
}

export interface WakeStore {
  readonly words: Readonly<Record<string, WakeRecord>>;
  /** Each persona's wake word when last seen, so a rename is noticed and asked for under the new name. */
  readonly personas: Readonly<Record<string, string>>;
}

export interface WakeRequest {
  readonly word: string;
  readonly personaId: string;
  readonly previous: string | null;
  readonly requestedAt: number;
  readonly reason: WakeReason;
}

export const CLAIM_LAPSE_MS = 6 * 60 * 60_000;
export const VERSIONS_KEPT = 3;
/** The words the app ships trained models for (desktop and R1). */
export const SHIPPED_WAKE_WORDS = ["tessaya", "alfred", "freya", "sebastian", "onyx"];

export const EMPTY_WAKE_STORE: WakeStore = { words: {}, personas: {} };
const WORD = /^[a-z][a-z' -]{0,40}$/;
export const wakeKey = (word: string): string | null => {
  const k = word.trim().toLowerCase();
  return WORD.test(k) ? k : null;
};

const live = (claim: WakeRecord["claim"], now: number) =>
  claim !== undefined && now - claim.at < CLAIM_LAPSE_MS;

/** `wake-models.json` as written, anything unreadable left out. */
export const parseWakeStore = (body: unknown): WakeStore => {
  const b = body as Partial<WakeStore> | null;
  const words = typeof b?.words === "object" && b.words !== null ? b.words : {};
  const personas = typeof b?.personas === "object" && b.personas !== null ? b.personas : {};
  return { words, personas };
};

/** Whether a persona's wake word wakes anything yet: shipped, signed by her server, or being trained now. */
export const wakeModelOf = (wake: string | null, store: WakeStore, now: number): WakeModel => {
  const k = wake === null ? null : wakeKey(wake);
  if (k === null) return "none";
  const r = store.words[k];
  if (r?.current != null) return "trained";
  if (r !== undefined && live(r.claim, now)) return "training";
  return SHIPPED_WAKE_WORDS.includes(k) ? "trained" : "none";
};

/**
 * The trainer's work: every persona's word with no model and no live claim, as new or a rename (noticed against the
 * word last seen for that persona), plus the asked-for retrains; and the store with each persona's word as seen now.
 */
export const wakeRequests = (
  personas: ReadonlyArray<{ readonly id: string; readonly wake: string | null }>,
  store: WakeStore,
  asked: ReadonlyArray<WakeRequest>,
  now: number,
): { readonly requests: ReadonlyArray<WakeRequest>; readonly store: WakeStore } => {
  const seen: Record<string, string> = { ...store.personas };
  const words: Record<string, WakeRecord> = { ...store.words };
  const out = new Map<string, WakeRequest>();
  for (const p of personas) {
    const k = p.wake === null ? null : wakeKey(p.wake);
    if (k === null) continue;
    const previous = seen[p.id] ?? null;
    seen[p.id] = k;
    // A new name clears an old cancel: he renamed her, so the new word is wanted.
    if (previous !== null && previous !== k && words[k]?.cancelled === true)
      words[k] = { ...words[k]!, cancelled: false };
    const r = words[k];
    if (wakeModelOf(k, { words, personas: seen }, now) !== "none" || r?.cancelled === true)
      continue;
    out.set(k, {
      word: k,
      personaId: p.id,
      previous: previous !== null && previous !== k ? previous : null,
      requestedAt: now,
      reason: previous !== null && previous !== k ? "rename" : "new",
    });
  }
  for (const a of asked) {
    const r = words[a.word];
    if (r?.cancelled === true || live(r?.claim, now)) continue;
    if (!out.has(a.word)) out.set(a.word, a);
  }
  return { requests: [...out.values()], store: { words, personas: seen } };
};

export interface WakeStatus {
  readonly word: string;
  readonly version: number;
  readonly status: "training" | "trained" | "rejected" | "failed";
  readonly reason?: string;
  readonly eval?: Readonly<Record<string, unknown>>;
  readonly artifacts?: ReadonlyArray<WakeArtifact>;
}

/** A trainer's report applied, or why it is refused. */
export const applyWakeStatus = (
  store: WakeStore,
  s: WakeStatus,
  trainerId: string,
  now: number,
): { readonly store: WakeStore } | { readonly refused: string } => {
  const k = wakeKey(s.word);
  if (k === null) return { refused: "That is not a wake word." };
  const r: WakeRecord = store.words[k] ?? { current: null, versions: [] };
  if (live(r.claim, now) && r.claim!.trainerId !== trainerId)
    return { refused: "Another trainer has this word." };
  if (r.cancelled === true) return { refused: "He cancelled training for this word." };
  const set = (next: WakeRecord): { readonly store: WakeStore } => ({
    store: { ...store, words: { ...store.words, [k]: next } },
  });
  if (s.status === "training") return set({ ...r, claim: { trainerId, at: now } });
  if ((s.status === "rejected" || s.status === "failed") && (s.reason ?? "").trim() === "")
    return { refused: "A rejected or failed model needs a reason." };
  if (r.versions.some((v) => v.version === s.version))
    return { refused: "That version is already reported." };
  const artifacts = s.status === "trained" ? (s.artifacts ?? []) : [];
  if (
    s.status === "trained" &&
    (artifacts.length === 0 ||
      artifacts.some(
        (a) =>
          !WAKE_TARGETS.includes(a.target) ||
          !WAKE_FORMATS.includes(a.format) ||
          !/^[0-9a-f]{64}$/.test(a.sha256) ||
          !(a.threshold > 0 && a.threshold <= 1),
      ))
  )
    return { refused: "Each artifact needs a known target and format, a sha256 and a threshold." };
  const version: WakeVersion = {
    version: s.version,
    status: s.status,
    ...(s.reason === undefined ? {} : { reason: s.reason }),
    eval: s.eval ?? {},
    artifacts: artifacts.map(({ target, format, sha256, threshold }) => ({
      target,
      format,
      sha256,
      threshold,
    })),
    at: now,
  };
  // A trained version keeps the claim until its bytes are in and signed; a rejected or failed one ends it.
  const { claim: _ended, ...rest } = r;
  return set({
    ...(s.status === "trained" ? r : rest),
    versions: [...r.versions, version],
  });
};

/** The words a signature covers: the model, its version and target, and its bytes. */
export const wakeSigned = (word: string, version: number, target: WakeTarget, sha256: string) =>
  `tessaya-wake|${word}|${version}|${target}|${sha256}`;

/**
 * An upload whose sha256 matches its report: signed when the version met its bar, and made current once every target
 * is signed. Returns the versions dropped past the last three, for their files to go.
 */
export const acceptWakeUpload = (
  store: WakeStore,
  word: string,
  version: number,
  target: WakeTarget,
  sha256: string,
  sign: (data: string) => string,
):
  | {
      readonly store: WakeStore;
      readonly current: boolean;
      readonly dropped: ReadonlyArray<number>;
    }
  | { readonly refused: string } => {
  const r = store.words[word];
  const v = r?.versions.find((x) => x.version === version);
  const a = v?.artifacts.find((x) => x.target === target);
  if (r === undefined || v === undefined || a === undefined)
    return { refused: "No report names this model." };
  if (a.sha256 !== sha256) return { refused: "The bytes do not match the reported sha256." };
  if (v.eval["barMet"] !== true) return { refused: "This version did not meet the bar." };
  const signed: WakeVersion = {
    ...v,
    artifacts: v.artifacts.map((x) =>
      x.target === target
        ? { ...x, signature: sign(wakeSigned(word, version, target, sha256)) }
        : x,
    ),
  };
  const done = signed.artifacts.every((x) => x.signature !== undefined);
  const versions = r.versions.map((x) => (x.version === version ? signed : x));
  const kept = versions.slice(-VERSIONS_KEPT);
  const dropped = versions.slice(0, -VERSIONS_KEPT).map((x) => x.version);
  const { claim: _done, ...rest } = r;
  const next: WakeRecord = done
    ? { ...rest, current: version, versions: kept }
    : { ...r, versions: kept };
  return {
    store: { ...store, words: { ...store.words, [word]: next } },
    current: done,
    dropped,
  };
};

/** Back to a kept version whose every target is signed. */
export const rollbackWake = (
  store: WakeStore,
  word: string,
  version: number,
): { readonly store: WakeStore } | { readonly refused: string } => {
  const r = store.words[word];
  const v = r?.versions.find((x) => x.version === version);
  if (r === undefined || v === undefined) return { refused: "That version is not kept." } as const;
  if (v.artifacts.length === 0 || v.artifacts.some((a) => a.signature === undefined))
    return { refused: "That version was never signed." } as const;
  return {
    store: { ...store, words: { ...store.words, [word]: { ...r, current: version } } },
  } as const;
};

/** Stop training a word: the claim and any request end, and none is offered until the name changes. */
export const cancelWake = (store: WakeStore, word: string): WakeStore => {
  const r = store.words[word] ?? { current: null, versions: [] };
  const { claim: _gone, ...rest } = r;
  return { ...store, words: { ...store.words, [word]: { ...rest, cancelled: true } } };
};

/** Train a cancelled word again, or retrain a current one: the cancel ends and the word is asked for. */
export const retrainWake = (
  store: WakeStore,
  word: string,
  personaId: string,
  now: number,
): { readonly store: WakeStore; readonly request: WakeRequest } => {
  const { cancelled: _undone, ...rest } = store.words[word] ?? { current: null, versions: [] };
  return {
    store: { ...store, words: { ...store.words, [word]: rest } },
    request: { word, personaId, previous: null, requestedAt: now, reason: "retrain" },
  };
};

/** One persona's wake word as Settings, voice and MCP show it: whether it wakes, which version, and each kept one. */
export interface WakeWordView {
  readonly personaId: string;
  readonly word: string;
  readonly model: WakeModel;
  readonly shipped: boolean;
  readonly current: number | null;
  readonly cancelled: boolean;
  readonly versions: ReadonlyArray<{
    readonly version: number;
    readonly status: WakeVersion["status"];
    readonly reason: string | null;
    readonly barMet: boolean;
    readonly provisional: boolean;
    readonly signed: boolean;
    readonly at: number;
  }>;
}

export const wakeOverview = (
  personas: ReadonlyArray<{ readonly id: string; readonly wake: string | null }>,
  store: WakeStore,
  now: number,
): ReadonlyArray<WakeWordView> =>
  personas.flatMap((p) => {
    const k = p.wake === null ? null : wakeKey(p.wake);
    if (k === null) return [];
    const r = store.words[k];
    return [
      {
        personaId: p.id,
        word: k,
        model: wakeModelOf(k, store, now),
        shipped: SHIPPED_WAKE_WORDS.includes(k),
        current: r?.current ?? null,
        cancelled: r?.cancelled === true,
        versions: (r?.versions ?? []).map((v) => ({
          version: v.version,
          status: v.status,
          reason: v.reason ?? null,
          barMet: v.eval["barMet"] === true,
          provisional: v.eval["provisional"] === true,
          signed: v.artifacts.length > 0 && v.artifacts.every((a) => a.signature !== undefined),
          at: v.at,
        })),
      },
    ];
  });

/** Her server's check, on every vessel: the bytes are the ones it signed for this word, version and target. */
export const wakeSignatureOk = (
  publicKeyPem: string,
  word: string,
  version: number,
  artifact: WakeArtifact,
  bytes: Uint8Array,
): boolean => {
  if (artifact.signature === undefined) return false;
  const sha = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (sha !== artifact.sha256) return false;
  try {
    return NodeCrypto.verify(
      "sha256",
      Buffer.from(wakeSigned(word, version, artifact.target, sha)),
      publicKeyPem,
      Buffer.from(artifact.signature, "base64"),
    );
  } catch {
    return false;
  }
};

/**
 * A vessel's fetch of the current model for one word from her server: kept only when her server's signature holds, so
 * an unsigned or altered model is refused (null), never loaded. `have` skips the download when that version is in hand.
 */
export const fetchSignedWake = async (input: {
  readonly server: string;
  readonly authorization: string;
  readonly word: string;
  readonly target: WakeTarget;
  readonly have?: number | null;
  readonly fetch?: typeof fetch;
}): Promise<
  | {
      readonly version: number;
      readonly format: WakeFormat;
      readonly threshold: number;
      readonly bytes: Uint8Array;
    }
  | "current"
  | null
> => {
  const get = input.fetch ?? fetch;
  const headers = { authorization: input.authorization };
  const k = wakeKey(input.word);
  if (k === null) return null;
  const at = (path: string) => new URL(`/api/tessaya/wake/${path}`, input.server);
  const response = await get(at(`models/${encodeURIComponent(k)}/${input.target}`), { headers });
  if (!response.ok) return null;
  const h = (name: string) => response.headers.get(`x-tessaya-wake-${name}`) ?? "";
  const version = Number(h("version"));
  if (!Number.isInteger(version)) return null;
  if (input.have === version) return "current";
  const bytes = new Uint8Array(await response.arrayBuffer());
  const key = await get(at("key"), { headers }).then((r) => (r.ok ? r.text() : ""));
  const artifact: WakeArtifact = {
    target: input.target,
    format: h("format") as WakeFormat,
    sha256: h("sha256"),
    threshold: Number(h("threshold")),
    ...(h("signature") === "" ? {} : { signature: h("signature") }),
  };
  return key !== "" && wakeSignatureOk(key, k, version, artifact, bytes)
    ? { version, format: artifact.format, threshold: artifact.threshold, bytes }
    : null;
};
