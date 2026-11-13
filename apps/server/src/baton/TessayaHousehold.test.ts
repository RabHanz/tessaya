import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { memberSubject } from "@t3tools/baton-shared/household";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { layerMemory as BatonDatabaseMemory } from "./BatonDatabase.ts";
import { BatonPhoneInbox } from "./BatonPhoneInbox.ts";
import {
  BatonPrivateMemoryService,
  PrivateCaller,
  PrivateKdf,
  layer as privateLayer,
} from "./BatonPrivateMemoryService.ts";
import { HouseholdCaller, TessayaHousehold, layer as householdLayer } from "./TessayaHousehold.ts";
import { VoiceForgets } from "./VoiceForgets.ts";
import { layer as MemberPreferencesLayer } from "./MemberPreferences.ts";

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-household-test-" })),
);
const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
  getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes).fill(7)),
});
/** The owner's approving device: it answers every ask with `answer` (0 is yes). */
const approver = (answer: number | null) =>
  Layer.mock(BatonPhoneInbox)({
    mirror: () => Effect.void,
    promptAnswer: () => Effect.succeed(answer),
  });
const stackWith = (answer: number | null) =>
  householdLayer.pipe(
    Layer.provideMerge(privateLayer),
    Layer.provideMerge(approver(answer)),
    Layer.provideMerge(MemberPreferencesLayer),
    Layer.provide(secrets),
    Layer.provideMerge(Layer.succeed(PrivateKdf, { N: 2 ** 10, r: 8, p: 1 })),
    Layer.provideMerge(BatonDatabaseMemory),
    Layer.provideMerge(authLayer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
  );

/** The owner at his desktop (A3), Sara's own phone (A2), and voices. */
const owner = { member: "owner", assurance: 3, via: "the desktop" } as const;
const as =
  (caller: typeof HouseholdCaller.defaultValue extends () => infer C ? C : never) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, HouseholdCaller, caller);
const call = (input: Parameters<TessayaHousehold["Service"]["call"]>[0]) =>
  Effect.flatMap(TessayaHousehold, (h) => h.call(input));

const metadata = { deviceType: "mobile" as const, os: "iOS", browser: "Safari" };
/** Redeems a pairing code as a phone would, returning the session it bought. */
const redeem = (code: string) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const exchange = yield* auth.createBrowserSession(code, metadata);
    return yield* auth.authenticateHttpRequest({
      cookies: { [sessions.cookieName]: exchange.sessionToken },
      headers: {},
    } as unknown as Parameters<
      EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
    >[0]);
  });

const test = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it.effect(name, body);
const run = <A, E>(
  answer: number | null,
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof stackWith>>>,
) => Effect.provide(effect, stackWith(answer));

