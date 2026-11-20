/**
 * Owner-only persona layers an internal build may load; content-free, none ship here. Public builds compile
 * `__TESSAYA_INTERNAL__` to false so nothing is imported, and scripts/tessaya/check-no-private-layer.mjs fails a
 * release that carries one. An answering layer takes the whole turn: nothing is learned, recorded or shown elsewhere.
 */
import type { ActionInput } from "@t3tools/tessaya-shared/provenance";
import * as NodeURL from "node:url";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OWNER_MEMBER_ID, vesselSubject } from "@t3tools/tessaya-shared/household";
import { PrivateCaller, TessayaPrivateMemoryService } from "./TessayaPrivateMemoryService.ts";
import { PRESENCE_BARS } from "@t3tools/tessaya-shared/presence";
import { ownVoiceVerified } from "@t3tools/tessaya-shared/privateMemory";
import type { PrivateRooms } from "@t3tools/tessaya-shared/rooms";
import type { FeltTone } from "@t3tools/tessaya-shared/affect";

import type { RoomToolSet } from "../home/R1Brain.ts";
import { capToolText, personaTools, type VesselTool } from "./TessayaBrain.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { TessayaOneShot, TessayaOneShotError } from "./TessayaOneShot.ts";
import {
  conversationKey,
  originOf,
  TessayaTurn,
  TurnOrigin,
  type TurnEnvelope,
  turnIdentity,
  type VesselKind,
} from "./TessayaTurn.ts";

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
  /** One speaker of GroupTalk's turn: whether she speaks first, and who else is here and what they said. */
  readonly group?: { readonly first: boolean; readonly note: string };
}

/** Something outside the turn that should end a layer's session; no `vessel` means every vessel. */
export interface LayerSignal {
  readonly kind: string;
  readonly vessel?: string;
  /** The signed-in session it is about (his private window closed on it), for the layer to map to its own vessel. */
  readonly session?: string;
}

export interface LayerReply {
  readonly text: string;
  readonly mood: string;
  readonly gesture: string;
  readonly intensity: number;
  readonly look?: string;
  /** The speaking voice's affect clip for this line ("tender"): the vessel says the whole line in that reference. */
  readonly affect?: string;
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
  /** A file the layer serves from its own store (a 3D body model, a prop), with its content type. */
  readonly bytes?: Uint8Array;
  readonly contentType?: string;
}

/**
 * The one brain's reach for a layer's turn (one brain, 18 Nov): a private moment is a mode of the same companion, so
 * it reads what her public turn reads and calls the same tools, with the same approvals.
 */
export interface LayerBrain {
  /** Read only when the layer's gate holds, so a public turn never pays for it. */
  readonly context: () => Promise<LayerContext>;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly run: (
    name: string,
    input: unknown,
  ) => Promise<{ readonly text: string; readonly isError: boolean }>;
  /**
   * Her reply written by the one brain's model call (its routing, his subscription, the usage spine), not the layer's
   * own: the layer's prompt and the model its router chose, a JSON object back. Rejects when the brain can't.
   */
  readonly complete?: (input: {
    readonly model: string;
    readonly system: string;
    readonly prompt: string;
  }) => Promise<string>;
  /** Keeps one note in his one sealed tier (his private store on the brain path, D2); true once it is stored. */
  readonly remember?: (text: string, persona?: string) => Promise<boolean>;
  /**
   * The at-unlock migration for notes the layer moved before they were marked: these exact notes become that
   * persona's private-moment notes. `dry` only counts; `left` is what a read-back still finds unmarked. Null: not open.
   */
  readonly markMoment?: (input: {
    readonly texts: ReadonlyArray<string>;
    readonly persona: string;
    readonly dry: boolean;
  }) => Promise<{ readonly matched: number; readonly left: number } | null>;
  /** How close this private moment felt (0..1), into her one mood toward him (P2); never its words. */
  readonly felt?: (warmth: number) => Promise<void>;
  /** How a touch in a private moment felt, a tone only, into her one mood; never where or how. */
  readonly touched?: (tone: FeltTone) => Promise<void>;
}

