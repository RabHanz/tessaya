// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off
/**
 * The phone page at /tessaya (docs/baton/MOBILE.md): the page itself, then a small API behind the server's own session
 * (the pairing cookie, or a bearer token), with the rules in BatonTessayaApi. Mounted by BatonServerLayer.routes.
 */
import * as NodePath from "node:path";

import {
  BATON_METHOD_OF,
  BatonPrivateCallInput,
  BatonHouseholdCallInput,
  CommsCallInput,
  BatonPrivateCallResult,
  BatonRpcGroup,
} from "@t3tools/tessaya-contracts";
import { buildPhoneState } from "@t3tools/tessaya-shared/phone";
import { AuthBatonHandsHostScope } from "@t3tools/contracts";
import { watchFleet } from "@t3tools/tessaya-shared/watch";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { HomeAssistantService, r1ByKey } from "../home/HomeAssistantService.ts";
import { DeskTools } from "../home/R1Tools.ts";
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
  householdCallerOf,
  householdRefusal,
  privateCallerOf,
  privateRefusal,
  syncCredentialOf,
} from "./BatonRpcAuthorization.ts";
import { MemoryViewer, SyncCredential } from "./BatonMemoryService.ts";
import { SessionMember, TessayaTurn } from "./TessayaTurn.ts";
import { DeskTurnBody, deskTurnStream } from "./DeskTurn.ts";
import { runAskWorker } from "./AskWorker.ts";
import { peerTurnHands, PeerTurnBody, relayDeskTurn, servePeerTurn } from "./DeskRelay.ts";
import { memberOfSubject, OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { callPrivate, PrivateCaller } from "./BatonPrivateMemoryService.ts";
import { HouseholdCaller, TessayaHousehold } from "./TessayaHousehold.ts";
import { TessayaComms } from "./TessayaComms.ts";
import * as PersonaLayers from "../tessaya/PersonaLayers.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { approvalRefusal } from "@t3tools/tessaya-shared/trust";
import * as FleetQuery from "./FleetQuery.ts";
import { AskSource, BatonPhoneInbox } from "./BatonPhoneInbox.ts";
import { handleHands } from "./BatonHandsApi.ts";
import { VesselHands } from "./VesselHands.ts";
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

/** One shared tool call from his desktop's Tessaya; `device` names the suite's pretend desktop (`replay-…`). */
const DeskToolCall = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(80)),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  device: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
});

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src blob:; manifest-src 'self'; frame-ancestors 'none'",
} as const;

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
            // Who says yes, and how sure: a yes counts only from a member whose role may give it (identity I-2).
            answerPrompt: (id, index) =>
              run(
                Effect.gen(function* () {
                  const inbox = yield* BatonPhoneInbox;
                  const caller = householdCallerOf(session.value);
                  const grants =
                    caller.member === null
                      ? null
                      : yield* Effect.flatMap(TessayaHousehold, (h) => h.grantsOf(caller.member!));
                  const card = (yield* inbox.pending).find((p) => p.id === id);
                  // Saying no narrows: anyone who may see the card may decline it.
                  const refusal =
                    card === undefined || index !== card.yes
                      ? null
                      : approvalRefusal({
                          risky: card?.needs === "cloud-approve",
                          approver: {
                            member: caller.member,
                            role: caller.service ? "service" : (grants?.role ?? null),
                            assurance: caller.assurance,
                          },
                        });
                  if (refusal !== null) return refusal;
                  return yield* inbox.answerPrompt(id, index, {
                    member: caller.member,
                    name: grants?.name ?? caller.member ?? "someone",
                    assurance: caller.assurance,
                    via: caller.via,
                  });
                }),
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
      const hands = Context.getOption(context, VesselHands);
      if (hands._tag === "None")
        return HttpServerResponse.jsonUnsafe(
          { message: "Remote hands are not running on this server." },
          { status: 503, headers: PAGE_HEADERS },
        );
      const answer = yield* Effect.promise(() =>
        handleHands(hands.value, {
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
    const deskTools = yield* DeskTools;
    const decodeToolCall = Schema.decodeUnknownOption(DeskToolCall);
    const decodeDeskTurn = Schema.decodeUnknownOption(DeskTurnBody);
    const decodePeerTurn = Schema.decodeUnknownOption(PeerTurnBody);
    const deskToolsAnswer = Effect.fn("BatonTessayaRoutes.deskTools")(function* (
      calledAs: string,
      request: HttpServerRequest.HttpServerRequest,
      rehearsal?: string,
    ) {
      if (deskTools === null)
        return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 404 });
      if (calledAs === "baton.tools.list")
        return HttpServerResponse.jsonUnsafe({ value: { tools: deskTools.specs } });
      const call = decodeToolCall(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))));
      if (call._tag === "None")
        return HttpServerResponse.jsonUnsafe(
          { message: "That request is not valid." },
          { status: 400 },
        );
      const { name, args, device } = call.value;
      return HttpServerResponse.jsonUnsafe({
        value: yield* deskTools.run(name, args ?? {}, rehearsal ?? device),
      });
    });
    // The live suite's pretend desktop (evals/tessaya-room, --vessel desktop): the same tools as his desktop's
    // Tessaya, behind the R1's device key the suite already holds, and always a rehearsal: nothing changes or is sent.
    const rehearse = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const all = yield* Effect.flatMap(HomeAssistantService, (h) => h.devices).pipe(
        Effect.provideContext(context),
      );
      const device = r1ByKey(
        all,
        (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, ""),
      );
      if (device === null)
        return HttpServerResponse.jsonUnsafe({ message: "Wrong device key." }, { status: 401 });
      const calledAs = new URL(request.url, "http://local").pathname.replace(
        /^\/tessaya\/rehearse\//,
        "",
      );
      if (calledAs !== "baton.tools.list" && calledAs !== "baton.tools.call")
        return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 404 });
      return yield* deskToolsAnswer(calledAs, request, "replay-desktop");
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ message: "That did not work." }, { status: 500 }),
        ),
      ),
    );
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
      // The shared toolkit as his desktop's own Tessaya: only the desktop app's own session may be that caller.
      if (calledAs === "baton.tools.list" || calledAs === "baton.tools.call") {
        if (!session.value.scopes.includes(AuthBatonHandsHostScope))
          return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 403 });
        return yield* deskToolsAnswer(calledAs, request);
      }
      // The one brain answers his phone's, the web bar's and agents' asks here (S6), as the desktop's setting says.
      if (calledAs === "brain-asks") {
        if (!session.value.scopes.includes(AuthBatonHandsHostScope))
          return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 403 });
        const on = (
          (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as { on?: unknown }
        ).on;
        yield* Effect.flatMap(BatonPhoneInbox, (inbox) => inbox.setBrainAnswers(on === true)).pipe(
          Effect.provideContext(context),
        );
        return HttpServerResponse.jsonUnsafe({ value: { on: on === true } });
      }
      // His sentence at the desk, through the one brain (SPINE-UNIFY S4): only the desktop app's own session sends it.
      if (calledAs === "turn") {
        if (!session.value.scopes.includes(AuthBatonHandsHostScope) || deskTools === null)
          return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 403 });
        const body = decodeDeskTurn(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))));
        if (body._tag === "None")
          return HttpServerResponse.jsonUnsafe(
            { message: "That request is not valid." },
            { status: 400 },
          );
        const hands = Option.getOrNull(Context.getOption(context, VesselHands));
        const here = deskTurnStream(body.value, deskTools, true, hands);
        // Placement (b): the household's home server answers; with none to reach, or none taking it, this one does.
        const turn =
          body.value.placement === "home"
            ? Stream.unwrap(
                relayDeskTurn(body.value, hands).pipe(
                  Effect.map((relayed) =>
                    relayed === null ? here : Stream.catchCause(relayed, () => here),
                  ),
                  Effect.orElseSucceed(() => here),
                ),
              )
            : here;
        return HttpServerResponse.stream(
          turn.pipe(
            Stream.provideService(SessionMember, memberOfSubject(session.value.subject)),
            Stream.provideContext(context),
            Stream.map((words) => `data: ${JSON.stringify({ words })}\n\n`),
            Stream.concat(Stream.make("data: [DONE]\n\n")),
            Stream.encodeText,
          ),
          { contentType: "text/event-stream", headers: { "cache-control": "no-store" } },
        );
      }
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
        // A member's own device: its typed turns are that member's (identity I-2), not the owner's.
        Effect.provideService(SessionMember, memberOfSubject(session.value.subject)),
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
    /**
     * A member's request: the household's members (ACCOUNTS-IDENTITY-DESIGN I-1) or comms (COMMS-DESIGN). The rules are
     * the service's, by the caller's member; this only pairs, decodes and answers.
     */
    const memberRoute = Effect.fn("BatonTessayaRoutes.memberRoute")(
      function* <I>(
        decode: (u: unknown) => Effect.Effect<I, Schema.SchemaError>,
        serve: (input: I) => Effect.Effect<unknown, never, TessayaHousehold | TessayaComms>,
      ) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
        if (session._tag === "None")
          return HttpServerResponse.jsonUnsafe(
            { message: "Not paired." },
            { status: 401, headers: PAGE_HEADERS },
          );
        const refusedHere = householdRefusal(session.value);
        if (refusedHere !== null)
          return HttpServerResponse.jsonUnsafe(
            { message: refusedHere },
            { status: 403, headers: PAGE_HEADERS },
          );
        const input = yield* decode(
          yield* request.json.pipe(Effect.orElseSucceed(() => ({}))),
        ).pipe(Effect.option);
        if (input._tag === "None")
          return HttpServerResponse.jsonUnsafe(
            { message: "That request is not valid." },
            { status: 400, headers: PAGE_HEADERS },
          );
        const result = yield* Effect.promise(() =>
          run(
            serve(input.value).pipe(
              Effect.provideService(HouseholdCaller, {
                ...householdCallerOf(session.value),
                // A passkey is for the site the page is on.
                ...(typeof request.headers["origin"] === "string"
                  ? { origin: request.headers["origin"] }
                  : {}),
              }),
            ),
          ),
        );
        return HttpServerResponse.jsonUnsafe({ value: result }, { headers: PAGE_HEADERS });
      },
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { message: "That did not work." },
            { status: 500, headers: PAGE_HEADERS },
          ),
        ),
      ),
    );
    const householdCall = memberRoute(
      Schema.decodeUnknownEffect(BatonHouseholdCallInput),
      (input) => Effect.flatMap(TessayaHousehold, (h) => h.call(input)),
    );
    const commsCall = memberRoute(Schema.decodeUnknownEffect(CommsCallInput), (input) =>
      Effect.flatMap(TessayaComms, (c) => c.call(input)),
    );
    yield* router.add("POST", "/tessaya/household", householdCall);
    yield* router.add("POST", "/tessaya/comms", commsCall);
    yield* router.add("POST", "/tessaya/private", privateCall);
    // Placement (b): another of his servers sends his desk turn here, and runs this turn's calls to its desktop.
    const peer = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
      if (client._tag === "None" || !client.value.peerLink || deskTools === null)
        return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 403 });
      const path = new URL(request.url, "http://local").pathname.replace(/^\/tessaya\/peer\//, "");
      const json = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
      if (path === "turn") {
        const body = decodePeerTurn(json);
        if (body._tag === "None")
          return HttpServerResponse.jsonUnsafe(
            { message: "That request is not valid." },
            { status: 400 },
          );
        return HttpServerResponse.stream(
          servePeerTurn(body.value, client.value.sessionId, deskTools).pipe(
            Stream.provideContext(context),
            Stream.map((words) => `data: ${JSON.stringify({ words })}\n\n`),
            Stream.concat(Stream.make("data: [DONE]\n\n")),
            Stream.encodeText,
          ),
          { contentType: "text/event-stream", headers: { "cache-control": "no-store" } },
        );
      }
      const hands = path.replace(/^turn-hands\//, "");
      const answer = yield* Effect.promise(() =>
        peerTurnHands(client.value.sessionId, hands, json as Record<string, unknown>),
      );
      return HttpServerResponse.jsonUnsafe(answer.json, { status: answer.status });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ message: "That did not work." }, { status: 500 }),
        ),
      ),
    );
    yield* router.add("POST", "/tessaya/peer/*", peer);
    // The one brain's ask worker: idle unless the desktop's one-brain setting turned `brain.asks` on.
    if (deskTools !== null)
      yield* runAskWorker(deskTools).pipe(
        Effect.provideContext(context),
        Effect.catchCause((cause) => Effect.logWarning("ask worker stopped", cause)),
        Effect.forkScoped,
      );
    yield* router.add("POST", "/tessaya/desk/*", desk);
    yield* router.add("POST", "/tessaya/rehearse/*", rehearse);
    yield* router.add("GET", "/tessaya/hands/*", handsApi);
    yield* router.add("POST", "/tessaya/hands/*", handsApi);
    yield* router.add("GET", "/tessaya/api/*", api);
    yield* router.add("POST", "/tessaya/api/*", api);
    yield* personaLayerRoutes(router, context, auth, deskTools, NodePath.dirname(config.dbPath));
  }),
);