describe("TessayaHousehold", () => {
  test("starts with the owner, under the id his voice and store use", () =>
    run(
      null,
      Effect.gen(function* () {
        const h = yield* TessayaHousehold;
        assert.strictEqual(yield* h.roleOf("owner"), "owner");
        const listed = yield* as(owner)(call({ op: "list" }));
        assert.deepStrictEqual(
          listed.members?.map((m) => [m.id, m.role, m.you]),
          [["owner", "owner", true]],
        );
      }),
    ));

  test("an invite pairs one device for that member, capped at the role's scopes, never T3's", () =>
    run(
      null,
      Effect.gen(function* () {
        const invited = yield* as(owner)(call({ op: "invite", name: "Sara", role: "adult" }));
        assert.strictEqual(invited.status, "done");
        const sara = (yield* as(owner)(call({ op: "list" }))).members!.find(
          (m) => m.name === "Sara",
        )!;
        assert.strictEqual(sara.state, "invited");
        assert.strictEqual(sara.inviteCode, invited.code);
        const session = yield* redeem(invited.code!);
        assert.strictEqual(session.subject, memberSubject(sara.id));
        assert.deepStrictEqual([...session.scopes], ["tessaya:member"]);
        for (const scope of AuthStandardClientScopes) assert.notInclude([...session.scopes], scope);
        const after = (yield* as(owner)(call({ op: "list" }))).members!.find(
          (m) => m.id === sara.id,
        )!;
        assert.deepStrictEqual([after.state, after.devices, after.inviteCode], ["active", 1, null]);
        // Sara sees the members, but no one's codes or birth dates.
        const hers = yield* as({ member: sara.id, assurance: 2, via: "her phone" })(
          call({ op: "list" }),
        );
        assert.isTrue(hers.members!.every((m) => m.inviteCode === null));
      }),
    ));

  test("roles bound who manages whom, and guests and strangers see nothing", () =>
    run(
      null,
      Effect.gen(function* () {
        const sara = (yield* as(owner)(call({ op: "invite", name: "Sara", role: "admin" }))).status;
        assert.strictEqual(sara, "done");
        const members = (yield* as(owner)(call({ op: "list" }))).members!;
        const saraId = members.find((m) => m.name === "Sara")!.id;
        const omar = yield* as(owner)(call({ op: "invite", name: "Omar", role: "adult" }));
        const omarId = (yield* as(owner)(call({ op: "list" }))).members!.find(
          (m) => m.name === "Omar",
        )!.id;
        const asSara = as({ member: saraId, assurance: 3, via: "her phone" });
        const asOmar = as({ member: omarId, assurance: 3, via: "his phone" });
        assert.strictEqual(omar.status, "done");
        const lines = [
          (yield* asOmar(call({ op: "invite", name: "Ali", role: "adult" }))).line,
          (yield* asSara(call({ op: "invite", name: "Ali", role: "admin" }))).line,
          (yield* asSara(call({ op: "remove", id: "owner" }))).line,
          (yield* asSara(call({ op: "machine", id: omarId, on: true }))).line,
          (yield* as({ member: null, assurance: 0, via: "a voice" })(call({ op: "list" }))).line,
          (yield* as({ member: "owner", service: true, assurance: 2, via: "an agent" })(
            call({ op: "invite", name: "Ali", role: "adult" }),
          )).line,
        ];
        assert.deepStrictEqual(lines, [
          "Only the owner or an admin manages members.",
          "Only the owner makes someone an admin.",
          "Nobody can remove the owner.",
          "Only the owner gives or takes this computer.",
          "Only members of this home can see that.",
          "Only the owner or an admin manages members.",
        ]);
        // An admin manages adults.
        assert.strictEqual(
          (yield* asSara(call({ op: "setRole", id: omarId, role: "child" }))).status,
          "done",
        );
        // A turn that read outside content never changes members, whoever it speaks for.
        const tainted = yield* as({ ...owner, tainted: true })(call({ op: "remove", id: omarId }));
        assert.strictEqual(tainted.status, "refused");
      }),
    ));

  test("below A3, an admin act waits for the owner's yes and happens only on it", () =>
    Effect.gen(function* () {
      const voice = { member: "owner", assurance: 2, via: "Tessaya via R1" } as const;
      const yes = yield* run(
        0,
        Effect.gen(function* () {
          const asked = yield* as(voice)(call({ op: "invite", name: "Maya", role: "child" }));
          yield* TestClock.adjust("3 seconds");
          return [
            asked.status,
            (yield* as(owner)(call({ op: "list" }))).members!.map((m) => m.name),
          ];
        }),
      );
      assert.deepStrictEqual(yes, ["asked", ["Owner", "Maya"]]);
      const no = yield* run(
        1,
        Effect.gen(function* () {
          yield* as(voice)(call({ op: "invite", name: "Maya", role: "child" }));
          yield* TestClock.adjust("3 seconds");
          return (yield* as(owner)(call({ op: "list" }))).members!.map((m) => m.name);
        }),
      );
      assert.deepStrictEqual(no, ["Owner"]);
    }));

  test("removing signs out every device at once, keeps the data 7 days for export, then destroys it; restore undoes", () =>
    run(
      null,
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const stores = yield* BatonPrivateMemoryService;
        const invited = yield* as(owner)(call({ op: "invite", name: "Sara", role: "adult" }));
        const id = (yield* as(owner)(call({ op: "list" }))).members!.find(
          (m) => m.name === "Sara",
        )!.id;
        yield* redeem(invited.code!);
        const second = yield* as({ member: id, assurance: 2, via: "her phone" })(
          call({ op: "pair", id }),
        );
        yield* redeem(second.code!);
        const desk = { session: "desk", desktop: true } as const;
        yield* Effect.provideService(
          stores.setup({ name: "Owner", pin: "27182818" }),
          PrivateCaller,
          desk,
        );
        yield* Effect.provideService(
          stores.setup({ personId: id, name: "Sara", pin: "314159" }),
          PrivateCaller,
          desk,
        );
        const pending = yield* as(owner)(call({ op: "pair", id }));
        assert.strictEqual(pending.status, "done");

        const removed = yield* as(owner)(call({ op: "remove", id }));
        assert.include(removed.line, "signed out everywhere");
        const live = (yield* auth.listSessions()).filter((s) => s.subject === memberSubject(id));
        assert.lengthOf(live, 0);
        assert.isFalse(
          (yield* auth.listPairingLinks()).some((l) => l.subject === memberSubject(id)),
        );
        const leaving = (yield* as(owner)(call({ op: "list" }))).members!.find((m) => m.id === id)!;
        assert.strictEqual(leaving.state, "leaving");
        assert.strictEqual(yield* (yield* TessayaHousehold).roleOf(id), null);

        // Restore within the window keeps her data; a second removal then runs out the window.
        assert.strictEqual((yield* as(owner)(call({ op: "restore", id }))).status, "done");
        yield* as(owner)(call({ op: "remove", id }));
        yield* TestClock.adjust("6 days");
        assert.strictEqual(yield* (yield* TessayaHousehold).purgeDue, 0);
        assert.isTrue((yield* stores.people).some((s) => s.personId === id));
        yield* TestClock.adjust("2 days");
        yield* (yield* TessayaHousehold).purgeDue;
        assert.isFalse((yield* stores.people).some((s) => s.personId === id));
        assert.isFalse((yield* as(owner)(call({ op: "list" }))).members!.some((m) => m.id === id));
      }),
    ));

  test("a narrower role or a withdrawn machine grant signs out the devices that held more", () =>
    run(
      null,
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const invited = yield* as(owner)(call({ op: "invite", name: "Sara", role: "admin" }));
        const id = (yield* as(owner)(call({ op: "list" }))).members!.find(
          (m) => m.name === "Sara",
        )!.id;
        yield* redeem(invited.code!);
        const granted = yield* as(owner)(call({ op: "machine", id, on: true }));
        assert.include(granted.warning ?? "", "anything on this computer");
        const machine = yield* redeem(granted.code!);
        assert.include([...machine.scopes], "terminal:operate");
        const devices = () =>
          Effect.map(
            auth.listSessions(),
            (all) => all.filter((s) => s.subject === memberSubject(id)).length,
          );
        assert.strictEqual(yield* devices(), 2);
        yield* as(owner)(call({ op: "machine", id, on: false }));
        assert.strictEqual(yield* devices(), 1);
        yield* as(owner)(call({ op: "setRole", id, role: "adult" }));
        assert.strictEqual(yield* devices(), 0);
        assert.strictEqual(
          (yield* as(owner)(call({ op: "machine", id: "owner", on: false }))).status,
          "done",
        );
      }),
    ));
});

