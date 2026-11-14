/**
 * Adopting a session Baton did not start, over the real services.
 *
 * The runtime is stubbed — Herdr is another program and is not installed here —
 * and everything else is real: SQLite, the work sessions, and the fleet the
 * adopted session has to appear in.
 */
import {
  WorkSessionId,
  type AdoptedRegisterInput,
  type AdoptedSessionId,
} from "@t3tools/tessaya-contracts";
import { HERDR_CAPABILITIES } from "@t3tools/tessaya-shared/adoptedSession";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import {
  AdoptedRuntimeAdapter,
  AdoptedSessionService,
  layer as adoptedSessionLayer,
} from "./AdoptedSessionService.ts";

const workSessionId = WorkSessionId.make("ws-scheduler");
const sessionId = "herdr:ops:hermes" as AdoptedSessionId;

const adapter = (delivered: boolean) =>
  Layer.succeed(AdoptedRuntimeAdapter, {
    discover: Effect.succeed({
      available: false,
      reason: "herdr is not installed on this environment.",
      candidates: [],
    }),
    sendInput: () =>
      Effect.succeed(
        delivered
          ? { delivered: true, detail: "typed into the pane." }
          : { delivered: false, detail: "herdr is not installed on this environment." },
      ),
    readOutput: () =>
      Effect.succeed({
        available: false,
        detail: "herdr is not installed on this environment.",
        output: "",
      }),
  });

const harness = (delivered = false) =>
  adoptedSessionLayer.pipe(
    Layer.provide(adapter(delivered)),
    Layer.provide(SqlitePersistenceMemory),
  );

const register = (overrides?: Partial<AdoptedRegisterInput>) =>
  Effect.gen(function* () {
    const service = yield* AdoptedSessionService;
    return yield* service.register({
      id: sessionId,
      runtime: "herdr",
      label: "hermes",
      location: { workspace: "ops", pane: "1", host: "harbour" },
      runtimeState: "working",
      workSessionId,
      capabilities: HERDR_CAPABILITIES,
      ...overrides,
    });
  });

describe("adopting a session", () => {
  it.effect("maps the runtime's state by §9's table and keeps its coordinates", () =>
    Effect.gen(function* () {
      const session = yield* register();
      assert.strictEqual(session.state, "working");
      assert.strictEqual(session.location.workspace, "ops");
      assert.strictEqual(session.location.host, "harbour");
      assert.strictEqual(session.workSessionId, workSessionId);
    }).pipe(Effect.provide(harness())),
  );

  it.effect("refuses a state it cannot map rather than calling it idle", () =>
    Effect.gen(function* () {
      // A blocked terminal sorted to the bottom of the fleet is the one wrong
      // state that does real harm, so an unknown word is a refusal.
      const outcome = yield* register({ runtimeState: "compacting" }).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      const service = yield* AdoptedSessionService;
      assert.lengthOf(yield* service.list({}), 0);
    }).pipe(Effect.provide(harness())),
  );

  it.effect("assumes the least when the runtime claims nothing", () =>
    Effect.gen(function* () {
      const service = yield* AdoptedSessionService;
      const session = yield* service.register({
        id: "herdr:ops:plain" as AdoptedSessionId,
        runtime: "herdr",
        label: "a terminal",
        location: { workspace: "ops", pane: "2", host: null },
        runtimeState: "idle",
      });
      // Baton never assumes a capability on a session it did not start.
      assert.isFalse(session.capabilities.sendInput);
      assert.isFalse(session.capabilities.approvals);
      assert.isTrue(session.capabilities.showTerminal);
    }).pipe(Effect.provide(harness())),
  );

  it.effect("registering twice with one id is a retry, not a second terminal", () =>
    Effect.gen(function* () {
      const first = yield* register();
      const second = yield* register({ label: "renamed" });
      assert.strictEqual(second.createdAt, first.createdAt);
      assert.strictEqual(second.label, "hermes");
      const service = yield* AdoptedSessionService;
      assert.lengthOf(yield* service.list({}), 1);
    }).pipe(Effect.provide(harness())),
  );

  it.effect("moves with the runtime's state, and keeps the same row", () =>
    Effect.gen(function* () {
      yield* register();
      const service = yield* AdoptedSessionService;
      const blocked = yield* service.refresh({ id: sessionId, runtimeState: "blocked" });
      // §9's table again: blocked is an answer Baton wants, not an approval
      // it cannot give.
      assert.strictEqual(blocked.state, "needs_input");
      const unknown = yield* service
        .refresh({ id: sessionId, runtimeState: "hibernating" })
        .pipe(Effect.result);
      assert.strictEqual(unknown._tag, "Failure");
      const [current] = yield* service.list({});
      assert.strictEqual(current?.state, "needs_input");
    }).pipe(Effect.provide(harness())),
  );

  it.effect("releasing it does not stop it, and keeps it in the history", () =>
    Effect.gen(function* () {
      yield* register();
      const service = yield* AdoptedSessionService;
      const detached = yield* service.detach(sessionId);
      assert.isNotNull(detached.detachedAt);
      // It was somebody else's terminal before Baton knew about it, and it
      // still is.
      assert.lengthOf(yield* service.list({}), 0);
      assert.lengthOf(yield* service.list({ includeDetached: true }), 1);
    }).pipe(Effect.provide(harness())),
  );
});

describe("what Tessaya may do to it", () => {
  it.effect("refuses to type into a session whose runtime did not claim it", () =>
    Effect.gen(function* () {
      const service = yield* AdoptedSessionService;
      yield* service.register({
        id: "herdr:ops:plain" as AdoptedSessionId,
        runtime: "herdr",
        label: "a terminal",
        location: { workspace: "ops", pane: "2", host: null },
        runtimeState: "idle",
      });
      const outcome = yield* service
        .sendInput({ id: "herdr:ops:plain" as AdoptedSessionId, text: "hello" })
        .pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
    }).pipe(Effect.provide(harness(true))),
  );

  it.effect("passes the runtime's own refusal through rather than claiming success", () =>
    Effect.gen(function* () {
      yield* register();
      const service = yield* AdoptedSessionService;
      const result = yield* service.sendInput({ id: sessionId, text: "hello" });
      assert.isFalse(result.delivered);
      assert.include(result.detail, "herdr is not installed");
    }).pipe(Effect.provide(harness())),
  );

  it.effect("refuses to type into a session that was released", () =>
    Effect.gen(function* () {
      yield* register();
      const service = yield* AdoptedSessionService;
      yield* service.detach(sessionId);
      const outcome = yield* service
        .sendInput({ id: sessionId, text: "hello" })
        .pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
    }).pipe(Effect.provide(harness(true))),
  );

  it.effect("says the runtime is missing by name, not by an empty list", () =>
    Effect.gen(function* () {
      const service = yield* AdoptedSessionService;
      const discovered = yield* service.discover;
      // "No sessions" and "no Herdr" are different facts with different fixes.
      assert.isFalse(discovered.available);
      assert.include(discovered.reason, "herdr is not installed");
      assert.lengthOf(discovered.candidates, 0);
    }).pipe(Effect.provide(harness())),
  );
});
