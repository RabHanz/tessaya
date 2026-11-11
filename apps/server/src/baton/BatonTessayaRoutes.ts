// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off
/**
 * The phone page at /tessaya (docs/baton/MOBILE.md): the page itself, then a small API behind the server's own session
 * (the pairing cookie, or a bearer token), with the rules in BatonTessayaApi. Mounted by BatonServerLayer.routes.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BATON_METHOD_OF,
  BatonPrivateCallInput,
  BatonPrivateCallResult,
  BatonRpcGroup,
} from "@t3tools/baton-contracts";
import { buildPhoneState } from "@t3tools/baton-shared/phone";
import { watchFleet } from "@t3tools/baton-shared/watch";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as JobFlow from "./BatonJobFlow.ts";
import { BatonWeaveService } from "./BatonWeaveService.ts";
import { BatonSessionCatalogService } from "./BatonSessionCatalogService.ts";
import * as BatonRpcHandlers from "./BatonRpcHandlers.ts";
import { BatonRuntime } from "./BatonRpcHandlers.ts";
import {
  DESK_METHODS,
  askSourceOf,
  memoryViewerOf,
  missingBatonScope,
  privateCallerOf,
  privateRefusal,
  syncCredentialOf,
} from "./BatonRpcAuthorization.ts";
import { MemoryViewer, SyncCredential } from "./BatonMemoryService.ts";
import { callPrivate, PrivateCaller } from "./BatonPrivateMemoryService.ts";
import * as FleetQuery from "./FleetQuery.ts";
import { AskSource, BatonPhoneInbox } from "./BatonPhoneInbox.ts";
import { createHandsBroker } from "@t3tools/baton-shared/remoteHands";
import { handleHands } from "./BatonHandsApi.ts";
import { handlePhone, readCapped, uploadRefusal, type PhoneDeps } from "./BatonTessayaApi.ts";
import { transcribeWav } from "./BatonPhoneVoice.ts";
import { HTML, MANIFEST, SCRIPT, SERVICE_WORKER } from "./BatonTessayaPage.ts";

/** Each direct-door method's payload decoder and result encoder, compiled once. */
const DESK_CODECS = new Map(
  [...DESK_METHODS].flatMap((tag) => {
    const rpc = BatonRpcGroup.requests.get(tag);
    if (rpc === undefined) return [];
    const payload = rpc.payloadSchema as Schema.Codec<unknown>;
    const success = rpc.successSchema as Schema.Codec<unknown>;
    return [
      [tag, { decode: Schema.decodeEffect(payload), encode: Schema.encodeUnknownEffect(success) }],
    ];
  }),
);

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src blob:; manifest-src 'self'; frame-ancestors 'none'",
} as const;

const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
const page = (body: string, contentType: string) =>
  HttpServerResponse.text(body, { contentType, headers: PAGE_HEADERS });

