/**
 * The brain's end of `tessaya_brain` (BrainHost): what a worker heard, applied here once, by the same services a turn
 * here would call. A server that is not the brain refuses, so an act is never passed along a chain.
 */
import type { AffectEvent } from "@t3tools/tessaya-shared/affect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { brainOn, type BrainOp } from "./BrainHost.ts";
import { CurrentPersona, GroupValue } from "./CurrentPersona.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { LibraryRemovedAct, writeLibraryRemoved } from "./LibraryRemoved.ts";
import { PrivateTierAct, tierAct } from "./PrivateTier.ts";
import { PronounceChange, pronounceHere } from "./Pronunciations.ts";
import { VoiceIdGateChange, voiceIdGateHere } from "./VoiceIdGate.ts";
import { TessayaScratchpadAct } from "@t3tools/tessaya-contracts";
import { scratchpadHere } from "./TessayaScratchpad.ts";
import * as Clock from "effect/Clock";
import { inboxAtBrain, TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import { TessayaPresence } from "./TessayaPresence.ts";

const Id = Schema.String.check(Schema.isMaxLength(200));
const MoodAct = Schema.Struct({
  p: Schema.String.check(Schema.isMaxLength(60)),
  m: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  // The event whole (its kind plus fields such as `ok`, `day`, `emotion`): a Struct would strip those.
  e: Schema.Record(Schema.String, Schema.Unknown),
});
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

const decodeMoodAct = Schema.decodeUnknownOption(MoodAct);
const decodePresenceAct = Schema.decodeUnknownOption(PresenceAct);
const decodePersonaAct = Schema.decodeUnknownOption(PersonaAct);
const decodeGroupAct = Schema.decodeUnknownOption(GroupAct);
const decodeInboxAct = Schema.decodeUnknownOption(InboxAct);
const decodeLibraryRemoved = Schema.decodeUnknownOption(LibraryRemovedAct);
const decodePrivateTier = Schema.decodeUnknownOption(PrivateTierAct);
const decodePronounce = Schema.decodeUnknownOption(PronounceChange);
const decodeVoiceIdGate = Schema.decodeUnknownOption(VoiceIdGateChange);
const decodeScratchpad = Schema.decodeUnknownOption(TessayaScratchpadAct);

const refused = (line: string) => ({ ok: false as const, line });
const done = (value: unknown = null) => ({ ok: true as const, value });

export const receiveAtBrain = Effect.fn("BrainHost.receive")(function* (
  op: BrainOp,
  payload: unknown,
) {
  if ((yield* brainOn) !== null) return refused("This server is not her brain.");
  switch (op) {
    case "mood": {
      const act = decodeMoodAct(payload);
      if (Option.isNone(act) || typeof act.value.e["kind"] !== "string")
        return refused("Not a mood act.");
      const mood = yield* Effect.serviceOption(TessayaMood);
      // Resolved on the worker (its day, the persona's dials): applied here as it is.
      if (Option.isSome(mood))
        yield* mood.value.note(
          act.value.p,
          act.value.e as unknown as Exclude<AffectEvent, { kind: "his_turn" }>,
          act.value.m,
        );
      return done();
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
    case "scratchpad": {
      const act = decodeScratchpad(payload);
      if (Option.isNone(act)) return refused("Not a Scratchpad act.");
      const result = yield* scratchpadHere(act.value).pipe(Effect.orElseSucceed(Option.none));
      return Option.isNone(result) ? refused("No Scratchpad here.") : done(result.value);
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
