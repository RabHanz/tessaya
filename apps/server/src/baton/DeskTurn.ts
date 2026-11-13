// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off
/**
 * The desktop as a vessel of the one brain (SPINE-UNIFY S4): his sentence at the desk goes to `brainTurn` with the
 * shared tools, the tools the desktop offers through its hands, and, on his own machine, Claude Code's file tools.
 * The desktop sends only what it sees (his window, the persona he woke); memory, the conversation and his work are read here.
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AGENT_PROMPT } from "@t3tools/baton-shared/agentPrompt";
import { recordText } from "@t3tools/baton-shared/audit";
import { assistantFrame } from "@t3tools/baton-shared/osPack";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { R1Brain, type RoomToolSet } from "../home/R1Brain.ts";
import { MemoryViewer } from "./BatonMemoryService.ts";
import { BatonRecordService } from "./BatonRecordService.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { brainTurn, type ActOutcome } from "./TessayaBrain.ts";
import { TessayaTurn, originOf, type TurnEnvelope } from "./TessayaTurn.ts";
import { VesselHands, vesselTools } from "./VesselHands.ts";

const Speaker = Schema.Struct({
  kind: Schema.Literals(["owner", "saved", "guest", "unverified"]),
  personId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  verified: Schema.Boolean,
  inherited: Schema.Boolean,
  confidence: Schema.optional(Schema.NullOr(Schema.Number)),
});

/** What the desktop sends with his sentence. */
export const DeskTurnBody = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(4000)),
  /** What the desktop sees: his window, the persona he woke, how long since they spoke (`contextLine`). Data. */
  context: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  persona: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  speaker: Schema.optional(Schema.NullOr(Speaker)),
  project: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  /** This desktop's id in the device registry. */
  vessel: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  timeZone: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
  /** The Claude Code binary his desktop is set to use, honoured only on his own machine. */
  claudeBinary: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type DeskTurnBody = typeof DeskTurnBody.Type;

/** What Claude Code itself may do on his own machine, as the desktop's sessions do today. */
const OWN_MACHINE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "Bash",
  "WebFetch",
  "WebSearch",
] as const;

const deskData = (input: {
  readonly body: DeskTurnBody;
  readonly memory: string;
  readonly privateBlock: string;
  readonly preferences: Readonly<Record<string, string>>;
  readonly conversation: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly notes: { readonly brain: string; readonly work: string };
}) =>
  [
    input.body.context ?? "",
    input.notes.work,
    input.notes.brain,
    input.memory === "" ? "" : `What you remember (data): ${JSON.stringify(input.memory)}`,
    input.privateBlock,
    Object.keys(input.preferences).length === 0
      ? ""
      : `How he likes things (follow these): ${JSON.stringify(input.preferences)}`,
    input.conversation.length === 0
      ? ""
      : `The conversation so far: ${JSON.stringify(input.conversation.slice(-12))}`,
    `He just said: ${JSON.stringify(input.body.text)}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

/**
 * His sentence at the desk through the one brain, as her words stream. `ownMachine`: the caller is the desktop app on
 * this same machine, so Claude Code's file and command tools act on his files; from anywhere else they stay off.
 */
export const deskTurnStream = (body: DeskTurnBody, tools: RoomToolSet, ownMachine: boolean) =>
  Stream.callback((queue: Queue.Queue<string, Cause.Done>) =>
    Effect.gen(function* () {
      const brain = yield* R1Brain;
      const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
      const pack = readPack(
        Option.isNone(config) ? NodeOS.homedir() : NodePath.dirname(config.value.dbPath),
      );
      const turn: TurnEnvelope = {
        vessel: { kind: "desktop", id: body.vessel ?? "desktop" },
        origin: "desktop",
        text: body.text,
        ...(body.persona === undefined ? {} : { persona: body.persona }),
        speaker:
          body.speaker == null
            ? null
            : {
                kind: body.speaker.kind,
                personId: body.speaker.personId,
                verified: body.speaker.verified,
                inherited: body.speaker.inherited,
                ...(body.speaker.confidence === undefined
                  ? {}
                  : { confidence: body.speaker.confidence }),
              },
        project: body.project ?? null,
        ...(body.timeZone === undefined ? {} : { timeZone: body.timeZone }),
        // Each turn is a fresh session, as on the room: standing memory comes with the turn.
        sessionless: true,
      };
      const hands = yield* Effect.serviceOption(VesselHands);
      const said = yield* brainTurn(
        {
          system: `${AGENT_PROMPT}\n\n${assistantFrame(pack)}`,
          tools,
          device: body.vessel,
          hold: () => (call) => call,
          ...(ownMachine
            ? {
                builtins: {
                  tools: OWN_MACHINE_TOOLS,
                  cwd: NodeOS.homedir(),
                  ...(body.claudeBinary === undefined || body.claudeBinary.trim() === ""
                    ? {}
                    : { binary: body.claudeBinary }),
                },
              }
            : {}),
          gather: Effect.gen(function* () {
            const pipeline = yield* TessayaTurn;
            const begun = yield* pipeline
              .begin(turn)
              .pipe(Effect.provideService(MemoryViewer, "desktop"));
            return {
              turn,
              names: pack.personas.map((p) => p.name),
              user: (notes: { readonly brain: string; readonly work: string }) =>
                deskData({
                  body,
                  memory: begun.block,
                  privateBlock: begun.privateBlock,
                  preferences: begun.preferences,
                  conversation: begun.conversation.turns,
                  notes,
                }),
              readBefore: [],
              own: Option.isNone(hands) ? [] : vesselTools(hands.value, originOf(turn)),
              finish: Effect.fn("DeskTurn.finish")(function* (
                reply: string,
                outcomes: ReadonlyArray<ActOutcome>,
                done: TurnEnvelope,
              ) {
                yield* pipeline.end(done, { reply }).pipe(Effect.ignore, Effect.forkDetach);
                const record = yield* Effect.serviceOption(BatonRecordService);
                if (Option.isSome(record))
                  yield* record.value
                    .append({
                      kind: "desktop",
                      actor: "desktop",
                      subject: `heard ${JSON.stringify(recordText(body.text, 160))}`,
                      outcome: outcomes.length === 0 ? "answered" : `acted ${outcomes.length}`,
                      detail: recordText(reply, 300),
                    })
                    .pipe(Effect.ignore);
              }),
            };
          }),
        },
        brain,
        (words) => Queue.offerUnsafe(queue, words),
        "session",
      ).pipe(Effect.orElseSucceed(() => null));
      if (said === null) Queue.offerUnsafe(queue, "Sorry, something went wrong on my side.");
      yield* Queue.end(queue);
    }),
  );
