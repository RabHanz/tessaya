import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { serveLearnCall } from "./TessayaLearn.ts";

const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-learn-" }).pipe(
  Layer.provide(NodeServices.layer),
);

describe("BatonLearn", () => {
  it.effect("keeps one progress for every device, and refuses what it does not know", () =>
    Effect.gen(function* () {
      yield* serveLearnCall({ kind: "act", op: "use", args: { place: "snippets" } });
      yield* serveLearnCall({ kind: "act", op: "seen", args: { id: "wake", at: 7 } });
      const read = yield* serveLearnCall({ kind: "read", op: "get" });
      expect(read.value).toMatchObject({ used: ["snippets"], seen: { wake: 1 }, lastTipAt: 7 });
      expect((yield* serveLearnCall({ kind: "read", op: "drop" })).ok).toBe(false);
      const odd = yield* serveLearnCall({ kind: "act", op: "use", args: { place: 42 } });
      expect(odd.value).toMatchObject({ used: ["snippets"] });
    }).pipe(Effect.provide(config)),
  );
});
