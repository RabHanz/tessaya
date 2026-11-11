/**
 * The one wire to Home Assistant: its WebSocket API (auth, commands by id, subscriptions) and the few REST
 * routes the automation editor uses. A port, so the service's logic is tested against a fake house.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export class HomeConnectError extends Schema.TaggedError<HomeConnectError>()("HomeConnectError", {
  reason: Schema.Literals(["unreachable", "unauthorized"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "unauthorized"
      ? "Home Assistant refused the token."
      : "Home Assistant could not be reached.";
  }
}

export class HomeCallError extends Schema.TaggedError<HomeCallError>()("HomeCallError", {
  operation: Schema.String,
  /** Home Assistant's own error code, or `closed` / `timeout` / `http_<status>`. */
  code: Schema.String,
  /** Home Assistant's own message, capped: it names the service or field that was wrong. */
  said: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Home Assistant ${this.operation} failed (${this.code}).`;
  }
}

export const isHomeCallError = Schema.is(HomeCallError);

export interface HomeLink {
  /** One WebSocket command; resolves with its `result`. */
  readonly command: (
    message: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, HomeCallError>;
  /** Subscribe; `onEvent` gets each event's payload until the link closes. */
  readonly subscribe: (
    message: Readonly<Record<string, unknown>>,
    onEvent: (event: unknown) => void,
  ) => Effect.Effect<void, HomeCallError>;
  readonly rest: (
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, HomeCallError>;
  /** Completes when the link drops. */
  readonly closed: Effect.Effect<void>;
}

export class HomeAssistantConnection extends Context.Service<
  HomeAssistantConnection,
  {
    readonly open: (
      url: string,
      token: string,
    ) => Effect.Effect<HomeLink, HomeConnectError, Scope.Scope>;
  }
>()("t3/home/HomeAssistantConnection") {}

const COMMAND_TIMEOUT = "20 seconds";
const said = (value: unknown): string => String(value ?? "").slice(0, 300);

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeFrame = (frame: Uint8Array | string): ReadonlyArray<Record<string, unknown>> => {
  const parsed = decodeJson(typeof frame === "string" ? frame : new TextDecoder().decode(frame));
  if (parsed._tag === "None") return [];
  const list = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  return list.filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null);
};

const make = Effect.gen(function* () {
  const constructor = yield* Socket.WebSocketConstructor;
  const http = yield* HttpClient.HttpClient;
  const open = Effect.fn("HomeAssistantConnection.open")(function* (url: string, token: string) {
    const base = url.replace(/\/+$/, "");
    const socket = yield* Socket.makeWebSocket(`${base.replace(/^http/, "ws")}/api/websocket`, {
      openTimeout: "10 seconds",
    }).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor));
    const unreachable = (cause: unknown) => new HomeConnectError({ reason: "unreachable", cause });
    const reader = yield* socket.reader.pipe(Effect.mapError(unreachable));
    const writer = yield* socket.writer;
    const send = (message: Readonly<Record<string, unknown>>) => writer.write(encodeJson(message));
    const queue: Array<Record<string, unknown>> = [];
    const next = Effect.gen(function* () {
      while (queue.length === 0)
        for (const frame of yield* reader.pull) queue.push(...decodeFrame(frame));
      return queue.shift()!;
    });

    // Handshake: auth_required, our token, then auth_ok or auth_invalid.
    const hello = yield* next.pipe(Effect.mapError(unreachable));
    if (hello["type"] !== "auth_required") return yield* unreachable(undefined);
    yield* send({ type: "auth", access_token: token }).pipe(Effect.mapError(unreachable));
    const answer = yield* next.pipe(Effect.mapError(unreachable));
    if (answer["type"] !== "auth_ok")
      return yield* new HomeConnectError({ reason: "unauthorized" });

    let nextId = 1;
    const pending = new Map<number, Deferred.Deferred<unknown, HomeCallError>>();
    const listeners = new Map<number, (event: unknown) => void>();
    const closed = yield* Deferred.make<void>();

    yield* Effect.gen(function* () {
      while (true) {
        const message = yield* next;
        const id = typeof message["id"] === "number" ? message["id"] : -1;
        if (message["type"] === "event") {
          listeners.get(id)?.(message["event"]);
          continue;
        }
        if (message["type"] !== "result") continue;
        const waiter = pending.get(id);
        if (waiter === undefined) continue;
        pending.delete(id);
        const error = (message["error"] ?? {}) as { code?: unknown; message?: unknown };
        yield* message["success"] === true
          ? Deferred.succeed(waiter, message["result"])
          : Deferred.fail(
              waiter,
              new HomeCallError({
                operation: "command",
                code: said(error.code),
                said: said(error.message),
              }),
            );
      }
    }).pipe(
      Effect.ignoreCause,
      Effect.ensuring(
        Effect.gen(function* () {
          for (const waiter of pending.values())
            yield* Deferred.fail(
              waiter,
              new HomeCallError({ operation: "command", code: "closed", said: "" }),
            );
          pending.clear();
          yield* Deferred.succeed(closed, undefined);
        }),
      ),
      Effect.forkScoped,
    );

    const command = Effect.fn("HomeAssistantConnection.command")(function* (
      message: Readonly<Record<string, unknown>>,
    ) {
      const id = nextId++;
      const waiter = yield* Deferred.make<unknown, HomeCallError>();
      pending.set(id, waiter);
      yield* send({ ...message, id }).pipe(
        Effect.mapError(
          (cause) => new HomeCallError({ operation: "command", code: "closed", said: "", cause }),
        ),
      );
      return yield* Deferred.await(waiter).pipe(
        Effect.timeoutOrElse({
          duration: COMMAND_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new HomeCallError({ operation: String(message["type"]), code: "timeout", said: "" }),
            ),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
    });

    const subscribe = Effect.fn("HomeAssistantConnection.subscribe")(function* (
      message: Readonly<Record<string, unknown>>,
      onEvent: (event: unknown) => void,
    ) {
      // The id is taken before the command goes out, so no event can arrive unheard.
      listeners.set(nextId, onEvent);
      yield* command(message);
    });

    const rest = Effect.fn("HomeAssistantConnection.rest")(function* (
      method: "GET" | "POST" | "DELETE",
      path: string,
      body?: unknown,
    ) {
      const operation = `${method} ${path.split("/").slice(0, 5).join("/")}`;
      const request = HttpClientRequest.make(method)(`${base}${path}`).pipe(
        HttpClientRequest.bearerToken(token),
        body === undefined
          ? (r) => r
          : HttpClientRequest.bodyText(encodeJson(body), "application/json"),
      );
      const failed = (cause: unknown) =>
        new HomeCallError({ operation, code: "unreachable", said: "", cause });
      const response = yield* http.execute(request).pipe(Effect.mapError(failed));
      const text = yield* response.text.pipe(Effect.mapError(failed));
      if (response.status < 200 || response.status >= 300)
        return yield* new HomeCallError({
          operation,
          code: `http_${response.status}`,
          said: said(text),
        });
      if (text === "") return null;
      const parsed = decodeJson(text);
      return parsed._tag === "Some" ? parsed.value : text;
    });

    return { command, subscribe, rest, closed: Deferred.await(closed) } satisfies HomeLink;
  });
  return HomeAssistantConnection.of({ open });
});

export const layer = Layer.effect(HomeAssistantConnection, make).pipe(
  Layer.provide(NodeSocket.layerWebSocketConstructor),
  Layer.provide(FetchHttpClient.layer),
);
