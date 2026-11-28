// @effect-diagnostics nodeBuiltinImport:off
/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Everything Baton adds to the server, as two layers the server mounts at one point each
 * (`vendor-patches/t3code/0002-server-hooks.patch`):
 *
 * - `services`: work sessions, rules, intents, adopted sessions, the account pool, the engine
 *   seam and the one-shot model, with Baton's repositories on Baton's own database.
 * - `workers`: the reactors that follow upstream's events (synopsis, rules) and the account
 *   rotation tick, started the way upstream starts `PullRequestSyncReactor`.
 *
 * Later entries provide to earlier ones, so the order below is the dependency order.
 */
import * as ActionLog from "../provenance/ActionLog.ts";
import * as FindingsReactor from "../provenance/FindingsReactor.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodePath from "node:path";

import { setClaudeAccountInstances } from "@t3tools/tessaya-contracts";
import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { claudeAccountInstances } from "./ClaudeAccountInstances.ts";
import * as AccountPoolService from "./AccountPoolService.ts";
import * as TessayaAccounts from "./TessayaAccounts.ts";
import * as AccountRotationPolicy from "./AccountRotationPolicy.ts";
import * as TessayaMemorySync from "./TessayaMemorySync.ts";
import * as FleetCoherence from "./FleetCoherence.ts";
import * as ActionShip from "../provenance/ActionShip.ts";
import * as HouseholdSettings from "./HouseholdSettings.ts";
import * as BrainHost from "./BrainHost.ts";
import * as HouseholdDevices from "./HouseholdDevices.ts";
import * as AccountRotationReactor from "./AccountRotationReactor.ts";
import * as AdoptedSessionService from "./AdoptedSessionService.ts";
import * as TessayaDatabase from "./TessayaDatabase.ts";
import * as Consent from "./consent.ts";
import * as TessayaEngine from "./TessayaEngine.ts";
import * as TessayaJobReactor from "./TessayaJobReactor.ts";
import * as TessayaJobService from "./TessayaJobService.ts";
import * as TessayaRecordService from "./TessayaRecordService.ts";
import * as BrainUsage from "./BrainUsage.ts";
import * as VesselHands from "./VesselHands.ts";
import * as TessayaWeaveBoxes from "./TessayaWeaveBoxes.ts";
import * as TessayaCloudService from "./TessayaCloudService.ts";
import * as HomeAssistantConnection from "../home/HomeAssistantConnection.ts";
import * as HomeAssistantService from "../home/HomeAssistantService.ts";
import * as R1Brain from "../home/R1Brain.ts";
import * as TessayaHousehold from "./TessayaHousehold.ts";
import * as TessayaComms from "./TessayaComms.ts";
import * as VoiceForgets from "./VoiceForgets.ts";
import * as MemberPreferences from "./MemberPreferences.ts";
import * as TessayaPeople from "./TessayaPeople.ts";
import * as PresenceFeeds from "./PresenceFeeds.ts";
import * as TessayaPresence from "./TessayaPresence.ts";
import * as TurnLiveContext from "./TurnLiveContext.ts";
import * as TessayaPulse from "./TessayaPulse.ts";
import * as TessayaBody from "./TessayaBody.ts";
import * as ProblemReports from "./ProblemReports.ts";
import * as StepUps from "../home/StepUps.ts";
import * as TessayaTurn from "./TessayaTurn.ts";
import * as TurnPools from "./TurnPools.ts";
import * as PersonaOps from "./PersonaOps.ts";
import * as TessayaMargin from "./TessayaMargin.ts";
import * as R1Device from "../home/R1Device.ts";
import * as HomeDevices from "../home/HomeDevices.ts";
import * as R1Hub from "../home/R1Hub.ts";
import * as R1Pairing from "../home/R1Pairing.ts";
import * as R1Loop from "../home/R1Loop.ts";
import * as R1Reach from "../home/R1Reach.ts";
import * as DeviceSync from "../home/DeviceSync.ts";
import * as R1Updates from "../home/R1Updates.ts";
import * as DeviceRegistry from "../home/DeviceRegistry.ts";
import * as VesselBodies from "../home/VesselBodies.ts";
import * as VoiceArbiter from "../home/VoiceArbiter.ts";
import * as DeviceTriggers from "../home/DeviceTriggers.ts";
import * as HomeDeviceRoutes from "../home/HomeDeviceRoutes.ts";
import * as TessayaSessionCatalogService from "./TessayaSessionCatalogService.ts";
import * as TessayaSessionsAcross from "./TessayaSessionsAcross.ts";
import * as TessayaSessionInsight from "./TessayaSessionInsight.ts";
import * as TessayaWeaveService from "./TessayaWeaveService.ts";
import * as TessayaAlarms from "./TessayaAlarms.ts";
import * as TessayaCommitmentService from "./TessayaCommitmentService.ts";
import * as TessayaMemoryLearning from "./TessayaMemoryLearning.ts";
import * as TessayaMemoryReactor from "./TessayaMemoryReactor.ts";
import * as TessayaMemoryEmbedder from "./TessayaMemoryEmbedder.ts";
import * as TessayaMemoryService from "./TessayaMemoryService.ts";
import * as TessayaPrivateMemoryService from "./TessayaPrivateMemoryService.ts";
import * as TessayaVocabulary from "./TessayaVocabulary.ts";
import * as TessayaVoiceLibrary from "./TessayaVoiceLibrary.ts";
import { packFileTexts } from "./OperatingSystemPack.ts";
import * as TessayaOneShot from "./TessayaOneShot.ts";
import * as TessayaUnderstanding from "./TessayaUnderstanding.ts";
import * as TessayaExpression from "./TessayaExpression.ts";
import * as TessayaPhoneInbox from "./TessayaPhoneInbox.ts";
import * as TessayaCast from "./TessayaCast.ts";
import * as TessayaDesktopSettings from "./TessayaDesktopSettings.ts";
import * as TessayaRoutes from "./TessayaRoutes.ts";
import * as TessayaRpcHandlers from "./TessayaRpcHandlers.ts";
import * as HerdrAdapter from "./HerdrAdapterLive.ts";
import * as IntentExecutor from "./IntentExecutorLive.ts";
import * as IntentService from "./IntentService.ts";
import * as SessionWatchdog from "./SessionWatchdog.ts";
import * as LiveSessionMirror from "./LiveSessionMirror.ts";
import * as OrchestrationEffects from "./OrchestrationEffectsLive.ts";
import * as OrchestrationReactor from "./OrchestrationReactor.ts";
import * as OrchestrationRuleService from "./OrchestrationRuleService.ts";
import * as SynopsisReactor from "./SynopsisReactor.ts";
import * as ThreadAccountMoves from "./ThreadAccountMoves.ts";
import * as TessayaUpcoming from "./TessayaUpcoming.ts";
import * as WorkSessionService from "./WorkSessionService.ts";
import * as TessayaWake from "./TessayaWake.ts";
import * as TessayaWakeRoutes from "./TessayaWakeRoutes.ts";
import * as TessayaAnnounceRoutes from "./TessayaAnnounceRoutes.ts";
import * as TessayaPackRoutes from "./TessayaPackRoutes.ts";
import * as CurrentPersona from "./CurrentPersona.ts";
import * as TessayaMood from "./TessayaMood.ts";
import * as PersonaLayers from "./PersonaLayers.ts";
import * as PromptLab from "./PromptLab.ts";
import { adoptTessayaEnv } from "@t3tools/tessaya-shared/tessayaEnv";

