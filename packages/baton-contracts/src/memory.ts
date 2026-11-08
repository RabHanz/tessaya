/**
 * Memory over the wire (D150, docs/baton/MEMORY.md). The same shapes as `MemoryItem` in
 * `@t3tools/baton-shared/memory`; the server checks they stay assignable.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";

export const BATON_MEMORY_WS_METHODS = {
  list: "baton.memory.list",
  search: "baton.memory.search",
  add: "baton.memory.add",
  edit: "baton.memory.edit",
  history: "baton.memory.history",
  restore: "baton.memory.restore",
  pin: "baton.memory.pin",
  forget: "baton.memory.forget",
  accept: "baton.memory.accept",
  recall: "baton.memory.recall",
  used: "baton.memory.used",
  export: "baton.memory.export",
  learn: "baton.memory.learn",
  import: "baton.memory.import",
  pull: "baton.memory.pull",
  /** The history index of past work, on the server that holds it (D5): this one, or a paired peer. */
  historySearch: "baton.memory.historySearch",
  syncHello: "baton.memory.syncHello",
  syncPull: "baton.memory.syncPull",
  syncPush: "baton.memory.syncPush",
  /** This server's own sync with its paired peers (GEN-6): the desktop app's session only. */
  syncState: "baton.memory.syncState",
  syncSetEnabled: "baton.memory.syncSetEnabled",
  syncAddPeer: "baton.memory.syncAddPeer",
  syncForget: "baton.memory.syncForget",
  syncRun: "baton.memory.syncRun",
} as const;

export const BatonMemoryKind = Schema.Literals([
  "note",
  "preference",
  "fact",
  "decision",
  "correction",
  "episode",
  "learning",
]);
export const BatonMemorySource = Schema.Literals(["user", "thread", "job", "import", "sync"]);
export const BatonMemoryScope = Schema.Literals(["global", "project", "person"]);

export const BatonMemoryItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: BatonMemoryKind,
  text: TrimmedNonEmptyString,
  source: BatonMemorySource,
  sourceRef: Schema.NullOr(Schema.String),
  scope: BatonMemoryScope,
  scopeRef: Schema.NullOr(Schema.String),
  confidence: Schema.Number,
  pinned: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  expiresAt: Schema.NullOr(IsoDateTime),
  supersededBy: Schema.NullOr(Schema.String),
  proposed: Schema.Boolean,
});
export type BatonMemoryItem = typeof BatonMemoryItem.Type;

export const BatonMemoryQuery = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  kinds: Schema.optionalKey(Schema.Array(BatonMemoryKind)),
  scope: Schema.optionalKey(BatonMemoryScope),
  scopeRef: Schema.optionalKey(Schema.NullOr(Schema.String)),
  includeSuperseded: Schema.optionalKey(Schema.Boolean),
  includeProposed: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Number),
  /** The persona asking (its pack id); a walled project's items then only reach its team. */
  agent: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60))),
  /** His own view: sees walled projects without a persona. Only the desktop app's own session may set it. */
  admin: Schema.optionalKey(Schema.Boolean),
});
export type BatonMemoryQuery = typeof BatonMemoryQuery.Type;

export const BatonMemoryDraft = Schema.Struct({
  kind: BatonMemoryKind,
  text: Schema.String,
  source: BatonMemorySource,
  sourceRef: Schema.optionalKey(Schema.NullOr(Schema.String)),
  scope: Schema.optionalKey(BatonMemoryScope),
  scopeRef: Schema.optionalKey(Schema.NullOr(Schema.String)),
  confidence: Schema.optionalKey(Schema.Number),
  pinned: Schema.optionalKey(Schema.Boolean),
  expiresAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  tainted: Schema.optionalKey(Schema.Boolean),
  /** The id this one replaces; the old item stays as history. */
  supersedes: Schema.optionalKey(Schema.String),
});
export type BatonMemoryDraft = typeof BatonMemoryDraft.Type;

export const BatonMemoryItemResult = Schema.Struct({ item: BatonMemoryItem });
export const BatonMemoryListResult = Schema.Struct({ items: Schema.Array(BatonMemoryItem) });
export const BatonMemorySearchResult = Schema.Struct({
  hits: Schema.Array(Schema.Struct({ item: BatonMemoryItem, score: Schema.Number })),
});
export const BatonMemoryEditInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(BatonMemoryKind),
});
/** One earlier wording of an item (KIRO-4), kept when it changed. */
export const BatonMemoryVersion = Schema.Struct({
  version: Schema.Number,
  text: Schema.String,
  kind: BatonMemoryKind,
  at: Schema.String,
  by: Schema.Literals(["him", "consolidate", "rewrite", "sync", "import"]),
  why: Schema.String,
});
/** `agent` and `admin` as for a list: the desktop's own view, or a persona's walled one. */
export const BatonMemoryHistoryInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  agent: Schema.optionalKey(Schema.String),
  admin: Schema.optionalKey(Schema.Boolean),
});
export const BatonMemoryHistoryResult = Schema.Struct({
  versions: Schema.Array(BatonMemoryVersion),
});
/** An earlier wording back as a new version; the history is never rewritten. */
export const BatonMemoryRestoreInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  version: Schema.Number,
});
export const BatonMemoryPinInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  pinned: Schema.Boolean,
});
export const BatonMemoryRefInput = Schema.Struct({ id: TrimmedNonEmptyString });
export const BatonMemoryForgetResult = Schema.Struct({ forgotten: Schema.Boolean });
export const BatonMemoryRecallInput = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  scopeRef: Schema.optionalKey(Schema.NullOr(Schema.String)),
  budgetTokens: Schema.optionalKey(Schema.Number),
  /** The turn the memories are for, so "what did you use?" has an answer. */
  turnRef: Schema.optionalKey(Schema.String),
  /** The persona the block is for (its pack id). Without one, nothing from a walled project comes back. */
  agent: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60))),
});
export const BatonMemoryRecallResult = Schema.Struct({
  block: Schema.String,
  ids: Schema.Array(Schema.String),
});
/** No `turnRef` means the most recent turn that used any memory. */
export const BatonMemoryUsedInput = Schema.Struct({
  turnRef: Schema.optionalKey(TrimmedNonEmptyString),
});
export const BatonMemoryExportResult = Schema.Struct({ markdown: Schema.String });

