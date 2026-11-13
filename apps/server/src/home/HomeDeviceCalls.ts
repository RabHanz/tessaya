/**
 * The `baton.devices.call` door: decodes one op's arguments, calls one service method, and answers ok with a value
 * or not ok with a sentence. The RPC handler and the MCP tools both come through here.
 */
import {
  BATON_DEVICES_ACT_OPS,
  DEVICE_DISPLAY_SETS,
  DEVICE_SPEAKER_ACTIONS,
  DEVICE_SPEAKER_OUTPUTS,
  BATON_DEVICES_OWNER_OPS,
  BATON_DEVICES_READ_OPS,
  DevicePublish,
  DEVICE_TRANSPORTS,
  DeviceTagAction,
  R1_KEY_SLOTS,
  R1KeyBinding,
  R1_LEDS,
  R1_MOODS,
  type R1KeySlot,
  type BatonDevicesCallInput,
  type BatonDevicesCallResult,
} from "@t3tools/baton-contracts";
import { itemsView, readView } from "@t3tools/baton-shared/deviceItems";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { HomeDevices, MAC, type DeviceActor, type DeviceCommand } from "./HomeDevices.ts";
import { DeviceRefusedError, DeviceRegistry } from "./DeviceRegistry.ts";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Id = Text(60);

type Run = (
  by: DeviceActor,
) => Effect.Effect<unknown, DeviceRefusedError, HomeDevices | DeviceRegistry>;
const op =
  <S extends Schema.Decoder<unknown>>(
    schema: S,
    run: (
      args: S["Type"],
      devices: HomeDevices["Service"],
      by: DeviceActor,
    ) => Effect.Effect<unknown, DeviceRefusedError, DeviceRegistry>,
  ) =>
  (args: unknown): Run | null => {
    const decoded = Schema.decodeUnknownOption(schema)(args);
    return decoded._tag === "None"
      ? null
      : (by) => Effect.flatMap(HomeDevices, (devices) => run(decoded.value, devices, by));
  };
const ById = Schema.Struct({ id: Id });
/** A device command with no fields of its own. */
const plain = (command: DeviceCommand) =>
  op(ById, (a, devices, by) => devices.command(a.id, command, by));

const OPS: Readonly<Record<string, (args: unknown) => Run | null>> = {
  list: op(Schema.Struct({}), (_, devices) => devices.overview),
  items: op(Schema.Struct({}), () =>
    Effect.map(
      Effect.flatMap(DeviceRegistry, (r) => r.list),
      (all) => ({ devices: itemsView(all) }),
    ),
  ),
  read: op(
    Schema.Struct({
      id: Id,
      items: Schema.optionalKey(Schema.Array(Text(80)).check(Schema.isMaxLength(50))),
    }),
    (a) =>
      Effect.gen(function* () {
        const d = yield* Effect.flatMap(DeviceRegistry, (r) => r.get(a.id));
        if (d === null)
          return yield* new DeviceRefusedError({ why: `No device called ${a.id} is known here.` });
        return readView(d, a.items, yield* Clock.currentTimeMillis);
      }),
  ),
  set: op(
    Schema.Struct({
      id: Id,
      itemId: Text(80),
      value: Schema.optionalKey(Schema.Unknown),
      confirmed: Schema.optionalKey(Schema.Boolean),
    }),
    (a, devices, by) =>
      devices.command(
        a.id,
        {
          op: "item",
          itemId: a.itemId,
          value: a.value ?? null,
          ...(a.confirmed === undefined ? {} : { confirmed: a.confirmed }),
        },
        by,
      ),
  ),
  eye: op(
    Schema.Struct({
      id: Id,
      mood: Schema.Literals(R1_MOODS),
      holdMs: Schema.optionalKey(Schema.Number),
    }),
    (a, devices, by) =>
      devices.command(
        a.id,
        { op: "eye", mood: a.mood, ...(a.holdMs === undefined ? {} : { holdMs: a.holdMs }) },
        by,
      ),
  ),
  led: op(Schema.Struct({ id: Id, color: Schema.Literals(R1_LEDS) }), (a, devices, by) =>
    devices.command(a.id, { op: "led", color: a.color }, by),
  ),
  vibrate: op(Schema.Struct({ id: Id, ms: Schema.optionalKey(Schema.Number) }), (a, devices, by) =>
    devices.command(a.id, { op: "vibrate", ms: a.ms ?? 120 }, by),
  ),
  say: op(Schema.Struct({ id: Id, text: Text(400) }), (a, devices, by) =>
    devices.command(a.id, { op: "say", text: a.text }, by),
  ),
  mute: op(Schema.Struct({ id: Id, muted: Schema.Boolean }), (a, devices, by) =>
    devices.command(a.id, { op: "mute", muted: a.muted }, by),
  ),
  earcons: op(Schema.Struct({ id: Id, on: Schema.Boolean }), (a, devices, by) =>
    devices.command(a.id, { op: "earcons", on: a.on }, by),
  ),
  volume: op(
    Schema.Struct({
      id: Id,
      to: Schema.Union([
        Schema.Literals(["up", "down", "max", "default"]),
        Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
      ]),
    }),
    (a, devices, by) => devices.command(a.id, { op: "volume", to: a.to }, by),
  ),
  keyBind: op(
    Schema.Struct({
      id: Id,
      slot: Schema.Literals(Object.keys(R1_KEY_SLOTS) as Array<R1KeySlot>),
      bind: R1KeyBinding,
    }),
    (a, devices, by) => devices.command(a.id, { op: "keyBind", slot: a.slot, bind: a.bind }, by),
  ),
  display: op(
    Schema.Struct({ id: Id, set: Schema.Literals(DEVICE_DISPLAY_SETS) }),
    (a, devices, by) => devices.command(a.id, { op: "display", set: a.set }, by),
  ),
  transport: op(
    Schema.Struct({ id: Id, transport: Schema.Literals(DEVICE_TRANSPORTS) }),
    (a, devices, by) => devices.command(a.id, { op: "transport", transport: a.transport }, by),
  ),
  transportConfirm: plain({ op: "transportConfirm" }),
  transportRevert: plain({ op: "transportRevert" }),
  enrol: op(
    Schema.Struct({ id: Id, cancel: Schema.optionalKey(Schema.Boolean) }),
    (a, devices, by) => devices.command(a.id, { op: "enrol", cancel: a.cancel === true }, by),
  ),
  diag: plain({ op: "diag" }),
  forget: plain({ op: "forget" }),
  speaker: op(
    Schema.Struct({
      id: Id,
      action: Schema.Literals(DEVICE_SPEAKER_ACTIONS),
      mac: Schema.optionalKey(Schema.String.check(Schema.isPattern(MAC))),
      name: Schema.optionalKey(Text(32)),
      output: Schema.optionalKey(Schema.Literals(DEVICE_SPEAKER_OUTPUTS)),
    }),
    (a, devices, by) => devices.command(a.id, { op: "speaker", ...a }, by),
  ),
  reboot: plain({ op: "reboot" }),
  camera: plain({ op: "camera" }),
  nfcAssign: op(
    Schema.Struct({
      uid: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F:]{4,40}$/)),
      label: Text(60),
      action: DeviceTagAction,
    }),
    (a, devices) => devices.assignTag(a.uid, a.label, a.action),
  ),
  nfcRemove: op(Schema.Struct({ uid: Text(40) }), (a, devices) => devices.removeTag(a.uid)),
  cameraView: op(ById, (a, devices) => devices.cameraView(a.id)),
  cameraClear: op(ById, (a, devices) => devices.cameraClear(a.id)),
};

