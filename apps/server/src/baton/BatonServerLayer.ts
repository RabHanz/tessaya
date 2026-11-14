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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodePath from "node:path";

import { setClaudeAccountInstances } from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { claudeAccountInstances } from "./ClaudeAccountInstances.ts";
import * as AccountPoolService from "./AccountPoolService.ts";
import * as BatonAccounts from "./BatonAccounts.ts";
import * as AccountRotationPolicy from "./AccountRotationPolicy.ts";
import * as BatonMemorySync from "./BatonMemorySync.ts";
import * as AccountRotationReactor from "./AccountRotationReactor.ts";
import * as AdoptedSessionService from "./AdoptedSessionService.ts";
import * as BatonDatabase from "./BatonDatabase.ts";
import * as BatonEngine from "./BatonEngine.ts";
import * as BatonJobReactor from "./BatonJobReactor.ts";
import * as BatonJobService from "./BatonJobService.ts";
import * as BatonRecordService from "./BatonRecordService.ts";
import * as BrainUsage from "./BrainUsage.ts";
import * as VesselHands from "./VesselHands.ts";
import * as BatonWeaveBoxes from "./BatonWeaveBoxes.ts";
import * as BatonCloudService from "./BatonCloudService.ts";
import * as HomeAssistantConnection from "../home/HomeAssistantConnection.ts";
import * as HomeAssistantService from "../home/HomeAssistantService.ts";
import * as R1Brain from "../home/R1Brain.ts";
import * as TessayaHousehold from "./TessayaHousehold.ts";
import * as TessayaComms from "./TessayaComms.ts";
import * as VoiceForgets from "./VoiceForgets.ts";
import * as MemberPreferences from "./MemberPreferences.ts";
import * as StepUps from "../home/StepUps.ts";
import * as TessayaTurn from "./TessayaTurn.ts";
import * as TurnPools from "./TurnPools.ts";
import * as R1Device from "../home/R1Device.ts";
import * as HomeDevices from "../home/HomeDevices.ts";
import * as R1Hub from "../home/R1Hub.ts";
import * as R1Pairing from "../home/R1Pairing.ts";
import * as R1Loop from "../home/R1Loop.ts";
import * as R1Reach from "../home/R1Reach.ts";
import * as R1Updates from "../home/R1Updates.ts";
import * as DeviceRegistry from "../home/DeviceRegistry.ts";
import * as VesselBodies from "../home/VesselBodies.ts";
import * as VoiceArbiter from "../home/VoiceArbiter.ts";
import * as DeviceTriggers from "../home/DeviceTriggers.ts";
import * as HomeDeviceRoutes from "../home/HomeDeviceRoutes.ts";
import * as BatonSessionCatalogService from "./BatonSessionCatalogService.ts";
import * as BatonSessionsAcross from "./BatonSessionsAcross.ts";
import * as BatonWeaveService from "./BatonWeaveService.ts";
import * as BatonCommitmentService from "./BatonCommitmentService.ts";
import * as BatonMemoryLearning from "./BatonMemoryLearning.ts";
import * as BatonMemoryReactor from "./BatonMemoryReactor.ts";
import * as BatonMemoryEmbedder from "./BatonMemoryEmbedder.ts";
import * as BatonMemoryService from "./BatonMemoryService.ts";
import * as BatonPrivateMemoryService from "./BatonPrivateMemoryService.ts";
import * as BatonVoiceLibrary from "./BatonVoiceLibrary.ts";
import { packFileTexts } from "./OperatingSystemPack.ts";
import * as BatonOneShot from "./BatonOneShot.ts";
import * as TessayaExpression from "./TessayaExpression.ts";
import * as BatonPhoneInbox from "./BatonPhoneInbox.ts";
import * as BatonDesktopSettings from "./BatonDesktopSettings.ts";
import * as BatonTessayaRoutes from "./BatonTessayaRoutes.ts";
import * as BatonRpcHandlers from "./BatonRpcHandlers.ts";
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
import * as WorkSessionService from "./WorkSessionService.ts";
import * as TessayaWake from "../tessaya/TessayaWake.ts";
import * as TessayaWakeRoutes from "../tessaya/TessayaWakeRoutes.ts";
import * as CurrentPersona from "../tessaya/CurrentPersona.ts";
import { adoptTessayaEnv } from "@t3tools/baton-shared/tessayaEnv";

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
const memoryLayer = BatonMemoryService.layer.pipe(
  // Recall by meaning, when this server has the model (MEM-13); keyword recall otherwise.
  Layer.provide(BatonMemoryEmbedder.layer),
  Layer.provide(
    Layer.effect(
      BatonMemoryService.MemoryPrivateTexts,
      Effect.map(
        ServerConfig.ServerConfig,
        (config) => () => packFileTexts(NodePath.dirname(config.dbPath)),
      ),
    ),
  ),
);

