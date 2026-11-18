/**
 * His pronunciations, one record for every voice (ONE-SPINE-MAP §8): `voicePronounce` in her brain's server settings.
 * A worker reads and teaches through the brain; the Tessel gets it over MQTT (R1Device), the desktop from its settings
 * sync.
 */
import { pronounceFrom } from "@t3tools/tessaya-shared/pronounce";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../serverSettings.ts";
import { makeBrainLink } from "./BrainHost.ts";

/** No word: the list as it is. A word with `sayAs` sets it; a word alone goes back to the voice's own way. */
export const PronounceChange = Schema.Struct({
  word: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60))),
  sayAs: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
});
export type PronounceChange = typeof PronounceChange.Type;

type Pronounce = Readonly<Record<string, string>>;

export const nextPronounce = (
  map: Pronounce,
  word: string,
  sayAs: string | undefined,
): Pronounce => {
  const { [word.trim()]: _, ...rest } = map;
  return sayAs === undefined || sayAs.trim() === ""
    ? rest
    : { ...rest, [word.trim()]: sayAs.trim() };
};

/** On this server's own settings, for the brain; None with no settings here. */
export const pronounceHere = Effect.fn("Pronunciations.here")(function* (change: PronounceChange) {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(settings)) return Option.none<Pronounce>();
  const current = yield* settings.value.getSettings;
  if (change.word === undefined) return Option.some(current.voicePronounce);
  const saved = yield* settings.value.updateSettings({
    voicePronounce: nextPronounce(current.voicePronounce, change.word, change.sayAs),
  });
  return Option.some(saved.voicePronounce);
});

/** The list (after `change`) on her brain; None when it has no store or the brain can't be reached. */
export const pronunciations = Effect.fn("Pronunciations.at")(function* (
  change: PronounceChange = {},
) {
  const brain = yield* makeBrainLink;
  if (yield* brain.isBrain) return yield* pronounceHere(change);
  return Option.map(yield* brain.send("pronounce", change), pronounceFrom);
});
