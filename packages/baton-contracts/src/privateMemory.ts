/**
 * Private memory stores over the wire (tessaya-ops research/PRIVATE-MEMORIES.md): his own encrypted store and one per
 * person, each under its PIN. Items have the same shape as `BatonMemoryItem`; nothing here ever carries a key or PIN
 * back to a client.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";

import { BatonMemoryItem, BatonMemoryKind } from "./memory.ts";

/**
 * Every request is one `op` posted to the server's `/tessaya/private` route: a read (read scope), a change (operate), or
 * what only the desktop's own assistant does (operate and hands-host).
 */
export const PRIVATE_READ_OPS: ReadonlySet<string> = new Set(["people", "list", "audit"]);
export const PRIVATE_ASSISTANT_OPS: ReadonlySet<string> = new Set([
  "recall",
  "remember",
  "deposit",
  "personDeleted",
  "backup",
  "restore",
]);

export const BatonPrivateStoreKind = Schema.Literals(["owner", "person"]);

export const BatonPrivateStore = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** "owner", or the voice profile id of a saved person (Voice ID's `personId`). */
  personId: TrimmedNonEmptyString,
  name: Schema.String,
  kind: BatonPrivateStoreKind,
  /** How many memories, waiting ones included. The one thing a locked store shows. */
  items: Schema.Number,
  /** Open for the caller's own session; another device's unlock does not count. */
  open: Schema.Boolean,
  openUntil: Schema.NullOr(IsoDateTime),
  /** Browse only: nothing in it is sent to a model. */
  recallOff: Schema.Boolean,
  lastOpenedAt: Schema.NullOr(IsoDateTime),
  /** Too many wrong PINs: no PIN is tried until then. */
  waitUntil: Schema.NullOr(IsoDateTime),
  /** His store after 20 wrong PINs in a row: only the recovery code opens it. */
  recoveryOnly: Schema.Boolean,
});
export type BatonPrivateStore = typeof BatonPrivateStore.Type;

const StoreRef = { storeId: TrimmedNonEmptyString };

export const BatonPrivatePeopleResult = Schema.Struct({ stores: Schema.Array(BatonPrivateStore) });
export const BatonPrivateSetupInput = Schema.Struct({
  /** Omitted for his own store; a saved person's voice profile id otherwise. */
  personId: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.String,
  pin: Schema.String,
});
/** The recovery code is shown once, here, and never again. */
export const BatonPrivateSetupResult = Schema.Struct({
  store: BatonPrivateStore,
  recoveryCode: Schema.String,
});
export const BatonPrivateUnlockInput = Schema.Struct({
  ...StoreRef,
  pin: Schema.optionalKey(Schema.String),
  recoveryCode: Schema.optionalKey(Schema.String),
});
export const BatonPrivateStoreResult = Schema.Struct({ store: BatonPrivateStore });
export const BatonPrivateLockInput = Schema.Struct({
  storeId: Schema.optionalKey(TrimmedNonEmptyString),
});
export const BatonPrivateLockResult = Schema.Struct({ locked: Schema.Number });
export const BatonPrivateListInput = Schema.Struct({
  ...StoreRef,
  text: Schema.optionalKey(Schema.String),
  /** Include what waits for his yes (an import's doubtful items). */
  includeProposed: Schema.optionalKey(Schema.Boolean),
});
export const BatonPrivateListResult = Schema.Struct({ items: Schema.Array(BatonMemoryItem) });

export const BatonPrivateDraft = Schema.Struct({
  kind: BatonMemoryKind,
  text: Schema.String,
  sourceRef: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** A person this memory is about (his memory of them, not theirs). */
  about: Schema.optionalKey(Schema.NullOr(Schema.String)),
  confidence: Schema.optionalKey(Schema.Number),
  /** Waits in his review list until he keeps or forgets it. */
  proposed: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.optionalKey(IsoDateTime),
  updatedAt: Schema.optionalKey(IsoDateTime),
});
export type BatonPrivateDraft = typeof BatonPrivateDraft.Type;
export const BatonPrivateAddInput = Schema.Struct({ ...StoreRef, draft: BatonPrivateDraft });
export const BatonPrivateItemResult = Schema.Struct({ item: BatonMemoryItem });
export const BatonPrivateEditInput = Schema.Struct({
  ...StoreRef,
  id: TrimmedNonEmptyString,
  text: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(BatonMemoryKind),
});
export const BatonPrivateItemRefInput = Schema.Struct({ ...StoreRef, id: TrimmedNonEmptyString });
export const BatonPrivateForgetResult = Schema.Struct({ forgotten: Schema.Boolean });
/** A fresh PIN (or recovery code) even while open: an export leaves the machine. */
export const BatonPrivateExportInput = Schema.Struct({
  ...StoreRef,
  pin: Schema.optionalKey(Schema.String),
  recoveryCode: Schema.optionalKey(Schema.String),
});
export const BatonPrivateExportResult = Schema.Struct({ markdown: Schema.String });
export const BatonPrivateChangePinInput = Schema.Struct({
  ...StoreRef,
  pin: Schema.optionalKey(Schema.String),
  recoveryCode: Schema.optionalKey(Schema.String),
  newPin: Schema.String,
});
export const BatonPrivateRemoveInput = Schema.Struct({
  ...StoreRef,
  pin: Schema.optionalKey(Schema.String),
});
export const BatonPrivateRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export const BatonPrivateSetRecallInput = Schema.Struct({ ...StoreRef, recallOff: Schema.Boolean });

