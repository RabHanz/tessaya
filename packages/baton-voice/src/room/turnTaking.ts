/**
 * When he starts, when he has finished, and when he cuts in over her: the room's turn-taking, pure, one 32 ms window
 * at a time. Silero says "speech or not" per window; Smart Turn is asked at each pause whether the sentence is done,
 * so a finished sentence ends in about 0.2 s and a thinking pause can last up to `maxSilenceMs`.
 *
 * @module baton-voice/room/turnTaking
 */
export const WINDOW = 512;
const WINDOW_MS = 32;

export interface TurnConfig {
  /** Silero probability that starts or continues speech. */
  readonly startProb: number;
  /** Below this a window counts as silence. */
  readonly stopProb: number;
  /** Speech for this long opens a turn (a click or a cough is shorter). */
  readonly startMs: number;
  /** Audio before the onset kept for the recogniser, so the first syllable is not clipped. */
  readonly prerollMs: number;
  /** Silence before Smart Turn is first asked. */
  readonly pauseMs: number;
  /** While Smart Turn says "not finished", it is asked again this often. */
  readonly recheckMs: number;
  /** Silence that ends the turn whatever Smart Turn says. */
  readonly maxSilenceMs: number;
  /** Smart Turn's "complete" cut-off. */
  readonly completeProb: number;
  /** While she speaks, a cut-in needs this probability... */
  readonly bargeProb: number;
  /** ...held this long. */
  readonly bargeMs: number;
  /** A turn longer than this is closed and answered. */
  readonly maxTurnMs: number;
}

export const ROOM_TURN: TurnConfig = {
  startProb: 0.5,
  stopProb: 0.35,
  startMs: 96,
  prerollMs: 320,
  pauseMs: 192,
  recheckMs: 288,
  maxSilenceMs: 1_500,
  completeProb: 0.5,
  bargeProb: 0.6,
  bargeMs: 160,
  maxTurnMs: 30_000,
};

export type TurnAction =
  | { readonly kind: "start"; readonly pcm: Int16Array }
  | { readonly kind: "audio"; readonly pcm: Int16Array }
  | { readonly kind: "check"; readonly id: number; readonly pcm: Int16Array }
  | {
      readonly kind: "end";
      readonly pcm: Int16Array;
      readonly reason: "complete" | "silence" | "long";
    }
  | { readonly kind: "barge" };

const join = (parts: ReadonlyArray<Int16Array>): Int16Array => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const createTurnTaking = (config: TurnConfig = ROOM_TURN) => {
  const ms = (n: number) => Math.max(1, Math.round(n / WINDOW_MS));
  const prerollWindows = ms(config.prerollMs);
  let recent: Int16Array[] = [];
  let onset = 0;
  let inTurn = false;
  let turn: Int16Array[] = [];
  let silence = 0;
  let nextCheck = 0;
  let checkId = 0;
  const end = (reason: "complete" | "silence" | "long"): TurnAction => {
    const pcm = join(turn);
    inTurn = false;
    turn = [];
    recent = [];
    onset = 0;
    silence = 0;
    checkId += 1;
    return { kind: "end", pcm, reason };
  };
  return {
    /** One window of mic audio with its Silero probability; `speaking` while her voice is playing in the room. */
    feed: (window: Int16Array, prob: number, speaking: boolean): TurnAction[] => {
      if (!inTurn) {
        recent.push(window);
        if (recent.length > prerollWindows) recent.shift();
        const need = speaking ? config.bargeProb : config.startProb;
        onset = prob >= need ? onset + 1 : 0;
        if (onset < ms(speaking ? config.bargeMs : config.startMs)) return [];
        inTurn = true;
        turn = [...recent];
        silence = 0;
        const start: TurnAction = { kind: "start", pcm: join(recent) };
        recent = [];
        return speaking ? [{ kind: "barge" }, start] : [start];
      }
      turn.push(window);
      const out: TurnAction[] = [{ kind: "audio", pcm: window }];
      if (turn.length >= ms(config.maxTurnMs)) return [...out, end("long")];
      if (prob >= config.stopProb) {
        if (silence > 0) checkId += 1;
        silence = 0;
        return out;
      }
      silence += 1;
      if (silence >= ms(config.maxSilenceMs)) return [...out, end("silence")];
      if (silence === ms(config.pauseMs)) nextCheck = silence;
      if (silence === nextCheck) {
        nextCheck = silence + ms(config.recheckMs);
        return [...out, { kind: "check", id: checkId, pcm: join(turn) }];
      }
      return out;
    },
    /** Smart Turn's answer to check `id`; stale answers (he spoke again since) are ignored. */
    verdict: (id: number, completeProb: number): TurnAction[] =>
      inTurn && id === checkId && silence > 0 && completeProb >= config.completeProb
        ? [end("complete")]
        : [],
    inTurn: () => inTurn,
  };
};