const readClaudeAccountInstances = Layer.effectDiscard(
  Effect.gen(function* () {
    const map = claudeAccountInstances(
      (yield* HostProcess.Environment).BATON_CLAUDE_ACCOUNT_INSTANCES,
    );
    setClaudeAccountInstances(map);
    const ids = Object.keys((yield* (yield* ServerSettingsService).getSettings).providerInstances);
    if (Object.keys(map).length === 0 && ids.some((id) => id.startsWith("claudeAgent_"))) {
      yield* Effect.logWarning(
        "Claude token instances exist but TESSAYA_CLAUDE_ACCOUNT_INSTANCES (or the old BATON_CLAUDE_ACCOUNT_INSTANCES) is not set: their limits are unknown and none is a rotation target",
        { instances: ids.filter((id) => id.startsWith("claudeAgent_")) },
      );
    }
  }),
);

// His private pack's text is refused by memory's door (D148); read fresh, so an edit counts at once.
const localMemoryLayer = TessayaMemoryService.layer.pipe(
  // Recall by meaning, when this server has the model (MEM-13); keyword recall otherwise.
  Layer.provide(TessayaMemoryEmbedder.layer),
  Layer.provide(
    Layer.effect(
      TessayaMemoryService.MemoryPrivateTexts,
      Effect.map(
        ServerConfig.ServerConfig,
        (config) => () => packFileTexts(NodePath.dirname(config.dbPath)),
      ),
    ),
  ),
);