/** Said in plain words to him: "that looks like a password, so I did not keep it". */
export class BatonMemoryRefusedError extends Schema.TaggedError<BatonMemoryRefusedError>()(
  "BatonMemoryRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** After a turn: what he said and what came back, for the extractor (D150). Dictation is never sent. */
export const BatonMemoryLearnInput = Schema.Struct({
  said: Schema.String,
  reply: Schema.String,
  /** The turn read something from outside, so nothing from it is kept without his yes. */
  tainted: Schema.Boolean,
  project: Schema.optionalKey(Schema.NullOr(Schema.String)),
  turnRef: Schema.optionalKey(Schema.String),
  /** The exchange before, so "yes, do that from now on" has a referent. */
  previous: Schema.optionalKey(Schema.String),
  /** The persona whose turn it was (its pack id). */
  agent: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60))),
  /** "conversation": `said` is a persona's turns since its last episode, kept as one episode (MEM-18). */
  origin: Schema.optionalKey(Schema.Literal("conversation")),
});
export const BatonMemoryLearnResult = Schema.Struct({
  stored: Schema.Number,
  held: Schema.Number,
});

/** Sync between servers (D150, MEMORY.md section 6): last writer wins, a tombstone beats an older item. */
export const BatonMemoryTombstone = Schema.Struct({
  id: TrimmedNonEmptyString,
  deletedAt: IsoDateTime,
  origin: Schema.String,
});
export const BatonMemoryChange = Schema.Struct({
  item: Schema.NullOr(BatonMemoryItem),
  tombstone: Schema.NullOr(BatonMemoryTombstone),
  writer: Schema.String,
});
export type BatonMemoryChange = typeof BatonMemoryChange.Type;
export const BatonMemorySyncHelloResult = Schema.Struct({
  origin: Schema.String,
  /** For each peer server: the newest change of theirs this one has applied. */
  cursors: Schema.Record(Schema.String, Schema.String),
});
export const BatonMemorySyncPullInput = Schema.Struct({ since: Schema.NullOr(Schema.String) });
export const BatonMemorySyncPullResult = Schema.Struct({
  origin: Schema.String,
  changes: Schema.Array(BatonMemoryChange),
  upTo: Schema.String,
});
export const BatonMemorySyncPushInput = Schema.Struct({
  from: Schema.String,
  changes: Schema.Array(BatonMemoryChange),
  upTo: Schema.String,
});
export const BatonMemorySyncPushResult = Schema.Struct({ applied: Schema.Number });

/** A paired peer as the server keeps it, without its credential. */
export const BatonMemorySyncPeer = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  expiresAt: Schema.Number,
});
export type BatonMemorySyncPeer = typeof BatonMemorySyncPeer.Type;
export const BatonMemorySyncStateResult = Schema.Struct({
  enabled: Schema.Boolean,
  peers: Schema.Array(BatonMemorySyncPeer),
});
export const BatonMemorySyncSetEnabledInput = Schema.Struct({ on: Schema.Boolean });
/** A credential a pairing returned; it only ever goes back to `origin`. */
export const BatonMemorySyncAddPeerInput = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  label: Schema.String,
  origin: TrimmedNonEmptyString,
  /** The URL the window reaches it at, with any relay path; absent, the origin itself. */
  baseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  token: TrimmedNonEmptyString,
  expiresAt: Schema.Number,
});
/** A change to this server's sync peers that was refused or could not be made; nothing was written. */
export class BatonMemorySyncError extends Schema.TaggedError<BatonMemorySyncError>()(
  "BatonMemorySyncError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
export const BatonMemorySyncForgetInput = Schema.Struct({ environmentId: TrimmedNonEmptyString });
export const BatonMemorySyncRunResult = Schema.Struct({
  servers: Schema.Number,
  applied: Schema.Number,
  refused: Schema.Array(Schema.Struct({ environmentId: Schema.String, label: Schema.String })),
});

/** A folder of markdown learnings on the server's machine, read and never written (MEMORY.md section 7). */
export const BatonMemoryImportInput = Schema.Struct({ folder: TrimmedNonEmptyString });
export const BatonMemoryImportResult = Schema.Struct({
  files: Schema.Number,
  added: Schema.Number,
  refused: Schema.Number,
  unchanged: Schema.Number,
});

/** The scheduled pull of learnings from the history index; what it finds is held for his yes (D150). */
export const BatonMemoryPullInput = Schema.Struct({
  action: Schema.Literals(["status", "enable", "disable", "run"]),
});
export const BatonMemoryHistorySearchInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  session: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** His own view, through walls: the desktop app only. */
  admin: Schema.optionalKey(Schema.Boolean),
});
/** `found` is false when no server with the index answered; `text` then says why in plain words. */
export const BatonMemoryHistorySearchResult = Schema.Struct({
  found: Schema.Boolean,
  text: Schema.String,
});
export const BatonMemoryPullResult = Schema.Struct({
  enabled: Schema.Boolean,
  found: Schema.Number,
  held: Schema.Number,
  message: Schema.String,
});
