// @effect-diagnostics globalDate:off
/**
 * The durable record of what Baton heard and did, one ndjson line each (D120). It stays on his own
 * machine. Dictated words are not written here: they are often someone else's business, so a
 * dictation records its length only.
 */
import { OVER_HER_VOICE, type VoiceCoreEvent } from "@t3tools/tessaya-voice";

/** Stage times are for the turn that follows its words, not one typed a minute later. */
const STAGES_KEPT_MS = 60_000;

export interface VoiceTurnTimings {
  readonly route: string;
  readonly source: string;
  readonly decideMs: number;
  readonly firstSentenceMs: number | null;
  readonly totalMs: number;
  /** What Baton said for this turn, for the record and the History. */
  readonly reply?: string;
}

export interface VoiceTurnLog {
  readonly event: (event: VoiceCoreEvent) => void;
  readonly timings: (timings: VoiceTurnTimings) => void;
  /** Anything else worth the record: an action taken, a window opened. */
  readonly note: (kind: string, fields: Readonly<Record<string, unknown>>) => void;
}

export const makeVoiceTurnLog = (
  write: (line: string) => void,
  clock: () => Date = () => new Date(),
): VoiceTurnLog => {
  interface Wake {
    readonly word: string | null;
    readonly score: number;
    readonly lateMs?: number;
    readonly checkMs?: number;
  }
  let wake: Wake | null = null;
  let transcript: string | null = null;
  let screenTurn: { readonly wake: Wake | null; readonly transcript: string | null } | null = null;
  /** The voice side of the turn being answered, so its line shows where the time went. */
  let speechEnd: { readonly at: number; readonly quietMs: number } | null = null;
  let stages: {
    readonly endpointMs: number | null;
    readonly recogniseMs: number;
    readonly holdMs: number;
    readonly heardAt: number;
    readonly lastWordAt: number | null;
  } | null = null;
  const stageFields = (kind: string, fields: Readonly<Record<string, unknown>>, at: number) => {
    if (stages === null || at - stages.heardAt > STAGES_KEPT_MS) return {};
    const { endpointMs, recogniseMs, holdMs, heardAt, lastWordAt } = stages;
    const base = { endpointMs, recogniseMs, holdMs };
    if (kind === "agent_turn_start") return { ...base, routeMs: at - heardAt };
    stages = null;
    const total = fields["totalMs"];
    const firstAudio = fields["firstAudioMs"];
    return {
      ...base,
      ...(typeof total === "number" && typeof firstAudio === "number" && lastWordAt !== null
        ? { speechToAudioMs: at - total + firstAudio - lastWordAt }
        : {}),
    };
  };
  const note: VoiceTurnLog["note"] = (kind, fields) => {
    const now = clock();
    const timed =
      kind === "agent_turn_start" || kind === "agent_turn" || kind === "turn"
        ? stageFields(kind, fields, now.getTime())
        : {};
    write(`${JSON.stringify({ at: now.toISOString(), kind, ...fields, ...timed })}\n`);
  };
  const clear = () => {
    wake = null;
    transcript = null;
  };
  return {
    note,
    event: (event) => {
      switch (event.type) {
        case "wake":
          if (wake !== null && transcript === null) note("wake_only", { wake });
          wake = {
            word: event.word,
            score: event.score,
            ...(event.lateMs === undefined ? {} : { lateMs: event.lateMs }),
            ...(event.checkMs === undefined ? {} : { checkMs: event.checkMs }),
          };
          return;
        case "transcript":
          transcript = event.text;
          screenTurn = null;
          if (event.recogniseMs !== undefined) {
            stages = {
              endpointMs: speechEnd?.quietMs ?? null,
              recogniseMs: event.recogniseMs,
              holdMs: event.holdMs ?? 0,
              heardAt: clock().getTime(),
              lastWordAt: speechEnd === null ? null : speechEnd.at - speechEnd.quietMs,
            };
          }
          return;
        case "dropped":
          // Over her voice the last wake is not what these words answer to.
          return note("dropped", {
            ...(OVER_HER_VOICE.has(event.reason) ? {} : { wake }),
            text: event.text,
            reason: event.reason,
            ...(event.score === undefined ? {} : { score: event.score }),
            ...(event.vadPeak === undefined
              ? {}
              : { vadPeak: event.vadPeak, vadMean: event.vadMean }),
          });
        case "stop_heard":
          return note("stop", { text: event.text });
        case "dismissed":
          clear();
          return note("dismissed", { text: event.text });
        case "barge_in":
          return note("barge_in", {});
        case "nothing":
          note("nothing_heard", { wake });
          return clear();
        case "error":
          return note("error", { message: event.message });
        case "effect":
          if (event.effect.kind !== "dictate") return;
          note("dictated", { chars: event.effect.text.length });
          return clear();
        case "outcome":
          if ("source" in event.outcome && event.outcome.source === "screen") {
            // Its timings line may follow, or never come (an agent turn): either way this wake is used.
            screenTurn = { wake, transcript };
            return clear();
          }
          if (event.outcome.kind === "dictated") return;
          note("outcome", {
            wake,
            transcript,
            outcome: event.outcome.kind,
            reply: "reply" in event.outcome ? event.outcome.reply : "",
            ...("reason" in event.outcome ? { reason: event.outcome.reason } : {}),
          });
          return clear();
        case "state":
          if (event.state !== "sleeping") return;
          if (wake !== null && transcript === null) note("wake_only", { wake });
          return clear();
        case "speech_end":
          speechEnd = { at: clock().getTime(), quietMs: event.quietMs };
          return note("speech_end", { quietMs: event.quietMs });
        case "thinking":
          return note("processing_start", {});
      }
    },
    timings: (timings) => {
      note("turn", { ...(screenTurn ?? { wake, transcript }), ...timings });
      screenTurn = null;
      clear();
    },
  };
};
