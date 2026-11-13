// @effect-diagnostics globalJsonInEffect:off
/**
 * Comms (tessaya-ops research/COMMS-DESIGN.md): notes, broadcasts, reactions, receipts, calls and drop-in consent, for
 * every vessel. One service: a vessel's tools, a client's route and an agent's MCP tool each make one `call`, as the
 * `HouseholdCaller` the transport set. Who someone is and their role come from the household; comms keeps no people
 * list. Every act is one Record row; a note's content is never written there.
 */
import {
  CommsEmergencyKind,
  CommsQuietHours,
  type CommsAddress,
  type CommsCallInput,
  type CommsCallResult,
  type CommsConsent,
  type CommsEmergency,
  type CommsForms,
  type CommsNote,
  type CommsReceipt,
  type RegisteredDevice,
} from "@t3tools/baton-contracts";
import {
  commsCaps,
  fallbackForms,
  GROUP_ROLES,
  inQuietHours,
  parseAddress,
  personAddress,
  renderNote,
  trimForms,
} from "@t3tools/baton-shared/comms";
import { planDelivery, type DeliveryTarget } from "@t3tools/baton-shared/commsDelivery";
import {
  EMERGENCY_MAX_MS,
  EMERGENCY_REPEAT_MS,
  emergencyRateOk,
  emergencyRefusal,
} from "@t3tools/baton-shared/commsEmergency";
import { OWNER_MEMBER_ID } from "@t3tools/baton-shared/household";
import type { MemberRole } from "@t3tools/baton-shared/household";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { HomeDevices } from "../home/HomeDevices.ts";
import { TessayaTurn, TurnOrigin } from "./TessayaTurn.ts";

import { BatonPhoneInbox } from "./BatonPhoneInbox.ts";
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

/** The owner's switch: comms off (the default) sends nothing and plays nothing anywhere. */
export const ENABLED_KEY = "comms.enabled";
const QUIET_KEY = "comms.quietHours";
const DND_PREFIX = "comms.dnd.";
/** The item a screen vessel (a desktop, a phone) declares to take notes: the server writes the plan to it. */
export const NOTE_ITEM = "comms.note";
export const OFF_LINE =
  "Messages are off in this home. The owner turns them on in Tessaya's window under Intercom, or under Messages on the phone page.";
const KINDS_KEY = "comms.emergencyKinds";
const decodeKinds = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(CommsEmergencyKind)),
);
const decodeQuiet = Schema.decodeUnknownOption(Schema.fromJsonString(CommsQuietHours));
const RECEIPT_RANK: Readonly<Record<CommsReceipt["state"], number>> = {
  queued: 0,
  delivered: 1,
  played: 2,
  heard: 3,
  read: 4,
  replied: 5,
};

/** Voice notes keep their audio this long by default (§5.5); text notes until deleted. */
export const VOICE_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Whose own device a vessel is: a client vessel (a phone, a desktop) belongs to the member whose session reported it,
 * and one from before members existed to the owner (identity I-0); a broker vessel (an R1) is the room's.
 */
