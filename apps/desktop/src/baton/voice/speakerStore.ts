// @effect-diagnostics nodeBuiltinImport:off
/**
 * Voice profiles (VOICE-ID): `<state dir>/voice/speakers.json`, his and the people he saved, as vectors only, never
 * audio. Local to this machine: not synced, not sent to the server. Deleting one rewrites the file without it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { SpeakerProfile } from "@t3tools/baton-voice";

interface Stored extends Omit<SpeakerProfile, "centroid"> {
  readonly centroid: string;
}

const toStored = (p: SpeakerProfile): Stored => ({
  ...p,
  centroid: Buffer.from(p.centroid.buffer, p.centroid.byteOffset, p.centroid.byteLength).toString(
    "base64",
  ),
});

const fromStored = (s: Stored): SpeakerProfile | null => {
  const bytes = Buffer.from(s.centroid, "base64");
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const copy = new Uint8Array(bytes);
  return { ...s, centroid: new Float32Array(copy.buffer, 0, copy.length / 4) };
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
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isStored).flatMap((s) => fromStored(s) ?? []);
    } catch {
      return [];
    }
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
