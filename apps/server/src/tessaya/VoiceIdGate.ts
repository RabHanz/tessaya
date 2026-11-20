/**
 * Voice ID's switches for who besides him she hears (D1-D3, D8): one record, `voiceIdGate` in her brain's server
 * settings. A worker reads and sets it through the brain; the Tessel gets it over MQTT (R1Device), the desktop from its
 * settings sync. What each Tessel learnt of his far voice is heard on the brain's hub and read the same way.
 */
import { VoiceIdGate } from "@t3tools/contracts";
import { VoiceLearning } from "@t3tools/tessaya-contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { HomeDevices } from "../home/HomeDevices.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeBrainLink } from "./BrainHost.ts";

/** No `set`: the switches as they are. */
export const VoiceIdGateChange = Schema.Struct({ set: Schema.optionalKey(VoiceIdGate) });
export type VoiceIdGateChange = typeof VoiceIdGateChange.Type;

const decodeGate = Schema.decodeUnknownOption(VoiceIdGate);

/** On this server's own settings, for the brain; None with no settings here. */
export const voiceIdGateHere = Effect.fn("VoiceIdGate.here")(function* (change: VoiceIdGateChange) {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(settings)) return Option.none<VoiceIdGate>();
  if (change.set === undefined) return Option.some((yield* settings.value.getSettings).voiceIdGate);
  return Option.some(
    (yield* settings.value.updateSettings({ voiceIdGate: change.set })).voiceIdGate,
  );
});

/** Each Tessel this server's hub heard report its far-voice learning; None with no devices here. */
export const voiceLearningHere = Effect.fn("VoiceIdGate.learningHere")(function* () {
  const devices = yield* Effect.serviceOption(HomeDevices);
  if (Option.isNone(devices)) return Option.none<ReadonlyArray<VoiceLearning>>();
  return Option.some(
    (yield* devices.value.heardHealth).flatMap(({ id, voiceLearning }) =>
      voiceLearning === null ? [] : [{ device: id, ...voiceLearning }],
    ),
  );
});

const decodeLearning = Schema.decodeUnknownOption(Schema.Array(VoiceLearning));

/** Every Tessel's far-voice learning as her brain heard it; None when the brain can't be reached. */
export const voiceLearning = Effect.fn("VoiceIdGate.learning")(function* () {
  const brain = yield* makeBrainLink;
  if (yield* brain.isBrain) return yield* voiceLearningHere();
  return Option.flatMap(yield* brain.send("voiceLearning", {}), decodeLearning);
});

/** The switches (after `change`) on her brain; None when it has no store or the brain can't be reached. */
export const voiceIdGate = Effect.fn("VoiceIdGate.at")(function* (change: VoiceIdGateChange = {}) {
  const brain = yield* makeBrainLink;
  if (yield* brain.isBrain) return yield* voiceIdGateHere(change);
  return Option.flatMap(yield* brain.send("voiceIdGate", change), decodeGate);
});
