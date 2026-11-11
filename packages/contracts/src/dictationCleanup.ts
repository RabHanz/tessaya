/**
 * Tessaya: the one dictation cleanup setting. Every environment keeps a copy in its server settings and applies it; the
 * newest copy is the setting, and clients carry it to every environment they reach, so a change anywhere shows
 * everywhere. A server only takes a copy newer than its own (`isNewerDictationCleanup`), which makes the copies converge.
 */
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

import { ModelSelection } from "./modelSelection.ts";

/** Whose cleanup runs on dictation sent to an environment: Tessaya's or T3's built-in. */
export const DictationCleanupEngine = Schema.Literals(["tessaya", "t3"]);
export type DictationCleanupEngine = typeof DictationCleanupEngine.Type;

export const DictationCleanup = Schema.Struct({
  enabled: Schema.Boolean,
  engine: DictationCleanupEngine,
  /** Null follows the environment's text generation model. */
  model: Schema.NullOr(ModelSelection),
  /** Epoch ms of the choice; 0 means nobody has chosen yet. */
  updatedAt: Schema.Number,
});
export type DictationCleanup = typeof DictationCleanup.Type;

export const DEFAULT_DICTATION_CLEANUP: DictationCleanup = {
  enabled: false,
  engine: "t3",
  model: null,
  updatedAt: 0,
};

export const DictationCleanupSetting = DictationCleanup.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_DICTATION_CLEANUP)),
);

/** Later choice wins; equal stamps fall to a fixed order of the values, so every copy settles on the same one. */
export const isNewerDictationCleanup = (next: DictationCleanup, current: DictationCleanup) =>
  next.updatedAt !== current.updatedAt
    ? next.updatedAt > current.updatedAt
    : JSON.stringify(next) > JSON.stringify(current);

export const newestDictationCleanup = (
  copies: ReadonlyArray<DictationCleanup>,
): DictationCleanup | null =>
  copies.reduce<DictationCleanup | null>(
    (best, copy) => (best === null || isNewerDictationCleanup(copy, best) ? copy : best),
    null,
  );

/** Moves the per-environment cleanup model T3 kept (`speechPostProcessingModelSelection`) into the one setting. */
export const withMigratedDictationCleanup = <
  Settings extends {
    readonly dictationCleanup: DictationCleanup;
    readonly speechPostProcessingModelSelection: ModelSelection | null;
  },
>(
  settings: Settings,
): Settings => {
  const legacy = settings.speechPostProcessingModelSelection;
  if (legacy === null) return settings;
  const unchosen =
    settings.dictationCleanup.updatedAt === 0 && settings.dictationCleanup.model === null;
  return {
    ...settings,
    speechPostProcessingModelSelection: null,
    dictationCleanup: unchosen
      ? { ...settings.dictationCleanup, model: legacy }
      : settings.dictationCleanup,
  };
};

/** A choice made now: stamped after the copy it changes even on a machine whose clock runs behind. */
export const chooseDictationCleanup = (
  current: DictationCleanup,
  change: Partial<Omit<DictationCleanup, "updatedAt">>,
  now: number,
): DictationCleanup => ({
  ...current,
  ...change,
  updatedAt: Math.max(now, current.updatedAt + 1),
});

/** The newest copy among an environment list, and the environments whose copy is older and must take it. */
export const dictationCleanupCatchUp = <Id>(
  copies: ReadonlyArray<{ readonly environmentId: Id; readonly cleanup: DictationCleanup }>,
) => {
  const newest = newestDictationCleanup(copies.map((copy) => copy.cleanup));
  return {
    newest,
    behind:
      newest === null
        ? []
        : copies
            .filter((copy) => isNewerDictationCleanup(newest, copy.cleanup))
            .map((copy) => copy.environmentId),
  };
};

/**
 * What a client's own on/off copy (a browser's cleanup switch) does about the setting: carry its old "on" in while
 * nobody has chosen, else follow the setting, only when the setting changed so a switch just flipped is not undone.
 */
export const followDictationCleanup = (
  newest: DictationCleanup,
  seen: DictationCleanup | null,
  localOn: boolean,
): "adopt" | "on" | "off" | null => {
  if (newest.updatedAt === 0) return localOn && !newest.enabled ? "adopt" : null;
  if (seen !== null && Equal.equals(seen, newest)) return null;
  return newest.enabled === localOn ? null : newest.enabled ? "on" : "off";
};
