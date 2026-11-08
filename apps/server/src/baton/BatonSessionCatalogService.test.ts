import { ThreadId } from "@t3tools/baton-contracts";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BatonEngine, layerStatic } from "./BatonEngine.ts";
import { openResumedThread } from "./BatonSessionCatalogService.ts";

it.effect("a resume brings an archived import thread back into the list", () => {
  const archived = ThreadId.make("import:claudeAgent:old");
  const open = ThreadId.make("import:claudeAgent:open");
  const unarchived: Array<ThreadId> = [];
  const shells = [
    { id: archived, archivedAt: "2026-11-01T10:12:44.299Z" },
    { id: open, archivedAt: null },
  ] as Array<OrchestrationV2ThreadShell>;
  return Effect.gen(function* () {
    const engine = yield* BatonEngine;
    assert.isTrue(yield* openResumedThread(engine, archived));
    assert.isTrue(yield* openResumedThread(engine, open));
    assert.isFalse(yield* openResumedThread(engine, ThreadId.make("import:claudeAgent:none")));
    assert.deepStrictEqual(unarchived, [archived]);
  }).pipe(Effect.provide(layerStatic({ shells, unarchived })));
});
