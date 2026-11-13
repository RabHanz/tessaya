/**
 * The `baton.home.*` door: decodes one op's arguments, calls one service method, and answers ok with a value or not
 * ok with a sentence. The RPC handlers, the MCP tools and the R1 endpoint all come through here.
 */
import {
  BATON_HOME_ACT_OPS,
  BATON_HOME_ANSWER_OPS,
  BATON_HOME_READ_OPS,
  HOME_AUTOMATION_KINDS,
  HOME_TIERS,
  type BatonHomeCallInput,
  type BatonHomeCallResult,
} from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  HomeAssistantService,
  type HomeActor,
  type HomeRefusedError,
} from "./HomeAssistantService.ts";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Obj = Schema.Record(Schema.String, Schema.Unknown);
const List = Schema.Array(Schema.Unknown);

export const HomeDoArgs = Schema.Struct({
  domain: Text(60),
  service: Text(80),
  target: Schema.optionalKey(Obj),
  data: Schema.optionalKey(Obj),
  why: Text(500),
});
export const HomeAutomationSaveArgs = Schema.Struct({
  id: Schema.optionalKey(Text(120)),
  alias: Text(120),
  description: Schema.optionalKey(Text(500)),
  kind: Schema.Literals(HOME_AUTOMATION_KINDS),
  runInMinutes: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 60 * 24 })),
  ),
  expiresInMinutes: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 60 * 24 * 90 })),
  ),
  expiresAt: Schema.optionalKey(Text(40)),
  once: Schema.optionalKey(Schema.Boolean),
  triggers: Schema.optionalKey(List),
  conditions: Schema.optionalKey(List),
  actions: List,
  mode: Schema.optionalKey(Schema.Literals(["single", "restart", "queued", "parallel"])),
  request: Text(500),
});
export const HomeAutomationSetArgs = Schema.Struct({
  id: Text(120),
  op: Schema.Literals(["pause", "resume", "delete"]),
});

type Run = (by: HomeActor) => Effect.Effect<unknown, HomeRefusedError, HomeAssistantService>;
const op =
  <S extends Schema.Decoder<unknown>>(
    schema: S,
    run: (
      args: S["Type"],
      home: HomeAssistantService["Service"],
      by: HomeActor,
    ) => Effect.Effect<unknown, HomeRefusedError>,
  ) =>
  (args: unknown): Run | null => {
    const decoded = Schema.decodeUnknownOption(schema)(args);
    return decoded._tag === "None"
      ? null
      : (by) => Effect.flatMap(HomeAssistantService, (home) => run(decoded.value, home, by));
  };
const None = Schema.Struct({});

