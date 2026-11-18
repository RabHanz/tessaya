import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { PersonaLayers, type PersonaLayer } from "./PersonaLayers.ts";
import { bodyState, moveBody, type BodyCaller } from "./TessayaBody.ts";

const her: BodyCaller = { id: "desktop:a", kind: "persona", mayBePrivate: true };
const outside: BodyCaller = { id: "client:x", kind: "outside", mayBePrivate: false };

const openLayer = (taken: Array<unknown>): PersonaLayer => ({
  id: "test",
  onTurn: async () => null,
  signal: () => undefined,
  http: async () => ({ status: 404 }),
  body: (m) => (taken.push(m), { ok: true, said: "moved" }),
  bodyState: () => ({ posture: "stand" }),
});
const desk = (writes: Array<unknown>) =>
  Layer.succeed(DeviceRegistry)(
    DeviceRegistry.of({
      list: Effect.succeed([{ deviceId: "d1", online: true, items: [{ id: "mascot.do" }] }]),
      write: (deviceId: string, itemId: string, value: unknown) =>
        Effect.sync(() => void writes.push([deviceId, itemId, value])),
    } as never),
  );

describe("TessayaBody", () => {
  it.effect("puts a move on the open private session's bodies as bounded cues", () =>
    Effect.gen(function* () {
      const taken: Array<{ cues: Array<{ kind: string }>; private: boolean }> = [];
      const answer = yield* moveBody(
        { act: "lean", mood: { name: "shy" }, then: [{ afterMs: 500, look: { x: -1, y: 0 } }] },
        her,
      ).pipe(Effect.provideService(PersonaLayers, { all: [openLayer(taken as Array<unknown>)] }));
      expect(answer).toEqual({ ok: true, route: "private", said: "moved" });
      expect(taken[0]!.private).toBe(false);
      expect(taken[0]!.cues.map((c) => c.kind)).toEqual(["act", "mood", "seq"]);
    }),
  );

  it.effect("keeps private moves inside a private moment and away from outside agents", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const none = yield* moveBody({ posture: "aroused" }, her).pipe(Effect.provide(desk(writes)));
      expect(none).toMatchObject({ ok: false, route: "none" });
      const taken: Array<unknown> = [];
      const refused = yield* moveBody({ act: "myOwnAct" }, outside).pipe(
        Effect.provideService(PersonaLayers, { all: [openLayer(taken)] }),
      );
      expect(refused).toMatchObject({ ok: false, route: "none" });
      expect(taken).toEqual([]);
      expect(writes).toEqual([]);
      const felt = yield* bodyState(outside).pipe(
        Effect.provideService(PersonaLayers, { all: [openLayer([])] }),
      );
      expect(felt).toMatchObject({ open: true, body: null });
    }),
  );

  it.effect(
    "with no private moment open, her desk character does what it can of an everyday move",
    () =>
      Effect.gen(function* () {
        const writes: Array<unknown> = [];
        const answer = yield* moveBody(
          { act: "wave", then: [{ afterMs: 800, gesture: "nodSmall" }] },
          her,
        ).pipe(Effect.provide(desk(writes)));
        expect(answer).toMatchObject({ ok: true, route: "desk" });
        expect(writes).toEqual([
          ["d1", "mascot.do", "wave"],
          ["d1", "mascot.do", "nod"],
        ]);
        const cannot = yield* moveBody({ bones: { head: [0.2, 0, 0] } }, her).pipe(
          Effect.provide(desk(writes)),
        );
        expect(cannot).toMatchObject({ ok: false, route: "none" });
      }),
  );

  it.effect("limits each caller to a burst, then tells it when to try again", () =>
    Effect.gen(function* () {
      const caller: BodyCaller = { id: "thread:burst", kind: "agent", mayBePrivate: true };
      const layers = Layer.succeed(PersonaLayers, { all: [openLayer([])] });
      const answers = [];
      for (let i = 0; i < 13; i++)
        answers.push(yield* moveBody({ gesture: "tilt" }, caller).pipe(Effect.provide(layers)));
      expect(answers.slice(0, 12).every((a) => a.ok)).toBe(true);
      expect(answers[12]).toMatchObject({ ok: false, retryMs: expect.any(Number) });
      expect(yield* moveBody({ bones: { tail: [0, 0, 0] } }, her)).toMatchObject({
        ok: false,
        said: expect.stringMatching(/unknown bone/),
      });
    }),
  );
});
