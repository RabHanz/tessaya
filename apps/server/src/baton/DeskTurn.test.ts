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
import { VesselHands } from "./VesselHands.ts";

const run = (ownMachine: boolean) =>
  Effect.gen(function* () {
    const seen: Array<SessionToolTurn> = [];
    const hands = createHandsBroker({ now: () => 0, newId: () => "c1" });
    // The desktop is listening and offers its screen.
    void hands.take(1, [
      { name: "screen_capture", description: "his screen", input_schema: { type: "object" } },
    ]);
    const said = yield* deskTurnStream(
      { text: "what's on my screen?", context: "the window he is using (data): Notepad" },
      { specs: [], run: () => Effect.succeed({ text: "", isError: false }) },
      ownMachine,
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
              Effect.succeed({
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
            end: () => Effect.succeed(null),
          }),
          Layer.mock(BatonRecordService)({ append: () => Effect.void as never }),
          Layer.succeed(VesselHands, hands),
        ),
      ),
    );
    return { said: [...said].join(""), turn: seen[0]! };
  });

effectIt.effect(
  "his sentence at the desk reaches the one brain with memory, the conversation from any vessel and the desktop's hands",
  () =>
    Effect.gen(function* () {
      const { said, turn } = yield* run(true);
      expect(said).toBe("It's Notepad. ");
      expect(turn.system.startsWith(AGENT_PROMPT)).toBe(true);
      expect(turn.vessel).toBe("desktop");
      expect(turn.user).toContain("Notepad");
      expect(turn.user).toContain("he likes short answers");
      expect(turn.user).toContain('"vessel":"R1"');
      expect(turn.tools.map((t) => t.name)).toContain("screen_capture");
      expect(turn.builtins?.tools).toContain("Bash");
    }),
);

effectIt.effect("Claude Code's file tools stay off unless the turn runs on his own machine", () =>
  Effect.gen(function* () {
    const { turn } = yield* run(false);
    expect(turn.builtins).toBeUndefined();
  }),
);
