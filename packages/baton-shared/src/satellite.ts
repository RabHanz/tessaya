/**
 * A spare phone as a room satellite, speaking the R1's device contract (research R1-OFF-AGORA §9): between sessions
 * only voiced segments go up on `voice/wake` for the server's wake check; in a session every 60 ms frame goes up on
 * `voice/up`. While her reply plays the microphone sends nothing (a phone's echo cancelling is not the R1's), so she
 * never hears herself. Pure, so the phone screen only moves bytes.
 */
import type { CompanionDown } from "@t3tools/baton-contracts";

import type { CompanionMoment } from "./companion.ts";

export const SATELLITE_RATE = 16_000;
/** 60 ms at 16 kHz, as the R1 batches its frames. */
export const FRAME_SAMPLES = 960;
/** 300 ms before the voice starts goes with it, so her name's first sound is in the segment. */
const PREROLL_FRAMES = 5;
/** The R1 caps a wake segment at 6 s. */
const WAKE_MAX_FRAMES = 100;
/** About half a second of quiet ends a voiced segment. */
const HANG_FRAMES = 8;
/** The room's echo of her last word dies away before the microphone opens again. */
const ECHO_TAIL_MS = 300;
/** Below this RMS (of 32768) is quiet, whatever the room's noise. */
const VOICE_MIN_RMS = 300;

export type UplinkTopic = "voice/up" | "voice/wake" | "voice/wake/end";
export interface UplinkMessage {
  readonly topic: UplinkTopic;
  readonly pcm?: Int16Array;
}

const rms = (frame: Int16Array): number => {
  let sum = 0;
  for (const s of frame) sum += s * s;
  return Math.sqrt(sum / Math.max(1, frame.length));
};

const join = (frames: ReadonlyArray<Int16Array>): Int16Array => {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
};

export interface Uplink {
  /** One FRAME_SAMPLES frame at 16 kHz from the microphone: what to send for it. */
  readonly push: (frame: Int16Array, now: number) => ReadonlyArray<UplinkMessage>;
  /** The room opened (`cmd/voice/start`) or closed a session; a wake segment in flight ends first. */
  readonly session: (open: boolean) => ReadonlyArray<UplinkMessage>;
  /** Her reply started or stopped playing on this phone. */
  readonly playing: (on: boolean, now: number) => void;
  /** He is speaking now, by the last frame. */
  readonly hearing: () => boolean;
  readonly lastVoiceAt: () => number | null;
}

export const createUplink = (): Uplink => {
  let open = false;
  let play = false;
  let quietUntil = 0;
  let floor = VOICE_MIN_RMS / 3;
  let voiced = false;
  let lastVoice: number | null = null;
  let preroll: Int16Array[] = [];
  let segment = false;
  let segFrames = 0;
  let quiet = 0;

  const endSegment = (): ReadonlyArray<UplinkMessage> => {
    if (!segment) return [];
    segment = false;
    return [{ topic: "voice/wake/end" }];
  };

  return {
    push: (frame, now) => {
      if (play || now < quietUntil) {
        voiced = false;
        return [];
      }
      const level = rms(frame);
      // The noise floor follows the room down at once and up slowly, so a voice never becomes the floor.
      floor = level < floor ? level : floor + (level - floor) * 0.002;
      voiced = level > Math.max(VOICE_MIN_RMS, floor * 3);
      if (voiced) lastVoice = now;
      if (open) return [{ topic: "voice/up", pcm: frame }];
      if (!segment) {
        preroll = [...preroll, frame].slice(-PREROLL_FRAMES);
        if (!voiced) return [];
        segment = true;
        segFrames = preroll.length;
        quiet = 0;
        const first = join(preroll);
        preroll = [];
        return [{ topic: "voice/wake", pcm: first }];
      }
      segFrames += 1;
      quiet = voiced ? 0 : quiet + 1;
      const out: UplinkMessage[] = [{ topic: "voice/wake", pcm: frame }];
      if (quiet >= HANG_FRAMES || segFrames >= WAKE_MAX_FRAMES) out.push(...endSegment());
      return out;
    },
    session: (next) => {
      const out = next ? endSegment() : [];
      open = next;
      preroll = [];
      return out;
    },
    playing: (on, now) => {
      if (on) play = true;
      else if (play) {
        play = false;
        quietUntil = now + ECHO_TAIL_MS;
      }
    },
    hearing: () => voiced,
    lastVoiceAt: () => lastVoice,
  };
};

/** Collects the microphone's buffers, at whatever rate the phone gives, into 16 kHz frames of FRAME_SAMPLES. */
export const createFramer = () => {
  let held = new Int16Array(0);
  let phase = 0;
  /** The last sample of the previous buffer, for the step that falls between two buffers. */
  let last = 0;
  return (pcm: Int16Array, rate: number): ReadonlyArray<Int16Array> => {
    const step = rate / SATELLITE_RATE;
    const out: number[] = [];
    // Linear resampling, carried across buffers so no seam clicks.
    for (; phase < pcm.length - 1; phase += step) {
      const i = Math.floor(phase);
      const t = phase - i;
      const from = i < 0 ? last : pcm[i]!;
      out.push(Math.round(from * (1 - t) + pcm[i + 1]! * t));
    }
    phase -= pcm.length;
    last = pcm.at(-1) ?? last;
    const all = new Int16Array(held.length + out.length);
    all.set(held);
    all.set(out, held.length);
    const frames: Int16Array[] = [];
    let at = 0;
    for (; at + FRAME_SAMPLES <= all.length; at += FRAME_SAMPLES)
      frames.push(all.slice(at, at + FRAME_SAMPLES));
    held = all.slice(at);
    return frames;
  };
};

/** What her face does on a satellite, from what it can see: the session, her voice, and his. */
export const satelliteMoment = (s: {
  readonly session: boolean;
  readonly playing: boolean;
  readonly hearing: boolean;
  /** Since he last spoke in this session, or null. */
  readonly sinceVoiceMs: number | null;
}): CompanionMoment => {
  if (!s.session) return "rest";
  if (s.playing) return "speaking";
  if (s.hearing) return "listening";
  return s.sinceVoiceMs !== null && s.sinceVoiceMs < 8_000 ? "thinking" : "listening";
};

/** The room's eye moods (`cmd/eye/set`, the R1's names) as the studio's expressions. */
export const expressionOfMood = (mood: string): string =>
  ({
    happy: "happy",
    curious: "curious",
    thinking: "thinking",
    worried: "concerned",
    sad: "sad",
    sleepy: "sleepy",
    angry: "annoyed",
    surprise: "surprised",
    love: "love",
  })[mood] ?? "neutral";

/** PCM to and from the base64 the RPC carries (little-endian, as the R1 sends it). */
export const pcmToBase64 = (pcm: Int16Array): string => {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/** The room's messages for this phone, handed from the link's stream (an atom) to the screen that plays them. */
export const satelliteInbox = (() => {
  const listeners = new Set<(down: CompanionDown) => void>();
  return {
    emit: (down: CompanionDown) => {
      for (const listener of listeners) listener(down);
    },
    listen: (listener: (down: CompanionDown) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
})();
