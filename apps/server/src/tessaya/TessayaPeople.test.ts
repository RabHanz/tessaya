import { assert, describe, it } from "@effect/vitest";
import { vectorToBase64 } from "@t3tools/tessaya-voice/speakerStore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as TessayaDatabaseMemory } from "./TessayaDatabase.ts";
import { layer as memoryLayer, TessayaMemoryService } from "./TessayaMemoryService.ts";
import { make, type PeopleCaller, TessayaPeople } from "./TessayaPeople.ts";
import { layer as presenceLayer, peopleHere } from "./TessayaPresence.ts";

const DIM = 16;
const basis = (i: number) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};
/** A clip of the voice `a` at cosine `score` to it, leaning along `axis`. */
const clip = (a: Float32Array, score: number, axis: number) => {
  const orth = basis(axis).map((x, i) => x - a[axis]! * a[i]!);
  const n = Math.hypot(...orth);
  return a.map((x, i) => score * x + Math.sqrt(1 - score * score) * (orth[i]! / n));
};
const ALI = basis(0);
const SARA = basis(5);
const print = (v: Float32Array, ms = 3_000) => ({ model: "m1", vector: vectorToBase64(v), ms });

const OWNER: PeopleCaller = { role: "owner", assurance: 2 };
const ADMIN: PeopleCaller = { role: "admin", assurance: 2 };
const ADULT: PeopleCaller = { role: "adult", assurance: 2 };
const GUEST: PeopleCaller = { role: null, assurance: 0 };

const peopleLayer = Layer.effect(TessayaPeople, make).pipe(
  Layer.provideMerge(presenceLayer),
  Layer.provideMerge(memoryLayer),
  Layer.provideMerge(TessayaDatabaseMemory),
);

const hear = (vessel: string, v: Float32Array, said: string) =>
  Effect.flatMap(TessayaPeople, (p) =>
    p.call({ op: "peopleObserve", vessel, said, print: print(v) }, GUEST),
  ).pipe(Effect.map((r) => r.person!));
const call = (input: Parameters<TessayaPeople["Service"]["call"]>[0], caller = GUEST) =>
  Effect.flatMap(TessayaPeople, (p) => p.call(input, caller));