// One instance: the sessions list keeps its messages in this table, and two drainers would type a row twice.
const weaveLayer = BatonWeaveService.layer.pipe(
  Layer.provide(BatonWeaveBoxes.layer.pipe(Layer.provide(HerdrAdapter.layer))),
  Layer.provide(BatonWeaveService.storesLayer),
);

// Home Assistant: one connection per server, its cards on the phone inbox. One value, so the devices share it.
const homeLayer = HomeAssistantService.layer.pipe(
  Layer.provide(HomeAssistantConnection.layer),
  Layer.provide(BatonPhoneInbox.layer),
);

// Her lines for every vessel: written ahead on her voice route, picked without waiting on a model. One value, shared.
const expressionLayer = TessayaExpression.layer.pipe(
  Layer.provide(BatonOneShot.layer),
  Layer.provide(homeLayer),
);

// The R1's own MQTT hub: one instance, so the route, the devices and every publish share its subscribers.
const hubLayer = R1Hub.layer.pipe(Layer.provide(homeLayer));
// Where the R1 should connect (LAN, then T3 Connect when away is on), kept current on it.
const reachLayer = R1Reach.layer.pipe(Layer.provide(hubLayer), Layer.provide(homeLayer));
// Firmware for the R1s on the hub, served by this server and installed when they are idle.
const updatesLayer = R1Updates.layer.pipe(
  Layer.provide(expressionLayer),
  Layer.provide(reachLayer),
  Layer.provide(hubLayer),
  Layer.provide(homeLayer),
);
// The room voice loop as this server's child, where it is installed beside it (R1Loop.ts).
const loopLayer = R1Loop.layer.pipe(Layer.provide(hubLayer), Layer.provide(homeLayer));
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
  // Firmware installs he asks for go through the devices' approval and audit, then the one updater.
  Layer.provide(updatesLayer),
  Layer.provide(DeviceRegistry.layer),
  Layer.provide(homeLayer),
  // A button bound to a thread continues or stops it through the engine's own door.
  Layer.provide(
    Layer.effect(
      HomeDevices.HomeDeviceThreads,
      Effect.map(BatonEngine.BatonEngine, (engine) =>
        HomeDevices.HomeDeviceThreads.of({
          run: Effect.fn("HomeDevices.HomeDeviceThreads.run")(function* (threadId, what) {
            const input = { tag: "r1-key", threadId: ThreadId.make(threadId) };
            return what === "stop"
              ? yield* engine.interruptThread(input)
              : yield* engine.sendMessage({ ...input, text: "Continue." });
          }),
        }),
      ),
    ).pipe(Layer.provide(BatonEngine.layer)),
  ),
  Layer.provide(BatonPhoneInbox.layer),
);