const OPS: Readonly<Record<string, (args: unknown) => Run | null>> = {
  status: op(None, (_, home) => home.status),
  find: op(
    Schema.Struct({
      text: Schema.optionalKey(Text(200)),
      area: Schema.optionalKey(Text(100)),
      domain: Schema.optionalKey(Text(60)),
      limit: Schema.optionalKey(Schema.Number),
    }),
    (a, home) => home.find(a),
  ),
  state: op(
    Schema.Struct({ entityId: Text(200), since: Schema.optionalKey(Text(40)) }),
    (a, home) =>
      a.since === undefined ? home.state(a.entityId) : home.history(a.entityId, a.since),
  ),
  history: op(Schema.Struct({ entityId: Text(200), since: Text(40) }), (a, home) =>
    home.history(a.entityId, a.since),
  ),
  services: op(Schema.Struct({ domain: Schema.optionalKey(Text(60)) }), (a, home) =>
    home.services(a.domain),
  ),
  automations: op(Schema.Struct({ all: Schema.optionalKey(Schema.Boolean) }), (a, home) =>
    home.automations(a),
  ),
  actions: op(Schema.Struct({ limit: Schema.optionalKey(Schema.Number) }), (a, home) =>
    home.actions(a.limit ?? 20),
  ),
  pending: op(None, (_, home) => home.pending),
  overrides: op(None, (_, home) => home.overrides),
  connect: op(
    Schema.Struct({
      url: Text(300),
      fallbackUrl: Schema.optionalKey(Text(300)),
      token: Text(2000),
    }),
    (a, home) => home.connect(a),
  ),
  disconnect: op(None, (_, home) => home.disconnect),
  do: op(HomeDoArgs, (a, home, by) => home.call(a, by)),
  undo: op(Schema.Struct({ id: Text(120) }), (a, home, by) => home.undo(a.id, by)),
  automationSave: op(HomeAutomationSaveArgs, (a, home, by) => home.saveAutomation(a, by)),
  automationSet: op(HomeAutomationSetArgs, (a, home, by) => home.setAutomation(a, by)),
  override: op(
    Schema.Struct({ entityId: Text(200), tier: Schema.NullOr(Schema.Literals(HOME_TIERS)) }),
    (a, home) => home.setOverride(a.entityId, a.tier),
  ),
  r1Setup: op(
    Schema.Struct({
      deviceKey: Text(200),
      mqttUrl: Schema.optionalKey(Text(200)),
      mqttUser: Schema.optionalKey(Text(100)),
      mqttPass: Schema.optionalKey(Text(200)),
      deviceId: Schema.optionalKey(Text(60)),
      devicePass: Schema.optionalKey(Text(200)),
    }),
    (a, home) =>
      home.putDevice({
        deviceKey: a.deviceKey,
        mqttUrl: a.mqttUrl ?? null,
        mqttUser: a.mqttUser ?? null,
        mqttPass: a.mqttPass ?? null,
        deviceId: a.deviceId ?? null,
        devicePass: a.devicePass ?? null,
      }),
  ),
  // One R1 by id, or every R1 (the older form with no arguments).
  r1Forget: op(Schema.Struct({ deviceId: Schema.optionalKey(Text(60)) }), (a, home) =>
    home.removeDevice(a.deviceId ?? null),
  ),
  answer: op(Schema.Struct({ id: Text(120), yes: Schema.Boolean }), (a, home) =>
    home.answer(a.id, a.yes),
  ),
};

export type HomeCallKind = BatonHomeCallInput["kind"];

export const serveHomeCall = Effect.fn("HomeCalls.serve")(function* (
  input: BatonHomeCallInput,
  by: HomeActor,
) {
  const kind = input.kind;
  const allowed: ReadonlyArray<string> =
    kind === "read"
      ? BATON_HOME_READ_OPS
      : kind === "act"
        ? BATON_HOME_ACT_OPS
        : BATON_HOME_ANSWER_OPS;
  // A read method never changes anything, whatever op it is sent.
  const decode = allowed.includes(input.op) ? OPS[input.op] : undefined;
  if (decode === undefined)
    return { ok: false, error: "That request is not allowed here." } satisfies BatonHomeCallResult;
  // Who is asking travels beside the op's own arguments; each op's schema ignores it.
  const run = decode(input.args ?? {});
  if (run === null)
    return {
      ok: false,
      error: `The arguments for ${input.op} are not right.`,
    } satisfies BatonHomeCallResult;
  return yield* run(by).pipe(
    Effect.map((value): BatonHomeCallResult => ({ ok: true, value })),
    Effect.catchTags({
      HomeRefusedError: (e) => Effect.succeed<BatonHomeCallResult>({ ok: false, error: e.why }),
    }),
  );
});

/**
 * Who a client call is from: Settings (him, no yes given) unless his desktop assistant says so. `approved` reaches
 * here only from his desktop's own session (BatonRpcAuthorization requires hands-host for it).
 */
export const homeActorOf = (input: BatonHomeCallInput): HomeActor => {
  const args = input.args ?? {};
  const assistant = args["surface"] === "assistant";
  return {
    who: assistant && typeof args["who"] === "string" ? args["who"].slice(0, 40) : "the Director",
    surface: assistant ? "assistant" : "settings",
    approved: args["approved"] === true,
  };
};
