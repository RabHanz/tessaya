/**
 * What the pill says, as a pure reducer. It exists only while something is happening: at rest
 * there is nothing on screen, whatever the background wake listening is doing (D112).
 */
export type TurnPhase =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "working"
  | "dictating"
  | "muted"
  | "done"
  /** The window has closed: from here he needs the wake word again. */
  | "ended"
  | "error";

export interface TurnState {
  readonly phase: TurnPhase;
  /** What was heard, what is running, or what went wrong. */
  readonly caption: string | null;
  /** Something was transcribed since the wake, so a closing window is not "heard nothing". */
  readonly heard: boolean;
  /** The label while `working` or `done`: "Looking", "Driving". */
  readonly label: string | null;
  /** The wake word that fired, or where the words are going. */
  readonly detail: string | null;
  /** A voice window is open, so the pill stays and reads Listening between turns. */
  readonly open: boolean;
  /** The window closed under something else: the end shows when that finishes. */
  readonly closing: boolean;
  /** Dictation is being written out or tidied: the waveform sweeps instead of hearing him. */
  readonly tidying?: boolean;
}

export type TurnEvent =
  | { readonly type: "wake"; readonly word: string | null }
  | { readonly type: "heard"; readonly text: string }
  | { readonly type: "thinking" }
  | { readonly type: "speaking"; readonly active: boolean }
  /** Where his words are going, once the router has a target. */
  | { readonly type: "target"; readonly name: string | null }
  /** The assistant is looking, driving or teaching; null when it stops. */
  | { readonly type: "activity"; readonly label: string | null; readonly caption?: string }
  | { readonly type: "dictating"; readonly caption: string | null; readonly tidying?: boolean }
  | { readonly type: "muted"; readonly on: boolean }
  /** A brief confirmation: "Pasted", "Sent". */
  | { readonly type: "done"; readonly label: string }
  /** Four seconds of a dead level while listening. */
  | { readonly type: "silent" }
  /** A wake or conversation window is open. */
  | { readonly type: "window_open" }
  /** Words were heard and set aside, so nothing is being worked out. */
  | { readonly type: "resume" }
  /** A wake the second check did not confirm: worth saying only while the pill says Listening. */
  | { readonly type: "unconfirmed" }
  /** The wake or conversation window closed. */
  | { readonly type: "window_closed" }
  /** The turn's words have been dealt with and nothing more is coming. */
  | { readonly type: "finished" }
  | { readonly type: "dismissed" }
  | { readonly type: "failed"; readonly message: string }
  /** Trouble worth raising even with no turn running: the microphone dropped. */
  | { readonly type: "trouble"; readonly message: string };

export const IDLE_TURN: TurnState = {
  phase: "idle",
  caption: null,
  heard: false,
  label: null,
  detail: null,
  open: false,
  closing: false,
};
/** Long enough to read, short enough not to linger. */
export const TURN_ERROR_MS = 3_500;
export const TURN_BRIEF_MS = 1_600;
/** A turn that never reports an end still leaves the screen. */
export const TURN_LIMIT_MS = 90_000;
export const SILENT_AFTER_MS = 4_000;

const FINISHING = "Finishing";
const NOTHING_HEARD = "Didn't catch that";
const ENDED_LABEL = "Not listening";
const WAKE_AGAIN = "Say the wake word";
const NOT_HEARING = "Not hearing your mic";
const CAPTION_CHARS = 90;

const short = (text: string): string =>
  text.length > CAPTION_CHARS ? `${text.slice(0, CAPTION_CHARS)}…` : text;

/**
 * Something finished. With the window still open for a follow-up the pill goes back to Listening,
 * so he can see Baton is hearing him; a window that closed under it shows its end once.
 */
const settle = (state: TurnState): TurnState => {
  if (state.closing) return { ...IDLE_TURN, phase: "ended", caption: WAKE_AGAIN };
  return state.open ? { ...IDLE_TURN, phase: "listening", heard: true, open: true } : IDLE_TURN;
};

/** What may change a spoken dictation's pill: only dictation itself, his mute, or trouble with the microphone. */
const MOVES_DICTATION = new Set<TurnEvent["type"]>([
  "dictating",
  "done",
  "muted",
  "trouble",
  "target",
]);

/** Where his words will go and the last of them, so he can see it is hearing him; the stop phrase before he speaks. */
export const dictationCaption = (into: string | null, said: string): string => {
  const words = said.trim().split(/\s+/).filter(Boolean);
  const tail = words.length > 5 ? `…${words.slice(-5).join(" ")}` : words.join(" ");
  if (into === null) return tail === "" ? 'Say "stop dictation" to insert' : tail;
  return `Into ${into} · ${tail === "" ? 'say "stop dictation"' : tail}`;
};

