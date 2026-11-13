// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Voice profiles (VOICE-ID): `<state dir>/voice/speakers.json`, his and the people he saved, as vectors only, never
 * audio. This machine's copy of each member's shared profile (kept on the home server), plus this device's own
 * refinements of it. Deleting one rewrites the file without it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { SpeakerProfile } from "./speaker.ts";

interface Stored extends Omit<SpeakerProfile, "centroid" | "base"> {
  readonly centroid: string;
  readonly base?: string;
}

/** A vector as base64 of its float32 bytes: how a profile is kept on disk and sent between machines. */
export const vectorToBase64 = (v: Float32Array): string =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");

/** A damaged vector must not be compared: a NaN score is never allowed to stand for anyone. */
export const vectorFromBase64 = (text: string): Float32Array | null => {
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const copy = new Uint8Array(bytes);
  const v = new Float32Array(copy.buffer, 0, copy.length / 4);
  return v.every(Number.isFinite) ? v : null;
};

/** A profile as it travels to the home server: the shared part only, never this device's refinements. */
export const profileToWire = (p: SpeakerProfile) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  model: p.model,
  centroid: vectorToBase64(p.base ?? p.centroid),
  samples: p.samples,
  sources: p.sources.filter((s) => s !== "adapted"),
  enrolledAt: p.enrolledAt,
  ...(p.consentNote === undefined ? {} : { consentNote: p.consentNote }),
});

/** The home's shared profile as this device keeps it; null when its vector is damaged. */
export const profileFromWire = (w: {
  readonly id: string;
  readonly name: string;
  readonly kind: "owner" | "saved";
  readonly model: string;
  readonly centroid: string;
  readonly samples: number;
  readonly sources: ReadonlyArray<"wispr" | "spoken" | "adapted">;
  readonly enrolledAt: string;
  readonly consentNote?: string;
  readonly version: number;
}): SpeakerProfile | null => {
  const centroid = vectorFromBase64(w.centroid);
  return centroid === null
    ? null
    : {
        id: w.id,
        name: w.name,
        kind: w.kind,
        model: w.model,
        centroid,
        samples: w.samples,
        sources: w.sources,
        enrolledAt: w.enrolledAt,
        ...(w.consentNote === undefined ? {} : { consentNote: w.consentNote }),
        version: w.version,
      };
};

const toStored = ({ base, ...p }: SpeakerProfile): Stored => ({
  ...p,
  centroid: vectorToBase64(p.centroid),
  ...(base === undefined ? {} : { base: vectorToBase64(base) }),
});

const fromStored = ({ base, ...s }: Stored): SpeakerProfile | null => {
  const centroid = vectorFromBase64(s.centroid);
  const shared = base === undefined ? undefined : vectorFromBase64(base);
  if (centroid === null || shared === null) return null;
  return { ...s, centroid, ...(shared === undefined ? {} : { base: shared }) };
};

const isStored = (value: unknown): value is Stored => {
  const v = value as Partial<Stored> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    (v.kind === "owner" || v.kind === "saved") &&
    typeof v.model === "string" &&
    typeof v.centroid === "string"
  );
};

export const speakersPath = (stateDir: string) => NodePath.join(stateDir, "voice", "speakers.json");

export const createSpeakerStore = (stateDir: string) => {
  const file = speakersPath(stateDir);
  const read = (): ReadonlyArray<SpeakerProfile> => {
    let text: string;
    try {
      text = NodeFS.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.filter(isStored).flatMap((s) => fromStored(s) ?? []);
    } catch {
      // Unreadable: kept aside below, so the next save starts a new file instead of writing over his profiles.
    }
    NodeFS.renameSync(file, `${file}.corrupt-${Date.now()}`);
    return [];
  };
  // Only he and the people he saved can read it: a voice profile identifies a person.
  const write = (profiles: ReadonlyArray<SpeakerProfile>) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(profiles.map(toStored), null, 2), {
      mode: 0o600,
    });
    NodeFS.renameSync(`${file}.tmp`, file);
  };
  return {
    list: read,
    /** Adds or replaces the profile with this id. */
    save: (profile: SpeakerProfile) =>
      write([...read().filter((p) => p.id !== profile.id), profile]),
    remove: (id: string) => write(read().filter((p) => p.id !== id)),
  };
};
