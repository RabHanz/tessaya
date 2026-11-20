/**
 * Voices she hears without her name tell her server who is near this Tessel (M-123). A wake segment that is long and
 * loud enough, not her own last words and not too soon after the last check, goes through the same Voice ID as a turn;
 * only who is sent, never the audio or any words, and nothing here runs a recogniser.
 * @module baton-voice/room/ambientPresence
 */
import type { SpeakerIdentity } from "../speaker.ts";
import type { TurnVoices } from "./segments.ts";

const RATE = 16_000;
/** Shorter than this Voice ID can't tell anyone (its windows are 1.5 s). */
export const AMBIENT_MIN_MS = 1_500;
/** Quieter than this (speech level, dBFS) is a far room or the telly, not someone at this Tessel. */
export const AMBIENT_MIN_DB = -45;
/** One check per Tessel this often at most: a voice renewed sooner changes no estimate. */
export const AMBIENT_EVERY_MS = 30_000;
/** Her own last words can still be ringing in a segment that starts this soon after she stopped. */
export const AMBIENT_AFTER_HER_MS = 3_000;
/** The server said ambient presence is off: ask again after this. */
export const AMBIENT_OFF_MS = 10 * 60_000;

/** Who one identity is to presence: a member Voice ID cleared, else someone it can't name. */
const whoOf = (identity: SpeakerIdentity | undefined): { readonly member: string | null } => ({
  member:
    identity !== undefined &&
    identity.verified &&
    (identity.kind === "owner" || identity.kind === "saved") &&
    identity.personId !== null
      ? identity.personId
      : null,
});

/** Every voice in the segment: each span's speaker when it is several, else the one speaker. */
export const ambientVoices = (
  voices: TurnVoices,
  one: SpeakerIdentity | undefined,
): ReadonlyArray<{ readonly member: string | null }> =>
  voices.kind === "many" ? voices.spans.map((s) => whoOf(s.identity)) : [whoOf(one)];

const levelOf = (pcm: Int16Array): number => {
  let sum = 0;
  for (const s of pcm) sum += s * s;
  const rms = Math.sqrt(sum / Math.max(1, pcm.length));
  return rms <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms / 32768);
};

export interface AmbientPresenceDeps {
  /** Who spoke when (segments.ts), and the one speaker when it was one. */
  readonly voices: (pcm: Int16Array) => Promise<TurnVoices>;
  readonly speaker: (pcm: Int16Array) => Promise<SpeakerIdentity | undefined>;
  /** When her own voice last played on this Tessel (null: not lately). */
  readonly herVoiceAt: (deviceId: string) => number | null;
  /** Tells her server; resolves false when it said ambient presence is off. */
  readonly send: (
    deviceId: string,
    voices: ReadonlyArray<{ readonly member: string | null }>,
  ) => Promise<boolean>;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

export const createAmbientPresence = (deps: AmbientPresenceDeps) => {
  const lastCheck = new Map<string, number>();
  let offUntil = 0;
  return {
    /** One wake segment that ended at this Tessel (a muted Tessel's audio never gets here). */
    segment: async (deviceId: string, pcm: Int16Array): Promise<void> => {
      const now = deps.now();
      const startedAt = now - (pcm.length / RATE) * 1000;
      const her = deps.herVoiceAt(deviceId);
      if (
        now < offUntil ||
        (pcm.length / RATE) * 1000 < AMBIENT_MIN_MS ||
        levelOf(pcm) < AMBIENT_MIN_DB ||
        (her !== null && startedAt - her < AMBIENT_AFTER_HER_MS) ||
        now - (lastCheck.get(deviceId) ?? Number.NEGATIVE_INFINITY) < AMBIENT_EVERY_MS
      )
        return;
      lastCheck.set(deviceId, now);
      const voices = await deps.voices(pcm);
      const one = voices.kind === "many" ? undefined : await deps.speaker(pcm);
      const heard = ambientVoices(voices, one);
      const on = await deps.send(deviceId, heard).catch(() => true);
      if (!on) {
        offUntil = now + AMBIENT_OFF_MS;
        return;
      }
      deps.log(`[${deviceId}] heard nearby: ${heard.map((v) => v.member ?? "someone").join(", ")}`);
    },
  };
};
