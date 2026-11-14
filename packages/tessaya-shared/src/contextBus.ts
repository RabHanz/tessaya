/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The desktop context bus, as a pure reducer, and §14's ladder over it.
 *
 * §15 asks for a local service that several producers write to and the voice
 * surface reads from. The part worth testing is not the IPC — it is the
 * arithmetic: which producer's fact wins, when a fact stops counting, and
 * which rung of §14 a given sentence lands on. That is what this module is.
 *
 * Three rules, each of which is a failure it prevents:
 *
 *   1. **One slot per producer.** VS Code going quiet must not erase what the
 *      browser just said. A single merged snapshot would let the last writer
 *      delete every other producer's facts.
 *   2. **Facts expire.** A producer that stopped reporting is not evidence of
 *      where the user is now. Routing a message into a VS Code window that was
 *      closed ten minutes ago is exactly the failure §14 exists to prevent, and
 *      an unexpiring bus makes it certain.
 *   3. **The ladder stops where the facts stop.** Each rung below is a rung
 *      some producer actually reports. Nothing here infers, and nothing here
 *      consults a model — §14's rung 8 is a semantic resolver and this module
 *      does not have one.
 *
 * @module batonContextBus
 */
import {
  CONTEXT_SNAPSHOT_TTL_MS,
  type BatonContextProducer,
  type BatonContextSnapshot,
  type BatonFocusTarget,
} from "@t3tools/tessaya-contracts";

/** The bus's whole state: the latest snapshot from each producer. */
export interface ContextBusState {
  readonly snapshots: ReadonlyMap<BatonContextProducer, BatonContextSnapshot>;
}

export const emptyContextBus: ContextBusState = { snapshots: new Map() };

/**
 * Apply one producer's report.
 *
 * An older snapshot from the same producer is dropped rather than applied:
 * IPC does not promise ordering, and a late arrival that overwrites a newer
 * fact is a context bus lying about the present.
 */
export const applyContextSnapshot = (
  state: ContextBusState,
  snapshot: BatonContextSnapshot,
): ContextBusState => {
  const existing = state.snapshots.get(snapshot.producer);
  if (existing !== undefined && Date.parse(existing.observedAt) > Date.parse(snapshot.observedAt)) {
    return state;
  }
  const next = new Map(state.snapshots);
  next.set(snapshot.producer, snapshot);
  return { snapshots: next };
};

/** Forget a producer entirely — the extension disconnected, the window closed. */
export const dropContextProducer = (
  state: ContextBusState,
  producer: BatonContextProducer,
): ContextBusState => {
  if (!state.snapshots.has(producer)) return state;
  const next = new Map(state.snapshots);
  next.delete(producer);
  return { snapshots: next };
};

/** The snapshots still young enough to be evidence, newest first. */
export const liveSnapshots = (
  state: ContextBusState,
  now: number,
  ttlMs: number = CONTEXT_SNAPSHOT_TTL_MS,
): ReadonlyArray<BatonContextSnapshot> =>
  [...state.snapshots.values()]
    .filter((snapshot) => now - Date.parse(snapshot.observedAt) <= ttlMs)
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));

const snapshotOf = (
  snapshots: ReadonlyArray<BatonContextSnapshot>,
  producer: BatonContextProducer,
): BatonContextSnapshot | null =>
  snapshots.find((snapshot) => snapshot.producer === producer) ?? null;

/**
 * §14's rungs, named. The number is the specification's, so a reader can check
 * this against the document rather than against the code's own vocabulary.
 */
export type ContextRung =
  | "utterance" // 1 — an explicit target in the sentence; resolved by the grammar, not here
  | "voice_conversation" // 2
  | "fabric_focus" // 3
  | "vscode" // 4
  | "editable_field" // 5
  | "most_recent" // 6
  | "none";

export interface ContextResolution {
  readonly workSessionId: string | null;
  readonly rung: ContextRung;
  /** What the rung was read from, for the read-back and for debugging. */
  readonly evidence: string | null;
}

