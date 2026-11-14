import { it as effectIt } from "@effect/vitest";
import { AGENT_PROMPT } from "@t3tools/baton-shared/agentPrompt";
import { createHandsBroker } from "@t3tools/baton-shared/remoteHands";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { R1Brain, type SessionToolTurn } from "../home/R1Brain.ts";
import { BatonRecordService } from "./BatonRecordService.ts";
import { deskTurnStream } from "./DeskTurn.ts";
import { TessayaTurn } from "./TessayaTurn.ts";
import { type PersonaLayer, PersonaLayers } from "../tessaya/PersonaLayers.ts";

const run = (ownMachine: boolean, layers: Array<PersonaLayer> = []) =>
  Effect.gen(function* () {
    const seen: Array<SessionToolTurn> = [];
    const touched: Array<string> = [];
    const hands = createHandsBroker({ now: () => 0, newId: () => "c1" });
    // The desktop is listening and offers its screen.
    void hands.take(1, [
      { name: "screen_capture", description: "his screen", input_schema: { type: "object" } },
    ]);
    const said = yield* deskTurnStream(
      {
        text: "what's on my screen?",
        context: "the window he is using (data): Notepad",
        claudeBinary: "C:\\claude.exe",
      },
      { specs: [], run: () => Effect.succeed({ text: "", isError: false }) },
      ownMachine,
      hands,
    ).pipe(
      Stream.runCollect,
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            R1Brain,
            R1Brain.of({
              route: Effect.succeed("subscription"),
              subscription: () => Stream.empty,
              converse: () => Stream.empty,
              warm: () => Effect.void,
              session: (turn) => {
                seen.push(turn);
                return Stream.make("It's Notepad. ");
              },
            }),
          ),
          Layer.mock(TessayaTurn)({
            begin: () =>
              Effect.sync(() => touched.push("begin")).pipe(
                Effect.as({
                  block: "he likes short answers",
                  ids: [],
                  privateBlock: "",
                  conversation: {
                    key: "household",
                    turns: [{ role: "user", content: "hi", vessel: "R1" }],
                  },
                  preferences: {},
                  who: { member: null, name: null },
                }),
              ),
            end: () => Effect.sync(() => touched.push("end")).pipe(Effect.as(null)),
          }),
          Layer.mock(BatonRecordService)({
            append: () => Effect.sync(() => touched.push("record")) as never,
          }),
          Layer.succeed(PersonaLayers, { all: layers }),
        ),
      ),
    );
    return { said: [...said].join(""), turn: seen[0], touched };
  });

effectIt.effect(
  "his sentence at the desk reaches the one brain with memory, the conversation from any vessel and the desktop's hands",
  () =>
    Effect.gen(function* () {
      const { said, turn: seenTurn } = yield* run(true);
      const turn = seenTurn!;
      expect(said).toBe("It's Notepad. ");
      expect(turn.system.startsWith(AGENT_PROMPT)).toBe(true);
      expect(turn.vessel).toBe("desktop");
      expect(turn.user).toContain("Notepad");
      expect(turn.user).toContain("he likes short answers");
      expect(turn.user).toContain('"vessel":"R1"');
      expect(turn.tools.map((t) => t.name)).toContain("screen_capture");
      expect(turn.builtins?.tools).toContain("Bash");
      expect(turn.builtins?.binary).toBe("C:\\claude.exe");
    }),
);

effectIt.effect("Claude Code's file tools stay off unless the turn runs on his own machine", () =>
  Effect.gen(function* () {
    const { turn } = yield* run(false);
    expect(turn!.builtins).toBeUndefined();
  }),
);

effectIt.effect(
  "a persona layer that answers takes the whole turn: no brain, no memory, nothing in the Record",
  () =>
    Effect.gen(function* () {
      const facts: Array<unknown> = [];
      const { said, turn, touched } = yield* run(true, [
        {
          id: "test",
          onTurn: async (t) => {
            facts.push(t);
            return {
              text: "Only the layer speaks.",
              mood: "happy",
              gesture: "none",
              intensity: 0.5,
            };
          },
          signal: () => undefined,
          http: async () => ({ status: 404 }),
        },
      ]);
      expect(said).toBe("Only the layer speaks.");
      expect(turn).toBeUndefined();
      expect(touched).toEqual([]);
      expect(facts).toEqual([
        expect.objectContaining({
          member: "owner",
          assurance: 2,
          vessel: { kind: "desktop", id: "desktop" },
        }),
      ]);
    }),
);
