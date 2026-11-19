import { it as effectIt } from "@effect/vitest";
import { AGENT_PROMPT } from "@t3tools/tessaya-shared/agentPrompt";
import { createHandsBroker } from "@t3tools/tessaya-shared/remoteHands";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { R1Brain, type SessionToolTurn } from "../home/R1Brain.ts";
import { TessayaRecordService } from "./TessayaRecordService.ts";
import { deskTurnStream } from "./DeskTurn.ts";
import { TessayaTurn, type TurnEnvelope, type WhoIsHome } from "./TessayaTurn.ts";
import { type PersonaLayer, PersonaLayers } from "./PersonaLayers.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { TessayaPrivateMemoryService } from "./TessayaPrivateMemoryService.ts";

const run = (
  ownMachine: boolean,
  layers: Array<PersonaLayer> = [],
  home: ReadonlyArray<WhoIsHome> = [],
) =>
  Effect.gen(function* () {
    const seen: Array<SessionToolTurn> = [];
    const touched: Array<string> = [];
    const begun: Array<TurnEnvelope> = [];
    const ran: Array<{ name: string; input: unknown }> = [];
    const asked: Array<{ role: string; feature: string; model?: string; persona?: string }> = [];
    const sealed: Array<{ text: string; typed: boolean }> = [];
    const moods: Array<unknown> = [];
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
        words: [
          { text: "what's", p: 0.98 },
          { text: "on", p: null },
        ],
        recogniser: "parakeet-tdt-0.6b-v3-Q8_0",
      },
      {
        specs: [
          {
            name: "home_do",
            description: "change a home device",
            input_schema: { type: "object" },
          },
          {
            name: "tessaya_memory_remember",
            description: "remember",
            input_schema: { type: "object" },
          },
        ],
        run: (name, input) =>
          Effect.sync(() => {
            ran.push({ name, input });
            return { text: "done", isError: false };
          }),
      },
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
            begin: (turn) =>
              Effect.sync(() => {
                touched.push("begin");
                begun.push(turn);
              }).pipe(
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
            whoIsHome: Effect.succeed(home),
          }),
          Layer.mock(TessayaRecordService)({
            append: () => Effect.sync(() => touched.push("record")) as never,
          }),
          Layer.succeed(PersonaLayers, { all: layers }),
          Layer.mock(TessayaPrivateMemoryService)({
            remember: (input) =>
              Effect.sync(() => {
                sealed.push({ text: input.text, typed: input.turn.typed });
                return { stored: true, whose: "owner", reason: null };
              }),
          }),
          Layer.mock(TessayaMood)({
            note: (persona, event, member) =>
              Effect.sync(() => void moods.push([persona, event, member])),
          }),
          Layer.succeed(
            TessayaOneShot,
            TessayaOneShot.of({
              run: (input) =>
                Effect.sync(() => {
                  asked.push({
                    role: input.role,
                    feature: input.feature,
                    ...(input.model === undefined ? {} : { model: input.model }),
                    ...(input.attribution?.persona === undefined
                      ? {}
                      : { persona: input.attribution.persona }),
                  });
                  return { text: "Mm.", mood: "happy" } as never;
                }),
            }),
          ),
        ),
      ),
    );
    return {
      said: [...said].filter((w) => typeof w === "string").join(""),
      events: [...said],
      turn: seen[0],
      touched,
      begun,
      asked,
      sealed,
      moods,
      ran,
    };
  });