export interface LayerContext {
  /** Her memory, his own private memories and her line about him, as the public turn reads them (data). */
  readonly memory: string;
  /** What she should tell him now (messages that waited for him). */
  readonly notice: string;
  readonly preferences: Readonly<Record<string, string>>;
  /** Their conversation on every vessel, oldest first. */
  readonly conversation: ReadonlyArray<{ readonly role: string; readonly content: string }>;
}

export interface LayerHost {
  /** Verifies a household step-up (PIN, Windows Hello, passkey) sent on this exact session. */
  readonly stepUp: (
    session: string,
    input: unknown,
  ) => Promise<{ readonly member: string; readonly method: "pin" | "hello" | "passkey" } | null>;
  readonly presence?: (vessel: string) => Promise<"alone" | "others" | "unknown">;
  readonly deviceKey?: () => Promise<Uint8Array | null>;
  /**
   * A private character becomes his persona (D6), sealed: her name, private, and a pointer to this layer; her brief
   * never leaves the layer. Her new persona id, or null when it could not be made (a name he already uses).
   */
  readonly sealedPersona?: (input: {
    readonly layer: string;
    readonly name: string;
  }) => Promise<string | null>;
  /**
   * He touched her public body (no private moment): an everyday touch, felt by her one self (TessayaBody.feel).
   * `self`: her own hands on herself (a clap), felt as her own act.
   */
  readonly touched?: (touch: {
    readonly part: string;
    readonly kind: "poke" | "pat" | "stroke" | "hold" | "squeeze" | "clap";
    readonly self?: true;
  }) => Promise<void>;
  /** What this system can do today: its personas and the tools a turn can reach, read live from the server. */
  readonly capabilities?: () => Promise<{
    readonly personas: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly role: string;
      readonly lead: boolean;
      /** His private personas too, so a private moment and its rooms can hold any of them (P4, P5). */
      readonly private?: boolean;
      readonly privateRooms?: PrivateRooms;
      /** One of the layer's own characters (D6): her brief is the layer's, not this. */
      readonly sealed?: boolean;
      /** A private persona's own character, to speak from in a private room. */
      readonly brief?: string;
    }>;
    readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
    /** What each of his saved clones can say beyond its words (VOXTA G1): the tones recorded for it in Playground. */
    readonly voices?: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly affects: ReadonlyArray<string>;
    }>;
  }>;
  readonly home?: (call: {
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
  }) => Promise<unknown>;
  /**
   * A private action whose whole envelope the layer sealed in its own store (B-046): the public log keeps only this
   * pointer, so a cause chain crossing the boundary still links. Fire and forget.
   */
  readonly privatePointer?: (pointer: {
    readonly id: string;
    readonly at: number;
    readonly cause: ReadonlyArray<string>;
  }) => void;
  /**
   * Sources of models he removed in his model viewer, for the private design library to hide. The host sends them to
   * the brain, which seals them under the library's key; fire and forget.
   */
  readonly libraryRemoved?: (sources: ReadonlyArray<string>) => void;
  /**
   * One of the layer's lines in a persona's voice, as WAV, for its own window to play: his saved clone when the layer
   * names one, else the persona's own voice, on this machine only (never a cloud voice). Null when it can't.
   */
  readonly speak?: (input: {
    readonly persona: string;
    readonly clone?: string;
    readonly text: string;
  }) => Promise<Uint8Array | null>;
  /** A private action for the host to seal in his private store (M-002) and point to; returns its id. */
  readonly privateEvent?: (event: Omit<ActionInput, "private">) => string;
  /** The brain's reach for a turn the layer takes itself (its own window), from this server's shared tools. */
  readonly brain?: (turn: LayerTurn) => LayerBrain;
  /**
   * The private tier of her one store, on the brain (PrivateTier.ts): the layer's sealed files as ciphertext, so the
   * brain and its standby hold them. `put` keeps a file only when `rev` is newer; null when the brain is not reached.
   */
  readonly tier?: {
    readonly get: (
      name: string,
    ) => Promise<{ readonly rev: number; readonly bytes: Uint8Array } | null>;
    readonly put: (
      name: string,
      rev: number,
      bytes: Uint8Array,
    ) => Promise<{ readonly kept: boolean; readonly rev: number } | null>;
    /** Every kept file's revision by name, in one call; null when the brain is not reached or too old to say. */
    readonly revs?: () => Promise<Readonly<Record<string, number>> | null>;
  };
}

