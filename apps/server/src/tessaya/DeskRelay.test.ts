import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { R1Brain } from "../home/R1Brain.ts";
import { TessayaRecordService } from "./TessayaRecordService.ts";
import { peerTurnHands, servePeerTurn } from "./DeskRelay.ts";
import { TessayaTurn } from "./TessayaTurn.ts";

effectIt.effect(
  "the home server runs his desk turn and reaches his desktop's hands only through the server that sent it",
  () =>
    Effect.gen(function* () {
      const turn = yield* servePeerTurn(
        {
          text: "what's on my screen?",
          turnId: "t1",
          offered: [{ name: "screen_capture", description: "his screen", input_schema: {} }],
        },
        "laptop-session",
        { specs: [], run: () => Effect.succeed({ text: "", isError: false }) },
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
                // The model looks at his screen; Claude Code's file tools are never on here.
                session: (t) =>
                  t.builtins === undefined
                    ? Stream.fromEffect(t.run("screen_capture", {})).pipe(
                        Stream.map((o) => `It's ${o.text}. `),
                      )
                    : Stream.make("file tools were on"),
              }),
            ),
            Layer.mock(TessayaTurn)({
              begin: () =>
                Effect.succeed({
                  block: "",
                  ids: [],
                  privateBlock: "",
                  conversation: { key: "household", turns: [] },
                  preferences: {},
                  who: { member: null, name: null },
                }),
              end: () => Effect.succeed(null),
            }),
            Layer.mock(TessayaRecordService)({ append: () => Effect.void as never }),
          ),
        ),
        Effect.forkChild,
      );
      // Let the turn start and register before the relay asks for its calls.
      yield* Effect.yieldNow;
      // Another server's session never reaches this turn's hands.
      expect(
        (yield* Effect.promise(() => peerTurnHands("other", "take", { turnId: "t1" }))).status,
      ).toBe(404);
      const taken = yield* Effect.promise(() =>
        peerTurnHands("laptop-session", "take", { turnId: "t1" }),
      );
      const call = taken.json["call"] as { id: string; tool: string; origin?: { label: string } };
      expect(call.tool).toBe("screen_capture");
      expect(call.origin?.label).toBe("desktop");
      yield* Effect.promise(() =>
        peerTurnHands("laptop-session", "reply", {
          turnId: "t1",
          id: call.id,
          result: { ok: true, text: "Notepad" },
        }),
      );
      expect([...(yield* Fiber.join(turn))].join("")).toBe("It's Notepad. ");
    }),
);
