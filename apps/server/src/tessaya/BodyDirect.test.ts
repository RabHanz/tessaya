import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { R1Brain, type ToolTurn } from "../home/R1Brain.ts";
import { directBody, ratedRow, type DirectProgress } from "./BodyDirect.ts";
import { pollBus, resetPlaygroundForTest } from "./BodyPlayground.ts";
import { PersonaLayers } from "./PersonaLayers.ts";

const progress = (): DirectProgress => ({
  model: "haiku",
  said: "wave hello",
  calls: [],
  done: false,
  reasoning: "",
  firstMotionMs: null,
  ms: null,
  graded: null,
  error: null,
});

describe("BodyDirect", () => {
  it.effect(
    "drives only the playground's bus with the model he picked, and grades what it did",
    () =>
      Effect.gen(function* () {
        resetPlaygroundForTest();
        yield* pollBus({ bus: "pg-direct1", owner: "owner", after: 0, waitMs: 0 });
        const asked: Array<ToolTurn> = [];
        const her: Array<unknown> = [];
        const brain = R1Brain.of({
          route: Effect.succeed("api"),
          subscription: () => Stream.empty,
          session: () => Stream.empty,
          warm: () => Effect.void,
          converse: (turn) =>
            Stream.unwrap(
              Effect.gen(function* () {
                asked.push(turn);
                // an agent trying to reach her body is kept on the playground
                yield* turn.run("tessaya_body_move", { act: "wave", target: "her" });
                return Stream.make("Waved.");
              }),
            ),
        });
        const p = progress();
        yield* directBody({
          said: p.said,
          model: "haiku",
          playground: "pg-direct1",
          alsoHer: false,
          progress: p,
        }).pipe(
          Effect.provideService(R1Brain, brain),
          Effect.provideService(PersonaLayers, {
            all: [
              {
                id: "her",
                onTurn: async () => null,
                signal: () => undefined,
                http: async () => ({ status: 404 }),
                body: (m) => (her.push(m), { ok: true, said: "moved" }),
              },
            ],
          }),
        );
        expect(asked[0]).toMatchObject({ model: "haiku", feature: "body-playground" });
        expect(asked[0]!.tools.map((t) => t.name).sort()).toEqual([
          "tessaya_body_move",
          "tessaya_body_scene",
          "tessaya_body_state",
        ]);
        expect(her).toEqual([]);
        expect(p).toMatchObject({ done: true, reasoning: "Waved.", error: null });
        expect(p.calls.map((c) => [c.name, c.ok])).toEqual([["tessaya_body_move", true]]);
        expect(p.firstMotionMs).not.toBeNull();
        expect(p.graded?.moved).toBe(true);
        const got = yield* pollBus({ bus: "pg-direct1", owner: "owner", after: 0, waitMs: 0 });
        expect(got.cues.map((c) => c.kind)).toEqual(["act"]);
        // a rating is a row harvest.ts takes as it is
        expect(ratedRow("r1", p, true, "nice", 0)).toMatchObject({
          split: "seen",
          score: 5,
          calls: "tessaya_body_move",
          bodyInputs: [{ act: "wave" }],
        });
      }),
  );
});
