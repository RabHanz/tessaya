// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off
/**
 * The phone page at /tessaya (docs/baton/MOBILE.md): the page itself, then a small API behind the server's own session
 * (the pairing cookie, or a bearer token), with the rules in BatonTessayaApi. Mounted by TessayaServerLayer.routes.
 */
import { PRIVATE_KIND } from "@t3tools/tessaya-shared/provenance";
import { emitAction, emitActionSync } from "../provenance/ActionLog.ts";
import { effectFired } from "./turnActions.ts";
import { NONVERBALS } from "@t3tools/tessaya-shared/interjections";
import * as NodePath from "node:path";

import {
  BATON_METHOD_OF,
  TessayaPrivateCallInput,
  TessayaHouseholdCallInput,
  CommsCallInput,
  TessayaPrivateCallResult,
  TessayaRpcGroup,
} from "@t3tools/tessaya-contracts";
import { deskEvent } from "@t3tools/tessaya-shared/deskTurnStream";
import { buildPhoneState } from "@t3tools/tessaya-shared/phone";
import { AuthTessayaHandsHostScope } from "@t3tools/contracts";
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
import type { RoomToolSet } from "../home/R1Brain.ts";
import * as ServerConfig from "../config.ts";
import * as JobFlow from "./TessayaJobFlow.ts";
import { TessayaWeaveService } from "./TessayaWeaveService.ts";
import { TessayaSessionCatalogService } from "./TessayaSessionCatalogService.ts";
import * as TessayaRpcHandlers from "./TessayaRpcHandlers.ts";
import { TessayaRuntime } from "./TessayaRpcHandlers.ts";
import {
  DESK_METHODS,
  askSourceOf,
  memoryViewerOf,
  missingTessayaScope,
  householdCallerOf,
  householdRefusal,
  privateCallerOf,
  privateRefusal,
  syncCredentialOf,
} from "./TessayaRpcAuthorization.ts";
import { MemoryViewer, SyncCredential } from "./TessayaMemoryService.ts";
import { TessayaPresence } from "./TessayaPresence.ts";
import { SessionMember } from "./TessayaTurn.ts";
import { EMBEDDING_ROUTE, privateVoice, TessayaVoiceLibrary } from "./TessayaVoiceLibrary.ts";
import { DeskTurnBody, deskTurnStream } from "./DeskTurn.ts";
import { runAskWorker } from "./AskWorker.ts";
import { peerTurnHands, PeerTurnBody, relayDeskTurn, servePeerTurn } from "./DeskRelay.ts";
import { memberOfSubject, OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { callPrivate, PrivateCaller } from "./TessayaPrivateMemoryService.ts";
import { HouseholdCaller, TessayaHousehold } from "./TessayaHousehold.ts";
import { TessayaComms } from "./TessayaComms.ts";
import * as BrainHost from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { type PrivateTierAct, tierAct } from "./PrivateTier.ts";
import * as PersonaLayers from "./PersonaLayers.ts";
import { readPack } from "./OperatingSystemPack.ts";
import * as FleetQuery from "./FleetQuery.ts";
import { AskSource, TessayaPhoneInbox, answerCard } from "./TessayaPhoneInbox.ts";
import { handleHands } from "./TessayaHandsApi.ts";
import { TurnLiveContext } from "./TurnLiveContext.ts";
import { VesselHands } from "./VesselHands.ts";
import { handlePhone, readCapped, uploadRefusal, type PhoneDeps } from "./TessayaApi.ts";
import { TessayaUpcoming } from "./TessayaUpcoming.ts";
import { houseZone, isoIn } from "./houseZone.ts";
import { countdownText } from "@t3tools/tessaya-shared/upcoming";
import { recogniserTerms } from "@t3tools/tessaya-shared/vocabulary";
import { transcribeWav } from "./TessayaPhoneVoice.ts";
import { TessayaVocabulary } from "./TessayaVocabulary.ts";
import { HTML, MANIFEST, SCRIPT, SERVICE_WORKER } from "./TessayaPage.ts";
import { changePersona } from "./PersonaChanges.ts";
import { playgroundRoutes } from "./PlaygroundRoutes.ts";
import {
  feel,
  interruptBody,
  noteDeskWorld,
  privateBodyEnded,
  webBodyForm,
} from "./TessayaBody.ts";

/** Each direct-door method's payload decoder and result encoder, compiled once. */
const DESK_CODECS = new Map(
  [...DESK_METHODS].flatMap((tag) => {
    const rpc = TessayaRpcGroup.requests.get(tag);
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
    // blob: lets the 3D body's model loader read the textures packed inside a model file
    "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; media-src blob:; manifest-src 'self'; frame-ancestors 'none'",
} as const;

const page = (body: string, contentType: string) =>
  HttpServerResponse.text(body, { contentType, headers: PAGE_HEADERS });

const decodePushBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const context = yield* TessayaRuntime;
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
            const inbox = yield* TessayaPhoneInbox;
            const now = yield* Clock.currentTimeMillis;
            const fleet = yield* FleetQuery.getFleet({});
            return buildPhoneState({
              jobs: yield* JobFlow.listJobs(),
              findings: [
                ...watchFleet(fleet.entries, now),
                ...(yield* (yield* TessayaSessionCatalogService).watchFindings),
              ],
              weaves: (yield* (yield* TessayaWeaveService).list(30)) as never,
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
      ask: (id, text) =>
        run(Effect.flatMap(TessayaPhoneInbox, (inbox) => inbox.post({ id, text }))),
      askGet: (id) =>
        run(
          Effect.flatMap(TessayaPhoneInbox, (inbox) =>
            Effect.all({ ask: inbox.get(id), connected: inbox.connected }),
          ),
        ),
      answerPrompt: (id, index) =>
        run(Effect.flatMap(TessayaPhoneInbox, (inbox) => inbox.answerPrompt(id, index))),
      expired: (id) => run(Effect.flatMap(TessayaPhoneInbox, (inbox) => inbox.expired(id))),
      // The page is plain script: each countdown and clock comes from here, on the house's clock, and the page reads
      // the list again every 20 s while it is open.
      upcoming: () =>
        run(
          Effect.gen(function* () {
            const list = yield* (yield* TessayaUpcoming).list({});
            const zone = yield* houseZone();
            const now = yield* Clock.currentTimeMillis;
            return {
              ...list,
              items: list.items.map((item) => ({
                ...item,
                when: countdownText(item, now),
                // "11-21" for a date, "11-19 22:40" for a time, on the house's clock.
                clock:
                  item.at === null
                    ? null
                    : isoIn(item.at, zone)
                        .slice(5, item.allDay === true ? 10 : 16)
                        .replace("T", " "),
              })),
            };
          }),
        ),
      // From his phone: Tessaya's own items change at once; his own automations still ask.
      changeUpcoming: (input) =>
        run(
          Effect.flatMap(TessayaUpcoming, (upcoming) =>
            upcoming.change(input, { who: "the Director", surface: "phone" }),
          ).pipe(Effect.catchTags({ UpcomingError: (e) => Effect.succeed(e.reason) })),
        ),
      transcribe: async (wav) => {
        if (hearing)
          return { ok: false, why: "Still working on the last recording. Try again in a moment." };
        hearing = true;
        try {
          const vocabulary = await run(
            Effect.serviceOption(TessayaVocabulary).pipe(
              Effect.flatMap((store) =>
                Option.isSome(store) ? store.value.read : Effect.succeed([]),
              ),
            ),
          );
          return await transcribeWav({
            wav,
            env: process.env,
            userdataDir: NodePath.dirname(config.dbPath),
            vocabulary: recogniserTerms(vocabulary),
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
                Effect.flatMap(TessayaPhoneInbox, (inbox) => inbox.post({ id, text })).pipe(
                  Effect.provideService(AskSource, source),
                ),
              ),
            // Who says yes, and how sure: a yes counts only from a member whose role may give it (identity I-2).
            answerPrompt: (id, index) =>
              run(
                Effect.gen(function* () {
                  const caller = householdCallerOf(session.value);
                  const grants =
                    caller.member === null
                      ? null
                      : yield* Effect.flatMap(TessayaHousehold, (h) => h.grantsOf(caller.member!));
                  return yield* answerCard(id, index, {
                    member: caller.member,
                    role: caller.service ? "service" : (grants?.role ?? null),
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
          ...(typeof request.headers["mcp-session-id"] === "string"
            ? { mcpSession: request.headers["mcp-session-id"] }
            : {}),
        }),
      );
      return HttpServerResponse.jsonUnsafe(answer.json, {
        status: answer.status,
        headers: { ...PAGE_HEADERS, ...answer.headers },
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
    const handlers = yield* TessayaRpcHandlers.makeHandlers;
    const deskTools = yield* DeskTools;
    const decodeToolCall = Schema.decodeUnknownOption(DeskToolCall);
    const decodeDeskTurn = Schema.decodeUnknownOption(DeskTurnBody);
    const decodeDeskEffect = Schema.decodeUnknownOption(
      Schema.Struct({
        nonverbal: Schema.Literals(NONVERBALS),
        face: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32))),
      }),
    );
    // What the desktop did on its own (a hands step, an app command, a Settings save): names and outcomes, no content.
    const decodeDeskAction = Schema.decodeUnknownOption(
      Schema.Struct({
        kind: Schema.Literals(["desk.tool", "desk.look", "settings.changed"]),
        subject: Schema.String.check(Schema.isPattern(/^[\w.-]{1,80}$/)),
        outcome: Schema.optional(Schema.Literals(["ok", "fail"])),
        ms: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3_600_000 }))),
      }),
    );
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
        if (!session.value.scopes.includes(AuthTessayaHandsHostScope))
          return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 403 });
        return yield* deskToolsAnswer(calledAs, request);
      }
      // The one brain answers his phone's, the web bar's and agents' asks here (S6), as the desktop's setting says.
      if (calledAs === "brain-asks") {
        if (!session.value.scopes.includes(AuthTessayaHandsHostScope))
          return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 403 });
        const on = (
          (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as { on?: unknown }
        ).on;
        yield* Effect.flatMap(TessayaPhoneInbox, (inbox) =>
          inbox.setBrainAnswers(on === true),
        ).pipe(Effect.provideContext(context));
        return HttpServerResponse.jsonUnsafe({ value: { on: on === true } });
      }
      // Her voice reached a stage direction's word on the desktop (VOXTA-STUDY G7): logged, the desktop has no motor.
      if (calledAs === "effect") {
        if (!session.value.scopes.includes(AuthTessayaHandsHostScope))
          return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 403 });
        const body = decodeDeskEffect(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))));
        if (body._tag === "None")
          return HttpServerResponse.jsonUnsafe({ message: "Not an effect." }, { status: 400 });
        yield* effectFired({ vessel: "desktop", ...body.value, haptic: null });
        return HttpServerResponse.jsonUnsafe({});
      }
      if (calledAs === "action") {
        if (!session.value.scopes.includes(AuthTessayaHandsHostScope))
          return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 403 });
        const body = decodeDeskAction(yield* request.json.pipe(Effect.orElseSucceed(() => ({}))));
        if (body._tag === "None")
          return HttpServerResponse.jsonUnsafe({ message: "Not an action." }, { status: 400 });
        const member = memberOfSubject(session.value.subject);
        const { ms, ...action } = body.value;
        yield* emitAction({
          ...action,
          ...(ms === undefined ? {} : { data: { ms } }),
          // A hands step or look is hers; a Settings save is whoever signed this desktop in.
          actor:
            action.kind !== "settings.changed"
              ? { kind: "persona", certainty: 1 }
              : {
                  kind: member === null ? "owner" : "member",
                  id: member ?? OWNER_MEMBER_ID,
                  certainty: 0.8,
                },
          evidence: [
            { kind: "device", ref: "desktop" },
            { kind: "session", ref: String(session.value.sessionId) },
          ],
        });
        return HttpServerResponse.jsonUnsafe({});
      }
      // What her look at his screen saw (G6): her next two turns at the desk know it, then it is gone.
      if (calledAs === "sighting") {
        if (!session.value.scopes.includes(AuthTessayaHandsHostScope))
          return HttpServerResponse.jsonUnsafe({ message: "Not here." }, { status: 403 });
        const { line } = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
          line?: unknown;
        };
        if (typeof line !== "string" || line.trim() === "")
          return HttpServerResponse.jsonUnsafe({ message: "Not a sighting." }, { status: 400 });
        yield* Effect.serviceOption(TurnLiveContext).pipe(
          Effect.flatMap((live) =>
            live._tag === "None"
              ? Effect.void
              : live.value.inject({
                  key: "screen",
                  vessel: "desktop",
                  source: "screen",
                  expiresAfterTurns: 2,
                  line: `A moment ago you looked at his screen and said: "${line.slice(0, 400)}".`,
                }),
          ),
          Effect.provideContext(context),
        );
        return HttpServerResponse.jsonUnsafe({});
      }
      // His sentence at the desk, through the one brain (SPINE-UNIFY S4): only the desktop app's own session sends it.
      if (calledAs === "turn") {
        if (!session.value.scopes.includes(AuthTessayaHandsHostScope) || deskTools === null)
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
            Stream.map(deskEvent),
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
      const missing = missingTessayaScope(
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
    const decodePrivate = Schema.decodeUnknownEffect(TessayaPrivateCallInput);
    const encodePrivate = Schema.encodeUnknownEffect(TessayaPrivateCallResult);
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
      Schema.decodeUnknownEffect(TessayaHouseholdCallInput),
      (input) => Effect.flatMap(TessayaHousehold, (h) => h.call(input)),
    );
    const commsCall = memberRoute(Schema.decodeUnknownEffect(CommsCallInput), (input) =>
      Effect.flatMap(TessayaComms, (c) => c.call(input)),
    );
    // A removed member's one-use export link (identity I-6): their devices are signed out, so the token is the key.
    const exportByLink = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const token = new URL(request.url, "http://local").pathname.split("/").pop() ?? "";
      const found = yield* Effect.promise(() =>
        run(Effect.flatMap(TessayaHousehold, (h) => h.exportByLink(token))),
      );
      return Option.isNone(found)
        ? HttpServerResponse.jsonUnsafe(
            { message: "This export link has been used, or has run out." },
            { status: 404, headers: PAGE_HEADERS },
          )
        : HttpServerResponse.jsonUnsafe(found.value, {
            headers: {
              ...PAGE_HEADERS,
              "content-disposition": 'attachment; filename="my-tessaya-data.json"',
            },
          });
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
    yield* router.add("GET", "/tessaya/export/*", exportByLink);
    yield* router.add("POST", "/tessaya/household", householdCall);
    yield* router.add("POST", "/tessaya/comms", commsCall);
    yield* router.add("POST", "/tessaya/private", privateCall);
    // Placement (b): another of his servers sends his desk turn here, and runs this turn's calls to its desktop.
    const peer = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
      if (
        client._tag === "None" ||
        !client.value.peerLink ||
        client.value.access === "body-only" ||
        deskTools === null
      )
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
            Stream.map(deskEvent),
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
    // A clone's embedding for this machine's own Pocket (`voice_url`, which sends no token): only from loopback with
    // no proxy or tunnel in between, under the key its library view hands out (VOXTA G1).
    yield* router.add(
      "GET",
      `${EMBEDDING_ROUTE}*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const remote = Option.getOrUndefined(request.remoteAddress) ?? "";
        const proxied = ["cf-connecting-ip", "x-forwarded-for", "tailscale-user-login"].some(
          (h) => request.headers[h] !== undefined,
        );
        const [key = "", file = ""] = new URL(request.url, "http://local").pathname
          .slice(EMBEDDING_ROUTE.length)
          .split("/");
        const bytes =
          proxied || !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)
            ? null
            : yield* (yield* TessayaVoiceLibrary).embedding(key, file);
        return bytes === null
          ? HttpServerResponse.empty({ status: 404 })
          : HttpServerResponse.uint8Array(bytes, { contentType: "application/octet-stream" });
      }).pipe(Effect.provideContext(context)),
    );
    yield* personaLayerRoutes(router, context, auth, deskTools, NodePath.dirname(config.dbPath));
    yield* playgroundRoutes(router, context, auth, NodePath.dirname(config.dbPath));
  }),
);

/**
 * Owner-only persona layers' own pages and calls, under /tessaya/layer/<id>/ (PersonaLayers.ts). A public build loads
 * none and registers nothing. The host verifies a layer's step-up through the household, on the request's own session.
 */
/** What the desktop app reports to the layers: its device key (32 bytes, base64) and what just happened on it. */
export const deskReport = (body: unknown) => {
  const b = (body ?? {}) as { key?: unknown; signals?: unknown; world?: unknown };
  const key = typeof b.key === "string" ? Buffer.from(b.key, "base64") : null;
  const world = b.world as { fullscreen?: unknown; opened?: unknown } | null | undefined;
  return {
    key: key !== null && key.length === 32 ? new Uint8Array(key) : null,
    fullscreen: typeof world?.fullscreen === "boolean" ? world.fullscreen : null,
    opened: world?.opened === true,
    signals: Array.isArray(b.signals)
      ? b.signals.filter((k): k is string => typeof k === "string" && DESK_SIGNALS.has(k))
      : [],
  };
};
const DESK_SIGNALS = new Set([
  "screenLocked",
  "sleep",
  "idle",
  "call",
  "screenShared",
  "recording",
  // He talked over her on the desktop: only that vessel's acts stop; his session goes on.
  "bargeIn",
  // He closed his private window: that window's private moment ends, nothing else.
  "windowClosed",
]);

/**
 * What the phone (any client vessel but the desktop) reports to the layers: its registry id and what just happened on
 * it. The app leaving the front or closing the private screen ends that screen's private moment (M-133).
 */
export const vesselReport = (body: unknown) => {
  const b = (body ?? {}) as { vessel?: unknown; signals?: unknown };
  return {
    vessel:
      typeof b.vessel === "string" && /^phone-[a-z0-9]{1,24}$/.test(b.vessel) ? b.vessel : "phone",
    signals: Array.isArray(b.signals)
      ? b.signals.filter((k): k is string => typeof k === "string" && VESSEL_SIGNALS.has(k))
      : [],
  };
};
const VESSEL_SIGNALS = new Set(["windowClosed", "screenLocked", "bargeIn"]);
/** The phone's private screen is the layer's window on its signed-in session, not the phone's registry id. */
export const layerVessel = (
  layer: Pick<PersonaLayers.PersonaLayer, "windowOf">,
  session: string | null,
  reported: string,
): string => (session === null ? reported : (layer.windowOf?.(session) ?? reported));

const personaLayerRoutes = Effect.fn("TessayaRoutes.personaLayers")(function* (
  router: HttpRouter.HttpRouter,
  context: Context.Context<TessayaRpcHandlers.TessayaServices>,
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  deskTools: RoomToolSet | null,
  userdata: string,
) {
  const run = Effect.runPromiseWith(context);
  const registry = Context.getOption(context, PersonaLayers.PersonaLayers);
  if (Option.isNone(registry) || !PersonaLayers.internalBuild()) return;
  // The caller of each in-flight layer request, so a step-up is checked on that session and no other.
  const callers = new Map<string, ReturnType<typeof householdCallerOf> & { origin?: string }>();
  const decodeStepUp = Schema.decodeUnknownEffect(TessayaHouseholdCallInput);
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
    speak: ({ persona, clone, text }) =>
      run(
        Effect.gen(function* () {
          const voices = yield* TessayaVoiceLibrary;
          const pick = privateVoice(yield* voices.library, persona, clone);
          if (pick === null) return null;
          const said = yield* voices.say({ ...pick, text });
          return new Uint8Array(Buffer.from(said.base64, "base64"));
        }).pipe(Effect.orElseSucceed(() => null)),
      ),
    privatePointer: ({ id, at, cause }) =>
      void emitActionSync(
        { id, at, kind: PRIVATE_KIND, actor: { kind: "system", certainty: 1 }, cause },
        { now: at },
      ),
    privateEvent: (event) => emitActionSync({ ...event, private: true }),
    libraryRemoved: (sources) =>
      void run(
        Effect.gen(function* () {
          const brain = yield* BrainHost.makeBrainLink;
          // the library key never leaves the brain: a worker sends the list, the brain seals it
          if (yield* brain.isBrain) yield* receiveAtBrain("libraryRemoved", { sources });
          else yield* brain.send("libraryRemoved", { sources });
        }).pipe(Effect.ignore),
      ),
    tier: {
      get: (name) =>
        run(onBrain({ get: name })).then((v) => {
          const file = v as { rev?: unknown; blob?: unknown } | null;
          return file !== null && typeof file.rev === "number" && typeof file.blob === "string"
            ? { rev: file.rev, bytes: new Uint8Array(Buffer.from(file.blob, "base64")) }
            : null;
        }),
      revs: () =>
        run(onBrain({ revs: true })).then((v) =>
          typeof v === "object" &&
          v !== null &&
          Object.values(v).every((r) => typeof r === "number")
            ? (v as Record<string, number>)
            : null,
        ),
      put: (name, rev, bytes) =>
        run(onBrain({ put: { name, rev, blob: Buffer.from(bytes).toString("base64") } })).then(
          (v) => {
            const kept = v as { kept?: unknown; rev?: unknown } | null;
            return kept !== null && typeof kept.kept === "boolean" && typeof kept.rev === "number"
              ? { kept: kept.kept, rev: kept.rev }
              : null;
          },
        ),
    },
    presence: (vessel) => run(PersonaLayers.layerPresence(vessel)),
    // Her own window's turns read and act as every other turn of hers does, on this server's shared tools.
    brain: (turn) =>
      Effect.runSyncWith(context)(
        PersonaLayers.layerBrain(
          {
            vessel: turn.vessel,
            origin: turn.vessel.kind,
            text: turn.text,
            ...(turn.persona === null ? {} : { persona: turn.persona }),
            member: turn.member,
            conversation: turn.conversation,
            sessionless: true,
            tainted: turn.tainted,
            sharedRoom: turn.sharedRoom,
            rehearsal: turn.rehearsal,
          },
          { tools: deskTools },
        ),
      ),
    sealedPersona: async ({ layer, name }) => {
      const made = await run(
        changePersona(
          {
            op: "create",
            draft: {
              name,
              role: "a private character, sealed in his private layer",
              private: true,
              privateRooms: "open",
              sealed: layer,
            },
          },
          { owner: true },
        ).pipe(Effect.orElseSucceed(() => null)),
      );
      return made?.ok === true ? (made.id ?? null) : null;
    },
    touched: ({ part, kind, self }) =>
      run(
        Effect.asVoid(feel({ vessel: "desktop", part, kind, ...(self === true ? { self } : {}) })),
      ),
    bodyForm: () => run(webBodyForm()),
    capabilities: async () => ({
      personas: readPack(userdata).personas.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        lead: p.lead,
        ...(p.private === true
          ? {
              private: true,
              privateRooms: p.privateRooms ?? "open",
              ...(p.sealed === undefined ? {} : { sealed: true }),
              brief: p.character ?? p.role,
            }
          : {}),
      })),
      tools: (deskTools?.specs ?? []).map((t) => ({ name: t.name, description: t.description })),
      // A layer offers a line's tone only where his voice was recorded in it (VOXTA G1).
      voices: ((await run(Effect.flatMap(TessayaVoiceLibrary, (v) => v.library))).clones ?? []).map(
        (c) => ({ id: c.id, name: c.name, affects: c.affects ?? [] }),
      ),
    }),
  };
  let deviceKey: Uint8Array | null = null;
  // A tier act on the brain: here when this server is the brain, else over the peer link; null when not reached.
  const onBrain = Effect.fn("TessayaRoutes.privateTier")(
    function* (act: PrivateTierAct) {
      const brain = yield* BrainHost.makeBrainLink;
      if (yield* brain.isBrain) return yield* tierAct(act, yield* Clock.currentTimeMillis);
      return Option.getOrNull(yield* brain.send("privateTier", act));
    },
    Effect.orElseSucceed(() => null),
  );
  registry.value.all.push(...(yield* Effect.promise(() => PersonaLayers.loadPersonaLayers(host))));
  // the long polls a layer answers that its pages may take as a socket instead
  const PUSHED: ReadonlySet<string> = new Set(["body.stream", "body.moves"]);
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
      for (const kind of desk.signals)
        for (const l of registry.value.all)
          l.signal(
            kind === "bargeIn"
              ? { kind, vessel: "desktop" }
              : kind === "windowClosed"
                ? { kind, session: caller.session }
                : { kind },
          );
      if (desk.signals.includes("bargeIn")) yield* interruptBody();
      // what her desk world is now, so her own wishes keep out of his way (a film, a game, a call)
      yield* noteDeskWorld({
        ...(desk.fullscreen === null ? {} : { fullscreen: desk.fullscreen }),
        ...(desk.signals.includes("call") ? { call: true } : {}),
        ...(desk.opened ? { opened: true } : {}),
      });
      // A locked or sleeping desk ends a private moment there: a private conversation loses her body at once.
      if (desk.signals.some((k) => k === "screenLocked" || k === "sleep"))
        yield* privateBodyEnded();
      if (desk.signals.includes("bargeIn"))
        yield* emitAction({
          kind: "desk.voice.barge",
          actor: { kind: "device", id: "desktop", certainty: 1 },
          subject: "desktop",
          evidence: [{ kind: "device", ref: "desktop" }],
        });
      // A locked, sleeping or long-idle desktop: they stepped away from it (B-043).
      const away = desk.signals.some((k) => k === "screenLocked" || k === "sleep")
        ? "deskAway"
        : desk.signals.includes("idle")
          ? "deskIdle"
          : null;
      if (caller.member !== null && away !== null)
        yield* Effect.serviceOption(TessayaPresence).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (p) => p.note({ member: caller.member, source: away, vessel: null }),
            }),
          ),
        );
      return HttpServerResponse.jsonUnsafe(
        {
          open: registry.value.all.some((l) => l.active?.("desktop") === true),
          persona:
            registry.value.all.map((l) => l.opened?.("desktop") ?? null).find((p) => p !== null) ??
            null,
          page:
            registry.value.all[0] === undefined
              ? null
              : `/tessaya/layer/${registry.value.all[0].id}`,
        },
        { headers: PAGE_HEADERS },
      );
    }
    if (id === "_vessel") {
      if (caller.desktop || caller.service || caller.member === null) return notHere;
      const report = vesselReport(body);
      const vesselIn = (l: PersonaLayers.PersonaLayer) =>
        layerVessel(l, caller.session, report.vessel);
      for (const kind of report.signals)
        for (const l of registry.value.all)
          l.signal(
            kind === "windowClosed"
              ? { kind, session: caller.session }
              : { kind, vessel: vesselIn(l) },
          );
      return HttpServerResponse.jsonUnsafe(
        {
          open: registry.value.all.some((l) => l.active?.(vesselIn(l)) === true),
          persona:
            registry.value.all
              .map((l) => l.opened?.(vesselIn(l)) ?? null)
              .find((p) => p !== null) ?? null,
          page:
            registry.value.all[0] === undefined
              ? null
              : `/tessaya/layer/${registry.value.all[0].id}`,
          // who else is home, so the phone keeps her private voice off its loudspeaker unless he is alone
          presence: yield* Effect.promise(() =>
            run(PersonaLayers.layerPresence(report.vessel)).catch(() => "unknown" as const),
          ),
        },
        { headers: PAGE_HEADERS },
      );
    }
    if (target === undefined) return notHere;
    if (rest[0] === "_push" && request.headers["upgrade"]?.toLowerCase() === "websocket") {
      const path = rest.slice(1).join("/");
      if (!PUSHED.has(path)) return notHere;
      return yield* pushSocket(request, target, path, caller);
    }
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
    if (answer.bytes !== undefined)
      return HttpServerResponse.uint8Array(answer.bytes, {
        status: answer.status,
        contentType: answer.contentType ?? "application/octet-stream",
        headers: PAGE_HEADERS,
      });
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
  /**
   * A layer's long poll (body.stream, body.moves) as a socket: the server holds the poll in-process and pushes each
   * answer the moment the layer has one, so a move never waits for the client's next request (remote links most).
   * `?body=` is the poll's own body; the server sets `after` and `wait`. Nothing runs while nothing is published.
   */
  const pushSocket = Effect.fn("TessayaRoutes.layerPush")(function* (
    request: HttpServerRequest.HttpServerRequest,
    target: PersonaLayers.PersonaLayer,
    path: string,
    caller: { readonly member: string | null; readonly session: string },
  ) {
    const raw = new URL(request.url, "http://local").searchParams.get("body") ?? "{}";
    const base =
      raw.length > 2000 ? {} : yield* decodePushBody(raw).pipe(Effect.orElseSucceed(() => ({})));
    const fields = typeof base === "object" && base !== null && !Array.isArray(base) ? base : {};
    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const write = (yield* socket.writer).write;
        const { pull } = yield* socket.reader;
        const loop = PersonaLayers.pushAnswers(
          target,
          { path, member: caller.member, session: caller.session, body: fields },
          (text) => write(text),
        );
        // the client closing its end (or anything it sends) ends the push
        return yield* Effect.raceFirst(loop, Effect.forever(pull));
      }),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  });
  yield* router.add("GET", "/tessaya/layer/*", serve);
  yield* router.add("POST", "/tessaya/layer/*", serve);
});