describe("a home's members on one server, asked by its others", () => {
  const link = { environmentId: "env-home", label: "home box", status: "connected" } as never;
  /** A limb whose link reaches `home`'s household as its linked tool would, or nothing when `home` is null. */
  const limbOf = (home: TessayaHousehold["Service"] | null, carried: Array<unknown>) =>
    stackWith(0).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PeerLinks.PeerLinks)({
            list: Effect.succeed([link]),
            enabled: Effect.succeed(true),
          }),
          Layer.mock(PeerMcpClient.PeerMcpClient)({
            call: (input) => {
              carried.push(input.arguments);
              const a = input.arguments as {
                input: Parameters<TessayaHousehold["Service"]["callHere"]>[0];
                member: string | null;
                assurance: 0 | 1 | 2 | 3;
                via: string;
              };
              return home === null
                ? Effect.die("unreachable")
                : (home.callHere(a.input).pipe(
                    Effect.provideService(HouseholdCaller, {
                      member: a.member,
                      assurance: a.assurance,
                      via: a.via,
                    }),
                  ) as never);
            },
          }),
        ),
      ),
    );

  test("forwards every request with who asked, reads roles from the home, and narrows to nobody when it is gone", () =>
    Effect.gen(function* () {
      const home = yield* Layer.build(stackWith(0)).pipe(
        Effect.map((ctx) => Context.get(ctx, TessayaHousehold)),
      );
      yield* as(owner)(home.callHere({ op: "invite", name: "Sara", role: "child" }));
      const carried: Array<unknown> = [];
      const fromLimb = Effect.gen(function* () {
        const limb = yield* TessayaHousehold;
        assert.strictEqual(
          (yield* as(owner)(limb.call({ op: "setHome", on: "home box" }))).status,
          "done",
        );
        const listed = yield* as(owner)(limb.call({ op: "list" }));
        const sara = listed.members!.find((m) => m.name === "Sara")!;
        return { names: listed.members!.map((m) => m.name), grants: yield* limb.grantsOf(sara.id) };
      }).pipe(Effect.provide(limbOf(home, carried)));
      assert.deepStrictEqual(yield* fromLimb, {
        names: ["Owner", "Sara"],
        grants: { role: "child", machine: false, name: "Sara" },
      });
      assert.deepInclude(carried[0] as object, { member: "owner", assurance: 3 });
      // The home unreachable: nothing is done there, and nobody is known.
      const gone = yield* Effect.gen(function* () {
        const limb = yield* TessayaHousehold;
        yield* as(owner)(limb.call({ op: "setHome", on: "home box" }));
        return [
          (yield* as(owner)(limb.call({ op: "list" }))).status,
          yield* limb.grantsOf("owner"),
        ];
      }).pipe(Effect.provide(limbOf(null, [])));
      assert.deepStrictEqual(gone, ["refused", null]);
      // Only a linked server it names can hold them.
      const unknownPeer = yield* as(owner)(home.callHere({ op: "setHome", on: "nowhere" }));
      assert.strictEqual(unknownPeer.status, "refused");
    }).pipe(Effect.scoped));
});