// Her one memory: on a server that isn't her brain, what she knows is read and written there (one-self move 3).
const memoryLayer = TessayaMemoryService.oneBrain.pipe(Layer.provide(localMemoryLayer));

// One instance: the sessions list keeps its messages in this table, and two drainers would type a row twice.
const weaveLayer = TessayaWeaveService.layer.pipe(
  Layer.provide(TessayaWeaveBoxes.layer.pipe(Layer.provide(HerdrAdapter.layer))),
  Layer.provide(TessayaWeaveService.storesLayer),
);

// Home Assistant: one connection per server, its cards on the phone inbox. One value, so the devices share it.
const homeLayer = HomeAssistantService.layer.pipe(
  Layer.provide(HomeAssistantConnection.layer),
  Layer.provide(TessayaPhoneInbox.layer),
);

// Her lines for every vessel: written ahead on her voice route, picked without waiting on a model. One value, shared.
const expressionLayer = TessayaExpression.layer.pipe(
  Layer.provide(TessayaOneShot.layer),
  Layer.provide(homeLayer),
);

// The R1's own MQTT hub: one instance, so the route, the devices and every publish share its subscribers.
const hubLayer = R1Hub.layer.pipe(Layer.provide(homeLayer));
// Each device's key, his choices for it and every server's hub, kept alike on his linked servers. One instance.
const syncLayer = DeviceSync.layer.pipe(Layer.provide(hubLayer), Layer.provide(homeLayer));
// Where the R1 should connect (every one of his hubs in its order), kept current on it.
// The room loop says whether this hub can hear her; a hub that cannot is left out of her list.
const loopLayer = R1Loop.layer.pipe(Layer.provide(hubLayer), Layer.provide(homeLayer));
const reachLayer = R1Reach.layer.pipe(
  Layer.provide(loopLayer),
  Layer.provide(syncLayer),
  Layer.provide(hubLayer),
  Layer.provide(homeLayer),
);
// Firmware for the R1s on the hub, served by this server and installed when they are idle.
const updatesLayer = R1Updates.layer.pipe(
  Layer.provide(expressionLayer),
  Layer.provide(reachLayer),
  Layer.provide(hubLayer),
  Layer.provide(homeLayer),
);
const pairingLayer = R1Pairing.layer.pipe(
  Layer.provide(reachLayer),
  Layer.provide(hubLayer),
  Layer.provide(homeLayer),
);

// The bodies vessels sit in (Dock, plush, stand), read from their NFC tags; one instance for the devices and the door.
const vesselBodiesLayer = VesselBodies.layer.pipe(Layer.provide(DeviceRegistry.layer));

// The R1 and later devices: one instance, shared by the rules that drive them.
const homeDevicesLayer = HomeDevices.layer.pipe(
  Layer.provide(vesselBodiesLayer),
  Layer.provide(HomeDevices.brokerLayer.pipe(Layer.provide(hubLayer))),
  Layer.provide(reachLayer),
  Layer.provide(syncLayer),
  // Firmware installs he asks for go through the devices' approval and audit, then the one updater.
  Layer.provide(updatesLayer),
  Layer.provide(DeviceRegistry.layer),
  Layer.provide(homeLayer),
  // A button bound to a thread continues or stops it through the engine's own door.
  Layer.provide(
    Layer.effect(
      HomeDevices.HomeDeviceThreads,
      Effect.map(TessayaEngine.TessayaEngine, (engine) =>
        HomeDevices.HomeDeviceThreads.of({
          run: Effect.fn("HomeDevices.HomeDeviceThreads.run")(function* (threadId, what) {
            const input = { tag: "r1-key", threadId: ThreadId.make(threadId) };
            return what === "stop"
              ? yield* engine.interruptThread(input)
              : yield* engine.sendMessage({ ...input, text: "Continue." });
          }),
        }),
      ),
    ).pipe(Layer.provide(TessayaEngine.layer)),
  ),
  Layer.provide(TessayaPhoneInbox.layer),
);

