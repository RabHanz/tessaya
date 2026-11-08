import { assert, it } from "@effect/vitest";
import type { BatonFleet, ClaudeLiveSession } from "@t3tools/baton-contracts";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type AuthMcpClientAccess,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { peerFleets, sharedRun, summariesAcross } from "./BatonSessionsAcross.ts";

const claude = (sessionId: string, pane: string | null): ClaudeLiveSession => ({
  pid: 1,
  sessionId,
  cwd: `/work/${sessionId}`,
  name: sessionId,
  status: "busy",
  entrypoint: "cli",
  herdrPane: pane,
  tmux: null,
  account: null,
  updatedAt: null,
});
const fleetOf = (...sessions: ReadonlyArray<ClaudeLiveSession>): BatonFleet => ({
  entries: [],
  claudeSessions: sessions,
  observedAt: "2026-11-07T00:00:00.000Z",
});
const at = DateTime.makeUnsafe("2026-11-07T00:00:00.000Z");
const link = (
  id: string,
  access: AuthMcpClientAccess,
  status: PeerLinkSummary["status"] = "reachable",
): PeerLinkSummary => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  urls: [`https://${id}.example`],
  access,
  linkedAt: at,
  expiresAt: at,
  lastReachedAt: null,
  lastError: null,
  status,
});

/** Each peer answers with its fleet, fails, or never answers. */
const peers = (answers: Readonly<Record<string, BatonFleet | "fails" | "hangs">>) => {
  const calls: Array<{ environmentId: string; tool: string }> = [];
  const client = PeerMcpClient.PeerMcpClient.of({
    call: (input) => {
      calls.push({ environmentId: input.environmentId, tool: input.tool });
      const answer = answers[input.environmentId];
      if (answer === "hangs") return Effect.never;
      if (answer === undefined || answer === "fails")
        return Effect.fail(
          new OrchestratorMcpFailure({ code: "orchestration_error", message: "unreachable" }),
        );
      return Effect.succeed({ fleet: answer } as never);
    },
  });
  return { calls, client };
};

it.effect(
  "lists this server's and every answering peer's sessions, each tagged with its link's access",
  () =>
    Effect.gen(function* () {
      const fake = peers({
        box: fleetOf(claude("on-box", "s~2")),
        ro: fleetOf(claude("on-ro", null)),
      });
      const found = yield* peerFleets([link("box", "full-access"), link("ro", "read-only")]).pipe(
        Effect.provideService(PeerMcpClient.PeerMcpClient, fake.client),
      );
      assert.deepStrictEqual(
        fake.calls.map((call) => call.tool),
        ["tessaya_fleet", "tessaya_fleet"],
      );
      const sessions = summariesAcross({
        environments: [
          {
            environmentId: EnvironmentId.make("here"),
            label: "laptop",
            fleet: fleetOf(claude("local", "s~1")),
            access: null,
          },
          ...found.listed,
        ],
        projects: [],
        providers: [],
      });
      assert.deepStrictEqual(
        sessions.map((s) => [s.session, s.box, s.access, s.pane?.environmentId ?? null]),
        [
          ["local", "laptop", null, "here"],
          ["on-box", "box", "full-access", "box"],
          ["on-ro", "ro", "read-only", null],
        ],
      );
      assert.deepStrictEqual(found.unreachable, []);
    }),
);

it.effect("reports a peer that fails, times out or has expired, and still lists the others", () =>
  Effect.gen(function* () {
    const fake = peers({ ok: fleetOf(claude("fine", null)), bad: "fails", slow: "hangs" });
    const fiber = yield* peerFleets([
      link("ok", "full-access"),
      link("bad", "full-access"),
      link("slow", "full-access"),
      link("gone", "full-access", "expired"),
    ]).pipe(Effect.provideService(PeerMcpClient.PeerMcpClient, fake.client), Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    const found = yield* Fiber.join(fiber);
    assert.deepStrictEqual(
      found.listed.map((env) => env.environmentId),
      ["ok"],
    );
    assert.deepStrictEqual(found.unreachable.map((env) => env.environmentId).toSorted(), [
      "bad",
      "gone",
      "slow",
    ]);
    // An expired link is not called at all.
    assert.isFalse(fake.calls.some((call) => call.environmentId === "gone"));
  }),
);

it.effect(
  "a listing its caller gave up on still finishes, and the next caller gets that answer",
  () =>
    Effect.gen(function* () {
      let started = 0;
      let finished = 0;
      // The laptop's own fleet took 27-40 s while the desktop's door gave up at 20 s (2026-11-08).
      const slowListing = Effect.sync(() => started++).pipe(
        Effect.andThen(Effect.sleep("30 seconds")),
        Effect.andThen(Effect.sync(() => ++finished)),
      );
      const listing = yield* sharedRun(slowListing, 5_000);
      const caller = yield* Effect.forkChild(listing);
      yield* TestClock.adjust("20 seconds");
      yield* Fiber.interrupt(caller);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(finished, 1);
      assert.strictEqual(yield* listing, 1);
      assert.strictEqual(started, 1);
    }),
);

it.effect("shows a linked server's work under the project and account that server resolved", () =>
  Effect.sync(() => {
    const entry = {
      workSessionId: "w1",
      title: "Fix login",
      projectId: "p1",
      lifecycle: "active",
      state: "running",
      needsUser: false,
      activeThreadId: null,
      threads: [],
      adopted: [],
      synopsis: null,
      updatedAt: "2026-11-07T00:00:00.000Z",
      project: { key: "github.com/x/shop", label: "Shop" },
      account: "Work Max",
    } as unknown as BatonFleet["entries"][number];
    const [row] = summariesAcross({
      environments: [
        {
          environmentId: EnvironmentId.make("box"),
          label: "box",
          fleet: { ...fleetOf(), entries: [entry] },
          access: "full-access",
        },
      ],
      projects: [],
      providers: [],
    });
    assert.deepStrictEqual([row?.project, row?.account], ["Shop", "Work Max"]);
  }),
);
