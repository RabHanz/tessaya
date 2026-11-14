import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { BATON_ON_LIMIT_ENV, make } from "./AccountRotationPolicy.ts";

const start = (env: Record<string, string>) =>
  make.pipe(Effect.provideService(HostProcess.Environment, env));

it.effect("takes the box's env var once, and the setting rules after that", () =>
  Effect.gen(function* () {
    const first = yield* start({ [BATON_ON_LIMIT_ENV]: "auto" });
    assert.strictEqual(yield* first.read, "auto");
    yield* first.set("ask");
    const restarted = yield* start({ [BATON_ON_LIMIT_ENV]: "auto" });
    assert.strictEqual(yield* restarted.read, "ask");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("is off on a machine that never set it", () =>
  Effect.gen(function* () {
    const policy = yield* start({});
    assert.strictEqual(yield* policy.read, "ask");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
