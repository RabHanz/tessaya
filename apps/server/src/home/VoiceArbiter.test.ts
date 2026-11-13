import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import type { VoiceClaimInput } from "@t3tools/baton-contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as BatonDatabaseMemory } from "../baton/BatonDatabase.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { VoiceArbiter, layer as arbiterLayer, serveArbiter } from "./VoiceArbiter.ts";

const layer = arbiterLayer.pipe(Layer.provideMerge(BatonDatabaseMemory));
const claim = (
  deviceId: string,
  loudnessDb: number,
  wakeScore = 0.9,
  answerHere = false,
): VoiceClaimInput => ({
  deviceId,
  loudnessDb,
  wakeScore,
  answerHere,
});

/** Several pretend vessels claim at once; the window closes; each gets its verdict. */
const round = (claims: ReadonlyArray<VoiceClaimInput>) =>
  Effect.gen(function* () {
    const arbiter = yield* VoiceArbiter;
    const fibers = yield* Effect.forEach(claims, (c) =>
      arbiter.claim(c).pipe(Effect.forkChild({ startImmediately: true })),
    );
    yield* TestClock.adjust("250 millis");
    return yield* Effect.forEach(fibers, Fiber.join);
  });

it.effect("two R1s and a desktop hear him at once: exactly one answers, the loudest", () =>
  Effect.gen(function* () {
    const verdicts = yield* round([
      claim("r1-kitchen", -38),
      claim("r1-office", -24),
      claim("desktop-laptop", -31),
    ]);
    assert.deepStrictEqual(
      verdicts.map((v) => v.answer),
      [false, true, false],
    );
    for (const v of verdicts) if (!v.answer) assert.strictEqual(v.winner, "r1-office");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "the others stay quiet while she answers and 2 s after, and the device he just used keeps the next turn",
  () =>
    Effect.gen(function* () {
      const arbiter = yield* VoiceArbiter;
      yield* round([claim("r1-kitchen", -40), claim("desktop-laptop", -20)]);
      const now = yield* Clock.currentTimeMillis;
      yield* arbiter.speaking("desktop-laptop", now + 5_000);
      // Her voice from the desktop wakes the R1: it yields at once, no round.
      const echo = yield* arbiter.claim(claim("r1-kitchen", -15, 1));
      assert.isFalse(echo.answer);
      yield* arbiter.ended("desktop-laptop");
      yield* TestClock.adjust("1 second");
      assert.isFalse((yield* arbiter.claim(claim("r1-kitchen", -15))).answer);
      yield* TestClock.adjust("1500 millis");
      // Quiet over; the desktop answered within 2 minutes, so it keeps him though the R1 is louder now.
      const next = yield* round([claim("r1-kitchen", -10), claim("desktop-laptop", -45)]);
      assert.deepStrictEqual(
        next.map((v) => v.answer),
        [false, true],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("his primary wins over loudness, and 'answer here' overrides once", () =>
  Effect.gen(function* () {
    const arbiter = yield* VoiceArbiter;
    yield* arbiter.setPrimary("r1-kitchen");
    const first = yield* round([claim("r1-kitchen", -50), claim("r1-office", -10)]);
    assert.deepStrictEqual(
      first.map((v) => v.answer),
      [true, false],
    );
    yield* arbiter.ended("r1-kitchen");
    yield* TestClock.adjust("3 seconds");
    const here = yield* round([claim("r1-kitchen", -50), claim("r1-office", -60, 0.5, true)]);
    assert.deepStrictEqual(
      here.map((v) => v.answer),
      [false, true],
    );
    assert.strictEqual((yield* arbiter.state).primary, "r1-kitchen");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "his desktop's server claims on the arbiter of the server with the desk device, and decides itself when none answers",
  () =>
    Effect.gen(function* () {
      const sent: Array<[string, unknown]> = [];
      const peers = (answers: boolean) =>
        Layer.mergeAll(
          Layer.mock(PeerLinks.PeerLinks)({
            enabled: Effect.succeed(true),
            list: Effect.succeed([
              { environmentId: EnvironmentId.make("env-home"), label: "home", status: "reachable" },
            ] as never),
          }),
          Layer.mock(PeerMcpClient.PeerMcpClient)({
            call: (input) =>
              Effect.sync(() => {
                sent.push([input.tool, input.arguments]);
                return answers
                  ? {
                      ok: true,
                      value: { answer: false, round: "r1", winner: "r1-office", until: 9 },
                    }
                  : { ok: false, error: "This server has no voice arbiter." };
              }) as never,
          }),
        );
      const desk = claim("desktop-laptop", -31);
      const forwarded = yield* serveArbiter("claim", desk).pipe(
        Effect.provide(
          arbiterLayer.pipe(
            Layer.provideMerge(peers(true)),
            Layer.provideMerge(BatonDatabaseMemory),
          ),
        ),
      );
      assert.deepStrictEqual(forwarded, {
        ok: true,
        value: { answer: false, round: "r1", winner: "r1-office", until: 9 },
      });
      assert.deepStrictEqual(sent, [
        ["tessaya_voice_arbiter", { op: "claim", args: desk, origin: "another of his servers" }],
      ]);
      // No other server took it: this server's own arbiter answers, as before.
      const fiber = yield* serveArbiter("claim", desk).pipe(
        Effect.provide(
          arbiterLayer.pipe(
            Layer.provideMerge(peers(false)),
            Layer.provideMerge(BatonDatabaseMemory),
          ),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("250 millis");
      assert.deepInclude((yield* Fiber.join(fiber))?.value as object, { answer: true });
    }),
);

it.effect(
  "names the conversation the winner continues: his own for a verified member, else the household's",
  () =>
    Effect.gen(function* () {
      const arbiter = yield* VoiceArbiter;
      const him = { personId: "owner", verified: true };
      const first = yield* round([
        { ...claim("r1-office", -20), speaker: him },
        claim("desktop-laptop", -40),
      ]);
      // Every claimant hears which conversation goes on, so the loser can continue it later.
      assert.deepStrictEqual(
        first.map((v) => v.conversation),
        ["person:owner", "person:owner"],
      );
      // Her voice on the loser while she speaks: still his conversation.
      assert.strictEqual(
        (yield* arbiter.claim(claim("desktop-laptop", -10))).conversation,
        "person:owner",
      );
      yield* arbiter.ended("r1-office");
      yield* TestClock.adjust("3 seconds");
      // An unknown or unverified voice is the household's.
      const next = yield* round([
        { ...claim("r1-office", -20), speaker: { personId: "owner", verified: false } },
      ]);
      assert.strictEqual(next[0]!.conversation, "household");
    }).pipe(Effect.provide(layer)),
);