const servicesInner = IntentService.layer.pipe(
  // The intent surface consumes the reactor, the rule service and the same narrow effects a
  // rule uses, rather than reaching the engine on its own: one sentence and one rule cause work
  // through the same door.
  Layer.provideMerge(IntentExecutor.layer),
  Layer.provideMerge(SynopsisReactor.layer),
  Layer.provideMerge(OrchestrationReactor.layer),
  Layer.provideMerge(OrchestrationEffects.layer),
  Layer.provideMerge(OrchestrationRuleService.layer),
  // One turn pipeline for every vessel; it reads the memory, learning and private stores provided below it.
  Layer.provideMerge(TessayaTurn.layer),
  // Shared slots for the brain and the learning loop, across every vessel (§2.0a).
  Layer.provideMerge(TurnPools.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      // One work-session service for the whole server, so a mutation arriving on one client's
      // socket reaches every other client's subscription.
      WorkSessionService.layer,
      BatonJobService.layer.pipe(Layer.provide(WorkSessionService.layer)),
      memoryLayer,
      BatonCommitmentService.layer,
      BatonPhoneInbox.layer,
      BatonDesktopSettings.layer,
      BatonCloudService.layer,
      homeLayer,
      // The R1 and later devices: the broker comes from the R1's record in Home; camera and reboot asks go to the phone.
      // One owner of every device's manifest and values: the R1 through the broker, desktops and phones as clients.
      DeviceRegistry.layer,
      // One responder per utterance across every vessel that heard him (R1-P7).
      // The house tells it whether this server has the desk device; the registry, which vessels are online.
      VoiceArbiter.layer.pipe(Layer.provide(homeLayer), Layer.provide(DeviceRegistry.layer)),
      // Rules on device state, fired on each registry change; their actions go through the devices and the house.
      DeviceTriggers.layer.pipe(
        Layer.provide(homeDevicesLayer),
        Layer.provide(DeviceRegistry.layer),
        Layer.provide(homeLayer),
        Layer.provide(BatonOneShot.layer),
      ),
      homeDevicesLayer,
      vesselBodiesLayer,
      // The engine is provided here: a sibling in this mergeAll is not visible to it, and without it a new session
      // on a machine with no Herdr found no way to start a thread.
      BatonSessionCatalogService.layer.pipe(
        Layer.provide(AdoptedSessionService.layer.pipe(Layer.provide(HerdrAdapter.layer))),
        Layer.provide(BatonEngine.layer),
        Layer.provide(weaveLayer),
        Layer.provide(BatonAccounts.layer.pipe(Layer.provide(AccountPoolService.layer))),
      ),
      weaveLayer,
      // This server's live sessions and each linked environment's, for the desktop with T3's window closed (GEN-6).
      BatonSessionsAcross.layer.pipe(
        Layer.provide(AdoptedSessionService.layer.pipe(Layer.provide(HerdrAdapter.layer))),
        Layer.provide(BatonEngine.layer),
        Layer.provide(WorkSessionService.layer),
      ),
      BatonMemoryLearning.layer.pipe(Layer.provide(memoryLayer), Layer.provide(BatonOneShot.layer)),
      // Memory sync with his other servers on this server's own clock, not T3's window (GEN-6).
      BatonMemorySync.layer.pipe(Layer.provide(memoryLayer)),
      readClaudeAccountInstances,
      AccountPoolService.layer,
      BatonAccounts.layer.pipe(Layer.provide(AccountPoolService.layer)),
      AccountRotationPolicy.layer,
      ThreadAccountMoves.layer.pipe(
        Layer.provide(BatonEngine.layer),
        Layer.provide(AccountPoolService.layer),
        Layer.provide(AdoptedSessionService.layer.pipe(Layer.provide(HerdrAdapter.layer))),
      ),
      // The adapter is provided here so the one place that talks to another program stays
      // visible, and a machine without Herdr still gets a service that refuses by name.
      AdoptedSessionService.layer.pipe(Layer.provide(HerdrAdapter.layer)),
      BatonEngine.layer,
      BatonOneShot.layer,
      // The R1's warm brain; it starts a Claude process only once an R1 is set up and asks.
      R1Brain.layer(R1Device.R1_STREAM_SYSTEM),
    ),
  ),
  // Beside the mergeAll above, not in it: one more member there loses its types.
  // The household's members, over the private stores it shreds; asks for the owner's yes go through the phone inbox.
  // A private store is only a member's: the store service asks the household, from its home server.
  Layer.provideMerge(
    Layer.effect(
      BatonPrivateMemoryService.StoreMembership,
      Effect.map(TessayaHousehold.TessayaHousehold, (household) =>
        BatonPrivateMemoryService.StoreMembership.of({
          isMember: Effect.fn("StoreMembership.isMember")((personId: string) =>
            Effect.map(household.grantsOf(personId), (grants) => grants !== null),
          ),
        }),
      ),
    ),
  ),
  // Comms (notes, calls, consent) over the household it reads who is who from; one step, as the pipe holds 20.
  Layer.provideMerge(
    TessayaComms.layer.pipe(
      Layer.provideMerge(TessayaHousehold.layer.pipe(Layer.provide(BatonPhoneInbox.layer))),
    ),
  ),
  Layer.provideMerge(BatonPrivateMemoryService.layer),
  Layer.provideMerge(BatonVoiceLibrary.layer),
  // Voices to forget, between the household and every vessel's owner: under both, so each sees it.
  Layer.provideMerge(VoiceForgets.layer),
  // Members' voice defaults and acts held for a step-up, between the turn and runner and every vessel's owner.
  // Her lines for every vessel, beside the members' preferences.
  // Who each person is talking to (P5), written by the turn and told to the room loops by the broker.
  Layer.provideMerge(
    Layer.mergeAll(MemberPreferences.layer, expressionLayer, CurrentPersona.layer),
  ),
  Layer.provideMerge(StepUps.layer.pipe(Layer.provide(BatonPhoneInbox.layer))),
  // Every brain call's usage row, for the Usage page and her usage report; her wake-word models, signed here (P3b).
  Layer.provideMerge(Layer.mergeAll(BrainUsage.layer, TessayaWake.layer)),
  // The desktop's hands: a remote session's calls and a brain turn's, one broker.
  Layer.provideMerge(VesselHands.layer),
  // The Record under everything above, so any service can write to it.
  Layer.provideMerge(BatonRecordService.layer),
  Layer.provideMerge(Layer.mergeAll(loopLayer, updatesLayer, pairingLayer, reachLayer, hubLayer)),
  // Baton's tables live in baton.sqlite; this client never reaches upstream's layers.
  Layer.provide(BatonDatabase.layer),
);

