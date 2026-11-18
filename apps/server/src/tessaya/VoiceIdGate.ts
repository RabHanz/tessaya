/**
 * Voice ID's switches for who besides him she hears (D1-D3, D8): one record, `voiceIdGate` in her brain's server
 * settings. A worker reads and sets it through the brain; the Tessel gets it over MQTT (R1Device), the desktop from its
 * settings sync.
 */
import { VoiceIdGate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

/** The switches (after `change`) on her brain; None when it has no store or the brain can't be reached. */
export const voiceIdGate = Effect.fn("VoiceIdGate.at")(function* (change: VoiceIdGateChange = {}) {
  const brain = yield* makeBrainLink;
  if (yield* brain.isBrain) return yield* voiceIdGateHere(change);
  return Option.flatMap(yield* brain.send("voiceIdGate", change), decodeGate);
});