export const personalOf = (d: Pick<RegisteredDevice, "via" | "member">): string | null =>
  d.via === "client" ? (d.member ?? OWNER_MEMBER_ID) : null;

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
    /**
     * Notes waiting for this member, told once at the vessel their turn came from: what a turn's context says to them.
     * Empty while comms is off.
     */
    readonly waitingFor: (
      member: string,
      vessel: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly from: string; readonly count: number }>>;
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

  const setting = (key: string) =>
    sql<{ value: string }>`SELECT value FROM fabric_settings WHERE key = ${key}`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]?.value ?? null),
    );
  const setSetting = (key: string, value: string | null) =>
    (value === null
      ? sql`DELETE FROM fabric_settings WHERE key = ${key}`
      : sql`INSERT INTO fabric_settings (key, value) VALUES (${key}, ${value})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    ).pipe(Effect.orDie, Effect.asVoid);
  const enabled = Effect.map(setting(ENABLED_KEY), (v) => v === "on");
  const quietHours = Effect.map(setting(QUIET_KEY), (v) =>
    v === null ? null : Option.getOrNull(decodeQuiet(v)),
  );
  /** A member's do-not-disturb end (ms), or null when off or over. */
  const dndUntil = Effect.fn("TessayaComms.dndUntil")(function* (member: string) {
    const v = yield* setting(`${DND_PREFIX}${member}`);
    const until = v === null ? Number.NaN : Date.parse(v);
    return Number.isFinite(until) && until > (yield* Clock.currentTimeMillis) ? until : null;
  });

  const receipt = Effect.fn("TessayaComms.receipt")(function* (
    noteId: string,
    person: string | null,
    vessel: string | null,
    state: CommsReceipt["state"],
  ) {
    const at = yield* nowIso;
    const [had] = yield* sql<{ state: CommsReceipt["state"] }>`
      SELECT state FROM tessaya_comms_receipts
      WHERE note_id = ${noteId} AND person = ${person ?? ""} AND vessel = ${vessel ?? ""}
    `.pipe(Effect.orDie);
    if (had !== undefined && RECEIPT_RANK[had.state] >= RECEIPT_RANK[state]) return;
    yield* sql`
      INSERT INTO tessaya_comms_receipts (note_id, person, vessel, state, at)
      VALUES (${noteId}, ${person ?? ""}, ${vessel ?? ""}, ${state}, ${at})
      ON CONFLICT (note_id, person, vessel) DO UPDATE SET state = excluded.state, at = excluded.at
    `.pipe(Effect.orDie);
  });
  const receiptsOf = (noteIds: ReadonlyArray<string>) =>
    noteIds.length === 0
      ? Effect.succeed<ReadonlyArray<CommsReceipt>>([])
      : sql<{
          note_id: string;
          person: string;
          vessel: string;
          state: CommsReceipt["state"];
          at: string;
        }>`
          SELECT * FROM tessaya_comms_receipts WHERE ${sql.in("note_id", noteIds)}
        `.pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((r): CommsReceipt => ({
              noteId: r.note_id,
              person: r.person === "" ? null : r.person,
              vessel: r.vessel === "" ? null : r.vessel,
              state: r.state,
              at: r.at,
            })),
          ),
        );

  /** The household as the comms service sees it: who lives here, with their roles. */
  const members = Effect.map(
    household.call({ op: "list" }).pipe(
      Effect.provideService(HouseholdCaller, {
        member: OWNER_MEMBER_ID,
        service: true,
        assurance: 0,
        via: "comms",
      }),
    ),
    (r) =>
      (r.members ?? [])
        .filter((m) => m.state === "active")
        .map((m) => ({ id: m.id, name: m.name, role: m.role })),
  );

  /** Speaks or shows one note on one vessel through that vessel's own adapter; what it did, or null. */
  const show = Effect.fn("TessayaComms.show")(function* (
    note: CommsNote,
    target: DeliveryTarget,
    dryRun: boolean,
  ) {
    const registry = yield* Effect.serviceOption(DeviceRegistry);
    if (Option.isNone(registry)) return null;
    const device = yield* registry.value.get(target.vessel);
    if (device === null) return null;
    const caps = commsCaps(device);
    const plan = renderNote(note, caps, { personal: target.personal, forName: target.forName });
    const quiet = target.silent ? { ...plan, sound: null, voice: null } : plan;
    if (caps.display === "eyes-round") {
      const devices = yield* Effect.serviceOption(HomeDevices);
      if (Option.isNone(devices)) return null;
      const by = { who: `a message from ${note.fromLabel}`, surface: "assistant" as const, dryRun };
      yield* devices.value
        .command(target.vessel, { op: "eye", mood: quiet.mood, holdMs: 6_000 }, by)
        .pipe(Effect.ignore);
      // shortcut: a voice note plays its transcript in her voice until the R1 has a clip path (voice/play).
      const words =
        quiet.voice === null ? null : "say" in quiet.voice ? quiet.voice.say : note.forms.spoken;
      if (words === null) return null;
      const said = yield* devices.value
        .command(target.vessel, { op: "say", text: words }, by)
        .pipe(
          Effect.as(true),
          Effect.catchTags({ DeviceRefusedError: () => Effect.succeed(false) }),
        );
      return said ? ("played" as const) : null;
    }
    if (!device.items.some((i) => i.id === NOTE_ITEM)) return null;
    if (dryRun) return "delivered" as const;
    const wrote = yield* registry.value
      .write(target.vessel, NOTE_ITEM, {
        id: note.id,
        kind: note.kind,
        from: note.fromLabel,
        urgency: note.urgency,
        plan: quiet,
      })
      .pipe(Effect.as(true), Effect.catchTags({ DeviceRefusedError: () => Effect.succeed(false) }));
    return wrote ? ("delivered" as const) : null;
  });

  /** Sends a note on its way (§2.4): where each recipient is now, or waits for them. Returns where it went. */
  const deliver = Effect.fn("TessayaComms.deliver")(function* (
    note: CommsNote,
    senderRole: MemberRole | null,
  ) {
    const origin = yield* TurnOrigin;
    const dryRun = origin?.rehearsal === true;
    const registry = yield* Effect.serviceOption(DeviceRegistry);
    const devices = Option.isNone(registry) ? [] : yield* registry.value.list;
    const turn = yield* Effect.serviceOption(TessayaTurn);
    const heard = Option.isNone(turn) ? [] : yield* turn.value.whoIsHome;
    const people = yield* members;
    const dnd = new Set<string>();
    for (const m of people) if ((yield* dndUntil(m.id)) !== null) dnd.add(m.id);
    const plan = planDelivery({
      note,
      senderRole,
      members: people,
      vessels: devices.map((d) => ({
        id: d.deviceId,
        name: d.name,
        online: d.online,
        caps: commsCaps(d),
        personalOf: personalOf(d),
      })),
      presence: heard.flatMap((h) =>
        h.heard === null
          ? []
          : [{ member: h.member, vessel: h.heard.vessel, minutesAgo: h.heard.minutesAgo }],
      ),
      quietNow: inQuietHours(yield* Clock.currentTimeMillis, yield* quietHours),
      dnd,
    });
    const went: Array<string> = [];
    for (const target of plan.targets) {
      const state = yield* show(note, target, dryRun);
      if (state === null) {
        if (target.person !== null && !dryRun)
          yield* receipt(note.id, target.person, null, "queued");
        continue;
      }
      went.push(devices.find((d) => d.deviceId === target.vessel)?.name ?? target.vessel);
      if (!dryRun) yield* receipt(note.id, target.person, target.vessel, state);
    }
    // His phone: a card in its inbox, the push his phone already gets (§2.4 step 2), for a note that is his.
    const inbox = yield* Effect.serviceOption(BatonPhoneInbox);
    const toHisPhone =
      Option.isSome(inbox) &&
      !dryRun &&
      note.kind !== "reaction" &&
      note.from !== OWNER_MEMBER_ID &&
      addressedTo(note.to, OWNER_MEMBER_ID, "owner");
    if (toHisPhone) {
      yield* inbox.value.mirror({
        id: `comms-${note.id}`,
        title: `${note.forms.glance.emoji} ${note.fromLabel}`,
        detail: note.private ? "A private message: open Messages to read it." : note.text,
        buttons: ["OK"],
        yes: 0,
        cancel: 0,
      });
      went.push("your phone");
    }
    const waiting = plan.waiting.filter((id) => !(toHisPhone && id === OWNER_MEMBER_ID));
    if (!dryRun) for (const person of waiting) yield* receipt(note.id, person, null, "queued");
    return { went, waiting: waiting.map((id) => people.find((m) => m.id === id)?.name ?? id) };
  });

  const send = Effect.fn("TessayaComms.send")(function* (
    input: Extract<CommsCallInput, { op: "send" }>,
  ) {
    const { caller, member, role, name } = yield* who;
    if (caller.member !== null && member === null)
      return refused("Only members of this home can send messages.");
    if (role === "guest") return refused("A guest can't send messages here.");
    if (!(yield* enabled)) return refused(OFF_LINE);
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
    const rehearsal = (yield* TurnOrigin)?.rehearsal === true;
    if (!rehearsal) yield* insertNote(note);
    const { went, waiting } = yield* deliver(note, role);
    if (!rehearsal)
      yield* write({
        actor: fromLabel,
        subject: `${note.kind} to ${note.to.join(", ")}`,
        outcome: "sent",
        ref: note.id,
        detail: `urgency ${note.urgency}${note.private ? ", private" : ""} via ${caller.via}; on ${went.length} vessel(s), ${waiting.length} waiting`,
      });
    const line = [
      went.length === 0 ? "Sent." : `Sent: on ${went.join(", ")}.`,
      waiting.length === 0
        ? ""
        : `It waits for ${waiting.join(", ")}, who I can't reach now; I'll tell them when I next hear them.`,
      rehearsal ? "(A replay: nothing was sent.)" : "",
    ]
      .filter((x) => x !== "")
      .join(" ");
    return { status: "done", line, note, delivered: went } satisfies Result;
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
    const { caller } = yield* who;
    const all = rows.map(noteOf);
    // A private note shows only that it exists until it's surely them (A2): a shared vessel's unsure voice, say.
    const sure = caller.assurance >= 2;
    const received = all
      .filter((n) => n.from !== member && addressedTo(n.to, member, role))
      .filter((n) => input.unreadOnly !== true || !read.has(n.id))
      .map((n) =>
        n.private && !sure
          ? {
              ...n,
              text: "",
              audio: null,
              forms: { ...n.forms, spoken: `A private message from ${n.fromLabel}.` },
            }
          : n,
      )
      .slice(0, 50);
    // What they sent lately, with its receipts, for "did Sara get it?".
    const sent = all.filter((n) => n.from === member && n.kind !== "reaction").slice(0, 5);
    const receipts = yield* receiptsOf(sent.map((n) => n.id));
    return {
      status: "done",
      line:
        received.length === 0
          ? "No messages."
          : `${received.length} message${received.length === 1 ? "" : "s"}.`,
      notes: [...received, ...sent],
      receipts,
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
    if (!(yield* enabled)) return refused(OFF_LINE);
    if ((yield* TurnOrigin)?.rehearsal === true)
      return {
        status: "done",
        line: "Done. (A replay: nothing was sent.)",
        note: reaction,
      } satisfies Result;
    yield* insertNote(reaction);
    yield* receipt(note.id, member, null, "replied");
    // Quietly on the sender's own screens; a reaction never rings (§8.6).
    yield* deliver(reaction, role);
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

  const emergencyKindsNow = Effect.map(setting(KINDS_KEY), (v) =>
    v === null ? [] : Option.getOrElse(decodeKinds(v), () => []),
  );
  // shortcut: the sounding emergency lives in this server's memory; a restart ends it (the Record keeps it).
  let active: {
    readonly kind: CommsEmergencyKind;
    readonly by: string;
    readonly byMember: string | null;
    readonly note: CommsNote;
    readonly startedAt: number;
    readonly pending: Set<string>;
    readonly acked: Set<string>;
    fiber: Fiber.Fiber<void> | null;
  } | null = null;
  const lastSounded = new Map<string, number>();
  const emergencyView = (): CommsEmergency | null =>
    active === null
      ? null
      : {
          kind: active.kind.id,
          label: active.kind.label,
          by: active.by,
          startedAt: DateTime.formatIso(DateTime.makeUnsafe(active.startedAt)),
          pending: [...active.pending],
          acked: [...active.acked],
        };

  /** Every awake vessel at once, through quiet hours and do-not-disturb (§8.7). */
  const soundEverywhere = Effect.fn("TessayaComms.soundEverywhere")(function* (note: CommsNote) {
    const registry = yield* Effect.serviceOption(DeviceRegistry);
    const devices = Option.isNone(registry) ? [] : yield* registry.value.list;
    const plan = planDelivery({
      note,
      senderRole: "owner",
      members: yield* members,
      vessels: devices.map((d) => ({
        id: d.deviceId,
        name: d.name,
        online: d.online,
        caps: commsCaps(d),
        personalOf: personalOf(d),
      })),
      presence: [],
      quietNow: false,
      dnd: new Set(),
    });
    for (const target of plan.targets) yield* show(note, target, false);
    const inbox = yield* Effect.serviceOption(BatonPhoneInbox);
    if (Option.isSome(inbox))
      yield* inbox.value.mirror({
        id: `comms-${note.id}-${yield* Clock.currentTimeMillis}`,
        title: `🚨 ${note.forms.glance.words}`,
        detail: note.text,
        buttons: ["OK"],
        yes: 0,
        cancel: 0,
      });
  });

  const endEmergency = Effect.fn("TessayaComms.endEmergency")(function* (why: string, by: string) {
    const was = active;
    if (was === null) return;
    active = null;
    if (was.fiber !== null) yield* Fiber.interrupt(was.fiber);
    yield* write({
      actor: by,
      subject: `emergency ${was.kind.label}`,
      outcome: "ended",
      ref: was.note.id,
      detail: `${why}; never answered: ${[...was.pending].join(", ") || "nobody"}`,
    });
  });

  const emergencyKinds = Effect.fn("TessayaComms.emergencyKinds")(function* (
    input: Extract<CommsCallInput, { op: "emergencyKinds" }>,
  ) {
    const { member, role, name } = yield* who;
    if (input.kinds !== undefined) {
      if (role !== "owner" && role !== "admin")
        return refused("Only the owner sets the emergencies.");
      yield* setSetting(KINDS_KEY, input.kinds.length === 0 ? null : JSON.stringify(input.kinds));
      yield* write({
        actor: name ?? member ?? "someone",
        subject: "emergency kinds",
        outcome: "changed",
        detail: input.kinds.map((k) => k.label).join(", "),
      });
    }
    const kinds = yield* emergencyKindsNow;
    return {
      status: "done",
      line:
        kinds.length === 0
          ? "No emergencies are set up. The owner adds them in Tessaya's window under Intercom."
          : `Emergencies: ${kinds.map((k) => `${k.label} (${k.id})`).join(", ")}.`,
      emergencyKinds: kinds,
      emergency: emergencyView(),
    } satisfies Result;
  });

  const emergency = Effect.fn("TessayaComms.emergency")(function* (
    input: Extract<CommsCallInput, { op: "emergency" }>,
  ) {
    const { caller, member, role, name } = yield* who;
    const kind = (yield* emergencyKindsNow).find((k) => k.id === input.kind.toLowerCase());
    if (kind === undefined)
      return refused(
        `There is no emergency called "${input.kind}". ${(yield* emergencyKinds({ op: "emergencyKinds" })).line}`,
      );
    const why = emergencyRefusal(kind, { role, service: caller.service === true });
    if (why !== null) return refused(why);
    if (active !== null)
      return refused(
        `${active.kind.label} is already sounding. Say okay, or "false alarm" to stop it.`,
      );
    const now = yield* Clock.currentTimeMillis;
    if (!emergencyRateOk(lastSounded.get(kind.id) ?? null, now))
      return refused(
        `${kind.label} sounded a moment ago; wait two minutes before setting it off again.`,
      );
    const by = name ?? caller.via;
    const note: CommsNote = {
      id: yield* newId,
      kind: "announce",
      from: member,
      fromLabel: by,
      fromVessel: null,
      to: ["all"],
      text: kind.text,
      forms: {
        glance: { emoji: "🚨", words: kind.label.split(/\s+/).slice(0, 4).join(" ") },
        spoken: kind.text,
        mood: "surprise",
      },
      urgency: "urgent",
      private: false,
      replyTo: null,
      tag: "emergency",
      audio: null,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      deliverAt: null,
      expiresAt: null,
    };
    if ((yield* TurnOrigin)?.rehearsal === true)
      return {
        status: "done",
        line: `${kind.label} would sound now. (A replay: nothing sounded.)`,
        note,
      } satisfies Result;
    const people = (yield* members).filter(
      (m) => m.role !== "guest" && (kind.children || m.role !== "child"),
    );
    yield* insertNote(note);
    lastSounded.set(kind.id, now);
    const mine = {
      kind,
      by,
      byMember: member,
      note,
      startedAt: now,
      pending: new Set(people.map((m) => m.id)),
      acked: new Set<string>(),
      fiber: null as Fiber.Fiber<void> | null,
    };
    active = mine;
    yield* soundEverywhere(note);
    // Again every 20 s until each person says okay, a false alarm, or 30 minutes.
    mine.fiber = yield* Effect.forkDetach(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(EMERGENCY_REPEAT_MS);
          if (active !== mine || mine.pending.size === 0) return;
          if ((yield* Clock.currentTimeMillis) - mine.startedAt >= EMERGENCY_MAX_MS) {
            // This fiber ends itself: it must not wait on its own interrupt.
            mine.fiber = null;
            return yield* endEmergency("30 minutes passed", "comms");
          }
          yield* soundEverywhere(note);
        }
      }),
    );
    yield* write({
      actor: by,
      subject: `emergency ${kind.label}`,
      outcome: "sounding",
      ref: note.id,
      detail: `via ${caller.via}; ${people.length} to answer`,
    });
    return {
      status: "done",
      line: `${kind.label} is sounding everywhere, through quiet hours. It repeats until each person says okay; "false alarm" stops it.`,
      note,
      emergency: emergencyView(),
    } satisfies Result;
  });

  const emergencyAck = Effect.fn("TessayaComms.emergencyAck")(function* () {
    const { member, name } = yield* who;
    if (active === null) return refused("Nothing is sounding.");
    if ((yield* TurnOrigin)?.rehearsal === true)
      return { status: "done", line: "Okay. (A replay: nothing changed.)" } satisfies Result;
    if (member === null || !active.pending.has(member))
      return { status: "done", line: "Okay.", emergency: emergencyView() } satisfies Result;
    active.pending.delete(member);
    active.acked.add(member);
    yield* write({
      actor: name ?? member,
      subject: `emergency ${active.kind.label}`,
      outcome: "acknowledged",
      ref: active.note.id,
    });
    const left = active.pending.size;
    if (left === 0) yield* endEmergency("everyone said okay", name ?? member);
    return {
      status: "done",
      line:
        left === 0
          ? "Okay. Everyone has answered; it has stopped."
          : `Okay. Waiting on ${left} more.`,
      emergency: emergencyView(),
    } satisfies Result;
  });

  const emergencyCancel = Effect.fn("TessayaComms.emergencyCancel")(function* () {
    const { member, role, name } = yield* who;
    if (active === null) return refused("Nothing is sounding.");
    const mayCancel =
      role === "owner" ||
      role === "admin" ||
      role === "adult" ||
      (member !== null && member === active.byMember);
    if (!mayCancel) return refused("A grown-up calls a false alarm.");
    if ((yield* TurnOrigin)?.rehearsal === true)
      return { status: "done", line: "Stopped. (A replay: nothing changed.)" } satisfies Result;
    const label = active.kind.label;
    yield* endEmergency("false alarm", name ?? member ?? "someone");
    const devices = yield* Effect.serviceOption(HomeDevices);
    const registry = yield* Effect.serviceOption(DeviceRegistry);
    if (Option.isSome(devices) && Option.isSome(registry))
      for (const d of yield* registry.value.list)
        if (d.online && commsCaps(d).display === "eyes-round")
          yield* devices.value
            .command(
              d.deviceId,
              { op: "say", text: `False alarm: ${label} is over. All clear.` },
              {
                who: "a false alarm",
                surface: "assistant",
              },
            )
            .pipe(Effect.ignore);
    return {
      status: "done",
      line: `Stopped everywhere: ${label} was a false alarm.`,
      emergency: null,
    } satisfies Result;
  });

  /** Plays one of the caller's notes where their turn is (an R1), or hands it to their screen; marks it read. */
  const play = Effect.fn("TessayaComms.play")(function* (
    input: Extract<CommsCallInput, { op: "play" }>,
  ) {
    const { caller, member, role } = yield* who;
    if (member === null) return refused("I need to know who you are to play your messages.");
    const note = yield* loadNote(input.noteId);
    if (note === null || !addressedTo(note.to, member, role))
      return refused("I can't find that message.");
    if (note.private && caller.assurance < 2)
      return refused(
        "That one is private: I need to be sure it's you. Try on your own phone, or say it again.",
      );
    const origin = yield* TurnOrigin;
    const rehearsal = origin?.rehearsal === true;
    let where: string | null = null;
    if (origin?.kind === "device") {
      const devices = yield* Effect.serviceOption(HomeDevices);
      if (Option.isSome(devices)) {
        // shortcut: a voice note plays its transcript in her voice until the R1 has a clip path (voice/play).
        const ok = yield* devices.value
          .command(
            origin.id,
            { op: "say", text: note.forms.spoken },
            {
              who: `${note.fromLabel}'s message`,
              surface: "assistant",
              dryRun: rehearsal,
            },
          )
          .pipe(
            Effect.as(true),
            Effect.catchTags({ DeviceRefusedError: () => Effect.succeed(false) }),
          );
        if (ok) where = origin.id;
      }
    }
    if (!rehearsal) yield* receipt(note.id, member, where, "read");
    return {
      status: "done",
      line: where === null ? `From ${note.fromLabel}: ${note.text}` : "Playing it.",
      note,
    } satisfies Result;
  });

  const dnd = Effect.fn("TessayaComms.dnd")(function* (
    input: Extract<CommsCallInput, { op: "dnd" }>,
  ) {
    const { member, name } = yield* who;
    if (member === null) return refused("I need to know who you are to change that.");
    const now = yield* Clock.currentTimeMillis;
    const until = input.until === null ? null : Date.parse(input.until);
    if (until !== null && !(until > now)) return refused("That time has already passed.");
    if ((yield* TurnOrigin)?.rehearsal === true)
      return { status: "done", line: "Done. (A replay: nothing changed.)" } satisfies Result;
    yield* setSetting(`${DND_PREFIX}${member}`, input.until);
    yield* write({
      actor: name ?? member,
      subject: "do not disturb",
      outcome: input.until === null ? "off" : "on",
      ...(input.until === null ? {} : { detail: `until ${input.until}` }),
    });
    return {
      status: "done",
      line:
        input.until === null
          ? "Do not disturb is off."
          : 'Do not disturb is on; messages wait quietly until then. Say "I\'m free" to end it sooner.',
      settings: { enabled: yield* enabled, quietHours: yield* quietHours, dndUntil: input.until },
    } satisfies Result;
  });

  /** The owner's switches; anyone may read them, with their own do-not-disturb. */
  const settings = Effect.fn("TessayaComms.settings")(function* (
    input: Extract<CommsCallInput, { op: "settings" }>,
  ) {
    const { member, role, name } = yield* who;
    if (member === null) return refused("I need to know who you are to show that.");
    const changes = input.enabled !== undefined || input.quietHours !== undefined;
    if (changes && role !== "owner" && role !== "admin")
      return refused("Only the owner changes how messages work in this home.");
    if (input.enabled !== undefined) yield* setSetting(ENABLED_KEY, input.enabled ? "on" : "off");
    if (input.quietHours !== undefined)
      yield* setSetting(
        QUIET_KEY,
        input.quietHours === null ? null : JSON.stringify(input.quietHours),
      );
    if (changes)
      yield* write({
        actor: name ?? member,
        subject: "comms settings",
        outcome: input.enabled === false ? "off" : input.enabled === true ? "on" : "changed",
      });
    const until = yield* dndUntil(member);
    return {
      status: "done",
      line: changes ? "Saved." : "",
      settings: {
        enabled: yield* enabled,
        quietHours: yield* quietHours,
        dndUntil: until === null ? null : DateTime.formatIso(DateTime.makeUnsafe(until)),
      },
      emergency: emergencyView(),
    } satisfies Result;
  });

  const waitingFor = Effect.fn("TessayaComms.waitingFor")(function* (
    member: string,
    vessel: string,
  ) {
    if (!(yield* enabled)) return [];
    const rows = yield* sql<{ note_id: string; from_label: string }>`
      SELECT r.note_id, n.from_label FROM tessaya_comms_receipts r
      JOIN tessaya_comms_notes n ON n.id = r.note_id
      WHERE r.person = ${member} AND r.state = 'queued' AND n.kind != 'reaction'
    `.pipe(Effect.orDie);
    const told = new Map<string, number>();
    for (const r of rows) {
      told.set(r.from_label, (told.get(r.from_label) ?? 0) + 1);
      yield* receipt(r.note_id, member, vessel, "delivered");
      yield* sql`DELETE FROM tessaya_comms_receipts
        WHERE note_id = ${r.note_id} AND person = ${member} AND vessel = '' AND state = 'queued'`.pipe(
        Effect.orDie,
      );
    }
    return [...told].map(([from, count]) => ({ from, count }));
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
      case "play":
        return yield* play(input);
      case "dnd":
        return yield* dnd(input);
      case "settings":
        return yield* settings(input);
      case "emergencyKinds":
        return yield* emergencyKinds(input);
      case "emergency":
        return yield* emergency(input);
      case "emergencyAck":
        return yield* emergencyAck();
      case "emergencyCancel":
        return yield* emergencyCancel();
    }
  });

  return TessayaComms.of({ call, waitingFor });
});

export const layer = Layer.effect(TessayaComms, make);