describe("a removed member's voice", () => {
  test("is forgotten by every vessel here and on every linked server once their data is destroyed", () =>
    Effect.gen(function* () {
      const forgotten: Array<string> = [];
      const told: Array<[string, unknown]> = [];
      const link = { environmentId: "env-laptop", label: "laptop", status: "connected" } as never;
      yield* Effect.gen(function* () {
        const h = yield* TessayaHousehold;
        yield* as(owner)(h.callHere({ op: "invite", name: "Sara", role: "adult" }));
        const id = (yield* as(owner)(h.callHere({ op: "list" }))).members!.find(
          (m) => m.name === "Sara",
        )!.id;
        yield* as(owner)(h.callHere({ op: "remove", id }));
        // Leaving keeps the voice for the export window; only destroying the data forgets it.
        assert.deepStrictEqual(forgotten, []);
        yield* as(owner)(h.callHere({ op: "remove", id, now: true }));
        assert.deepStrictEqual(forgotten, [id]);
        assert.deepStrictEqual(told, [["household_voice_forget", { member: id }]]);
      }).pipe(
        Effect.provide(
          stackWith(null).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  VoiceForgets,
                  VoiceForgets.of({
                    forget: (m) => Effect.sync(() => void forgotten.push(m)),
                    setProfiles: () => Effect.void,
                    current: Effect.succeed([]),
                    listen: () => Effect.void,
                  }),
                ),
                Layer.mock(PeerLinks.PeerLinks)({ list: Effect.succeed([link]) }),
                Layer.mock(PeerMcpClient.PeerMcpClient)({
                  call: (input) =>
                    Effect.sync(() => (told.push([input.tool, input.arguments]), {})) as never,
                }),
              ),
            ),
          ),
        ),
      );
    }));
});

