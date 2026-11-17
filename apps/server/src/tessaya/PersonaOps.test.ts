// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import type { ActionEnvelope } from "@t3tools/tessaya-shared/provenance";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { onAction } from "../provenance/ActionLog.ts";
import { TessayaHousehold } from "./TessayaHousehold.ts";
import { TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import {
  RELAY_KEY_SECRET,
  PersonaOps,
  layerWith,
  tokenSecretName,
  type PersonaOpsActor,
  type PersonaOpsConfig,
} from "./PersonaOps.ts";
import { relayKeyOf } from "./personaOpsRelay.ts";

const MOCK = NodePath.join(import.meta.dirname, "__fixtures__", "persona-ops-mcp-mock.mjs");
const WORKER = "00000000-0000-4000-8000-00000000aaaa";
const TOKEN = "vos_mcp_test_token";

const sebastian: PersonaOpsActor = {
  persona: "Sebastian",
  hisVoice: false,
  score: null,
  tainted: false,
  via: "the desk",
};
const hisVoice: PersonaOpsActor = { ...sebastian, hisVoice: true, score: 0.71 };

const setup = (
  options: {
    readonly relay?: boolean;
    readonly token?: string;
    readonly home?: string | null;
  } = {},
) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "persona-ops-mock-"));
  const mockLog = NodePath.join(dir, "calls.jsonl");
  const values = new Map<string, Uint8Array>();
  values.set(tokenSecretName("sebastian"), new TextEncoder().encode(`${options.token ?? TOKEN}\n`));
  const secrets = Layer.succeed(
    ServerSecretStore,
    ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  );
  const cards: Array<{ id: string; title: string; detail: string; needs?: string }> = [];
  const inbox = Layer.succeed(TessayaPhoneInbox, {
    mirror: (card: (typeof cards)[number]) => Effect.sync(() => void cards.push(card)),
    promptAnswer: () => Effect.succeed(null),
    cardLife: Effect.succeed(0),
    closePrompt: () => Effect.void,
  } as unknown as TessayaPhoneInbox["Service"]);
  const household = Layer.succeed(TessayaHousehold, {
    homeOn: Effect.succeed(options.home ?? null),
  } as unknown as TessayaHousehold["Service"]);
  const env: Record<string, string> = {
    MOCK_WORKER_ID: WORKER,
    MOCK_TOKEN: TOKEN,
    MOCK_LOG: mockLog,
    MOCK_DELEGATES: JSON.stringify([
      { platform: "tiktok", account: "his_handle", warmup: true, post: true },
    ]),
  };
  const config: PersonaOpsConfig = {
    command: process.execPath,
    args: [MOCK],
    uiUrl: "https://cockpit.example/",
    workerIdEnv: "OPS_WORKER_ID",
    tokenEnv: "OPS_TOKEN",
    relay: options.relay ?? false,
    env,
    personas: { sebastian: WORKER },
  };
  const events: ActionEnvelope[] = [];
  const stop = onAction((e) => void events.push(e));
  const layer = layerWith(config).pipe(Layer.provide(Layer.mergeAll(secrets, inbox, household)));
  const calls = () =>
    NodeFS.existsSync(mockLog)
      ? NodeFS.readFileSync(mockLog, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
      : [];
  // Read when the connection opens, which is after the key is first asked for.
  const withRelayPub = (pub: string) => void (env["MOCK_RELAY_PUBKEY"] = pub);
  return { layer, cards, events, calls, values, stop, withRelayPub };
};

