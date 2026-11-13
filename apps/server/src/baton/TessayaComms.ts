// @effect-diagnostics globalJsonInEffect:off
/**
 * Comms (tessaya-ops research/COMMS-DESIGN.md): notes, broadcasts, reactions, receipts, calls and drop-in consent, for
 * every vessel. One service: a vessel's tools, a client's route and an agent's MCP tool each make one `call`, as the
 * `HouseholdCaller` the transport set. Who someone is and their role come from the household; comms keeps no people
 * list. Every act is one Record row; a note's content is never written there.
 */
import type {
  CommsAddress,
  CommsCallInput,
  CommsCallResult,
  CommsConsent,
  CommsForms,
  CommsNote,
} from "@t3tools/baton-contracts";
import {
  fallbackForms,
  GROUP_ROLES,
  parseAddress,
  personAddress,
  trimForms,
} from "@t3tools/baton-shared/comms";
import type { MemberRole } from "@t3tools/baton-shared/household";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as SqlClient from "effect/sql/SqlClient";

import { BatonRecordService } from "./BatonRecordService.ts";
import { HouseholdCaller, TessayaHousehold } from "./TessayaHousehold.ts";

type Result = CommsCallResult;
const refused = (line: string): Result => ({ status: "refused", line });

interface NoteRow {
  readonly id: string;
  readonly kind: CommsNote["kind"];
  readonly from_member: string | null;
  readonly from_label: string;
  readonly from_vessel: string | null;
  readonly to_json: string;
  readonly text: string;
  readonly forms_json: string;
  readonly urgency: CommsNote["urgency"];
  readonly private: number;
  readonly reply_to: string | null;
  readonly tag: string | null;
  readonly audio: string | null;
  readonly created_at: string;
  readonly deliver_at: string | null;
  readonly expires_at: string | null;
}
// Written only here, from decoded input: never malformed.
const noteOf = (r: NoteRow): CommsNote => ({
  id: r.id,
  kind: r.kind,
  from: r.from_member,
  fromLabel: r.from_label,
  fromVessel: r.from_vessel,
  to: JSON.parse(r.to_json) as Array<CommsAddress>,
  text: r.text,
  forms: JSON.parse(r.forms_json) as CommsForms,
  urgency: r.urgency,
  private: r.private === 1,
  replyTo: r.reply_to,
  tag: r.tag,
  audio: r.audio,
  createdAt: r.created_at,
  deliverAt: r.deliver_at,
  expiresAt: r.expires_at,
});

interface ConsentRow {
  readonly target: string;
  readonly caller: string;
  readonly state: CommsConsent["state"];
  readonly set_by: string;
  readonly since: string;
}
const consentOf = (r: ConsentRow): CommsConsent => ({
  target: r.target as CommsAddress,
  caller: r.caller,
  state: r.state,
  setBy: r.set_by,
  since: r.since,
});

/** Voice notes keep their audio this long by default (§5.5); text notes until deleted. */
export const VOICE_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

/** Whether a member with this role is among a note's recipients, by person, group or `all`. */
export const addressedTo = (
  to: ReadonlyArray<string>,
  member: string,
  role: MemberRole | null,
): boolean =>
  to.some((address) => {
    const t = parseAddress(address);
    if (t === null) return false;
    if (t.kind === "all") return role !== null && role !== "guest";
    if (t.kind === "person") return t.id === member.toLowerCase();
    if (t.kind === "group") return role !== null && (GROUP_ROLES[t.id] ?? []).includes(role);
    return false;
  });

export class TessayaComms extends Context.Service<
  TessayaComms,
  {
    /** One request, as `HouseholdCaller`. */
    readonly call: (input: CommsCallInput) => Effect.Effect<Result>;
  }