effectIt.effect(
  "his sentence at the desk reaches the one brain with memory, the conversation from any vessel and the desktop's hands",
  () =>
    Effect.gen(function* () {
      const { said, turn: seenTurn, begun } = yield* run(true);
      const turn = seenTurn!;
      // His words' confidences reach transcript repair, judged on that recogniser's bounds.
      expect(begun[0]).toMatchObject({
        words: [
          { text: "what's", p: 0.98 },
          { text: "on", p: null },
        ],
        recogniser: "parakeet-tdt-0.6b-v3-Q8_0",
      });
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
      const { said, events, turn, touched } = yield* run(true, [
        {
          id: "test",
          onTurn: async (t) => {
            facts.push(t);
            return {
              text: "Only the layer speaks.",
              mood: "happy",
              gesture: "none",
              intensity: 0.5,
              affect: "tender",
            };
          },
          signal: () => undefined,
          http: async () => ({ status: 404 }),
        },
      ]);
      expect(said).toBe("Only the layer speaks.");
      // Marked private first (presence unknown: not on speakers), then its affect, so the whole line is said in it.
      expect(events.slice(0, 2)).toEqual([{ private: { speakers: false } }, { affect: "tender" }]);
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

effectIt.effect(
  "a private turn has her main memory and every tool of the turn, and leaves nothing on shared views",
  () =>
    Effect.gen(function* () {
      const seen: Array<{
        memory: string;
        tools: Array<string>;
        acted: string;
        refused: boolean;
        wrote: string;
      }> = [];
      const { said, touched, begun, ran, asked, sealed, moods } = yield* run(true, [
        {
          id: "test",
          onTurn: async (_t, brain) => {
            const context = await brain!.context();
            const acted = await brain!.run("home_do", { light: "desk", on: false });
            const refused = await brain!.run("tessaya_memory_remember", { text: "x" });
            // her reply is written by the one brain's call, on the model the layer's router chose
            // a note of hers goes into his one sealed tier (step 6), not the public memory
            if ((await brain!.remember!("he likes rain")) !== true) throw new Error("not kept");
            // how close it felt reaches her one mood, never its words
            await brain!.felt!(0.8);
            const wrote = await brain!.complete!({
              model: "claude-sonnet-5-5",
              system: "her",
              prompt: "him",
            });
            seen.push({
              memory: context.memory,
              tools: brain!.tools.map((t) => t.name),
              acted: acted.text,
              refused: refused.isError,
              wrote,
            });
            return { text: "Done, love.", mood: "happy", gesture: "none", intensity: 0.5 };
          },
          signal: () => undefined,
          http: async () => ({ status: 404 }),
        },
      ]);
      expect(said).toBe("Done, love.");
      expect(seen).toEqual([
        {
          memory: "he likes short answers",
          // The shared home tools and the desktop's own hands; never the public memory write.
          tools: ["home_do", "screen_capture"],
          acted: "done",
          refused: true,
          wrote: '{"text":"Mm.","mood":"happy"}',
        },
      ]);
      // one call on the spine, as a spoken turn on his subscription, never with its words
      expect(sealed).toEqual([{ text: "he likes rain", typed: true }]);
      expect(moods).toEqual([[undefined, { kind: "close", warmth: 0.8 }, "owner"]]);
      expect(asked).toEqual([
        { role: "voice", feature: "private-turn", model: "claude-sonnet-5-5" },
      ]);
      expect(ran).toEqual([{ name: "home_do", input: { light: "desk", on: false } }]);
      expect(begun[0]?.private).toBe(true);
      // Read through the one pipeline, but no end, no Record.
      expect(touched).toEqual(["begin"]);
    }),
);

effectIt.effect(
  "a private reply may play on the desk's speakers only while he is placed there alone",
  () =>
    Effect.gen(function* () {
      const layer: PersonaLayer = {
        id: "test",
        onTurn: async () => ({ text: "Hi.", mood: "happy", gesture: "none", intensity: 0.5 }),
        signal: () => undefined,
        http: async () => ({ status: 404 }),
      };
      const at = (vessel: string, member = "owner") =>
        ({ member, likelyHome: true, nearest: { vessel, confidence: 1 } }) as unknown as WhoIsHome;
      const marker = (home: ReadonlyArray<WhoIsHome>) =>
        Effect.map(run(true, [layer], home), (r) => r.events[0]);
      expect(yield* marker([at("desktop")])).toEqual({ private: { speakers: true } });
      expect(yield* marker([at("kitchen")])).toEqual({ private: { speakers: false } });
      expect(yield* marker([at("desktop"), at("hall", "sara")])).toEqual({
        private: { speakers: false },
      });
    }),
);
