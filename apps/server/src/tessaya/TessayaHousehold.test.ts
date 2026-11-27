import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { memberSubject } from "@t3tools/tessaya-shared/household";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { layerMemory as TessayaDatabaseMemory } from "./TessayaDatabase.ts";
import { TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import {
  DEVICE_CLAIM,
  heldFromDevice,
  layer as memoryLayer,
  TessayaMemoryService,
} from "./TessayaMemoryService.ts";
import {
  TessayaPrivateMemoryService,
  PrivateCaller,
  PrivateKdf,
  StoreMembership,
  layer as privateLayer,
} from "./TessayaPrivateMemoryService.ts";
import { HouseholdCaller, TessayaHousehold, layer as householdLayer } from "./TessayaHousehold.ts";
import * as TessayaPresence from "./TessayaPresence.ts";
import { VoiceForgets } from "./VoiceForgets.ts";
import { layer as MemberPreferencesLayer } from "./MemberPreferences.ts";
import { authenticator, ORIGIN } from "./testing/softPasskey.ts";

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
  Layer.mock(TessayaPhoneInbox)({
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
    Layer.provideMerge(TessayaDatabaseMemory),
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
  test("only a vessel's own proven turn may file a voiceprint", () =>
    run(
      null,
      Effect.gen(function* () {
        const observe = call({
          op: "peopleObserve",
          vessel: "r1-1",
          said: "hi",
          print: { model: "m", vector: "AAAAAA==", ms: 3_000 },
        });
        assert.deepStrictEqual(yield* as(owner)(observe), {
          status: "refused",
          line: "Only a vessel's own turn files a voice.",
        });
        assert.notInclude((yield* as({ ...owner, heard: true })(observe)).line, "own turn");
      }),
    ));

  test("a family of four set up on a pretend Tumble: who each is, their yes, and a guest pass that ends", () =>
    run(
      null,
      Effect.gen(function* () {
        // He adds them by voice at the desk he has confirmed (A3); the clock starts on 1 Jan 1970.
        const added = (name: string, role: "adult" | "child" | "guest", extra = {}) =>
          as(owner)(call({ op: "invite", name, role, ...extra }));
        assert.strictEqual((yield* added("Sara", "adult")).status, "done");
        assert.strictEqual((yield* added("Adam", "child", { born: "1962-05-01" })).status, "done");
        const ali = yield* added("Ali", "guest", { until: "1970-01-02" });
        assert.include(ali.line, "as a guest until 1970-01-02");
        assert.strictEqual(
          (yield* added("Omar", "adult", { until: "1970-01-02" })).status,
          "refused",
        );
        const ids = Object.fromEntries(
          (yield* as(owner)(call({ op: "list" }))).members!.map((m) => [m.name, m.id]),
        );
        // Each one, by voice on the kitchen Tumble, asks "who am I?".
        const voice = (id: string | null) =>
          as({ member: id, assurance: id === null ? 0 : 2, via: "Tessaya via kitchen" });
        const sara = (yield* voice(ids["Sara"]!)(call({ op: "whoAmI" }))).you!;
        assert.deepInclude(sara, { name: "Sara", role: "adult", assurance: 2, consented: false });
        // A new home: her private memories are sealed from him, and she is told so.
        assert.include(sara.seenBy, "not even the owner");
        const adam = (yield* voice(ids["Adam"]!)(call({ op: "whoAmI" }))).you!;
        assert.include(adam.seenBy, "guardians");
        assert.strictEqual((yield* voice(ids["Ali"]!)(call({ op: "whoAmI" }))).you!.role, "guest");
        const stranger = yield* voice(null)(call({ op: "whoAmI" }));
        assert.include(stranger.line, "you're a guest");
        // Her yes is hers, in her own voice; an agent or an unsure voice can't give it, and she can take it back.
        assert.strictEqual(
          (yield* as({ member: ids["Sara"]!, assurance: 1, via: "a short reply" })(
            call({ op: "consent", yes: true }),
          )).status,
          "refused",
        );
        assert.strictEqual(
          (yield* as({ member: ids["Sara"]!, service: true, assurance: 2, via: "an agent" })(
            call({ op: "consent", yes: true }),
          )).status,
          "refused",
        );
        yield* voice(ids["Sara"]!)(call({ op: "consent", yes: true }));
        assert.isTrue((yield* voice(ids["Sara"]!)(call({ op: "whoAmI" }))).you!.consented);
        // Memory keeps what is about her only now (the gate reads this); the owner never needs one.
        const h = yield* TessayaHousehold;
        assert.isTrue(yield* h.consented(ids["Sara"]!));
        assert.isTrue(yield* h.consented("owner"));
        assert.isFalse(yield* h.consented(ids["Adam"]!));
        yield* voice(ids["Sara"]!)(call({ op: "consent", yes: false }));
        assert.isFalse((yield* voice(ids["Sara"]!)(call({ op: "whoAmI" }))).you!.consented);
        assert.isFalse(yield* h.consented(ids["Sara"]!));
        // Ali's pass ends after its last day (the hourly sweep), and all of it with it.
        yield* TestClock.adjust("3 days");
        assert.deepStrictEqual(
          (yield* as(owner)(call({ op: "list" }))).members!.map((m) => m.name).sort(),
          ["Adam", "Owner", "Sara"],
        );
      }),
    ));

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

  test("a child's own store opens for their guardian; on their day they become an adult and it seals (choice 5)", () =>
    run(
      null,
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* TessayaHousehold;
          const stores = yield* TessayaPrivateMemoryService;
          const desk = { session: "desk", desktop: true } as const;
          yield* Effect.provideService(
            stores
              .setup({ name: "Owner", pin: "27182818" })
              .pipe(Effect.flatMap((o) => stores.confirmSetup(o))),
            PrivateCaller,
            desk,
          );
          // Adam turns 16 on 1 May 1966, before the test clock's 1 Jan 1970; Zoe, set to 18, on 1 May 1970.
          yield* as(owner)(call({ op: "invite", name: "Adam", role: "child", born: "1950-05-01" }));
          yield* as(owner)(
            call({ op: "invite", name: "Zoe", role: "child", born: "1952-05-01", adultAge: 18 }),
          );
          const ids = Object.fromEntries(
            (yield* as(owner)(call({ op: "list" }))).members!.map((m) => [m.name, m.id]),
          );
          const adam = ids["Adam"]!;
          const membership = StoreMembership.of({
            isMember: (id) => Effect.map(h.roleOf(id), (r) => r !== null),
            isChild: (id) => Effect.map(h.roleOf(id), (r) => r === "child"),
          });
          // Adam makes his own on his phone: sealed to his PIN, and (a child's) to his guardian, the owner.
          const made = yield* stores.setup({ personId: adam, name: "Adam", pin: "314159" }).pipe(
            Effect.flatMap((o) => stores.confirmSetup(o)),
            Effect.provideService(PrivateCaller, {
              session: "adam-phone",
              desktop: false,
              member: adam,
            }),
            Effect.provideService(StoreMembership, membership),
          );
          const openAsOwner = Effect.provideService(
            stores.unlock({ storeId: made.id }).pipe(
              Effect.map((r) => r.open),
              Effect.orElseSucceed(() => false),
            ),
            PrivateCaller,
            desk,
          );
          yield* Effect.provideService(
            stores.unlock({
              storeId: (yield* Effect.provideService(stores.people, PrivateCaller, desk)).find(
                (s) => s.personId === "owner",
              )!.id,
              pin: "27182818",
            }),
            PrivateCaller,
            desk,
          );
          assert.isTrue(yield* openAsOwner);
          // He forgot his PIN: his guardian, the owner with his own store open here, sets a new one without the old.
          const reset = (by: { session: string; desktop: boolean; member?: string }) =>
            stores.changePin({ storeId: made.id, newPin: "271828" }).pipe(
              Effect.provideService(PrivateCaller, by),
              Effect.provideService(StoreMembership, membership),
              Effect.as("done"),
              Effect.orElseSucceed(() => "refused"),
            );
          assert.strictEqual(
            yield* reset({ session: "adam-phone", desktop: false, member: adam }),
            "refused",
          );
          assert.strictEqual(yield* reset(desk), "done");
          yield* Effect.provideService(stores.lock(), PrivateCaller, {
            session: "adam-phone",
            desktop: false,
            member: adam,
          });
          assert.isTrue(
            (yield* stores.unlock({ storeId: made.id, pin: "271828" }).pipe(
              Effect.provideService(PrivateCaller, {
                session: "adam-phone",
                desktop: false,
                member: adam,
              }),
            )).open,
          );
          const told = yield* h.grownUpdates;

          // A guardian's limits on Zoe: set, seen by her, refused from her, lifted the same way.
          const zoe = ids["Zoe"]!;
          const limit = (
            who: typeof owner | { member: string; assurance: 2; via: string },
            input: object,
          ) => as(who)(call({ op: "setLimit", id: zoe, ...input } as never));
          assert.strictEqual(
            (yield* limit(owner, { limit: "quiet", value: "9pm-7am" })).status,
            "refused",
          );
          assert.strictEqual(
            (yield* limit(owner, { limit: "quiet", value: "21:00-07:00" })).status,
            "done",
          );
          assert.strictEqual(
            (yield* limit(owner, { limit: "messages", value: "guardians" })).status,
            "done",
          );
          const asZoe = { member: zoe, assurance: 2, via: "her phone" } as const;
          assert.strictEqual(
            (yield* limit(asZoe, { limit: "quiet", value: null })).status,
            "refused",
          );
          const seen = (yield* as(asZoe)(call({ op: "list" }))).members!.find((m) => m.id === zoe)!;
          assert.deepStrictEqual(seen.limits, { quiet: "21:00-07:00", messages: "guardians" });
          assert.deepStrictEqual((yield* h.grantsOf(zoe))?.messagesTo, ["owner"]);
          yield* limit(owner, { limit: "messages", value: null });
          assert.isNull((yield* h.grantsOf(zoe))?.messagesTo);

          assert.deepStrictEqual(yield* h.growUp, ["Adam"]);
          // Comms tells him, from his guardian; his guardian's phone hears it too.
          assert.deepInclude(yield* PubSub.take(told), { name: "Adam", guardians: ["owner"] });
          // Grown up, nobody resets his PIN but him.
          assert.strictEqual(yield* reset(desk), "refused");
          assert.strictEqual(yield* h.roleOf(adam), "adult");
          assert.strictEqual(yield* h.roleOf(ids["Zoe"]!), "child");
          const grown = (yield* as(owner)(call({ op: "list" }))).members!.find(
            (m) => m.id === adam,
          )!;
          assert.deepStrictEqual(grown.guardians, []);
          // This home never chose to open adults' stores, so the owner's copy of his key is gone.
          yield* Effect.provideService(stores.lock(), PrivateCaller, desk);
          yield* Effect.provideService(
            stores.unlock({
              storeId: (yield* Effect.provideService(stores.people, PrivateCaller, desk)).find(
                (s) => s.personId === "owner",
              )!.id,
              pin: "27182818",
            }),
            PrivateCaller,
            desk,
          );
          assert.isFalse(yield* openAsOwner);
        }),
      ),
    ));

  test("removing signs out every device at once, keeps the data 7 days for export, then destroys it; restore undoes", () =>
    run(
      null,
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const stores = yield* TessayaPrivateMemoryService;
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
          stores
            .setup({ name: "Owner", pin: "27182818" })
            .pipe(Effect.flatMap((o) => stores.confirmSetup(o))),
          PrivateCaller,
          desk,
        );
        yield* Effect.provideService(
          stores
            .setup({ personId: id, name: "Sara", pin: "314159" })
            .pipe(Effect.flatMap((o) => stores.confirmSetup(o))),
          PrivateCaller,
          desk,
        );
        const pending = yield* as(owner)(call({ op: "pair", id }));
        assert.strictEqual(pending.status, "done");

        // Her export: her own device, confirmed it's her (A3); never an agent's, never at A2.
        const hers = { member: id, assurance: 3, via: "her phone" } as const;
        assert.strictEqual(
          (yield* as({ ...hers, assurance: 2 })(call({ op: "exportMine" }))).status,
          "refused",
        );
        assert.strictEqual(
          (yield* as({ ...hers, service: true })(call({ op: "exportMine" }))).status,
          "refused",
        );
        const exported = yield* as(hers)(call({ op: "exportMine" }));
        assert.deepStrictEqual(
          exported.export!["tessaya_household_members"]!.map((r) => r["id"]),
          [id],
        );

        const removed = yield* as(owner)(call({ op: "remove", id }));
        assert.include(removed.line, "signed out everywhere");
        // Signed out, she still gets her data: once, by the link, and never by a guess or a second try.
        const h = yield* TessayaHousehold;
        const token = removed.exportLink!.split("/").pop()!;
        assert.isTrue(Option.isNone(yield* h.exportByLink("A".repeat(32))));
        const byLink = yield* h.exportByLink(token);
        assert.deepStrictEqual(
          Option.getOrThrow(byLink)["tessaya_household_members"]!.map((r) => r["id"]),
          [id],
        );
        assert.isTrue(Option.isNone(yield* h.exportByLink(token)));
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
        // joining shows its owner the one code that brings this server's own memories in at home
        const joined = yield* as(owner)(limb.call({ op: "setHome", on: "home box" }));
        assert.strictEqual(joined.status, "done");
        assert.match(joined.code!, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        const listed = yield* as(owner)(limb.call({ op: "list" }));
        const sara = listed.members!.find((m) => m.name === "Sara")!;
        return { names: listed.members!.map((m) => m.name), grants: yield* limb.grantsOf(sara.id) };
      }).pipe(Effect.provide(limbOf(home, carried)));
      assert.deepStrictEqual(yield* fromLimb, {
        names: ["Owner", "Sara"],
        // A child's limits travel to the limb too: none set here.
        grants: {
          role: "child",
          machine: false,
          name: "Sara",
          quietNow: false,
          messagesTo: null,
        },
      });
      // The list went with who asked (a background preferences read may go first).
      const listCall = carried.find((a) => (a as { input?: { op?: string } }).input?.op === "list");
      assert.deepInclude(listCall as object, { member: "owner", assurance: 3 });
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