export type DevicesCallKind = BatonDevicesCallInput["kind"];

const decodePublish = Schema.decodeUnknownOption(DevicePublish);

/** A desktop or phone reporting itself: its manifest and values in, the writes waiting for it out. */
const servePublish = Effect.fn("DeviceCalls.publish")(function* (args: unknown) {
  const decoded = decodePublish(args);
  if (decoded._tag === "None")
    return {
      ok: false,
      error: "The device report is not in the expected shape.",
    } satisfies BatonDevicesCallResult;
  const p = decoded.value;
  const registry = yield* DeviceRegistry;
  if (p.manifest !== undefined) {
    if (p.manifest.deviceId !== p.deviceId)
      return {
        ok: false,
        error: "The manifest is for another device.",
      } satisfies BatonDevicesCallResult;
    const refused = yield* registry.publish("client", p.manifest);
    if (refused !== null) return { ok: false, error: refused } satisfies BatonDevicesCallResult;
  }
  yield* registry.report("client", p.deviceId, p.values ?? []);
  const writes = yield* registry.take(p.deviceId, p.acks ?? [], p.waitMs ?? 0);
  return { ok: true, value: { writes } } satisfies BatonDevicesCallResult;
});

export const serveDevicesCall = Effect.fn("DeviceCalls.serve")(function* (
  input: BatonDevicesCallInput,
  by: DeviceActor,
) {
  if (input.kind === "vessel")
    return input.op === "publish"
      ? yield* servePublish(input.args ?? {})
      : ({
          ok: false,
          error: "That request is not allowed here.",
        } satisfies BatonDevicesCallResult);
  const allowed: ReadonlyArray<string> =
    input.kind === "read"
      ? BATON_DEVICES_READ_OPS
      : input.kind === "act"
        ? BATON_DEVICES_ACT_OPS
        : BATON_DEVICES_OWNER_OPS;
  const decode = allowed.includes(input.op) ? OPS[input.op] : undefined;
  if (decode === undefined)
    return {
      ok: false,
      error: "That request is not allowed here.",
    } satisfies BatonDevicesCallResult;
  const run = decode(input.args ?? {});
  if (run === null)
    return {
      ok: false,
      error: `The arguments for ${input.op} are not right.`,
    } satisfies BatonDevicesCallResult;
  return yield* run(by).pipe(
    Effect.map((value): BatonDevicesCallResult => ({ ok: true, value })),
    Effect.catchTags({
      DeviceRefusedError: (e) =>
        Effect.succeed<BatonDevicesCallResult>({ ok: false, error: e.why }),
    }),
  );
});

/**
 * Who a client call is from: him in Settings → Devices, unless his desktop assistant says so; then camera and reboot
 * ask on his phone even though the desktop's session holds the approval scope.
 */
export const devicesActorOf = (input: BatonDevicesCallInput): DeviceActor => {
  const args = input.args ?? {};
  return args["surface"] === "assistant"
    ? {
        who: typeof args["who"] === "string" ? args["who"].slice(0, 40) : "his assistant",
        surface: "assistant",
      }
    : { who: "the Director", surface: "settings" };
};