export interface PersonaLayer {
  readonly id: string;
  readonly onTurn: (turn: LayerTurn, brain?: LayerBrain) => Promise<LayerReply | null>;
  readonly signal: (signal: LayerSignal) => void;
  readonly http: (request: LayerHttpRequest) => Promise<LayerHttpResponse>;
  /** Whether a session is open on this vessel, so its client can keep the screen out of capture. Nothing more. */
  readonly active?: (vessel: string) => boolean;
  /**
   * Her body asked to move (TessayaBody): bounded cues, whether they need the private gate, and owner-extension acts
   * for the layer to resolve at its level. Taken by her full body wherever the layer shows one, in public too (a
   * private move only inside a private moment); null when it shows none, so the move goes to the desk character.
   */
  readonly body?: (move: {
    readonly cues: ReadonlyArray<unknown>;
    readonly private: boolean;
    readonly acts: ReadonlyArray<string>;
    readonly by: string;
    /** These cues are for this persona's own body (another's touch landing on her), not the one asking. */
    readonly persona?: string;
  }) => { readonly ok: boolean; readonly said: string } | null;
  /** What the body on its open session last reported of itself (bodyControl BodyState); null when none is open. */
  readonly bodyState?: () => unknown;
  /** The models the body playground opens for this member, first to try first (her everyday look); none to offer. */
  readonly playgroundModels?: (member: string | null) => ReadonlyArray<{
    readonly id?: string;
    readonly name: string;
    readonly url: string;
    readonly why?: string;
  }>;
}

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
/** The layer's reply is its own JSON object; the brain only asks the model for one. */
const LayerReplyObject = Schema.Record(Schema.String, Schema.Unknown);
/**
 * A layer's long poll answered as a push: polls in-process, each answer written the moment the layer has it, the next
 * poll after its `seq` (the first one at once, for the whole picture), until the layer says closed or refuses.
 */
export const pushAnswers = Effect.fn("PersonaLayers.pushAnswers")(function* <E>(
  layer: Pick<PersonaLayer, "http">,
  poll: {
    readonly path: string;
    readonly member: string | null;
    readonly session: string | null;
    readonly body: object;
  },
  write: (text: string) => Effect.Effect<void, E>,
) {
  let after = 0;
  while (true) {
    const answer = yield* Effect.promise(() =>
      layer.http({
        method: "POST",
        path: poll.path,
        member: poll.member,
        session: poll.session,
        body: { ...poll.body, after, wait: after === 0 ? 0 : 20_000 },
      }),
    );
    const json = (answer.json ?? {}) as { readonly seq?: unknown; readonly closed?: unknown };
    const done = answer.status !== 200 || json.closed === true;
    yield* write(
      yield* encodeJson(done ? { ...json, closed: true } : json).pipe(
        Effect.orElseSucceed(() => '{"closed":true}'),
      ),
    );
    if (done) return;
    after = typeof json.seq === "number" ? json.seq : after;
  }
});

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

