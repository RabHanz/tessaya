// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import type { TessayaEngineShape } from "./TessayaEngine.ts";
import { layerMemory } from "./TessayaDatabase.ts";
import { TessayaWeaveBoxes } from "./TessayaWeaveBoxes.ts";
import { make as makeWeave, WeaveStores } from "./TessayaWeaveService.ts";

import {
  pendingKept,
  resendKept,
  sessionOfThread,
  stampKept,
  type KeptMessage,
} from "./UnboundMessages.ts";

const entry = (id: string, over: Partial<KeptMessage> = {}): KeptMessage => ({
  id,
  at: "2026-11-04T10:00:00Z",
  cwd: "/work",
  sessionId: "baton-unbound-1-2",
  threadId: null,
  text: id,
  ...over,
});

describe("kept unbound messages", () => {
  it("belong to the thread the ledger stamped, wait until claimed, and come back when released", () => {
    const kept = [entry("a"), entry("b"), entry("c", { threadId: "baton-live4:s" })];
    expect(pendingKept(kept, []).map((e) => e.thread)).toEqual([null, null, "baton-live4:s"]);
    const stamped = [
      { id: "a", threadId: "baton-live4:s" },
      { id: "b", state: "claimed" as const },
    ];
    expect(pendingKept(kept, stamped).map((e) => [e.id, e.thread])).toEqual([
      ["a", "baton-live4:s"],
      ["c", "baton-live4:s"],
    ]);
    // A failed resend releases the claim: the message is waiting again, not lost.
    expect(
      pendingKept(kept, [...stamped, { id: "b", state: "released" as const }]).map((e) => e.id),
    ).toEqual(["a", "b", "c"]);
  });
  it("reads the session id from a live thread id", () => {
    expect(sessionOfThread("baton-live4:abc")).toBe("abc");
    expect(sessionOfThread("other")).toBeNull();
  });
});

describe("resending a kept message", () => {
  const THREAD = "baton-live4:s";
  /** The old kept file, taken into the table when the weave service starts; the second line was already claimed. */
  const setup = (sendOk: boolean, active: boolean) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-kept-"));
    NodeFS.writeFileSync(
      NodePath.join(dir, "unbound-messages.ndjson"),
      [
        { id: "m1", at: "t", text: "one", threadId: THREAD },
        { id: "m0", at: "t", text: "already sent", threadId: THREAD },
        { id: "m2", at: "t", text: "two", sessionId: "baton-unbound-1-2" },
      ]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(""),
    );
    NodeFS.writeFileSync(
      NodePath.join(dir, "unbound-ledger.ndjson"),
      `${JSON.stringify({ id: "m0", state: "claimed" })}\n`,
    );
    const sent: string[] = [];
    const engine = {
      threadShell: () => Effect.succeed({ activeRunId: active ? "run" : null }),
      threadShells: Effect.succeed([{ id: THREAD }]),
      activeProviderThread: () =>
        Effect.succeed({ nativeThreadRef: { nativeId: "baton-unbound-1-2" } }),
      sendMessage: (input: { text: string }) => (sent.push(input.text), Effect.succeed(sendOk)),
    } as unknown as TessayaEngineShape;
    return { dir, sent, engine };
  };
  const provide = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          layerMemory,
          Layer.succeed(TessayaWeaveBoxes, []),
          Layer.succeed(WeaveStores, {
            liveQueueDir: () => dir,
            catalogFile: NodePath.join(dir, "none.json"),
          }),
        ),
      ),
    );

  it.effect("waits until the thread is bound, then sends the oldest once, then the next", () =>
    Effect.suspend(() => {
      const { dir, sent, engine } = setup(true, false);
      return provide(
        dir,
        Effect.gen(function* () {
          const weave = yield* makeWeave;
          expect(
            NodeFS.readdirSync(dir).some((n) => n.startsWith("unbound-messages.ndjson.migrated-")),
          ).toBe(true);
          const run = (bound: boolean) => resendKept(engine, weave, { threadId: THREAD, bound });
          yield* run(false);
          expect(sent).toEqual([]);
          yield* stampKept(engine, weave);
          for (let i = 0; i < 4; i += 1) yield* run(true);
          expect(sent).toEqual(["one", "two"]);
          expect(yield* weave.unbound).toEqual([]);
        }),
      );
    }),
  );

  it.effect("keeps a message whose send failed, and waits while a turn is running", () =>
    Effect.suspend(() => {
      const failed = setup(false, false);
      return provide(
        failed.dir,
        Effect.gen(function* () {
          const weave = yield* makeWeave;
          yield* resendKept(failed.engine, weave, { threadId: THREAD, bound: true });
          expect((yield* weave.unbound).map((r) => r.text)).toEqual(["one", "two"]);
          const busy = setup(true, true);
          yield* resendKept(busy.engine, weave, { threadId: THREAD, bound: true });
          expect(busy.sent).toEqual([]);
        }),
      );
    }),
  );
});
