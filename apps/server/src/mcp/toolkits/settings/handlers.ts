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
  settingHere,
  settingValue,
} from "../../../baton/SettingsVoice.ts";
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
  const context = yield* BatonRuntime;
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
      // His other servers may change a setting here for a turn they heard; its class and his yes still apply.
      { linkedCallers: "allowed" },
    ),
  };
});