export const reduceTurn = (state: TurnState, event: TurnEvent): TurnState => {
  // Spoken dictation stays on screen for as long as it is on: her closing line or a stray click must not hide it.
  if (state.phase === "dictating" && state.open && !MOVES_DICTATION.has(event.type)) return state;
  switch (event.type) {
    case "wake":
      // A wake word changes nothing in spoken dictation, so "Alfred, stop dictating" stays Dictating.
      if (state.phase === "dictating" && state.open) return state;
      return { ...IDLE_TURN, phase: "listening", detail: event.word, open: true };
    case "window_open":
      if (state.open) return state;
      return state.phase === "idle" || state.phase === "ended"
        ? { ...IDLE_TURN, phase: "listening", heard: true, open: true }
        : { ...state, open: true, closing: false };
    case "unconfirmed":
      if (state.phase === "listening")
        return {
          ...IDLE_TURN,
          phase: "error",
          caption: NOTHING_HEARD,
          open: state.open,
          closing: state.closing,
        };
      return state.phase === "thinking" ? settle(state) : state;
    case "resume":
      return state.phase === "thinking" ? settle(state) : state;
    case "heard":
      return state.phase === "idle" || state.phase === "dictating"
        ? state
        : { ...state, phase: "thinking", label: null, caption: short(event.text), heard: true };
    // His speech ended and recognition is running: never Listening from here.
    case "thinking":
      return state.phase === "listening" || state.phase === "idle"
        ? { ...state, phase: "thinking", label: FINISHING }
        : state;
    case "speaking":
      if (event.active) return { ...state, phase: "speaking", label: null };
      return state.phase === "speaking" ? settle(state) : state;
    case "target":
      return state.phase === "idle" ? state : { ...state, detail: event.name };
    case "activity":
      if (event.label === null) return state.phase === "working" ? settle(state) : state;
      return {
        ...state,
        phase: state.phase === "speaking" ? "speaking" : "working",
        label: event.label,
        caption: event.caption ?? null,
      };
    case "dictating":
      if (event.caption === null) return state.phase === "dictating" ? settle(state) : state;
      return {
        ...IDLE_TURN,
        phase: "dictating",
        caption: event.caption,
        open: state.open,
        closing: state.closing,
        tidying: event.tidying === true,
      };
    case "muted":
      if (event.on) return { ...IDLE_TURN, phase: "muted" };
      return state.phase === "muted" ? settle(state) : state;
    case "done":
      // Spoken dictation carries on after each chunk lands, so Dictating stays up.
      if (state.phase === "dictating" && state.open) {
        return { ...state, caption: short(event.label) };
      }
      return state.phase === "idle" || state.phase === "dictating"
        ? { ...IDLE_TURN, phase: "done", label: event.label, open: state.open }
        : state;
    case "silent":
      return state.phase === "listening" && !state.heard
        ? { ...state, caption: NOT_HEARING }
        : state;
    case "window_closed":
      if (state.phase === "listening") {
        return {
          ...IDLE_TURN,
          phase: "ended",
          label: state.heard ? null : NOTHING_HEARD,
          caption: WAKE_AGAIN,
        };
      }
      if (state.phase === "idle" || state.phase === "ended") return state;
      return { ...state, open: false, closing: state.open || state.closing };
    case "finished":
      return state.phase === "speaking" ||
        state.phase === "error" ||
        state.phase === "dictating" ||
        state.phase === "muted"
        ? state
        : settle(state);
    case "dismissed":
      return IDLE_TURN;
    case "failed":
      return state.phase === "idle"
        ? state
        : {
            ...IDLE_TURN,
            phase: "error",
            caption: short(event.message),
            heard: state.heard,
            open: state.open,
            closing: state.closing,
          };
    case "trouble":
      return { ...IDLE_TURN, phase: "error", caption: short(event.message) };
  }
};

export type WaveMode = "live" | "sweep" | "flat";

export interface TurnView {
  readonly label: string;
  /** A second, quieter word: the wake word, the target, what was heard. */
  readonly caption: string | null;
  readonly tone: "plain" | "voice" | "write" | "warn" | "off" | "good";
  readonly wave: WaveMode;
}

