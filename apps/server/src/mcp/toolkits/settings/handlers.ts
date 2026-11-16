/** The settings tools' handlers: thin; SettingsVoice decides, with the runtime's settings and his phone. */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { TessayaRuntime } from "../../../tessaya/TessayaRpcHandlers.ts";
import { TurnOrigin } from "../../../tessaya/TessayaTurn.ts";
import {
  allSettings,
  choicesOf,
  entryOf,
  SETTINGS,
  findSettings,
  answerBatch,
  setSetting,
  setSettings,
  settingHere,
  settingValue,
} from "../../../tessaya/SettingsVoice.ts";
import { asForwarded, fromPeers, onPeer } from "../../../peer/PeerVessels.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { vesselOf } from "../home/handlers.ts";

const unavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "Settings are not available on this server.",
});
const unknown = (key: string) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `No setting is called ${key}; use settings_find.`,
  });

type Args = Readonly<Record<string, unknown>>;

/** A peer's answer that is about the setting, not "no such setting" or "its desktop is not here". */
const answered = (value: unknown): boolean => {
  const line = (value as { line?: unknown } | null)?.line;
  return !(
    typeof line === "string" &&
    (line.startsWith("No setting is called") || line.includes("not connected to this server"))
  );
};

export const make = Effect.gen(function* () {
  const context = yield* TessayaRuntime;
  const inRuntime = <A, E>(effect: Effect.Effect<A, E, never>) =>
    context === null ? Effect.fail(unavailable) : effect;
  // The desktop's published controls join the fixed settings where this server has its desktop.
  const everything =
    context === null ? Effect.succeed(SETTINGS) : allSettings.pipe(Effect.provideContext(context));
  /**
   * A setting this server does not hold (a desktop's beside another of his servers), or one `on` another machine:
   * asked there over the peer link, its answer named with that machine.
   */
  const routed = <A, E, R>(tool: string, input: Args, here: Effect.Effect<A, E, R>) =>
    asForwarded(
      input,
      Effect.gen(function* () {
        const key = String(input["key"] ?? "");
        const on = typeof input["on"] === "string" ? input["on"] : undefined;
        const held =
          context === null ? false : yield* settingHere(key).pipe(Effect.provideContext(context));
        if (on !== undefined || !held) {
          const there = yield* onPeer(tool, input, { on, takes: answered });
          if (there !== null) return { ...(there.value as object), on: there.on } as A | object;
        }
        return yield* here;
      }),
    );
  /** Who is asking, for the card, and whether it is the suite's pretend R1 (checked as for real, changes nothing). */
  const askerOf = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const vessel = vesselOf(scope.client);
    const via = (yield* TurnOrigin)?.label;
    return {
      dryRun: vessel?.dryRun === true,
      who:
        via !== undefined
          ? `Tessaya via ${via}`
          : vessel !== null
            ? vessel.surface === "r1"
              ? "Tessaya in the room"
              : "Tessaya on his desktop"
            : scope.client === undefined
              ? "an agent in T3"
              : "an outside agent",
    };
  });
  const described = Effect.fn("SettingsMcp.described")(function* (key: string) {
    const entry = entryOf(key, yield* everything);
    if (entry === null) return yield* unknown(key);
    return { entry, value: yield* settingValue(entry).pipe(Effect.provideContext(context!)) };
  });
  return {
    settings_find: McpToolAccess.reads((input: Args) =>
      asForwarded(
        input,
        Effect.gen(function* () {
          const text = String(input["text"] ?? "");
          const here = findSettings(text, yield* everything).map((s) => ({
            key: s.key,
            says: s.say,
            store: s.store,
            class: s.class,
          }));
          const elsewhere = (yield* fromPeers("settings_find", { text })).flatMap(
            ({ on, value }) =>
              Array.isArray(value) ? value.map((entry) => ({ ...(entry as object), on })) : [],
          );
          return [...here, ...elsewhere];
        }),
      ),
    ),
    settings_get: McpToolAccess.reads((input: Args) =>
      routed(
        "settings_get",
        input,
        inRuntime(
          Effect.map(described(String(input["key"] ?? "")), ({ entry, value }) => ({
            key: entry.key,
            says: entry.say,
            value,
          })),
        ),
      ),
    ),
    settings_explain: McpToolAccess.reads((input: Args) =>
      routed(
        "settings_explain",
        input,
        inRuntime(
          Effect.map(described(String(input["key"] ?? "")), ({ entry, value }) => ({
            key: entry.key,
            says: entry.say,
            value,
            choices: choicesOf(entry),
            class: entry.class,
            ...(entry.why === undefined ? {} : { never: entry.why }),
            change:
              entry.class === "free"
                ? "changes at once"
                : entry.class === "never"
                  ? "never by voice"
                  : "waits for his yes on his phone",
          })),
        ),
      ),
    ),
    settings_set: McpToolAccess.writes(
      (input: Args) =>
        routed(
          "settings_set",
          input,
          Effect.gen(function* () {
            const asker = yield* askerOf;
            return yield* inRuntime(
              setSetting({
                key: String(input["key"] ?? ""),
                value: input["value"],
                why: String(input["why"] ?? ""),
                ...asker,
              }).pipe(Effect.provideContext(context!)),
            );
          }),
        ),
      // His other servers may change a setting here for a turn they heard; its class and his yes still apply.
      { linkedCallers: "allowed" },
    ),
    settings_set_many: McpToolAccess.writes(
      (input: Args) =>
        asForwarded(
          input,
          Effect.gen(function* () {
            const asker = yield* askerOf;
            const why = String(input["why"] ?? "");
            const changes = (
              Array.isArray(input["changes"])
                ? (input["changes"] as ReadonlyArray<{
                    key?: unknown;
                    value?: unknown;
                    on?: unknown;
                  }>)
                : []
            ).map((c, i) => ({
              i,
              key: String(c.key ?? ""),
              value: c.value,
              on: typeof c.on === "string" ? c.on : undefined,
            }));
            const machines = [...new Set(changes.map((c) => c.on))];
            // Each machine's part shares one id, so his phone shows one card for all of them.
            const batch =
              typeof input["batch"] === "string"
                ? input["batch"]
                : machines.length > 1
                  ? `settings-${yield* Clock.currentTimeMillis}`
                  : undefined;
            const results = new Map<number, unknown>();
            for (const on of machines) {
              if (on === undefined) continue;
              const part = changes.filter((c) => c.on === on);
              const there = yield* onPeer(
                "settings_set_many",
                {
                  changes: part.map(({ key, value }) => ({ key, value })),
                  why,
                  ...(batch === undefined ? {} : { batch }),
                },
                {
                  on,
                  takes: (v) => Array.isArray((v as { results?: unknown } | null)?.results),
                },
              );
              // `on` named this machine, or no peer answered: those changes are tried here.
              if (there === null) continue;
              const said = (there.value as { results: ReadonlyArray<object> }).results;
              part.forEach((c, j) => results.set(c.i, { ...said[j], on: there.on }));
            }
            const here = changes.filter((c) => !results.has(c.i));
            if (here.length > 0) {
              const done = yield* inRuntime(
                setSettings({
                  changes: here.map(({ key, value }) => ({ key, value })),
                  why,
                  ...asker,
                  ...(batch === undefined ? {} : { batch }),
                }).pipe(Effect.provideContext(context!)),
              );
              here.forEach((c, j) => results.set(c.i, done.results[j]));
            }
            return { results: changes.map((c) => results.get(c.i)) };
          }),
        ),
      // His other servers send each their part of one request; its classes and his yes still apply.
      { linkedCallers: "allowed" },
    ),
    settings_answer_all: McpToolAccess.writes((input: Args) =>
      inRuntime(
        answerBatch(input["answer"] === "approve" ? "approve" : "deny").pipe(
          Effect.provideContext(context!),
        ),
      ),
    ),
  };
});
