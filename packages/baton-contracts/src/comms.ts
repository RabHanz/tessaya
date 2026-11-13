/**
 * Comms over the wire (tessaya-ops research/COMMS-DESIGN.md): notes (messages, broadcasts, reactions), receipts, calls
 * with N legs, and drop-in consent. Every request is one `op` to the server's TessayaComms, from a vessel's tools, a
 * client's route or an agent's MCP tool; the server decides who may reach whom from the caller's member and role.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";

import { R1_MOODS } from "./devices.ts";

/**
 * Who a note or call is for: `person:<memberId>`, `room:<room>`, `group:<role or list>` (`group:kids` is the child
 * role), `vessel:<deviceId>`, or `all`. A person is followed to wherever they are; a room or vessel stays put.
 */
export const CommsAddress = Schema.String.check(
  Schema.isPattern(/^(all|(person|room|group|vessel):[^\s:]{1,128})$/),
);
export type CommsAddress = typeof CommsAddress.Type;

export const COMMS_NOTE_KINDS = ["text", "voice", "announce", "reaction"] as const;
export const COMMS_URGENCIES = ["normal", "soon", "urgent"] as const;
/** queued → delivered → played → heard (played where that person was verified present) → read; replied on a reply. */
export const COMMS_RECEIPT_STATES = [
  "queued",
  "delivered",
  "played",
  "heard",
  "read",
  "replied",
] as const;
export const COMMS_CALL_MODES = ["knock", "dropin", "announce-live"] as const;
export const COMMS_CONSENTS = ["allow", "knock", "never"] as const;

/** The note's forms, made once at send time; each vessel shows what its manifest can (COMMS-DESIGN §3). */
export const CommsForms = Schema.Struct({
  glance: Schema.Struct({
    /** One emoji. */
    emoji: Schema.String.check(Schema.isMaxLength(16)),
    /** Four words or fewer. */
    words: Schema.String.check(Schema.isMaxLength(48)),
  }),
  /** What a speaker says aloud ("From Sara: I'm running late"). */
  spoken: Schema.String.check(Schema.isMaxLength(600)),
  mood: Schema.Literals(R1_MOODS),
});
export type CommsForms = typeof CommsForms.Type;

export const CommsNote = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(COMMS_NOTE_KINDS),
  /** The sender's member id; null for someone the house could not name ("someone in the kitchen"). */
  from: Schema.NullOr(Schema.String),
  /** How the sender is named, from the server's verdict, never the client's claim. */
  fromLabel: Schema.String,
  /** The vessel it was sent from, if any. */
  fromVessel: Schema.NullOr(Schema.String),
  to: Schema.Array(CommsAddress),
  text: Schema.String,
  forms: CommsForms,
  urgency: Schema.Literals(COMMS_URGENCIES),
  /** Shown on a shared vessel only as its glance and "a message for <name>" until that person's voice is verified. */
  private: Schema.Boolean,
  /** A reaction or reply's note. */
  replyTo: Schema.NullOr(Schema.String),
  /** `voicemail` for a missed call's note. */
  tag: Schema.NullOr(Schema.String),
  /** A voice note's recording, by reference. */
  audio: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  deliverAt: Schema.NullOr(IsoDateTime),
  expiresAt: Schema.NullOr(IsoDateTime),
});
export type CommsNote = typeof CommsNote.Type;

export const CommsReceipt = Schema.Struct({
  noteId: Schema.String,
  /** The recipient member; null for a room or vessel nobody was named on. */
  person: Schema.NullOr(Schema.String),
  /** Where it was delivered or played; null while queued for the person. */
  vessel: Schema.NullOr(Schema.String),
  state: Schema.Literals(COMMS_RECEIPT_STATES),
  at: IsoDateTime,
});
export type CommsReceipt = typeof CommsReceipt.Type;

export const CommsLeg = Schema.Struct({
  vessel: Schema.String,
  /** Who answered there, when the house knows. */
  person: Schema.NullOr(Schema.String),
  state: Schema.Literals(["ringing", "live", "left"]),
  muted: Schema.Boolean,
  joinedAt: Schema.NullOr(IsoDateTime),
  leftAt: Schema.NullOr(IsoDateTime),
});
export type CommsLeg = typeof CommsLeg.Type;

