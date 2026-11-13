import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as BatonDatabase from "../baton/BatonDatabase.ts";
import * as BrainUsage from "../baton/BrainUsage.ts";
import * as ServerSettings from "../serverSettings.ts";
import { parseRateTable } from "../usage/usagePricing.ts";
import * as DictationCleanupApi from "./DictationCleanupApi.ts";

const rates = parseRateTable({
  "claude-haiku-5-5": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
  },
});
const usageLayer = Layer.effect(
  BrainUsage.BrainUsage,
  BrainUsage.make(() => rates),
).pipe(Layer.provide(BatonDatabase.layerMemory));

it.effect("cleans up with the saved Anthropic key only, and says when none is saved", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "claude-haiku-5-5",
        usage: { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10 },
        content: [{ type: "text", text: " Cleaned. " }],
      }),
    );
    const [api, settings, usage] = yield* Effect.all([
      DictationCleanupApi.DictationCleanupApi,
      ServerSettings.ServerSettingsService,
      BrainUsage.BrainUsage,
    ]);
    const fetching = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    const input = { system: "Fix the transcript.", message: "um hello", maxTokens: 64 };

    expect(yield* api.configured).toBe(false);
    expect(yield* fetching(api.cleanup(input))).toEqual({ configured: false });
    expect(yield* fetching(api.test)).toBe("missing-key");
    expect(upstream).not.toHaveBeenCalled();

    yield* api.setKey(Redacted.make("sk-ant-fixture"));
    // Only whether a key is saved, never the key.
    expect(yield* api.configured).toBe(true);
    expect(yield* fetching(api.cleanup(input))).toMatchObject({
      configured: true,
      text: "Cleaned.",
    });
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-fixture");
    expect(JSON.parse(yield* Effect.promise(() => new Response(init?.body).text()))).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 64,
      system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "um hello" }],
      output_config: { effort: "low" },
    });
    // Its usage row, priced at list: 100 × $1/M + 1000 × $0.1/M + 10 × $5/M.
    expect(yield* usage.totals({ since: 0, timeZone: "Asia/Karachi" })).toMatchObject([
      {
        role: "cleanup",
        credential: "apiKey:anthropic",
        model: "claude-haiku-5-5",
        calls: 1,
        input: 100,
        cacheRead: 1000,
        output: 10,
        dollars: expect.closeTo(0.00025, 8),
      },
    ]);

    // The one cleanup setting's model, when it is Claude's; another provider's model keeps Haiku.
    const bodyModel = (call: number) =>
      Effect.promise(() => new Response(upstream.mock.calls[call]![1]?.body).text()).pipe(
        Effect.map((text) => JSON.parse(text).model),
      );
    const choose = (instanceId: string, model: string, updatedAt: number) =>
      settings.updateSettings({
        dictationCleanup: {
          enabled: true,
          engine: "t3",
          model: { instanceId: ProviderInstanceId.make(instanceId), model },
          updatedAt,
        },
      });
    yield* choose("claudeAgent", "claude-sonnet-5", 1);
    yield* fetching(api.cleanup(input));
    expect(yield* bodyModel(1)).toBe("claude-sonnet-5");
    yield* choose("codex", "gpt-6-luna", 2);
    yield* fetching(api.cleanup(input));
    expect(yield* bodyModel(2)).toBe("claude-haiku-5-5");

    // The spend guard: a role off the key's list is refused before anything is sent, and nothing falls back.
    const sent = upstream.mock.calls.length;
    const turn = { system: "Be brief.", messages: [], tools: [], maxTokens: 64 };
    const deep = { role: "deep", model: "claude-opus-5-5", effort: "medium" } as const;
    expect(yield* Effect.flip(fetching(Stream.runDrain(api.converse(deep, turn))))).toMatchObject({
      _tag: "BrainRefused",
      role: "deep",
    });
    yield* settings.updateSettings({ brainKeyRoles: { anthropic: [] } });
    expect(yield* Effect.flip(fetching(api.cleanup(input)))).toMatchObject({
      _tag: "BrainRefused",
      role: "cleanup",
    });
    expect(upstream.mock.calls.length).toBe(sent);
    // His table: cleanup back on the key, on the model his row names.
    yield* settings.updateSettings({
      brainKeyRoles: { anthropic: ["cleanup"] },
      brainModels: { cleanup: { model: "claude-sonnet-5-5" } },
    });
    yield* fetching(api.cleanup(input));
    expect(yield* bodyModel(sent)).toBe("claude-sonnet-5-5");

    upstream.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    expect(yield* Effect.flip(fetching(api.cleanup(input)))).toMatchObject({
      reason: "invalid-key",
    });
    upstream.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    expect(yield* fetching(api.test)).toBe("invalid-key");

    // A busy API (529, 5xx) gets one quick second try.
    upstream.mockResolvedValueOnce(new Response("busy", { status: 529 }));
    const retried = yield* fetching(api.cleanup(input)).pipe(Effect.forkChild);
    yield* TestClock.adjust("200 millis");
    expect(yield* Fiber.join(retried)).toMatchObject({ configured: true, text: "Cleaned." });
    upstream
      .mockResolvedValueOnce(new Response("busy", { status: 529 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }));
    const failed = yield* Effect.flip(fetching(api.cleanup(input))).pipe(Effect.forkChild);
    yield* TestClock.adjust("200 millis");
    expect(yield* Fiber.join(failed)).toMatchObject({ reason: "unreachable" });

    yield* api.setKey(null);
    expect(yield* api.configured).toBe(false);
  }).pipe(
    Effect.provide(
      Layer.effect(DictationCleanupApi.DictationCleanupApi, DictationCleanupApi.make).pipe(
        Layer.provideMerge(usageLayer),
        Layer.provide(FetchHttpClient.layer),
        Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(
          Layer.mock(SecretResolver.SecretResolver)({
            read: () => Effect.succeed([]),
            label: () => Effect.succeed("Work"),
            invalidate: () => Effect.void,
          }),
        ),
      ),
    ),
  ),
);
