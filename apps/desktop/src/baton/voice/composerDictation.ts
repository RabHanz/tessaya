// @effect-diagnostics globalTimers:off -- Electron IPC answers, not an Effect program
/**
 * Dictation into Tessaya's own chat box: when the window with the keyboard is ours and its composer claims the
 * dictation, the composer draws the words at its caret and takes the cleaned ones itself. No floating pill shows and
 * nothing is pasted. A composer that does not answer in time gets today's pill and paste, so nothing is ever lost.
 */
import type { ComposerDictationMessage, ComposerDictationReply } from "@t3tools/baton-contracts";
import type { TurnEvent } from "@t3tools/baton-shared/voiceTurn";
import { waveEngine } from "@t3tools/baton-shared/waveform";

const WAVE = waveEngine();

/** A renderer that can take the dictation: our window that had the keyboard as it started. */
export interface ComposerTarget {
  readonly send: (message: ComposerDictationMessage) => void;
  readonly gone: () => boolean;
  /** The window says its chat box has the keyboard (it reports every focus change), so it is asked at all. */
  readonly focused: () => boolean;
}

/** How long a composer has to claim the dictation before the pill shows, and to take the words before they paste. */
export const CLAIM_MS = 250;
export const COMMIT_MS = 1_500;

type Asked = Extract<ComposerDictationReply, { readonly ok: boolean }>["type"];

interface Session {
  readonly id: number;
  readonly target: ComposerTarget;
  /** Null while the claim is out. */
  claimed: boolean | null;
  claim: Promise<boolean>;
}

export const createComposerDictation = (input: {
  readonly target: () => ComposerTarget | null;
  /** ✓ or ✕ on the composer's control: the same as on the pill. */
  readonly onAction: (insert: boolean) => void;
}) => {
  let seq = 0;
  let session: Session | null = null;
  const waits = new Map<string, (ok: boolean) => void>();
  const ask = (s: Session, message: ComposerDictationMessage, type: Asked, ms: number) =>
    new Promise<boolean>((resolve) => {
      const key = `${s.id}:${type}`;
      const timer = setTimeout(() => {
        waits.delete(key);
        resolve(false);
      }, ms);
      waits.set(key, (ok) => {
        clearTimeout(timer);
        waits.delete(key);
        resolve(ok);
      });
      if (s.target.gone()) return waits.get(key)?.(false);
      s.target.send(message);
    });
  const live = () =>
    session !== null && session.claimed !== false && !session.target.gone() ? session : null;
  const tell = (message: (id: number) => ComposerDictationMessage) => {
    const s = live();
    if (s !== null) s.target.send(message(s.id));
  };
  const end = () => {
    const s = session;
    session = null;
    return s;
  };

  return {
    /**
     * The key went down, or a recording started: the press and its recording are one dictation, so a second call
     * only tells its mode. Only a window whose chat box has the keyboard is asked; `active()` holds the pill from
     * this moment, before anything could show it. Resolves true when the chat box took it.
     */
    start: (mode: "held" | "free"): Promise<boolean> => {
      const current = live();
      if (current !== null) {
        current.target.send({ type: "mode", id: current.id, mode });
        return current.claim;
      }
      end();
      const target = input.target();
      if (target === null || !target.focused()) return Promise.resolve(false);
      const id = ++seq;
      const claimed = (s: Session) =>
        ask(s, { type: "start", id, mode }, "claimed", CLAIM_MS).then((ok) => {
          if (session === s) s.claimed = ok;
          return ok && session === s;
        });
      const s: Session = { id, target, claimed: null, claim: Promise.resolve(false) };
      session = s;
      s.claim = claimed(s);
      return s.claim;
    },
    /** A composer has (or may yet claim) this dictation: the floating pill and the paste stay away. */
    active: () => live() !== null,
    mode: (mode: "held" | "free") => tell((id) => ({ type: "mode", id, mode })),
    level: (db: number) => tell((id) => ({ type: "level", id, db })),
    words: (text: string) => tell((id) => ({ type: "words", id, text })),
    finish: () => tell((id) => ({ type: "finish", id })),
    /** The cleaned words: true when the composer took them; false pastes them as before. */
    commit: (text: string): Promise<boolean> => {
      const s = live();
      if (s === null) return Promise.resolve(false);
      session = null;
      // A claim still out is a claim missed: nothing waits on it any more.
      if (s.claimed !== true) return Promise.resolve(false);
      return ask(s, { type: "commit", id: s.id, text }, "took", COMMIT_MS);
    },
    /** Nothing came of it, or ✕ / Esc threw it away: the composer puts the draft back as it was. */
    cancel: () => {
      const s = end();
      if (s !== null && s.claimed !== false && !s.target.gone())
        s.target.send({ type: "cancel", id: s.id });
    },
    reply: (reply: ComposerDictationReply) => {
      if (reply.type === "action") {
        if (session?.id === reply.id) input.onAction(reply.insert);
        return;
      }
      waits.get(`${reply.id}:${reply.type}`)?.(reply.ok);
    },
  };
};
export type ComposerDictation = ReturnType<typeof createComposerDictation>;

/** The pill's dictation events stay off the screen while the composer shows the dictation. */
const DICTATION_EVENTS: ReadonlySet<TurnEvent["type"]> = new Set(["dictating", "done"]);

/**
 * The pill, with its dictation shown in the composer instead while one has it: the dictating and done states are
 * held back (the last one is replayed if the claim fails), and the words and level go to the composer.
 */
export const routePill = <
  P extends {
    readonly on: (event: TurnEvent, options?: { readonly silent?: boolean }) => void;
    readonly micLevel: (value: number, shown?: number, frame?: Int16Array) => void;
    readonly words: (text: string) => void;
  },
>(
  pill: P,
  composer: Pick<ComposerDictation, "active" | "level" | "words">,
): P & { readonly replay: () => void } => {
  let held: readonly [TurnEvent, { readonly silent?: boolean } | undefined] | null = null;
  return {
    ...pill,
    on: (event, options) => {
      if (composer.active() && DICTATION_EVENTS.has(event.type)) {
        held = [event, options];
        return;
      }
      held = null;
      pill.on(event, options);
    },
    micLevel: (value, shown, frame) => {
      // The frame's own RMS in dBFS, as the pill draws it: the shown level is a square root, too flat to move it.
      if (composer.active())
        composer.level(frame === undefined ? WAVE.dbOf(value) : WAVE.frameDb(frame));
      else pill.micLevel(value, shown, frame);
    },
    words: (text) => (composer.active() ? composer.words(text) : pill.words(text)),
    replay: () => {
      const last = held;
      held = null;
      if (last !== null) pill.on(last[0], last[1]);
    },
  };
};
