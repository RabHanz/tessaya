/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Every Claude Code session running on an environment, whoever started it (D68).
 *
 * Claude Code writes `<config dir>/sessions/<pid>.json` for each live process:
 * its conversation id, directory, name, busy/idle status and where it runs
 * (a terminal, VS Code, tmux). Baton reads those, so a session started in a
 * plain terminal or in VS Code is in the same list as a T3 thread or a Herdr
 * pane, and none of it depends on which account is signed in.
 *
 * @module baton/liveSessions
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "@t3tools/contracts";

// Legacy names (D71): wire method names keep "fabric." so installed clients keep working.
export const BATON_LIVE_WS_METHODS = {
  /** Type into a Herdr pane by its ref; refused unless discovery currently sees that pane. */
  herdrSend: "fabric.herdr.send",
  /** Put a file into a live session's directory and return its path (D73). */
  liveAttach: "baton.live.attach",
  /** Bring a Claude session from a plain terminal or VS Code into Herdr, same conversation (D74). */
  liveAdopt: "baton.live.adopt",
  /** Set a live Claude session's model and effort with its own slash commands, confirmed from its transcript. */
  liveSetModel: "baton.live.setModel",
  /** Move one live Claude session to another account (a cswap slot) while it runs: its own dir's credential is swapped. */
  liveSetAccount: "baton.live.setAccount",
  /** A session's real effort and model, and the change waiting for it to go idle (ACCOUNTS-2). */
  liveState: "baton.live.state",
  liveCancelQueued: "baton.live.cancelQueued",
} as const;

/** Where a live session is: a Herdr pane, or a Claude conversation by id. */
export const BatonLiveTarget = Schema.Struct({
  pane: Schema.optionalKey(TrimmedNonEmptyString),
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type BatonLiveTarget = typeof BatonLiveTarget.Type;

/** 8 MiB of file, base64-encoded on the wire. */
export const BATON_ATTACH_MAX_BYTES = 8 * 1024 * 1024;

export const BatonLiveAttachInput = Schema.Struct({
  target: BatonLiveTarget,
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  dataBase64: Schema.String.check(
    Schema.isMaxLength(Math.ceil((BATON_ATTACH_MAX_BYTES * 4) / 3) + 4),
  ),
});
export type BatonLiveAttachInput = typeof BatonLiveAttachInput.Type;

export const BatonLiveAttachResult = Schema.Struct({
  saved: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  detail: Schema.String,
});
export type BatonLiveAttachResult = typeof BatonLiveAttachResult.Type;

export const BatonLiveAdoptInput = Schema.Struct({ sessionId: TrimmedNonEmptyString });
export type BatonLiveAdoptInput = typeof BatonLiveAdoptInput.Type;

export const BatonLiveAdoptResult = Schema.Struct({
  adopted: Schema.Boolean,
  pane: Schema.NullOr(Schema.String),
  detail: Schema.String,
});
export type BatonLiveAdoptResult = typeof BatonLiveAdoptResult.Type;

export const BatonLiveSetModelInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  model: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
  effort: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(20))),
});
export type BatonLiveSetModelInput = typeof BatonLiveSetModelInput.Type;

export const BatonLiveSetModelResult = Schema.Struct({
  state: Schema.Literals([
    "applied",
    "not_confirmed",
    "not_in_herdr",
    "busy",
    "not_running",
    "refused",
  ]),
  detail: Schema.String,
  /** What the session itself said back, as it said it. */
  confirmed: Schema.Array(Schema.String),
  /** With state "busy": the change waits and is applied when the session goes idle. */
  queued: Schema.optionalKey(Schema.Boolean),
});
export type BatonLiveSetModelResult = typeof BatonLiveSetModelResult.Type;

export const BatonLiveSetAccountInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  /** The cswap slot (the pool account's key). */
  accountKey: TrimmedNonEmptyString.check(Schema.isMaxLength(20)),
  /** Ignored: a session on the machine's shared login always restarts once in its pane. Kept for older clients. */
  restart: Schema.optionalKey(Schema.Boolean),
});
export type BatonLiveSetAccountInput = typeof BatonLiveSetAccountInput.Type;

export const BatonLiveSetAccountResult = Schema.Struct({
  state: Schema.Literals([
    "switched",
    "unchanged",
    "needs_restart",
    "busy",
    "not_in_herdr",
    "not_running",
    "refused",
  ]),
  detail: Schema.String,
  queued: Schema.optionalKey(Schema.Boolean),
});
export type BatonLiveSetAccountResult = typeof BatonLiveSetAccountResult.Type;

export const BatonLiveQueued = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  accountKey: Schema.optionalKey(Schema.String),
  restart: Schema.optionalKey(Schema.Boolean),
});
export type BatonLiveQueued = typeof BatonLiveQueued.Type;

export const BatonLiveSessionInput = Schema.Struct({ sessionId: TrimmedNonEmptyString });
export const BatonLiveStateResult = Schema.Struct({
  /** The session's own effort: its last /effort, its config dir's setting, else its model's default. */
  effort: Schema.NullOr(Schema.String),
  queued: Schema.NullOr(BatonLiveQueued),
  /** The queued change is being applied now: for an account move, the one restart and the switch. */
  applying: Schema.optionalKey(Schema.Boolean),
  /** The usage limit the session last stopped on, in Claude's words, until it says anything else. */
  limit: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ text: Schema.String, at: Schema.String })),
  ),
  /** Why the last queued change was not applied, until the next one is queued. */
  failure: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type BatonLiveStateResult = typeof BatonLiveStateResult.Type;
export const BatonLiveCancelQueuedResult = Schema.Struct({ cancelled: Schema.Boolean });

/**
 * Which project a live session belongs to, the same on every box (D72): the
 * repository's canonical key from T3's own resolver when the directory is a
 * git checkout with a remote, else `dir:<folder name>`. This is what lets one
 * project be one entry across accounts and machines.
 */
export const BatonProjectRef = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type BatonProjectRef = typeof BatonProjectRef.Type;

export const ClaudeLiveSession = Schema.Struct({
  pid: Schema.Number,
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  /** "user" when someone named the session; "derived" names change on every restart. */
  nameSource: Schema.optionalKey(Schema.String),
  /** Claude Code's own word: "busy", "idle", or another it adds later. */
  status: Schema.NullOr(Schema.String),
  /** "cli", "vscode", … as Claude Code reports its entrypoint. */
  entrypoint: Schema.NullOr(Schema.String),
  /** The Herdr pane ref (`<session>~<pane>`, or the pane alone in the default session). */
  herdrPane: Schema.NullOr(Schema.String),
  tmux: Schema.NullOr(Schema.String),
  /** The account behind its config directory, when the pool knows it. */
  account: Schema.NullOr(Schema.String),
  project: Schema.optionalKey(BatonProjectRef),
  /** The Claude config directory the session runs under, when it is not `~/.claude` (D83). */
  configDir: Schema.optionalKey(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type ClaudeLiveSession = typeof ClaudeLiveSession.Type;

export const BatonHerdrSendInput = Schema.Struct({
  pane: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  submit: Schema.optionalKey(Schema.Boolean),
});
export type BatonHerdrSendInput = typeof BatonHerdrSendInput.Type;

export const BatonHerdrSendResult = Schema.Struct({
  delivered: Schema.Boolean,
  detail: Schema.String,
});
export type BatonHerdrSendResult = typeof BatonHerdrSendResult.Type;
