/**
 * The `baton.devices.call` door: decodes one op's arguments, calls one service method, and answers ok with a value
 * or not ok with a sentence. The RPC handler and the MCP tools both come through here.
 */
import {
  BATON_DEVICES_ACT_OPS,
  BATON_DEVICES_OWNER_OPS,
  BATON_DEVICES_READ_OPS,
  DEVICE_TRANSPORTS,
  DeviceTagAction,
  R1_LEDS,
  R1_MOODS,
  type BatonDevicesCallInput,
  type BatonDevicesCallResult,
} from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  HomeDevices,
  type DeviceActor,
  type DeviceCommand,
  type DeviceRefusedError,
} from "./HomeDevices.ts";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Id = Text(60);

type Run = (by: DeviceActor) => Effect.Effect<unknown, DeviceRefusedError, HomeDevices>;
const op =
  <S extends Schema.Decoder<unknown>>(
    schema: S,
    run: (
      args: S["Type"],
      devices: HomeDevices["Service"],
      by: DeviceActor,
    ) => Effect.Effect<unknown, DeviceRefusedError>,
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

export const serveDevicesCall = Effect.fn("DeviceCalls.serve")(function* (
  input: BatonDevicesCallInput,
  by: DeviceActor,
) {
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
