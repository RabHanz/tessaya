import { DEFAULT_ROUTING } from "@t3tools/baton-shared/costRouting";
import { brainRoute, keyRefusal, type BrainRoute } from "@t3tools/baton-shared/brainRoutes";
import {
  type BrainRole,
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";

const API = "https://api.anthropic.com/v1";
const isApiKey = Schema.is(CloudSpeechApiKey);

/** What one streamed Messages API turn gives: its words as they come, and each tool call once its input is whole. */
export type ConversePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly id: string; readonly name: string; readonly input: unknown };

/** Reads one turn's stream lines in order; holds a tool call's input until its block stops. */
export const converseReader = () => {
  const open = new Map<number, { id: string; name: string; json: string }>();
  return (line: string): ReadonlyArray<ConversePart> => {
    if (!line.startsWith("data:")) return [];
    let event: {
      type?: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string };
    };
    try {
      event = JSON.parse(line.slice(5)) as typeof event;
    } catch {
      return [];
    }
    const index = event.index ?? -1;
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      open.set(index, {
        id: event.content_block.id ?? "",
        name: event.content_block.name ?? "",
        json: "",
      });
      return [];
    }
    if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta" && event.delta.text)
        return [{ type: "text", text: event.delta.text }];
      const tool = open.get(index);
      if (event.delta?.type === "input_json_delta" && tool !== undefined)
        tool.json += event.delta.partial_json ?? "";
      return [];
    }
    if (event.type === "content_block_stop") {
      const tool = open.get(index);
      if (tool === undefined) return [];
      open.delete(index);
      let input: unknown = {};
      try {
        input = tool.json.trim() === "" ? {} : JSON.parse(tool.json);
      } catch {
        input = {};
      }
      return [{ type: "tool", id: tool.id, name: tool.name, input }];
    }
    return [];
  };
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
export interface ConverseRequest {
  readonly system: string;
  /** The Messages API's own messages: text, tool calls and their results. */
  readonly messages: ReadonlyArray<unknown>;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly input_schema: unknown;
  }>;
  readonly maxTokens: number;
  /** "none" makes the model answer in words: the last round of a capped tool loop. */
  readonly toolChoice?: "auto" | "none";
}
/** Which role a call is for and the model the routing table gave it (`brainRoute`). */
export type ConverseRoute = Pick<BrainRoute, "role" | "model" | "effort">;

/**
 * Thinking off before the first word, the way each model allows it: Sonnet 5.5 refuses `disabled` and takes
 * `between_tools`; Opus 5.5 can't turn it off, so its effort carries the speed.
 */
const quickThinking = (model: string) =>
  /opus/.test(model)
    ? {}
    : /^(?:claude-)?sonnet(?:-5-5)?$/.test(model)
      ? { thinking: { type: "between_tools" } }
      : { thinking: { type: "disabled" } };

/** The routing table does not let the key serve this call's role (the spend guard). */
export class BrainRefused extends Schema.TaggedError<BrainRefused>()("BrainRefused", {
  role: Schema.String,
  why: Schema.String,
}) {}

export type DictationCleanupResult =
  | { readonly configured: false }
  | { readonly configured: true; readonly text: string; readonly ms: number };

/**
 * The Anthropic key saved in Settings → APIs, read only here. Every call names its role, and a role the key may not
 * serve (the brain's routing table, `brainKeyRoles`) is refused before anything is sent: the spend guard.
 */
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
    ) => Effect.Effect<
      DictationCleanupResult,
      DictationCleanupError | BrainRefused | ServerSettingsError
    >;
    /** One streamed turn that may call tools; fails `unreadable-key` when no key is saved, `refused` off its roles. */
    readonly converse: (
      route: ConverseRoute,
      input: ConverseRequest,
    ) => Stream.Stream<ConversePart, DictationCleanupError | BrainRefused | ServerSettingsError>;
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

    // Off the key's roles: logged, and the call fails with BrainRefused. Nothing falls back from here.
    const allow = Effect.fn("DictationCleanupApi.allow")(function* (role: BrainRole) {
      const why = keyRefusal(yield* settings.getSettings, "anthropic", role);
      if (why === null) return;
      yield* Effect.logWarning("brain: an API call was refused", { role, why });
      return yield* new BrainRefused({ role, why });
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
        yield* allow("cleanup");
        // Cleanup never reads the cheap model: any value does here.
        const route = brainRoute(yield* settings.getSettings, "cleanup", DEFAULT_ROUTING.cheap);
        const request = yield* authorized(
          HttpClientRequest.post(`${API}/messages`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              model: route.model,
              max_tokens: input.maxTokens,
              system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: input.message }],
              // As measured in the cleanup A/B: no thinking at low effort, the fastest Haiku answer.
              ...quickThinking(route.model),
              output_config: { effort: route.effort ?? "low" },
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
            // His p90 on 0.1.107 with a cold connection (2026-11-12); 1.2 s cut three of four answers at 1.05-1.3 s.
            duration: "2500 millis",
            orElse: () => Effect.fail(new DictationCleanupError({ reason: "timeout" })),
          }),
        ),
    );

    const converse = (route: ConverseRoute, input: ConverseRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* allow(route.role);
          const tools = input.tools.map((tool, i) =>
            // The tools are the same every turn: cached with the system prompt.
            i === input.tools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" } } : tool,
          );
          const request = yield* authorized(
            HttpClientRequest.post(`${API}/messages`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                model: route.model,
                max_tokens: input.maxTokens,
                stream: true,
                system: [
                  { type: "text", text: input.system, cache_control: { type: "ephemeral" } },
                ],
                messages: input.messages,
                ...(tools.length === 0
                  ? {}
                  : { tools, tool_choice: { type: input.toolChoice ?? "auto" } }),
                ...quickThinking(route.model),
                ...(route.effort === null ? {} : { output_config: { effort: route.effort } }),
              }),
            ),
          );
          if (request === null)
            return yield* new DictationCleanupError({ reason: "unreadable-key" });
          const response = yield* execute(request);
          if (response.status < 200 || response.status >= 300)
            return yield* rejected(response.status);
          const read = converseReader();
          return response.stream.pipe(
            Stream.mapError(() => new DictationCleanupError({ reason: "unreachable" })),
            Stream.decodeText,
            Stream.splitLines,
            Stream.flatMap((line) => Stream.fromIterable(read(line))),
          );
        }),
      );

    return DictationCleanupApi.of({ configured, setKey, test, cleanup, converse });
  }),
);
