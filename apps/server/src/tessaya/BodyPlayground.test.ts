import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import { onAction } from "../provenance/ActionLog.ts";
import {
  movePlayground,
  onPlayground,
  pollBus,
  reportBus,
  resetPlaygroundForTest,
  scenePlayground,
  statePlayground,
  watchBus,
} from "./BodyPlayground.ts";
import { PersonaLayers, type PersonaLayer } from "./PersonaLayers.ts";
import { bodyHolderLine, type BodyCaller } from "./TessayaBody.ts";

const outside: BodyCaller = { id: "client:x", kind: "outside", mayBePrivate: false };
const her: BodyCaller = { id: "desktop:a", kind: "persona", mayBePrivate: true };
const open = (bus: string, owner = "owner") => pollBus({ bus, owner, after: 0, waitMs: 0 });

describe("BodyPlayground", () => {
  it("aims outside agents at the playground and her own turns at her, unless they say", () => {
    expect(onPlayground({}, outside)).toBe(true);
    expect(onPlayground({}, her)).toBe(false);
    expect(onPlayground({ target: "her" }, outside)).toBe(false);
    expect(onPlayground({ target: "playground" }, her)).toBe(true);
  });

  it.effect("puts a move on the playground's bus only: never her body, never body focus", () =>
    Effect.gen(function* () {
      resetPlaygroundForTest();
      const taken: Array<unknown> = [];
      const layer: PersonaLayer = {
        id: "test",
        onTurn: async () => null,
        signal: () => undefined,
        http: async () => ({ status: 404 }),
        body: (m) => (taken.push(m), { ok: true, said: "moved" }),
      };
      const rows: Array<{ kind: string; subject?: string }> = [];
      using _off = { [Symbol.dispose]: onAction((a) => rows.push(a)) };
      yield* open("pg-abcd1");
      const answer = yield* movePlayground({ act: "wave" }, outside).pipe(
        Effect.provideService(PersonaLayers, { all: [layer] }),
      );
      expect(answer).toMatchObject({ ok: true, route: "playground" });
      expect(taken).toEqual([]);
      expect(yield* bodyHolderLine()).toContain("free");
      const got = yield* open("pg-abcd1");
      expect(got.cues.map((c) => c.kind)).toEqual(["act"]);
      expect(rows.find((r) => r.kind === "body.move")?.subject).toBe("pg-abcd1");
    }),
  );

  it.effect("wakes a waiting poll the moment a move arrives", () =>
    Effect.gen(function* () {
      resetPlaygroundForTest();
      const first = yield* open("pg-wait1");
      const waiting = yield* Effect.forkChild(
        pollBus({ bus: "pg-wait1", owner: "owner", after: first.seq, waitMs: 20_000 }),
      );
      yield* movePlayground({ gesture: "nodSmall" }, outside, "pg-wait1");
      const got = yield* Fiber.join(waiting);
      expect(got.cues.length).toBeGreaterThan(0);
    }),
  );

  it.effect("pushes a watched bus's cues as they are published, and nothing between", () =>
    Effect.gen(function* () {
      resetPlaygroundForTest();
      const sent = yield* Queue.unbounded<string>();
      const watching = yield* Effect.forkChild(
        watchBus({ bus: "pg-push1", owner: "owner" }, (t) => Queue.offer(sent, t)),
      );
      expect(JSON.parse(yield* Queue.take(sent))).toMatchObject({ closed: false, cues: [] });
      yield* movePlayground({ act: "nod" }, outside, "pg-push1");
      expect(JSON.parse(yield* Queue.take(sent)).cues).toHaveLength(1);
      expect(yield* Queue.size(sent)).toBe(0);
      yield* Fiber.interrupt(watching);
    }),
  );

  it.effect("keeps each session's bus its own, private moves off it, and its reported state", () =>
    Effect.gen(function* () {
      resetPlaygroundForTest();
      yield* open("pg-mine1");
      expect((yield* open("pg-mine1", "someone-else")).closed).toBe(true);
      expect(reportBus({ bus: "pg-mine1", owner: "someone-else", state: { posture: "x" } })).toBe(
        false,
      );
      expect(reportBus({ bus: "pg-mine1", owner: "owner", state: { posture: "sit" } })).toBe(true);
      expect(statePlayground("pg-mine1")).toMatchObject({
        open: true,
        playground: "pg-mine1",
        body: { posture: "sit" },
      });
      const refused = yield* movePlayground({ posture: "aroused" }, her, "pg-mine1");
      expect(refused).toMatchObject({ ok: false, route: "none" });
      expect((yield* open("pg-mine1")).cues).toEqual([]);
    }),
  );

  it.effect("plays a scene on the bus, and says so when no playground is open", () =>
    Effect.gen(function* () {
      resetPlaygroundForTest();
      expect(yield* movePlayground({ act: "wave" }, outside)).toMatchObject({ ok: false });
      expect(yield* scenePlayground("greeting", outside, true)).toMatchObject({ ok: true });
      yield* open("pg-scene1");
      expect(yield* scenePlayground("greeting", outside, false)).toMatchObject({
        ok: true,
        route: "playground",
      });
      expect((yield* open("pg-scene1")).cues.length).toBeGreaterThan(0);
    }),
  );
});
