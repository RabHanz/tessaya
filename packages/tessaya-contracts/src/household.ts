/**
 * The household's members over the wire (tessaya-ops research/ACCOUNTS-IDENTITY-DESIGN.md I-1, HOUSEHOLD-DESIGN.md
 * 5b-i). Every request is one `op` posted to the server's `/tessaya/household` route (or `baton.household.call` over
 * the socket), or made by voice through the members tools; the server decides who may do what from the caller's
 * member, role and assurance.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";

export const TESSAYA_HOUSEHOLD_WS_METHODS = { call: "baton.household.call" } as const;

export const TessayaMemberRole = Schema.Literals(["owner", "admin", "adult", "child", "guest"]);
const InviteRole = Schema.Literals(["admin", "adult", "child", "guest"]);
/** What a member can set for themselves (HOUSEHOLD-DESIGN §4); tessaya-shared's PREFERENCE_KEYS says what each means. */
export const TessayaPreferenceKey = Schema.Literals([
  "name",
  "persona",
  "voice",
  "units",
  "timeFormat",
  "news",
  "music",
  "wakeTraining",
  "follow",
  "pronouns",
  "devices",
  "location",
  "camera",
]);
export type TessayaPreferenceKey = typeof TessayaPreferenceKey.Type;

export const TessayaHouseholdMember = Schema.Struct({
  /** The same id as their Voice ID profile and their private store. */
  id: TrimmedNonEmptyString,
  name: Schema.String,
  role: TessayaMemberRole,
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
  /** The Windows account whose Hello confirms them, when one is set. */
  windowsAccount: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TessayaHouseholdMember = typeof TessayaHouseholdMember.Type;

/**
 * One member's shared voice profile (one per member and voice model, kept on the home server): numbers, never audio.
 * `centroid` is base64 float32. `version` rises each time they enrol again.
 */
export const TessayaVoiceProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  kind: Schema.Literals(["owner", "saved"]),
  model: TrimmedNonEmptyString,
  centroid: Schema.String.check(Schema.isMaxLength(16_384)),
  samples: Schema.Int,
  sources: Schema.Array(Schema.Literals(["wispr", "spoken", "adapted"])),
  enrolledAt: Schema.String,
  consentNote: Schema.optionalKey(Schema.String),
  version: Schema.Int,
  updatedAt: Schema.String,
});
export type TessayaVoiceProfile = typeof TessayaVoiceProfile.Type;

const Ref = { id: TrimmedNonEmptyString };
const VesselId = Schema.String.check(Schema.isMaxLength(128));
/** One clip's speaker embedding (base64 float32) from a vessel's Voice ID model. */
export const TessayaVoicePrint = Schema.Struct({
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  vector: Schema.String.check(Schema.isMaxLength(16_384)),
  ms: Schema.Number,
});
export type TessayaVoicePrint = typeof TessayaVoicePrint.Type;
const op = <const O extends string, F extends Schema.Struct.Fields>(name: O, fields: F) =>
  Schema.Struct({ op: Schema.Literal(name), ...fields });