/**
 * Owner-only persona layers' own pages and calls, under /tessaya/layer/<id>/ (PersonaLayers.ts). A public build loads
 * none and registers nothing. The host verifies a layer's step-up through the household, on the request's own session.
 */
/** What the desktop app reports to the layers: its device key (32 bytes, base64) and what just happened on it. */
export const deskReport = (body: unknown) => {
  const b = (body ?? {}) as { key?: unknown; signals?: unknown };
  const key = typeof b.key === "string" ? Buffer.from(b.key, "base64") : null;
  return {
    key: key !== null && key.length === 32 ? new Uint8Array(key) : null,
    signals: Array.isArray(b.signals)
      ? b.signals.filter((k): k is string => typeof k === "string" && DESK_SIGNALS.has(k))
      : [],
  };
};
const DESK_SIGNALS = new Set(["screenLocked", "sleep", "call", "screenShared", "recording"]);

/**
 * Who is near a vessel, for a layer's Tessel rule: "alone" only when the owner is the one member likely home and was
 * just heard on that vessel; another member likely home is "others"; anything less is "unknown", which fails closed.
 */
const presenceOn = Effect.fn("BatonTessayaRoutes.presenceOn")(function* (vessel: string) {
  const home = (yield* (yield* TessayaTurn).whoIsHome).filter((p) => p.likelyHome);
  if (home.some((p) => p.member !== OWNER_MEMBER_ID)) return "others" as const;
  const owner = home.find((p) => p.member === OWNER_MEMBER_ID);
  return owner?.heard?.vessel === vessel && owner.heard.minutesAgo <= 5
    ? ("alone" as const)
    : ("unknown" as const);
});