describe("TessayaPeople", () => {
  it.layer(peopleLayer)("people graph", (it) => {
    it.effect(
      "files a stranger across vessels, binds their name and loads their context next time",
      () =>
        Effect.gen(function* () {
          const first = yield* hear("tessel-1", clip(ALI, 0.8, 1), "Hello, is the owner around?");
          assert.strictEqual(first.name, null);
          assert.include(first.line, "What's your name?");
          const met = yield* call({ op: "peopleIntroduce", vessel: "tessel-1", name: "ali" });
          assert.strictEqual(met.status, "done");
          assert.include(met.line, "Ali");
          // Another session, another vessel: the same voice is Ali, with what was said last time.
          const again = yield* hear("desk", clip(ALI, 0.7, 2), "I'm back");
          assert.strictEqual(again.id, first.id);
          assert.isTrue(again.recognised);
          assert.include(again.line, "it is Ali");
          assert.include(again.line, "is the owner around?");
          const sara = yield* hear("desk", SARA, "Hi");
          assert.notStrictEqual(sara.id, first.id);
          // A short clip is too unsure to file, and a member's voice is never a stranger.
          assert.isNull(
            (yield* call({
              op: "peopleObserve",
              vessel: "desk",
              said: "x",
              print: print(SARA, 1_200),
            })).person,
          );
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
          INSERT INTO tessaya_voice_profiles (member_id, model, name, kind, centroid, samples, sources_json,
            enrolled_at, version, updated_at)
          VALUES ('owner', 'm1', 'Owner', 'owner', ${vectorToBase64(basis(9))}, 5, '[]', 'x', 1, 'x')
        `;
          assert.isNull(
            (yield* call({
              op: "peopleObserve",
              vessel: "desk",
              said: "x",
              print: print(clip(basis(9), 0.5, 3)),
            })).person,
          );
        }),
    );

    it.effect("tells each person only what is theirs to hear", () =>
      Effect.gen(function* () {
        yield* hear("tessel-1", clip(ALI, 0.75, 3), "My surprise for Sara is a trip to Hunza");
        // A voice that only claims the name hears nothing of Ali's.
        yield* hear("tessel-1", SARA, "hello");
        const claim = yield* call({ op: "peopleIntroduce", vessel: "tessel-1", name: "Ali" });
        assert.isFalse(claim.person!.recognised);
        assert.notInclude(claim.person!.line, "Hunza");
        assert.strictEqual(
          (yield* call({ op: "peopleWho", name: "Ali", vessel: "tessel-1" })).status,
          "refused",
        );
        // A member hears who Ali is, never what Ali said; the owner hears it all; Ali hears their own.
        const member = yield* call({ op: "peopleWho", name: "Ali" }, ADULT);
        assert.strictEqual(member.status, "done");
        assert.notInclude(member.line, "Hunza");
        assert.include((yield* call({ op: "peopleWho", name: "Ali" }, OWNER)).line, "Hunza");
        yield* hear("tessel-2", clip(ALI, 0.75, 4), "what did we talk about?");
        assert.include(
          (yield* call({ op: "peopleWho", name: "Ali", vessel: "tessel-2" })).line,
          "Hunza",
        );
        assert.strictEqual((yield* call({ op: "peopleList" }, ADULT)).status, "refused");
      }),
    );
  });

  it.layer(peopleLayer)("owner changes", (it) => {
    it.effect("merge, not-same, split, name with a relation, and the household's own facts", () =>
      Effect.gen(function* () {
        const a = yield* hear("tessel-1", ALI, "first");
        // Between the listen and join cut-offs: someone new, put to the owner as maybe the same.
        const b = yield* hear("tessel-1", clip(ALI, 0.4, 7), "second");
        assert.notStrictEqual(a.id, b.id);
        const listed = yield* call({ op: "peopleList" }, OWNER);
        const same = listed.suggestions!.find((s) => s.kind === "same")!;
        assert.sameMembers([same.id, same.other], [a.id, b.id]);
        assert.strictEqual(listed.retentionDays, 0);
        yield* call({ op: "peopleManage", action: "notSame", id: a.id, into: b.id }, OWNER);
        assert.isUndefined(
          (yield* call({ op: "peopleList" }, OWNER)).suggestions!.find((s) => s.kind === "same"),
        );
        assert.strictEqual(
          (yield* call({ op: "peopleManage", action: "merge", id: b.id, into: a.id }, ADMIN))
            .status,
          "refused",
        );
        assert.strictEqual(
          (yield* call(
            { op: "peopleManage", action: "merge", id: b.id, into: a.id },
            { role: "owner", assurance: 1 },
          )).status,
          "refused",
        );
        yield* call({ op: "peopleManage", action: "merge", id: b.id, into: a.id }, OWNER);
        assert.lengthOf((yield* call({ op: "peopleList" }, OWNER)).people!, 1);
        // Two people filed as one: split on their clips.
        for (const [i, v] of [clip(ALI, 0.9, 2), clip(ALI, 0.9, 3)].entries())
          yield* hear("tessel-1", v, `ali ${i}`);
        const split = yield* call({ op: "peopleManage", action: "split", id: a.id }, ADMIN);
        assert.strictEqual(split.status, "done");
        assert.lengthOf((yield* call({ op: "peopleList" }, OWNER)).people!, 2);
        // "Remember that's my cousin Ali": the last voice named, saved, and how he knows them.
        yield* TestClock.adjust("1 second");
        const again = yield* hear("tessel-1", ALI, "hi again");
        // A guest counts as present where they were heard (B-043).
        assert.deepInclude((yield* peopleHere("tessel-1"))[0], { member: again.id, guest: true });
        const named = yield* call(
          {
            op: "peopleManage",
            action: "name",
            id: "last",
            vessel: "tessel-1",
            name: "Ali",
            relation: "my cousin",
          },
          OWNER,
        );
        assert.include(named.line, "your cousin");
        const ali = (yield* call({ op: "peopleList" }, OWNER)).people!.find(
          (p) => p.name === "Ali",
        )!;
        assert.isNull(ali.keepUntil);
        assert.deepInclude(ali.relations, { text: "the owner's cousin", why: null });
        // His own words draw edges too: who was at the party.
        const memory = yield* TessayaMemoryService;
        yield* memory.add({
          kind: "fact",
          text: "Sara was at the birthday party.",
          source: "user",
        });
        assert.include((yield* call({ op: "peopleWho", event: "the party" }, ADULT)).line, "Sara");
        assert.strictEqual((yield* call({ op: "peopleWho", event: "party" })).status, "refused");
      }),
    );
  });

  it.layer(peopleLayer)("retention", (it) => {
    it.effect(
      "keeps everyone by default; an owner's expiry forgets only unnamed voices; forget me works",
      () =>
        Effect.gen(function* () {
          const sweep = Effect.flatMap(TessayaPeople, (p) => p.sweep);
          const kept = yield* hear("tessel-1", basis(11), "nobody named me");
          yield* TestClock.adjust("400 days");
          assert.strictEqual(yield* sweep, 0);
          assert.strictEqual(
            (yield* call({ op: "peopleManage", action: "retention", days: 30 }, ADMIN)).status,
            "done",
          );
          // Forgetting is said back first and needs his yes; then it goes to the bin, never straight away.
          const ask = yield* call({ op: "peopleManage", action: "forget", id: kept.id }, OWNER);
          assert.strictEqual(ask.status, "asked");
          assert.include(ask.line, "1 thing they said");
          assert.lengthOf((yield* call({ op: "peopleList" }, OWNER)).people!, 1);
          yield* call(
            { op: "peopleManage", action: "forget", id: kept.id, confirmed: true },
            OWNER,
          );
          const bin = yield* call({ op: "peopleList" }, OWNER);
          assert.deepStrictEqual([bin.people!.length, bin.forgotten![0]?.by], [0, "owner"]);
          yield* call({ op: "peopleManage", action: "restore", id: kept.id }, ADMIN);
          assert.lengthOf((yield* call({ op: "peopleList" }, OWNER)).people!, 1);
          const stranger = yield* hear("tessel-1", ALI, "just passing");
          yield* hear("tessel-1", SARA, "I'm Sara");
          // Named, however briefly: remembered, whatever the expiry.
          yield* call({ op: "peopleIntroduce", vessel: "tessel-1", name: "Sara" });
          yield* TestClock.adjust("31 days");
          assert.strictEqual(yield* sweep, 1);
          const left = yield* call({ op: "peopleList" }, OWNER);
          assert.sameMembers(
            left.people!.map((p) => p.name),
            ["Sara", null],
          );
          assert.deepStrictEqual(
            left.forgotten!.map((f) => [f.id, f.by]),
            [[stranger.id, "expiry"]],
          );
          // The bin keeps them 30 days, then they go for good.
          yield* TestClock.adjust("31 days");
          yield* sweep;
          const sql = yield* SqlClient.SqlClient;
          assert.lengthOf(
            yield* sql`SELECT * FROM fabric_memory_sightings WHERE entity_id = ${stranger.id}`,
            0,
          );
          // "Forget me", in Sara's own voice: said back, then her yes; the owner sees she asked.
          yield* hear("tessel-1", clip(SARA, 0.8, 2), "please forget me");
          assert.strictEqual(
            (yield* call({ op: "peopleForgetMe", vessel: "tessel-1" })).status,
            "asked",
          );
          assert.strictEqual(
            (yield* call({ op: "peopleForgetMe", vessel: "tessel-1", confirmed: true })).status,
            "done",
          );
          const after = yield* call({ op: "peopleList" }, OWNER);
          assert.notInclude(
            after.people!.map((p) => p.name),
            "Sara",
          );
          assert.include(
            after.forgotten!.map((f) => f.by),
            "themselves",
          );
          // Deleting for good is the owner's alone.
          assert.strictEqual(
            (yield* call({ op: "peopleManage", action: "purge" }, ADMIN)).status,
            "refused",
          );
          yield* call({ op: "peopleManage", action: "purge" }, OWNER);
          assert.lengthOf((yield* call({ op: "peopleList" }, OWNER)).forgotten!, 0);
        }),
    );
  });
});