const views: Record<Exclude<TurnPhase, "idle">, Omit<TurnView, "caption">> = {
  listening: { label: "Listening", tone: "plain", wave: "live" },
  thinking: { label: "Thinking", tone: "plain", wave: "sweep" },
  speaking: { label: "Speaking", tone: "voice", wave: "live" },
  working: { label: "Working", tone: "voice", wave: "sweep" },
  dictating: { label: "Dictating", tone: "write", wave: "live" },
  muted: { label: "Muted", tone: "off", wave: "flat" },
  done: { label: "Done", tone: "good", wave: "flat" },
  ended: { label: ENDED_LABEL, tone: "off", wave: "flat" },
  error: { label: "Didn't work", tone: "warn", wave: "flat" },
};

export const turnView = (state: TurnState): TurnView | null => {
  if (state.phase === "idle") return null;
  const view = views[state.phase];
  // An error's words are the headline; there is nothing to add beside them.
  if (state.phase === "error") {
    return { ...view, label: state.caption ?? view.label, caption: null };
  }
  const parts = [state.caption, state.detail].filter((part) => part !== null);
  return {
    ...view,
    ...(state.phase === "dictating" && state.tidying === true ? { wave: "sweep" as const } : {}),
    label: state.label ?? view.label,
    caption: parts.length > 0 ? parts[0]! : null,
  };
};

/** How long a phase may stay up with nothing further happening. */
export const turnLimitMs = (phase: TurnPhase): number =>
  phase === "error" || phase === "ended"
    ? TURN_ERROR_MS
    : phase === "done" || phase === "muted"
      ? TURN_BRIEF_MS
      : TURN_LIMIT_MS;

/**
 * Esc belongs to his apps unless Baton's voice window is open: while it listens, thinks, speaks or
 * works, Esc ends it from any app. Dictation holds it itself, a drive as its safety stop, and the
 * ask box and prompts hear it through their own focus.
 */
export const turnHoldsEscape = (state: TurnState): boolean =>
  state.phase === "listening" ||
  state.phase === "thinking" ||
  state.phase === "speaking" ||
  state.phase === "working";

/** Peak of a frame on a rough 0..1 scale for the waveform. */
export const frameLevel = (frame: Int16Array): number => {
  let peak = 0;
  for (let i = 0; i < frame.length; i += 8) peak = Math.max(peak, Math.abs(frame[i]!));
  return Math.min(1, Math.sqrt(peak / 32768) * 1.4);
};

/** Voiced frames the speech reference is taken over: 3 s at 50 frames a second. */
const REFERENCE_FRAMES = 150;
/** Over voiced frames the floor only creeps up this far a frame (0.5 dB a second), so a long sentence never lifts it. */
const FLOOR_CREEP_DB = 0.01;
/** Digital silence reads no lower than this, so it never drags the floor below any real room. */
const QUIETEST_DB = -90;
/** Bars span this many dB below his reference; 3 dB above it is the top. */
const SHOWN_RANGE_DB = 20;
/** A frame this far over the noise floor is his voice. */
const VOICED_OVER_FLOOR_DB = 9;
/** A peak stays this many frames (80 ms) before it falls, so a syllable's top is seen. */
const PEAK_HOLD_FRAMES = 4;

/**
 * The pill's bars against his own speech level (a display AGC): dB over his reference (the p90 of voiced frames in the
 * last 3 s) above a floor learned only from the room, with a short peak hold. `reset` at each recording and new mic.
 * Display only: recognition, silence detection and the mic test keep `frameLevel`.
 */
export const createSpeechGain = () => {
  let floor: number | null = null;
  let reference = -30;
  const voiced: number[] = [];
  let held = 0;
  let holding = 0;
  const gain = (level: number): number => {
    // frameLevel is 1.4 * sqrt(peak): back to the peak in dBFS.
    const db = Math.max(QUIETEST_DB, level > 0 ? 40 * Math.log10(level / 1.4) : QUIETEST_DB);
    // The room is learned only from frames that are not his voice: down quickly, up slowly. Digital silence (a muted
    // or starting device) says nothing about the room and is left out.
    const silent = db <= QUIETEST_DB;
    if (!silent) floor ??= db;
    const isVoiced = floor !== null && db > floor + VOICED_OVER_FLOOR_DB;
    if (floor !== null && !silent)
      floor = isVoiced ? floor + FLOOR_CREEP_DB : floor + (db - floor) * (db < floor ? 0.3 : 0.05);
    if (isVoiced) {
      voiced.push(db);
      if (voiced.length > REFERENCE_FRAMES) voiced.shift();
      const sorted = [...voiced].sort((a, b) => a - b);
      reference = Math.min(
        -6,
        Math.max(
          -50,
          (floor ?? -90) + VOICED_OVER_FLOOR_DB + 6,
          sorted[Math.floor(sorted.length * 0.9)]!,
        ),
      );
    }
    const shown = isVoiced
      ? Math.max(0, Math.min(1, (db - reference + SHOWN_RANGE_DB) / (SHOWN_RANGE_DB + 3)))
      : 0;
    if (shown >= held) {
      held = shown;
      holding = PEAK_HOLD_FRAMES;
    } else if (holding > 0) holding -= 1;
    else held = Math.max(shown, held * 0.6);
    return held;
  };
  return Object.assign(gain, {
    /** A new recording or microphone: its own room and his level there, learned afresh. */
    reset: () => {
      floor = null;
      reference = -30;
      voiced.length = 0;
      held = 0;
      holding = 0;
    },
  });
};

