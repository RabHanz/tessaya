import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { PersonaLayers, type PersonaLayer } from "./PersonaLayers.ts";
import { onAction } from "../provenance/ActionLog.ts";
import {
  bodyHolderLine,
  bodyState,
  feel,
  moveBody,
  playScene,
  noteDeskWorld,
  restBody,
  wishTick,
  type BodyCaller,
} from "./TessayaBody.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { SessionMember, TessayaTurn } from "./TessayaTurn.ts";
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
  it.effect("puts a move on her shown full body as bounded cues, private moment or not", () =>
    Effect.gen(function* () {
      const taken: Array<{ cues: Array<{ kind: string }>; private: boolean }> = [];
      const answer = yield* moveBody(
        { act: "lean", mood: { name: "shy" }, then: [{ afterMs: 500, look: { x: -1, y: 0 } }] },
        her,
      ).pipe(Effect.provideService(PersonaLayers, { all: [openLayer(taken as Array<unknown>)] }));
      expect(answer).toEqual({ ok: true, route: "body", said: "moved" });
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

  it.effect("a private cue her shown body refuses outside a private moment goes nowhere else", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const shownPublic: PersonaLayer = {
        ...openLayer([]),
        body: (m) =>
          m.private
            ? { ok: false, said: "Not outside a private moment." }
            : { ok: true, said: "moved" },
      };
      const refused = yield* moveBody({ posture: "aroused" }, her).pipe(
        Effect.provideService(PersonaLayers, { all: [shownPublic] }),
        Effect.provide(desk(writes)),
      );
      expect(refused).toEqual({
        ok: false,
        route: "private",
        said: "Not outside a private moment.",
      });
      const waved = yield* moveBody({ act: "wave" }, her).pipe(
        Effect.provideService(PersonaLayers, { all: [shownPublic] }),
        Effect.provide(desk(writes)),
      );
      expect(waved).toMatchObject({ ok: true, route: "body" });
      expect(writes).toEqual([]);
    }),
  );

  it.effect(
    "with no full body shown, her desk character does what it can of an everyday move",
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

  it.effect(
    "only the conversation he is in moves her body, a scene holds it until he speaks elsewhere, and her desk is his alone",
    () =>
      Effect.gen(function* () {
        yield* restBody();
        const writes: Array<unknown> = [];
        const focused: Array<unknown> = [];
        const off = onAction((e) => void (e.kind === "body.focus" && focused.push(e.data)));
        const desks = Layer.succeed(DeviceRegistry)(
          DeviceRegistry.of({
            list: Effect.succeed([
              { deviceId: "his", online: true, items: [{ id: "mascot.do" }] },
              { deviceId: "saras", online: true, member: "sara", items: [{ id: "mascot.do" }] },
            ]),
            write: (deviceId: string, itemId: string, value: unknown) =>
              Effect.sync(() => void writes.push([deviceId, itemId, value])),
          } as never),
        );
        const a: BodyCaller = {
          ...her,
          id: "desktop:focus",
          thread: "freya|person:owner",
          signal: "type",
        };
        const b: BodyCaller = {
          id: "phone:p",
          kind: "persona",
          mayBePrivate: true,
          thread: "freya|w2",
          signal: "type",
        };
        expect(yield* moveBody({ act: "wave" }, a).pipe(Effect.provide(desks))).toMatchObject({
          ok: true,
          route: "desk",
        });
        expect(writes).toEqual([["his", "mascot.do", "wave"]]);
        // B's reply a moment later does not mix in; once he has been in B a while, B has her
        expect(yield* moveBody({ act: "nod" }, b).pipe(Effect.provide(desks))).toMatchObject({
          ok: false,
          route: "none",
        });
        yield* TestClock.adjust("3 seconds");
        expect(yield* moveBody({ act: "nod" }, b).pipe(Effect.provide(desks))).toMatchObject({
          ok: true,
        });
        // B's scene holds her: A typing a moment later still does not, but his voice in A pauses it and A has her
        const layers = { all: [openLayer([])] };
        expect(
          yield* playScene("greeting", b, false).pipe(Effect.provideService(PersonaLayers, layers)),
        ).toMatchObject({ ok: true });
        const spoke: BodyCaller = { ...a, signal: "speak" };
        expect(yield* moveBody({ act: "wave" }, spoke).pipe(Effect.provide(desks))).toMatchObject({
          ok: true,
        });
        // and a third conversation a moment later does not take it from the one he spoke in
        const c: BodyCaller = {
          id: "phone:q",
          kind: "persona",
          mayBePrivate: true,
          thread: "freya|w3",
          signal: "type",
        };
        expect(yield* moveBody({ act: "nod" }, c).pipe(Effect.provide(desks))).toMatchObject({
          ok: false,
        });
        off();
        expect(focused).toEqual([
          { from: null, to: "freya|person:owner", event: "presence" },
          { from: "freya|person:owner", to: "freya|w2", event: "presence" },
          { from: "freya|w2", to: "freya|person:owner", event: "presence" },
        ]);
        yield* restBody();
      }),
  );

  it.effect("says which of his conversations has her desk body, and when she is free", () =>
    Effect.gen(function* () {
      yield* restBody();
      expect(yield* bodyHolderLine()).toBe("Her desk body is free: no conversation holds it.");
      const agent: BodyCaller = {
        id: "thread:t3-a",
        kind: "agent",
        mayBePrivate: true,
        signal: "touch",
      };
      yield* moveBody({ act: "wave" }, agent).pipe(
        Effect.provideService(PersonaLayers, { all: [openLayer([])] }),
      );
      expect(yield* bodyHolderLine()).toBe("Her desk body is with one of his agents.");
      yield* TestClock.adjust("3 seconds");
      const freya: BodyCaller = {
        ...her,
        id: "desktop:who",
        thread: "freya|person:owner",
        signal: "speak",
      };
      yield* playScene("greeting", freya, false).pipe(
        Effect.provideService(PersonaLayers, { all: [openLayer([])] }),
      );
      expect(yield* bodyHolderLine()).toBe(
        "Her desk body is with a conversation that has gone quiet (a scene is playing).",
      );
      yield* restBody();
    }),
  );

  it.effect("her own wish moves her only at rest, and the record keeps why", () =>
    Effect.gen(function* () {
      yield* restBody();
      yield* TestClock.adjust("2 hours");
      const taken: Array<{ cues: Array<{ kind: string; act?: string }> }> = [];
      const wants: Array<unknown> = [];
      const off = onAction((e) => void (e.kind === "body.want" && wants.push([e.subject, e.data])));
      const world = Layer.mergeAll(
        Layer.mock(TessayaTurn)({
          threads: () => Effect.succeed([]),
          whoIsHome: Effect.succeed([]),
        }),
        Layer.mock(TessayaMood)({
          view: () => Effect.succeed({ label: "sleepy", intensity: 0.5, energy: 0.1 } as never),
        }),
        Layer.succeed(PersonaLayers, { all: [openLayer(taken as Array<unknown>)] }),
      );
      expect(yield* wishTick().pipe(Effect.provide(world))).toMatchObject({ want: "rest" });
      expect(taken[0]?.cues.find((c) => c.kind === "act")?.act).toBe("sit");
      // a conversation of his has her body: no wish of her own mixes in
      yield* TestClock.adjust("5 minutes");
      yield* moveBody(
        { act: "wave" },
        { ...her, id: "desktop:wish", thread: "freya|person:owner" },
      ).pipe(Effect.provide(world));
      expect(yield* wishTick().pipe(Effect.provide(world))).toBeNull();
      off();
      expect(wants).toEqual([["rest", { why: "she is tired", route: "body" }]]);
      // a full-screen app in front: she rests out of his way, however she feels
      yield* restBody();
      yield* TestClock.adjust("20 minutes");
      yield* noteDeskWorld({ fullscreen: true });
      const bright = Layer.mergeAll(
        world,
        Layer.mock(TessayaMood)({
          view: () => Effect.succeed({ label: "happy", intensity: 0.5, energy: 0.9 } as never),
        }),
      );
      expect(yield* wishTick().pipe(Effect.provide(bright))).toEqual({
        want: "rest",
        why: "he is in a full-screen app",
      });
      yield* noteDeskWorld({ fullscreen: false });
      // another app comes to the front: she goes to look, at once, not at the next minute
      yield* restBody();
      yield* TestClock.adjust("20 minutes");
      const calm = Layer.mergeAll(
        world,
        Layer.mock(TessayaMood)({
          view: () => Effect.succeed({ label: "neutral", intensity: 0.1, energy: 0.6 } as never),
        }),
      );
      const seen: Array<unknown> = [];
      const watch = onAction((e) => void (e.kind === "body.want" && seen.push(e.subject)));
      yield* noteDeskWorld({ opened: true }).pipe(Effect.provide(calm));
      watch();
      expect(seen).toEqual(["curious"]);
      yield* restBody();
    }),
  );

  it.effect(
    "a persona with her own body in his desktop's crew moves that body, not the lead's",
    () =>
      Effect.gen(function* () {
        yield* restBody();
        const writes: Array<unknown> = [];
        const crew = Layer.succeed(DeviceRegistry)(
          DeviceRegistry.of({
            list: Effect.succeed([
              {
                deviceId: "his",
                online: true,
                items: [{ id: "mascot.do" }, { id: "mascot.do.alfred" }],
              },
            ]),
            write: (deviceId: string, itemId: string, value: unknown) =>
              Effect.sync(() => void writes.push([itemId, value])),
          } as never),
        );
        const alfred: BodyCaller = {
          id: "desktop:alfred",
          kind: "persona",
          mayBePrivate: true,
          persona: "alfred",
          thread: "alfred|person:owner",
        };
        yield* moveBody({ act: "wave" }, alfred).pipe(Effect.provide(crew));
        yield* TestClock.adjust("3 seconds");
        const freya: BodyCaller = {
          ...alfred,
          id: "desktop:freya",
          persona: "freya",
          thread: "freya|person:owner",
          signal: "speak",
        };
        yield* moveBody({ act: "nod" }, freya).pipe(Effect.provide(crew));
        expect(writes).toEqual([
          ["mascot.do.alfred", "wave"],
          ["mascot.do", "nod"],
        ]);
        yield* restBody();
      }),
  );

  it.effect("limits each caller to a burst, then tells it when to try again", () =>
    Effect.gen(function* () {
      // past the last test's hold on her body (body focus), so this agent's thread has it
      yield* TestClock.adjust("3 seconds");
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
        yield* TestClock.adjust("10 seconds");
        const taken: Array<{ cues: Array<{ kind: string }> }> = [];
        const played = yield* playScene(
          "greeting",
          { id: "thread:scene", kind: "agent", mayBePrivate: true },
          false,
        ).pipe(Effect.provideService(PersonaLayers, { all: [openLayer(taken as Array<unknown>)] }));
        expect(played).toMatchObject({ ok: true, route: "body" });
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
        yield* restBody();
        const off = onAction((e) => void (e.kind === "body.felt" && rows.push(e)));
        const live = yield* TurnLiveContext.TurnLiveContext;
        const noted: Array<[unknown, string | null | undefined]> = [];
        const mood = {
          note: (_: unknown, event: unknown, member?: string | null) =>
            Effect.sync(() => void noted.push([event, member])),
        } as unknown as TessayaMood["Service"];
        yield* feel({ vessel: "desktop", part: "head", kind: "pat" }).pipe(
          Effect.provideService(SessionMember, "member-sam"),
          Effect.provideService(TessayaMood, mood),
        );
        // a hard pull on her hair, through the hand frame's own stretch: it hurts, and her reaction says so
        yield* feel({ vessel: "phone", part: "hair", kind: "hold", stretch: 0.95 }).pipe(
          Effect.provideService(SessionMember, "member-sam"),
          Effect.provideService(TessayaMood, mood),
        );
        expect(noted).toEqual([
          [{ kind: "felt", tone: "firm" }, "member-sam"],
          [{ kind: "felt", tone: "hurt" }, "member-sam"],
        ]);
        // an agent's hand through a move is felt the same way, named as the agent
        yield* moveBody({ touch: { part: "arm", motion: "stroke" } }, her).pipe(
          Effect.provideService(PersonaLayers, { all: [openLayer([])] }),
        );
        // a private moment's touch is sealed: recorded, but never in shared context
        yield* feel({ vessel: "window", part: "hand", kind: "hold", private: true });
        off();
        expect(rows.map((r) => [r.actor.kind, r.actor.id, r.data])).toEqual([
          ["member", "member-sam", { vessel: "desktop" }],
          ["member", "member-sam", { vessel: "phone" }],
          ["agent", "desktop:a", { vessel: "window", pressure: 0.4 }],
        ]);
        const onTumble = yield* live.take({ vessel: "tessel-1", persona: null, spend: true });
        expect(onTumble).toMatch(/on his desktop, someone in the household patted your head/);
        // her nerves say what it was like: a slow stroke on hairy skin reaches her caress fibres
        expect(onTumble).toMatch(
          /an agent's hand stroked your arm \(you felt a slow stroke, 5 cm\/s\)/,
        );
        expect(onTumble).not.toMatch(/hand:|held your hand/);
        expect(onTumble).toMatch(/held your hair \(you felt a pull that hurts\)/);
      }).pipe(Effect.provide(TurnLiveContext.layer)),
  );
});
