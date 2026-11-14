/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Sessions Baton did not start: §9's adopted sessions.
 *
 * A persistent Hermes CLI in a Herdr pane, an infrastructure terminal, a test
 * watcher, an agent someone started over SSH last week. T3 does not own their
 * lifecycle and cannot recover their conversation, and the point of adopting
 * them is **visibility without pretence**: they appear in the fleet, they carry
 * a state, and everything Baton cannot do to them is declared rather than
 * discovered by trying.
 *
 * Three rules shape this contract, all of them §9's:
 *
 *   1. **Do not wrap T3's own providers.** An adopted session is for work
 *      outside T3's ownership. Nothing here is a second way to run Claude.
 *   2. **Reduced capabilities are declared up front** (§9 principle 5). A
 *      client renders what it may do; a refusal names the capability and the
 *      reason rather than failing when the button is pressed.
 *   3. **The runtime is an integration, never a copy.** Herdr is AGPL and lives
 *      in its own process; Baton speaks to it and ships none of it.
 *
 * @module baton/adoptedSession
 */
import * as Schema from "effect/Schema";

import { BatonProjectRef } from "./liveSessions.ts";

import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "@t3tools/contracts";
import { BatonSessionState } from "./sessionState.ts";
import { WorkSessionId } from "./workSession.ts";

// Legacy names (D71): wire method names keep "fabric." so installed clients keep working.
export const BATON_ADOPTED_WS_METHODS = {
  adoptedDiscover: "fabric.adopted.discover",
  adoptedRegister: "fabric.adopted.register",
  adoptedList: "fabric.adopted.list",
  adoptedRefresh: "fabric.adopted.refresh",
  adoptedDetach: "fabric.adopted.detach",
  adoptedSendInput: "fabric.adopted.sendInput",
  adoptedReadOutput: "fabric.adopted.readOutput",
} as const;

export const AdoptedSessionId = TrimmedNonEmptyString.pipe(Schema.brand("AdoptedSessionId"));
export type AdoptedSessionId = typeof AdoptedSessionId.Type;

/**
 * Which external runtime owns the session.
 *
 * One member today, and a union rather than a string so adding a second is a
 * contract change somebody reviews instead of a value somebody invents.
 */
export const AdoptedRuntime = Schema.Literals(["herdr"]);
export type AdoptedRuntime = typeof AdoptedRuntime.Type;

/**
 * What Baton may do to a session it did not start.
 *
 * Every field is false by default in the sense that matters: a runtime has to
 * say it can do a thing before Baton will offer it. §9 principle 5, made
 * checkable.
 */
export const AdoptedSessionCapabilities = Schema.Struct({
  /** Structured conversation — messages, roles, turns. Herdr has pane text. */
  readConversation: Schema.Boolean,
  /** Type into the pane. Safe only where the runtime says it is. */
  sendInput: Schema.Boolean,
  /** Answer the agent's approval requests. Needs structured state to exist. */
  approvals: Schema.Boolean,
  /** Diffs and checkpoints, which belong to T3's own thread machinery. */
  diffs: Schema.Boolean,
  /** Stop the session from Baton rather than from its own terminal. */
  stop: Schema.Boolean,
  /** Bring the raw terminal up in a client (§21's "show X"). */
  showTerminal: Schema.Boolean,
});
export type AdoptedSessionCapabilities = typeof AdoptedSessionCapabilities.Type;

export const AdoptedSessionCapability = Schema.Literals([
  "readConversation",
  "sendInput",
  "approvals",
  "diffs",
  "stop",
  "showTerminal",
]);
export type AdoptedSessionCapability = typeof AdoptedSessionCapability.Type;

/** Where the session lives inside its runtime. Herdr's own coordinates. */
export const AdoptedSessionLocation = Schema.Struct({
  /** Herdr workspace, or whatever the runtime calls its top-level container. */
  workspace: TrimmedNonEmptyString,
  /** The pane or tab. */
  pane: TrimmedNonEmptyString,
  /** The host it runs on, when the runtime is attached over SSH. */
  host: Schema.NullOr(TrimmedNonEmptyString),
});
export type AdoptedSessionLocation = typeof AdoptedSessionLocation.Type;