>()("t3/baton/TessayaComms") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const household = yield* TessayaHousehold;
  const record = yield* Effect.serviceOption(BatonRecordService);

  const nowIso = Effect.map(Clock.currentTimeMillis, (ms) =>
    DateTime.formatIso(DateTime.makeUnsafe(ms)),
  );
  const write = (entry: {
    readonly actor: string;
    readonly subject: string;
    readonly outcome: string;
    readonly ref?: string;
    readonly detail?: string;
  }) => (Option.isNone(record) ? Effect.void : record.value.append({ kind: "comms", ...entry }));

  /** Who is asking: their member, role and name; a service acts for its member, with the member's role. */
  const who = Effect.gen(function* () {
    const caller = yield* HouseholdCaller;
    const grants = caller.member === null ? null : yield* household.grantsOf(caller.member);
    return {
      caller,
      member: grants === null ? null : caller.member,
      role: grants?.role ?? null,
      name: grants?.name ?? null,
    };
  });

  const loadNote = (id: string) =>
    sql<NoteRow>`SELECT * FROM tessaya_comms_notes WHERE id = ${id}`.pipe(
      Effect.orDie,
      Effect.map((rows) => (rows[0] === undefined ? null : noteOf(rows[0]))),
    );

  const insertNote = (note: CommsNote) =>
    sql`
      INSERT INTO tessaya_comms_notes (id, kind, from_member, from_label, from_vessel, to_json, text, forms_json,
        urgency, private, reply_to, tag, audio, created_at, deliver_at, expires_at)
      VALUES (${note.id}, ${note.kind}, ${note.from}, ${note.fromLabel}, ${note.fromVessel},
        ${JSON.stringify(note.to)}, ${note.text}, ${JSON.stringify(note.forms)}, ${note.urgency},
        ${note.private ? 1 : 0}, ${note.replyTo}, ${note.tag}, ${note.audio}, ${note.createdAt},
        ${note.deliverAt}, ${note.expiresAt})
    `.pipe(Effect.orDie);

  const newId = Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    return `note-${at.toString(36)}-${(yield* Random.nextIntBetween(0, 0xffffff)).toString(16)}`;
  });

  /** Whether this member may see this note: they sent it, or it is addressed to them. */
  const visibleTo = (note: CommsNote, member: string, role: MemberRole | null) =>
    note.from === member || addressedTo(note.to, member, role);

  const send = Effect.fn("TessayaComms.send")(function* (
    input: Extract<CommsCallInput, { op: "send" }>,
  ) {
    const { caller, member, role, name } = yield* who;
    if (caller.member !== null && member === null)
      return refused("Only members of this home can send messages.");
    if (role === "guest") return refused("A guest can't send messages here.");
    const bad = input.to.find((a) => parseAddress(a) === null);
    if (bad !== undefined) return refused(`I don't know who "${bad}" is.`);
    if (input.replyTo !== undefined && (yield* loadNote(input.replyTo)) === null)
      return refused("I can't find the message you're replying to.");
    const now = yield* Clock.currentTimeMillis;
    const createdAt = DateTime.formatIso(DateTime.makeUnsafe(now));
    const fromLabel = name ?? `someone via ${caller.via}`;
    const note: CommsNote = {
      id: yield* newId,
      kind: input.kind,
      from: member,
      fromLabel,
      fromVessel: null,
      to: input.to,
      text: input.text,
      forms:
        input.forms === undefined ? fallbackForms(input.text, fromLabel) : trimForms(input.forms),
      // A child's "urgent" is theirs to feel, not to override anyone's quiet (§5.1): it stays soon.
      urgency:
        input.urgency === "urgent" && role === "child" ? "soon" : (input.urgency ?? "normal"),
      private: input.private === true,
      replyTo: input.replyTo ?? null,
      tag: null,
      audio: input.audio ?? null,
      createdAt,
      deliverAt: input.deliverAt ?? null,
      expiresAt:
        input.kind === "voice"
          ? DateTime.formatIso(DateTime.makeUnsafe(now + VOICE_KEEP_DAYS * DAY_MS))
          : null,
    };
    yield* insertNote(note);
    yield* write({
      actor: fromLabel,
      subject: `${note.kind} to ${note.to.join(", ")}`,
      outcome: "sent",
      ref: note.id,
      detail: `urgency ${note.urgency}${note.private ? ", private" : ""} via ${caller.via}`,
    });
    return { status: "done", line: "Sent.", note } satisfies Result;
  });

  const inbox = Effect.fn("TessayaComms.inbox")(function* (
    input: Extract<CommsCallInput, { op: "inbox" }>,
  ) {
    const { member, role } = yield* who;
    if (member === null) return refused("I need to know who you are to read your messages.");
    const rows = yield* sql<NoteRow>`
      SELECT * FROM tessaya_comms_notes ORDER BY created_at DESC LIMIT 500
    `.pipe(Effect.orDie);
    const read = new Set(
      (yield* sql<{ note_id: string }>`
        SELECT note_id FROM tessaya_comms_receipts WHERE person = ${member} AND state IN ('read', 'replied')
      `.pipe(Effect.orDie)).map((r) => r.note_id),
    );
    const notes = rows
      .map(noteOf)
      .filter((n) => n.from !== member && addressedTo(n.to, member, role))
      .filter((n) => input.unreadOnly !== true || !read.has(n.id))
      .slice(0, 50);
    return {
      status: "done",
      line:
        notes.length === 0
          ? "No messages."
          : `${notes.length} message${notes.length === 1 ? "" : "s"}.`,
      notes,
    } satisfies Result;
  });

  const react = Effect.fn("TessayaComms.react")(function* (
    input: Extract<CommsCallInput, { op: "react" }>,
  ) {
    const { member, role, name } = yield* who;
    if (member === null || role === "guest") return refused("Only members of this home can react.");
    const note = yield* loadNote(input.noteId);
    if (note === null || !visibleTo(note, member, role))
      return refused("I can't find that message.");
    if (note.from === null) return refused("That message has nobody to react to.");
    const at = yield* nowIso;
    const fromLabel = name ?? member;
    const reaction: CommsNote = {
      id: yield* newId,
      kind: "reaction",
      from: member,
      fromLabel,
      fromVessel: null,
      to: [personAddress(note.from)],
      text: input.emoji,
      forms: { ...fallbackForms(input.emoji, fromLabel), mood: "happy" },
      urgency: "normal",
      private: false,
      replyTo: note.id,
      tag: null,
      audio: null,
      createdAt: at,
      deliverAt: null,
      expiresAt: null,
    };
    yield* insertNote(reaction);
    yield* write({
      actor: fromLabel,
      subject: `reaction to ${note.id}`,
      outcome: "sent",
      ref: reaction.id,
    });
    return { status: "done", line: "Done.", note: reaction } satisfies Result;
  });

  /**
   * Who may set consent on a target (§5.2): a person sets their own; a vessel or room is the owner's or an admin's. A
   * child never opens their own room to drop-ins (a parent's knock there stays).
   */
  const consentRefusal = (
    target: CommsAddress,
    state: CommsConsent["state"],
    member: string,
    role: MemberRole | null,
  ): string | null => {
    const t = parseAddress(target);
    if (t === null || t.kind === "all" || t.kind === "group")
      return "Consent is set for one person, room or device.";
    if (role === null || role === "guest") return "Only members of this home set who may drop in.";
    if (t.kind === "person") {
      if (t.id !== member.toLowerCase() && role !== "owner" && role !== "admin")
        return "Only that person, or the owner, sets who may drop in on them.";
      if (role === "child" && state === "allow")
        return "A parent sets drop-ins for a child; you can ask them.";
      return null;
    }
    return role === "owner" || role === "admin"
      ? null
      : "The owner sets who may drop in on a room or a device.";
  };

  const consentSet = Effect.fn("TessayaComms.consentSet")(function* (
    input: Extract<CommsCallInput, { op: "consentSet" }>,
  ) {
    const { member, role, name } = yield* who;
    if (member === null) return refused("I need to know who you are to change that.");
    const why = consentRefusal(input.target, input.state, member, role);
    if (why !== null) return refused(why);
    const since = yield* nowIso;
    const target = input.target.toLowerCase() as CommsAddress;
    yield* sql`
      INSERT INTO tessaya_comms_consent (target, caller, state, set_by, since)
      VALUES (${target}, ${input.caller}, ${input.state}, ${member}, ${since})
      ON CONFLICT (target, caller) DO UPDATE SET state = excluded.state, set_by = excluded.set_by,
        since = excluded.since
    `.pipe(Effect.orDie);
    yield* write({
      actor: name ?? member,
      subject: `drop-in on ${target} by ${input.caller}`,
      outcome: input.state,
    });
    const line =
      input.state === "allow"
        ? `${input.caller} may now drop in on ${target}. Set it back to knock any time.`
        : input.state === "knock"
          ? `${input.caller} now knocks first on ${target}.`
          : `${input.caller} can't reach ${target} by drop-in or knock.`;
    return {
      status: "done",
      line,
      consents: [{ target, caller: input.caller, state: input.state, setBy: member, since }],
    } satisfies Result;
  });

  const consents = Effect.fn("TessayaComms.consents")(function* () {
    const { member, role } = yield* who;
    if (member === null) return refused("I need to know who you are to show that.");
    const rows =
      yield* sql<ConsentRow>`SELECT * FROM tessaya_comms_consent ORDER BY since DESC`.pipe(
        Effect.orDie,
      );
    const mine = personAddress(member).toLowerCase();
    const shown = rows
      .map(consentOf)
      .filter(
        (c) =>
          role === "owner" ||
          role === "admin" ||
          c.target === mine ||
          c.setBy === member ||
          c.caller === member,
      );
    return { status: "done", line: `${shown.length} set.`, consents: shown } satisfies Result;
  });

  /** A member's own log; the owner sees everyone's metadata, never the words (Decision 5). */
  const log = Effect.fn("TessayaComms.log")(function* (
    input: Extract<CommsCallInput, { op: "log" }>,
  ) {
    const { member, role } = yield* who;
    if (member === null) return refused("I need to know who you are to show that.");
    const rows = yield* sql<NoteRow>`
      SELECT * FROM tessaya_comms_notes ORDER BY created_at DESC LIMIT 1000
    `.pipe(Effect.orDie);
    const notes = rows
      .map(noteOf)
      .flatMap((n) =>
        visibleTo(n, member, role)
          ? [n]
          : role === "owner"
            ? [
                {
                  ...n,
                  text: "",
                  audio: null,
                  forms: { ...n.forms, glance: { emoji: "💬", words: "" }, spoken: "" },
                },
              ]
            : [],
      )
      .slice(0, input.limit ?? 50);
    return { status: "done", line: `${notes.length} shown.`, notes } satisfies Result;
  });

  const call = Effect.fn("TessayaComms.call")(function* (input: CommsCallInput) {
    switch (input.op) {
      case "send":
        return yield* send(input);
      case "inbox":
        return yield* inbox(input);
      case "react":
        return yield* react(input);
      case "consentSet":
        return yield* consentSet(input);
      case "consents":
        return yield* consents();
      case "log":
        return yield* log(input);
    }
  });

  return TessayaComms.of({ call });
});

export const layer = Layer.effect(TessayaComms, make);
