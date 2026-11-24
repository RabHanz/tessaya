// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off preferSchemaOverJson:off cryptoRandomUUID:off
/**
 * The desktop's hands on this server (docs/baton/REMOTE_HANDS.md, SPINE-UNIFY §2.3): one broker for a remote session's
 * calls and for a brain turn's calls to the tools the desktop offers. The desktop takes every call and its gate judges
 * it; this server only holds and passes them.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { LOOK_GRANT } from "@t3tools/tessaya-shared/consent";
import { screenGlance } from "@t3tools/tessaya-shared/screenCompanion";
import {
  createHandsBroker,
  HIS_YES,
  type HandsOrigin,
  type HandsBroker,
  type HandsResult,
} from "@t3tools/tessaya-shared/remoteHands";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { emitActionSync } from "../provenance/ActionLog.ts";
import type { ToolOutcome } from "../home/R1Brain.ts";
import type { VesselTool } from "./TessayaBrain.ts";
import type { Consent } from "./consent.ts";
import { TurnLiveContext } from "./TurnLiveContext.ts";
/** The turn's origin as `TurnOrigin` and `originOf` carry it. */
interface TurnOriginValue {
  readonly label: string;
  readonly hisVoice?: boolean | undefined;
  readonly member?: string | null | undefined;
  readonly assurance?: number | undefined;
  readonly tainted?: boolean | undefined;
  readonly kind?: string;
  readonly id?: string;
  readonly speaker?: unknown;
  readonly persona?: string | null | undefined;
}

const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export class VesselHands extends Context.Service<VesselHands, HandsBroker>()(
  "t3/tessaya/VesselHands",
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
      onAudit: (entry) => {
        // A remote caller's every call is an action in the record: who (as it named itself), what, how it ended.
        if (entry.caller !== undefined)
          emitActionSync(
            {
              kind: "hands.remote",
              // Self-named; what is proven is the session's baton:hands token, kept as evidence.
              actor: { kind: "agent", id: entry.caller, certainty: 0.5 },
              subject: entry.tool,
              outcome: entry.outcome,
              data: { what: entry.what, ms: entry.ms },
              evidence: [{ kind: "session", ref: entry.session }],
            },
            { now: entry.at },
          );
        audited = audited.then(async () => {
          try {
            if ((await NodeFS.promises.stat(file)).size > AUDIT_MAX_BYTES)
              await NodeFS.promises.rename(file, `${file}.1`);
          } catch {
            // No file yet.
          }
          await NodeFS.promises
            .appendFile(file, `${JSON.stringify(entry)}\n`)
            .catch(() => undefined);
        });
      },
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

/** The box each identical ask is waiting on, per broker: a second ask for the same act joins the first box. */
const asking = new WeakMap<HandsBroker, Map<string, Promise<HandsResult>>>();

/**
 * His yes in the desktop's own approval box, for a desk turn running here; "unreachable" when the desktop is not
 * listening or does not answer, so the caller asks his phone instead. The same act asked again while its box is up
 * gets that box's answer, not a second box.
 */
export const askHisYes = (
  hands: HandsBroker,
  origin: TurnOriginValue,
  what: string,
  /** A standing-yes key: the box offers "Always allow", answered "always". */
  key: string | null = null,
) =>
  Effect.promise(() => {
    const open = asking.get(hands) ?? new Map<string, Promise<HandsResult>>();
    asking.set(hands, open);
    const id = JSON.stringify([what, key]);
    const was = open.get(id);
    if (was !== undefined) return was;
    const answer = hands
      .call(
        `turn:${origin.label}`,
        HIS_YES,
        key === null ? { what } : { what, key },
        handsOrigin(origin),
      )
      .finally(() => open.delete(id));
    open.set(id, answer);
    return answer;
  }).pipe(
    Effect.map((r): "yes" | "always" | "no" | "unreachable" =>
      !r.ok ? "unreachable" : r.text === "yes" || r.text === "always" ? r.text : "no",
    ),
  );

/** The desktop's tools that show what is on his screen. */
const LOOKS: ReadonlySet<string> = new Set(["screen_capture", "ui_tree", "window_capture"]);
const NOT_YOURS_TO_SEE =
  "Refused: only he can let me see his screen, and I can't tell this is him. Nothing was looked at.";

/**
 * What the desktop offers now, as a brain turn's own tools, each call carrying the turn so its gate knows who asked.
 * Once he has said Always allow, the desktop looks without asking, so a look passes here only for the grant's holder
 * (grantHolds); with no grant, the desktop's own box asks.
 */
/**
 * Screen memory (D-004 step 5): which windows were open, and on which screen, stays in front of her next few turns
 * at that vessel through the one live context, then is gone. Window titles only, in this server's memory.
 */
const rememberGlance = Effect.fn("VesselHands.rememberGlance")(function* (
  tree: string,
  origin: TurnOriginValue,
) {
  const live = yield* Effect.serviceOption(TurnLiveContext);
  if (Option.isNone(live) || origin.id === undefined) return;
  const line = screenGlance(tree);
  if (line === null) return;
  yield* live.value.inject({
    key: "screen-windows",
    vessel: origin.id,
    source: "screen",
    expiresAfterTurns: 4,
    line,
  });
});

export const vesselTools = (
  hands: HandsBroker,
  origin: TurnOriginValue,
  consent: Consent["Service"] | null = null,
): ReadonlyArray<VesselTool> =>
  hands
    .published()
    .filter((spec) => spec.name !== HIS_YES)
    .map((spec) => ({
      spec,
      run: Effect.fn("VesselHands.run")(function* (args: unknown) {
        if (
          consent !== null &&
          LOOKS.has(spec.name) &&
          (yield* consent.read).includes(LOOK_GRANT) &&
          !(yield* consent.holds(LOOK_GRANT, { ...origin, kind: origin.kind ?? "" }))
        )
          return { text: NOT_YOURS_TO_SEE, isError: true } satisfies ToolOutcome;
        const outcome = toolOutcome(
          yield* Effect.promise(() =>
            hands.call(
              `turn:${origin.label}`,
              spec.name,
              typeof args === "object" && args !== null && !Array.isArray(args)
                ? (args as Record<string, unknown>)
                : {},
              handsOrigin(origin),
            ),
          ),
        );
        if (spec.name === "ui_tree" && !outcome.isError)
          yield* rememberGlance(outcome.text, origin);
        return outcome;
      }),
    }));
