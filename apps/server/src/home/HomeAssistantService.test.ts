import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { EnvironmentId } from "@t3tools/contracts";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { layerMemory as TessayaDatabaseMemory } from "../tessaya/TessayaDatabase.ts";
import { TessayaPhoneInbox, layer as inboxLayer } from "../tessaya/TessayaPhoneInbox.ts";
import { TessayaRecordService, layer as recordLayer } from "../tessaya/TessayaRecordService.ts";
import {
  HomeAssistantConnection,
  HomeCallError,
  HomeConnectError,
  type HomeLink,
} from "./HomeAssistantConnection.ts";
import * as HomeAssistantService from "./HomeAssistantService.ts";
import { TessayaHousehold } from "../tessaya/TessayaHousehold.ts";
import { TurnOrigin } from "../tessaya/TessayaTurn.ts";
import { Consent, layer as ConsentLayer } from "../tessaya/consent.ts";
import { houseGrant } from "@t3tools/tessaya-shared/consent";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";

interface Entity {
  s: string;
  a: Record<string, unknown>;
}

/** A small house: a light, a lock, the pump, one of his automations. Applies what Tessaya asks and streams the diffs back. */
const makeHouse = () => {
  const states = new Map<string, Entity>([
    ["light.study", { s: "on", a: { friendly_name: "Study light" } }],
    ["lock.front", { s: "locked", a: { friendly_name: "Front door" } }],
    ["switch.sonoff_1", { s: "off", a: { friendly_name: "Water Pump" } }],
    ["fan.fan", { s: "on", a: { friendly_name: "Fan" } }],
    ["script.office_fan_toggle", { s: "off", a: { friendly_name: "Office Fan Toggle" } }],
    ["automation.kitten", { s: "on", a: { friendly_name: "Kitten litter", id: "kitten_1" } }],
  ]);
  const configs = new Map<string, Record<string, unknown>>([
    ["kitten_1", { id: "kitten_1", alias: "Kitten litter" }],
  ]);
  const scenes = new Map<string, Map<string, Entity>>();
  const calls: Array<string> = [];
  /** The house going down just as a missed run is made up. */
  const down = { trigger: false };
  const logbook: Array<string> = [];
  let onDiff: ((e: unknown) => void) | null = null;
  let onDone: ((e: unknown) => void) | null = null;
  const put = (id: string, entity: Entity) => {
    states.set(id, entity);
    onDiff?.({ a: { [id]: { s: entity.s, a: entity.a } } });
  };
  const remove = (id: string) => {
    states.delete(id);
    onDiff?.({ r: [id] });
  };
  const ids = (target: unknown): ReadonlyArray<string> => {
    const raw = (target as { entity_id?: unknown } | undefined)?.entity_id;
    return raw === undefined ? [] : Array.isArray(raw) ? (raw as Array<string>) : [String(raw)];
  };
  const command = (m: Readonly<Record<string, unknown>>): Effect.Effect<unknown, HomeCallError> =>
    Effect.suspend((): Effect.Effect<unknown, HomeCallError> => {
      switch (m["type"]) {
        case "script/config":
          return Effect.succeed(
            m["entity_id"] === "script.office_fan_toggle"
              ? {
                  config: {
                    sequence: [{ action: "fan.toggle", target: { entity_id: "fan.fan" } }],
                  },
                }
              : null,
          );
        case "get_config":
          return Effect.succeed({ version: "2026.8.0", time_zone: "Asia/Karachi" });
        case "auth/current_user":
          return Effect.succeed({ is_admin: true });
        case "config/area_registry/list":
          return Effect.succeed([
            { area_id: "study", name: "Study" },
            { area_id: "office", name: "Office" },
            { area_id: "bedroom", name: "Bedroom" },
          ]);
        case "config/device_registry/list":
          return Effect.succeed([]);
        case "config/entity_registry/list":
          return Effect.succeed([
            { entity_id: "light.study", area_id: "study" },
            // HA knows it, but its integration has given it no state: off the network.
            { entity_id: "fan.office_fan", area_id: "office", name: "Office Fan" },
            { entity_id: "light.desk_lamp", area_id: "office" },
            { entity_id: "light.bedside_lamp", area_id: "bedroom" },
          ]);
        case "validate_config": {
          const empty = Array.isArray(m["triggers"]) && m["triggers"].length === 0;
          return Effect.succeed({
            triggers: empty
              ? { valid: false, error: "a trigger is required" }
              : { valid: true, error: null },
            conditions: { valid: true, error: null },
            actions: { valid: true, error: null },
          });
        }
        case "call_service": {
          const name = `${String(m["domain"])}.${String(m["service"])}`;
          calls.push(name);
          const data = (m["service_data"] ?? {}) as Record<string, unknown>;
          if (name === "logbook.log") logbook.push(String(data["message"]));
          if (name === "scene.create") {
            const snap = new Map<string, Entity>();
            for (const e of data["snapshot_entities"] as Array<string>)
              snap.set(e, structuredClone(states.get(e)!));
            scenes.set(`scene.${String(data["scene_id"])}`, snap);
            put(`scene.${String(data["scene_id"])}`, {
              s: "scening",
              a: { entity_id: [...snap.keys()] },
            });
          }
          if (name === "scene.delete") for (const e of ids(m["target"])) remove(e);
          if (name === "scene.turn_on")
            for (const [e, v] of scenes.get(ids(m["target"])[0]!) ?? []) put(e, structuredClone(v));
          if (name === "fan.turn_on" || name === "switch.turn_on")
            for (const e of ids(m["target"])) put(e, { ...states.get(e)!, s: "on" });
          if (
            name === "light.turn_off" ||
            name === "fan.turn_off" ||
            name === "switch.turn_off" ||
            name === "automation.turn_off"
          )
            for (const e of ids(m["target"])) put(e, { ...states.get(e)!, s: "off" });
          if (name === "automation.trigger" && down.trigger)
            return Effect.fail(
              new HomeCallError({ operation: "call_service", code: "unreachable", said: "down" }),
            );
          if (name === "automation.trigger")
            for (const e of ids(m["target"]))
              put(e, { ...states.get(e)!, a: { ...states.get(e)!.a, last_triggered: "now" } });
          if (name === "automation.turn_on")
            for (const e of ids(m["target"])) put(e, { ...states.get(e)!, s: "on" });
          if (name === "lock.unlock")
            for (const e of ids(m["target"])) put(e, { ...states.get(e)!, s: "unlocked" });
          return Effect.succeed({ context: {} });
        }
        case "config/label_registry/list":
          return Effect.succeed([{ label_id: "tessaya", name: "Tessaya" }]);
        default:
          return Effect.succeed(null);
      }
    });
  const link: HomeLink = {
    command,
    subscribe: (m, onEvent) =>
      Effect.sync(() => {
        if (m["type"] === "subscribe_entities") {
          onDiff = onEvent;
          onEvent({
            a: Object.fromEntries([...states].map(([id, e]) => [id, { s: e.s, a: e.a }])),
          });
        } else onDone = onEvent;
      }),
    rest: (method, path, body) =>
      Effect.suspend((): Effect.Effect<unknown, HomeCallError> => {
        const id = decodeURIComponent(path.split("/").pop()!);
        if (method === "GET")
          return configs.has(id)
            ? Effect.succeed(configs.get(id))
            : Effect.fail(
                new HomeCallError({ operation: "GET", code: "http_404", said: "not found" }),
              );
        if (method === "DELETE") {
          configs.delete(id);
          for (const [e, v] of states) if (v.a["id"] === id) states.delete(e);
          onDiff?.({ r: [...states.keys()].filter(() => false) });
          return Effect.succeed({ result: "ok" });
        }
        const config = body as Record<string, unknown>;
        configs.set(id, config);
        put(`automation.${id}`, { s: "on", a: { id, friendly_name: config["alias"] } });
        return Effect.succeed({ result: "ok" });
      }),
    closed: Effect.never,
  };
  const connection = Layer.succeed(HomeAssistantConnection)({
    open: (_url, token) =>
      token === "bad-token-bad-token-bad"
        ? Effect.fail(new HomeConnectError({ reason: "unauthorized" }))
        : Effect.succeed(link),
  });
  return {
    states,
    configs,
    calls,
    logbook,
    connection,
    put,
    remove,
    fireDone: (id: string) => onDone?.({ data: { id } }),
    down,
  };
};

