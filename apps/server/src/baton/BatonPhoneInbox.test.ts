import {
  ASK_LEASE_MS,
  ASK_TTL_MS,
  BAR_ASK_TTL_MS,
  BAR_NOT_CONNECTED,
  CONNECTED_MS,
} from "@t3tools/tessaya-shared/phoneRelay";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonRecordService, layer as BatonRecordLayer } from "./BatonRecordService.ts";
import {
  AskOwner,
  AskSource,
  BatonPhoneInbox,
  layer as inboxLayer,
  phoneCall,
} from "./BatonPhoneInbox.ts";

const layer = it.layer(inboxLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("BatonPhoneInbox", (it) => {
  it.effect(
    "a waiting take is answered the moment an ask arrives, and gives up after its time (13 Nov)",
    () =>
      Effect.gen(function* () {
        const inbox = yield* BatonPhoneInbox;
        while ((yield* inbox.take) !== null);
        const waiting = yield* phoneCall({ op: "take", args: { waitMs: 10_000 } }).pipe(
          Effect.forkChild,
        );
        yield* inbox.post({ id: "client-wait-0001", text: "what is on my screen" });
        const taken = (yield* Fiber.join(waiting)).value as { id: string } | null;
        assert.strictEqual(taken?.id, "client-wait-0001");
        const idle = yield* phoneCall({ op: "take", args: { waitMs: 10_000 } }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("10 seconds");
        assert.isNull((yield* Fiber.join(idle)).value);
      }),
  );

  it.effect("queues in order, marks the source, and a repeat of the same client id asks once", () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      const first = yield* inbox
        .post({ id: "client-aaaa-0001", text: "  what needs me " })
        .pipe(Effect.provideService(AskSource, "phone"));
      assert.isTrue(first.ok);
      if (!first.ok) return;
      assert.strictEqual(first.ask.source, "phone");
      assert.strictEqual(first.ask.text, "what needs me");
      assert.isTrue((yield* inbox.post({ id: "client-aaaa-0001", text: "something else" })).ok);
      assert.strictEqual((yield* inbox.get("client-aaaa-0001"))?.text, "what needs me");
      // Nobody said whose words these are: a device's, never his.
      yield* inbox.post({ id: "client-aaaa-0002", text: "second", origin: "R1" });
      const firstTaken = yield* inbox.take;
      assert.strictEqual(firstTaken?.id, "client-aaaa-0001");
      assert.strictEqual(firstTaken?.origin, "phone");
      const second = yield* inbox.take;
      assert.strictEqual(second?.id, "client-aaaa-0002");
      assert.strictEqual(second?.source, "device");
      // The device he said it to travels with it (his R1 asking his laptop, 13 Nov).
      assert.strictEqual(second?.origin, "R1");
      assert.isNull(yield* inbox.get("web-dddd-0001"));
      // Earlier cases leave asks in the shared queue; taking them counts the desktop as connected.
      while ((yield* inbox.take) !== null);
    }),
  );

  it.effect("refuses an empty, huge or id-less ask in words", () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      assert.deepEqual(yield* inbox.post({ id: "client-bbbb-0001", text: "   " }), {
        ok: false,
        why: "Say something.",
      });
      assert.isFalse((yield* inbox.post({ id: "client-bbbb-0001", text: "x".repeat(2001) })).ok);
      assert.isFalse((yield* inbox.post({ id: "bad id!", text: "hello" })).ok);
    }),
  );

  it.effect("answers only what was taken, once, and the phone reads the answer", () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      yield* inbox.post({ id: "client-cccc-0001", text: "stop the job" });
      assert.isFalse(yield* inbox.answer("client-cccc-0001", "Stopped.", "Stopped the job."));
      yield* inbox.take;
      assert.isTrue(yield* inbox.answer("client-cccc-0001", "Stopped.", "Stopped the job."));
      assert.isFalse(yield* inbox.answer("client-cccc-0001", "again", "again"));
      const got = yield* inbox.get("client-cccc-0001");
      assert.strictEqual(got?.status, "answered");
      assert.strictEqual(got?.card, "Stopped the job.");
    }),
  );

  it.effect(
    "an ask waits while the desktop is away, then expires; a taken one the desktop stops renewing is dropped, never run twice",
    () =>
      Effect.gen(function* () {
        const inbox = yield* BatonPhoneInbox;
        // Earlier tests in this file took asks at clock zero.
        yield* TestClock.adjust(CONNECTED_MS + 1);
        assert.isFalse(yield* inbox.connected);
        yield* inbox.post({ id: "client-dddd-0001", text: "wait for me" });
        yield* TestClock.adjust(ASK_TTL_MS - 1000);
        assert.strictEqual((yield* inbox.get("client-dddd-0001"))?.status, "queued");
        yield* TestClock.adjust(2000);
        assert.strictEqual((yield* inbox.get("client-dddd-0001"))?.status, "expired");
        assert.isNull(yield* inbox.get("web-dddd-0001"));
        // Earlier cases leave asks in the shared queue; taking them counts the desktop as connected.
        while ((yield* inbox.take) !== null);

        yield* inbox.post({ id: "client-dddd-0002", text: "lease" });
        assert.strictEqual((yield* inbox.take)?.id, "client-dddd-0002");
        assert.isTrue(yield* inbox.connected);
        yield* TestClock.adjust(CONNECTED_MS + 1);
        assert.isFalse(yield* inbox.connected);
        // A phone ask keeps its day-long deadline, but a lapsed lease means the desktop left mid-turn.
        yield* TestClock.adjust(ASK_LEASE_MS);
        assert.strictEqual((yield* inbox.get("client-dddd-0002"))?.status, "expired");
        assert.isNull(yield* inbox.take);
      }),
  );

  it.effect(
    "a question the desktop mirrors can be answered once from the phone, and the desktop sees it",
    () =>
      Effect.gen(function* () {
        const inbox = yield* BatonPhoneInbox;
        yield* inbox.mirror({
          id: "prompt-1",
          title: "Run it?",
          detail: "Click Save in Notes",
          buttons: ["Go ahead", "Not now"],
          yes: 0,
          cancel: 1,
        });
        const [shown] = yield* inbox.pending;
        assert.strictEqual(shown?.detail, "Click Save in Notes");
        assert.isNull(yield* inbox.promptAnswer("prompt-1"));
        assert.isFalse(yield* inbox.answerPrompt("prompt-1", 5));
        assert.isTrue(yield* inbox.answerPrompt("prompt-1", 0));
        assert.isFalse(yield* inbox.answerPrompt("prompt-1", 1));
        assert.strictEqual(yield* inbox.promptAnswer("prompt-1"), 0);
        assert.lengthOf(yield* inbox.pending, 0);
      }),
  );

  it.effect(
    "an ask the desktop keeps renewing is neither taken twice nor expired, and is dropped once it stops",
    () =>
      Effect.gen(function* () {
        const inbox = yield* BatonPhoneInbox;
        while ((yield* inbox.take) !== null);
        yield* inbox.post({ id: "long-aaaa-0001", text: "check every job", ttlMs: 60_000 });
        assert.strictEqual((yield* inbox.take)?.id, "long-aaaa-0001");
        for (let minute = 0; minute < 8; minute += 1) {
          yield* TestClock.adjust(60_000);
          yield* inbox.renew("long-aaaa-0001");
        }
        // Earlier cases' asks come back as their leases run out; this one never does while renewed.
        for (let next = yield* inbox.take; next !== null; next = yield* inbox.take)
          assert.notStrictEqual(next.id, "long-aaaa-0001");
        assert.strictEqual((yield* inbox.get("long-aaaa-0001"))?.status, "taken");
        // Once it stops renewing, its deadline passes too: it is dropped, never run a second time.
        yield* TestClock.adjust(ASK_LEASE_MS + 1);
        assert.strictEqual((yield* inbox.get("long-aaaa-0001"))?.status, "expired");
      }),
  );

  it.effect("a mirrored question nobody answers is dropped", () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      yield* inbox.mirror({
        id: "prompt-2",
        title: "t",
        detail: "d",
        buttons: ["a", "b"],
        yes: 0,
        cancel: 1,
      });
      yield* TestClock.adjust(121_000);
      assert.lengthOf(yield* inbox.pending, 0);
      assert.isFalse(yield* inbox.answerPrompt("prompt-2", 0));
      // An answered question is kept for its reader, then deleted: the table does not grow forever.
      yield* inbox.mirror({
        id: "prompt-3",
        title: "t",
        detail: "d",
        buttons: ["a"],
        yes: 0,
        cancel: 0,
      });
      assert.isTrue(yield* inbox.answerPrompt("prompt-3", 0));
      assert.strictEqual(yield* inbox.promptAnswer("prompt-3"), 0);
      yield* TestClock.adjust(241_000);
      yield* inbox.pending;
      assert.isNull(yield* inbox.promptAnswer("prompt-3"));
    }),
  );

  it.effect(
    "keeps up to eight answers for the cloud card and answers the last one by its index",
    () =>
      Effect.gen(function* () {
        const inbox = yield* BatonPhoneInbox;
        const buttons = ["A", "B", "C", "D", "E", "F", "Deny", "Decide later"];
        yield* inbox.mirror({
          id: "prompt-8",
          title: "Cloud task waiting",
          detail: "d",
          buttons,
          yes: 0,
          cancel: 7,
        });
        const [shown] = yield* inbox.pending;
        assert.deepStrictEqual(shown?.buttons, buttons);
        assert.isTrue(yield* inbox.answerPrompt("prompt-8", 7));
        assert.strictEqual(yield* inbox.promptAnswer("prompt-8"), 7);
      }),
  );
  it.effect(
    "only the MCP toolkit asks as an agent, and agents asking together get three in all",
    () =>
      Effect.gen(function* () {
        const inbox = yield* BatonPhoneInbox;
        while ((yield* inbox.take) !== null);
        const ask = (id: string, owner: string | null) =>
          phoneCall({ op: "ask", args: { id, text: "stop job 3", owner: "a1" } }).pipe(
            Effect.provideService(AskOwner, owner),
            Effect.flip,
            Effect.as("refused"),
            Effect.catch((value) => Effect.succeed(value)),
          );
        // A client may not post an agent's id, nor name an owner through its arguments.
        assert.strictEqual(yield* ask("mcp-a1-0001", null), "refused");
        assert.isNull(yield* inbox.get("mcp-a1-0001"));
        // An agent may post only its own ids.
        assert.strictEqual(yield* ask("mcp-a2-0001", "a1"), "refused");

        const results = yield* Effect.forEach(
          ["b1", "b2", "b3", "b4", "b5"],
          (owner) =>
            phoneCall({ op: "ask", args: { id: `mcp-${owner}-0001`, text: "x" } }).pipe(
              Effect.provideService(AskOwner, owner),
            ),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(
          results.filter((r) => (r.value as { ok?: boolean }).ok === true).length,
          3,
        );
      }),
  );

  it.effect(
    "keeps only the named fields of the desktop's account of itself, and refuses an oversized one",
    () =>
      Effect.gen(function* () {
        const inbox = yield* BatonPhoneInbox;
        yield* inbox.take;
        const state = {
          settings: {
            output: "spoken",
            captureApproval: "ask",
            actWithoutAsking: false,
            socialOn: true,
            browserChrome: false,
            remoteHands: false,
            assistantModel: "auto",
            assistantEffort: "auto",
            claudeBinary: "/home/ann/claude",
          },
          voice: {
            enabled: true,
            voice: "anna",
            recognition: "cloud",
            cloudProvider: "openai",
            cloudModel: null,
            cloudApiKey: "sk-live-abc123",
            languages: ["en"],
            wakeWords: ["freya"],
            dictationCleanup: "claude",
          },
          personas: [],
          skills: [],
          diagnostics: {
            appVersion: "1.2.3",
            brain: "opus",
            voiceEngine: "kokoro",
            recognition: "cloud",
            environments: [],
            errors: [],
          },
          vault: ["github-token"],
        };
        yield* phoneCall({ op: "state", args: { state } });
        const got = (yield* phoneCall({ op: "stateGet", args: {} })).value;
        const text = JSON.stringify(got);
        for (const secret of ["sk-live-abc123", "/home/ann/claude", "github-token"])
          assert.notInclude(text, secret);
        assert.include(text, '"recognition":"cloud"');

        const huge = {
          ...state,
          personas: [{ id: "x", name: "x", role: "y".repeat(70_000), lead: false }],
        };
        const refused = yield* phoneCall({ op: "state", args: { state: huge } }).pipe(
          Effect.flip,
          Effect.map((e) => e._tag),
        );
        assert.strictEqual(refused, "BatonPhoneError");
      }),
  );

  it.effect(
    "the web intent bar asks the lead only while a desktop is there, and its ask expires in minutes",
    () =>
      Effect.gen(function* () {
        const inbox = yield* BatonPhoneInbox;
        const ask = (id: string, text: string) => phoneCall({ op: "ask", args: { id, text } });
        // No desktop has asked for work lately: nothing is queued to run later unannounced.
        yield* TestClock.adjust(CONNECTED_MS + 1);
        assert.deepEqual((yield* ask("web-dddd-0001", "plan my week")).value, {
          ok: false,
          line: BAR_NOT_CONNECTED,
        });
        assert.isNull(yield* inbox.get("web-dddd-0001"));
        // Earlier cases leave asks in the shared queue; taking them counts the desktop as connected.
        while ((yield* inbox.take) !== null);

        assert.include((yield* ask("web-dddd-0002", "plan my week")).value, {
          ok: true,
          status: "queued",
        });
        assert.strictEqual((yield* inbox.take)?.id, "web-dddd-0002");
        yield* inbox.answer("web-dddd-0002", "Done.", "Three things this week.");
        assert.deepEqual(
          (yield* phoneCall({ op: "askGet", args: { id: "web-dddd-0002" } })).value,
          {
            status: "answered",
            line: "Three things this week.",
          },
        );

        yield* ask("web-dddd-0003", "and next week");
        yield* TestClock.adjust(BAR_ASK_TTL_MS + 1);
        assert.include((yield* phoneCall({ op: "askGet", args: { id: "web-dddd-0003" } })).value, {
          status: "expired",
        });
        assert.deepEqual((yield* ask("web-dddd-0004", " ")).value, {
          ok: false,
          line: BAR_NOT_CONNECTED,
        });
      }),
  );
});

it.effect(
  "a card's answer names who gave it and how sure, on the card and in the Record (identity I-2)",
  () =>
    Effect.gen(function* () {
      const inbox = yield* BatonPhoneInbox;
      yield* inbox.mirror({
        id: "prompt-who",
        title: "Add Maya as an adult",
        detail: "",
        buttons: ["Yes", "No"],
        yes: 0,
        cancel: 1,
      });
      yield* inbox.answerPrompt("prompt-who", 0, {
        member: "sara",
        name: "Sara",
        assurance: 3,
        via: "her phone",
      });
      const rows = yield* (yield* BatonRecordService).query({ limit: 5 });
      assert.isTrue(
        JSON.stringify(rows).includes("Approved by Sara (A3, her phone)"),
        JSON.stringify(rows).slice(0, 400),
      );
    }).pipe(
      Effect.provide(
        inboxLayer.pipe(
          Layer.provideMerge(BatonRecordLayer),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    ),
);
