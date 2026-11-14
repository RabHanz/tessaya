/**
 * Several people in one turn (HOUSEHOLD-DESIGN §9b, step 1), from Voice ID's scores on sliding windows. Split only at
 * a pause whose sides each sound like one speaker alone. CAM++ names the louder voice in a mix, so a long overlap
 * beside a pause can still slip into a span (test/segmentsEval.ts counts it).
 * @module baton-voice/room/segments
 */
import {
  cosine,
  decideSpeaker,
  identityOf,
  type SpeakerClip,
  type SpeakerIdentity,
  type SpeakerPolicy,
  type SpeakerProfile,
} from "../speaker.ts";
import { speechLevel } from "./audio.ts";

const RATE = 16_000;
const WINDOW_MS = 1_500;
const HOP_MS = 500;
/** Quieter than this (speech level, dBFS) a window is a pause, not a voice. */
const QUIET_DB = -50;
/** Under this share of the speech owned by one member, the split is a guess: she asks for one at a time. */
const MIN_OWNED = 0.5;

/** One person's stretch of the turn, in ms from its start. */
interface VoiceSpan {
  readonly startMs: number;
  readonly endMs: number;
  readonly identity: SpeakerIdentity;
}

export type TurnVoices =
  | { readonly kind: "one" }
  | { readonly kind: "many"; readonly spans: ReadonlyArray<VoiceSpan> }
  | { readonly kind: "one-at-a-time"; readonly why: "three-voices" | "overlap" | "unsure" };

const levelOf = (pcm: Int16Array): number => {
  let sum = 0;
  for (const s of pcm) sum += s * s;
  const rms = Math.sqrt(sum / Math.max(1, pcm.length));
  return rms <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms / 32768);
};

/** A pause is this long or more of 30 ms frames 25 dB under the turn's speech (or under `QUIET_DB`). */
const PAUSE_MS = 120;
/** How far either side of a handover may sound from its speaker talking alone. */
const SLACK = 0.15;
const FRAME = 480;

/** The middle of every pause in the turn, as a sample index. */
const pausesOf = (pcm: Int16Array): ReadonlyArray<number> => {
  const quiet = Math.max(speechLevel(pcm) - 25, QUIET_DB);
  const out: number[] = [];
  let since = -1;
  for (let f = 0; f + FRAME <= pcm.length; f += FRAME) {
    if (levelOf(pcm.subarray(f, f + FRAME)) < quiet) {
      if (since < 0) since = f;
      continue;
    }
    if (since >= 0 && f - since >= (PAUSE_MS / 1000) * RATE) out.push(Math.round((since + f) / 2));
    since = -1;
  }
  return out;
};

/**
 * Who spoke when in this turn. One voice (or fewer than two enrolled profiles, or too short for two) is "one", and the
 * turn goes on as it always has. Two or more members each with a clean run of 2+ windows, handing over at pauses, are
 * "many". Three people within 2 s, no clean handover, or a split that owns too little of the speech: "one-at-a-time".
 */