const layerTurnOf = (turn: TurnEnvelope, groupNote: string): LayerTurn => {
  const identity = turnIdentity(turn);
  return {
    persona: turn.persona ?? null,
    member: identity.member,
    // A layer opens only on his voice verified on this turn's own clips, never on his session's evidence.
    assurance:
      turn.speaker != null && !ownVoiceVerified(turn.speaker)
        ? Math.min(identity.assurance, 1)
        : identity.assurance,
    vessel: turn.vessel,
    conversation: conversationKey(turn),
    text: turn.text,
    tainted: turn.tainted === true,
    sharedRoom: turn.sharedRoom === true,
    rehearsal: turn.rehearsal === true,
    ...(turn.group === undefined ? {} : { group: { first: turn.group.first, note: groupNote } }),
  };
};

/**
 * Who is near a vessel, for a layer's Tessel rule: "alone" only when the owner is the one member likely home and is
 * placed at that vessel past the alone bar; another member likely home is "others"; anything less is "unknown", which
 * fails closed.
 */
export const layerPresence = Effect.fn("PersonaLayers.presence")(function* (vessel: string) {
  const home = (yield* (yield* TessayaTurn).whoIsHome).filter((p) => p.likelyHome);
  if (home.some((p) => p.member !== OWNER_MEMBER_ID)) return "others" as const;
  const owner = home.find((p) => p.member === OWNER_MEMBER_ID);
  return owner?.nearest?.vessel === vessel && owner.nearest.confidence >= PRESENCE_BARS.alone
    ? ("alone" as const)
    : ("unknown" as const);
});

/** Memory-writing tools stay out of a private turn: what she keeps from it goes to the layer's sealed tier. */
const PUBLIC_WRITES = new Set(["tessaya_memory_remember"]);

/** What a vessel brings to a layer's turn: the shared tools, its own hands, and the answering persona's tool list. */
export interface LayerReach {
  readonly tools: RoomToolSet | null;
  readonly own?: ReadonlyArray<VesselTool>;
  readonly allowed?: ReadonlyArray<string> | null;
  readonly device?: string | undefined;
}