/** A call is a room with N legs; two people talking is N = 2. */
export const CommsCall = Schema.Struct({
  id: TrimmedNonEmptyString,
  mode: Schema.Literals(COMMS_CALL_MODES),
  host: Schema.NullOr(Schema.String),
  hostLabel: Schema.String,
  to: Schema.Array(CommsAddress),
  legs: Schema.Array(CommsLeg),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  endReason: Schema.NullOr(Schema.String),
});
export type CommsCall = typeof CommsCall.Type;

/** May `caller` drop in on `target` (a `vessel:` or `person:`)? Knock is the default everywhere (Decision 1). */
export const CommsConsent = Schema.Struct({
  target: CommsAddress,
  caller: Schema.String,
  state: Schema.Literals(COMMS_CONSENTS),
  setBy: Schema.String,
  since: IsoDateTime,
});
export type CommsConsent = typeof CommsConsent.Type;

/** Quiet hours, as local times in a zone: "22:00" to "07:00" spans midnight. */
export const CommsQuietHours = Schema.Struct({
  from: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  to: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  timeZone: Schema.String.check(Schema.isMaxLength(64)),
});
export type CommsQuietHours = typeof CommsQuietHours.Type;

export const CommsSettings = Schema.Struct({
  enabled: Schema.Boolean,
  quietHours: Schema.NullOr(CommsQuietHours),
  /** The caller's own do-not-disturb end, if on. */
  dndUntil: Schema.NullOr(IsoDateTime),
});
export type CommsSettings = typeof CommsSettings.Type;

const op = <const O extends string, F extends Schema.Struct.Fields>(name: O, fields: F) =>
  Schema.Struct({ op: Schema.Literal(name), ...fields });

export const CommsCallInput = Schema.Union([
  /** A message, a broadcast (`announce`) or a voice note; forms the sender's turn did not make are made by the server. */
  op("send", {
    to: Schema.Array(CommsAddress).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
    kind: Schema.Literals(["text", "voice", "announce"]),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
    forms: Schema.optionalKey(CommsForms),
    urgency: Schema.optionalKey(Schema.Literals(COMMS_URGENCIES)),
    private: Schema.optionalKey(Schema.Boolean),
    replyTo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
    audio: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    deliverAt: Schema.optionalKey(IsoDateTime),
  }),
  /** The caller's own notes, newest first. */
  op("inbox", { unreadOnly: Schema.optionalKey(Schema.Boolean) }),
  /** One emoji on someone's note. */
  op("react", {
    noteId: Schema.String.check(Schema.isMaxLength(64)),
    emoji: TrimmedNonEmptyString.check(Schema.isMaxLength(16)),
  }),
  /** Who may drop in on `target`: allow, knock (the default) or never. */
  op("consentSet", {
    target: CommsAddress,
    caller: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    state: Schema.Literals(COMMS_CONSENTS),
  }),
  /** Every consent the caller set or that protects them. */
  op("consents", {}),
  /** Plays one of the caller's notes where they are, or returns it for their screen; marks it read. */
  op("play", { noteId: Schema.String.check(Schema.isMaxLength(64)) }),
  /** Do not disturb for the caller until a time, or off (null). */
  op("dnd", { until: Schema.NullOr(IsoDateTime) }),
  /** The owner's switches: comms on or off for this home, and the household's quiet hours (null: none). */
  op("settings", {
    enabled: Schema.optionalKey(Schema.Boolean),
    quietHours: Schema.optionalKey(Schema.NullOr(CommsQuietHours)),
  }),
  /** The comms log: a member's own; the owner sees everyone's metadata, never content (Decision 5). */
  op("log", {
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  }),
]);
export type CommsCallInput = typeof CommsCallInput.Type;

export const CommsCallResult = Schema.Struct({
  /** done: now. held: waits (quiet hours, an asleep vessel). refused: with why. */
  status: Schema.Literals(["done", "held", "refused"]),
  /** What happened, in words she can say. */
  line: Schema.String,
  note: Schema.optionalKey(CommsNote),
  notes: Schema.optionalKey(Schema.Array(CommsNote)),
  receipts: Schema.optionalKey(Schema.Array(CommsReceipt)),
  consents: Schema.optionalKey(Schema.Array(CommsConsent)),
  call: Schema.optionalKey(CommsCall),
  settings: Schema.optionalKey(CommsSettings),
  /** Where a note went, in words: "the kitchen R1", "Sara's phone". */
  delivered: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type CommsCallResult = typeof CommsCallResult.Type;