/** A spoken cancel, with any wake word already stripped: it dismisses the pill at once. */
export const isCancelPhrase = (text: string): boolean =>
  /^(?:cancel(?: that)?|never ?mind|scratch that|forget it)[.!]?$/i.test(text.trim());

const NEUTRAL = String.raw`okay|ok|alright|right|yeah|please|now|for now|sir`;
const DISMISS_ATOM = String.raw`dismiss(?:ed)?|go away|leave it|never ?mind|forget it|scratch that|cancel(?: that)?|stop(?: it| that| listening)?|(?:be )?quiet|enough|that'?s enough|that(?:'s| is|'ll be| will be| would be) (?:all|it)|nothing|no(?:pe)?|nah|thanks?|tanks?|thank you(?: very much)?|cheers|bye(?: bye)?|goodbye|good bye|see you|see ya`;
const DISMISS = new RegExp(String.raw`^(?:(?:${NEUTRAL}|${DISMISS_ATOM})(?: |$)){1,4}$`);
const NEUTRAL_ONLY = new RegExp(String.raw`^(?:(?:${NEUTRAL})(?: |$))+$`);

const plain = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const ANSWER_NEUTRAL = String.raw`right|please|then|now|sir|thanks|thank you|just|well|oh|mate`;
const YES_ATOM = String.raw`yes|yeah|yea|yep|yup|aye|sure|ok|okay|alright|all right|fine|correct|that's right|confirm(?:ed)?|approve(?:d)?|go ahead|go on|go for it|do it|do that|send it|carry on|proceed|please do|sounds good|absolutely|definitely|of course|why not|let's do it`;
const NO_ATOM = String.raw`no|nope|nah|cancel(?: it| that)?|stop|don't(?: do it)?|do not|never ?mind|abort|not now|not yet|leave it|forget it|scratch that|hold on|wait`;
const wholly = (atoms: string) =>
  new RegExp(String.raw`^(?:(?:${ANSWER_NEUTRAL}|${atoms})(?: |$)){1,6}$`);
const YES = wholly(YES_ATOM);
const NO = wholly(NO_ATOM);
const NEUTRAL_ANSWER = wholly("(?!)");
/** After a yes, words that only ask for it again or for no more asking: "go ahead and don't ask me again". */
const YES_TAIL = String.raw`(?:and )?(?:try|do it|do that)(?: it)? again|again|(?:and )?(?:don't|do not|never) ask(?: me)?(?: that| about that)?(?: again)?|(?:and )?always|from now on|every time|no need to ask`;
const YES_THEN = new RegExp(
  String.raw`^(?:(?:${ANSWER_NEUTRAL}|${YES_ATOM})(?: |$)){1,6}(?:(?:${ANSWER_NEUTRAL}|${YES_TAIL})(?: |$)){1,3}$`,
);
const STANDING = /\b(?:(?:don't|do not|never) ask|always|from now on|every time|no need to ask)\b/;

/**
 * The answer to a yes-or-no question, by the whole utterance, as dismissal is: "yeah go on then"
 * is a yes, "no, send it to Sam instead" is neither, and that goes to the assistant as a new ask.
 */
export const answerOf = (text: string): "yes" | "no" | null => {
  const words = plain(text);
  if (words === "" || NEUTRAL_ANSWER.test(words)) return null;
  if (YES.test(words) || YES_THEN.test(words)) return "yes";
  if (NO.test(words)) return "no";
  return null;
};

/** A yes that also says not to ask about this again: his standing yes for it. */
export const isStandingYes = (text: string): boolean =>
  answerOf(text) === "yes" && STANDING.test(plain(text));

/**
 * The whole utterance is only a dismissal ("stop", "nothing, dismiss", "okay that will be all
 * tanks"), read as Baton heard it. Any other word makes it an ask for the assistant, never this.
 */
export const isDismissPhrase = (text: string): boolean => {
  const words = plain(text);
  return words.length > 0 && DISMISS.test(words) && !NEUTRAL_ONLY.test(words);
};