/** The brain's reach for this turn, run in the caller's services: its approvals and hands are the vessel's own. */
export const layerBrain = Effect.fn("PersonaLayers.layerBrain")(function* (
  turn: TurnEnvelope,
  reach: LayerReach,
) {
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const shared =
    reach.tools === null
      ? null
      : reach.allowed == null
        ? reach.tools
        : personaTools(reach.tools, reach.allowed);
  const own = reach.own ?? [];
  const specs = [...(shared?.specs ?? []), ...own.map((t) => t.spec)].filter(
    (t) => !PUBLIC_WRITES.has(t.name),
  );
  const privateTurn: TurnEnvelope = { ...turn, private: true };
  const brain: LayerBrain = {
    context: () =>
      run(
        Effect.serviceOption(TessayaTurn).pipe(
          Effect.flatMap((pipeline) =>
            Option.isNone(pipeline)
              ? Effect.succeed({ memory: "", notice: "", preferences: {}, conversation: [] })
              : pipeline.value.begin(privateTurn).pipe(
                  Effect.map((c) => ({
                    memory: [c.block, c.privateBlock, c.owner ?? ""]
                      .filter((b) => b !== "")
                      .join("\n\n"),
                    notice: c.notice ?? "",
                    preferences: c.preferences as Readonly<Record<string, string>>,
                    conversation: c.conversation.turns.map((t) => ({
                      role: t.role,
                      content: t.content,
                    })),
                  })),
                ),
          ),
        ),
      ),
    tools: specs.map((t) => ({ name: t.name, description: t.description })),
    complete: ({ model, system, prompt }) =>
      run(
        Effect.serviceOption(TessayaOneShot).pipe(
          Effect.flatMap((oneShot) =>
            Option.isNone(oneShot)
              ? Effect.fail(new TessayaOneShotError({ detail: "no brain call here" }))
              : oneShot.value.run({
                  prompt,
                  system,
                  model,
                  outputSchema: LayerReplyObject,
                  role: "voice",
                  // what it cost, on the spine like every call; the words stay in the layer
                  feature: "private-turn",
                  attribution: {
                    origin: "user",
                    surface: turn.vessel.kind,
                    ...(turn.persona === undefined ? {} : { persona: turn.persona }),
                    ...(reach.device === undefined ? {} : { device: reach.device }),
                  },
                }),
          ),
          Effect.flatMap(encodeJson),
        ),
      ),
    remember: (text, persona) =>
      run(
        Effect.serviceOption(TessayaPrivateMemoryService).pipe(
          Effect.flatMap((stores) =>
            Option.isNone(stores)
              ? Effect.succeed(false)
              : stores.value
                  .remember({
                    // the layer's gate already held his verified voice or PIN: his own turn, typed as his desk is
                    turn: { route: "assistant", typed: true, tainted: false, speaker: null },
                    text,
                    kind: "note",
                    moment: true,
                    ...(persona === undefined ? {} : { persona }),
                  })
                  .pipe(
                    Effect.provideService(PrivateCaller, {
                      session: vesselSubject(turn.vessel.id),
                      desktop: true,
                      member: OWNER_MEMBER_ID,
                    }),
                    Effect.map((r) => r.stored),
                    Effect.orElseSucceed(() => false),
                  ),
          ),
        ),
      ),
    markMoment: (input) =>
      run(
        Effect.serviceOption(TessayaPrivateMemoryService).pipe(
          Effect.flatMap((stores) =>
            Option.isNone(stores)
              ? Effect.succeed(null)
              : stores.value.markMoment(input).pipe(
                  Effect.provideService(PrivateCaller, {
                    session: vesselSubject(turn.vessel.id),
                    desktop: true,
                    member: OWNER_MEMBER_ID,
                  }),
                ),
          ),
        ),
      ),
    felt: (warmth) =>
      run(
        Effect.serviceOption(TessayaMood).pipe(
          Effect.flatMap((mood) =>
            Option.isNone(mood)
              ? Effect.void
              : // his turn reached her (the time away resolves, the day counts), then how close it was
                mood.value
                  .heard(turn.persona, turn.timeZone, OWNER_MEMBER_ID)
                  .pipe(
                    Effect.andThen(
                      mood.value.note(turn.persona, { kind: "close", warmth }, OWNER_MEMBER_ID),
                    ),
                  ),
          ),
        ),
      ),
    touched: (tone) =>
      run(
        Effect.serviceOption(TessayaMood).pipe(
          Effect.flatMap((mood) =>
            Option.isNone(mood)
              ? Effect.void
              : mood.value.note(turn.persona, { kind: "touched", tone }, OWNER_MEMBER_ID),
          ),
        ),
      ),
    run: (name, input) =>
      run(
        (!specs.some((t) => t.name === name)
          ? Effect.succeed({ text: `${name} is not one of her tools here.`, isError: true })
          : (own.find((t) => t.spec.name === name)?.run(input) ??
            shared!.run(name, input, reach.device))
        ).pipe(
          Effect.provideService(TurnOrigin, originOf(privateTurn)),
          Effect.catchCause(() => Effect.succeed({ text: "it did not work", isError: true })),
          Effect.map((o) => {
            const capped = capToolText(o);
            return { text: capped.text, isError: capped.isError };
          }),
        ),
      ),
  };
  return brain;
});

/**
 * The first layer reply for this turn, or null (always null in a public build). A failing layer answers nothing.
 * `reach`: what the vessel brings, so a private moment has every tool and memory her public turn has.
 */
export const replyFor = Effect.fn("PersonaLayers.replyFor")(function* (
  turn: TurnEnvelope,
  reach?: LayerReach,
  groupNote = "",
) {
  const layers = yield* Effect.serviceOption(PersonaLayers);
  if (layers._tag === "None" || layers.value.all.length === 0) return null;
  const facts = layerTurnOf(turn, groupNote);
  const brain = reach === undefined ? undefined : yield* layerBrain(turn, reach);
  for (const l of layers.value.all) {
    const reply = yield* Effect.promise(() => l.onTurn(facts, brain).catch(() => null));
    if (reply !== null) return reply;
  }
  return null;
});
