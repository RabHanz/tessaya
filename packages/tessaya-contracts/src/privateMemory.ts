/**
 * Private memory stores over the wire (tessaya-ops research/PRIVATE-MEMORIES.md): his own encrypted store and one per
 * person, each under its PIN. Items have the same shape as `TessayaMemoryItem`; nothing here ever carries a key or PIN
 * back to a client.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";

import { TessayaMemoryItem, TessayaMemoryKind, TessayaTurnSpeaker } from "./memory.ts";

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

export const TessayaPrivateStoreKind = Schema.Literals(["owner", "person"]);

export const TessayaPrivateStore = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** "owner", or the voice profile id of a saved person (Voice ID's `personId`). */
  personId: TrimmedNonEmptyString,
  name: Schema.String,
  kind: TessayaPrivateStoreKind,
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
export type TessayaPrivateStore = typeof TessayaPrivateStore.Type;

const StoreRef = { storeId: TrimmedNonEmptyString };

export const TessayaPrivatePeopleResult = Schema.Struct({
  stores: Schema.Array(TessayaPrivateStore),
});
export const TessayaPrivateSetupInput = Schema.Struct({
  /** Omitted for his own store; a saved person's voice profile id otherwise. */
  personId: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.String,
  pin: Schema.String,
});
/** The recovery code is shown once, here, and never again. */
export const TessayaPrivateSetupResult = Schema.Struct({
  store: TessayaPrivateStore,
  recoveryCode: Schema.String,
});
export const TessayaPrivateUnlockInput = Schema.Struct({
  ...StoreRef,
  pin: Schema.optionalKey(Schema.String),
  recoveryCode: Schema.optionalKey(Schema.String),
});
export const TessayaPrivateStoreResult = Schema.Struct({ store: TessayaPrivateStore });
export const TessayaPrivateLockInput = Schema.Struct({
  storeId: Schema.optionalKey(TrimmedNonEmptyString),
});
export const TessayaPrivateLockResult = Schema.Struct({ locked: Schema.Number });
export const TessayaPrivateListInput = Schema.Struct({
  ...StoreRef,
  text: Schema.optionalKey(Schema.String),
  /** Include what waits for his yes (an import's doubtful items). */
  includeProposed: Schema.optionalKey(Schema.Boolean),
});
export const TessayaPrivateListResult = Schema.Struct({ items: Schema.Array(TessayaMemoryItem) });