export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const context = yield* BatonRuntime;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const config = yield* ServerConfig.ServerConfig;

    if (context === null) return;
    const run = Effect.runPromiseWith(context);
    // One transcription at a time: each one runs the speech model on this computer.
    let hearing = false;
    const deps: PhoneDeps = {
      state: () =>
        run(
          Effect.gen(function* () {
            const inbox = yield* BatonPhoneInbox;
            const now = yield* Clock.currentTimeMillis;
            const fleet = yield* FleetQuery.getFleet({});
            return buildPhoneState({
              jobs: yield* JobFlow.listJobs(),
              findings: [
                ...watchFleet(fleet.entries, now),
                ...(yield* (yield* BatonSessionCatalogService).watchFindings),
              ],
              weaves: (yield* (yield* BatonWeaveService).list(30)) as never,
              now,
              prompts: yield* inbox.pending,
              asks: yield* inbox.recent(8),
              desktopConnected: yield* inbox.connected,
            });
          }),
        ),
      agree: (id) => run(Effect.asVoid(JobFlow.agreeJob(id as never))),
      stop: (id) => run(JobFlow.stopJob(id as never)),
      retry: (id) => run(JobFlow.retryJob(id as never)),
      ask: (id, text) => run(Effect.flatMap(BatonPhoneInbox, (inbox) => inbox.post({ id, text }))),
      askGet: (id) =>
        run(
          Effect.flatMap(BatonPhoneInbox, (inbox) =>
            Effect.all({ ask: inbox.get(id), connected: inbox.connected }),
          ),
        ),
      answerPrompt: (id, index) =>
        run(Effect.flatMap(BatonPhoneInbox, (inbox) => inbox.answerPrompt(id, index))),
      transcribe: async (wav) => {
        if (hearing)
          return { ok: false, why: "Still working on the last recording. Try again in a moment." };
        hearing = true;
        try {
          return await transcribeWav({
            wav,
            env: process.env,
            userdataDir: NodePath.dirname(config.dbPath),
          });
        } finally {
          hearing = false;
        }
      },
    };

    const api = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
      if (session._tag === "None") {
        return HttpServerResponse.jsonUnsafe(
          { message: "Not paired." },
          { status: 401, headers: PAGE_HEADERS },
        );
      }
      const url = new URL(request.url, "http://local");
      const path = url.pathname.replace(/^\/tessaya\/api\//, "");
      const type = request.headers["content-type"] ?? "";
      const raw = request.method === "POST" && type.startsWith("audio/");
      const refused = raw
        ? uploadRefusal(new Set(session.value.scopes), request.headers["content-length"])
        : null;
      if (refused !== null)
        return HttpServerResponse.jsonUnsafe(refused.json, {
          status: refused.status,
          headers: PAGE_HEADERS,
        });
      const read = raw ? yield* readCapped(request.stream) : undefined;
      if (read !== undefined && !(read instanceof Uint8Array))
        return HttpServerResponse.jsonUnsafe(read.json, {
          status: read.status,
          headers: PAGE_HEADERS,
        });
      const bytes = read;
      const json =
        request.method === "POST" && !raw
          ? yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
          : undefined;
      const source = askSourceOf(session.value);
      const answer = yield* Effect.promise(() =>
        handlePhone(
          {
            ...deps,
            ask: (id, text) =>
              run(
                Effect.flatMap(BatonPhoneInbox, (inbox) => inbox.post({ id, text })).pipe(
                  Effect.provideService(AskSource, source),
                ),
              ),
          },
          {
            method: request.method,
            path,
            scopes: new Set(session.value.scopes),
            ...(json === undefined ? {} : { json }),
            ...(bytes === undefined ? {} : { bytes }),
            ...(request.headers["x-client-id"] === undefined
              ? {}
              : { clientId: request.headers["x-client-id"] }),
          },
        ),
      );
      return HttpServerResponse.jsonUnsafe(answer.json, {
        status: answer.status,
        headers: PAGE_HEADERS,
      });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ message: "That did not work." }, { status: 500 }),
        ),
      ),
    );

    // One registration serves "/tessaya" and "/tessaya/": the router ignores a trailing slash and refuses both.
    yield* router.add(
      "GET",
      "/tessaya",
      Effect.sync(() => page(HTML, "text/html; charset=utf-8")),
    );
    yield* router.add(
      "GET",
      "/tessaya/app.js",
      Effect.sync(() => page(SCRIPT, "text/javascript; charset=utf-8")),
    );
    yield* router.add(
      "GET",
      "/tessaya/sw.js",
      Effect.sync(() => page(SERVICE_WORKER, "text/javascript; charset=utf-8")),
    );
    yield* router.add(
      "GET",
      "/tessaya/manifest.webmanifest",
      Effect.sync(() => page(MANIFEST, "application/manifest+json")),
    );
    // Remote hands: a remote session asks, the desktop takes and answers (docs/baton/REMOTE_HANDS.md).
    let audited: Promise<void> = Promise.resolve();
    const hands = createHandsBroker({
      now: () => Date.now(),
      newId: () => globalThis.crypto.randomUUID(),
      // In order, and rolled to one `.1` file past AUDIT_MAX_BYTES, so the record never grows without end.
      onAudit: (entry) =>
        void (audited = audited.then(async () => {
          const file = NodePath.join(NodePath.dirname(config.dbPath), "baton-hands-audit.ndjson");
          try {
            if ((await NodeFS.promises.stat(file)).size > AUDIT_MAX_BYTES)
              await NodeFS.promises.rename(file, `${file}.1`);
          } catch {
            // No file yet.
          }
          await NodeFS.promises
            .appendFile(file, `${JSON.stringify(entry)}\n`)
            .catch(() => undefined);
        })),
    });
    const handsApi = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
      if (session._tag === "None") {
        return HttpServerResponse.jsonUnsafe(
          { message: "Not paired." },
          { status: 401, headers: PAGE_HEADERS },
        );
      }
      const url = new URL(request.url, "http://local");
      const json =
        request.method === "POST"
          ? yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
          : undefined;
      const answer = yield* Effect.promise(() =>
        handleHands(hands, {
          method: request.method,
          path: url.pathname.replace(/^\/tessaya\/hands\//, ""),
          scopes: new Set(session.value.scopes),
          session: session.value.subject,
          ...(json === undefined ? {} : { json }),
        }),
      );
      return HttpServerResponse.jsonUnsafe(answer.json, {
        status: answer.status,
        headers: PAGE_HEADERS,
      });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ message: "That did not work." }, { status: 500 }),
        ),
      ),
    );
    // The desktop's own door to Tessaya's job, watch and memory methods while T3's window is closed: the same
    // handlers, schemas and scopes as the WS RPC, for a fixed set of methods.
    const handlers = yield* BatonRpcHandlers.makeHandlers;
    const desk = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
      if (session._tag === "None") {
        return HttpServerResponse.jsonUnsafe({ message: "Not paired." }, { status: 401 });
      }
      const calledAs = new URL(request.url, "http://local").pathname.replace(
        /^\/tessaya\/desk\//,
        "",
      );
      const tag = BATON_METHOD_OF.get(calledAs) ?? calledAs;
      const codec = DESK_CODECS.get(tag);
      if (codec === undefined) {
        return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 404 });
      }
      const payload = yield* codec
        .decode(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))))
        .pipe(Effect.option);
      const missing = missingBatonScope(
        tag,
        session.value.scopes,
        payload._tag === "None" ? undefined : payload.value,
      );
      if (missing !== null) {
        return HttpServerResponse.jsonUnsafe({ message: `Needs ${missing}.` }, { status: 403 });
      }
      if (payload._tag === "None") {
        return HttpServerResponse.jsonUnsafe(
          { message: "That request is not valid." },
          { status: 400 },
        );
      }
      const handler = (handlers as Record<string, (input: unknown, options: never) => unknown>)[
        tag
      ]!;
      const result = yield* (
        handler(payload.value, {} as never) as Effect.Effect<
          unknown,
          { reason?: unknown; message?: unknown }
        >
      ).pipe(
        Effect.provideService(MemoryViewer, memoryViewerOf(session.value)),
        Effect.provideService(SyncCredential, syncCredentialOf(session.value)),
        Effect.flatMap(codec.encode),
        Effect.result,
      );
      if (result._tag === "Failure") {
        const failure: { reason?: unknown; message?: unknown } = result.failure;
        const reason =
          typeof failure.reason === "string"
            ? failure.reason
            : typeof failure.message === "string"
              ? failure.message
              : "That could not be done. Nothing changed.";
        return HttpServerResponse.jsonUnsafe({ message: reason }, { status: 422 });
      }
      return HttpServerResponse.jsonUnsafe({ value: result.success });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ message: "That did not work." }, { status: 500 }),
        ),
      ),
    );
    // Private memory stores (tessaya-ops research/PRIVATE-MEMORIES.md), for the desktop, the phone page and the web app.
    const decodePrivate = Schema.decodeUnknownEffect(BatonPrivateCallInput);
    const encodePrivate = Schema.encodeUnknownEffect(BatonPrivateCallResult);
    const privateCall = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
      if (session._tag === "None")
        return HttpServerResponse.jsonUnsafe(
          { message: "Not paired." },
          { status: 401, headers: PAGE_HEADERS },
        );
      const input = yield* decodePrivate(
        yield* request.json.pipe(Effect.orElseSucceed(() => ({}))),
      ).pipe(Effect.option);
      if (input._tag === "None")
        return HttpServerResponse.jsonUnsafe(
          { message: "That request is not valid." },
          { status: 400, headers: PAGE_HEADERS },
        );
      const refused = privateRefusal(session.value, input.value.op);
      if (refused !== null)
        return HttpServerResponse.jsonUnsafe(
          { message: refused },
          { status: 403, headers: PAGE_HEADERS },
        );
      const result = yield* Effect.promise(() =>
        run(
          callPrivate(input.value).pipe(
            Effect.provideService(PrivateCaller, privateCallerOf(session.value)),
            Effect.flatMap(encodePrivate),
            Effect.result,
          ),
        ),
      );
      // A refusal is said in plain words; never a memory's text, a PIN or a key.
      return result._tag === "Failure"
        ? HttpServerResponse.jsonUnsafe(
            {
              message:
                "reason" in result.failure ? result.failure.reason : "That could not be done.",
            },
            { status: 422, headers: PAGE_HEADERS },
          )
        : HttpServerResponse.jsonUnsafe({ value: result.success }, { headers: PAGE_HEADERS });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { message: "That did not work." },
            { status: 500, headers: PAGE_HEADERS },
          ),
        ),
      ),
    );
    yield* router.add("POST", "/tessaya/private", privateCall);
    yield* router.add("POST", "/tessaya/desk/*", desk);
    yield* router.add("GET", "/tessaya/hands/*", handsApi);
    yield* router.add("POST", "/tessaya/hands/*", handsApi);
    yield* router.add("GET", "/tessaya/api/*", api);
    yield* router.add("POST", "/tessaya/api/*", api);
  }),
);
