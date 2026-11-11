import { it } from "@effect/vitest";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as DictationCleanupApi from "./DictationCleanupApi.ts";

it.effect("cleans up with the saved Anthropic key only, and says when none is saved", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({ content: [{ type: "text", text: " Cleaned. " }] }),
    );
    const api = yield* DictationCleanupApi.DictationCleanupApi.pipe(
      Effect.provide(
        DictationCleanupApi.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(
            Layer.mock(SecretResolver.SecretResolver)({
              read: () => Effect.succeed([]),
              label: () => Effect.succeed("Work"),
              invalidate: () => Effect.void,
            }),
          ),
        ),
      ),
    );
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

    upstream.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    expect(yield* Effect.flip(fetching(api.cleanup(input)))).toMatchObject({
      reason: "invalid-key",
    });
    upstream.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    expect(yield* fetching(api.test)).toBe("invalid-key");

    yield* api.setKey(null);
    expect(yield* api.configured).toBe(false);
  }),
);