/** The services, plus `BatonRuntime` so the `fabric.*` routes find them (BatonRpcHandlers). */
// First, so the services below read TESSAYA_* names (BATON_* still works).
const adoptEnv = Layer.effectDiscard(Effect.sync(() => void adoptTessayaEnv(process.env)));

export const services = BatonRpcHandlers.runtimeLayer.pipe(
  Layer.provideMerge(servicesInner),
  Layer.provide(adoptEnv),
);

export const workers = Layer.effectDiscard(
  Effect.gen(function* () {
    // The synopsis first: a rule that fires should see a synopsis the same events already moved.
    yield* (yield* SynopsisReactor.BatonSynopsisReactor).start();
    yield* (yield* OrchestrationReactor.BatonOrchestrationReactor).start();
    yield* (yield* BatonJobReactor.BatonJobReactor).start();
    yield* (yield* BatonMemoryReactor.BatonMemoryReactor).start();
  }),
).pipe(
  Layer.provideMerge(BatonJobReactor.layer),
  Layer.provideMerge(BatonMemoryReactor.layer),
  Layer.provideMerge(AccountRotationReactor.layer),
  // Every live Claude Code session as a T3 thread, for T3's official apps (D83).
  Layer.provideMerge(LiveSessionMirror.layer),
  // A session that died mid-turn is resumed by itself, within the guardrails in AutoResume.ts.
  Layer.provideMerge(SessionWatchdog.layer),
  // What waits to be typed into a live session goes on the server's own clock (item 5).
  Layer.provideMerge(BatonWeaveService.drainer),
);

/** The phone page at /tessaya and its API, and the R1 desk device's chat endpoint and camera upload. */
export const routes = Layer.mergeAll(
  BatonTessayaRoutes.routes,
  TessayaWakeRoutes.routes,
  R1Device.routes,
  HomeDeviceRoutes.routes,
);
