// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * Making his voice profile (VOICE-ID, D7): up to 60 of his own Wispr Flow recordings, read once and read-only after
 * he says yes, then about 20 s of him reading sentences through Tessaya's own microphone, which is what she will
 * hear. Only vectors are kept; no audio is written anywhere. Re-enrolling replaces the profile, deleting removes it.
 */
import * as NodePath from "node:path";

import { enrol, type SpeakerProfile } from "@t3tools/tessaya-voice";

const RATE = 16_000;
/** Wispr clips shorter than this say too little about a voice; longer ones cost time and add nothing. */
const SEED_MIN_S = 3;
const SEED_MAX_S = 30;
export const SEED_LIMIT = 60;
/** Spoken enrolment is cut into windows this long, each its own vector. */
const SPOKEN_WINDOW_S = 4;
/** About -40 dBFS: quieter windows are mostly silence. */
const QUIET_RMS = 330;
/** He reads these aloud; together about 20 s at a normal pace. */
export const ENROLMENT_SENTENCES = [
  "The quick brown fox jumps over the lazy dog, and then it goes back to sleep in the sun.",
  "I'm setting up my voice so Tessaya knows it's me when I ask her to do something.",
  "Please book the meeting for half past ten on Thursday, and remind me the day before.",
] as const;
/** Less spoken speech than this and the profile is made from the Wispr seed alone. */
export const SPOKEN_MIN_S = 12;

export interface SeedRow {
  readonly id: string;
  readonly mic: string;
  readonly at: string;
  readonly seconds: number;
}

/**
 * Which recordings to learn him from: newest first, one from each microphone and day in turn, so the profile hears
 * him on every mic and across the months rather than on one long afternoon.
 */
