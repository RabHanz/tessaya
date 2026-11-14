/**
 * A live thread must stay bound to the terminal session it mirrors. The decision is pure: from what the thread says
 * about itself and what the running session says, what to do this check.
 */
export interface BindingFacts {
  readonly threadId: string;
  readonly sessionId: string;
  /** The running session found by id, or null when none runs under this id. */
  readonly session: { readonly status: string | null; readonly pane: string | null } | null;
  readonly thread: {
    readonly instanceId: string;
    /** The native session id of the thread's active provider thread, if it has one. */
    readonly nativeId: string | null;
    readonly running: boolean;
  };
}

export type BindingAction =
  /** Bound to its session. */
  | { readonly kind: "ok" }
  /** No running session under this id: nothing to bind to yet. */
  | { readonly kind: "no-session" }
  /** On another provider instance (a handoff session): put it back on the live instance. */
  | { readonly kind: "rebind-instance" }
  /** On the live instance but pointing at no session or another one: point it at this session. */
  | { readonly kind: "rebind-native" }
  /** A turn is running; check again after it. */
  | { readonly kind: "wait" };

export const decideBinding = (facts: BindingFacts): BindingAction => {
  if (facts.session === null) return { kind: "no-session" };
  if (facts.thread.instanceId === "baton-live" && facts.thread.nativeId === facts.sessionId)
    return { kind: "ok" };
  if (facts.thread.running) return { kind: "wait" };
  return facts.thread.instanceId === "baton-live"
    ? { kind: "rebind-native" }
    : { kind: "rebind-instance" };
};

export type ReattachAction =
  | { readonly kind: "already-bound" }
  | { readonly kind: "wait" }
  /** Point the thread at `sessionId` (instance and/or native id as needed). */
  | {
      readonly kind: "rebind";
      readonly sessionId: string;
      readonly pane: string | null;
      readonly instance: boolean;
      readonly native: boolean;
    }
  /** No session has this id, but exactly one runs in the folder: only ever offered, never taken without a yes. */
  | { readonly kind: "confirm"; readonly pane: string }
  | { readonly kind: "none" };

/**
 * Reattach: by session id when one runs under it (the same rule as the 30 s heal); otherwise the single running
 * session in the thread's folder, but only after the person confirmed that exact pane.
 */
export const decideReattach = (input: {
  readonly facts: BindingFacts;
  readonly folderSessions: ReadonlyArray<{
    readonly sessionId: string;
    readonly pane: string | null;
  }>;
  readonly confirmPane: string | null;
}): ReattachAction => {
  const { facts } = input;
  if (facts.session !== null) {
    const action = decideBinding(facts);
    if (action.kind === "ok") return { kind: "already-bound" };
    if (action.kind === "wait") return { kind: "wait" };
    return {
      kind: "rebind",
      sessionId: facts.sessionId,
      pane: facts.session.pane,
      instance: facts.thread.instanceId !== "baton-live",
      native: facts.thread.nativeId !== facts.sessionId,
    };
  }
  const inPanes = input.folderSessions.filter((s) => s.pane !== null);
  const only = inPanes.length === 1 ? inPanes[0]! : null;
  if (only === null || only.pane === null) return { kind: "none" };
  if (input.confirmPane !== only.pane) return { kind: "confirm", pane: only.pane };
  if (facts.thread.running) return { kind: "wait" };
  return {
    kind: "rebind",
    sessionId: only.sessionId,
    pane: only.pane,
    instance: facts.thread.instanceId !== "baton-live",
    native: facts.thread.nativeId !== only.sessionId,
  };
};