const stored = new Map<string, Uint8Array>();
const secrets = Layer.mock(ServerSecretStore)({
  get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
  set: (name, value) => Effect.sync(() => void stored.set(name, value)),
  remove: (name) => Effect.sync(() => void stored.delete(name)),
});

const TOKEN = "a-long-enough-test-token-0123456789";
const assistant: HomeAssistantService.HomeActor = { who: "Tessaya", surface: "assistant" };

const setup = () => {
  stored.clear();
  const house = makeHouse();
  const layer = HomeAssistantService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(house.connection, secrets, inboxLayer, recordLayer)),
    Layer.provideMerge(TessayaDatabaseMemory),
  );
  return { house, layer };
};

const connected = Effect.gen(function* () {
  const home = yield* HomeAssistantService.HomeAssistantService;
  const status = yield* home.connect({ url: "http://ha.local:8123", token: TOKEN });
  assert.strictEqual(status.state, "connected");
  return home;
});

it.effect("keeps the token in the secret store only, and refuses one HA refuses", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const home = yield* HomeAssistantService.HomeAssistantService;
    const refused = yield* home
      .connect({ url: "http://ha.local:8123", token: "bad-token-bad-token-bad" })
      .pipe(Effect.flip);
    assert.include(refused.why, "refused");
    assert.isFalse(stored.has(HomeAssistantService.TOKEN_SECRET));
    const status = yield* home.connect({ url: "http://ha.local:8123/", token: TOKEN });
    assert.deepStrictEqual(
      [status.state, status.host, status.version],
      ["connected", "ha.local:8123", "2026.8.0"],
    );
    assert.strictEqual(
      new TextDecoder().decode(stored.get(HomeAssistantService.TOKEN_SECRET)),
      TOKEN,
    );
    assert.notInclude(JSON.stringify(status), TOKEN);
    assert.strictEqual((yield* home.disconnect).state, "off");
    assert.isFalse(stored.has(HomeAssistantService.TOKEN_SECRET));
    // A house with no token settles at once, so the room's ready door never waits on it.
    yield* home.settled;
  }).pipe(Effect.provide(layer));
});