export const BatonPrivateAuditRow = Schema.Struct({
  storeId: Schema.String,
  name: Schema.String,
  action: Schema.String,
  outcome: Schema.String,
  /** "desktop", "phone or browser", or "the owner, as admin". */
  by: Schema.String,
  count: Schema.Number,
  at: IsoDateTime,
});
export const BatonPrivateAuditInput = Schema.Struct({
  storeId: Schema.optionalKey(TrimmedNonEmptyString),
});
export const BatonPrivateAuditResult = Schema.Struct({
  rows: Schema.Array(BatonPrivateAuditRow),
  /** His chain checks out end to end; false when a row was removed or changed. */
  intact: Schema.Boolean,
});

export const BatonPrivateSpeaker = Schema.Struct({
  kind: Schema.Literals(["owner", "saved", "guest", "unverified"]),
  personId: Schema.NullOr(Schema.String),
  verified: Schema.Boolean,
  inherited: Schema.Boolean,
});
export const BatonPrivateTurn = Schema.Struct({
  route: Schema.Literals(["assistant", "outside", "standing", "phone", "agent"]),
  typed: Schema.Boolean,
  tainted: Schema.Boolean,
  speaker: Schema.NullOr(BatonPrivateSpeaker),
});
export const BatonPrivateRecallInput = Schema.Struct({
  turn: BatonPrivateTurn,
  text: Schema.optionalKey(Schema.String),
  budgetTokens: Schema.optionalKey(Schema.Number),
});
/** `whose` names the store for the "used 3 private memories (yours)" line; the block is for the model only. */
export const BatonPrivateRecallResult = Schema.Struct({
  block: Schema.String,
  count: Schema.Number,
  whose: Schema.NullOr(Schema.String),
});
export const BatonPrivateRememberInput = Schema.Struct({
  turn: BatonPrivateTurn,
  text: Schema.String,
  kind: Schema.optionalKey(BatonMemoryKind),
  about: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const BatonPrivateRememberResult = Schema.Struct({
  stored: Schema.Boolean,
  whose: Schema.NullOr(Schema.String),
  /** Why it was not kept, in words to say. */
  reason: Schema.NullOr(Schema.String),
});
/** An import into a store, open or locked: locked, items wait sealed to its box key until it is next opened. */
export const BatonPrivateDepositInput = Schema.Struct({
  personId: TrimmedNonEmptyString,
  items: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, draft: BatonPrivateDraft })),
});
export const BatonPrivateDepositResult = Schema.Struct({
  added: Schema.Number,
  /** Already there, by id (a re-run adds nothing). */
  skipped: Schema.Number,
});
export const BatonPrivatePersonDeletedInput = Schema.Struct({ personId: TrimmedNonEmptyString });
/** Ciphertext and wrapped keys only; restores with each store's recovery code, not the server's pepper. */
export const BatonPrivateBackupResult = Schema.Struct({ dump: Schema.String });
export const BatonPrivateRestoreInput = Schema.Struct({ dump: Schema.String });
export const BatonPrivateRestoreResult = Schema.Struct({
  stores: Schema.Number,
  items: Schema.Number,
});

const op = <const O extends string, F extends Schema.Struct.Fields>(name: O, fields: F) =>
  Schema.Struct({ op: Schema.Literal(name), ...fields });

export const BatonPrivateCallInput = Schema.Union([
  op("people", {}),
  op("list", BatonPrivateListInput.fields),
  op("audit", BatonPrivateAuditInput.fields),
  op("setup", BatonPrivateSetupInput.fields),
  op("unlock", BatonPrivateUnlockInput.fields),
  op("lock", BatonPrivateLockInput.fields),
  op("add", BatonPrivateAddInput.fields),
  op("edit", BatonPrivateEditInput.fields),
  op("forget", BatonPrivateItemRefInput.fields),
  op("accept", BatonPrivateItemRefInput.fields),
  op("export", BatonPrivateExportInput.fields),
  op("changePin", BatonPrivateChangePinInput.fields),
  op("remove", BatonPrivateRemoveInput.fields),
  op("setRecall", BatonPrivateSetRecallInput.fields),
  op("recall", BatonPrivateRecallInput.fields),
  op("remember", BatonPrivateRememberInput.fields),
  op("deposit", BatonPrivateDepositInput.fields),
  op("personDeleted", BatonPrivatePersonDeletedInput.fields),
  op("backup", {}),
  op("restore", BatonPrivateRestoreInput.fields),
]);
export type BatonPrivateCallInput = typeof BatonPrivateCallInput.Type;
/** Each op's result is one of these; the client knows which from the op it sent. */
export const BatonPrivateCallResult = Schema.Union([
  BatonPrivatePeopleResult,
  BatonPrivateListResult,
  BatonPrivateAuditResult,
  BatonPrivateSetupResult,
  BatonPrivateStoreResult,
  BatonPrivateLockResult,
  BatonPrivateItemResult,
  BatonPrivateForgetResult,
  BatonPrivateExportResult,
  BatonPrivateRemoveResult,
  BatonPrivateRecallResult,
  BatonPrivateRememberResult,
  BatonPrivateDepositResult,
  BatonPrivateBackupResult,
  BatonPrivateRestoreResult,
]);

/** Said in plain words to whoever asked: never a memory's text, a PIN or a key. */
export class BatonPrivateRefusedError extends Schema.TaggedError<BatonPrivateRefusedError>()(
  "BatonPrivateRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
