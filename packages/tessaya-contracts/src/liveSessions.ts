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
export const TessayaLiveTarget = Schema.Struct({
  pane: Schema.optionalKey(TrimmedNonEmptyString),
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TessayaLiveTarget = typeof TessayaLiveTarget.Type;

/** 8 MiB of file, base64-encoded on the wire. */
export const BATON_ATTACH_MAX_BYTES = 8 * 1024 * 1024;

export const TessayaLiveAttachInput = Schema.Struct({
  target: TessayaLiveTarget,
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  dataBase64: Schema.String.check(
    Schema.isMaxLength(Math.ceil((BATON_ATTACH_MAX_BYTES * 4) / 3) + 4),
  ),
});
export type TessayaLiveAttachInput = typeof TessayaLiveAttachInput.Type;

export const TessayaLiveAttachResult = Schema.Struct({
  saved: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  detail: Schema.String,
});
export type TessayaLiveAttachResult = typeof TessayaLiveAttachResult.Type;

export const TessayaLiveAdoptInput = Schema.Struct({ sessionId: TrimmedNonEmptyString });
export type TessayaLiveAdoptInput = typeof TessayaLiveAdoptInput.Type;

export const TessayaLiveAdoptResult = Schema.Struct({
  adopted: Schema.Boolean,
  pane: Schema.NullOr(Schema.String),
  detail: Schema.String,
});
export type TessayaLiveAdoptResult = typeof TessayaLiveAdoptResult.Type;

export const TessayaLiveSetModelInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  model: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
  effort: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(20))),
});
export type TessayaLiveSetModelInput = typeof TessayaLiveSetModelInput.Type;

export const TessayaLiveSetModelResult = Schema.Struct({
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
export type TessayaLiveSetModelResult = typeof TessayaLiveSetModelResult.Type;

export const TessayaLiveSetAccountInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  /** The cswap slot (the pool account's key). */
  accountKey: TrimmedNonEmptyString.check(Schema.isMaxLength(20)),
  /** Ignored: a session on the machine's shared login always restarts once in its pane. Kept for older clients. */
  restart: Schema.optionalKey(Schema.Boolean),
});
export type TessayaLiveSetAccountInput = typeof TessayaLiveSetAccountInput.Type;

export const TessayaLiveSetAccountResult = Schema.Struct({
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
export type TessayaLiveSetAccountResult = typeof TessayaLiveSetAccountResult.Type;

export const TessayaLiveQueued = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  accountKey: Schema.optionalKey(Schema.String),
  restart: Schema.optionalKey(Schema.Boolean),
});
export type TessayaLiveQueued = typeof TessayaLiveQueued.Type;

export const TessayaLiveSessionInput = Schema.Struct({ sessionId: TrimmedNonEmptyString });
export const TessayaLiveStateResult = Schema.Struct({
  /** The session's own effort: its last /effort, its config dir's setting, else its model's default. */
  effort: Schema.NullOr(Schema.String),
  queued: Schema.NullOr(TessayaLiveQueued),
  /** The queued change is being applied now: for an account move, the one restart and the switch. */
  applying: Schema.optionalKey(Schema.Boolean),
  /** The usage limit the session last stopped on, in Claude's words, until it says anything else. */
  limit: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ text: Schema.String, at: Schema.String })),
  ),
  /** Why the last queued change was not applied, until the next one is queued. */
  failure: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TessayaLiveStateResult = typeof TessayaLiveStateResult.Type;
export const TessayaLiveCancelQueuedResult = Schema.Struct({ cancelled: Schema.Boolean });

/**
 * Which project a live session belongs to, the same on every box (D72): the
 * repository's canonical key from T3's own resolver when the directory is a
 * git checkout with a remote, else `dir:<folder name>`. This is what lets one
 * project be one entry across accounts and machines.
 */
export const TessayaProjectRef = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type TessayaProjectRef = typeof TessayaProjectRef.Type;

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
  project: Schema.optionalKey(TessayaProjectRef),
  /** The Claude config directory the session runs under, when it is not `~/.claude` (D83). */
  configDir: Schema.optionalKey(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type ClaudeLiveSession = typeof ClaudeLiveSession.Type;

export const TessayaHerdrSendInput = Schema.Struct({
  pane: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  submit: Schema.optionalKey(Schema.Boolean),
});
export type TessayaHerdrSendInput = typeof TessayaHerdrSendInput.Type;

export const TessayaHerdrSendResult = Schema.Struct({
  delivered: Schema.Boolean,
  detail: Schema.String,
});
export type TessayaHerdrSendResult = typeof TessayaHerdrSendResult.Type;
