/**
 * Owner-only persona layers an internal build may load; content-free, none ship here. Public builds compile
 * `__TESSAYA_INTERNAL__` to false so nothing is imported, and scripts/tessaya/check-no-private-layer.mjs fails a
 * release that carries one. An answering layer takes the whole turn: nothing is learned, recorded or shown elsewhere.
 */
import * as NodeURL from "node:url";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  conversationKey,
  type TurnEnvelope,
  turnIdentity,
  type VesselKind,
} from "../baton/TessayaTurn.ts";

declare const __TESSAYA_INTERNAL__: boolean | undefined;

export interface LayerTurn {
  readonly persona: string | null;
  readonly member: string | null;
  readonly assurance: number;
  readonly vessel: { readonly kind: VesselKind; readonly id: string };
  readonly conversation: string;
  readonly text: string;
  readonly tainted: boolean;
  readonly sharedRoom: boolean;
  readonly rehearsal: boolean;
}

/** Something outside the turn that should end a layer's session; no `vessel` means every vessel. */
export interface LayerSignal {
  readonly kind: string;
  readonly vessel?: string;
}

export interface LayerReply {
  readonly text: string;
  readonly mood: string;
  readonly gesture: string;
  readonly intensity: number;
  readonly look?: string;
}

export interface LayerHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly member: string | null;
  readonly session: string | null;
  readonly body: unknown;
}

export interface LayerHttpResponse {
  readonly status: number;
  readonly json?: unknown;
  /** A page or script the layer serves itself, with its content type. */
  readonly body?: string;
  readonly contentType?: string;
}

export interface LayerHost {
  /** Verifies a household step-up (PIN, Windows Hello, passkey) sent on this exact session. */
  readonly stepUp: (
    session: string,
    input: unknown,
  ) => Promise<{ readonly member: string; readonly method: "pin" | "hello" | "passkey" } | null>;
  readonly presence?: (vessel: string) => Promise<"alone" | "others" | "unknown">;
  readonly deviceKey?: () => Promise<Uint8Array | null>;
  /** What this system can do today: its personas and the tools a turn can reach, read live from the server. */
  readonly capabilities?: () => Promise<{
    readonly personas: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly role: string;
      readonly lead: boolean;
    }>;
    readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  }>;
  readonly home?: (call: {
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
  }) => Promise<unknown>;
}

export interface PersonaLayer {
  readonly id: string;
  readonly onTurn: (turn: LayerTurn) => Promise<LayerReply | null>;
  readonly signal: (signal: LayerSignal) => void;
  readonly http: (request: LayerHttpRequest) => Promise<LayerHttpResponse>;
  /** Whether a session is open on this vessel, so its client can keep the screen out of capture. Nothing more. */
  readonly active?: (vessel: string) => boolean;
}

/** The loaded layers: empty in every public build, filled once at startup in an internal one. */
export class PersonaLayers extends Context.Service<
  PersonaLayers,
  { readonly all: Array<PersonaLayer> }
>()("t3/tessaya/PersonaLayers") {}

export const layer = Layer.sync(PersonaLayers, () => ({ all: [] }));

export const internalBuild = (): boolean =>
  typeof __TESSAYA_INTERNAL__ !== "undefined" && __TESSAYA_INTERNAL__ === true;

/** Loads the layers an internal build names in TESSAYA_PERSONA_LAYERS; a public build never imports anything. */
export const loadPersonaLayers = async (
  host: LayerHost,
  entry = process.env.TESSAYA_PERSONA_LAYERS?.trim(),
): Promise<Array<PersonaLayer>> => {
  if (!internalBuild() || entry === undefined || entry === "") return [];
  // An internal build without its staged layer runs as a public one rather than failing to start.
  const mod = (await import(/* @vite-ignore */ NodeURL.pathToFileURL(entry).href).catch(
    () => null,
  )) as { readonly default: (host: LayerHost) => ReadonlyArray<PersonaLayer> } | null;
  return mod === null ? [] : [...mod.default(host)];
};

const layerTurnOf = (turn: TurnEnvelope): LayerTurn => {
  const identity = turnIdentity(turn);
  return {
    persona: turn.persona ?? null,
    member: identity.member,
    assurance: identity.assurance,
    vessel: turn.vessel,
    conversation: conversationKey(turn),
    text: turn.text,
    tainted: turn.tainted === true,
    sharedRoom: turn.sharedRoom === true,
    rehearsal: turn.rehearsal === true,
  };
};

/** The first layer reply for this turn, or null (always null in a public build). A failing layer answers nothing. */
export const replyFor = Effect.fn("PersonaLayers.replyFor")(function* (turn: TurnEnvelope) {
  const layers = yield* Effect.serviceOption(PersonaLayers);
  if (layers._tag === "None" || layers.value.all.length === 0) return null;
  const facts = layerTurnOf(turn);
  for (const l of layers.value.all) {
    const reply = yield* Effect.promise(() => l.onTurn(facts).catch(() => null));
    if (reply !== null) return reply;
  }
  return null;
});
