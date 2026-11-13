/** The settings tools' handlers: thin; SettingsVoice decides, with the runtime's settings and his phone. */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BatonRuntime } from "../../../baton/BatonRpcHandlers.ts";
import { TurnOrigin } from "../../../baton/TessayaTurn.ts";
import {
  allSettings,
  choicesOf,
  entryOf,
  SETTINGS,
  findSettings,
  setSetting,
  settingValue,
} from "../../../baton/SettingsVoice.ts";
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

export const make = Effect.gen(function* () {
  const context = yield* BatonRuntime;
  const inRuntime = <A, E>(effect: Effect.Effect<A, E, never>) =>
    context === null ? Effect.fail(unavailable) : effect;
  // The desktop's published controls join the fixed settings where this server has its desktop.
  const everything =
    context === null ? Effect.succeed(SETTINGS) : allSettings.pipe(Effect.provideContext(context));
  const described = Effect.fn("SettingsMcp.described")(function* (key: string) {
    const entry = entryOf(key, yield* everything);
    if (entry === null) return yield* unknown(key);
    return { entry, value: yield* settingValue(entry).pipe(Effect.provideContext(context!)) };
  });
  return {
    settings_find: McpToolAccess.reads((input: Args) =>
      Effect.map(everything, (entries) =>
        findSettings(String(input["text"] ?? ""), entries).map((s) => ({
          key: s.key,
          says: s.say,
          store: s.store,
          class: s.class,
        })),
      ),
    ),
    settings_get: McpToolAccess.reads((input: Args) =>
      inRuntime(
        Effect.map(described(String(input["key"] ?? "")), ({ entry, value }) => ({
          key: entry.key,
          says: entry.say,
          value,
        })),
      ),
    ),
    settings_explain: McpToolAccess.reads((input: Args) =>
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
    settings_set: McpToolAccess.writes((input: Args) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const vessel = vesselOf(scope.client);
        const via = (yield* TurnOrigin)?.label;
        return yield* inRuntime(
          setSetting({
            key: String(input["key"] ?? ""),
            value: input["value"],
            why: String(input["why"] ?? ""),
            // The suite's pretend R1 is checked as for real and changes nothing.
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
          }).pipe(Effect.provideContext(context!)),
        );
      }),
    ),
  };
});