export const voicesOf = async (input: {
  readonly pcm: Int16Array;
  readonly embed: (pcm: Int16Array) => Promise<Float32Array | null>;
  readonly profiles: ReadonlyArray<SpeakerProfile>;
  readonly policy: SpeakerPolicy;
  readonly at: number;
}): Promise<TurnVoices> => {
  const { pcm, policy } = input;
  const profiles = input.profiles.filter((p) => p.model === policy.model);
  const win = (WINDOW_MS / 1000) * RATE;
  const hop = (HOP_MS / 1000) * RATE;
  if (profiles.length < 2 || pcm.length < 2 * win) return { kind: "one" };
  const starts: number[] = [];
  for (let s = 0; s + win <= pcm.length; s += hop) starts.push(s);
  const listen = policy.single.listen;
  /** speaker.ts's rule: above the listen cut-off and clear of the next profile by the margin, or nobody's. */
  const nameOf = async (clip: Int16Array) => {
    const vector = await input.embed(clip);
    if (vector === null) return { label: null, clip: null, scores: new Map<string, number>() };
    const scored = profiles
      .map((p) => ({ id: p.id, score: cosine(vector, p.centroid) }))
      .filter((x) => Number.isFinite(x.score))
      .toSorted((a, b) => b.score - a.score);
    const [best, next] = scored;
    const label =
      best !== undefined &&
      best.score >= listen &&
      (next === undefined || best.score - next.score >= policy.margin)
        ? best.id
        : null;
    return {
      label,
      clip: { vector, ms: (clip.length / RATE) * 1000 } satisfies SpeakerClip,
      scores: new Map(scored.map((x) => [x.id, x.score])),
    };
  };
  const windows = await Promise.all(
    starts.map(async (s) => {
      const clip = pcm.subarray(s, s + win);
      return levelOf(clip) < QUIET_DB
        ? { s, quiet: true, label: null, clip: null, scores: new Map<string, number>() }
        : { s, quiet: false, ...(await nameOf(clip)) };
    }),
  );
  // Three people named within 2 s of each other: too many voices to split.
  for (let i = 0; i < windows.length; i += 1) {
    const near = new Set(
      windows.slice(i, i + 5).flatMap((w) => (w.label === null ? [] : [w.label])),
    );
    if (near.size >= 3) return { kind: "one-at-a-time", why: "three-voices" };
  }
  // Runs of the same label; a run of one window is noise, not a person.
  type Run = { label: string; from: number; to: number };
  const runs: Run[] = [];
  windows.forEach((w, i) => {
    const last = runs.at(-1);
    if (w.label === null) return;
    if (last !== undefined && last.label === w.label && last.to === i - 1) last.to = i;
    else runs.push({ label: w.label, from: i, to: i });
  });
  const clean = runs.filter((r) => r.to > r.from);
  if (new Set(clean.map((r) => r.label)).size < 2) return { kind: "one" };
  const speaking = windows.filter((w) => !w.quiet).length;
  const owned = clean.reduce((n, r) => n + r.to - r.from + 1, 0);
  if (owned / Math.max(1, speaking) < MIN_OWNED) return { kind: "one-at-a-time", why: "unsure" };
  // Where one person hands over to the next: a pause between their runs, checked by naming the audio on each side of it.
  // With no pause, or either side not clearly theirs, the voices overlap and nobody's words can be cut out cleanly.
  const pauses = pausesOf(pcm);
  const cutIn = new Map<Run, number>();
  const cutOut = new Map<Run, number>();
  for (let k = 1; k < clean.length; k += 1) {
    const [a, b] = [clean[k - 1]!, clean[k]!];
    if (a.label === b.label || b.from - a.to > 3) continue;
    // Past the middle of the first voice's last window, before the end of the next one's first.
    const from = windows[a.to]!.s + hop;
    const to = windows[b.from]!.s + win - hop;
    // Each side sounds as its speaker does talking alone: as like them, and no more like the other voice.
    const typical = (r: Run, id: string, at: number) => {
      const xs = windows.slice(r.from, r.to + 1).map((w) => w.scores.get(id) ?? 0);
      return xs.toSorted((x, y) => x - y)[Math.floor((xs.length - 1) * at)]!;
    };
    // As like them as their clearest window, and no more like the other voice than their usual window.
    const likeAlone = (side: Awaited<ReturnType<typeof nameOf>>, r: Run, other: Run) =>
      side.label === r.label &&
      (side.scores.get(r.label) ?? 0) >= typical(r, r.label, 1) - SLACK &&
      (side.scores.get(other.label) ?? 1) <= typical(r, other.label, 0.5) + SLACK;
    const handsOver = async (at: number) => {
      const [before, after] = await Promise.all([
        nameOf(pcm.subarray(Math.max(0, at - win), at)),
        nameOf(pcm.subarray(at, at + win)),
      ]);
      return likeAlone(before, a, b) && likeAlone(after, b, a);
    };
    // A breath inside one person's words is a pause too: the nearest that truly hands over wins.
    const mid = (from + to) / 2;
    let cut: number | undefined;
    for (const p of pauses
      .filter((p) => p >= from && p <= to)
      .toSorted((x, y) => Math.abs(x - mid) - Math.abs(y - mid)))
      if (await handsOver(p)) {
        cut = p;
        break;
      }
    if (cut === undefined) return { kind: "one-at-a-time", why: "overlap" };
    cutOut.set(a, cut);
    cutIn.set(b, cut);
  }
  // Elsewhere a window owns its middle hop; one beside an unnamed voice may hold some of it, so owns nothing.
  const other = (i: number, label: string) =>
    i >= 0 && i < windows.length && !windows[i]!.quiet && windows[i]!.label !== label;
  const ms = (sample: number) => (sample / RATE) * 1000;
  const edge = (i: number) => i < 0 || i >= windows.length || windows[i]!.quiet;
  const spans = clean.flatMap((r) => {
    const into = cutIn.get(r);
    const outOf = cutOut.get(r);
    const from = into === undefined && other(r.from - 1, r.label) ? r.from + 1 : r.from;
    const to = outOf === undefined && other(r.to + 1, r.label) ? r.to - 1 : r.to;
    if (to < from) return [];
    const start = into ?? windows[from]!.s + (edge(from - 1) ? 0 : hop);
    const end = outOf ?? windows[to]!.s + (edge(to + 1) ? win : 2 * hop);
    return [{ r, startMs: ms(start), endMs: ms(end) }];
  });
  if (new Set(spans.map((x) => x.r.label)).size < 2)
    return { kind: "one-at-a-time", why: "unsure" };
  // A run's name at the steer level, as a whole turn's is; act is never claimed from shared audio.
  const lenient = { ...policy, minSpeechMs: WINDOW_MS };
  return {
    kind: "many",
    spans: spans.map(({ r, startMs, endMs }) => {
      const clips = windows
        .slice(r.from, r.to + 1)
        .flatMap((w) => (w.clip === null ? [] : [w.clip]));
      const steer = decideSpeaker({
        clips,
        model: policy.model,
        profiles,
        policy: lenient,
        use: "steer",
      });
      const named = identityOf(steer, { kind: "unverified", why: "too-short" }, input.at);
      // Never a name other than the run's own.
      const identity =
        named.personId === null || named.personId === r.label
          ? named
          : { ...named, kind: "guest" as const, personId: null, name: null };
      return { startMs, endMs, identity };
    }),
  };
};

/**
 * Each span recognised on its own, in speaking order; one person's spans side by side are one segment.
 * Undefined when fewer than two people are left with words: then the turn is answered as one voice.
 */
export const segmentsOf = async (
  spans: ReadonlyArray<VoiceSpan>,
  pcm: Int16Array,
  recognise: (pcm: Int16Array) => Promise<string>,
): Promise<
  ReadonlyArray<{ readonly speaker: SpeakerIdentity; readonly words: string }> | undefined
> => {
  const heard = await Promise.all(
    spans.map(async (s) => ({
      speaker: s.identity,
      words: (
        await recognise(pcm.subarray((s.startMs * RATE) / 1000, (s.endMs * RATE) / 1000)).catch(
          () => "",
        )
      ).trim(),
    })),
  );
  const out: Array<{ speaker: SpeakerIdentity; words: string }> = [];
  for (const h of heard) {
    if (h.words === "") continue;
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.speaker.personId !== null &&
      last.speaker.personId === h.speaker.personId
    )
      last.words = `${last.words} ${h.words}`;
    else out.push({ ...h });
  }
  return out.length >= 2 ? out : undefined;
};