export const AdoptedSession = Schema.Struct({
  id: AdoptedSessionId,
  runtime: AdoptedRuntime,
  /** The work this belongs to, once somebody says so. §9 principle 6. */
  workSessionId: Schema.NullOr(WorkSessionId),
  /** What to call it on screen: the pane's title, or the command. */
  label: TrimmedNonEmptyString,
  location: AdoptedSessionLocation,
  /**
   * Which CLI is in the pane, as the runtime reported it — "claude", "codex",
   * "hermes". Null when it could not tell, which is a normal answer for a
   * terminal somebody opened by hand.
   */
  agentKind: Schema.NullOr(TrimmedNonEmptyString),
  /** Mapped from the runtime's own state by the rules in §9. */
  state: BatonSessionState,
  capabilities: AdoptedSessionCapabilities,
  /** When the runtime last told us any of this. */
  observedAt: IsoDateTime,
  createdAt: IsoDateTime,
  /** Set when the session is released; the record stays for the timeline. */
  detachedAt: Schema.NullOr(IsoDateTime),
});
export type AdoptedSession = typeof AdoptedSession.Type;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * A session the runtime can see but Baton has not adopted.
 *
 * Deliberately not the same shape as an adopted one: nothing is registered, no
 * id has been minted, and the user has not said this belongs to any work.
 */
export const AdoptedSessionCandidate = Schema.Struct({
  runtime: AdoptedRuntime,
  label: TrimmedNonEmptyString,
  location: AdoptedSessionLocation,
  agentKind: Schema.NullOr(TrimmedNonEmptyString),
  /** The runtime's own word for what it is doing, before mapping. */
  runtimeState: TrimmedNonEmptyString,
  /**
   * What the runtime reported running in the pane, when it recognised no agent.
   *
   * Null for a terminal at its prompt, and null for a pane whose agent already
   * reported a state — in that case the agent's word is the better fact and
   * this is not consulted.
   *
   * It is on the candidate because the state derivation stays on the server and
   * stays deterministic: a client adopting this pane passes the observation
   * back rather than passing a `state` it chose, so nothing outside the
   * runtime can invent what a terminal is doing.
   */
  foreground: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  /** What that word maps to, or null when Baton does not know the word. */
  state: Schema.NullOr(BatonSessionState),
  /**
   * The last lines of a pane whose agent is blocked: the question it is asking,
   * surfaced where the fleet is read rather than only inside the terminal.
   */
  blockedPrompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The pane's working directory and the project it belongs to (D72). */
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  project: Schema.optionalKey(BatonProjectRef),
});
export type AdoptedSessionCandidate = typeof AdoptedSessionCandidate.Type;

export const AdoptedDiscoverResult = Schema.Struct({
  /** Empty and `available: false` when the runtime is not on this machine. */
  available: Schema.Boolean,
  /**
   * Why not, in words a person can act on. Never empty when `available` is
   * false: "no herdr" and "herdr is running but refused us" are different
   * problems with different fixes.
   */
  reason: TrimmedString,
  candidates: Schema.Array(AdoptedSessionCandidate),
});
export type AdoptedDiscoverResult = typeof AdoptedDiscoverResult.Type;

// ---------------------------------------------------------------------------
// RPC payloads
// ---------------------------------------------------------------------------

export const AdoptedDiscoverInput = Schema.Struct({});
export type AdoptedDiscoverInput = typeof AdoptedDiscoverInput.Type;

export const AdoptedRegisterInput = Schema.Struct({
  id: AdoptedSessionId,
  runtime: AdoptedRuntime,
  label: TrimmedNonEmptyString,
  location: AdoptedSessionLocation,
  agentKind: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  /** The runtime's own state word. Baton maps it, and refuses what it cannot. */
  runtimeState: TrimmedNonEmptyString,
  /**
   * The candidate's `foreground`, passed back unchanged.
   *
   * Without it a terminal that is not a recognised agent can be discovered and
   * never adopted: the runtime's word for it is `unknown`, and the mapping that
   * turns `unknown` into a state needs to know whether anything is running.
   */
  foreground: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  workSessionId: Schema.optionalKey(Schema.NullOr(WorkSessionId)),
  /**
   * What the runtime says it can do. Absent means the conservative default —
   * see `ADOPTED_MINIMUM_CAPABILITIES` in `@t3tools/shared/batonAdoptedSession`.
   */
  capabilities: Schema.optionalKey(AdoptedSessionCapabilities),
});
export type AdoptedRegisterInput = typeof AdoptedRegisterInput.Type;

