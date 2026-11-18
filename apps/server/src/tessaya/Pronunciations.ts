// @effect-diagnostics globalJsonInEffect:off nodeBuiltinImport:off
/**
 * His pronunciations, one record for every voice (ONE-SPINE-MAP §8): `voicePronounce` in her brain's server settings.
 * A worker reads and teaches through the brain; the Tessel gets it over MQTT (R1Device), the desktop from its settings
 * sync.
 */
import { pronounceFrom } from "@t3tools/tessaya-shared/pronounce";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeBrainLink } from "./BrainHost.ts";

/** No word: the list as it is. A word with `sayAs` sets it; a word alone goes back to the voice's own way. */
export const PronounceChange = Schema.Struct({
  word: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60))),
  sayAs: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
  /** A worker's own list from before: added where the brain has no word of that name (the brain's own wins). */
  merge: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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
  if (change.merge !== undefined)
    return Option.some(
      (yield* settings.value.updateSettings({
        voicePronounce: { ...pronounceFrom(change.merge), ...current.voicePronounce },
      })).voicePronounce,
    );
  if (change.word === undefined) return Option.some(current.voicePronounce);
  const saved = yield* settings.value.updateSettings({
    voicePronounce: nextPronounce(current.voicePronounce, change.word, change.sayAs),
  });
  return Option.some(saved.voicePronounce);
});

/**
 * A worker's own list from before the brain kept it goes up once (additive), with a copy kept in its state folder;
 * only then is its own emptied, so a word the brain later drops never comes back from here.
 */
const uploadOwn = Effect.fn("Pronunciations.uploadOwn")(function* (
  send: (op: "pronounce", payload: unknown) => Effect.Effect<Option.Option<unknown>>,
) {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(settings) || Option.isNone(config)) return;
  const own = (yield* settings.value.getSettings.pipe(Effect.orDie)).voicePronounce;
  if (Object.keys(own).length === 0) return;
  if (Option.isNone(yield* send("pronounce", { merge: own }))) return;
  const kept = NodePath.join(config.value.stateDir, "voice", "pronounce.before-brain.json");
  yield* Effect.sync(() => {
    NodeFS.mkdirSync(NodePath.dirname(kept), { recursive: true });
    if (!NodeFS.existsSync(kept)) NodeFS.writeFileSync(kept, `${JSON.stringify(own, null, 2)}\n`);
  });
  yield* settings.value.updateSettings({ voicePronounce: {} }).pipe(Effect.orDie);
});

/** The list (after `change`) on her brain; None when it has no store or the brain can't be reached. */
export const pronunciations = Effect.fn("Pronunciations.at")(function* (
  change: PronounceChange = {},
) {
  const brain = yield* makeBrainLink;
  if (yield* brain.isBrain) return yield* pronounceHere(change);
  yield* uploadOwn(brain.send);
  return Option.map(yield* brain.send("pronounce", change), pronounceFrom);
});
