import { it as effectIt } from "@effect/vitest";
import { createHandsBroker, HIS_YES } from "@t3tools/tessaya-shared/remoteHands";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { LOOK_GRANT } from "@t3tools/tessaya-shared/consent";
import { OPEN_WINDOWS_HEAD } from "@t3tools/tessaya-shared/screenCompanion";
import { expect } from "vite-plus/test";

import { askHisYes, vesselTools } from "./VesselHands.ts";
import { Consent, layer as consentLayer } from "./consent.ts";
import { layerMemory } from "./TessayaDatabase.ts";
import { TurnLiveContext, layer as liveLayer } from "./TurnLiveContext.ts";

const origin = { label: "desktop", hisVoice: false, member: "owner", assurance: 2, tainted: false };

effectIt.effect(
  "once he allowed looks, a brain turn's screenshot passes only for him, never a guest's or unverified voice",
  () =>
    Effect.gen(function* () {
      const consent = yield* Consent;
      yield* consent.set(LOOK_GRANT, true);
      let id = 0;
      const hands = createHandsBroker({ now: () => 0, newId: () => `c${++id}` });
      yield* Effect.promise(() =>
        hands.take(1, [{ name: "screen_capture", description: "", input_schema: {} }]),
      );
      const look = (who: Record<string, unknown>) =>
        vesselTools(hands, { ...origin, kind: "desktop", id: "desktop", ...who }, consent)[0]!.run(
          {},
        );
      // A guest's voice at his desk, and his own unverified (A0): refused, and the desktop is never called.
      for (const who of [
        { speaker: { kind: "guest" }, member: null, assurance: 0 },
        { speaker: { kind: "unverified" }, member: "owner", assurance: 0 },
      ])
        expect((yield* look(who)).isError).toBe(true);
      expect(yield* Effect.promise(() => hands.take(1))).toBeNull();
      // His typed turn at his own desktop reaches it.
      const his = yield* Effect.forkChild(look({ speaker: null }));
      const call = (yield* Effect.promise(() => hands.take(1)))!;
      expect(call.tool).toBe("screen_capture");
      hands.reply(call.id, { ok: true, text: "a window" });
      expect((yield* Fiber.join(his)).isError).toBe(false);
    }).pipe(Effect.provide(Layer.provideMerge(consentLayer, layerMemory))),
);

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

effectIt.effect(
  "the same act asked twice while its box is up is one box, and both hear its answer",
  () =>
    Effect.gen(function* () {
      let id = 0;
      const hands = createHandsBroker({ now: () => 0, newId: () => `c${++id}` });
      yield* Effect.promise(() =>
        hands.take(1, [{ name: HIS_YES, description: "", input_schema: {} }]),
      );
      const ask = askHisYes(hands, origin, "connect Tumble to your headphones", "device_set|x|");
      const first = yield* Effect.forkChild(ask);
      const second = yield* Effect.forkChild(ask);
      const call = (yield* Effect.promise(() => hands.take(1)))!;
      hands.reply(call.id, { ok: true, text: "always" });
      expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual(["always", "always"]);
      // No second box was queued.
      expect(yield* Effect.promise(() => hands.take(1))).toBeNull();
    }),
);

effectIt.effect(
  "a read of his windows stays in front of her next turns at that desk: titles and screens, never the controls",
  () =>
    Effect.gen(function* () {
      const hands = createHandsBroker({ now: () => 0, newId: () => "c1" });
      yield* Effect.promise(() =>
        hands.take(1, [{ name: "ui_tree", description: "", input_schema: {} }]),
      );
      const reading = yield* Effect.forkChild(
        vesselTools(hands, { ...origin, kind: "desktop", id: "desk" })[0]!.run({}),
      );
      const call = (yield* Effect.promise(() => hands.take(1)))!;
      hands.reply(call.id, {
        ok: true,
        text: [
          "Untitled - Notepad",
          "[1] document: Text editor (focused) = my bank PIN is 1234",
          OPEN_WINDOWS_HEAD,
          "- Untitled - Notepad (screen 1, left)",
          "- Inbox - Google Chrome (screen 2, right)",
        ].join("\n"),
      });
      yield* Fiber.join(reading);
      const live = yield* TurnLiveContext;
      const next = yield* live.take({ vessel: "desk", persona: null, spend: true });
      expect(next).toContain("Inbox - Google Chrome (screen 2, right)");
      expect(next).not.toContain("PIN");
      expect(yield* live.take({ vessel: "phone", persona: null, spend: true })).toBe("");
    }).pipe(Effect.provide(liveLayer)),
);