/**
 * Which work session a sentence with no explicit target belongs to.
 *
 * Rung 1 is missing on purpose: an explicit target lives in the words, and the
 * grammar resolves it before this is consulted. Everything here is the
 * question "and if they did not say?".
 */
export const resolveContextWorkSession = (
  state: ContextBusState,
  input: {
    readonly now: number;
    readonly ttlMs?: number;
    /** The work session the user most recently interacted with, if any. */
    readonly mostRecentWorkSessionId?: string | null;
  },
): ContextResolution => {
  const snapshots = liveSnapshots(state, input.now, input.ttlMs ?? CONTEXT_SNAPSHOT_TTL_MS);

  // 2 — the target an ongoing voice conversation is already pointed at.
  const voice = snapshotOf(snapshots, "voice");
  if (voice?.recentVoiceTarget != null) {
    return {
      workSessionId: voice.recentVoiceTarget,
      rung: "voice_conversation",
      evidence: "the current voice conversation",
    };
  }

  // 3 — what the user has open in Baton.
  const baton = snapshotOf(snapshots, "fabric");
  if (baton?.activeWorkSessionId != null) {
    return {
      workSessionId: baton.activeWorkSessionId,
      rung: "fabric_focus",
      evidence: "what is open in Tessaya",
    };
  }

  // 4 — the VS Code window, but only when it is already linked to work. An
  // unlinked window says where the user is and not what they mean.
  const vscode = snapshotOf(snapshots, "vscode");
  if (vscode?.vscode?.workSessionId != null) {
    return {
      workSessionId: vscode.vscode.workSessionId,
      rung: "vscode",
      evidence:
        vscode.vscode.workspaceFolder === null
          ? "the VS Code window"
          : `the VS Code window on ${vscode.vscode.workspaceFolder}`,
    };
  }

  // 6 — whatever moved last. Rung 5 is an editable field, which is a
  // dictation target rather than a work session, and is resolved separately.
  if (input.mostRecentWorkSessionId != null) {
    return {
      workSessionId: input.mostRecentWorkSessionId,
      rung: "most_recent",
      evidence: "the work that moved last",
    };
  }

  return { workSessionId: null, rung: "none", evidence: null };
};

/**
 * Where dictated text would go — §14's rung 5, and §18's job.
 *
 * Deliberately separate from the work-session resolution: "tell Claude to run
 * the tests" and "dictate: thanks, I'll send it tomorrow" are different
 * intents with different destinations, and §12.3 says they must stay
 * distinguishable. Conflating them is how dictation ends up in an agent's
 * prompt.
 */
export const resolveInjectionTarget = (
  state: ContextBusState,
  input: { readonly now: number; readonly ttlMs?: number },
): BatonFocusTarget | null => {
  const snapshots = liveSnapshots(state, input.now, input.ttlMs ?? CONTEXT_SNAPSHOT_TTL_MS);
  // Newest first, and the first producer that says it can take text wins. A
  // producer that reports a field but cannot insert into it is not a target —
  // saying so is §18's honesty requirement, not a detail.
  for (const snapshot of snapshots) {
    const target = snapshot.editableTarget;
    if (target !== null && target.injectable) return target;
  }
  return null;
};

/** The same question, answered with the reason when the answer is no. */
export const describeInjectionTarget = (
  state: ContextBusState,
  input: { readonly now: number; readonly ttlMs?: number },
): { readonly target: BatonFocusTarget | null; readonly reason: string } => {
  const target = resolveInjectionTarget(state, input);
  if (target !== null) return { target, reason: "" };
  const snapshots = liveSnapshots(state, input.now, input.ttlMs ?? CONTEXT_SNAPSHOT_TTL_MS);
  const seen = snapshots.find((snapshot) => snapshot.editableTarget !== null);
  if (seen?.editableTarget != null) {
    return {
      target: null,
      reason: `${seen.editableTarget.label} cannot take dictated text from here.`,
    };
  }
  return snapshots.length === 0
    ? { target: null, reason: "Nothing is reporting where you are." }
    : { target: null, reason: "Nothing editable is focused." };
};