// Her pulse (B-003) beside the intent surface, so every service provided below reaches it.
const servicesInner = Layer.mergeAll(
  IntentService.layer,
  // Coming up: reads each owner below through the caller's context; it keeps nothing of its own.
  TessayaUpcoming.layer,
  // What his coding sessions are doing and his words to them (M-104), for MCP and every voice.
  TessayaSessionInsight.layer.pipe(
    Layer.provide(TessayaOneShot.layer),
    Layer.provide(TessayaEngine.layer),
  ),
  TessayaPulse.layer,
  TessayaBody.wishLayer,
  FindingsReactor.layer,
).pipe(
  // The intent surface consumes the reactor, the rule service and the same narrow effects a
  // rule uses, rather than reaching the engine on its own: one sentence and one rule cause work
  // through the same door.
  // Problem reports and the developer feed sit under the pulse, which says her one line when she sends one.
  Layer.provideMerge(Layer.mergeAll(IntentExecutor.layer, ProblemReports.layer)),
  Layer.provideMerge(SynopsisReactor.layer),
  Layer.provideMerge(OrchestrationReactor.layer),
  Layer.provideMerge(OrchestrationEffects.layer),
  Layer.provideMerge(OrchestrationRuleService.layer),
  // One turn pipeline for every vessel; it reads the memory, learning and private stores provided below it.
  Layer.provideMerge(TessayaTurn.layer),
  // Shared slots for the brain and the learning loop, across every vessel (§2.0a).
  // Presence that watches (B-043): the home network and Home Assistant into TessayaPresence, over the house below.
  // One step with the pools: the pipe holds 20. Persona ops sits here to see the household and the inbox below.
  Layer.provideMerge(
    Layer.mergeAll(
      TurnPools.layer,
      PresenceFeeds.layer,
      PersonaOps.layer.pipe(Layer.provide(TessayaPhoneInbox.layer)),
      TessayaMargin.layer.pipe(Layer.provide(TessayaPhoneInbox.layer)),
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      // One work-session service for the whole server, so a mutation arriving on one client's
      // socket reaches every other client's subscription.
      WorkSessionService.layer,
      TessayaJobService.layer.pipe(Layer.provide(WorkSessionService.layer)),
      memoryLayer,
      TessayaCommitmentService.layer,
      TessayaPhoneInbox.layer,
      TessayaDesktopSettings.layer,
      TessayaCloudService.layer,
      homeLayer,
      // The R1 and later devices: the broker comes from the R1's record in Home; camera and reboot asks go to the phone.
      // One owner of every device's manifest and values: the R1 through the broker, desktops and phones as clients.
      DeviceRegistry.layer,
      // One responder per utterance across every vessel that heard him (R1-P7).
      // Her brain holds the one arbiter, other servers claim there; the registry says which vessels are online.
      VoiceArbiter.layer.pipe(Layer.provide(homeLayer), Layer.provide(DeviceRegistry.layer)),
      // Rules on device state, fired on each registry change; their actions go through the devices and the house.
      DeviceTriggers.layer.pipe(
        Layer.provide(homeDevicesLayer),
        Layer.provide(DeviceRegistry.layer),
        Layer.provide(homeLayer),
        Layer.provide(TessayaOneShot.layer),
      ),
      homeDevicesLayer,
      // Alarms and spoken wake-ups (M-108): her commitments, rung on the Tessel nearest him by her brain.
      TessayaAlarms.layer.pipe(
        Layer.provide(homeDevicesLayer),
        Layer.provide(TessayaCommitmentService.layer),
        Layer.provide(homeLayer),
      ),
      vesselBodiesLayer,
      // The engine is provided here: a sibling in this mergeAll is not visible to it, and without it a new session
      // on a machine with no Herdr found no way to start a thread.
      TessayaSessionCatalogService.layer.pipe(
        Layer.provide(AdoptedSessionService.layer.pipe(Layer.provide(HerdrAdapter.layer))),
        Layer.provide(TessayaEngine.layer),
        Layer.provide(weaveLayer),
        Layer.provide(TessayaAccounts.layer.pipe(Layer.provide(AccountPoolService.layer))),
      ),
      weaveLayer,
      // This server's live sessions and each linked environment's, for the desktop with T3's window closed (GEN-6).
      TessayaSessionsAcross.layer.pipe(
        Layer.provide(AdoptedSessionService.layer.pipe(Layer.provide(HerdrAdapter.layer))),
        Layer.provide(TessayaEngine.layer),
        Layer.provide(WorkSessionService.layer),
      ),
      TessayaMemoryLearning.layer.pipe(
        Layer.provide(memoryLayer),
        Layer.provide(TessayaOneShot.layer),
      ),
      // Memory sync with his other servers on this server's own clock, not T3's window (GEN-6).
      // sync keeps this server's read copy (for when the brain can't be reached) in step: its own store
      TessayaMemorySync.layer.pipe(Layer.provide(localMemoryLayer)),
      // a worker's changes that waited for the brain land once it is back (one truth, nothing lost)
      BrainHost.outboxLayer,
      // a worker tells the brain its build, brain, login and store digests each minute (M-146)
      FleetCoherence.reportLayer,
      // a worker's own Record events reach the brain's one Record (21 Nov)
      ActionShip.layer,
      // the household's settings, from the brain, with a worker's edits written through (21 Nov)
      HouseholdSettings.layer,
      // one phone, every machine: a sign-out of a household device here is a sign-out everywhere (M-097)
      HouseholdDevices.layer,
      // a desk body reaches her brain the moment it shows, hides or moves, so every vessel knows it (20 Nov)
      TessayaCast.reportDesksLayer.pipe(Layer.provide(DeviceRegistry.layer)),
      // Her standing understanding of each person and of herself (G4), versioned in the one memory.
      TessayaUnderstanding.layer.pipe(
        Layer.provide(memoryLayer),
        Layer.provide(TessayaOneShot.layer),
      ),
      readClaudeAccountInstances,
      AccountPoolService.layer,
      TessayaAccounts.layer.pipe(Layer.provide(AccountPoolService.layer)),
      AccountRotationPolicy.layer,
      ThreadAccountMoves.layer.pipe(
        Layer.provide(TessayaEngine.layer),
        Layer.provide(AccountPoolService.layer),
        Layer.provide(AdoptedSessionService.layer.pipe(Layer.provide(HerdrAdapter.layer))),
      ),
      // The adapter is provided here so the one place that talks to another program stays
      // visible, and a machine without Herdr still gets a service that refuses by name.
      AdoptedSessionService.layer.pipe(Layer.provide(HerdrAdapter.layer)),
      TessayaEngine.layer,
      TessayaOneShot.layer,
      // The R1's warm brain; it starts a Claude process only once an R1 is set up and asks.
      R1Brain.layer(R1Device.R1_STREAM_SYSTEM),
    ),
  ),
  // Beside the mergeAll above, not in it: one more member there loses its types.
  // The household's members, over the private stores it shreds; asks for the owner's yes go through the phone inbox.
  // A private store is only a member's: the store service asks the household, from its home server.
  // What she keeps about a member waits for their own yes (identity I-4), as the household on the brain records it.
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effect(
        TessayaPrivateMemoryService.StoreMembership,
        Effect.map(TessayaHousehold.TessayaHousehold, (household) =>
          TessayaPrivateMemoryService.StoreMembership.of({
            isMember: Effect.fn("StoreMembership.isMember")((personId: string) =>
              Effect.map(household.grantsOf(personId), (grants) => grants !== null),
            ),
            isChild: Effect.fn("StoreMembership.isChild")((personId: string) =>
              Effect.map(household.roleOf(personId), (role) => role === "child"),
            ),
          }),
        ),
      ),
      Layer.effect(
        TessayaMemoryService.MemberConsent,
        Effect.map(TessayaHousehold.TessayaHousehold, (household) =>
          TessayaMemoryService.MemberConsent.of({ mayKeep: household.consented }),
        ),
      ),
    ),
  ),
  // Comms (notes, calls, consent) over the household it reads who is who from; one step, as the pipe holds 20.
  Layer.provideMerge(
    TessayaComms.layer.pipe(
      Layer.provideMerge(TessayaHousehold.layer.pipe(Layer.provide(TessayaPhoneInbox.layer))),
    ),
  ),
  // The action log (B-046) over his private store, which seals its private events.
  Layer.provideMerge(ActionLog.layer.pipe(Layer.provideMerge(TessayaPrivateMemoryService.layer))),
  // The voices, and his one dictionary, which the voice door, the device route and every vessel's turn read.
  Layer.provideMerge(Layer.mergeAll(TessayaVoiceLibrary.layer, TessayaVocabulary.layer)),
  // Voices to forget, between the household and every vessel's owner: under both, so each sees it.
  // With them, what every machine believes, for the brain's fleet check (M-146): under health and the brain door.
  Layer.provideMerge(Layer.mergeAll(VoiceForgets.layer, FleetCoherence.layer)),
  // Members' voice defaults and acts held for a step-up, between the turn and runner and every vessel's owner.
  // Her lines for every vessel, beside the members' preferences.
  // Who each person is talking to (P5), written by the turn and told to the room loops by the broker.
  Layer.provideMerge(
    Layer.mergeAll(
      MemberPreferences.layer,
      // Where each member is, from every vessel's signals (B-043): the turn, comms, job news and the Tessels share it.
      TessayaPresence.layer,
      // Live state for the next few turns, then gone (G6): motion and other feeders write, every vessel's turn reads.
      TurnLiveContext.layer,
      // Who a voice that is no member is, across vessels (HOUSEHOLD-DESIGN §11): the household's people ops answer here.
      TessayaPeople.layer,
      expressionLayer,
      CurrentPersona.layer,
      // Who wears which body (Settings → Cast): its siblings here are invisible to it, so they are provided.
      TessayaCast.layer.pipe(
        Layer.provide(CurrentPersona.layer),
        Layer.provide(DeviceRegistry.layer),
        Layer.provide(TessayaDesktopSettings.layer),
      ),
      // Her mood per persona (CS6): the turn writes it, every vessel's face and words read it.
      // Built over the people graph (the same memoised layer): it follows who is forgotten or merged.
      TessayaMood.layer.pipe(
        Layer.provide(Layer.mergeAll(TessayaOneShot.layer, TessayaPeople.layer)),
      ),
      PersonaLayers.layer,
      // The prompt lab (B-030): its runs are one-shots on his subscription.
      PromptLab.layer.pipe(Layer.provide(TessayaOneShot.layer)),
    ),
  ),
  // His standing yeses on this database too, for the room's runners, which run beside upstream's SqlClient.
  Layer.provideMerge(
    Layer.mergeAll(StepUps.layer.pipe(Layer.provide(TessayaPhoneInbox.layer)), Consent.layer),
  ),
  // Every brain call's usage row, for the Usage page and her usage report; her wake-word models, signed here (P3b).
  Layer.provideMerge(
    Layer.mergeAll(
      BrainUsage.layer,
      // It hears each member's training switch from their preferences (the same memoised layer as above).
      TessayaWake.layer.pipe(Layer.provide(MemberPreferences.layer)),
    ),
  ),
  // The desktop's hands: a remote session's calls and a brain turn's, one broker.
  Layer.provideMerge(VesselHands.layer),
  // The Record under everything above, so any service can write to it.
  Layer.provideMerge(TessayaRecordService.layer),
  Layer.provideMerge(
    Layer.mergeAll(loopLayer, updatesLayer, pairingLayer, reachLayer, syncLayer, hubLayer),
  ),
  // Baton's tables live in baton.sqlite; this client never reaches upstream's layers.
  Layer.provide(TessayaDatabase.layer),
);

