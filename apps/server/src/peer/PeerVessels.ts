/**
 * A vessel on another of his servers: a setting of the desktop beside his studio server, or the R1 beside his home server, asked
 * from a turn here. The same tool is called on that server over the peer link, as laptop_ask does, carrying the vessel
 * the turn came through and whether his own voice was verified on it (the target reads them only from a linked
 * caller). A linked caller is never forwarded again, so two servers cannot bounce a call between them.
 */
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TurnOrigin } from "../baton/TessayaTurn.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { vesselOf } from "../mcp/toolkits/home/handlers.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { DEVICE } from "@t3tools/baton-shared/productNames";

/** What a forwarded call adds: where the turn was heard, and his verified voice as that server's own turn heard it. */
export const PeerOrigin = {
  origin: Schema.optional(
    Schema.String.check(Schema.isMaxLength(60)).annotate({
      description: "Set only by another of his servers.",
    }),
  ),
  hisVoice: Schema.optional(
    Schema.Boolean.annotate({ description: "Set only by another of his servers." }),
  ),
};

export const On = Schema.String.check(Schema.isMaxLength(60)).annotate({
  description:
    "The machine it lives on, as settings_find or device_list named it (`on`). Leave it out for this one.",
});

/** The tool runs as the turn that asked on the other server, when that server is the caller. */
export const asForwarded = Effect.fn("PeerVessels.asForwarded")(function* <A, E, R>(
  input: Readonly<Record<string, unknown>>,
  effect: Effect.Effect<A, E, R>,
) {
  const client = (yield* McpInvocationContext.McpInvocationContext).client;
  const origin = input["origin"];
  if (client?.linked !== true || typeof origin !== "string") return yield* effect;
  return yield* effect.pipe(
    Effect.provideService(TurnOrigin, {
      kind: "mcp",
      id: client.sessionId,
      label: origin,
      hisVoice: input["hisVoice"] === true,
    }),
  );
});

/** His other servers this turn may forward to: none for a linked caller. */
const peersToAsk = Effect.gen(function* () {
  // Outside a tool call (a device's own door, as the voice arbiter's) there is no caller to read.
  const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
  const client = scope._tag === "None" ? undefined : scope.value.client;
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const mcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  const vessel = vesselOf(client);
  // A rehearsal (the suite's pretend vessel) never reaches another server: its writes would be real there.
  if (client?.linked === true || vessel?.dryRun === true) return null;
  if (links._tag === "None" || mcp._tag === "None") return null;
  if (!(yield* links.value.enabled)) return null;
  const linked = (yield* links.value.list.pipe(Effect.orElseSucceed(() => []))).filter(
    (l) => l.status !== "expired",
  );
  const turn = yield* TurnOrigin;
  const carried = {
    origin:
      turn?.label ??
      (vessel === null ? "another of his servers" : vessel.surface === "r1" ? DEVICE : "desktop"),
    ...(turn?.hisVoice === true ? { hisVoice: true } : {}),
  };
  const call = (
    environmentId: (typeof linked)[number]["environmentId"],
    tool: string,
    args: object,
    wait: Duration.Input,
  ) =>
    mcp.value
      .call({
        environmentId,
        tool,
        arguments: { ...args, ...carried },
        limits: { runtimeMode: "approval-required", interactionMode: "default" },
        success: Schema.Unknown,
      })
      .pipe(Effect.timeout(wait), Effect.option);
  return { linked, call };
});

/** Whether a peer's label is the machine his words name. */
const named = (label: string, on: string) => label.toLowerCase().includes(on.trim().toLowerCase());

/**
 * One call on the server `on` names, or on each of his servers in turn until one `takes` the answer. Null when none
 * took it (or there is no peer to ask, or `on` names none of them: this machine), so the call runs here.
 */
export const onPeer = Effect.fn("PeerVessels.onPeer")(function* (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  options: {
    readonly on?: string | undefined;
    readonly takes: (value: unknown) => boolean;
    /** How long one server may take; a voice claim cannot wait past its round. */
    readonly wait?: Duration.Input;
  },
) {
  const peers = yield* peersToAsk;
  if (peers === null) return null;
  const { on: _on, ...rest } = args;
  const targets =
    options.on === undefined
      ? peers.linked
      : peers.linked.filter((l) => named(l.label, options.on!));
  for (const link of targets) {
    const answer = yield* peers.call(link.environmentId, tool, rest, options.wait ?? "15 seconds");
    if (answer._tag === "Some" && options.takes(answer.value))
      return { on: link.label, value: answer.value };
  }
  return null;
});

/** The same call on every peer at once, each answer with the machine it came from; a quiet peer is left out. */
export const fromPeers = Effect.fn("PeerVessels.fromPeers")(function* (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  wait: Duration.Input = "4 seconds",
) {
  const peers = yield* peersToAsk;
  if (peers === null) return [];
  const answers = yield* Effect.forEach(
    peers.linked,
    (link) =>
      Effect.map(peers.call(link.environmentId, tool, args, wait), (answer) =>
        answer._tag === "Some" ? [{ on: link.label, value: answer.value }] : [],
      ),
    { concurrency: "unbounded" },
  );
  return answers.flat();
});
