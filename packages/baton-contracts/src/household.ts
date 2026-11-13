/**
 * The household's members over the wire (tessaya-ops research/ACCOUNTS-IDENTITY-DESIGN.md I-1, HOUSEHOLD-DESIGN.md
 * 5b-i). Every request is one `op` posted to the server's `/tessaya/household` route, or made by voice through the
 * members tools; the server decides who may do what from the caller's member, role and assurance.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";

export const BatonMemberRole = Schema.Literals(["owner", "admin", "adult", "child", "guest"]);
const InviteRole = Schema.Literals(["admin", "adult", "child", "guest"]);

export const BatonHouseholdMember = Schema.Struct({
  /** The same id as their Voice ID profile and their private store. */
  id: TrimmedNonEmptyString,
  name: Schema.String,
  role: BatonMemberRole,
  /** "invited": nobody has redeemed the invite yet. "leaving": removed, data kept for their export until `purgeAfter`. */
  state: Schema.Literals(["active", "invited", "leaving"]),
  /** Holds the separate "machine" grant: T3's threads, terminals and files, the whole computer. */
  machine: Schema.Boolean,
  guardians: Schema.Array(Schema.String),
  /** A child becomes an adult at this age (the household default unless set). */
  adultAge: Schema.NullOr(Schema.Number),
  born: Schema.NullOr(Schema.String),
  /** Their signed-in devices: counted for everyone, listed for the owner, admins and themselves. */
  devices: Schema.Number,
  connected: Schema.Boolean,
  /** A pending invite's code, shown only to the owner and admins while it lasts. */
  inviteCode: Schema.NullOr(Schema.String),
  inviteExpiresAt: Schema.NullOr(IsoDateTime),
  purgeAfter: Schema.NullOr(IsoDateTime),
  /** The caller. */
  you: Schema.Boolean,
});
export type BatonHouseholdMember = typeof BatonHouseholdMember.Type;

const Ref = { id: TrimmedNonEmptyString };
const op = <const O extends string, F extends Schema.Struct.Fields>(name: O, fields: F) =>
  Schema.Struct({ op: Schema.Literal(name), ...fields });

export const BatonHouseholdCallInput = Schema.Union([
  op("list", {}),
  /** Who is around now: a member's device connected, or recently. */
  op("home", {}),
  op("invite", {
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
    role: InviteRole,
    /** A child's birth date (YYYY-MM-DD), for growing up. */
    born: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10))),
    adultAge: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 25 }))),
  }),
  /** A new pairing code for a member's next device. */
  op("pair", Ref),
  op("setRole", { ...Ref, role: InviteRole }),
  op("setAdultAge", {
    ...Ref,
    adultAge: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 25 })),
  }),
  /** Ends their access now; their data waits for their export unless `now`. */
  op("remove", { ...Ref, now: Schema.optionalKey(Schema.Boolean) }),
  op("restore", Ref),
  /** The owner-only "machine" grant, on or off. */
  op("machine", { ...Ref, on: Schema.Boolean }),
  /**
   * Which linked server holds this household's members (its label), or null for this one. Every other server asks it,
   * so a home has one members table however many servers it has.
   */
  op("setHome", { on: Schema.NullOr(Schema.String.check(Schema.isMaxLength(60))) }),
]);
export type BatonHouseholdCallInput = typeof BatonHouseholdCallInput.Type;

export const BatonHouseholdCallResult = Schema.Struct({
  /** done: changed now. asked: sent to the owner's approving device, changes on a yes. refused: with why. */
  status: Schema.Literals(["done", "asked", "refused"]),
  /** What happened, in words she can say. */
  line: Schema.String,
  members: Schema.optionalKey(Schema.Array(BatonHouseholdMember)),
  /** A new pairing code: shown once to whoever asked for it. */
  code: Schema.optionalKey(Schema.String),
  codeExpiresAt: Schema.optionalKey(IsoDateTime),
  /** The plain warning a machine grant carries. */
  warning: Schema.optionalKey(Schema.String),
  /** With `list`: the linked server the members live on (null: this one), and the linked servers it could be. */
  homeOn: Schema.optionalKey(Schema.NullOr(Schema.String)),
  peers: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type BatonHouseholdCallResult = typeof BatonHouseholdCallResult.Type;
