// @effect-diagnostics globalJsonInEffect:off nodeBuiltinImport:off
/**
 * The household's settings live on her brain (M-146); a worker keeps a cache. Until the brain has a worker's edit,
 * the worker sends it again each minute and takes nothing back, so the brain being away never reverts an edit.
 * Host-local settings (provider instances, the environment's icon) stay on each machine.
 */
import * as NodeCrypto from "node:crypto";

import { type ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeBrainLink } from "./BrainHost.ts";

export const HOUSEHOLD_SETTINGS = [
  "dictationCleanup",
  "dictationCleanupCredentials",
  "providerModelPreferences",
  "tessayaFeedback",
  "tessayaExpression",
  "tessayaOwnerOpensMemberStores",
] as const;
type HouseholdKey = (typeof HOUSEHOLD_SETTINGS)[number];
export type HouseholdPatch = Partial<Pick<ServerSettings, HouseholdKey>>;

/** What a worker last agreed with the brain on, as a digest only (never the key itself). */
const AGREED_KEY = "household.settingsAgreed";

/** The household's part of `settings`, its key read out of the secret store (it travels only over a full-access link). */
const householdOf = Effect.fn("HouseholdSettings.of")(function* (settings: ServerSettings) {
  const resolver = yield* Effect.serviceOption(SecretResolver.SecretResolver);
  const key = settings.dictationCleanupCredentials.anthropic;
  const plain =
    Option.isNone(resolver) || key === ""
      ? key
      : yield* requireSettingsSecret(resolver.value, key).pipe(Effect.orElseSucceed(() => key));
  return {
    dictationCleanup: settings.dictationCleanup,
    dictationCleanupCredentials: { anthropic: plain },
    // null: not yet migrated from the old model settings, so there is nothing of his to share yet
    ...(settings.providerModelPreferences === null
      ? {}
      : { providerModelPreferences: settings.providerModelPreferences }),
    tessayaFeedback: settings.tessayaFeedback,
    tessayaExpression: settings.tessayaExpression,
    tessayaOwnerOpensMemberStores: settings.tessayaOwnerOpensMemberStores,
  } satisfies HouseholdPatch;
});

/** A digest to compare two copies by: equal copies, equal digests. Pure. */
export const householdDigest = (patch: HouseholdPatch) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(HOUSEHOLD_SETTINGS.map((k) => [k, patch[k] ?? null])))
    .digest("hex");

export const HouseholdAct = Schema.Union([
  Schema.Struct({ a: Schema.Literal("read") }),
  Schema.Struct({ a: Schema.Literal("set"), patch: ServerSettingsPatch }),
]);
export type HouseholdAct = typeof HouseholdAct.Type;
const decodePatch = Schema.decodeUnknownOption(ServerSettingsPatch);

const only = (patch: ServerSettingsPatch): ServerSettingsPatch =>
  Object.fromEntries(
    HOUSEHOLD_SETTINGS.flatMap((k) => (patch[k] === undefined ? [] : [[k, patch[k]]])),
  );

/** On her brain: a worker's read or edit of the household's settings (BrainReceive "householdSettings"). */
export const householdAtBrain = Effect.fn("HouseholdSettings.atBrain")(function* (
  act: HouseholdAct,
) {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(settings)) return {};
  if (act.a === "set") yield* settings.value.updateSettings(only(act.patch)).pipe(Effect.orDie);
  return yield* householdOf(yield* settings.value.getSettings.pipe(Effect.orDie));
});

/**
 * One minute's sync on a worker. Its copy differs from what it last agreed with the brain: an edit made here, sent up
 * (and nothing taken back until the brain has it). Otherwise the brain's copy, if it differs, is kept here.
 */
export const syncOnce = Effect.gen(function* () {
  const brain = yield* makeBrainLink;
  if (yield* brain.isBrain) return "brain" as const;
  const settings = yield* ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const here = yield* householdOf(yield* settings.getSettings);
  const agreed =
    (yield* sql<{ value: string }>`SELECT value FROM fabric_settings WHERE key = ${AGREED_KEY}`)[0]
      ?.value ?? null;
  const agree = (patch: HouseholdPatch) =>
    sql`INSERT INTO fabric_settings (key, value) VALUES (${AGREED_KEY}, ${householdDigest(patch)})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  const edited = agreed !== null && householdDigest(here) !== agreed;
  const answer = yield* brain.send(
    "householdSettings",
    (edited ? { a: "set", patch: here } : { a: "read" }) satisfies HouseholdAct,
  );
  const theirs = Option.flatMap(answer, decodePatch);
  if (Option.isNone(theirs)) return edited ? ("kept" as const) : ("away" as const);
  if (householdDigest(theirs.value as HouseholdPatch) !== householdDigest(here))
    yield* settings.updateSettings(only(theirs.value));
  yield* agree(theirs.value as HouseholdPatch);
  return edited ? ("sent" as const) : ("taken" as const);
});

/** Whether the owner can open the private memories of adults who join (decision 1): only when chosen; never chosen is sealed. */
export const ownerOpensMemberStores = Effect.serviceOption(ServerSettingsService).pipe(
  Effect.flatMap((s) => (Option.isNone(s) ? Effect.succeed(null) : s.value.getSettings)),
  Effect.map((settings) => settings?.tessayaOwnerOpensMemberStores === true),
  Effect.orElseSucceed(() => false),
);

/** Set by migration 060 where private stores existed before the choice: that home keeps its rule (decision 1). */
const KEPT_RULE_KEY = "household.ownerOpenedBefore";

/** Once: a home whose stores were all open to the owner before decision 1 keeps that rule, as its own choice. */
export const keepOwnersRule = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const kept = yield* sql`SELECT 1 FROM fabric_settings WHERE key = ${KEPT_RULE_KEY}`;
  if (kept.length === 0) return;
  if ((yield* settings.getSettings).tessayaOwnerOpensMemberStores === null)
    yield* settings.updateSettings({ tessayaOwnerOpensMemberStores: true });
  yield* sql`DELETE FROM fabric_settings WHERE key = ${KEPT_RULE_KEY}`;
});

export const layer = Layer.effectDiscard(
  keepOwnersRule.pipe(
    Effect.ignoreCause({ log: true }),
    Effect.andThen(
      syncOnce.pipe(
        Effect.ignoreCause({ log: true }),
        Effect.repeat(Schedule.spaced("1 minute")),
        Effect.forkScoped,
      ),
    ),
  ),
);