const personaLayerRoutes = Effect.fn("BatonTessayaRoutes.personaLayers")(function* (
  router: HttpRouter.HttpRouter,
  context: Context.Context<BatonRpcHandlers.BatonServices>,
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  deskTools: {
    readonly specs: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  } | null,
  userdata: string,
) {
  const run = Effect.runPromiseWith(context);
  const registry = Context.getOption(context, PersonaLayers.PersonaLayers);
  if (Option.isNone(registry) || !PersonaLayers.internalBuild()) return;
  // The caller of each in-flight layer request, so a step-up is checked on that session and no other.
  const callers = new Map<string, ReturnType<typeof householdCallerOf> & { origin?: string }>();
  const decodeStepUp = Schema.decodeUnknownEffect(BatonHouseholdCallInput);
  const host: PersonaLayers.LayerHost = {
    stepUp: async (session, input) => {
      const caller = callers.get(session);
      const fields = (input ?? {}) as Record<string, unknown>;
      const method =
        fields["passkey"] !== undefined
          ? "passkey"
          : fields["hello"] !== undefined
            ? "hello"
            : "pin";
      if (caller === undefined || caller.member === null || caller.service) return null;
      const result = await run(
        decodeStepUp({ ...fields, op: "stepUp" }).pipe(
          Effect.flatMap((call) => Effect.flatMap(TessayaHousehold, (h) => h.call(call))),
          Effect.provideService(HouseholdCaller, caller),
          Effect.provideContext(context),
          Effect.orElseSucceed(() => null),
        ),
      );
      return result?.status === "done" ? { member: caller.member, method } : null;
    },
    // The desktop's own key for the layer's store, kept by Windows (DPAPI) and sent by the desktop app.
    deviceKey: async () => deviceKey,
    presence: (vessel) => run(presenceOn(vessel)),
    capabilities: async () => ({
      personas: readPack(userdata)
        .personas.filter((p) => p.private !== true)
        .map((p) => ({ id: p.id, name: p.name, role: p.role, lead: p.lead })),
      tools: (deskTools?.specs ?? []).map((t) => ({ name: t.name, description: t.description })),
    }),
  };
  let deviceKey: Uint8Array | null = null;
  registry.value.all.push(...(yield* Effect.promise(() => PersonaLayers.loadPersonaLayers(host))));
  const notHere = HttpServerResponse.jsonUnsafe(
    { message: "Not here." },
    { status: 404, headers: PAGE_HEADERS },
  );
  const serve = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const [id = "", ...rest] = new URL(request.url, "http://local").pathname
      .replace(/^\/tessaya\/layer\//, "")
      .split("/");
    const target = registry.value.all.find((l) => l.id === id);
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(session) || householdRefusal(session.value) !== null) return notHere;
    const caller = {
      ...householdCallerOf(session.value),
      ...(typeof request.headers["origin"] === "string"
        ? { origin: request.headers["origin"] }
        : {}),
    };
    const body =
      request.method === "POST" ? yield* request.json.pipe(Effect.orElseSucceed(() => ({}))) : {};
    if (id === "_desk") {
      if (!caller.desktop) return notHere;
      const desk = deskReport(body);
      if (desk.key !== null) deviceKey = desk.key;
      for (const kind of desk.signals) for (const l of registry.value.all) l.signal({ kind });
      return HttpServerResponse.jsonUnsafe(
        {
          open: registry.value.all.some((l) => l.active?.("desktop") === true),
          page:
            registry.value.all[0] === undefined
              ? null
              : `/tessaya/layer/${registry.value.all[0].id}`,
        },
        { headers: PAGE_HEADERS },
      );
    }
    if (target === undefined) return notHere;
    callers.set(caller.session, caller);
    const answer = yield* Effect.promise(() =>
      target
        .http({
          method: request.method === "POST" ? "POST" : "GET",
          path: rest.join("/"),
          member: caller.member,
          session: caller.session,
          body,
        })
        .finally(() => {
          if (callers.get(caller.session) === caller) callers.delete(caller.session);
        }),
    );
    return answer.body === undefined
      ? HttpServerResponse.jsonUnsafe(answer.json ?? {}, {
          status: answer.status,
          headers: PAGE_HEADERS,
        })
      : HttpServerResponse.text(answer.body, {
          status: answer.status,
          contentType: answer.contentType ?? "text/plain; charset=utf-8",
          headers: PAGE_HEADERS,
        });
  }).pipe(Effect.catchCause(() => Effect.succeed(notHere)));
  yield* router.add("GET", "/tessaya/layer/*", serve);
  yield* router.add("POST", "/tessaya/layer/*", serve);
});
