import {
  CloudSpeechApiKey,
  DictationCleanupError,
  type DictationCleanupKeyTest,
  type SecretReference,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";

const API = "https://api.anthropic.com/v1";
const MODEL = "claude-haiku-5-5";
const isApiKey = Schema.is(CloudSpeechApiKey);

/** The text of one Messages API stream line (`data: {...content_block_delta...}`), or null for any other line. */
export const sseTextDelta = (line: string): string | null => {
  if (!line.startsWith("data:")) return null;
  try {
    const event = JSON.parse(line.slice(5)) as {
      type?: string;
      delta?: { type?: string; text?: string };
    };
    return event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      event.delta.text
      ? event.delta.text
      : null;
  } catch {
    return null;
  }
};
const MessagesResponse = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
  ),
});

export interface DictationCleanupRequest {
  readonly system: string;
  readonly message: string;
  readonly maxTokens: number;
}
export type DictationCleanupResult =
  | { readonly configured: false }
  | { readonly configured: true; readonly text: string; readonly ms: number };

/** The Anthropic key saved in Settings → APIs, read only here: for dictation cleanup and the room device's turn. */
export class DictationCleanupApi extends Context.Service<
  DictationCleanupApi,
  {
    readonly configured: Effect.Effect<boolean, ServerSettingsError>;
    readonly setKey: (
      key: Redacted.Redacted<string> | SecretReference | null,
    ) => Effect.Effect<void, ServerSettingsError>;
    readonly test: Effect.Effect<DictationCleanupKeyTest["result"], ServerSettingsError>;
    readonly cleanup: (
      input: DictationCleanupRequest,
    ) => Effect.Effect<DictationCleanupResult, DictationCleanupError | ServerSettingsError>;
    /** One streamed Haiku answer as text deltas; fails `unreadable-key` when no key is saved. */
    readonly stream: (
      input: DictationCleanupRequest,
    ) => Stream.Stream<string, DictationCleanupError | ServerSettingsError>;
  }
>()("t3/speech/DictationCleanupApi") {}

export const layer = Layer.effect(
  DictationCleanupApi,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const http = yield* HttpClient.HttpClient;
    const source = settings.getSettings.pipe(
      Effect.map((value) => value.dictationCleanupCredentials.anthropic),
    );
    const configured = Effect.map(source, Boolean);
    // The key goes only into this request's header: never an environment variable, a log or a reply.
    const authorized = Effect.fn("DictationCleanupApi.authorized")(function* (
      request: HttpClientRequest.HttpClientRequest,
    ) {
      const saved = yield* source;
      if (!saved) return null;
      const unreadable = () => new DictationCleanupError({ reason: "unreadable-key" });
      const key = yield* requireSettingsSecret(resolver, saved).pipe(Effect.mapError(unreadable));
      if (!isApiKey(key)) return yield* unreadable();
      return request.pipe(
        HttpClientRequest.setHeaders({
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        }),
      );
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      http.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(() => new DictationCleanupError({ reason: "unreachable" })),
      );
    const rejected = (status: number) =>
      new DictationCleanupError({
        reason: [401, 403].includes(status)
          ? "invalid-key"
          : status === 429
            ? "rate-limit"
            : "unreachable",
      });

    const setKey = Effect.fn("DictationCleanupApi.setKey")(function* (
      key: Redacted.Redacted<string> | SecretReference | null,
    ) {
      yield* settings.updateSettings({
        dictationCleanupCredentials: {
          anthropic: Redacted.isRedacted(key) ? Redacted.value(key) : (key ?? ""),
        },
      });
    });

    const test = Effect.gen(function* () {
      const request = yield* authorized(HttpClientRequest.get(`${API}/models?limit=1`));
      if (request === null) return "missing-key" as const;
      const response = yield* execute(request);
      if (response.status >= 200 && response.status < 300) return "ok" as const;
      return yield* rejected(response.status);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.succeed("unreachable" as const),
      }),
      Effect.catchTags({
        DictationCleanupError: (error) =>
          Effect.succeed(
            error.reason === "invalid-key" ? ("invalid-key" as const) : ("unreachable" as const),
          ),
      }),
      Effect.withSpan("DictationCleanupApi.test"),
    );

    const cleanup = Effect.fn("DictationCleanupApi.cleanup")(
      function* (input: DictationCleanupRequest) {
        // The one cleanup setting's model when it is Claude's; any other provider's model is not this key's.
        const chosen = (yield* settings.getSettings).dictationCleanup.model?.model;
        const request = yield* authorized(
          HttpClientRequest.post(`${API}/messages`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              model: chosen?.startsWith("claude-") ? chosen : MODEL,
              max_tokens: input.maxTokens,
              system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: input.message }],
              // As measured in the cleanup A/B: no thinking at low effort, the fastest Haiku answer.
              thinking: { type: "disabled" },
              output_config: { effort: "low" },
            }),
          ),
        );
        if (request === null) return { configured: false } as const;
        const started = yield* Clock.currentTimeMillis;
        const response = yield* execute(request);
        if (response.status < 200 || response.status >= 300)
          return yield* rejected(response.status);
        const { content } = yield* HttpClientResponse.schemaBodyJson(MessagesResponse)(
          response,
        ).pipe(Effect.mapError(() => new DictationCleanupError({ reason: "unreachable" })));
        const text = content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []));
        const ms = (yield* Clock.currentTimeMillis) - started;
        return { configured: true, text: text.join("").trim(), ms } as const;
      },
      (effect) =>
        effect.pipe(
          Effect.timeoutOrElse({
            // Short enough that the subscription fallback still fits a short dictation's limit (hardLimitMs).
            duration: "1200 millis",
            orElse: () => Effect.fail(new DictationCleanupError({ reason: "timeout" })),
          }),
        ),
    );

    const stream = (input: DictationCleanupRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const request = yield* authorized(
            HttpClientRequest.post(`${API}/messages`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                model: MODEL,
                max_tokens: input.maxTokens,
                stream: true,
                system: [
                  { type: "text", text: input.system, cache_control: { type: "ephemeral" } },
                ],
                messages: [{ role: "user", content: input.message }],
                thinking: { type: "disabled" },
              }),
            ),
          );
          if (request === null)
            return yield* new DictationCleanupError({ reason: "unreadable-key" });
          const response = yield* execute(request);
          if (response.status < 200 || response.status >= 300)
            return yield* rejected(response.status);
          return response.stream.pipe(
            Stream.mapError(() => new DictationCleanupError({ reason: "unreachable" })),
            Stream.decodeText,
            Stream.splitLines,
            Stream.filterMap((line) => {
              const delta = sseTextDelta(line);
              return delta === null ? Result.failVoid : Result.succeed(delta);
            }),
          );
        }),
      );

    return DictationCleanupApi.of({ configured, setKey, test, cleanup, stream });
  }),
);
