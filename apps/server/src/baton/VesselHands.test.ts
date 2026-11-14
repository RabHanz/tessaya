import { it as effectIt } from "@effect/vitest";
import { createHandsBroker, HIS_YES } from "@t3tools/tessaya-shared/remoteHands";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";

import { askHisYes, vesselTools } from "./VesselHands.ts";

const origin = { label: "desktop", hisVoice: false, member: "owner", assurance: 2, tainted: false };

effectIt.effect(
  "a desk turn's act asks his yes in the desktop's own box, and says when the desktop can't be asked",
  () =>
    Effect.gen(function* () {
      const hands = createHandsBroker({ now: () => 0, newId: () => "c1" });
      expect(yield* askHisYes(hands, origin, "add acme/app as a project")).toBe("unreachable");
      yield* Effect.promise(() =>
        hands.take(1, [{ name: HIS_YES, description: "", input_schema: {} }]),
      );
      // The box is never one of the model's tools.
      expect(vesselTools(hands, origin)).toEqual([]);
      const asking = yield* Effect.forkChild(askHisYes(hands, origin, "add acme/app as a project"));
      const call = (yield* Effect.promise(() => hands.take(1)))!;
      expect(call).toMatchObject({
        tool: HIS_YES,
        args: { what: "add acme/app as a project" },
        origin,
      });
      hands.reply(call.id, { ok: true, text: "no" });
      expect(yield* Fiber.join(asking)).toBe("no");
    }),
);
