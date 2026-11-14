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
import { MemberPreferences } from "./MemberPreferences.ts";
import { foldSpelling, spellBack } from "@t3tools/baton-shared/spelling";
import {
  keyFromJson,
  keyToJson,
  newChallenge,
  PasskeyError,
  verifyAssertion,
  verifyRegistration,
} from "./passkeys.ts";

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
  /** The signed-in session it came through: a step-up (PIN, Windows Hello) raises only that session, for a while. */
  readonly session?: string;
  /** The desktop app's own session, the only one that may vouch for Windows Hello. */
  readonly desktop?: boolean;
  /** The page's origin (its `Origin` header): a passkey is for that site. */
  readonly origin?: string;
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
/** The setting naming the linked server that holds this home's members; empty or absent: this one. */
export const HOME_KEY = "household.home";
/** Each member's Windows account (`HOST\\user`, lower case) on this server's desktops, for Windows Hello. */
const WINDOWS_KEY = "household.windowsAccounts";
/** A step-up's A3 lasts this long on the session that made it (ACCOUNTS-IDENTITY-DESIGN §3.1). */
export const STEP_UP_MS = 5 * 60_000;
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
const isPasskeyError = Schema.is(PasskeyError);
const accountsJson = (accounts: Readonly<Record<string, string>>) => JSON.stringify(accounts);
/** A passkey ceremony's challenge lasts this long. */
const CHALLENGE_MS = 2 * 60_000;

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
    /** The linked server holding the household (its label), or null: this one. Also where a desk turn goes (S4c). */
    readonly homeOn: Effect.Effect<string | null>;
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
  const prefs = yield* Effect.serviceOption(MemberPreferences);
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

  const windowsAccounts = Effect.map(
    sql<{ value: string }>`SELECT value FROM fabric_settings WHERE key = ${WINDOWS_KEY}`.pipe(
      Effect.orDie,
    ),
    (rows): Record<string, string> => {
      try {
        const parsed: unknown = JSON.parse(rows[0]?.value ?? "{}");
        return typeof parsed === "object" && parsed !== null
          ? (Object.fromEntries(
              Object.entries(parsed).filter(([, v]) => typeof v === "string"),
            ) as Record<string, string>)
          : {};
      } catch {
        return {};
      }
    },
  );

  const list = Effect.gen(function* () {
    const c = yield* HouseholdCaller;
    const role = yield* callerRole;
    const manager = role === "owner" || role === "admin";
    const sessions = yield* allSessions;
    const windows = yield* windowsAccounts;
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
        ...(manager || c.member === row.id ? { windowsAccount: windows[row.id] ?? null } : {}),
      };
    });
  });

  const home = Effect.gen(function* () {
    const sessions = yield* allSessions;
    const now = yield* Clock.currentTimeMillis;
    const around = (yield* rows).flatMap((row) => {
      if (row.removed_at !== null) return [];
      const mine = sessionsOf(row.id, sessions);
      const connected = mine.filter((s) => s.connected).length;
      const last = Math.max(
        ...mine.map((s) =>
          s.lastConnectedAt === null ? 0 : DateTime.toEpochMillis(s.lastConnectedAt),
        ),
      );
      if (connected === 0 && now - last >= AROUND_MS) return [];
      const minutesAgo = connected > 0 ? 0 : Math.floor((now - last) / 60_000);
      return [{ id: row.id, name: row.name, connected, minutesAgo }];
    });
    return done(
      around.length === 0
        ? "Nobody's devices are connected right now."
        : `Around now, by their devices: ${around.map((r) => r.name).join(", ")}.`,
      { around },
    );
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

  /** Sessions a member stepped up on (PIN or Windows Hello): A3 until then, on that session only. */
  const leases = new Map<string, { readonly member: string; readonly until: number }>();
  const withLease = Effect.fn("TessayaHousehold.withLease")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) {
    const c = yield* HouseholdCaller;
    const lease = c.session === undefined ? undefined : leases.get(c.session);
    const now = yield* Clock.currentTimeMillis;
    if (lease === undefined || lease.member !== c.member || lease.until <= now || c.assurance >= 3)
      return yield* effect;
    return yield* Effect.provideService(effect, HouseholdCaller, { ...c, assurance: 3 });
  });

  /** Each session's one open passkey ceremony: its challenge, what for, and until when. */
  const challenges = new Map<
    string,
    { readonly challenge: string; readonly purpose: "register" | "stepUp"; readonly until: number }
  >();
  const siteOf = (origin: string | undefined) => {
    try {
      return origin === undefined ? null : { origin, rpId: new URL(origin).hostname };
    } catch {
      return null;
    }
  };
  /** The challenge this session asked for, used once. */
  const takeChallenge = Effect.fn("TessayaHousehold.takeChallenge")(function* (
    session: string,
    purpose: "register" | "stepUp",
  ) {
    const open = challenges.get(session);
    challenges.delete(session);
    const now = yield* Clock.currentTimeMillis;
    return open !== undefined && open.purpose === purpose && open.until > now
      ? open.challenge
      : null;
  });
  const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64url"));

  const passkeyStepUp = Effect.fn("TessayaHousehold.passkeyStepUp")(function* (
    member: string,
    session: string,
    origin: string | undefined,
    answer: {
      readonly credentialId: string;
      readonly clientDataJSON: string;
      readonly authenticatorData: string;
      readonly signature: string;
    },
  ) {
    const site = siteOf(origin);
    const challenge = yield* takeChallenge(session, "stepUp");
    if (site === null || challenge === null)
      return "Ask for a fresh passkey request and try again.";
    const rows = yield* sql<{
      public_key_jwk: string;
      alg: number;
      sign_count: number;
      rp_id: string;
    }>`
      SELECT public_key_jwk, alg, sign_count, rp_id FROM tessaya_member_passkeys
      WHERE credential_id = ${answer.credentialId} AND member_id = ${member}
    `.pipe(Effect.orDie);
    const key = rows[0];
    if (key === undefined || key.rp_id !== site.rpId)
      return "That passkey isn't one of yours here.";
    const checked = yield* Effect.try({
      try: () =>
        verifyAssertion(
          {
            clientDataJSON: bytes(answer.clientDataJSON),
            authenticatorData: bytes(answer.authenticatorData),
            signature: bytes(answer.signature),
          },
          { challenge, ...site },
          {
            jwk: keyFromJson(key.public_key_jwk),
            alg: key.alg,
            signCount: key.sign_count,
          },
        ),
      catch: (e) => (isPasskeyError(e) ? e.message : "That passkey's answer is not valid."),
    }).pipe(
      Effect.map((r) => ({ ok: true as const, signCount: r.signCount })),
      Effect.catch((why) => Effect.succeed({ ok: false as const, why })),
    );
    if (!checked.ok) return checked.why;
    const now = iso(yield* Clock.currentTimeMillis);
    yield* sql`UPDATE tessaya_member_passkeys SET sign_count = ${checked.signCount}, last_used_at = ${now} WHERE credential_id = ${answer.credentialId}`.pipe(
      Effect.orDie,
    );
    return null;
  });

  /**
   * A step-up on this session: their PIN typed on their own device, or Windows Hello on a desktop whose Windows account
   * is mapped to exactly one member (on a shared account Hello says only that someone enrolled there is present).
   */
  const stepUp = Effect.fn("TessayaHousehold.stepUp")(function* (input: {
    readonly pin?: string | undefined;
    readonly hello?: string | undefined;
    readonly passkey?:
      | {
          readonly credentialId: string;
          readonly clientDataJSON: string;
          readonly authenticatorData: string;
          readonly signature: string;
        }
      | undefined;
  }) {
    const c = yield* HouseholdCaller;
    if (c.member === null || c.service === true || c.session === undefined)
      return refused("Only a member's own signed-in device can confirm it's them.");
    const now = yield* Clock.currentTimeMillis;
    if (input.hello !== undefined) {
      if (c.desktop !== true)
        return refused("Only Tessaya's desktop app can vouch for Windows Hello.");
      const account = input.hello.toLowerCase();
      const holders = Object.entries(yield* windowsAccounts)
        .filter(([, a]) => a === account)
        .map(([m]) => m);
      if (holders.length !== 1 || holders[0] !== c.member)
        return refused(
          holders.length > 1
            ? "This Windows account is shared, so Windows Hello can't say which of you it is."
            : "This Windows account isn't set as yours in Household, so Windows Hello can't confirm it's you.",
        );
    } else if (input.passkey !== undefined) {
      const why = yield* passkeyStepUp(c.member, c.session, c.origin, input.passkey);
      if (why !== null) return refused(why);
    } else if (input.pin !== undefined) {
      if (Option.isNone(stores)) return refused("PINs aren't kept on this server.");
      const right = yield* stores.value
        .checkPin(c.member, input.pin)
        .pipe(Effect.catch((e) => Effect.succeed(e.reason)));
      if (right !== true) return refused(right === false ? "That PIN is not right." : right);
    } else return refused("Type your PIN, or use Windows Hello.");
    leases.set(c.session, { member: c.member, until: now + STEP_UP_MS });
    return done("Thanks, that's you. For the next 5 minutes this device can do what needs you.");
  });

  /** A member's own passkeys on their own signed-in device: ask for a challenge, keep a new one, or remove one. */
  const passkeys = Effect.fn("TessayaHousehold.passkeys")(function* (
    input: Extract<
      BatonHouseholdCallInput,
      { readonly op: "passkeyOptions" | "passkeyRegister" | "passkeyRemove" }
    >,
  ) {
    const c = yield* HouseholdCaller;
    if (c.member === null || c.service === true || c.session === undefined)
      return refused("Only a member's own signed-in device can hold their passkeys.");
    const member = c.member;
    if (input.op === "passkeyRemove") {
      yield* sql`DELETE FROM tessaya_member_passkeys WHERE credential_id = ${input.credentialId} AND member_id = ${member}`.pipe(
        Effect.orDie,
      );
      return done("Removed that passkey.");
    }
    const site = siteOf(c.origin);
    if (site === null) return refused("Passkeys work from Tessaya's page in a browser.");
    if (input.op === "passkeyOptions") {
      const challenge = newChallenge();
      challenges.set(c.session, {
        challenge,
        purpose: input.purpose,
        until: (yield* Clock.currentTimeMillis) + CHALLENGE_MS,
      });
      const keys = yield* sql<{ credential_id: string; label: string }>`
        SELECT credential_id, label FROM tessaya_member_passkeys WHERE member_id = ${member} AND rp_id = ${site.rpId}
      `.pipe(Effect.orDie);
      const row = yield* target(member);
      return done("", {
        passkey: {
          challenge,
          rpId: site.rpId,
          userId: Buffer.from(member).toString("base64url"),
          userName: row?.name ?? member,
          keys: keys.map((k) => ({ id: k.credential_id, label: k.label })),
        },
      });
    }
    const challenge = yield* takeChallenge(c.session, "register");
    if (challenge === null) return refused("Ask for a fresh passkey request and try again.");
    const made = yield* Effect.try({
      try: () =>
        verifyRegistration(
          {
            clientDataJSON: bytes(input.clientDataJSON),
            attestationObject: bytes(input.attestationObject),
          },
          { challenge, ...site },
        ),
      catch: (e) => (isPasskeyError(e) ? e.message : "That passkey's answer is not valid."),
    }).pipe(
      Effect.map((key) => ({ ok: true as const, key })),
      Effect.catch((why) => Effect.succeed({ ok: false as const, why })),
    );
    if (!made.ok) return refused(made.why);
    const label = input.label.trim() === "" ? "Passkey" : input.label.trim();
    yield* sql`
      INSERT INTO tessaya_member_passkeys (credential_id, member_id, rp_id, public_key_jwk, alg, sign_count, label, created_at)
      VALUES (${made.key.credentialId}, ${member}, ${site.rpId}, ${keyToJson(made.key.jwk)}, ${made.key.alg}, ${made.key.signCount}, ${label}, ${iso(yield* Clock.currentTimeMillis)})
      ON CONFLICT (credential_id) DO NOTHING
    `.pipe(Effect.orDie);
    return done(`Added ${label}. It can confirm it's you on this device.`);
  });

  const call = Effect.fn("TessayaHousehold.call")(function* (input: BatonHouseholdCallInput) {
    // A step-up belongs to this server's session; everything else carries the session's lease.
    if (input.op === "stepUp") return yield* stepUp(input);
    if (
      input.op === "passkeyOptions" ||
      input.op === "passkeyRegister" ||
      input.op === "passkeyRemove"
    )
      return yield* passkeys(input);
    return yield* withLease(callThere(input));
  });
  const callThere = Effect.fn("TessayaHousehold.callThere")(function* (
    input: BatonHouseholdCallInput,
  ) {
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
        return yield* home;
      case "invite": {
        // "Zayd, Z-A-Y-D": kept as spelled, said back once, and taught to her voice.
        const spelled = foldSpelling(input.name.trim());
        const name = spelled.text.slice(0, 60);
        if (name === "") return refused("Say their name.");
        if (Option.isSome(prefs)) yield* prefs.value.teach(spelled.names);
        const what = `Add ${name} as ${input.role === "adult" || input.role === "admin" ? "an" : "a"} ${input.role}`;
        return yield* adminAct(
          manageRefusal(role, null, input.role),
          what,
          Effect.gen(function* () {
            const id = `${
              name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "") || "member"
            }-${(yield* Random.nextIntBetween(0, 0xffffff)).toString(16)}`;
            const now = iso(yield* Clock.currentTimeMillis);
            const row: Row = {
              id,
              name: name,
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
              `Added ${name}.${spellBack(spelled.names)} Their code ${pairing.code} pairs their phone for ${HOUSEHOLD_DEFAULTS.inviteHours} hours; then they enrol their voice.`,
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
      case "stepUp":
        return yield* stepUp(input);
      case "passkeyOptions":
      case "passkeyRegister":
      case "passkeyRemove":
        return yield* passkeys(input);
      case "setWindowsAccount": {
        const row = yield* target(input.id);
        if (row === null || row.removed_at !== null) return refused("No member has that id.");
        const account = input.account?.trim().toLowerCase() ?? null;
        const save = Effect.gen(function* () {
          const next = { ...(yield* windowsAccounts) };
          if (account === null) delete next[row.id];
          else next[row.id] = account;
          yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${WINDOWS_KEY}, ${accountsJson(next)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
            Effect.orDie,
          );
          return done(
            account === null
              ? `Windows Hello no longer confirms ${row.name}.`
              : `Windows Hello on ${account} now confirms it's ${row.name}.`,
          );
        });
        // Choosing who Windows Hello proves is admin-class: the owner's yes on their device, or A3 already.
        return yield* adminAct(
          row.role === "owner"
            ? role === "owner"
              ? null
              : "Only the owner chooses what confirms it's the owner."
            : manageRefusal(role, row.role, null),
          account === null
            ? `Stop Windows Hello confirming ${row.name}`
            : `Let Windows Hello on ${account} confirm it's ${row.name}`,
          save,
        );
      }
      case "rename": {
        const row = yield* target(input.id);
        if (row === null || row.removed_at !== null) return refused("No member has that id.");
        const spelled = foldSpelling(input.name.trim());
        const name = spelled.text.slice(0, 60);
        if (name === "") return refused("Say their name.");
        const rename = Effect.gen(function* () {
          if (Option.isSome(prefs)) yield* prefs.value.teach(spelled.names);
          yield* sql`UPDATE tessaya_household_members SET name = ${name} WHERE id = ${row.id}`.pipe(
            Effect.orDie,
          );
          yield* sql`UPDATE tessaya_voice_profiles SET name = ${name} WHERE member_id = ${row.id}`.pipe(
            Effect.orDie,
          );
          yield* shareVoices;
          return done(`${row.name} is now ${name}.${spellBack(spelled.names)}`);
        });
        // Their own name is theirs to change; anyone else's is an admin's.
        const self = c.member === row.id && c.service !== true && c.assurance >= 2;
        return self
          ? yield* rename
          : yield* adminAct(
              manageRefusal(role, row.role, null),
              `Rename ${row.name} to ${name}`,
              rename,
            );
      }
      case "preferences":
      case "setPreference": {
        const row = yield* target(input.id);
        if (row === null || row.removed_at !== null) return refused("No member has that id.");
        if (Option.isNone(prefs)) return refused("Preferences aren't kept on this server.");
        // Each member's own, or the owner's, on a device that is theirs (A2) and a turn that read nothing outside.
        const self = c.member === row.id && c.service !== true;
        if (!self && role !== "owner")
          return refused(
            `Only ${row.name} or the owner can see or change ${row.name}'s preferences.`,
          );
        if (input.op === "preferences")
          return done("", { preferences: yield* prefs.value.of(row.id) });
        if (c.assurance < 2 || c.tainted === true)
          return refused("I need to be sure it's you to change preferences: use your own device.");
        const set = yield* prefs.value.set(row.id, input.key, input.value);
        return done(self ? set.line : `${set.line} (for ${row.name})`, {
          preferences: yield* prefs.value.of(row.id),
        });
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
    homeOn,
    roleOf,
    grantsOf,
    purgeDue,
    forgetVoiceHere,
  });
});

/** The household's home server's link, read now: its label is a setting, its address whatever the link finds. */
export const homeLink = Effect.gen(function* () {
  const household = yield* Effect.serviceOption(TessayaHousehold);
  const peers = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  if (Option.isNone(household) || Option.isNone(peers)) return null;
  const label = yield* household.value.homeOn;
  if (label === null) return null;
  const links = peers.value;
  if (!(yield* links.enabled)) return null;
  const link = (yield* links.list.pipe(Effect.orElseSucceed(() => []))).find(
    (l) => l.status !== "expired" && l.label === label,
  );
  return link === undefined
    ? null
    : yield* links.resolve(link.environmentId).pipe(Effect.option, Effect.map(Option.getOrNull));
});

export const layer = Layer.effect(TessayaHousehold, make);