describe("one voice profile per member, on the home", () => {
  const voice = (id: string, samples: number, centroid = "AACAPwAAAAA=") => ({
    id,
    name: id,
    kind: id === "owner" ? ("owner" as const) : ("saved" as const),
    model: "m",
    centroid,
    samples,
    sources: ["spoken" as const],
    enrolledAt: "2026-11-13T00:00:00Z",
  });
  test("a new enrolment replaces it everywhere; a device's old copy stands only with more samples; members only", () =>
    Effect.gen(function* () {
      const shared: Array<ReadonlyArray<{ id: string; version: number }>> = [];
      yield* Effect.gen(function* () {
        const h = yield* TessayaHousehold;
        const saved = (fresh: boolean, samples: number, centroid?: string) =>
          as(owner)(
            h.callHere({ op: "saveVoice", profile: voice("owner", samples, centroid), fresh }),
          );
        // The R1's enrolment lands first; the desktop's older copy with more samples then wins; a fresh one replaces it.
        assert.strictEqual((yield* saved(true, 4)).status, "done");
        assert.strictEqual((yield* saved(false, 3)).line.includes("kept"), true);
        yield* saved(false, 9, "AAAAAAAAgD8=");
        yield* saved(true, 2);
        const listed = (yield* as(owner)(h.callHere({ op: "voices" }))).voices!;
        assert.deepStrictEqual(
          listed.map((v) => [v.id, v.samples, v.version]),
          [["owner", 2, 3]],
        );
        assert.deepStrictEqual(
          shared.at(-1)?.map((v) => [v.id, v.version]),
          [["owner", 3]],
        );
        // Nobody who isn't a member, and no member's voice saved by someone else who isn't the owner or an admin.
        const stranger = yield* as(owner)(
          h.callHere({ op: "saveVoice", profile: voice("ali", 5), fresh: true }),
        );
        assert.strictEqual(stranger.status, "refused");
        yield* as(owner)(h.callHere({ op: "invite", name: "Sara", role: "adult" }));
        yield* as(owner)(h.callHere({ op: "invite", name: "Omar", role: "adult" }));
        const ids = (yield* as(owner)(h.callHere({ op: "list" }))).members!.map((m) => m.id);
        const [sara, omar] = [ids[1]!, ids[2]!];
        const byOmar = yield* as({ member: omar, assurance: 2, via: "his phone" })(
          h.callHere({ op: "saveVoice", profile: voice(sara, 5), fresh: true }),
        );
        assert.strictEqual(byOmar.status, "refused");
        // Gone with their data.
        yield* as({ member: sara, assurance: 2, via: "her phone" })(
          h.callHere({ op: "saveVoice", profile: voice(sara, 5), fresh: true }),
        );
        yield* as(owner)(h.callHere({ op: "remove", id: sara, now: true }));
        assert.deepStrictEqual(
          (yield* as(owner)(h.callHere({ op: "voices" }))).voices!.map((v) => v.id),
          ["owner"],
        );
      }).pipe(
        Effect.provide(
          stackWith(null).pipe(
            Layer.provide(
              Layer.succeed(
                VoiceForgets,
                VoiceForgets.of({
                  forget: () => Effect.void,
                  setProfiles: (list) => Effect.sync(() => void shared.push(list)),
                  current: Effect.succeed([]),
                  listen: () => Effect.void,
                }),
              ),
            ),
          ),
        ),
      );
    }));

  test("a spelled name is kept as spelled; each member edits their own preferences, the owner anyone's", () =>
    run(
      null,
      Effect.gen(function* () {
        const invited = yield* as(owner)(
          call({ op: "invite", name: "Zaid, Z-A-Y-D", role: "adult" }),
        );
        assert.include(invited.line, "Added Zayd. Zayd, Z-A-Y-D.");
        const zayd = (yield* as(owner)(call({ op: "list" }))).members!.find(
          (m) => m.name === "Zayd",
        )!;
        const self = { member: zayd.id, assurance: 2, via: "his phone" } as const;
        // His own: read and set on his phone; a spelled value comes back spelled.
        const set = yield* as(self)(
          call({ op: "setPreference", id: zayd.id, key: "name", value: "Zaki, Z-A-K-Y" }),
        );
        assert.strictEqual(set.line, "Kept. Zaky, Z-A-K-Y.");
        assert.deepStrictEqual(
          (yield* as(self)(call({ op: "preferences", id: zayd.id }))).preferences,
          { name: "Zaky" },
        );
        // Not anyone else's, and not from a voice that only might be his.
        assert.strictEqual(
          (yield* as(self)(call({ op: "preferences", id: "owner" }))).status,
          "refused",
        );
        assert.strictEqual(
          (yield* as({ ...self, assurance: 1 })(
            call({ op: "setPreference", id: zayd.id, key: "units", value: "metric" }),
          )).status,
          "refused",
        );
        // The owner edits anyone's, and clearing takes it away.
        const cleared = yield* as(owner)(
          call({ op: "setPreference", id: zayd.id, key: "name", value: null }),
        );
        assert.strictEqual(cleared.line, "Cleared. (for Zayd)");
        assert.deepStrictEqual(cleared.preferences, {});
        // His own name is his to change.
        const renamed = yield* as(self)(call({ op: "rename", id: zayd.id, name: "Zayd Khan" }));
        assert.strictEqual(renamed.line, "Zayd is now Zayd Khan.");
      }),
    ));
});