it.effect("finds by words and room, toggles a light, and undoes it from the snapshot", () => {
  const { house, layer } = setup();
  return Effect.gen(function* () {
    const home = yield* connected;
    const found = yield* home.find({ text: "study" });
    assert.deepStrictEqual(
      found.map((e) => [e.entityId, e.area]),
      [["light.study", "Study"]],
    );
    // A short word counts only whole: "on" is not a hit for "automation" or "front".
    assert.deepStrictEqual(
      (yield* home.find({ text: "Turn on the fan", limit: 1 })).map((e) => e.entityId),
      ["fan.fan"],
    );
    const done = yield* home.call(
      {
        domain: "light",
        service: "turn_off",
        target: { entity_id: "light.study" },
        why: "he asked",
      },
      assistant,
    );
    assert.strictEqual(done.status, "done");
    assert.strictEqual(house.states.get("light.study")?.s, "off");
    // What a follow-up ("turn it back on") needs to reach the same light.
    assert.deepStrictEqual((yield* home.actions(1))[0]?.entities, ["light.study"]);
    assert.deepStrictEqual(house.calls.slice(0, 2), ["scene.create", "light.turn_off"]);
    assert.isTrue(house.logbook.some((line) => line.includes("light.turn_off")));
    const undone = yield* home.undo(done.undoId!, assistant);
    assert.strictEqual(undone.status, "undone");
    assert.strictEqual(house.states.get("light.study")?.s, "on");
    // Its snapshot goes once used, and any left past its day goes too; a newer one stays (13 Nov: 6 of his 6 scenes).
    assert.isFalse([...house.states.keys()].some((e) => e.startsWith("scene.tessaya_undo_")));
    house.put("scene.tessaya_undo_100", { s: "scening", a: { entity_id: [] } });
    yield* TestClock.adjust("25 hours");
    house.put(`scene.tessaya_undo_${(25 * 3_600_000).toString(36)}00`, { s: "scening", a: {} });
    yield* home.tick;
    assert.deepStrictEqual(
      [...house.states.keys()].filter((e) => e.startsWith("scene.")),
      [`scene.tessaya_undo_${(25 * 3_600_000).toString(36)}00`],
    );
    // 12 Nov: the R1 turned off "light.lamp" (no such entity), HA said ok, and she said it was off.
    const calls = house.calls.length;
    const ghost = yield* home
      .call(
        {
          domain: "light",
          service: "turn_off",
          target: { entity_id: "light.lamp" },
          why: "x",
        },
        assistant,
      )
      .pipe(Effect.flip);
    assert.include(ghost.why, "no light.lamp");
    assert.strictEqual(house.calls.length, calls);
    const record = yield* (yield* TessayaRecordService).query({ kind: "home" });
    assert.deepStrictEqual(
      record.map((r) => r.outcome),
      ["undone", "done"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "asks before an ask-first action, runs it on his yes, and never takes a yes from the R1",
  () => {
    const { house, layer } = setup();
    return Effect.gen(function* () {
      const home = yield* connected;
      const inbox = yield* TessayaPhoneInbox;
      const unlock = {
        domain: "lock",
        service: "unlock",
        target: { entity_id: "lock.front" },
        why: "let me in",
      };
      const fromR1 = yield* home.call(unlock, { who: "Tessaya", surface: "r1", approved: true });
      assert.strictEqual(fromR1.status, "asked");
      assert.strictEqual(house.states.get("lock.front")?.s, "locked");
      const card = (yield* inbox.pending).find((p) => p.id === `home-${fromR1.id}`);
      assert.strictEqual(card?.needs, "cloud-approve");
      assert.isTrue(yield* inbox.answerPrompt(card!.id, 0));
      yield* home.tick;
      assert.strictEqual(house.states.get("lock.front")?.s, "unlocked");
      assert.deepStrictEqual((yield* home.pending).length, 0);

      const pump = yield* home.call(
        {
          domain: "switch",
          service: "turn_on",
          target: { entity_id: "switch.sonoff_1" },
          why: "water",
        },
        assistant,
      );
      assert.strictEqual(pump.status, "asked");
      assert.strictEqual((yield* home.answer(pump.id!, false)).status, "denied");
      assert.strictEqual(house.states.get("switch.sonoff_1")?.s, "off");

      const unattended = yield* home.call(unlock, { who: "a job", surface: "standing" });
      assert.strictEqual(unattended.status, "held");
      const never = yield* home.call(
        { domain: "homeassistant", service: "stop", why: "x" },
        assistant,
      );
      assert.strictEqual(never.status, "refused");
      assert.notInclude(house.calls, "homeassistant.stop");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a scratch automation is checked by HA, marked as hers, and removed after its one run",
  () => {
    const { house, layer } = setup();
    return Effect.gen(function* () {
      const home = yield* connected;
      const broken = yield* home
        .saveAutomation(
          {
            alias: "Nothing",
            kind: "scratch",
            triggers: [],
            actions: [{ action: "light.turn_on", target: { entity_id: "light.study" } }],
            request: "test",
          },
          assistant,
        )
        .pipe(Effect.flip);
      assert.include(broken.why, "a trigger is required");
      const saved = yield* home.saveAutomation(
        {
          alias: "Study light at sunset",
          kind: "scratch",
          once: true,
          triggers: [{ trigger: "sun", event: "sunset" }],
          actions: [{ action: "light.turn_on", target: { entity_id: "light.study" } }],
          request: "turn the study light on at sunset, once",
        },
        assistant,
      );
      assert.strictEqual(saved.status, "done");
      const id = saved.id!;
      assert.match(id, /^tessaya_scratch_/);
      const config = house.configs.get(id)!;
      assert.include(String(config["description"]), "Made by Tessaya for Tessaya");
      assert.deepStrictEqual(
        (config["conditions"] as Array<{ condition: string }>).map((c) => c.condition),
        ["template"],
      );
      assert.deepStrictEqual(
        (config["actions"] as Array<{ event?: string }>).at(-1)?.event,
        HomeAssistantService.DONE_EVENT,
      );
      const listed = yield* home.automations({});
      assert.deepStrictEqual(
        listed.map((a) => [a.id, a.kind, a.status]),
        [[id, "scratch", "active"]],
      );

      house.fireDone(id);
      yield* home.tick;
      assert.isFalse(house.configs.has(id));
      assert.strictEqual((yield* home.automations({}))[0]?.status, "finished");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a timer lists when it runs, and moves under the same id; a rule on a condition does not move",
  () => {
    const { house, layer } = setup();
    return Effect.gen(function* () {
      const home = yield* connected;
      const timer = yield* home.saveAutomation(
        {
          alias: "Study light off",
          kind: "temporary",
          runInMinutes: 20,
          actions: [{ action: "light.turn_off", target: { entity_id: "light.study" } }],
          request: "study light off in twenty",
        },
        assistant,
      );
      const id = timer.id!;
      const now = yield* Clock.currentTimeMillis;
      const runsAt = () =>
        Effect.map(home.automations({}), (rows) =>
          Date.parse(rows.find((r) => r.id === id)!.runsAt!),
        );
      assert.strictEqual(Math.round(((yield* runsAt()) - now) / 60_000), 20);

      const moved = yield* home.moveAutomation({ id, runInMinutes: 15 }, assistant);
      assert.strictEqual(moved.status, "done");
      assert.strictEqual(Math.round(((yield* runsAt()) - now) / 60_000), 15);
      const config = house.configs.get(id)!;
      assert.lengthOf(config["conditions"] as ReadonlyArray<unknown>, 1);
      assert.lengthOf(
        (config["actions"] as Array<{ event?: string }>).filter(
          (a) => a.event === HomeAssistantService.DONE_EVENT,
        ),
        1,
      );

      const sunset = yield* home.saveAutomation(
        {
          alias: "Study light at sunset",
          kind: "temporary",
          expiresInMinutes: 600,
          triggers: [{ trigger: "sun", event: "sunset" }],
          actions: [{ action: "light.turn_on", target: { entity_id: "light.study" } }],
          request: "study light at sunset today",
        },
        assistant,
      );
      const refused = yield* home
        .moveAutomation({ id: sunset.id!, runInMinutes: 5 }, assistant)
        .pipe(Effect.flip);
      assert.include(refused.why, "Only a one-off timer moves");
      assert.isNull((yield* home.automations({})).find((r) => r.id === sunset.id)!.runsAt);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a temporary automation is swept at its end; pause, delete and undo work, and his own ask first",
  () => {
    const { house, layer } = setup();
    return Effect.gen(function* () {
      const home = yield* connected;
      const saved = yield* home.saveAutomation(
        {
          alias: "Study light off",
          kind: "temporary",
          expiresInMinutes: 30,
          triggers: [{ trigger: "time_pattern", minutes: "/5" }],
          actions: [{ action: "light.turn_off", target: { entity_id: "light.study" } }],
          request: "for the next half hour keep the study light off",
        },
        assistant,
      );
      const id = saved.id!;
      assert.strictEqual(
        (yield* home.setAutomation({ id, op: "pause" }, assistant)).status,
        "done",
      );
      assert.strictEqual(house.states.get(`automation.${id}`)?.s, "off");
      assert.strictEqual(
        (yield* home.setAutomation({ id, op: "delete" }, assistant)).status,
        "done",
      );
      assert.isFalse(house.configs.has(id));
      assert.strictEqual((yield* home.undo(id, assistant)).status, "undone");
      assert.isTrue(house.configs.has(id));
      yield* TestClock.adjust("31 minutes");
      yield* home.tick;
      assert.isFalse(house.configs.has(id));

      const his = yield* home.setAutomation({ id: "kitten_1", op: "delete" }, assistant);
      assert.strictEqual(his.status, "asked");
      assert.isTrue(house.configs.has("kitten_1"));

      const risky = yield* home.saveAutomation(
        {
          alias: "Unlock at 3",
          kind: "permanent",
          triggers: [{ trigger: "time", at: "03:00:00" }],
          actions: [{ action: "lock.unlock", target: { entity_id: "lock.front" } }],
          request: "unlock the door at 3am",
        },
        assistant,
      );
      assert.strictEqual(risky.status, "asked");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a timer the house was down for runs late within 10 minutes, else is kept as missed to move; one heard nowhere is finished",
  () => {
    const { house, layer } = setup();
    return Effect.gen(function* () {
      const home = yield* connected;
      const timer = (alias: string, runInMinutes: number) =>
        Effect.map(
          home.saveAutomation(
            {
              alias,
              kind: "temporary",
              runInMinutes,
              actions: [{ action: "light.turn_off", target: { entity_id: "light.study" } }],
              request: `${alias} in ${runInMinutes}`,
            },
            assistant,
          ),
          (o) => o.id!,
        );
      const statusOf = (id: string) =>
        Effect.map(home.automations({}), (rows) => rows.find((r) => r.id === id)?.status);
      const ranAt = (id: string) =>
        Effect.map(Clock.currentTimeMillis, (now) =>
          house.put(`automation.${id}`, {
            ...house.states.get(`automation.${id}`)!,
            a: {
              ...house.states.get(`automation.${id}`)!.a,
              last_triggered: DateTime.formatIso(DateTime.makeUnsafe(now)),
            },
          }),
        );
      // The house's real "now" stamp, as HA writes it once a made-up run goes.
      const stamp = (id: string) =>
        house.states.get(`automation.${id}`)?.a["last_triggered"] === "now"
          ? ranAt(id)
          : Effect.void;

      const late = yield* timer("Study light off", 20);
      yield* TestClock.adjust("25 minutes");
      yield* home.tick;
      assert.include(house.calls, "automation.trigger");
      yield* stamp(late);
      yield* home.tick;
      assert.strictEqual(yield* statusOf(late), "finished");

      const missed = yield* timer("Study light off later", 20);
      house.down.trigger = true;
      yield* TestClock.adjust("35 minutes");
      yield* home.tick;
      house.down.trigger = false;
      assert.strictEqual(yield* statusOf(missed), "missed");
      const triggers = house.calls.filter((c) => c === "automation.trigger").length;
      assert.strictEqual(
        (yield* home.moveAutomation({ id: missed, runInMinutes: 5 }, assistant)).status,
        "done",
      );
      assert.strictEqual(yield* statusOf(missed), "active");
      yield* home.setAutomation({ id: missed, op: "delete" }, assistant);

      // HA ran it on time while this server was down, so its done event was never heard.
      const unheard = yield* timer("Fan off", 10);
      yield* TestClock.adjust("10 minutes");
      yield* ranAt(unheard);
      yield* TestClock.adjust("2 minutes");
      yield* home.tick;
      assert.strictEqual(yield* statusOf(unheard), "finished");
      assert.strictEqual(house.calls.filter((c) => c === "automation.trigger").length, triggers);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "never runs a toggle script for on or off: it points at the fan itself, whose state is read (00:42, 13 Nov)",
  () => {
    const { house, layer } = setup();
    return Effect.gen(function* () {
      const home = yield* connected;
      const viaScript = {
        domain: "script",
        service: "turn_on",
        target: { entity_id: "script.office_fan_toggle" },
        why: "Turn on the office fan.",
      };
      // The fan is on: the script would have turned it off.
      const refusedOn = yield* home.call(viaScript, assistant).pipe(Effect.flip);
      assert.include(refusedOn.why, "fan.fan (now on)");
      house.put("fan.fan", { s: "off", a: { friendly_name: "Fan" } });
      const refusedOff = yield* home.call(viaScript, assistant).pipe(Effect.flip);
      assert.include(refusedOff.why, "fan.fan (now off)");
      assert.notInclude(house.calls, "script.turn_on");
      const done = yield* home.call(
        {
          domain: "fan",
          service: "turn_on",
          target: { entity_id: "fan.fan" },
          why: "Turn on the office fan.",
        },
        assistant,
      );
      assert.strictEqual(done.status, "done");
      assert.strictEqual(house.states.get("fan.fan")?.s, "on");
      // His real office fan has no state in the house (01:29, 13 Nov): only a flip he agreed to.
      house.remove("fan.fan");
      const blind = yield* home.call(viaScript, assistant).pipe(Effect.flip);
      assert.include(blind.why, "cannot tell whether it is on");
      assert.notInclude(house.calls, "script.turn_on");
      const flipped = yield* home.call(
        { ...viaScript, service: "toggle", why: "He said yes, flip it." },
        assistant,
      );
      assert.strictEqual(flipped.status, "done");
      assert.include(house.calls, "script.toggle");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "tells offline from missing, never flips blind, checks the device after acting, and names two Lamps by room (13 Nov)",
  () => {
    const { house, layer } = setup();
    return Effect.gen(function* () {
      const home = yield* connected;
      // 07:19: his office fan was offline, dropped out of search, and was called missing.
      const fan = (yield* home.find({ text: "office fan" })).find(
        (e) => e.entityId === "fan.office_fan",
      );
      assert.strictEqual(fan?.state, "unavailable");
      const calls = house.calls.length;
      const away = yield* home
        .call(
          { domain: "fan", service: "turn_on", target: { entity_id: "fan.office_fan" }, why: "x" },
          assistant,
        )
        .pipe(Effect.flip);
      assert.include(away.why, "Office Fan is offline");
      // A toggle flips an on fan off; the state is known, so it is refused with it.
      const flip = yield* home
        .call(
          { domain: "fan", service: "toggle", target: { entity_id: "fan.fan" }, why: "on please" },
          assistant,
        )
        .pipe(Effect.flip);
      assert.include(flip.why, "Fan is on");
      assert.strictEqual(house.calls.length, calls);

      // 07:39: HA took turn_on, the fan stayed off, and she said done. Sent once more, then said as it is.
      house.put("light.stuck", { s: "off", a: { friendly_name: "Stuck light" } });
      const stuck = yield* home
        .call(
          { domain: "light", service: "turn_on", target: { entity_id: "light.stuck" }, why: "x" },
          assistant,
        )
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("7 seconds");
      const told = yield* Fiber.join(stuck);
      assert.strictEqual(told.status, "failed");
      assert.include(told.line, "Stuck light is still off");
      assert.strictEqual(house.calls.filter((c) => c === "light.turn_on").length, 2);

      house.put("light.desk_lamp", { s: "off", a: { friendly_name: "Lamp" } });
      house.put("light.bedside_lamp", { s: "on", a: { friendly_name: "Lamp" } });
      const lamps = yield* home.find({ text: "lamp" });
      assert.deepStrictEqual(lamps.map((e) => e.name).toSorted(), [
        "Lamp (Bedroom)",
        "Lamp (Office)",
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a dry run is checked and judged as for real, and changes, sends and keeps nothing",
  () => {
    const { house, layer } = setup();
    return Effect.gen(function* () {
      const home = yield* connected;
      const inbox = yield* TessayaPhoneInbox;
      const dry: HomeAssistantService.HomeActor = { who: "Tessaya", surface: "r1", dryRun: true };
      const on = yield* home.call(
        { domain: "fan", service: "turn_off", target: { entity_id: "fan.fan" }, why: "x" },
        dry,
      );
      assert.strictEqual(on.status, "done");
      assert.include(on.line, "Done: fan.turn_off");
      const unlock = yield* home.call(
        { domain: "lock", service: "unlock", target: { entity_id: "lock.front" }, why: "x" },
        dry,
      );
      assert.strictEqual(unlock.status, "asked");
      // 13 Nov: a replay's made-up entity came back "done"; checked for real, it is refused.
      const ghost = yield* home
        .call(
          { domain: "fan", service: "turn_on", target: { entity_id: "fan.ghost" }, why: "x" },
          dry,
        )
        .pipe(Effect.flip);
      assert.include(ghost.why, "no fan.ghost");
      assert.deepStrictEqual(house.calls, []);
      assert.strictEqual(house.states.get("fan.fan")?.s, "on");
      assert.deepStrictEqual(yield* inbox.pending, []);
      assert.deepStrictEqual(yield* home.actions(10), []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "pauses, resumes, deletes and undoes a rule on device state with no Home Assistant behind it",
  () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const home = yield* HomeAssistantService.HomeAssistantService;
      const sql = yield* SqlClient.SqlClient;
      const id = "tessaya_device_rule1";
      const rule = { name: "Phone battery low", deviceId: "phone-x", itemId: "power.battery_pct" };
      yield* sql`
        INSERT INTO fabric_home_automations (id, kind, expires_at, once, actor, surface, request, config, previous, last_op, status, created_at, updated_at)
        VALUES (${id}, 'permanent', NULL, 0, 'Tessaya', 'assistant', 'warn me', ${JSON.stringify(rule)}, NULL, 'create', 'active', 1, 1)
      `;
      const listed = () =>
        home.automations({}).pipe(Effect.map((rows) => rows.find((r) => r.id === id) ?? null));
      assert.deepStrictEqual((yield* listed())?.alias, "Phone battery low");
      yield* home.setAutomation({ id, op: "pause" }, assistant);
      assert.isTrue((yield* listed())?.paused);
      yield* home.setAutomation({ id, op: "resume" }, assistant);
      assert.isFalse((yield* listed())?.paused);
      const deleted = yield* home.setAutomation({ id, op: "delete" }, assistant);
      assert.strictEqual(deleted.undoId, id);
      assert.isNull(yield* listed());
      yield* home.undo(id, assistant);
      assert.isFalse((yield* listed())?.paused);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps several R1s, reads a server's one record from before, and finds each by id or key",
  () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const home = yield* HomeAssistantService.HomeAssistantService;
      const r1 = (id: string, key: string): HomeAssistantService.R1Device => ({
        deviceKey: key,
        deviceId: id,
        mqttUrl: null,
        mqttUser: null,
        mqttPass: null,
      });
      // A server set up before several R1s: its one record is still read, and kept on the next write.
      stored.set(
        "r1-device",
        new TextEncoder().encode(JSON.stringify(r1("r1-old", "o".repeat(32)))),
      );
      assert.deepStrictEqual(
        (yield* home.devices).map((d) => d.deviceId),
        ["r1-old"],
      );
      yield* home.putDevice(r1("r1-desk", "d".repeat(32)));
      yield* home.putDevice(r1("r1-kitchen", "k".repeat(32)));
      // The first R1 stays in the old place for a rollback to an older build.
      assert.include(new TextDecoder().decode(stored.get("r1-device")), "r1-old");
      const all = yield* home.devices;
      assert.deepStrictEqual(
        all.map((d) => d.deviceId),
        ["r1-old", "r1-desk", "r1-kitchen"],
      );
      assert.strictEqual(HomeAssistantService.r1ByKey(all, "k".repeat(32))?.deviceId, "r1-kitchen");
      assert.isNull(HomeAssistantService.r1ByKey(all, "x".repeat(32)));
      assert.isNull(HomeAssistantService.r1ByKey(all, ""));
      // Replacing one keeps the others; a record with no id is refused.
      yield* home.putDevice(r1("r1-desk", "e".repeat(32)));
      assert.strictEqual(
        HomeAssistantService.r1ById(yield* home.devices, "r1-desk")?.deviceKey,
        "e".repeat(32),
      );
      const noId = yield* home
        .putDevice({ ...r1("x", "z".repeat(32)), deviceId: null })
        .pipe(Effect.flip);
      assert.include(noId.why, "id");
      yield* home.removeDevice("r1-old");
      assert.deepStrictEqual(
        (yield* home.devices).map((d) => d.deviceId),
        ["r1-desk", "r1-kitchen"],
      );
      yield* home.removeDevice(null);
      assert.lengthOf(yield* home.devices, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "his own voice runs the pump and its timer with no card; anyone else's request is one card, answered once",
  () => {
    const { house, layer } = setup();
    const tessel: HomeAssistantService.HomeActor = { who: "Tessaya via Tessel", surface: "r1" };
    const request = (member: string | null) =>
      Effect.gen(function* () {
        const home = yield* HomeAssistantService.HomeAssistantService;
        const on = yield* home.call(
          {
            domain: "switch",
            service: "turn_on",
            target: { entity_id: "switch.sonoff_1" },
            why: "turn on the water pump for fifty minutes",
          },
          tessel,
        );
        const timer = yield* home.saveAutomation(
          {
            alias: "Water pump off after fifty minutes",
            kind: "temporary",
            runInMinutes: 50,
            actions: [{ action: "switch.turn_off", target: { entity_id: "switch.sonoff_1" } }],
            request: "turn on the water pump for fifty minutes",
          },
          tessel,
        );
        return [on, timer] as const;
      }).pipe(
        Effect.provideService(
          TurnOrigin,
          member === null
            ? { kind: "device", id: "r1", label: "Tessel", member: null, assurance: 0 }
            : { kind: "device", id: "r1", label: "Tessel", member, assurance: 2 },
        ),
      );
    return Effect.gen(function* () {
      const home = yield* connected;
      const inbox = yield* TessayaPhoneInbox;
      // 19 Nov 22:25: both asked him, once for the switch and once for its timer.
      const [on, timer] = yield* request(OWNER_MEMBER_ID);
      assert.deepStrictEqual([on.status, timer.status], ["done", "done"]);
      // Said by its clock time, so a misheard "fifty" is caught when she says it back.
      assert.match(timer.line, /runs in 50 minutes, at \d\d:\d\d\) as tessaya_temporary_/);
      // "No, fifteen": the same timer changes; there is never a second.
      const fifteen = yield* home
        .saveAutomation(
          {
            alias: "Water pump off after fifteen minutes",
            kind: "temporary",
            runInMinutes: 15,
            actions: [{ action: "switch.turn_off", target: { entity_id: "switch.sonoff_1" } }],
            request: "no, fifteen",
          },
          tessel,
        )
        .pipe(
          Effect.provideService(TurnOrigin, {
            kind: "device",
            id: "r1",
            label: "Tessel",
            member: OWNER_MEMBER_ID,
            assurance: 2,
          }),
        );
      assert.strictEqual(fifteen.id, timer.id);
      assert.lengthOf(
        (yield* home.automations({})).filter((a) => a.id.startsWith("tessaya_temporary_")),
        1,
      );
      assert.strictEqual(house.states.get("switch.sonoff_1")?.s, "on");
      assert.lengthOf(yield* inbox.pending, 0);
      // His own voice still asks for a lock.
      const unlock = yield* home
        .call(
          { domain: "lock", service: "unlock", target: { entity_id: "lock.front" }, why: "x" },
          tessel,
        )
        .pipe(
          Effect.provideService(TurnOrigin, {
            kind: "device",
            id: "r1",
            label: "Tessel",
            member: OWNER_MEMBER_ID,
            assurance: 2,
          }),
        );
      assert.strictEqual(unlock.status, "asked");
      yield* home.answer(unlock.id!, false);

      yield* home.call(
        {
          domain: "switch",
          service: "turn_off",
          target: { entity_id: "switch.sonoff_1" },
          why: "x",
        },
        { who: "the Director", surface: "settings", approved: true },
      );
      yield* TestClock.adjust("2 minutes");
      const [guestOn, guestTimer] = yield* request(null);
      assert.deepStrictEqual([guestOn.status, guestTimer.status], ["asked", "asked"]);
      assert.lengthOf(yield* inbox.pending, 1);
      assert.isTrue(yield* inbox.answerPrompt(`home-${guestOn.id}`, 0));
      yield* home.tick;
      assert.strictEqual(house.states.get("switch.sonoff_1")?.s, "on");
      assert.lengthOf(yield* home.pending, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "his standing yes for a device runs it with no card from his own turn, and only his",
  () => {
    const { house, layer } = setup();
    const his = {
      kind: "device",
      id: "r1",
      label: "Tessel",
      member: OWNER_MEMBER_ID,
      assurance: 2,
      hisVoice: true,
    } as const;
    return Effect.gen(function* () {
      const home = yield* connected;
      const consent = yield* Consent;
      const unlock = {
        domain: "lock",
        service: "unlock",
        target: { entity_id: "lock.front" },
        why: "let me in",
      };
      const tessel: HomeAssistantService.HomeActor = { who: "Tessaya via Tessel", surface: "r1" };
      assert.strictEqual(
        (yield* home.call(unlock, tessel).pipe(Effect.provideService(TurnOrigin, his))).status,
        "asked",
      );
      // "Remember, you don't need approval for the front door."
      yield* consent.set(houseGrant("lock.front", "Front door"), true, { member: OWNER_MEMBER_ID });
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual(
        (yield* home.call(unlock, tessel).pipe(Effect.provideService(TurnOrigin, his))).status,
        "done",
      );
      assert.strictEqual(house.states.get("lock.front")?.s, "unlocked");
      // A guest's voice is asked as before.
      const guest = { ...his, member: null, assurance: 0 as const, hisVoice: false };
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual(
        (yield* home.call(unlock, tessel).pipe(Effect.provideService(TurnOrigin, guest))).status,
        "asked",
      );
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provideMerge(ConsentLayer.pipe(Layer.provide(TessayaDatabaseMemory)))),
      ),
    );
  },
);

it.effect(
  "two people, one fan (CS4): the owner wins, a child cannot override, anyone else is told and asking again is their yes",
  () => {
    const { house, layer } = setup();
    const household = Layer.mock(TessayaHousehold)({
      grantsOf: (member: string) =>
        Effect.succeed({
          role: member === "kid" ? "child" : "adult",
          machine: false,
          name: member,
        }),
    } as never);
    const as = (member: string | null) => (service: "turn_on" | "turn_off") =>
      Effect.gen(function* () {
        const home = yield* HomeAssistantService.HomeAssistantService;
        return yield* home.call(
          { domain: "fan", service, target: { entity_id: "fan.fan" }, why: "asked" },
          assistant,
        );
      }).pipe(
        Effect.provideService(
          TurnOrigin,
          member === null ? null : { kind: "device", id: "r1", label: "R1", member, assurance: 2 },
        ),
      );
    return Effect.gen(function* () {
      yield* connected;
      assert.strictEqual((yield* as("sara")("turn_off")).status, "done");
      const kid = yield* as("kid")("turn_on").pipe(Effect.flip);
      assert.include(kid.why, "a child cannot change it over them");
      const omar = yield* as("omar")("turn_on").pipe(Effect.flip);
      assert.include(omar.why, "sara set Fan");
      assert.strictEqual(house.states.get("fan.fan")?.s, "off");
      // Told, he asks again: that is his yes.
      const again = yield* as("omar")("turn_on");
      assert.strictEqual(again.status, "done");
      assert.include(again.line, "sara had set Fan");
      // The owner (no turn origin: Settings, his outside agents) goes through, and hears whose setting it was.
      const owner = yield* as(null)("turn_off");
      assert.include(owner.line, "changed it over theirs");
      // Past the window it is an ordinary ask.
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual((yield* as("kid")("turn_on")).status, "done");
    }).pipe(Effect.provide(Layer.merge(layer, household)));
  },
);

it.effect(
  "with no connection here, the house through a linked server reads as connected, and off with none",
  () => {
    // 19 Nov 05:20: on a server with no token she said the house wasn't connected; a linked one had it.
    const peers = (answers: boolean) =>
      Layer.mergeAll(
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(true),
          list: Effect.succeed([
            { environmentId: EnvironmentId.make("env-brain"), label: "brain", status: "reachable" },
          ] as never),
        }),
        Layer.mock(PeerMcpClient.PeerMcpClient)({
          call: () =>
            Effect.succeed(
              answers
                ? { ok: true, value: [] }
                : { ok: false, error: "Home Assistant is not connected." },
            ) as never,
        }),
      );
    const statusWith = (answers: boolean) => {
      const { layer } = setup();
      return Effect.flatMap(HomeAssistantService.HomeAssistantService, (h) => h.status).pipe(
        Effect.provide(layer.pipe(Layer.provide(peers(answers)))),
      );
    };
    return Effect.gen(function* () {
      assert.strictEqual((yield* statusWith(true)).state, "connected");
      assert.strictEqual((yield* statusWith(false)).state, "off");
    });
  },
);