const run = <A, E>(
  t: ReturnType<typeof setup>,
  body: (vos: PersonaOps["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(PersonaOps, body).pipe(
    Effect.provide(t.layer),
    Effect.ensuring(Effect.sync(t.stop)),
  );

it.live(
  "acts as the persona's own worker, and the ops system's refusals come back as its words",
  () => {
    const t = setup();
    return run(t, (vos) =>
      Effect.gen(function* () {
        const status = yield* vos.act(sebastian, { op: "status" });
        assert.strictEqual(status.status, "ok");
        const notMine = yield* vos.act(sebastian, {
          op: "schedule",
          deviceSerial: "QV772MAWEG",
          platform: "instagram",
          account: "someone_else",
          nicheTerms: ["fitness"],
          minutesPerDay: 20,
          daysBeforeFirstPost: 7,
          enabled: true,
        });
        assert.strictEqual(notMine.status, "refused");
        assert.include(notMine.line, "no delegation");
        const mine = yield* vos.act(sebastian, {
          op: "schedule",
          deviceSerial: "QV772MAWEG",
          platform: "tiktok",
          account: "his_handle",
          nicheTerms: ["fitness"],
          minutesPerDay: 20,
          daysBeforeFirstPost: 7,
          enabled: true,
        });
        assert.strictEqual(mine.status, "ok");
        const planned = t.calls().find((c) => c.name === "device_warmup_schedule")!;
        assert.deepStrictEqual(Object.keys(planned.args).toSorted(), [
          "deviceSerial",
          "enabled",
          "plan",
        ]);
        assert.include(planned.args["plan"] as object, { watchOnly: true, interactions: "none" });
        // Each call is one ActionLog event, the persona its actor.
        const logged = t.events.filter((e) => e.kind === "ops.call");
        assert.strictEqual(logged.length, 3);
        assert.deepStrictEqual(logged[0]!.actor, {
          kind: "persona",
          id: "tessaya:sebastian",
          certainty: 1,
        });
        assert.strictEqual(logged[1]!.outcome, "refused");
      }),
    );
  },
);

it.live(
  "a post files the ops system's approval: one card in the inbox, the ActionLog id as its key",
  () => {
    const t = setup();
    return run(t, (vos) =>
      Effect.gen(function* () {
        const post = yield* vos.act(sebastian, {
          op: "post",
          deviceSerial: "QV772MAWEG",
          platform: "tiktok",
          account: "his_handle",
          mediaRef: "/srv/clips/one.mp4",
          caption: "First one",
        });
        assert.strictEqual(post.status, "approval");
        const sent = t.calls().find((c) => c.name === "device_post_enqueue")!;
        assert.strictEqual(sent.args["idempotencyKey"], `tessaya:${post.actionId}`);
        const card = t.cards.find((c) => c.id === "ops:11111111-1111-4111-8111-111111111111");
        assert.strictEqual(card?.needs, "cloud-approve");
        assert.include(card?.detail ?? "", "@his_handle");
        const event = t.events.find((e) => e.id === post.actionId);
        assert.strictEqual(event?.outcome, "approval");
        assert.include(event?.data as object, {
          approvalId: "11111111-1111-4111-8111-111111111111",
        });
      }),
    );
  },
);

it.live(
  "only his verified voice relays a decision, signed by the brain, and only once relays are on",
  () => {
    const off = setup();
    const offResult = run(off, (vos) =>
      vos.act(hisVoice, {
        op: "answer",
        approvalId: "11111111-1111-4111-8111-111111111111",
        decision: "approve",
      }),
    );
    const on = setup({ relay: true });
    return Effect.gen(function* () {
      const pointed = yield* offResult;
      assert.strictEqual(pointed.status, "refused");
      assert.include(pointed.line, "https://cockpit.example/approvals");
      yield* run(on, (vos) =>
        Effect.gen(function* () {
          const key = (yield* vos.relayKey)!;
          assert.match(key.keyId, /^tessaya-brain-[0-9a-f]{16}$/);
          on.withRelayPub(key.publicKeyPem);
          // The key is kept in the brain's secrets, and the same key comes back.
          assert.strictEqual(
            relayKeyOf(new TextDecoder().decode(on.values.get(RELAY_KEY_SECRET)!)).keyId,
            key.keyId,
          );
          const unverified = yield* vos.act(
            { ...hisVoice, hisVoice: false },
            {
              op: "answer",
              approvalId: "11111111-1111-4111-8111-111111111111",
              decision: "approve",
            },
          );
          assert.strictEqual(unverified.status, "refused");
          const relayed = yield* vos.act(hisVoice, {
            op: "answer",
            approvalId: "11111111-1111-4111-8111-111111111111",
            decision: "approve",
          });
          assert.strictEqual(relayed.status, "ok", relayed.line);
          const sent = on.calls().find((c) => c.name === "approval_relay")!.args;
          assert.strictEqual(sent["relayer_action_id"], relayed.actionId);
          assert.deepStrictEqual(sent["verification"], { method: "voice_owner", score: 0.71 });
          assert.strictEqual(sent["key_id"], key.keyId);
        }),
      );
    });
  },
);

it.live("runs only on the brain, and revoking takes the persona's token away", () => {
  const elsewhere = setup({ home: "the-brain" });
  const t = setup();
  return Effect.gen(function* () {
    const away = yield* run(elsewhere, (vos) => vos.act(sebastian, { op: "status" }));
    assert.strictEqual(away.status, "error");
    assert.include(away.line, "brain (the-brain)");
    yield* run(t, (vos) =>
      Effect.gen(function* () {
        const before = yield* vos.view;
        assert.deepStrictEqual(
          before.personas.map((p) => [p.persona, p.hasToken, p.accounts]),
          [["sebastian", true, []]],
        );
        const nobody = yield* vos.act({ ...sebastian, persona: "alfred" }, { op: "status" });
        assert.include(nobody.line, "Only sebastian");
        yield* vos.revoke("sebastian");
        assert.isFalse(t.values.has(tokenSecretName("sebastian")));
        const after = yield* vos.act(sebastian, { op: "status" });
        assert.strictEqual(after.status, "refused");
        assert.isFalse((yield* vos.view).personas[0]!.hasToken);
      }),
    );
  });
});

it.live("a token that is not the worker's says so instead of acting", () => {
  const t = setup({ token: "someone-elses" });
  return run(t, (vos) =>
    Effect.gen(function* () {
      const result = yield* vos.act(sebastian, { op: "status" });
      assert.strictEqual(result.status, "error");
      assert.include(result.line, "does not belong to this worker");
    }),
  );
});
