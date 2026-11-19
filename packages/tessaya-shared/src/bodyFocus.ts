/**
 * Which of her threads drives one body (architecture §3.3), the rules alone: the thread he is present in now, a scene
 * holding the body until it ends or he interrupts, and a way back from every state. Pure, as voiceArbiter is.
 */

/** How he is present in a thread, strongest first. */
export type PresenceSignal = "speak" | "touch" | "type" | "look";
const STRENGTH: Readonly<Record<PresenceSignal, number>> = { speak: 4, touch: 3, type: 2, look: 1 };
/** An equal or weaker signal from another thread takes the body only this long after the last one. */
export const HANDOVER_MS = 2_000;
/** A paused scene resumes if he comes back to its thread within this, else it closes. */
export const SCENE_RESUME_MS = 10 * 60_000;

export type Focus =
  | { readonly state: "rest" }
  | {
      readonly state: "engaged";
      readonly thread: string;
      readonly signal: PresenceSignal;
      readonly at: number;
    }
  | {
      readonly state: "scene";
      readonly thread: string;
      readonly scene: string;
      readonly until: number;
    }
  | {
      readonly state: "paused";
      readonly thread: string;
      readonly scene: string;
      readonly at: number;
      /** How much of the scene was still to play. */
      readonly left: number;
      /** The thread that took the body when he interrupted, if any. */
      readonly engaged: string | null;
    };

export type FocusEvent =
  | {
      readonly kind: "presence";
      readonly thread: string;
      readonly signal: PresenceSignal;
      readonly at: number;
    }
  | {
      readonly kind: "sceneStart";
      readonly thread: string;
      readonly scene: string;
      readonly at: number;
      readonly ms: number;
    }
  | { readonly kind: "sceneEnd"; readonly thread: string; readonly at: number }
  /** A barge-in or a stop word: a scene pauses, and the thread he speaks in next takes the body. */
  | { readonly kind: "interrupt"; readonly at: number }
  /** "Carry on": a paused scene plays again. */
  | { readonly kind: "resume"; readonly at: number }
  /** A thread reached its conversation's idle boundary. */
  | { readonly kind: "idle"; readonly thread: string; readonly at: number }
  /** A private lease ended: its threads lose the body at once. */
  | { readonly kind: "privateEnd"; readonly threads: ReadonlyArray<string>; readonly at: number };

export interface FocusStep {
  readonly focus: Focus;
  /** Who held the body and who holds it now, when that changed (the `body.focus` record). */
  readonly handover: {
    readonly from: string | null;
    readonly to: string | null;
    readonly reason: string;
  } | null;
  /** Why a scene could not start: another thread's scene holds the body. */
  readonly refused?: string;
}

export const REST: Focus = { state: "rest" };

/** The thread whose cues reach the body now; null at rest, when any thread may move her. */
export const holderOf = (f: Focus): string | null =>
  f.state === "rest" ? null : f.state === "paused" ? f.engaged : f.thread;

/** Whether a thread's moves reach the body: its holder's, or anyone's at rest. */
export const mayDrive = (f: Focus, thread: string): boolean => {
  const h = holderOf(f);
  return h === null || h === thread;
};

/** Time alone moves a body: a scene that played out is over, and a pause left too long closes. */
const settle = (f: Focus, now: number): Focus =>
  f.state === "scene" && now >= f.until
    ? { state: "engaged", thread: f.thread, signal: "look", at: f.until }
    : f.state === "paused" && now - f.at > SCENE_RESUME_MS
      ? f.engaged === null
        ? REST
        : { state: "engaged", thread: f.engaged, signal: "look", at: f.at }
      : f;

export const nextFocus = (before: Focus, e: FocusEvent): FocusStep => {
  const f = settle(before, e.at);
  const to = (focus: Focus, reason: string): FocusStep => {
    const from = holderOf(before);
    const now = holderOf(focus);
    return { focus, handover: from === now ? null : { from, to: now, reason } };
  };
  switch (e.kind) {
    case "presence": {
      const engaged: Focus = { state: "engaged", thread: e.thread, signal: e.signal, at: e.at };
      if (f.state === "rest") return to(engaged, e.signal);
      if (f.state === "engaged") {
        if (f.thread === e.thread) return to(engaged, e.signal);
        const stronger = STRENGTH[e.signal] > STRENGTH[f.signal];
        return stronger || e.at - f.at >= HANDOVER_MS ? to(engaged, e.signal) : to(f, e.signal);
      }
      if (f.state === "scene") {
        // Speaking, touching or typing elsewhere interrupts her scene; a look does not.
        if (f.thread === e.thread || e.signal === "look") return to(f, e.signal);
        return to(
          {
            state: "paused",
            thread: f.thread,
            scene: f.scene,
            at: e.at,
            left: f.until - e.at,
            engaged: e.thread,
          },
          "interrupted",
        );
      }
      // Paused: back in the scene's own thread picks it up where it was; anywhere else takes the body for now.
      if (e.thread === f.thread)
        return to(
          { state: "scene", thread: f.thread, scene: f.scene, until: e.at + f.left },
          "resumed",
        );
      // Another thread takes it from the one that interrupted only as it would from an engaged one.
      const settled =
        f.engaged === null ||
        f.engaged === e.thread ||
        e.signal === "speak" ||
        e.at - f.at >= HANDOVER_MS;
      return to(settled ? { ...f, engaged: e.thread } : f, e.signal);
    }
    case "sceneStart": {
      const h = holderOf(f);
      if (f.state === "scene" && f.thread !== e.thread)
        return { ...to(f, "refused"), refused: "another conversation's scene holds her body" };
      return to(
        { state: "scene", thread: e.thread, scene: e.scene, until: e.at + e.ms },
        h === e.thread ? "scene" : "scene took the body",
      );
    }
    case "sceneEnd":
      return (f.state === "scene" || f.state === "paused") && f.thread === e.thread
        ? to(
            f.state === "paused" && f.engaged !== null
              ? { state: "engaged", thread: f.engaged, signal: "look", at: e.at }
              : { state: "engaged", thread: e.thread, signal: "look", at: e.at },
            "scene ended",
          )
        : to(f, "scene ended");
    case "interrupt":
      return f.state === "scene"
        ? to(
            {
              state: "paused",
              thread: f.thread,
              scene: f.scene,
              at: e.at,
              left: f.until - e.at,
              engaged: null,
            },
            "interrupted",
          )
        : to(f, "interrupted");
    case "resume":
      return f.state === "paused"
        ? to({ state: "scene", thread: f.thread, scene: f.scene, until: e.at + f.left }, "resumed")
        : to(f, "resumed");
    case "idle":
      return f.state === "engaged" && f.thread === e.thread ? to(REST, "idle") : to(f, "idle");
    case "privateEnd": {
      const gone = new Set(e.threads);
      if (f.state === "rest") return to(f, "private ended");
      if (f.state === "paused") {
        if (gone.has(f.thread))
          return to(
            f.engaged === null || gone.has(f.engaged)
              ? REST
              : { state: "engaged", thread: f.engaged, signal: "look", at: e.at },
            "private ended",
          );
        return to(
          f.engaged !== null && gone.has(f.engaged) ? { ...f, engaged: null } : f,
          "private ended",
        );
      }
      return to(gone.has(f.thread) ? REST : f, "private ended");
    }
  }
};
