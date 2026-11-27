/**
 * The brain's end of `tessaya_brain` (BrainHost): what a worker heard, applied here once, by the same services a turn
 * here would call. A server that is not the brain refuses, so an act is never passed along a chain.
 */
import type { AffectEvent } from "@t3tools/tessaya-shared/affect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CommitmentAsk, TessayaCommitmentService } from "./TessayaCommitmentService.ts";
import { emitAction } from "../provenance/ActionLog.ts";
import { BrainOp as BrainOpSchema, brainOn, type BrainOp } from "./BrainHost.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentPersona, GroupValue } from "./CurrentPersona.ts";
import { AffectCause } from "./AffectCause.ts";
import * as HouseholdDevices from "./HouseholdDevices.ts";
import * as PhonePairing from "./PhonePairing.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { TessayaCast } from "./TessayaCast.ts";
import { CastBody, CastCallInput, TessayaVoiceProfile } from "@t3tools/tessaya-contracts";
import { TessayaHousehold } from "./TessayaHousehold.ts";
import { TessayaCast as TessayaCastRules } from "@t3tools/contracts/settings";
import { ServerSettingsService } from "../serverSettings.ts";
import { privateRowsAtBrain } from "./PrivateRows.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { PRIVATE_PEPPER } from "./TessayaPrivateMemoryService.ts";
import { TessayaTurn } from "./TessayaTurn.ts";
import { memoryAtBrain, ON_BRAIN, TessayaMemoryService } from "./TessayaMemoryService.ts";
import { LibraryRemovedAct, writeLibraryRemoved } from "./LibraryRemoved.ts";
import { PrivateTierAct, tierAct } from "./PrivateTier.ts";
import { PronounceChange, pronounceHere } from "./Pronunciations.ts";
import { VoiceIdGateChange, voiceIdGateHere, voiceLearningHere } from "./VoiceIdGate.ts";
import { TessayaScratchpadAct } from "@t3tools/tessaya-contracts";
import { R1Hub } from "../home/R1Hub.ts";
import { scratchpadHere } from "./TessayaScratchpad.ts";
import { storeStylePairs } from "./stylePairsStore.ts";
import { TessayaVocabulary, VocabularyAtBrain } from "./TessayaVocabulary.ts";
import { decodeFingerprint, FleetCoherence } from "./FleetCoherence.ts";
import { ConsentAct, consentAtBrain } from "./consent.ts";
import { MemberPreferences, PreferencesAct } from "./MemberPreferences.ts";
import * as Clock from "effect/Clock";
import { inboxAtBrain, TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import { TessayaPresence } from "./TessayaPresence.ts";

const Id = Schema.String.check(Schema.isMaxLength(200));
const MoodAct = Schema.Struct({
  p: Schema.String.check(Schema.isMaxLength(60)),
  m: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  // The event whole (its kind plus fields such as `ok`, `day`, `emotion`): a Struct would strip those.
  e: Schema.Record(Schema.String, Schema.Unknown),
  // the event it came from, so "that wasn't me" can move it (AffectCause)
  r: Schema.optionalKey(
    Schema.Struct({
      ref: Schema.String.check(Schema.isMaxLength(300)),
      vessel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
      assumed: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const MoodMove = Schema.Struct({
  move: Schema.Struct({
    from: Schema.String.check(Schema.isMaxLength(120)),
    to: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
    ref: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
    vessel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
    since: Schema.optionalKey(Schema.Number),
    assumedOnly: Schema.optionalKey(Schema.Boolean),
    by: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  }),
});
const decodeMoodMove = Schema.decodeUnknownOption(MoodMove);
const decodePhoneCodes = Schema.decodeUnknownOption(
  Schema.Struct({
    device: Schema.String.check(Schema.isMaxLength(40)),
    skip: Schema.Array(Schema.String.check(Schema.isMaxLength(120))).check(Schema.isMaxLength(20)),
  }),
);
const decodeDeviceRevoke = Schema.decodeUnknownOption(
  Schema.Struct({ device: Schema.String.check(Schema.isMaxLength(40)) }),
);
const PresenceAct = Schema.Union([
  Schema.Struct({
    note: Schema.Struct({
      member: Schema.NullOr(Id),
      source: Id,
      vessel: Schema.NullOr(Id),
      guest: Schema.optionalKey(Schema.Boolean),
      at: Schema.Number,
    }),
  }),
  Schema.Struct({ forget: Id, into: Schema.optionalKey(Id) }),
]);
const PersonaAct = Schema.Struct({
  conversation: Id,
  persona: Schema.String.check(Schema.isPattern(/^[\w-]{1,40}$/)),
});
const GroupAct = Schema.Struct({ conversation: Id, group: GroupValue });
const InboxAct = Schema.Struct({ op: Id, args: Schema.Record(Schema.String, Schema.Unknown) });

/** A worker's room-loop claim (R1Loop), recorded here under the worker's own event id. */
export const RoomLoopAct = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(40)),
  at: Schema.Number,
  kind: Schema.Literals(["room.loop.takeover", "room.loop.handback"]),
  from: Id,
  outcome: Schema.String.check(Schema.isMaxLength(40)),
  data: Schema.Unknown,
});
const decodeRoomLoop = Schema.decodeUnknownOption(RoomLoopAct);
const decodeMoodAct = Schema.decodeUnknownOption(MoodAct);
const MoodAsk = Schema.Struct({
  p: Schema.NullOr(Schema.String.check(Schema.isMaxLength(60))),
  m: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  z: Schema.NullOr(Schema.String.check(Schema.isMaxLength(60))),
  /** A vessel asking for its own face (atDevice): its owner's relationship when it may show it. */
  d: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  /** Settings' inner state, as this viewer may see it (the general mood and their own rows; the owner all). */
  i: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(120)))),
});
const decodeMoodAsk = Schema.decodeUnknownOption(MoodAsk);
const CastAct = Schema.Union([
  Schema.Struct({ a: Schema.Literal("view") }),
  Schema.Struct({ a: Schema.Literal("touch"), body: Schema.String.check(Schema.isMaxLength(120)) }),
  Schema.Struct({ a: Schema.Literal("told"), body: Schema.String.check(Schema.isMaxLength(120)) }),
  // a worker's own rules from before the brain kept them: added for bodies the brain has none for
  Schema.Struct({ a: Schema.Literal("merge"), rules: TessayaCastRules }),
  // a worker's desk bodies, as its desktop reported them now
  Schema.Struct({
    a: Schema.Literal("desks"),
    server: Schema.String.check(Schema.isMaxLength(120)),
    desks: Schema.Array(CastBody).check(Schema.isMaxLength(8)),
  }),
  Schema.Struct({
    a: Schema.Literal("call"),
    input: CastCallInput,
    verified: Schema.Boolean,
    visitOk: Schema.Boolean,
  }),
]);
const decodeCastAct = Schema.decodeUnknownOption(CastAct);
const PrivateRowsAsk = Schema.Struct({
  sql: Schema.String.check(Schema.isMaxLength(4000)),
  params: Schema.Array(Schema.Unknown),
  values: Schema.Boolean,
});
const decodePrivateRows = Schema.decodeUnknownOption(PrivateRowsAsk);
const OutboxIn = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(64)),
  op: BrainOpSchema,
  payload: Schema.Unknown,
});
const decodeOutbox = Schema.decodeUnknownOption(OutboxIn);
const Doing = Schema.NullOr(
  Schema.Struct({ what: Schema.String.check(Schema.isMaxLength(200)), until: Schema.Number }),
);
const ThreadActIn = Schema.Union([
  Schema.Struct({
    a: Schema.Literal("keep"),
    id: Schema.String.check(Schema.isMaxLength(400)),
    row: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({ a: Schema.Literal("drop"), id: Schema.String.check(Schema.isMaxLength(400)) }),
  Schema.Struct({
    a: Schema.Literal("doing"),
    thread: Schema.String.check(Schema.isMaxLength(400)),
    doing: Doing,
  }),
  Schema.Struct({
    a: Schema.Literal("list"),
    persona: Schema.NullOr(Schema.String.check(Schema.isMaxLength(60))),
  }),
  Schema.Struct({
    a: Schema.Literal("said"),
    lines: Schema.Array(
      Schema.Struct({
        at: Schema.Number,
        vessel: Schema.String.check(Schema.isMaxLength(200)),
        conversation: Schema.String.check(Schema.isMaxLength(400)),
        role: Schema.Literals(["them", "her"]),
        who: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
        text: Schema.String.check(Schema.isMaxLength(2100)),
        private: Schema.Number,
      }),
    ).check(Schema.isMaxLength(10)),
  }),
  Schema.Struct({ a: Schema.Literal("transcript"), from: Schema.Number, to: Schema.Number }),
]);
const decodeThreadAct = Schema.decodeUnknownOption(ThreadActIn);
const MemoryAsk = Schema.Struct({
  m: Schema.Literals(ON_BRAIN),
  args: Schema.Array(Schema.Unknown),
  viewer: Schema.Literals(["server", "desktop", "client"]),
});
const decodeMemoryAsk = Schema.decodeUnknownOption(MemoryAsk);
const decodeCommitmentAsk = Schema.decodeUnknownOption(CommitmentAsk);
const MemorySyncIn = Schema.Struct({
  origin: Schema.String.check(Schema.isMaxLength(200)),
  changes: Schema.Array(Schema.Unknown),
  upTo: Schema.String.check(Schema.isMaxLength(60)),
});
const decodeMemorySync = Schema.decodeUnknownOption(MemorySyncIn);
const decodePresenceAct = Schema.decodeUnknownOption(PresenceAct);
const decodePersonaAct = Schema.decodeUnknownOption(PersonaAct);
const decodeGroupAct = Schema.decodeUnknownOption(GroupAct);
const decodeInboxAct = Schema.decodeUnknownOption(InboxAct);
const decodeLibraryRemoved = Schema.decodeUnknownOption(LibraryRemovedAct);
const decodePrivateTier = Schema.decodeUnknownOption(PrivateTierAct);
const decodePronounce = Schema.decodeUnknownOption(PronounceChange);
const decodeVoiceIdGate = Schema.decodeUnknownOption(VoiceIdGateChange);
const decodeScratchpad = Schema.decodeUnknownOption(TessayaScratchpadAct);
const decodeVocabulary = Schema.decodeUnknownOption(VocabularyAtBrain);

const decodeConsent = Schema.decodeUnknownOption(ConsentAct);
const decodePreferences = Schema.decodeUnknownOption(PreferencesAct);
const decodeVoiceMerge = Schema.decodeUnknownOption(
  Schema.Struct({ profile: TessayaVoiceProfile }),
);

const refused = (line: string) => ({ ok: false as const, line });
const done = (value: unknown = null) => ({ ok: true as const, value });

const applyAtBrain = Effect.fn("BrainHost.apply")(function* (op: BrainOp, payload: unknown) {
  // The one op a worker takes from its brain: her mood moved, so the faces here read it again (it carries nothing).
  if (op === "moodMoved") {
    const mood = yield* Effect.serviceOption(TessayaMood);
    if ((yield* brainOn) !== null && Option.isSome(mood)) yield* mood.value.refresh;
    return done();
  }
  if ((yield* brainOn) !== null) return refused("This server is not her brain.");
  switch (op) {
    case "fingerprint": {
      const fp = decodeFingerprint(payload);
      if (Option.isNone(fp)) return refused("Not a fingerprint.");
      const fleet = yield* Effect.serviceOption(FleetCoherence);
      if (Option.isSome(fleet)) yield* fleet.value.record(fp.value);
      return done();
    }
    case "preferences": {
      const act = decodePreferences(payload);
      if (Option.isNone(act)) return refused("Not a preferences act.");
      const prefs = yield* Effect.serviceOption(MemberPreferences);
      if (Option.isNone(prefs)) return refused("Preferences are not kept here.");
      return done(yield* prefs.value.atBrain(act.value));
    }
    case "consent": {
      const act = decodeConsent(payload);
      if (Option.isNone(act)) return refused("Not a standing-yes act.");
      return done(yield* consentAtBrain(act.value));
    }
    case "voiceMerge": {
      const merge = decodeVoiceMerge(payload);
      if (Option.isNone(merge)) return refused("Not a voice profile.");
      const household = yield* Effect.serviceOption(TessayaHousehold);
      if (Option.isNone(household)) return refused("The household is not kept here.");
      return (yield* household.value.mergeVoice(merge.value.profile))
        ? done()
        : refused("That voice can't be joined to the one here.");
    }
    case "hubLogin": {
      const hub = yield* Effect.serviceOption(R1Hub);
      if (Option.isNone(hub)) return refused("There is no hub here.");
      const login = yield* hub.value.busLogin;
      return login.key === "" ? refused("This hub has no bus login yet.") : done(login);
    }
    case "roomLoop": {
      const act = decodeRoomLoop(payload);
      if (Option.isNone(act)) return refused("Not a room-loop claim.");
      const a = act.value;
      yield* emitAction({
        id: a.id,
        at: a.at,
        kind: a.kind,
        actor: { kind: "system", id: "room-loop", certainty: 1 },
        subject: "room-loop",
        outcome: a.outcome,
        evidence: [{ kind: "environment", ref: a.from }],
        data: a.data,
      });
      return done();
    }
    case "mood": {
      const move = decodeMoodMove(payload);
      if (Option.isSome(move)) {
        const mood = yield* Effect.serviceOption(TessayaMood);
        return done(Option.isSome(mood) ? yield* mood.value.reassign(move.value.move) : 0);
      }
      const act = decodeMoodAct(payload);
      if (Option.isNone(act) || typeof act.value.e["kind"] !== "string")
        return refused("Not a mood act.");
      const mood = yield* Effect.serviceOption(TessayaMood);
      // Resolved on the worker (its day, the persona's dials): applied here as it is.
      if (Option.isSome(mood))
        yield* mood.value
          .note(
            act.value.p,
            act.value.e as unknown as Exclude<AffectEvent, { kind: "his_turn" }>,
            act.value.m,
          )
          .pipe(Effect.provideService(AffectCause, act.value.r ?? null));
      return done();
    }
    case "moodView": {
      const ask = decodeMoodAsk(payload);
      if (Option.isNone(ask)) return refused("Not a mood ask.");
      const mood = yield* Effect.serviceOption(TessayaMood);
      if (Option.isNone(mood)) return refused("No mood here.");
      const a = ask.value;
      if (a.i !== undefined)
        return done(yield* mood.value.inner(a.p ?? undefined, a.i, a.z ?? undefined));
      return done(
        a.d === undefined
          ? yield* mood.value.view(a.p ?? undefined, a.z ?? undefined, a.m)
          : yield* mood.value.atDevice(a.d, a.p ?? undefined, a.z ?? undefined),
      );
    }
    case "cast": {
      const act = decodeCastAct(payload);
      if (Option.isNone(act)) return refused("Not a cast act.");
      const cast = yield* Effect.serviceOption(TessayaCast);
      if (Option.isNone(cast)) return refused("No cast here.");
      const a = act.value;
      switch (a.a) {
        case "view":
          return done(yield* cast.value.view);
        case "touch":
          yield* cast.value.touch(a.body);
          return done();
        case "told":
          return done(yield* cast.value.told(a.body));
        case "desks":
          yield* cast.value.desksFrom(a.server, a.desks);
          return done();
        case "merge": {
          const settings = yield* Effect.serviceOption(ServerSettingsService);
          if (Option.isNone(settings)) return refused("No settings here.");
          const have = (yield* settings.value.getSettings.pipe(Effect.orDie)).tessayaCast;
          const added = Object.fromEntries(
            Object.entries(a.rules).filter(([k]) => have[k] === undefined),
          );
          if (Object.keys(added).length > 0)
            yield* settings.value
              .updateSettings({ tessayaCast: { ...have, ...added } })
              .pipe(Effect.orDie);
          return done({
            added: Object.keys(added).length,
            kept: Object.keys(a.rules).length - Object.keys(added).length,
          });
        }
        case "call":
          return yield* cast.value.call(a.input, a.verified, a.visitOk).pipe(
            Effect.map((v) => done(v)),
            // a refusal is an answer (his voice wasn't enough), not the brain being away
            Effect.catch((line: string) => Effect.succeed(done({ refused: line }))),
          );
      }
    }
    case "threads": {
      const act = decodeThreadAct(payload);
      if (Option.isNone(act)) return refused("Not a thread change.");
      const turn = yield* Effect.serviceOption(TessayaTurn);
      if (Option.isNone(turn)) return refused("No conversations here.");
      return done(yield* turn.value.threadAct(act.value));
    }
    case "outbox":
      // unwrapped by receiveAtBrain: never nested
      return refused("Not a queued change.");
    case "memory": {
      const ask = decodeMemoryAsk(payload);
      if (Option.isNone(ask)) return refused("Not a memory ask.");
      const here = yield* Effect.serviceOption(TessayaMemoryService);
      if (Option.isNone(here)) return refused("No memory here.");
      return done(
        yield* memoryAtBrain(ask.value.m, ask.value.args, ask.value.viewer).pipe(
          Effect.provideService(TessayaMemoryService, here.value),
        ),
      );
    }
    case "commitments": {
      const ask = decodeCommitmentAsk(payload);
      if (Option.isNone(ask)) return refused("Not a reminders ask.");
      const here = yield* Effect.serviceOption(TessayaCommitmentService);
      if (Option.isNone(here)) return refused("No reminders here.");
      const a = ask.value;
      return done(
        a.m === "list"
          ? yield* here.value.local.list
          : yield* here.value.local.upsert(a.items).pipe(Effect.orElseSucceed(() => 0)),
      );
    }
    case "memorySync": {
      const sync = decodeMemorySync(payload);
      if (Option.isNone(sync)) return refused("Not a memory sync.");
      const here = yield* Effect.serviceOption(TessayaMemoryService);
      if (Option.isNone(here)) return refused("No memory here.");
      const s = sync.value;
      return done(yield* here.value.applyChanges(s.origin, s.changes as never, s.upTo));
    }
    case "phoneCodes": {
      const ask = decodePhoneCodes(payload);
      if (Option.isNone(ask)) return refused("Not a pairing ask.");
      const codes = yield* PhonePairing.codesAtBrain(ask.value.device, ask.value.skip).pipe(
        Effect.orElseSucceed(() => null),
      );
      return codes === null ? refused("Pairing is not available here.") : done(codes);
    }
    case "deviceRevoke": {
      const ask = decodeDeviceRevoke(payload);
      if (Option.isNone(ask)) return refused("Not a device.");
      return done({ revoked: yield* HouseholdDevices.revokeEverywhereFromBrain(ask.value.device) });
    }
    case "privatePepper": {
      // never logged or recorded: the caller (tessaya_brain) has already checked the link's scope
      const secrets = yield* Effect.serviceOption(ServerSecretStore);
      if (Option.isNone(secrets)) return refused("No store here.");
      const pepper = yield* secrets.value.getOrCreateRandom(PRIVATE_PEPPER, 32).pipe(Effect.option);
      return Option.isNone(pepper)
        ? refused("No store here.")
        : done({ pepper: Buffer.from(pepper.value).toString("base64") });
    }
    case "privateRows": {
      // his private store's own statements only (its four tables), on ciphertext rows; never anything else
      const ask = decodePrivateRows(payload);
      if (Option.isNone(ask)) return refused("Not a private store statement.");
      const rows = yield* privateRowsAtBrain(ask.value).pipe(Effect.orElseSucceed(() => null));
      return rows === null ? refused("Not one of the private store's statements.") : done(rows);
    }
    case "presence": {
      const act = decodePresenceAct(payload);
      if (Option.isNone(act)) return refused("Not a presence signal.");
      const presence = yield* Effect.serviceOption(TessayaPresence);
      if (Option.isNone(presence)) return done();
      const a = act.value;
      yield* "note" in a ? presence.value.note(a.note) : presence.value.forget(a.forget, a.into);
      return done();
    }
    case "persona": {
      const act = decodePersonaAct(payload);
      if (Option.isNone(act)) return refused("Not a persona.");
      const current = yield* Effect.serviceOption(CurrentPersona);
      if (Option.isSome(current))
        yield* current.value.set(act.value.conversation, act.value.persona);
      return done();
    }
    case "group": {
      const act = decodeGroupAct(payload);
      if (Option.isNone(act)) return refused("Not a group.");
      const current = yield* Effect.serviceOption(CurrentPersona);
      if (Option.isSome(current))
        yield* current.value.setGroup(act.value.conversation, act.value.group);
      return done();
    }
    case "inbox": {
      const act = decodeInboxAct(payload);
      if (Option.isNone(act)) return refused("Not an inbox call.");
      const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
      if (Option.isNone(inbox)) return refused("No inbox here.");
      const value = yield* inboxAtBrain(inbox.value, act.value.op, act.value.args);
      return value === undefined ? refused("Not an inbox call.") : done(value);
    }
    case "privateTier": {
      const act = decodePrivateTier(payload);
      if (Option.isNone(act)) return refused("Not a sealed file.");
      const value = yield* tierAct(act.value, yield* Clock.currentTimeMillis).pipe(
        Effect.map((v) => ({ v })),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      return value === null ? refused("The private tier is not here.") : done(value.v);
    }
    case "pronounce": {
      const change = decodePronounce(payload);
      if (Option.isNone(change)) return refused("Not a pronunciation.");
      const list = yield* pronounceHere(change.value).pipe(Effect.orElseSucceed(Option.none));
      return Option.isNone(list) ? refused("Pronunciations aren't kept here.") : done(list.value);
    }
    case "voiceIdGate": {
      const change = decodeVoiceIdGate(payload);
      if (Option.isNone(change)) return refused("Not Voice ID's switches.");
      const gate = yield* voiceIdGateHere(change.value).pipe(Effect.orElseSucceed(Option.none));
      return Option.isNone(gate)
        ? refused("Voice ID's switches aren't kept here.")
        : done(gate.value);
    }
    case "voiceLearning": {
      const learnt = yield* voiceLearningHere().pipe(Effect.orElseSucceed(Option.none));
      return Option.isNone(learnt) ? refused("No Tessels are heard here.") : done(learnt.value);
    }
    case "scratchpad": {
      const act = decodeScratchpad(payload);
      if (Option.isNone(act)) return refused("Not a Scratchpad act.");
      const result = yield* scratchpadHere(act.value).pipe(Effect.orElseSucceed(Option.none));
      return Option.isNone(result) ? refused("No Scratchpad here.") : done(result.value);
    }
    case "vocabulary": {
      const act = decodeVocabulary(payload);
      if (Option.isNone(act)) return refused("Not a dictionary change.");
      const vocabulary = yield* Effect.serviceOption(TessayaVocabulary);
      if (Option.isNone(vocabulary)) return refused("No dictionary here.");
      if (act.value.pairs !== undefined) yield* storeStylePairs(act.value.pairs);
      const all =
        act.value.change === null
          ? Option.some(yield* vocabulary.value.read)
          : yield* vocabulary.value.change(act.value.change).pipe(Effect.option);
      if (Option.isNone(all)) return refused("The dictionary was not changed.");
      return done({ stored: yield* vocabulary.value.stored, all: all.value });
    }
    case "libraryRemoved": {
      const act = decodeLibraryRemoved(payload);
      if (Option.isNone(act)) return refused("Not a removed list.");
      const written = yield* Effect.try({
        try: () => writeLibraryRemoved(act.value.sources),
        catch: (e) => String(e),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("library removed list not written", { error }),
        ),
        Effect.orElseSucceed(() => false),
      );
      return written ? done() : refused("No private library here.");
    }
  }
});

/** One act from a worker; a queued one (outbox) is applied exactly once by its id, however often it is replayed. */
export const receiveAtBrain = Effect.fn("BrainHost.receive")(function* (
  op: BrainOp,
  payload: unknown,
  /** The linked caller's access: his PIN's pepper goes only to a link of his with full access. */
  access?: string,
) {
  if (
    op === "privatePepper" &&
    (access === undefined || access === "read-only" || access === "body-only")
  )
    return refused("That link may not open his private store.");
  // pairing codes reach a shell on every machine: only a link that already has one may ask
  // pairing codes and her hub's bus login reach a shell or every Tessel: only a link that already has one may ask
  if ((op === "phoneCodes" || op === "hubLogin") && access !== "full-access")
    return refused("Only another of his machines, linked with full access, may ask for this.");
  if (op !== "outbox") return yield* applyAtBrain(op, payload);
  if ((yield* brainOn) !== null) return refused("This server is not her brain.");
  const box = decodeOutbox(payload);
  // a queued change is a write; nothing secret is ever asked through the outbox
  if (
    Option.isNone(box) ||
    box.value.op === "outbox" ||
    box.value.op === "privatePepper" ||
    box.value.op === "phoneCodes" ||
    box.value.op === "hubLogin"
  )
    return refused("Not a queued change.");
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isSome(sql)) {
    const seen = yield* sql.value<{ n: number }>`
      SELECT COUNT(*) AS n FROM tessaya_brain_applied WHERE id = ${box.value.id}
    `.pipe(Effect.orElseSucceed(() => [{ n: 0 }]));
    if ((seen[0]?.n ?? 0) > 0) return done({ already: true });
  }
  const answer = yield* applyAtBrain(box.value.op, box.value.payload);
  if (answer.ok && Option.isSome(sql))
    yield* sql.value`
      INSERT OR IGNORE INTO tessaya_brain_applied (id, at) VALUES (${box.value.id}, ${yield* Clock.currentTimeMillis})
    `.pipe(Effect.ignore);
  return answer;
});