export const AdoptedRefreshInput = Schema.Struct({
  id: AdoptedSessionId,
  runtimeState: TrimmedNonEmptyString,
  /** As on register: the same word needs the same context to map the same way. */
  foreground: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type AdoptedRefreshInput = typeof AdoptedRefreshInput.Type;

export const AdoptedRefInput = Schema.Struct({ id: AdoptedSessionId });
export type AdoptedRefInput = typeof AdoptedRefInput.Type;

export const AdoptedListInput = Schema.Struct({
  workSessionId: Schema.optionalKey(WorkSessionId),
  includeDetached: Schema.optionalKey(Schema.Boolean),
});
export type AdoptedListInput = typeof AdoptedListInput.Type;

export const AdoptedSendInputInput = Schema.Struct({
  id: AdoptedSessionId,
  text: TrimmedNonEmptyString,
  /**
   * Press return after the text. Off by default: typing into a pane somebody
   * else is watching is one thing, submitting it is another.
   */
  submit: Schema.optionalKey(Schema.Boolean),
});
export type AdoptedSendInputInput = typeof AdoptedSendInputInput.Type;

export const AdoptedSessionResult = Schema.Struct({ session: AdoptedSession });
export type AdoptedSessionResult = typeof AdoptedSessionResult.Type;

export const AdoptedSessionListResult = Schema.Struct({
  sessions: Schema.Array(AdoptedSession),
});
export type AdoptedSessionListResult = typeof AdoptedSessionListResult.Type;

export const AdoptedSendInputResult = Schema.Struct({
  /** False with a reason rather than an error: refusing is a normal answer. */
  delivered: Schema.Boolean,
  detail: TrimmedString,
});
export type AdoptedSendInputResult = typeof AdoptedSendInputResult.Type;

/**
 * Read what is on an adopted terminal.
 *
 * This is **not** `readConversation`, and the distinction is the honest part:
 * there is no structured conversation on a pane Baton did not start, only
 * text. It is gated on `showTerminal` because that is the capability it
 * actually exercises — §21's "show X", answered on the server where the client
 * has no terminal of its own to render into.
 */
export const AdoptedReadOutputInput = Schema.Struct({
  id: AdoptedSessionId,
  /**
   * How much scrollback to ask for. Bounded because a pane can hold megabytes
   * and an unbounded read would put all of it through the socket.
   */
  lines: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 }))),
});
export type AdoptedReadOutputInput = typeof AdoptedReadOutputInput.Type;

export const AdoptedReadOutputResult = Schema.Struct({
  /** False with a reason, the same way `sendInput` refuses. */
  available: Schema.Boolean,
  detail: TrimmedString,
  /** The terminal's text, verbatim, soft wraps already joined. */
  output: TrimmedString,
});
export type AdoptedReadOutputResult = typeof AdoptedReadOutputResult.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdoptedSessionNotFoundError extends Schema.TaggedError<AdoptedSessionNotFoundError>()(
  "AdoptedSessionNotFoundError",
  { id: AdoptedSessionId },
) {
  override get message(): string {
    return `No adopted session '${this.id}'.`;
  }
}

/**
 * The runtime's word for a state Baton has no mapping for.
 *
 * Refused rather than guessed: mapping an unknown word to `idle` would put a
 * session that needs the user at the bottom of the fleet, which is the one
 * place a wrong state does real harm.
 */
export class AdoptedStateUnknownError extends Schema.TaggedError<AdoptedStateUnknownError>()(
  "AdoptedStateUnknownError",
  { runtime: AdoptedRuntime, runtimeState: TrimmedString },
) {
  override get message(): string {
    return `${this.runtime} reported a state Tessaya does not know: '${this.runtimeState}'.`;
  }
}

export class AdoptedCapabilityRefusedError extends Schema.TaggedError<AdoptedCapabilityRefusedError>()(
  "AdoptedCapabilityRefusedError",
  { id: AdoptedSessionId, capability: AdoptedSessionCapability, reason: TrimmedString },
) {
  override get message(): string {
    return `${this.capability} is not available on this adopted session: ${this.reason}`;
  }
}

export class AdoptedStorageError extends Schema.TaggedError<AdoptedStorageError>()(
  "AdoptedStorageError",
  { operation: TrimmedNonEmptyString, detail: TrimmedString },
) {
  override get message(): string {
    return `Could not ${this.operation} adopted sessions: ${this.detail}`;
  }
}

export const AdoptedSessionError = Schema.Union([
  AdoptedSessionNotFoundError,
  AdoptedStateUnknownError,
  AdoptedCapabilityRefusedError,
  AdoptedStorageError,
]);
export type AdoptedSessionError = typeof AdoptedSessionError.Type;
