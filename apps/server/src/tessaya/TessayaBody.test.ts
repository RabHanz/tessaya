import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { PersonaLayers, type PersonaLayer } from "./PersonaLayers.ts";
import { onAction } from "../provenance/ActionLog.ts";
import { bodyState, feel, moveBody, playScene, type BodyCaller } from "./TessayaBody.ts";
import { SessionMember } from "./TessayaTurn.ts";
import * as TurnLiveContext from "./TurnLiveContext.ts";

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
        // a performance becomes the nearest of its few acts: joy hops
        yield* moveBody(
          { perform: { feel: { valence: 0.9, arousal: 0.8, dominance: 0.4 } } },
          her,
        ).pipe(Effect.provide(desk(writes)));
        expect(writes.at(-1)).toEqual(["d1", "mascot.do", "hop"]);
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
      // a live stream has its own bucket: its frames still go through, then it too is held to its rate
      const frames = [];
      for (let i = 0; i < 31; i++)
        frames.push(
          yield* moveBody({ stream: true, bones: { head: [0.01 * i, 0, 0] } }, caller).pipe(
            Effect.provide(layers),
          ),
        );
      expect(frames.slice(0, 30).every((a) => a.ok)).toBe(true);
      expect(frames[30]).toMatchObject({ ok: false, said: expect.stringMatching(/30 a second/) });
      expect(yield* moveBody({ bones: { tail: [0, 0, 0] } }, her)).toMatchObject({
        ok: false,
        said: expect.stringMatching(/unknown bone/),
      });
    }),
  );

  it.effect(
    "plays a core scene on the open session as one timed sequence, and dry-runs one with a fix per error",
    () =>
      Effect.gen(function* () {
        const taken: Array<{ cues: Array<{ kind: string }> }> = [];
        const played = yield* playScene(
          "greeting",
          { id: "thread:scene", kind: "agent", mayBePrivate: true },
          false,
        ).pipe(Effect.provideService(PersonaLayers, { all: [openLayer(taken as Array<unknown>)] }));
        expect(played).toMatchObject({ ok: true, route: "private" });
        expect(taken[0]!.cues.map((c) => c.kind)).toEqual(["mood", "gaze", "seq"]);
        const bad = yield* playScene(
          {
            version: 1,
            id: "k",
            beats: [{ atMs: 0, move: { bones: { leftLowerLeg: [-0.8, 0, 0] } } }],
          },
          her,
          true,
        );
        expect(bad).toMatchObject({
          ok: true,
          corrected: [{ at: "beats[0]", corrected: [{ bone: "leftLowerLeg", kind: "reversal" }] }],
        });
        expect(yield* playScene("nope", her, false)).toMatchObject({ ok: false });
      }),
  );

  it.effect(
    "a touch on the desk body is one provenance row with its member and vessel, and the next turn on any vessel knows it",
    () =>
      Effect.gen(function* () {
        const rows: Array<{ kind: string; actor: { kind: string; id?: string }; data: unknown }> =
          [];
        const off = onAction((e) => void (e.kind === "body.felt" && rows.push(e)));
        const live = yield* TurnLiveContext.TurnLiveContext;
        yield* feel({ vessel: "desktop", part: "head", kind: "pat" }).pipe(
          Effect.provideService(SessionMember, "member-sam"),
        );
        // an agent's hand through a move is felt the same way, named as the agent
        yield* moveBody({ touch: { part: "arm", motion: "stroke" } }, her).pipe(
          Effect.provideService(PersonaLayers, { all: [openLayer([])] }),
        );
        // a private moment's touch is sealed: recorded, but never in shared context
        yield* feel({ vessel: "window", part: "hand", kind: "hold", private: true });
        off();
        expect(rows.map((r) => [r.actor.kind, r.actor.id, r.data])).toEqual([
          ["member", "member-sam", { vessel: "desktop" }],
          ["agent", "desktop:a", { vessel: "window", pressure: 0.4 }],
        ]);
        const onTumble = yield* live.take({ vessel: "tessel-1", persona: null, spend: true });
        expect(onTumble).toMatch(/on his desktop, someone in the household patted your head/);
        // her nerves say what it was like: a slow stroke on hairy skin reaches her caress fibres
        expect(onTumble).toMatch(
          /an agent's hand stroked your arm \(you felt a slow stroke, 4 cm\/s\)/,
        );
        expect(onTumble).not.toMatch(/hand:|held your hand/);
      }).pipe(Effect.provide(TurnLiveContext.layer)),
  );
});