export const TessayaPrivateDraft = Schema.Struct({
  kind: TessayaMemoryKind,
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
export type TessayaPrivateDraft = typeof TessayaPrivateDraft.Type;
export const TessayaPrivateAddInput = Schema.Struct({ ...StoreRef, draft: TessayaPrivateDraft });
export const TessayaPrivateItemResult = Schema.Struct({ item: TessayaMemoryItem });
export const TessayaPrivateEditInput = Schema.Struct({
  ...StoreRef,
  id: TrimmedNonEmptyString,
  text: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(TessayaMemoryKind),
});
export const TessayaPrivateItemRefInput = Schema.Struct({ ...StoreRef, id: TrimmedNonEmptyString });
export const TessayaPrivateForgetResult = Schema.Struct({ forgotten: Schema.Boolean });
/** A fresh PIN (or recovery code) even while open: an export leaves the machine. */
export const TessayaPrivateExportInput = Schema.Struct({
  ...StoreRef,
  pin: Schema.optionalKey(Schema.String),
  recoveryCode: Schema.optionalKey(Schema.String),
});
export const TessayaPrivateExportResult = Schema.Struct({ markdown: Schema.String });
export const TessayaPrivateChangePinInput = Schema.Struct({
  ...StoreRef,
  pin: Schema.optionalKey(Schema.String),
  recoveryCode: Schema.optionalKey(Schema.String),
  newPin: Schema.String,
});
export const TessayaPrivateRemoveInput = Schema.Struct({
  ...StoreRef,
  pin: Schema.optionalKey(Schema.String),
});
export const TessayaPrivateRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export const TessayaPrivateSetRecallInput = Schema.Struct({
  ...StoreRef,
  recallOff: Schema.Boolean,
});

export const TessayaPrivateAuditRow = Schema.Struct({
  storeId: Schema.String,
  name: Schema.String,
  action: Schema.String,
  outcome: Schema.String,
  /** "desktop", "phone or browser", or "the owner, as admin". */
  by: Schema.String,
  count: Schema.Number,
  at: IsoDateTime,
});
export const TessayaPrivateAuditInput = Schema.Struct({
  storeId: Schema.optionalKey(TrimmedNonEmptyString),
});
export const TessayaPrivateAuditResult = Schema.Struct({
  rows: Schema.Array(TessayaPrivateAuditRow),
  /** His chain checks out end to end; false when a row was removed or changed. */
  intact: Schema.Boolean,
});

export const TessayaPrivateSpeaker = TessayaTurnSpeaker;
export const TessayaPrivateTurn = Schema.Struct({
  route: Schema.Literals(["assistant", "outside", "standing", "phone", "agent"]),
  typed: Schema.Boolean,
  tainted: Schema.Boolean,
  speaker: Schema.NullOr(TessayaPrivateSpeaker),
});
export const TessayaPrivateRecallInput = Schema.Struct({
  turn: TessayaPrivateTurn,
  text: Schema.optionalKey(Schema.String),
  budgetTokens: Schema.optionalKey(Schema.Number),
});
/** `whose` names the store for the "used 3 private memories (yours)" line; the block is for the model only. */
export const TessayaPrivateRecallResult = Schema.Struct({
  block: Schema.String,
  count: Schema.Number,
  whose: Schema.NullOr(Schema.String),
});
export const TessayaPrivateRememberInput = Schema.Struct({
  turn: TessayaPrivateTurn,
  text: Schema.String,
  kind: Schema.optionalKey(TessayaMemoryKind),
  about: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const TessayaPrivateRememberResult = Schema.Struct({
  stored: Schema.Boolean,
  whose: Schema.NullOr(Schema.String),
  /** Why it was not kept, in words to say. */
  reason: Schema.NullOr(Schema.String),
});
/** An import into a store, open or locked: locked, items wait sealed to its box key until it is next opened. */
export const TessayaPrivateDepositInput = Schema.Struct({
  personId: TrimmedNonEmptyString,
  items: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, draft: TessayaPrivateDraft })),
});
export const TessayaPrivateDepositResult = Schema.Struct({
  added: Schema.Number,
  /** Already there, by id (a re-run adds nothing). */
  skipped: Schema.Number,
});
export const TessayaPrivatePersonDeletedInput = Schema.Struct({ personId: TrimmedNonEmptyString });
/** Ciphertext and wrapped keys only; restores with each store's recovery code, not the server's pepper. */
export const TessayaPrivateBackupResult = Schema.Struct({ dump: Schema.String });
export const TessayaPrivateRestoreInput = Schema.Struct({ dump: Schema.String });
export const TessayaPrivateRestoreResult = Schema.Struct({
  stores: Schema.Number,
  items: Schema.Number,
});

const op = <const O extends string, F extends Schema.Struct.Fields>(name: O, fields: F) =>
  Schema.Struct({ op: Schema.Literal(name), ...fields });

export const TessayaPrivateCallInput = Schema.Union([
  op("people", {}),
  op("list", TessayaPrivateListInput.fields),
  op("audit", TessayaPrivateAuditInput.fields),
  op("setup", TessayaPrivateSetupInput.fields),
  op("unlock", TessayaPrivateUnlockInput.fields),
  op("lock", TessayaPrivateLockInput.fields),
  op("add", TessayaPrivateAddInput.fields),
  op("edit", TessayaPrivateEditInput.fields),
  op("forget", TessayaPrivateItemRefInput.fields),
  op("accept", TessayaPrivateItemRefInput.fields),
  op("export", TessayaPrivateExportInput.fields),
  op("changePin", TessayaPrivateChangePinInput.fields),
  op("remove", TessayaPrivateRemoveInput.fields),
  op("setRecall", TessayaPrivateSetRecallInput.fields),
  op("recall", TessayaPrivateRecallInput.fields),
  op("remember", TessayaPrivateRememberInput.fields),
  op("deposit", TessayaPrivateDepositInput.fields),
  op("personDeleted", TessayaPrivatePersonDeletedInput.fields),
  op("backup", {}),
  op("restore", TessayaPrivateRestoreInput.fields),
]);
export type TessayaPrivateCallInput = typeof TessayaPrivateCallInput.Type;
/** Each op's result is one of these; the client knows which from the op it sent. */
export const TessayaPrivateCallResult = Schema.Union([
  TessayaPrivatePeopleResult,
  TessayaPrivateListResult,
  TessayaPrivateAuditResult,
  TessayaPrivateSetupResult,
  TessayaPrivateStoreResult,
  TessayaPrivateLockResult,
  TessayaPrivateItemResult,
  TessayaPrivateForgetResult,
  TessayaPrivateExportResult,
  TessayaPrivateRemoveResult,
  TessayaPrivateRecallResult,
  TessayaPrivateRememberResult,
  TessayaPrivateDepositResult,
  TessayaPrivateBackupResult,
  TessayaPrivateRestoreResult,
]);

/** Said in plain words to whoever asked: never a memory's text, a PIN or a key. */
export class TessayaPrivateRefusedError extends Schema.TaggedError<TessayaPrivateRefusedError>()(
  "BatonPrivateRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