export const TessayaHouseholdCallInput = Schema.Union([
  op("list", {}),
  /** Who is around now: a member's device connected, or recently. */
  op("home", {}),
  /**
   * The signed-in member's own presence from a vessel (B-043): the app came to the front or went away, their phone
   * crossed the home geofence (only with their `location` on), or a camera saw them (only with their `camera` on).
   */
  op("here", {
    signal: Schema.Literals(["foreground", "background", "home", "away", "seen"]),
    vessel: Schema.optionalKey(VesselId),
  }),
  /** Whose a room vessel is (a Tessel), so its headphones and handling count for them; null: the household's. */
  op("setVesselMember", { vessel: VesselId, member: Schema.NullOr(Schema.String) }),
  op("invite", {
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
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
  /**
   * Confirms it's them on this signed-in device, for 5 minutes (A3): their PIN typed here, or (the desktop app only)
   * Windows Hello passed on this Windows account (`HOST\\user`), which must be theirs alone in `setWindowsAccount`.
   */
  op("stepUp", {
    pin: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
    hello: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    /** A passkey's answer to `passkeyOptions` (base64url fields, as the browser gives them). */
    passkey: Schema.optionalKey(
      Schema.Struct({
        credentialId: Schema.String.check(Schema.isMaxLength(1024)),
        clientDataJSON: Schema.String.check(Schema.isMaxLength(8192)),
        authenticatorData: Schema.String.check(Schema.isMaxLength(8192)),
        signature: Schema.String.check(Schema.isMaxLength(8192)),
      }),
    ),
  }),
  /** A fresh challenge for this device's passkey: to add one, or to confirm it's them; with their passkeys. */
  op("passkeyOptions", { purpose: Schema.Literals(["register", "stepUp"]) }),
  /** Keeps a new passkey for the member signed in here, from `navigator.credentials.create`'s answer. */
  op("passkeyRegister", {
    clientDataJSON: Schema.String.check(Schema.isMaxLength(8192)),
    attestationObject: Schema.String.check(Schema.isMaxLength(16384)),
    label: Schema.String.check(Schema.isMaxLength(60)),
  }),
  op("passkeyRemove", { credentialId: Schema.String.check(Schema.isMaxLength(1024)) }),
  /** Which Windows account's Hello confirms this member (null: none). */
  op("setWindowsAccount", {
    ...Ref,
    account: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  }),
  /** A name said or typed; spelled out ("Zayd, Z-A-Y-D") it is kept as spelled. Themselves, or an admin. */
  op("rename", { ...Ref, name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)) }),
  /** A member's own preferences: theirs, or the owner's view of anyone's. */
  op("preferences", Ref),
  /** One of a member's preferences, set or (null) cleared: by themselves, or the owner. */
  op("setPreference", {
    ...Ref,
    key: TessayaPreferenceKey,
    value: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  }),
  /** Every member's shared voice profile, for a vessel to recognise them. */
  op("voices", {}),
  /**
   * A member's voice, enrolled on any vessel. `fresh`: a new enrolment, which replaces theirs everywhere; otherwise a
   * copy found on a device (moving to one profile), kept only when it has more samples than the home's.
   */
  op("saveVoice", {
    profile: TessayaVoiceProfile.mapFields((f) => {
      const { version: _v, updatedAt: _u, ...rest } = f;
      return rest;
    }),
    fresh: Schema.Boolean,
  }),
  /**
   * People (HOUSEHOLD-DESIGN §11). A vessel's turn from a voice that is no member: its voiceprint (numbers, never
   * audio) is filed with the voice it matches, or as someone new; the answer is who it is and what she is told.
   */
  op("peopleObserve", {
    vessel: VesselId,
    said: Schema.String.check(Schema.isMaxLength(400)),
    print: TessayaVoicePrint,
  }),
  /** Every person she knows by voice or by relation, what she keeps and why, the suggestions, and how long. */
  op("peopleList", {}),
  /** Who someone is and how he knows them, what they last talked about, who was at an event or here on a day. */
  op("peopleWho", {
    name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
    event: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
    day: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10))),
    vessel: Schema.optionalKey(VesselId),
  }),
  /** The voice just heard on this vessel tells its name; from then on she remembers them. */
  op("peopleIntroduce", {
    vessel: VesselId,
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  }),
  /** The voice just heard on this vessel asks to be forgotten: its voiceprint and what it said go now. */
  op("peopleForgetMe", { vessel: VesselId, confirmed: Schema.optionalKey(Schema.Boolean) }),
  /**
   * The owner's (and for some, an admin's) changes. `id` "last" is the last voice heard on `vessel` that is no member.
   * merge and forget are the owner's alone.
   */
  op("peopleManage", {
    action: Schema.Literals([
      "name",
      "merge",
      "split",
      "notSame",
      "notPerson",
      "setStatus",
      "save",
      "unsave",
      "ask",
      "forget",
      "retention",
      "restore",
      "purge",
      "bin",
    ]),
    id: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(140))),
    into: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(140))),
    name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60))),
    /** With `name`: how he knows them ("cousin", "works with me"), kept as his own memory. */
    relation: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60))),
    status: Schema.optionalKey(Schema.Literals(["member", "guest"])),
    /** With `setStatus` member: the household member this voice is. */
    member: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(140))),
    /** With `ask`: whether she may ask this voice's name (no `id`: anyone's). */
    on: Schema.optionalKey(Schema.Boolean),
    /** With `forget`: said back and answered yes; without it, nothing goes and she asks. */
    confirmed: Schema.optionalKey(Schema.Boolean),
    /** With `retention`: days an unnamed voice is kept (0, the default: until forgotten); with `bin`: restore days. */
    days: Schema.optionalKey(Schema.Number),
    vessel: Schema.optionalKey(VesselId),
  }),
]);
export type TessayaHouseholdCallInput = typeof TessayaHouseholdCallInput.Type;