export const pickSeedClips = (
  rows: ReadonlyArray<SeedRow>,
  limit = SEED_LIMIT,
): ReadonlyArray<string> => {
  const buckets = new Map<string, SeedRow[]>();
  for (const row of rows
    .filter((r) => r.seconds >= SEED_MIN_S && r.seconds <= SEED_MAX_S)
    .toSorted((a, b) => b.at.localeCompare(a.at))) {
    const key = `${row.mic}|${row.at.slice(0, 10)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  const lists = [...buckets.values()];
  const picked: string[] = [];
  for (let round = 0; picked.length < limit && lists.some((l) => l.length > round); round += 1)
    for (const list of lists) {
      const row = list[round];
      if (row !== undefined && picked.length < limit) picked.push(row.id);
    }
  return picked;
};

/** A Wispr recording's samples, or null unless it is 16 kHz mono 16-bit PCM. */
export const pcmOfWav = (bytes: Uint8Array): Int16Array | null => {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length < 12 ||
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WAVE"
  )
    return null;
  let format = false;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "fmt ")
      format =
        b.readUInt16LE(at + 8) === 1 &&
        b.readUInt16LE(at + 10) === 1 &&
        b.readUInt32LE(at + 12) === RATE &&
        b.readUInt16LE(at + 22) === 16;
    if (id === "data") {
      if (!format) return null;
      const end = Math.min(b.length, at + 8 + size);
      const copy = new Uint8Array(b.subarray(at + 8, end - ((end - at - 8) % 2)));
      return new Int16Array(copy.buffer, 0, copy.length / 2);
    }
    at += 8 + size + (size % 2);
  }
  return null;
};

/** His speech in windows, the silent ones left out. */
export const speechWindows = (
  pcm: Int16Array,
  seconds = SPOKEN_WINDOW_S,
): ReadonlyArray<Int16Array> => {
  const n = seconds * RATE;
  const out: Int16Array[] = [];
  for (let start = 0; start + n <= pcm.length; start += n) {
    const w = pcm.subarray(start, start + n);
    let sum = 0;
    for (const v of w) sum += v * v;
    if (Math.sqrt(sum / n) >= QUIET_RMS) out.push(w);
  }
  return out;
};

type Embed = (pcm: Int16Array) => Promise<Float32Array | null>;

/** Between enrolment embeds, so the voice model worker answers the speech detector in between. */
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** His Wispr recordings as vectors, read-only, only the clips chosen; null when there is no Wispr history. */
export const wisprSeedVectors = async (input: {
  readonly appData: string | undefined;
  readonly embed: Embed;
  readonly limit?: number;
}): Promise<{ readonly vectors: ReadonlyArray<Float32Array>; readonly clips: number } | null> => {
  if (input.appData === undefined) return null;
  const { DatabaseSync } = await import("node:sqlite");
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(NodePath.join(input.appData, "Wispr Flow", "flow.sqlite"), {
      readOnly: true,
    });
  } catch {
    return null;
  }
  try {
    const rows = db
      .prepare(
        "SELECT transcriptEntityId AS id, coalesce(micDevice, '') AS mic, timestamp AS at, duration AS seconds FROM History WHERE audio IS NOT NULL AND length(audio) > 0",
      )
      .all() as unknown as ReadonlyArray<SeedRow>;
    const audio = db.prepare("SELECT audio FROM History WHERE transcriptEntityId = ?");
    const vectors: Float32Array[] = [];
    let clips = 0;
    for (const id of pickSeedClips(rows, input.limit)) {
      const row = audio.get(id) as { audio?: Uint8Array } | undefined;
      const pcm = row?.audio === undefined ? null : pcmOfWav(row.audio);
      if (pcm === null) continue;
      clips += 1;
      await pause();
      const vector = await input.embed(pcm);
      if (vector !== null) vectors.push(vector);
    }
    return { vectors, clips };
  } catch {
    return null;
  } finally {
    db.close();
  }
};

/** His spoken enrolment (the sentences read through her mic) as vectors, one per 4 s window of speech. */
export const spokenVectors = async (
  pcm: Int16Array,
  embed: Embed,
): Promise<{ readonly vectors: ReadonlyArray<Float32Array>; readonly seconds: number }> => {
  const windows = speechWindows(pcm);
  const vectors: Float32Array[] = [];
  for (const w of windows) {
    await pause();
    const v = await embed(w);
    if (v !== null) vectors.push(v);
  }
  return { vectors, seconds: windows.length * SPOKEN_WINDOW_S };
};

/**
 * His profile from what he gave: the Wispr seed, the spoken windows, or both. Null when there is too little to
 * tell his voice by, which Settings reports instead of saving a weak profile.
 */
export const ownerProfile = (input: {
  readonly name: string;
  readonly model: string;
  readonly seed: ReadonlyArray<Float32Array>;
  readonly spoken: ReadonlyArray<Float32Array>;
  readonly spokenSeconds: number;
  readonly now: Date;
}): SpeakerProfile | null => {
  const useSpoken = input.spokenSeconds >= SPOKEN_MIN_S;
  const made = enrol([...input.seed, ...(useSpoken ? input.spoken : [])]);
  if (made === null) return null;
  return {
    id: "owner",
    name: input.name,
    kind: "owner",
    model: input.model,
    centroid: made.centroid,
    samples: made.kept,
    sources: [
      ...(input.seed.length > 0 ? (["wispr"] as const) : []),
      ...(useSpoken && input.spoken.length > 0 ? (["spoken"] as const) : []),
    ],
    enrolledAt: input.now.toISOString(),
  };
};

export interface EnrolResult {
  readonly saved: boolean;
  /** Wispr recordings read (0 when he did not agree, or has none). */
  readonly wisprClips: number;
  readonly spokenSeconds: number;
  readonly samples: number;
  /** When nothing was saved: why, for Settings to say. */
  readonly why?: "no-model" | "too-little";
}

/**
 * Enrols him, or re-enrols him (the profile is replaced). The Wispr seed is read only when he agreed to it; the
 * spoken PCM is what he read through her mic, possibly empty.
 */
export const enrolOwner = async (input: {
  readonly name: string;
  readonly embedder: { readonly model: string; readonly embed: Embed } | null;
  readonly useWispr: boolean;
  readonly appData: string | undefined;
  readonly spoken: Int16Array;
  readonly save: (profile: SpeakerProfile) => void;
  readonly now: Date;
}): Promise<EnrolResult> => {
  const none = { saved: false, wisprClips: 0, spokenSeconds: 0, samples: 0 };
  if (input.embedder === null) return { ...none, why: "no-model" };
  const { model, embed } = input.embedder;
  const seed = input.useWispr ? await wisprSeedVectors({ appData: input.appData, embed }) : null;
  const spoken = await spokenVectors(input.spoken, embed);
  const profile = ownerProfile({
    name: input.name,
    model,
    seed: seed?.vectors ?? [],
    spoken: spoken.vectors,
    spokenSeconds: spoken.seconds,
    now: input.now,
  });
  const counts = { wisprClips: seed?.clips ?? 0, spokenSeconds: spoken.seconds };
  if (profile === null) return { ...none, ...counts, why: "too-little" };
  input.save(profile);
  return { saved: true, ...counts, samples: profile.samples };
};

/** What a saved person reads after saying yes: short, so a guest at the table can do it. */
export const SAVED_PERSON_LINES = [
  "Yes, Tessaya may remember my voice.",
  "I'm reading this so she knows it's me when I talk to her.",
  "The quick brown fox jumps over the lazy dog, and then it goes back to sleep in the sun.",
] as const;

/** A profile id from a name: never "owner", never one already taken. */
export const personId = (name: string, taken: ReadonlyArray<string>): string => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "person";
  const free = (id: string) => id !== "owner" && !taken.includes(id);
  if (free(base)) return base;
  for (let n = 2; ; n += 1) if (free(`${base}-${n}`)) return `${base}-${n}`;
};

/** Someone he saves, from their read alone (no Wispr: those are only his). Null when there is too little. */
export const enrolSaved = async (input: {
  readonly name: string;
  /** A household member's id: their profile takes it (re-enrolling replaces theirs). Never "owner". */
  readonly id?: string;
  readonly taken: ReadonlyArray<string>;
  readonly embedder: { readonly model: string; readonly embed: Embed };
  readonly spoken: Int16Array;
  readonly consentNote: string;
  readonly save: (profile: SpeakerProfile) => void;
  readonly now: Date;
}): Promise<SpeakerProfile | null> => {
  const spoken = await spokenVectors(input.spoken, input.embedder.embed);
  const made = enrol(spoken.vectors);
  if (made === null) return null;
  const profile: SpeakerProfile = {
    id:
      input.id !== undefined && input.id !== "owner" ? input.id : personId(input.name, input.taken),
    name: input.name,
    kind: "saved",
    model: input.embedder.model,
    centroid: made.centroid,
    samples: made.kept,
    sources: ["spoken"],
    enrolledAt: input.now.toISOString(),
    consentNote: input.consentNote,
  };
  input.save(profile);
  return profile;
};
