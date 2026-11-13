// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off preferSchemaOverJson:off cryptoRandomUUID:off
/**
 * The desktop's hands on this server (docs/baton/REMOTE_HANDS.md, SPINE-UNIFY §2.3): one broker for a remote session's
 * calls and for a brain turn's calls to the tools the desktop offers. The desktop takes every call and its gate judges
 * it; this server only holds and passes them.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  createHandsBroker,
  HIS_YES,
  type HandsOrigin,
  type HandsBroker,
  type HandsResult,
} from "@t3tools/baton-shared/remoteHands";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import type { ToolOutcome } from "../home/R1Brain.ts";
import type { VesselTool } from "./TessayaBrain.ts";
/** The turn's origin as `TurnOrigin` and `originOf` carry it. */
interface TurnOriginValue {
  readonly label: string;
  readonly hisVoice?: boolean | undefined;
  readonly member?: string | null | undefined;
  readonly assurance?: number | undefined;
  readonly tainted?: boolean | undefined;
}

const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export class VesselHands extends Context.Service<VesselHands, HandsBroker>()(
  "t3/baton/VesselHands",
) {}

export const layer = Layer.effect(
  VesselHands,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const file = NodePath.join(NodePath.dirname(config.dbPath), "baton-hands-audit.ndjson");
    let audited: Promise<void> = Promise.resolve();
    return createHandsBroker({
      now: () => Date.now(),
      newId: () => globalThis.crypto.randomUUID(),
      // In order, and rolled to one `.1` file past AUDIT_MAX_BYTES, so the record never grows without end.
      onAudit: (entry) =>
        void (audited = audited.then(async () => {
          try {
            if ((await NodeFS.promises.stat(file)).size > AUDIT_MAX_BYTES)
              await NodeFS.promises.rename(file, `${file}.1`);
          } catch {
            // No file yet.
          }
          await NodeFS.promises
            .appendFile(file, `${JSON.stringify(entry)}\n`)
            .catch(() => undefined);
        })),
    });
  }),
);

/** The desktop's answer as a tool result: its first picture goes to the model with the words. */
export const toolOutcome = (result: HandsResult): ToolOutcome => {
  const image = result.images?.[0];
  return {
    text: result.ok ? (result.text ?? "Done.") : (result.error ?? "It did not work."),
    isError: !result.ok,
    ...(image === undefined ? {} : { image: { mediaType: image.mimeType, data: image.data } }),
  };
};

/** What the desktop offers now, as a brain turn's own tools, each call carrying the turn so its gate knows who asked. */
const handsOrigin = (origin: TurnOriginValue): HandsOrigin => ({
  label: origin.label,
  hisVoice: origin.hisVoice === true,
  member: origin.member ?? null,
  assurance: origin.assurance ?? 0,
  tainted: origin.tainted === true,
});

/**
 * His yes in the desktop's own approval box, for a desk turn running here; "unreachable" when the desktop is not
 * listening or does not answer, so the caller asks his phone instead.
 */
export const askHisYes = (hands: HandsBroker, origin: TurnOriginValue, what: string) =>
  Effect.promise(() =>
    hands.call(`turn:${origin.label}`, HIS_YES, { what }, handsOrigin(origin)),
  ).pipe(
    Effect.map((r): "yes" | "no" | "unreachable" =>
      !r.ok ? "unreachable" : r.text === "yes" ? "yes" : "no",
    ),
  );

export const vesselTools = (
  hands: HandsBroker,
  origin: TurnOriginValue,
): ReadonlyArray<VesselTool> =>
  hands
    .published()
    .filter((spec) => spec.name !== HIS_YES)
    .map((spec) => ({
      spec,
      run: (args: unknown) =>
        Effect.promise(() =>
          hands.call(
            `turn:${origin.label}`,
            spec.name,
            typeof args === "object" && args !== null && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
            handsOrigin(origin),
          ),
        ).pipe(Effect.map(toolOutcome)),
    }));