export const TessayaPersonStatus = Schema.Literals(["member", "guest", "unknown", "not_person"]);
export const TessayaPerson = Schema.Struct({
  id: Schema.String,
  /** Null: a voice she hasn't been told the name of. */
  name: Schema.NullOr(Schema.String),
  status: TessayaPersonStatus,
  /** What his memory says about them, each with the memory that says it (the why). */
  relations: Schema.Array(
    Schema.Struct({ text: Schema.String, why: Schema.NullOr(Schema.String) }),
  ),
  /** Turns their voice was heard in. */
  heard: Schema.Number,
  firstSeen: Schema.NullOr(Schema.String),
  lastSeen: Schema.NullOr(Schema.String),
  /** When an unnamed voice and what it said are deleted; null: kept until someone asks her to forget. */
  keepUntil: Schema.NullOr(Schema.String),
  askName: Schema.Boolean,
  impression: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.Struct({ at: Schema.String, said: Schema.String })),
});
export type TessayaPerson = typeof TessayaPerson.Type;
export const TessayaPeopleSuggestion = Schema.Struct({
  kind: Schema.Literals(["same", "name", "split"]),
  id: Schema.String,
  /** With `same`: the other person. */
  other: Schema.NullOr(Schema.String),
  score: Schema.NullOr(Schema.Number),
  line: Schema.String,
});
export type TessayaPeopleSuggestion = typeof TessayaPeopleSuggestion.Type;

export const TessayaHouseholdCallResult = Schema.Struct({
  /** done: changed now. asked: sent to the owner's approving device, changes on a yes. refused: with why. */
  status: Schema.Literals(["done", "asked", "refused"]),
  /** What happened, in words she can say. */
  line: Schema.String,
  members: Schema.optionalKey(Schema.Array(TessayaHouseholdMember)),
  /** A new pairing code: shown once to whoever asked for it. */
  code: Schema.optionalKey(Schema.String),
  codeExpiresAt: Schema.optionalKey(IsoDateTime),
  /** The plain warning a machine grant carries. */
  warning: Schema.optionalKey(Schema.String),
  /** With `list`: the linked server the members live on (null: this one), and the linked servers it could be. */
  homeOn: Schema.optionalKey(Schema.NullOr(Schema.String)),
  peers: Schema.optionalKey(Schema.Array(Schema.String)),
  voices: Schema.optionalKey(Schema.Array(TessayaVoiceProfile)),
  /** With `passkeyOptions`: the challenge, the site it is for, and the member's passkeys. */
  passkey: Schema.optionalKey(
    Schema.Struct({
      challenge: Schema.String,
      rpId: Schema.String,
      userId: Schema.String,
      userName: Schema.String,
      keys: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
    }),
  ),
  /** With `home`: members whose devices are connected now (minutesAgo 0) or were within the last quarter hour. */
  around: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        connected: Schema.Number,
        minutesAgo: Schema.Number,
      }),
    ),
  ),
  /** With `home`: where each member likely is, fused from every signal, and why (B-043). */
  presence: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        confidence: Schema.Number,
        nearest: Schema.NullOr(Schema.Struct({ name: Schema.String, confidence: Schema.Number })),
        reasons: Schema.Array(Schema.String),
      }),
    ),
  ),
  /** With `preferences`: that member's, by key. */
  preferences: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** With `peopleObserve` and `peopleIntroduce`: the voice's person, and the line she is given for this turn. */
  person: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        name: Schema.NullOr(Schema.String),
        status: TessayaPersonStatus,
        recognised: Schema.Boolean,
        line: Schema.String,
      }),
    ),
  ),
  /** With `peopleList`: everyone, the suggestions, how long unsaved voices are kept, and whether she asks names. */
  people: Schema.optionalKey(Schema.Array(TessayaPerson)),
  suggestions: Schema.optionalKey(Schema.Array(TessayaPeopleSuggestion)),
  retentionDays: Schema.optionalKey(Schema.Number),
  /**
   * Recently forgotten, newest first: restorable for `binDays`, then deleted for good. `by`: owner, themselves, expiry
   * or tidy (her own tidying).
   * With `fact`: one fact forgotten from her understanding of `name` (a persona's name when about herself), or a
   * forgotten memory (`name` "Memory" or "Episode").
   */
  forgotten: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.NullOr(Schema.String),
        by: Schema.String,
        at: Schema.String,
        fact: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  binDays: Schema.optionalKey(Schema.Number),
  askNames: Schema.optionalKey(Schema.Boolean),
});
export type TessayaHouseholdCallResult = typeof TessayaHouseholdCallResult.Type;
