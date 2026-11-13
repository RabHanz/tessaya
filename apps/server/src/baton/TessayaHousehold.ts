// @effect-diagnostics globalDate:off
/**
 * The household's members (ACCOUNTS-IDENTITY-DESIGN I-1). A member's devices are sessions whose subject names them, so
 * revoking a member is a query over sessions T3 already keeps. Admin-class acts need A3, or the owner's yes.
 */
import {
  ADMIN_ASSURANCE,
  OWNER_MEMBER_ID,
  type Assurance,
  HOUSEHOLD_DEFAULTS,
  manageRefusal,
  memberOfSubject,
  memberSubject,
  type MemberRole,
  type PrincipalRole,
  roleCeiling,
  withinCeiling,
} from "@t3tools/baton-shared/household";
import {
  BatonHouseholdCallResult,
  type BatonHouseholdCallInput,
  type BatonHouseholdMember,
  type BatonVoiceProfile,
} from "@t3tools/baton-contracts";
import type { AuthClientSession, AuthEnvironmentScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { BatonPhoneInbox } from "./BatonPhoneInbox.ts";
import { BatonPrivateMemoryService } from "./BatonPrivateMemoryService.ts";
import { VoiceForgets } from "./VoiceForgets.ts";

/** Who is asking, set by the transport: the member a session or voice acts for, its role if not the member's, and how sure. */
export const HouseholdCaller = Context.Reference<{
  /** Null: nobody known (a guest's voice, an unverified one). */
  readonly member: string | null;
  /** "service" for an agent, token or job acting for its member: it never manages members itself. */
  readonly service?: boolean;
  readonly assurance: Assurance;
  /** The turn read outside content: nothing admin-class is done for it. */
  readonly tainted?: boolean;
  /** How the Record and the owner's ask name who asked ("Tessaya via R1", "Sara's phone"). */
  readonly via: string;
}>("t3/baton/TessayaHousehold/HouseholdCaller", {
  defaultValue: () => ({ member: null, assurance: 0, via: "unknown" }),
});

interface Row {
  readonly id: string;
  readonly name: string;
  readonly role: MemberRole;
  readonly machine: number;
  readonly guardians_json: string;
  readonly born: string | null;
  readonly adult_age: number | null;
  readonly created_at: string;
  readonly removed_at: string | null;
  readonly purge_after: string | null;
}

/** The linked-server tool a forwarded request runs on the home (`household_peer`). */
export const HOUSEHOLD_PEER_TOOL = "household_peer";
/** The linked-server tool that tells a server a member's data was destroyed, so its vessels forget their voice. */
export const VOICE_FORGET_TOOL = "household_voice_forget";
const HOME_KEY = "household.home";
/** How long a server not holding the members keeps the home's answer about who is who. */
const GRANTS_CACHE_MS = 60_000;
const decodeResult = Schema.decodeUnknownOption(BatonHouseholdCallResult);

/** "Who is around": a device connected now, or within this long. */
const AROUND_MS = 15 * 60_000;
/** How long the owner's approving device has to say yes. */
const ANSWER_WAIT_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export const MACHINE_WARNING = (name: string) =>
  `${name} will be able to do anything on this computer: every session, terminal, file and provider account here.`;

type Result = BatonHouseholdCallResult;
// Written only here, from member ids: never malformed.
const guardiansOf = (row: Row): ReadonlyArray<string> =>
  JSON.parse(row.guardians_json) as Array<string>;
// A plain list of strings: a child's guardians, a voice profile's sources.
const guardiansJson = (ids: ReadonlyArray<string>) => JSON.stringify(ids);

interface VoiceRow {
  readonly member_id: string;
  readonly model: string;
  readonly name: string;
  readonly kind: "owner" | "saved";
  readonly centroid: string;
  readonly samples: number;
  readonly sources_json: string;
  readonly enrolled_at: string;
  readonly consent_note: string | null;
  readonly version: number;
  readonly updated_at: string;
}
// Written only here, from a decoded profile: never malformed.
const voiceOf = (r: VoiceRow): BatonVoiceProfile => ({
  id: r.member_id,
  name: r.name,
  kind: r.kind,
  model: r.model,
  centroid: r.centroid,
  samples: r.samples,
  sources: JSON.parse(r.sources_json) as BatonVoiceProfile["sources"],
  enrolledAt: r.enrolled_at,
  ...(r.consent_note === null ? {} : { consentNote: r.consent_note }),
  version: r.version,
  updatedAt: r.updated_at,
});
const refused = (line: string): Result => ({ status: "refused", line });
const done = (line: string, extra: Omit<Result, "status" | "line"> = {}): Result => ({
  status: "done",
  line,
  ...extra,
});

export class TessayaHousehold extends Context.Service<
  TessayaHousehold,
  {
    /**
     * One request from the window, the phone or a voice tool, as `HouseholdCaller`. On a server whose household lives
     * on a linked server (`setHome`), it is asked there, with the caller.
     */
    readonly call: (input: BatonHouseholdCallInput) => Effect.Effect<Result>;
    /** The same request answered here, never forwarded: what a linked server's forwarded request runs. */
    readonly callHere: (input: BatonHouseholdCallInput) => Effect.Effect<Result>;
    /** A member's role, or null for someone who is not (or no longer) a member. */
    readonly roleOf: (member: string) => Effect.Effect<MemberRole | null>;
    /** What Trust needs of a member: their role and whether they hold the machine grant; null when not a member. */
    readonly grantsOf: (member: string) => Effect.Effect<{
      readonly role: MemberRole;
      readonly machine: boolean;
      readonly name: string;
    } | null>;
    /** Destroys the data of members whose export window ended. */
    readonly purgeDue: Effect.Effect<number>;
    /** Another of this home's servers destroyed this member's data: this server's vessels forget their voice too. */
    readonly forgetVoiceHere: (member: string) => Effect.Effect<void>;
  }
>()("t3/baton/TessayaHousehold") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth;
  const stores = yield* Effect.serviceOption(BatonPrivateMemoryService);
  const inbox = yield* Effect.serviceOption(BatonPhoneInbox);
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peerMcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);

  /** The linked server holding the members (its label), or null: this one. */
  const homeOn = Effect.map(
    sql<{ value: string }>`SELECT value FROM fabric_settings WHERE key = ${HOME_KEY}`.pipe(
      Effect.orDie,
    ),
    (rows) => {
      const on = rows[0]?.value;
      return on === undefined || on === "" ? null : on;
    },
  );
  const peerLabels = Option.isNone(links)
    ? Effect.succeed<ReadonlyArray<string>>([])
    : links.value.list.pipe(
        Effect.map((all) => all.filter((l) => l.status !== "expired").map((l) => l.label)),
        Effect.orElseSucceed(() => []),
      );

  /** Asks the home server, as the caller; null when it can't be reached. */
  const askHome = Effect.fn("TessayaHousehold.askHome")(function* (
    on: string,
    input: BatonHouseholdCallInput,
  ) {
    if (Option.isNone(links) || Option.isNone(peerMcp)) return null;
    const c = yield* HouseholdCaller;
    const link = (yield* links.value.list.pipe(Effect.orElseSucceed(() => []))).find(
      (l) => l.status !== "expired" && l.label === on,
    );
    if (link === undefined) return null;
    const answer = yield* peerMcp.value
      .call({
        environmentId: link.environmentId,
        tool: HOUSEHOLD_PEER_TOOL,
        arguments: {
          input,
          member: c.member,
          service: c.service === true,
          assurance: c.assurance,
          tainted: c.tainted === true,
          via: c.via,
        },
        limits: { runtimeMode: "approval-required", interactionMode: "default" },
        success: Schema.Unknown,
      })
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.option,
        // A peer that breaks rather than answers is as gone as one that never answers.
        Effect.catchCause(() => Effect.succeedNone),
      );
    return Option.isSome(answer) ? Option.getOrNull(decodeResult(answer.value)) : null;
  });
  let grantsCache: {
    readonly at: number;
    readonly members: ReadonlyArray<BatonHouseholdMember>;
  } | null = null;
  /** Each pending invite's code, kept only in memory and shown only to the owner and admins until it expires. */
  const codes = new Map<string, { readonly code: string; readonly expiresAt: string }>();

  const iso = (ms: number) => new Date(ms).toISOString();
  const rows =
    sql<Row>`SELECT * FROM tessaya_household_members ORDER BY role = 'owner' DESC, created_at`.pipe(
      Effect.orDie,
    );
  const rowOf = (id: string) =>
    Effect.map(sql<Row>`SELECT * FROM tessaya_household_members WHERE id = ${id}`, (r) =>
      Option.fromNullishOr(r[0]),
    ).pipe(Effect.orDie);
  const sessionsOf = (id: string, all: ReadonlyArray<AuthClientSession>) =>
    all.filter((s) => memberOfSubject(s.subject) === id);
  const allSessions = auth.listSessions().pipe(Effect.orDie);

  const roleOf = Effect.fn("TessayaHousehold.roleOf")(function* (member: string) {
    const row = yield* rowOf(member);
    return Option.isSome(row) && row.value.removed_at === null ? row.value.role : null;
  });

  const grantsOf = Effect.fn("TessayaHousehold.grantsOf")(function* (member: string) {
    const on = yield* homeOn;
    if (on !== null) {
      const now = yield* Clock.currentTimeMillis;
      if (grantsCache === null || now - grantsCache.at > GRANTS_CACHE_MS) {
        const listed = yield* askHome(on, { op: "list" }).pipe(
          Effect.provideService(HouseholdCaller, {
            member: OWNER_MEMBER_ID,
            service: true,
            assurance: 0,
            via: "another of this home's servers",
          }),
        );
        // An unreachable home names nobody: identity only narrows, so they are treated as a guest until it answers.
        grantsCache = { at: now, members: listed?.members ?? [] };
      }
      const m = grantsCache.members.find((x) => x.id === member && x.state !== "leaving");
      return m === undefined ? null : { role: m.role, machine: m.machine, name: m.name };
    }
    const row = yield* rowOf(member);
    return Option.isSome(row) && row.value.removed_at === null
      ? { role: row.value.role, machine: row.value.machine === 1, name: row.value.name }
      : null;
  });

  const callerRole = Effect.gen(function* () {
    const c = yield* HouseholdCaller;
    if (c.service === true) return "service" as PrincipalRole;
    return c.member === null ? null : yield* roleOf(c.member);
  });

  /** A member's pairing code, capped at their role's ceiling. */
  const pairingFor = Effect.fn("TessayaHousehold.pairingFor")(function* (row: Row) {
    const issued = yield* auth
      .createPairingLink({
        subject: memberSubject(row.id),
        scopes: roleCeiling(row.role, row.machine === 1),
        ttl: Duration.hours(HOUSEHOLD_DEFAULTS.inviteHours),
        label: `${row.name} (${row.role})`,
      })
      .pipe(Effect.orDie);
    const expiresAt = DateTime.formatIso(issued.expiresAt);
    codes.set(row.id, { code: issued.credential, expiresAt });
    return { code: issued.credential, codeExpiresAt: expiresAt };
  });

  /** Ends a member's access: every device whose scopes leave `keep` (all of them when null) and every pending code. */
  const cutAccess = Effect.fn("TessayaHousehold.cutAccess")(function* (
    id: string,
    keep: ReadonlyArray<AuthEnvironmentScope> | null,
  ) {
    for (const s of sessionsOf(id, yield* allSessions))
      if (keep === null || !withinCeiling(s.permissions ?? s.scopes, keep))
        yield* auth.revokeSession(s.sessionId).pipe(Effect.orDie);
    for (const link of yield* auth.listPairingLinks().pipe(Effect.orDie))
      if (link.subject === memberSubject(id))
        if (keep === null || !withinCeiling(link.permissions ?? link.scopes, keep))
          yield* auth.revokePairingLink(link.id).pipe(Effect.orDie);
    if (keep === null) {
      codes.delete(id);
      if (Option.isSome(stores)) yield* stores.value.endLeasesOf(id);
    }
  });

  const voices = yield* Effect.serviceOption(VoiceForgets);
  const forgetVoiceHere = (member: string) =>
    Option.isSome(voices) ? voices.value.forget(member) : Effect.void;
  /** Every linked server forgets the member's voice too: its desktop, its devices. A quiet one catches up on its desktop's next check. */
  const forgetOnPeers = Effect.fn("TessayaHousehold.forgetOnPeers")(function* (member: string) {
    if (Option.isNone(links) || Option.isNone(peerMcp)) return;
    const linked = (yield* links.value.list.pipe(Effect.orElseSucceed(() => []))).filter(
      (l) => l.status !== "expired",
    );
    yield* Effect.forEach(
      linked,
      (link) =>
        peerMcp.value
          .call({
            environmentId: link.environmentId,
            tool: VOICE_FORGET_TOOL,
            arguments: { member },
            limits: { runtimeMode: "approval-required", interactionMode: "default" },
            success: Schema.Unknown,
          })
          .pipe(Effect.timeout("10 seconds"), Effect.ignoreCause),
      { concurrency: "unbounded", discard: true },
    );
  });

  /** Every member's shared voice profile, kept here (the home). */
  const voicesHere = Effect.map(
    sql<VoiceRow>`SELECT v.* FROM tessaya_voice_profiles v JOIN tessaya_household_members m ON m.id = v.member_id WHERE m.removed_at IS NULL ORDER BY v.member_id`.pipe(
      Effect.orDie,
    ),
    (rows) => rows.map(voiceOf),
  );
  /** Every vessel here gets the profiles: from this server's table, or from the home where the members live elsewhere. */
  const shareVoices = Effect.gen(function* () {
    if (Option.isNone(voices)) return;
    const on = yield* homeOn;
    const list =
      on === null
        ? yield* voicesHere
        : ((yield* askHome(on, { op: "voices" }).pipe(
            Effect.provideService(HouseholdCaller, {
              member: OWNER_MEMBER_ID,
              service: true,
              assurance: 0,
              via: "another of this home's servers",
            }),
          ))?.voices ?? null);
    // An unreachable home leaves every vessel with what it has.
    if (list !== null) yield* voices.value.setProfiles(list);
  }).pipe(Effect.withSpan("TessayaHousehold.shareVoices"));

  const purge = Effect.fn("TessayaHousehold.purge")(function* (row: Row) {
    if (Option.isSome(stores)) yield* stores.value.shred(row.id);
    yield* sql`DELETE FROM tessaya_household_members WHERE id = ${row.id}`.pipe(Effect.orDie);
    yield* sql`DELETE FROM tessaya_voice_profiles WHERE member_id = ${row.id}`.pipe(Effect.orDie);
    yield* shareVoices;
    // Their voice print is theirs too (design §5.1): every vessel here and on every linked server forgets it.
    yield* forgetVoiceHere(row.id);
    yield* forgetOnPeers(row.id);
  });

  const purgeDue = Effect.gen(function* () {
    const now = iso(yield* Clock.currentTimeMillis);
    let n = 0;
    for (const row of yield* rows)
      if (row.purge_after !== null && row.purge_after <= now) {
        yield* purge(row);
        n++;
      }
    return n;
  });

  const list = Effect.gen(function* () {
    const c = yield* HouseholdCaller;
    const role = yield* callerRole;
    const manager = role === "owner" || role === "admin";
    const sessions = yield* allSessions;
    // A code shows only while its pairing is unspent and unexpired.
    const pending = new Set(
      (yield* auth.listPairingLinks().pipe(Effect.orDie)).map((l) => l.subject),
    );
    return (yield* rows).map((row): BatonHouseholdMember => {
      const mine = sessionsOf(row.id, sessions);
      const code = codes.get(row.id);
      const live = code !== undefined && pending.has(memberSubject(row.id)) ? code : undefined;
      const shown = manager || c.member === row.id;
      return {
        id: row.id,
        name: row.name,
        role: row.role,
        state:
          row.removed_at !== null
            ? "leaving"
            : mine.length === 0 && live !== undefined
              ? "invited"
              : "active",
        machine: row.machine === 1,
        guardians: guardiansOf(row),
        adultAge:
          row.role === "child"
            ? (row.adult_age ?? HOUSEHOLD_DEFAULTS.childAdultAge)
            : row.adult_age,
        born: shown ? row.born : null,
        devices: mine.length,
        connected: mine.some((s) => s.connected),
        inviteCode: manager && live !== undefined ? live.code : null,
        inviteExpiresAt: manager && live !== undefined ? live.expiresAt : null,
        purgeAfter: row.purge_after,
        you: c.member === row.id,
      };
    });
  });

  const home = Effect.gen(function* () {
    const sessions = yield* allSessions;
    const now = yield* Clock.currentTimeMillis;
    const around = (yield* rows).filter(
      (row) =>
        row.removed_at === null &&
        sessionsOf(row.id, sessions).some(
          (s) =>
            s.connected ||
            (s.lastConnectedAt !== null &&
              now - DateTime.toEpochMillis(s.lastConnectedAt) < AROUND_MS),
        ),
    );
    return around.length === 0
      ? "Nobody's devices are connected right now."
      : `Around now, by their devices: ${around.map((r) => r.name).join(", ")}.`;
  });

  /**
   * Runs an admin-class act: refused when the caller's role may not, done now at A3, otherwise sent to the owner's
   * approving device and done on a yes.
   */
  const adminAct = Effect.fn("TessayaHousehold.adminAct")(function* (
    refusal: string | null,
    what: string,
    act: Effect.Effect<Result>,
  ) {
    const c = yield* HouseholdCaller;
    if (refusal !== null) return refused(refusal);
    if (c.tainted === true)
      return refused("Members can't be changed from a turn that read outside content.");
    if (c.assurance >= ADMIN_ASSURANCE) return yield* act;
    if (Option.isNone(inbox))
      return refused(`${what} needs a yes on the owner's device, and nothing here can ask.`);
    const id = `household-${yield* Clock.currentTimeMillis}-${yield* Random.nextIntBetween(0, 1e6)}`;
    yield* inbox.value.mirror({
      id,
      title: "Tessaya wants to change who lives here",
      detail: `${what}. Asked by ${c.via}.`,
      buttons: ["Yes", "No"],
      yes: 0,
      cancel: 1,
      needs: "cloud-approve",
    });
    yield* inbox.value.promptAnswer(id).pipe(
      Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: (a) => a !== null }),
      Effect.timeoutOption(`${ANSWER_WAIT_MS} millis`),
      Effect.flatMap((answer) => (Option.isSome(answer) && answer.value === 0 ? act : Effect.void)),
      Effect.ignore,
      Effect.forkDetach,
    );
    return {
      status: "asked",
      line: `Sent to the owner's device for a yes: ${what}. Nothing changes until then.`,
    } satisfies Result;
  });

  const target = Effect.fn("TessayaHousehold.target")(function* (id: string) {
    const row = yield* rowOf(id);
    return Option.isSome(row) ? row.value : null;
  });

  const call = Effect.fn("TessayaHousehold.call")(function* (input: BatonHouseholdCallInput) {
    const on = input.op === "setHome" ? null : yield* homeOn;
    if (on === null) return yield* callHere(input);
    const there = yield* askHome(on, input);
    grantsCache = null;
    return there ?? refused(`This home's members live on ${on}, which can't be reached right now.`);
  });

  const callHere = Effect.fn("TessayaHousehold.callHere")(function* (
    input: BatonHouseholdCallInput,
  ) {
    const c = yield* HouseholdCaller;
    const role = yield* callerRole;
    // Guests, unknown voices and removed members see nothing of who lives here.
    if (role === null || role === "guest")
      return refused("Only members of this home can see that.");
    yield* purgeDue;
    switch (input.op) {
      case "list":
        return done("", { members: yield* list, homeOn: yield* homeOn, peers: yield* peerLabels });
      case "home":
        return done(yield* home);
      case "invite": {
        if (input.name.trim() === "") return refused("Say their name.");
        const what = `Add ${input.name} as ${input.role === "adult" || input.role === "admin" ? "an" : "a"} ${input.role}`;
        return yield* adminAct(
          manageRefusal(role, null, input.role),
          what,
          Effect.gen(function* () {
            const id = `${
              input.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "") || "member"
            }-${(yield* Random.nextIntBetween(0, 0xffffff)).toString(16)}`;
            const now = iso(yield* Clock.currentTimeMillis);
            const row: Row = {
              id,
              name: input.name,
              role: input.role,
              machine: 0,
              // A child's guardian is the adult who added them.
              guardians_json: guardiansJson(
                input.role === "child" && c.member !== null ? [c.member] : [],
              ),
              born: input.born ?? null,
              adult_age: input.adultAge ?? null,
              created_at: now,
              removed_at: null,
              purge_after: null,
            };
            yield* sql`INSERT INTO tessaya_household_members ${sql.insert({ ...row })}`.pipe(
              Effect.orDie,
            );
            const pairing = yield* pairingFor(row);
            return done(
              `Added ${input.name}. Their code ${pairing.code} pairs their phone for ${HOUSEHOLD_DEFAULTS.inviteHours} hours; then they enrol their voice.`,
              pairing,
            );
          }),
        );
      }
      case "pair": {
        const row = yield* target(input.id);
        if (row === null || row.removed_at !== null) return refused("No member has that id.");
        const self = c.member === row.id && c.service !== true && c.assurance >= 2;
        const make = Effect.map(pairingFor(row), (p) =>
          done(`A new code for ${row.name}'s device: ${p.code}.`, p),
        );
        return self
          ? yield* make
          : yield* adminAct(
              manageRefusal(role, row.role, null),
              `Pair a new device for ${row.name}`,
              make,
            );
      }
      case "setRole": {
        const row = yield* target(input.id);
        if (row === null || row.removed_at !== null) return refused("No member has that id.");
        if (row.role === input.role) return done(`${row.name} is already ${input.role}.`);
        return yield* adminAct(
          manageRefusal(role, row.role, input.role),
          `Make ${row.name} ${input.role === "adult" || input.role === "admin" ? "an" : "a"} ${input.role}`,
          Effect.gen(function* () {
            const machine = row.machine === 1 && input.role !== "child" && input.role !== "guest";
            yield* sql`UPDATE tessaya_household_members SET role = ${input.role}, machine = ${machine ? 1 : 0} WHERE id = ${row.id}`.pipe(
              Effect.orDie,
            );
            // A narrower role takes effect at once: devices holding more than it allows are signed out.
            yield* cutAccess(row.id, roleCeiling(input.role, machine));
            return done(`${row.name} is now ${input.role}.`);
          }),
        );
      }
      case "setAdultAge": {
        const row = yield* target(input.id);
        if (row === null || row.role !== "child")
          return refused("Only a child has an age to grow up at.");
        const guardian = c.member !== null && guardiansOf(row).includes(c.member);
        return yield* adminAct(
          guardian ? null : manageRefusal(role, row.role, null),
          `Set ${row.name} to become an adult at ${input.adultAge}`,
          Effect.as(
            sql`UPDATE tessaya_household_members SET adult_age = ${input.adultAge} WHERE id = ${row.id}`.pipe(
              Effect.orDie,
            ),
            done(`${row.name} becomes an adult at ${input.adultAge}.`),
          ),
        );
      }
      case "remove": {
        const row = yield* target(input.id);
        if (row === null) return refused("No member has that id.");
        if (row.role === "owner") return refused("Nobody can remove the owner.");
        if (row.removed_at !== null && input.now !== true)
          return done(
            `${row.name} is already leaving; their data goes on ${row.purge_after?.slice(0, 10)}.`,
          );
        const remove = Effect.gen(function* () {
          yield* cutAccess(row.id, null);
          const now = yield* Clock.currentTimeMillis;
          if (input.now === true) {
            yield* purge(row);
            return done(`Removed ${row.name} and destroyed their data.`);
          }
          const until = iso(now + HOUSEHOLD_DEFAULTS.exportWindowDays * DAY_MS);
          yield* sql`UPDATE tessaya_household_members SET removed_at = ${iso(now)}, purge_after = ${until} WHERE id = ${row.id}`.pipe(
            Effect.orDie,
          );
          return done(
            `${row.name} is signed out everywhere. Their data is kept until ${until.slice(0, 10)} so they can export it, then destroyed; restore them before then to undo.`,
          );
        });
        // Leaving is narrowing for the person themselves: their own device may do it without the owner.
        const self = c.member === row.id && c.service !== true && c.assurance >= 2;
        return self
          ? yield* remove
          : yield* adminAct(manageRefusal(role, row.role, null), `Remove ${row.name}`, remove);
      }
      case "restore": {
        const row = yield* target(input.id);
        if (row === null) return refused("Their data is already gone; add them again.");
        if (row.removed_at === null) return done(`${row.name} hasn't been removed.`);
        return yield* adminAct(
          manageRefusal(role, row.role, null),
          `Restore ${row.name}`,
          Effect.as(
            sql`UPDATE tessaya_household_members SET removed_at = NULL, purge_after = NULL WHERE id = ${row.id}`.pipe(
              Effect.orDie,
            ),
            done(`${row.name} is back; they pair their devices again with a new code.`),
          ),
        );
      }
      case "voices": {
        if (role !== "owner" && role !== "admin" && role !== "service")
          return refused("Only the owner or this home's devices read everyone's voice.");
        return done("", { voices: yield* voicesHere });
      }
      case "saveVoice": {
        const p = input.profile;
        const target = yield* rowOf(p.id);
        if (Option.isNone(target) || target.value.removed_at !== null)
          return refused("Only a member of this home has a voice profile here.");
        if ((p.kind === "owner") !== (target.value.role === "owner"))
          return refused("That profile's kind doesn't match the member.");
        // Their own voice, or the owner or an admin enrolling someone sitting with them.
        const may =
          (c.member === p.id && c.service !== true) || role === "owner" || role === "admin";
        if (!may || c.assurance < 2 || c.tainted === true)
          return refused("Only they, the owner or an admin save a member's voice.");
        const now = iso(yield* Clock.currentTimeMillis);
        const existing =
          (yield* sql<VoiceRow>`SELECT * FROM tessaya_voice_profiles WHERE member_id = ${p.id} AND model = ${p.model}`.pipe(
            Effect.orDie,
          ))[0];
        // A copy found on a device stands only when it has more samples; a new enrolment always does.
        if (existing !== undefined && !input.fresh && existing.samples >= p.samples)
          return done(`${target.value.name}'s voice here already has as many samples; kept.`);
        const version = (existing?.version ?? 0) + 1;
        yield* sql`INSERT INTO tessaya_voice_profiles ${sql.insert({
          member_id: p.id,
          model: p.model,
          name: p.name,
          kind: p.kind,
          centroid: p.centroid,
          samples: p.samples,
          sources_json: guardiansJson(p.sources),
          enrolled_at: p.enrolledAt,
          consent_note: p.consentNote ?? null,
          version,
          updated_at: now,
        })} ON CONFLICT (member_id, model) DO UPDATE SET name = excluded.name, kind = excluded.kind, centroid = excluded.centroid, samples = excluded.samples, sources_json = excluded.sources_json, enrolled_at = excluded.enrolled_at, consent_note = excluded.consent_note, version = excluded.version, updated_at = excluded.updated_at`.pipe(
          Effect.orDie,
        );
        yield* shareVoices;
        return done(`Saved ${target.value.name}'s voice for every device in this home.`);
      }
      case "setHome": {
        const on = input.on === null || input.on.trim() === "" ? null : input.on.trim();
        if (on !== null && !(yield* peerLabels).includes(on))
          return refused(`${on} is not a server linked to this one.`);
        return yield* adminAct(
          role === "owner" ? null : "Only the owner chooses where the members live.",
          on === null ? "Keep this home's members on this server" : `Ask ${on} who lives here`,
          Effect.gen(function* () {
            yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, ${on ?? ""}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
              Effect.orDie,
            );
            grantsCache = null;
            return done(
              on === null
                ? "This server keeps its own members."
                : `This server now asks ${on} who lives here.`,
            );
          }),
        );
      }
      case "machine": {
        const row = yield* target(input.id);
        if (row === null || row.removed_at !== null) return refused("No member has that id.");
        if (row.role === "owner") return done("The owner always has this computer.");
        if (input.on && (row.role === "child" || row.role === "guest"))
          return refused(`A ${row.role} never gets this computer.`);
        const refusal = role === "owner" ? null : "Only the owner gives or takes this computer.";
        if (!input.on)
          // Taking it away is narrowing: no yes needed beyond the owner's own request.
          return refusal !== null
            ? refused(refusal)
            : yield* Effect.gen(function* () {
                yield* sql`UPDATE tessaya_household_members SET machine = 0 WHERE id = ${row.id}`.pipe(
                  Effect.orDie,
                );
                yield* cutAccess(row.id, roleCeiling(row.role, false));
                return done(
                  `${row.name} no longer has this computer; their devices that had it are signed out.`,
                );
              });
        return yield* adminAct(
          refusal,
          `Give ${row.name} this computer. ${MACHINE_WARNING(row.name)}`,
          Effect.gen(function* () {
            yield* sql`UPDATE tessaya_household_members SET machine = 1 WHERE id = ${row.id}`.pipe(
              Effect.orDie,
            );
            const pairing = yield* pairingFor({ ...row, machine: 1 });
            return done(`${row.name} has this computer once they pair with code ${pairing.code}.`, {
              ...pairing,
              warning: MACHINE_WARNING(row.name),
            });
          }),
        );
      }
    }
  });

  yield* Effect.andThen(purgeDue, shareVoices).pipe(
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  return TessayaHousehold.of({
    call,
    callHere,
    roleOf,
    grantsOf,
    purgeDue,
    forgetVoiceHere,
  });
});

export const layer = Layer.effect(TessayaHousehold, make);
