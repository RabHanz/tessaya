import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { FeedbackMode } from "@t3tools/tessaya-contracts";
import {
  toEnvelope,
  type ActionEnvelope,
  type ActionInput,
} from "@t3tools/tessaya-shared/provenance";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ActionLog, emitActionSync } from "../provenance/ActionLog.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProblemReports, layer } from "./ProblemReports.ts";
import * as TessayaDatabase from "./TessayaDatabase.ts";

const SECRET = "my bank pin is 4471";
let n = 0;
const ev = (input: ActionInput & { at: number }): ActionEnvelope =>
  toEnvelope(input, { id: `e${++n}`, at: input.at, origin: "env-a", cause: [] });
const verdict = (vessel: string, at: number) =>
  ev({
    kind: "room.voice_id",
    actor: { kind: "owner", id: "owner", certainty: 0.95 },
    outcome: "owner",
    data: { vessel, asrMs: 900, text: SECRET },
    at,
  });

/** The service over an in-memory database, the owner's setting, and a log holding `events`. */
const stack = (mode: FeedbackMode, events: ReadonlyArray<ActionEnvelope>) =>
  layer.pipe(
    Layer.provide(
      Layer.mock(ActionLog)({
        list: (q) =>
          Effect.succeed(
            events.filter(
              (e) =>
                (q.kindPrefix === undefined || e.kind.startsWith(q.kindPrefix)) &&
                (q.outcome === undefined || e.outcome === q.outcome),
            ),
          ),
        trace: (id) => Effect.succeed(events.filter((e) => e.id === id)),
      }),
    ),
    Layer.provide(ServerSettingsService.layerTest({ tessayaFeedback: mode })),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-reports-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(TessayaDatabase.layerMemory),
  );

const asked = {
  source: "asked" as const,
  symptom: "she answered twice on Tumble",
  guess: "two voice loops may be running",
  vessel: "t1",
  by: { kind: "owner" as const, id: "owner" },
};

describe("problem reports", () => {
  it.effect("on request: a report with the turn's evidence and none of his words, once", () =>
    Effect.gen(function* () {
      const reports = yield* ProblemReports;
      const out = yield* reports.file(asked);
      assert.match(out.say, /report on she answered twice on Tumble/);
      const report = yield* reports.get(out.id!);
      assert.strictEqual(report?.status, "open");
      assert.deepStrictEqual(
        report?.bundle?.events.map((e) => e.data?.["asrMs"]),
        [900],
      );
      assert.notInclude(JSON.stringify(report), "4471");
      // Asking about the same thing again is the same report.
      assert.strictEqual((yield* reports.file(asked)).id, null);
    }).pipe(Effect.provide(stack("silent", [verdict("t1", 0)]))),
  );

  it.effect("off sends nothing, even when asked", () =>
    Effect.gen(function* () {
      const reports = yield* ProblemReports;
      assert.strictEqual((yield* reports.file(asked)).id, null);
      assert.strictEqual(yield* reports.triage, 0);
      assert.deepStrictEqual(yield* reports.list({}), []);
    }).pipe(Effect.provide(stack("off", [verdict("t1", 0), verdict("t1", 800)]))),
  );

  it.effect(
    "a real fault (two loops answering one Tessel) is one report she sends herself, and in developer mode one line to say",
    () =>
      Effect.gen(function* () {
        const reports = yield* ProblemReports;
        // This machine's own health is read too, so the test counts the double answer's report only.
        yield* reports.triage;
        yield* reports.triage;
        const doubles = (yield* reports.list({})).filter((r) => r.key.startsWith("double_turn"));
        assert.strictEqual(doubles.length, 1);
        const report = doubles[0];
        assert.strictEqual(report?.source, "proactive");
        assert.strictEqual(report?.bundle?.vessel, "t1");
        const lines = (yield* reports.toAnnounce).filter((l) => l.id === `report:${report?.id}`);
        assert.strictEqual(lines.length, 1);
        assert.include(
          lines[0]!.text,
          "I've sent the developers a report on the double answer on t1",
        );
        assert.notInclude(JSON.stringify(report), "4471");
      }).pipe(Effect.provide(stack("developer", [verdict("t1", 0), verdict("t1", 800)]))),
  );

  it.effect("silent mode sends the report but never says so", () =>
    Effect.gen(function* () {
      const reports = yield* ProblemReports;
      yield* reports.triage;
      assert.isTrue((yield* reports.list({})).some((r) => r.key.startsWith("double_turn")));
      assert.deepStrictEqual(yield* reports.toAnnounce, []);
    }).pipe(Effect.provide(stack("silent", [verdict("t1", 0), verdict("t1", 800)]))),
  );

  it.effect(
    "withdraw keeps it listed; delete drops its bundle and the delete reaches a peer's pull",
    () =>
      Effect.gen(function* () {
        const reports = yield* ProblemReports;
        const { id } = yield* reports.file(asked);
        const withdrawn = yield* reports.call("withdraw", id!);
        assert.strictEqual(withdrawn.reports[0]?.status, "withdrawn");
        const deleted = yield* reports.call("delete", id!);
        assert.deepStrictEqual(deleted.reports, []);
        const pulled = yield* reports.syncSince(0);
        assert.deepStrictEqual(
          pulled.reports.map((r) => [r.status, r.bundle]),
          [["deleted", null]],
        );
      }).pipe(Effect.provide(stack("silent", []))),
  );

  it.effect(
    "the developer feed carries each vessel's events, redacted, and only in developer mode",
    () =>
      Effect.gen(function* () {
        const reports = yield* ProblemReports;
        emitActionSync({
          kind: "room.voice_id",
          actor: { kind: "owner", certainty: 1 },
          data: { vessel: "t1", asrMs: 700, text: SECRET },
        });
        emitActionSync({
          kind: "room.wake",
          actor: { kind: "owner", certainty: 1 },
          private: true,
        });
        emitActionSync({ kind: "rpc.call", actor: { kind: "owner", certainty: 1 } });
        const feed = yield* reports.feed({});
        assert.isTrue(feed.on);
        assert.deepStrictEqual(
          feed.events.map((e) => [e.kind, e.vessel, e.data]),
          [["room.voice_id", "t1", { vessel: "t1", asrMs: 700 }]],
        );
        assert.deepStrictEqual((yield* reports.feed({ after: feed.next })).events, []);
      }).pipe(Effect.provide(stack("developer", []))),
  );

  it.effect("the feed is off outside developer mode", () =>
    Effect.gen(function* () {
      const reports = yield* ProblemReports;
      emitActionSync({ kind: "room.wake", actor: { kind: "device", id: "t1", certainty: 1 } });
      assert.deepStrictEqual(yield* reports.feed({}), { on: false, events: [], next: 0 });
    }).pipe(Effect.provide(stack("silent", []))),
  );
});
