import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { R1Brain, type SessionToolTurn } from "../home/R1Brain.ts";
import { answerAsk, askVessel } from "./AskWorker.ts";
import { BatonPhoneInbox } from "./BatonPhoneInbox.ts";
import { BatonRecordService } from "./BatonRecordService.ts";
import { TessayaTurn, type TurnEnvelope } from "./TessayaTurn.ts";

const ask = (id: string, source: "phone" | "device", origin: string | null) => ({
  id,
  text: "what's in flight?",
  source,
  origin,
  hisVoice: false,
  status: "taken" as const,
  createdAt: 0,
  expiresAt: 0,
  spoken: null,
  card: null,
  error: null,
});

effectIt.effect(
  "an ask from his phone, the R1 or an agent is answered by the one brain, and an agent's words are outside content",
  () =>
    Effect.gen(function* () {
      expect(askVessel(ask("p1", "phone", null))).toEqual({
        kind: "phone",
        origin: "phone",
        tainted: false,
      });
      expect(askVessel(ask("r1", "device", "R1"))).toMatchObject({ kind: "device", origin: "R1" });
      expect(askVessel(ask("mcp-a-1", "device", null))).toMatchObject({
        kind: "mcp",
        tainted: true,
      });

      const begun: Array<TurnEnvelope> = [];
      const answered: Array<[string, string]> = [];
      const sessions: Array<SessionToolTurn> = [];
      yield* answerAsk(ask("mcp-a-1", "device", null), {
        specs: [],
        run: () => Effect.succeed({ text: "", isError: false }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              R1Brain,
              R1Brain.of({
                route: Effect.succeed("subscription"),
                subscription: () => Stream.empty,
                converse: () => Stream.empty,
                warm: () => Effect.void,
                session: (t) => (sessions.push(t), Stream.make("Two jobs are running.")),
              }),
            ),
            Layer.mock(TessayaTurn)({
              begin: (turn) =>
                Effect.sync(() => {
                  begun.push(turn);
                  return {
                    block: "",
                    ids: [],
                    privateBlock: "",
                    conversation: { key: "household", turns: [] },
                    preferences: {},
                    who: { member: null, name: null },
                  };
                }),
              end: () => Effect.succeed(null),
            }),
            Layer.mock(BatonPhoneInbox)({
              answer: (id, spoken) => Effect.sync(() => (answered.push([id, spoken]), true)),
              fail: () => Effect.succeed(true),
            }),
            Layer.mock(BatonRecordService)({ append: () => Effect.void as never }),
          ),
        ),
      );
      expect(answered).toEqual([["mcp-a-1", "Two jobs are running."]]);
      expect(begun[0]).toMatchObject({ vessel: { kind: "mcp" }, tainted: true });
      // Never Claude Code's file tools for an ask: the words were not his at his own machine.
      expect(sessions[0]!.builtins).toBeUndefined();
    }),
);