/** The services, plus `TessayaRuntime` so the `fabric.*` routes find them (TessayaRpcHandlers). */
// First, so the services below read TESSAYA_* names (BATON_* still works).
const adoptEnv = Layer.effectDiscard(Effect.sync(() => void adoptTessayaEnv(process.env)));

export const services = TessayaRpcHandlers.runtimeLayer.pipe(
  Layer.provideMerge(servicesInner),
  Layer.provide(adoptEnv),
);

/** The usage ledger for T3's Usage page; the same layer as the services' (layers memoize by reference). */
export const usageLedger = BrainUsage.layer;

export const workers = Layer.effectDiscard(
  Effect.gen(function* () {
    // The synopsis first: a rule that fires should see a synopsis the same events already moved.
    yield* (yield* SynopsisReactor.TessayaSynopsisReactor).start();
    yield* (yield* OrchestrationReactor.TessayaOrchestrationReactor).start();
    yield* (yield* TessayaJobReactor.TessayaJobReactor).start();
    yield* (yield* TessayaMemoryReactor.TessayaMemoryReactor).start();
  }),
).pipe(
  Layer.provideMerge(TessayaJobReactor.layer),
  Layer.provideMerge(TessayaMemoryReactor.layer),
  Layer.provideMerge(AccountRotationReactor.layer),
  // Every live Claude Code session as a T3 thread, for T3's official apps (D83).
  Layer.provideMerge(LiveSessionMirror.layer),
  // A session that died mid-turn is resumed by itself, within the guardrails in AutoResume.ts.
  Layer.provideMerge(SessionWatchdog.layer),
  // What waits to be typed into a live session goes on the server's own clock (item 5).
  Layer.provideMerge(TessayaWeaveService.drainer),
);

/** The phone page at /tessaya and its API, and the R1 desk device's chat endpoint and camera upload. */
export const routes = Layer.mergeAll(
  TessayaRoutes.routes,
  TessayaWakeRoutes.routes,
  TessayaAnnounceRoutes.routes,
  TessayaPackRoutes.routes,
  R1Device.routes,
  HomeDeviceRoutes.routes,
);