describe("a device's own memories, brought in", () => {
  test("only by its owner, at A3 on their own device, with the code it showed them, once", () =>
    Effect.gen(function* () {
      const memory = yield* TessayaMemoryService;
      yield* as(owner)(call({ op: "invite", name: "Maya", role: "adult" }));
      const maya = (yield* as(owner)(call({ op: "list" }))).members!.find(
        (m) => m.name === "Maya",
      )!;
      const item = {
        id: "phone-1",
        kind: "fact",
        text: "Maya's locker code is 4471",
        source: "user",
        sourceRef: null,
        scope: "global",
        scopeRef: null,
        confidence: 1,
        pinned: false,
        proposed: false,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: null,
        supersededBy: null,
      } as const;
      yield* memory.applyChanges(
        "her-phone",
        heldFromDevice("her-phone", [{ item, tombstone: null, writer: "her-phone" }]),
        "",
      );
      const hash = NodeCrypto.createHash("sha256").update("ABCDEFGH").digest("hex");
      yield* memory.setMeta(`${DEVICE_CLAIM}${hash}`, "her-phone");
      const hers = { member: maya.id, assurance: 3, via: "her phone" } as const;
      const claim = (code: string) => call({ op: "claimDevice", code });
      // not at A2, not an agent, not a wrong code
      for (const [who, code] of [
        [{ ...hers, assurance: 2 }, "ABCD-EFGH"],
        [{ ...hers, service: true }, "ABCD-EFGH"],
        [hers, "ABCD-EFGJ"],
      ] as const)
        assert.strictEqual((yield* as(who)(claim(code))).status, "refused");
      assert.strictEqual((yield* as(hers)(claim("abcd efgh"))).status, "done");
      const placed = (yield* memory.list()).find((i) => i.id === "phone-1")!;
      assert.strictEqual(placed.speaker, maya.id);
      // used once
      assert.strictEqual((yield* as(hers)(claim("ABCD-EFGH"))).status, "refused");
    }).pipe(Effect.provide(memoryLayer.pipe(Layer.provideMerge(stackWith(0))))));
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
        // Filed under his member name, never a vessel's placeholder ("Owner" from the room, "You" from the desktop).
        const him = (yield* as(owner)(h.callHere({ op: "list" }))).members![0]!.name;
        assert.notStrictEqual(him, "owner");
        assert.strictEqual(listed[0]!.name, him);
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

  test("a vessel's presence report places its own member; location and camera only once they turn them on", () =>
    run(
      null,
      Effect.gen(function* () {
        const presence = yield* TessayaPresence.TessayaPresence;
        const here = (signal: "foreground" | "home" | "seen") =>
          as(owner)(call({ op: "here", signal, vessel: "phone-1" }));
        assert.strictEqual((yield* here("foreground")).status, "done");
        assert.strictEqual((yield* here("home")).status, "refused");
        assert.strictEqual((yield* here("seen")).status, "refused");
        const sources = () =>
          Effect.map(presence.estimate(), (e) =>
            e.members.find((m) => m.member === "owner")!.evidence.map((x) => x.source),
          );
        assert.deepStrictEqual(yield* sources(), ["phoneApp"]);
        for (const key of ["location", "camera"] as const)
          yield* as(owner)(call({ op: "setPreference", id: "owner", key, value: "on" }));
        // A network address is kept as typed, not read as a spelled name.
        const devices = yield* as(owner)(
          call({
            op: "setPreference",
            id: "owner",
            key: "devices",
            value: "AA:BB:CC:DD:EE:01, Pixel",
          }),
        );
        assert.strictEqual(devices.preferences?.devices, "AA:BB:CC:DD:EE:01, Pixel");
        assert.strictEqual((yield* here("home")).status, "done");
        assert.strictEqual((yield* here("seen")).status, "done");
        assert.deepStrictEqual((yield* sources()).toSorted(), ["camera", "home", "phoneApp"]);
        // Whose a Tessel is is the owner's or an admin's to say, and only for a room vessel.
        assert.strictEqual(
          (yield* as(owner)(call({ op: "setVesselMember", vessel: "nope", member: "owner" })))
            .status,
          "refused",
        );
      }).pipe(Effect.provide(TessayaPresence.layer)),
    ));

  test("a step-up raises only that session to A3 for 5 minutes: their PIN, or Windows Hello on an account that is theirs alone", () =>
    run(
      null,
      Effect.gen(function* () {
        const stores = yield* TessayaPrivateMemoryService;
        yield* Effect.provideService(
          stores
            .setup({ name: "Owner", pin: "27182818" })
            .pipe(Effect.flatMap((o) => stores.confirmSetup(o))),
          PrivateCaller,
          { session: "desk", desktop: true },
        );
        // His desktop is A2 like any signed-in device: adding someone waits for his phone's yes.
        const desk = {
          member: "owner",
          assurance: 2,
          via: "the desktop",
          session: "desk",
          desktop: true,
        } as const;
        const invite = call({ op: "invite", name: "Adam", role: "child" });
        assert.strictEqual((yield* as(desk)(invite)).status, "asked");
        // A wrong PIN, then a right one: A3 on this session only, and only for 5 minutes.
        assert.strictEqual(
          (yield* as(desk)(call({ op: "stepUp", pin: "11111111" }))).status,
          "refused",
        );
        assert.strictEqual(
          (yield* as(desk)(call({ op: "stepUp", pin: "27182818" }))).status,
          "done",
        );
        assert.strictEqual((yield* as(desk)(invite)).status, "done");
        assert.strictEqual((yield* as({ ...desk, session: "phone" })(invite)).status, "asked");
        yield* TestClock.adjust("301 seconds");
        assert.strictEqual((yield* as(desk)(invite)).status, "asked");
        // Windows Hello: not until his account is mapped to him (a phone yes here), and never on a shared account.
        const hello = call({ op: "stepUp", hello: "LAPTOP\\rab" });
        assert.strictEqual((yield* as(desk)(hello)).status, "refused");
        assert.strictEqual((yield* as({ ...desk, desktop: false })(hello)).status, "refused");
        assert.strictEqual(
          (yield* as(owner)(call({ op: "setWindowsAccount", id: "owner", account: "laptop\\rab" })))
            .status,
          "done",
        );
        assert.strictEqual((yield* as(desk)(hello)).status, "done");
        assert.strictEqual((yield* as(desk)(invite)).status, "done");
        const adam = (yield* as(owner)(call({ op: "list" }))).members!.find(
          (m) => m.name === "Adam",
        )!;
        assert.strictEqual(
          (yield* as(owner)(call({ op: "setWindowsAccount", id: adam.id, account: "laptop\\rab" })))
            .status,
          "done",
        );
        yield* TestClock.adjust("301 seconds");
        assert.include((yield* as(desk)(hello)).line, "shared");
      }),
    ));

  test("with only the owner in the household, his desktop's Windows Hello confirms him without mapping it first", () =>
    run(
      null,
      Effect.gen(function* () {
        const desk = {
          member: "owner",
          assurance: 2,
          via: "the desktop",
          session: "desk",
          desktop: true,
        } as const;
        assert.strictEqual(
          (yield* as(desk)(call({ op: "stepUp", hello: "LAPTOP\\rab" }))).status,
          "done",
        );
        const me = (yield* as(owner)(call({ op: "list" }))).members!.find((m) => m.you)!;
        assert.strictEqual(me.windowsAccount, "laptop\\rab", "kept, so the household tab shows it");
        assert.strictEqual(
          (yield* as(desk)(call({ op: "stepUp", hello: "LAPTOP\\guest" }))).status,
          "refused",
          "another account on the machine still isn't him",
        );
      }),
    ));

  test("a passkey added on their own device confirms it's them there: A3 for 5 minutes, on that site, by that member only", () =>
    run(
      null,
      Effect.gen(function* () {
        const phone = {
          member: "owner",
          assurance: 2,
          via: "his phone",
          session: "phone",
          origin: ORIGIN,
        } as const;
        const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
        const device = authenticator();
        const options = (purpose: "register" | "stepUp") =>
          Effect.map(as(phone)(call({ op: "passkeyOptions", purpose })), (r) => r.passkey!);
        const reg = yield* options("register");
        assert.strictEqual(reg.rpId, "home.example");
        const made = device.create(reg.challenge);
        const added = yield* as(phone)(
          call({
            op: "passkeyRegister",
            clientDataJSON: b64(made.clientDataJSON),
            attestationObject: b64(made.attestationObject),
            label: "His phone",
          }),
        );
        assert.strictEqual(added.status, "done");
        const step = yield* options("stepUp");
        assert.lengthOf(step.keys, 1);
        const answer = (challenge: string) => {
          const a = device.get(challenge);
          return {
            credentialId: step.keys[0]!.id,
            clientDataJSON: b64(a.clientDataJSON),
            authenticatorData: b64(a.authenticatorData),
            signature: b64(a.signature),
          };
        };
        const invite = call({ op: "invite", name: "Adam", role: "child" });
        assert.strictEqual((yield* as(phone)(invite)).status, "asked");
        // A challenge is used once; another member's session can't use his passkey.
        const signed = answer(step.challenge);
        assert.strictEqual(
          (yield* as({ ...phone, member: "sara-1" })(call({ op: "stepUp", passkey: signed })))
            .status,
          "refused",
        );
        const again = yield* options("stepUp");
        assert.strictEqual(
          (yield* as(phone)(call({ op: "stepUp", passkey: answer(again.challenge) }))).status,
          "done",
        );
        assert.strictEqual((yield* as(phone)(invite)).status, "done");
        assert.strictEqual(
          (yield* as(phone)(call({ op: "stepUp", passkey: answer(again.challenge) }))).status,
          "refused",
        );
        // Removing it takes it away.
        yield* as(phone)(call({ op: "passkeyRemove", credentialId: step.keys[0]!.id }));
        assert.lengthOf((yield* options("stepUp")).keys, 0);
      }),
    ));
});
