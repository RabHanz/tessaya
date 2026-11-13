// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalTimersInEffect:off preferSchemaOverJson:off globalFetch:off
/**
 * Everything Baton adds to the desktop main process, started by one call in `DesktopApp.ts`
 * (`vendor-patches/t3code/0007-desktop.patch`): the injection-report IPC handler and the voice
 * core (D66), and the screen companion (D84). Neither may stop the app starting: a missing tray
 * host or a refused microphone is reported in its own tray, not as a startup failure.
 */
import * as NodeOS from "node:os";
import * as Electron from "electron";

import { isCompanionWindow } from "./lastAppWindow.ts";
import { captureDraftImageDrops } from "./health/draftImageDropLog.ts";
import { rescueMainWindow } from "./mainWindowRescue.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { createOsTts } from "@t3tools/baton-voice";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { resolveDictationBinary } from "./voice/dictationSidecar.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { getBatonInjectionReport } from "../ipc/methods/baton.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import { createRemoteHandsLoop, type HubPost } from "./agent/remoteHandsLoop.ts";
import { readDeskTurn } from "./agent/deskTurnStream.ts";
import { conversationsIn } from "./conversation/conversationLog.ts";
import {
  beginStart,
  failedStartMessage,
  isBad,
  markHealthy,
} from "@t3tools/baton-shared/startGuard";
import {
  BATON_SESSIONS_WS_METHODS,
  type BatonHouseholdCallResult,
  tessayaPlaceOf,
} from "@t3tools/baton-contracts";
import { approvalRecord } from "@t3tools/baton-shared/approvals";
import { DEFAULT_POCKET_VOICE } from "@t3tools/baton-shared/voiceLibrary";
import { inFlightLine } from "@t3tools/baton-shared/turnsInFlight";
import { releasesUrl } from "@t3tools/baton-shared/repo";
import { adoptTessayaEnv } from "@t3tools/baton-shared/tessayaEnv";
import { readGuard, writeGuard } from "./health/startGuardFile.ts";
import { createLifecycleLog } from "./lifecycle/lifecycleLog.ts";
import { markPhase, startStallWatch } from "./lifecycle/mainStall.ts";
import { liftInheritedPriority } from "./lifecycle/processPriority.ts";
import { busyFileOf, busyFilePath, writeBusyFile } from "./lifecycle/busyFile.ts";
import { createBatonUpdater } from "./update/BatonUpdater.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { startScreenCompanion, type ScreenCompanion } from "./screen/ScreenCompanion.ts";
import { startDesktopBatonVoice, type DesktopBatonVoice } from "./voice/DesktopBatonVoice.ts";
import { createBridgeCatalogService } from "./sessions/catalogBridge.ts";
import { createCatalog } from "./sessions/catalogRows.ts";
import { createSessionsBridge } from "./sessions/sessionsBridge.ts";
import { createEscapeKey } from "./screen/escapeKey.ts";
import { createVoicePlayer } from "./voice/voicePlayer.ts";
import { createPocketEngine, type PocketVoice } from "./voice/pocketVoice.ts";
import { createSpeaker, type Synthesise, type VoiceChoice } from "./voice/voiceSpeaker.ts";
import { createDesktopVoiceCore, resolveVoiceAssets } from "./voice/desktopVoiceCore.ts";
import { makeVoiceTurnLog } from "./voice/voiceTurnLog.ts";
import { createOnnxHost, type OnnxReply } from "./voice/onnxHost.ts";
import { publishPaletteThemes } from "./home/palette.ts";
import { makeRotatingLogFileWriter } from "../app/DesktopObservability.ts";
import type { HouseholdCall } from "./memory/householdTab.ts";
import { createPrivateMemory } from "./memory/privateMemoryClient.ts";
import { runFreyaImport } from "./memory/freyaImport.ts";
import { isTessayaLink, placeInArgs, TESSAYA_SCHEME } from "./home/links.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";

/** The one line a voice speaks when he plays or picks it. */
const AUDITION_LINE = "Hello, this is how I sound.";
/** Long enough for T3's own window reveal to finish first. */
const SECOND_LAUNCH_RAISE_MS = 900;
const VOICE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const VOICE_LOG_MAX_FILES = 5;

/** After launch work has settled, so the sessions' start does not compete with it. */
const LAUNCH_WARM_MS = 5_000;
/** How often, while an update waits, this machine's server is asked whether a session is mid-turn. */
const IN_FLIGHT_MS = 5_000;
/** Long enough for this machine's server to be up; a plan that still finds it down waits for the next start. */
const FREYA_IMPORT_DELAY_MS = 30_000;

export const startBatonDesktop = Effect.gen(function* () {
  adoptTessayaEnv(process.env);
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(getBatonInjectionReport);
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostArchitecture = yield* HostProcess.Architecture;
  const context = yield* Effect.context<never>();
  const { resourcesPath } = environment;
  // Same rotation as the desktop's own traces, smaller: a line a turn is a lot of turns.
  const voiceLogFile = yield* makeRotatingLogFileWriter({
    filePath: NodePath.join(environment.logDir, "voice-turns.ndjson"),
    maxBytes: VOICE_LOG_MAX_BYTES,
    maxFiles: VOICE_LOG_MAX_FILES,
  }).pipe(Effect.option);
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const { latest: initialUpdateState, changes: updateChanges } = yield* updates.subscribe;
  yield* Effect.sync(() => {
    let voice: DesktopBatonVoice | null = null;
    let screen: ScreenCompanion | null = null;
    let catalogStore: ReturnType<typeof createCatalog> | null = null;
    const conversations = conversationsIn(environment.stateDir);
    const run = <A>(effect: Effect.Effect<A>) => Effect.runPromiseWith(context)(effect);
    // The release feed is this repository's (D137); the install waits for a quiet moment.
    const lifecycle = createLifecycleLog({
      file: NodePath.join(environment.logDir, "baton-lifecycle.ndjson"),
      runningFile: NodePath.join(environment.stateDir, "baton-running.json"),
      version: environment.appVersion,
    });
    // A hung main thread names itself: stalls and the startup phase in progress go to the lifecycle log.
    startStallWatch({
      file: NodePath.join(environment.logDir, "baton-lifecycle.ndjson"),
      version: environment.appVersion,
    });
    captureDraftImageDrops(
      Electron.app,
      Electron.webContents.getAllWebContents(),
      environment.logDir,
    );
    markPhase("start-guard:begin");
    // A version that fails to start twice is remembered, never installed again by itself, and he is told what worked.
    const guardPath = NodePath.join(environment.stateDir, "baton-start-guard.json");
    // Only a launch that owns the running marker counts: a second launch beside a live Tessaya must not reset the guard.
    const started = lifecycle.anotherInstance
      ? { file: readGuard(guardPath), failing: false, goBackTo: null }
      : beginStart(readGuard(guardPath), environment.appVersion, lifecycle.previousRunEndedBadly());
    let guard = started.file;
    if (!lifecycle.anotherInstance) {
      try {
        publishPaletteThemes(environment.stateDir);
      } catch {
        // The palettes are a nicety in the app window's theme list; a full disk never stops the start.
      }
      writeGuard(guardPath, guard);
      setTimeout(() => {
        guard = markHealthy(guard);
        writeGuard(guardPath, guard);
      }, 45_000).unref();
    }
    if (started.failing) {
      lifecycle.note("version-failed-twice", {
        version: environment.appVersion,
        goBackTo: started.goBackTo,
      });
      void Electron.app.whenReady().then(async () => {
        const answer = await Electron.dialog.showMessageBox({
          type: "warning",
          title: "Tessaya",
          message: failedStartMessage(environment.appVersion, started.goBackTo),
          buttons: ["Open the releases page", "Not now"],
          defaultId: 0,
          cancelId: 1,
        });
        if (answer.response === 0) void Electron.shell.openExternal(releasesUrl(process.env));
      });
    }
    markPhase("start-guard:end");
    if (environment.platform === "win32") {
      const inherited = liftInheritedPriority();
      if (inherited !== null) lifecycle.note("priority-lifted", { from: inherited });
    }
    Electron.app.on("render-process-gone", (_event, contents, details) =>
      lifecycle.note("render-process-gone", {
        reason: details.reason,
        exitCode: details.exitCode,
        window: contents.getTitle(),
      }),
    );
    Electron.app.on("child-process-gone", (_event, details) =>
      lifecycle.note("child-process-gone", {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: details.name ?? null,
      }),
    );
    Electron.app.on("before-quit", () => lifecycle.note("before-quit"));
    Electron.app.on("will-quit", () => lifecycle.note("will-quit"));
    Electron.app.on("window-all-closed", () => lifecycle.note("window-all-closed"));
    Electron.app.on("quit", (_event, exitCode) => lifecycle.note("quit", { exitCode }));
    markPhase("crash-dumps:begin");
    // Minidumps of a native crash go to a known folder (no upload); a dump left since the last run is named at start.
    try {
      Electron.crashReporter.start({ uploadToServer: false, compress: true });
      const dumps = Electron.app.getPath("crashDumps");
      const seenFile = NodePath.join(environment.stateDir, "baton-dumps-seen.json");
      const seen = new Set<string>(
        (() => {
          try {
            return JSON.parse(NodeFS.readFileSync(seenFile, "utf8")) as string[];
          } catch {
            return [];
          }
        })(),
      );
      const found = (() => {
        try {
          return NodeFS.readdirSync(dumps, { recursive: true })
            .map(String)
            .filter((name) => name.endsWith(".dmp") && !seen.has(name));
        } catch {
          return [];
        }
      })();
      lifecycle.note("crash-dumps", { folder: dumps, newDumps: found });
      // @effect-diagnostics-next-line globalJsonInEffect:off - an array of file names, inside a try.
      NodeFS.writeFileSync(seenFile, JSON.stringify([...seen, ...found]));
    } catch {
      // diagnostics only
    }
    markPhase("crash-dumps:end");
    Electron.powerMonitor.on("shutdown", () => lifecycle.note("os-shutdown"));
    Electron.powerMonitor.on("suspend", () => lifecycle.note("suspend"));
    Electron.powerMonitor.on("resume", () => lifecycle.note("resume"));
    // After an update install, tell him it worked; the marker says what ran.
    const pendingPath = NodePath.join(environment.stateDir, "baton-update-pending.json");
    const afterUpdate = (() => {
      try {
        const marker = JSON.parse(NodeFS.readFileSync(pendingPath, "utf8")) as {
          to?: string;
          at?: string;
        };
        NodeFS.rmSync(pendingPath, { force: true });
        if (marker.to === undefined) return null;
        lifecycle.note("restarted-after-update", { to: marker.to, startedAt: marker.at ?? null });
        return marker.to === environment.appVersion
          ? `Updated to ${marker.to}.`
          : `The update to ${marker.to} did not take: still on ${environment.appVersion}.`;
      } catch {
        return null;
      }
    })();
    const notify = (title: string, body: string, onClick?: () => void) => {
      if (!Electron.Notification.isSupported()) return;
      const toast = new Electron.Notification({ title, body, silent: true });
      if (onClick !== undefined) toast.on("click", onClick);
      toast.show();
    };
    /** A session turn running on this machine that a restart would cut off; set once the server is reachable. */
    let inFlight: string | null = null;
    let inFlightAnswered = false;
    let readInFlight = async (): Promise<void> => {};
    const busyNow = () => ({
      voiceBusy: voice?.busy() ?? false,
      assistantBusy: screen?.active() ?? false,
      inFlight,
    });
    // The release feed is this repository's (D137); the restart is announced, then waits for quiet.
    const batonUpdates = createBatonUpdater({
      skip: (version) => isBad(guard, version),
      initial: initialUpdateState,
      check: () => run(updates.check("baton-window")),
      download: () => run(updates.download),
      backAfter: afterUpdate,
      install: (version) => {
        lifecycle.willExitFor("update", `to ${version}`);
        try {
          NodeFS.writeFileSync(
            pendingPath,
            JSON.stringify({
              from: environment.appVersion,
              to: version,
              at: new Date().toISOString(),
            }),
          );
        } catch {
          // Without the marker the window just does not say it is back.
        }
        return run(updates.installPrepared(version)).then((result) => {
          if (result.accepted && !result.failed) return;
          // Still running: this exit is not an update, and the next start must not say it was.
          lifecycle.cancelExit();
          lifecycle.note("update-install-failed", { to: version });
          try {
            NodeFS.rmSync(pendingPath, { force: true });
          } catch {
            // The next start then says the update did not take, which is true.
          }
        });
      },
      busy: busyNow,
      headsUp: (version, restartAt) => {
        voice?.openHome();
        lifecycle.note("update-heads-up", {
          to: version,
          restartAt: new Date(restartAt).toISOString(),
        });
        notify(
          "Tessaya is updating",
          `Restarting in 30 seconds to install ${version}. Click to restart now, or choose Later in Tessaya.`,
          () => batonUpdates.install(),
        );
      },
      onChange: () => {
        if (batonUpdates.ready()) void readInFlight();
        voice?.refresh();
      },
    });
    if (afterUpdate !== null) {
      setTimeout(() => {
        voice?.openHome();
        notify("Tessaya is back", afterUpdate);
      }, 3_000).unref();
    }
    Effect.runForkWith(context)(
      Stream.runForEach(updateChanges, (state) => Effect.sync(() => batonUpdates.onState(state))),
    );
    const turnLog = makeVoiceTurnLog((line) => {
      if (voiceLogFile._tag === "Some") {
        Effect.runForkWith(context)(voiceLogFile.value.writeText(line));
      }
    });
    // Windows limits who may take the foreground, so this takes upstream's strong reveal.
    const openMainWindow = () =>
      void Effect.runPromiseWith(context)(
        desktopWindow.prepareCaptureReveal.pipe(
          Effect.andThen(desktopWindow.revealOrCreateMain),
          Effect.tap((window) =>
            Effect.sync(() => {
              rescueMainWindow(window, Electron.screen);
              turnLog.note("open_main", {
                // "baton" here means the reveal landed on Baton's own window and T3 did not open.
                target: isCompanionWindow(window) ? "baton" : "t3",
                visible: window.isVisible(),
                minimised: window.isMinimized(),
                bounds: window.getBounds(),
              });
            }),
          ),
        ),
      ).catch((cause: unknown) => turnLog.note("open_main_failed", { cause: String(cause) }));
    Electron.app.on("second-instance", openMainWindow);
    const holdEscape = createEscapeKey(Electron.globalShortcut);
    const pocket = createPocketEngine({
      root: NodePath.join(environment.stateDir, "voice", "pocket"),
      platform: environment.platform,
      arch: hostArchitecture,
      onProgress: (message) => voice?.onNote(message),
    });
    Electron.app.on("will-quit", pocket.dispose);
    const spokenThisTurn: string[] = [];
    /** The voice is taking dictation, and the wake word heard last. */
    let dictating = false;
    /** Undefined until a wake; null for a hotkey, which answers as the lead. */
    let lastWake: string | null | undefined;
    /** Tessaya's own voice, waited for while it loads. The OS voice only when he chose it. */
    const chooseVoice = (
      name: PocketVoice | "system",
      cloud: string | null = null,
    ): VoiceChoice => {
      if (name === "system") return { kind: "system" };
      const synth = pocket.synthesise(name);
      if (synth === null) return { kind: "wait", ready: pocket.ensure(name) };
      return cloud === null || Date.now() < cloudQuietUntil
        ? { kind: "synth", synth, voice: name }
        : { kind: "synth", synth: cloudSynth(cloud, synth), voice: cloud, engine: "gemini" };
    };
    /** After a cloud line fails (offline, no key), the persona's own voice speaks for five minutes before trying again. */
    let cloudQuietUntil = 0;
    const cloudSynth =
      (cloud: string, fallback: Synthesise): Synthesise =>
      (text) => {
        let cancelled = false;
        let inner: ReturnType<Synthesise> | null = null;
        const stream = (async function* () {
          const reply = (await direct("baton.voice.call", {
            kind: "act",
            op: "say",
            args: { voice: cloud, text },
          }).catch(() => null)) as { ok?: boolean; value?: { base64?: string } } | null;
          if (cancelled) return;
          if (reply?.ok === true && typeof reply.value?.base64 === "string") {
            yield Buffer.from(reply.value.base64, "base64");
            return;
          }
          cloudQuietUntil = Date.now() + 5 * 60_000;
          // Gemini's tags mean nothing to Pocket: said without them.
          inner = fallback(text.replace(/<[^<>]{1,30}>/g, " "));
          yield* inner.stream;
        })();
        return {
          stream,
          cancel: () => {
            cancelled = true;
            inner?.cancel();
          },
        };
      };
    const voicePlayer = createVoicePlayer(
      (level) => voice?.onSpeechLevel(level),
      () => screen?.volume() ?? 1,
      (pcm, rate, soundsAtMs) => voice?.onReference(pcm, rate, soundsAtMs),
    );
    const speaker = createSpeaker({
      os: createOsTts(environment.platform),
      voice: () =>
        chooseVoice(screen?.voice() ?? DEFAULT_POCKET_VOICE, screen?.cloudVoice() ?? null),
      player: voicePlayer,
      silent: () => screen?.writtenOnly() ?? false,
      onActive: (active) => voice?.onSpeaking(active),
      onText: (text) => voice?.onSpoken(text),
      respellings: () => voice?.respellings() ?? {},
      onPlaying: (text) => voice?.onPlaying(text),
      onWaiting: (waiting) => voice?.onNote(waiting ? "Loading the voice…" : null),
      onUnavailable: () =>
        voice?.onNote("The voice is not ready, so replies show as text. Voice tab: Voice."),
    });
    // Wake and speech models run in a utility process: onnxruntime-node blocks the thread it runs on.
    const onnx = createOnnxHost({
      fork: () => {
        const child = Electron.utilityProcess.fork(
          NodePath.join(__dirname, "baton", "voice", "onnxWorker.cjs"),
          [],
          { serviceName: "Tessaya voice models", stdio: ["ignore", "ignore", "pipe"] },
        );
        child.stderr?.on("data", (chunk: Buffer) =>
          lifecycle.note("voice-models-stderr", { text: chunk.toString("utf8").slice(0, 500) }),
        );
        return {
          postMessage: (request) => child.postMessage(request),
          onMessage: (listener) => child.on("message", (reply: OnnxReply) => listener(reply)),
          onExit: (listener) => child.once("exit", listener),
          kill: () => child.kill(),
        };
      },
      onCrash: (code, speak) => {
        lifecycle.note("voice-models-restarted", { exitCode: code });
        if (speak) {
          void speaker
            .speak("My hearing stopped for a moment. It is coming back now.")
            .catch(() => undefined);
        }
      },
    });
    Electron.app.on("will-quit", onnx.close);
    // Remote hands (docs/baton/REMOTE_HANDS.md): the app's own operations a remote session may ask for.
    const remoteOps = {
      version: () => environment.appVersion,
      logs: {
        "voice-turns": NodePath.join(environment.logDir, "voice-turns.ndjson"),
        lifecycle: NodePath.join(environment.logDir, "baton-lifecycle.ndjson"),
      },
      // Nothing in the app starts a process a remote session may stop yet, so the list is empty.
      processes: async () => [],
      stop: async () => undefined,
      update: async (version: string) => {
        await run(updates.check("remote-hands"));
        const state = await run(updates.getState);
        if (state.availableVersion !== version && state.downloadedVersion !== version) {
          return `The update feed offers ${state.availableVersion ?? "nothing"}, not ${version}. Nothing was changed.`;
        }
        // Through the countdown: he is warned before the app restarts under him.
        void run(updates.download).then(() => batonUpdates.soon());
        return `Downloading ${version}; the app warns for 30 seconds, then restarts at the first quiet moment.`;
      },
      pages: ["home"],
      openPage: async (page: string) => {
        voice?.openHome();
        return `Opened ${page}.`;
      },
    };
    // This machine's own server, with the desktop's local token, as the remote-hands loop calls it.
    const own = async (path: string, body: unknown, timeoutMs = 20_000): Promise<unknown> => {
      const token = await Effect.runPromiseWith(context)(localAuth.getBearerToken);
      const config = await run(Effect.flatMap(pool.primary, (primary) => primary.currentConfig));
      if (config._tag === "None") throw new Error("The local server is not ready.");
      const response = await fetch(new URL(path, config.value.httpBaseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await response.json().catch(() => ({}))) as {
        value?: unknown;
        message?: string;
      };
      if (!response.ok) throw new Error(json.message ?? "That could not be done. Nothing changed.");
      return json.value;
    };
    const direct = (method: string, body: unknown, timeoutMs?: number) =>
      own(`/tessaya/desk/${method}`, body, timeoutMs);
    // His sentence through the one brain on this machine's server (SPINE-UNIFY S4): her words as they stream.
    const deskTurn = async (
      body: unknown,
      onWords: (words: string) => void,
      signal: AbortSignal,
    ): Promise<void> => {
      const token = await Effect.runPromiseWith(context)(localAuth.getBearerToken);
      const config = await run(Effect.flatMap(pool.primary, (primary) => primary.currentConfig));
      if (config._tag === "None") throw new Error("The local server is not ready.");
      const response = await fetch(new URL("/tessaya/desk/turn", config.value.httpBaseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok || response.body === null)
        throw new Error(`The server brain did not answer (${response.status}).`);
      await readDeskTurn(response.body, onWords);
    };
    // His private stores live on this machine's own server: always asked here, never through T3's window.
    const privateMemory = createPrivateMemory((op, args = {}) =>
      own("/tessaya/private", { op, ...args }),
    );
    // The household lives on this machine's own server, like the stores it shreds.
    const household: HouseholdCall = (op, args = {}) =>
      own("/tessaya/household", { op, ...args }) as Promise<BatonHouseholdCallResult>;
    // The screen locked or the machine slept: this desktop's stores close, and so do sessions that read them.
    const lockPrivate = () => {
      void privateMemory.lockAll();
      screen?.forgetPrivate();
    };
    Electron.powerMonitor.on("lock-screen", lockPrivate);
    Electron.powerMonitor.on("suspend", lockPrivate);
    // A Freya import plan he dropped in comes in once this machine's server answers, then is deleted.
    setTimeout(
      () =>
        void runFreyaImport(environment.stateDir, {
          memory: (op, args) => direct(`baton.memory.${op}`, args),
          private: privateMemory.call,
        }).catch(() => undefined),
      FREYA_IMPORT_DELAY_MS,
    ).unref();
    // While an update waits, what a restart would cut off here (SESS-SURVIVE): it restarts only when nothing is mid-turn.
    readInFlight = async () => {
      try {
        const found = (await direct(BATON_SESSIONS_WS_METHODS.inFlight, {})) as {
          readonly threads?: unknown;
          readonly live?: unknown;
        };
        inFlight = inFlightLine({
          threads: Array.isArray(found?.threads) ? found.threads : [],
          live: Array.isArray(found?.live) ? found.live : [],
        });
        inFlightAnswered = true;
      } catch {
        // A server that does not answer has no turn of its own running to cut off.
        inFlight = null;
        inFlightAnswered = false;
      }
    };
    // Read always, not only while an update waits: an installer outside the app reads the busy file.
    const busyFile = busyFilePath(environment.logDir);
    setInterval(() => {
      void readInFlight().then(() =>
        writeBusyFile(
          busyFile,
          busyFileOf({
            busy: busyNow(),
            serverAnswered: inFlightAnswered,
            now: new Date(),
            pid: process.pid,
          }),
        ),
      );
    }, IN_FLIGHT_MS).unref();
    // His API spend alerts (BrainUsage writes each once, to the Record): a notice here when one is reached.
    // @effect-diagnostics-next-line globalDateInEffect:off - a timestamp for the Record's `since`, read by plain code
    let spendSeen = new Date().toISOString();
    setInterval(() => {
      void direct("baton.record.list", { kind: "brain_spend", since: spendSeen, limit: 5 })
        .then((value) => {
          const entries = (value as { entries?: ReadonlyArray<{ at: string; detail?: string }> })
            ?.entries;
          for (const entry of [...(entries ?? [])].toReversed()) {
            if (entry.at <= spendSeen) continue;
            spendSeen = entry.at;
            notify("API spend alert", entry.detail ?? "An API spend alert was reached.");
          }
        })
        .catch(() => undefined);
    }, 60_000).unref();
    // Each assistant turn goes to the Record on this machine's server, so "what happened?" has what she was asked and did.
    const noteTurn = (kind: string, fields: Readonly<Record<string, unknown>>) => {
      turnLog.note(kind, fields);
      if (kind !== "agent_turn") return;
      const text = (key: string) => (typeof fields[key] === "string" ? fields[key] : "");
      const tools = Array.isArray(fields["tools"]) ? fields["tools"].map(String) : [];
      const ok = fields["ok"] === true;
      void direct("baton.record.append", {
        kind: "assistant_turn",
        actor: (text("persona") || "Tessaya").slice(0, 60),
        ...(text("project") === "" ? {} : { project: text("project").slice(0, 200) }),
        subject: text("said").slice(0, 300),
        outcome: ok ? "answered" : "failed",
        // Voice ID: whose voice it was, when known ("owner", "saved:<id>", "guest", "unverified").
        detail:
          `${text("speaker") === "" ? "" : `[voice: ${text("speaker")}] `}${ok ? text("reply") : text("error")}${tools.length === 0 ? "" : ` (tools: ${[...new Set(tools)].join(", ")})`}`.slice(
            0,
            1000,
          ),
      }).catch(() => undefined);
      // Learning's trace: tools, argument names and times, never values, errors or his words.
      const calls = (Array.isArray(fields["toolResults"]) ? fields["toolResults"] : []).map(
        (r: { tool?: unknown; argKeys?: unknown; ok?: unknown; ms?: unknown }) => ({
          tool: String(r.tool),
          argKeys: Array.isArray(r.argKeys) ? r.argKeys.map(String) : [],
          ok: r.ok === true,
          ms: typeof r.ms === "number" ? r.ms : 0,
        }),
      );
      void direct("baton.record.append", {
        kind: "turn_trace",
        actor: (text("persona") || "Tessaya").slice(0, 60),
        ...(text("project") === "" ? {} : { project: text("project").slice(0, 200) }),
        subject: `${calls.length} calls, ${calls.filter((c) => !c.ok).length} failed, ${fields["totalMs"] ?? "?"} ms`,
        outcome: ok ? "answered" : "failed",
        // The last calls, so the line stays whole JSON under the Record's 1000 characters.
        detail: JSON.stringify({
          // First, so a cut line still names the turn the nightly learning pass looks for.
          turn: typeof fields["turn"] === "number" ? fields["turn"] : null,
          calls: calls.slice(-10),
          skills: fields["skills"] ?? [],
          stoppedBy: fields["stoppedBy"] ?? null,
          model: fields["model"] ?? null,
        }).slice(0, 1000),
      }).catch(() => undefined);
    };
    markPhase("screen-companion:begin");
    try {
      screen = startScreenCompanion({
        memberGrants: async (member) => {
          const listed = await household("list");
          const m = listed.members?.find((x) => x.id === member && x.state !== "leaving");
          return m === undefined ? null : { role: m.role, machine: m.machine };
        },
        remoteOps,
        catalog: () => catalogStore?.tools,
        stateDir: environment.stateDir,
        conversations,
        onNote: noteTurn,
        platform: environment.platform,
        env: hostEnvironment,
        direct,
        deskTurn,
        privateMemory,
        speak: (text) => {
          spokenThisTurn.push(text);
          return speaker.speak(text);
        },
        onChange: () => voice?.refresh(),
        onTurnEnd: () => voice?.onTurnEnd(),
        onTimings: (timings) => {
          turnLog.timings({ ...timings, reply: spokenThisTurn.join(" ") });
          spokenThisTurn.length = 0;
        },
        onAction: (entry) => {
          turnLog.note("action", entry);
          const answer = approvalRecord(entry);
          if (answer !== null) void direct("baton.record.append", answer).catch(() => undefined);
        },
        stopSpeech: speaker.cancel,
        holdEscape,
        ownEscape: holdEscape.own,
        onActivity: (label, caption) => voice?.onActivity(label, caption),
        onCue: (name) => voice?.cue(name),
        onDismissed: () => voice?.onDismissed(),
        onOpenTab: () => voice?.openHome(),
      });
    } catch (cause) {
      Effect.runForkWith(context)(
        Effect.logWarning("Tessaya screen companion did not start", cause),
      );
    }
    markPhase("screen-companion:end");
    if (screen !== null) {
      const companion = screen;
      const post: HubPost = async (path, body) => {
        const token = await Effect.runPromiseWith(context)(localAuth.getBearerToken);
        const primary = await run(pool.primary);
        const config = await run(primary.currentConfig);
        if (config._tag === "None") throw new Error("The local backend is not ready.");
        const response = await fetch(new URL(`/tessaya/hands/${path}`, config.value.httpBaseUrl), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(40_000),
        });
        return { status: response.status, json: await response.json().catch(() => ({})) };
      };
      const hands = createRemoteHandsLoop({
        post,
        enabled: () => companion.remoteHands.enabled(),
        offered: () => companion.remoteHands.offered(),
        run: (call) => companion.remoteHands.run(call),
      });
      hands.start();
      Electron.app.on("will-quit", hands.stop);
    }
    const t3Up = () =>
      run(electronWindow.main).then((main) => main._tag === "Some" && !main.value.isDestroyed());
    const sessions = createSessionsBridge({
      ensureMainWindow: () => Effect.runPromiseWith(context)(desktopWindow.ensureMain),
      openMainWindow,
      onChange: () => voice?.refresh(),
      direct,
      mainWindowUp: t3Up,
    });
    // A second launch means "show me Tessaya". T3's own handler raises its main window first and slowly, so
    // Tessaya's window is raised after it, or the T3 window ends up on top.
    Electron.app.on("second-instance", (_event, argv) => {
      const place = placeInArgs(argv) ?? undefined;
      setTimeout(() => voice?.openHome(place), SECOND_LAUNCH_RAISE_MS).unref();
    });
    // tessaya://settings/hardware opens that place: Windows hands it to a second launch, macOS to open-url.
    Electron.app.on("open-url", (event, url) => {
      if (!isTessayaLink(url)) return;
      event.preventDefault();
      voice?.openHome(tessayaPlaceOf(url) ?? undefined);
    });
    if (Electron.app.isPackaged) Electron.app.setAsDefaultProtocolClient(TESSAYA_SCHEME);
    const launchPlace = placeInArgs(process.argv);
    if (launchPlace !== null)
      setTimeout(() => voice?.openHome(launchPlace), SECOND_LAUNCH_RAISE_MS * 3).unref();
    // Every session on every connected environment, through the T3 sidebar.
    const catalog = (catalogStore = createCatalog({
      service: createBridgeCatalogService({
        bridge: sessions,
        openMainWindow,
        note: lifecycle.note,
        saveCleanupList: (json) =>
          NodeFS.writeFileSync(
            NodePath.join(environment.stateDir, `baton-cleanup-${Date.now()}.json`),
            json,
          ),
      }),
      onChange: () => voice?.refresh(),
    }));
    // With T3's window closed the catalog is this machine's server's, through its door; it never opens the window.
    const refreshCatalog = () => void catalog.refresh();
    setTimeout(refreshCatalog, 8_000).unref();
    setInterval(refreshCatalog, 45_000).unref();
    markPhase("voice-start:begin");
    voice = startDesktopBatonVoice({
      loginEntry: environment.appUserModelId,
      stateDir: environment.stateDir,
      conversation: conversations.current,
      onNote: turnLog.note,
      logDir: environment.logDir,
      appVersion: environment.appVersion,
      platform: environment.platform,
      env: hostEnvironment,
      ensureMainWindow: () => Effect.runPromiseWith(context)(desktopWindow.ensureMain),
      mainWindowUp: t3Up,
      direct,
      privateMemory,
      household,
      // His Anthropic key answers first when he saved one; a failure (its reason in the error) falls back to the
      // subscription session. The wait matches the server's 2.5 s limit, with a little for the hop.
      cleanupApi: async (system, message, maxTokens) => {
        const answer = (await direct(
          "baton.dictation.cleanupApi",
          { system, message, maxTokens },
          2_800,
        )) as { readonly configured?: boolean; readonly text?: unknown };
        return answer?.configured === true && typeof answer.text === "string" ? answer.text : null;
      },
      ...(screen === null ? {} : { extras: screen }),
      sessions,
      catalog,
      updates: batonUpdates,
      holdEscape,
      onPillState: (phase) =>
        turnLog.note(phase === "idle" ? "pill_hidden" : "pill_state", { phase }),
      onPillDrag: (outcome) => turnLog.note("pill_drag", outcome),
      onTestAudio: (event) => turnLog.note("test-audio", event),
      onBargeIn: () => {
        voicePlayer.duck?.(false);
        speaker.cancel();
        screen?.cutIn();
      },
      onDuck: (on) => voicePlayer.duck?.(on),
      onStop: (quiet) => {
        speaker.cancel();
        screen?.stop(quiet);
      },
      audition: (name) => {
        const picked = (name ?? screen?.voice() ?? DEFAULT_POCKET_VOICE) as PocketVoice | "system";
        if (picked === "system") {
          voice?.onNote("System voice has no sample. Pick one of Tessaya's voices to hear it.");
          return;
        }
        void speaker.sample(chooseVoice(picked), AUDITION_LINE);
      },
      warmAssistant: () => screen?.warmAssistant(),
      openMainWindow,
      embed: { url: getDesktopUrl(environment.isDevelopment), preload: environment.preloadPath },
      dictationBinary: resolveDictationBinary({
        resourcesPath,
        platform: environment.platform,
        env: hostEnvironment,
      }),
      voiceAssets: (modelsDir) =>
        resolveVoiceAssets({
          stateDir: environment.stateDir,
          resourcesPath,
          env: { BATON_VOICE_MODELS: hostEnvironment["BATON_VOICE_MODELS"] },
          modelsDir,
        }),
      speakerModel: (path, model) => onnx.speaker(path, model),
      makeCore: async ({
        intent,
        onReply,
        settings,
        stt,
        stopStt,
        onEvent,
        vocabulary,
        waitMs,
        listening,
        verifyWake,
        trustWake,
        recording,
        echo,
        speakerMode,
        speaker: voiceSpeaker,
      }) => {
        // The assistant's sessions start now, not at his first wake: a cold start took 27 s (0.1.68).
        setTimeout(() => screen?.warm(), LAUNCH_WARM_MS).unref();
        return (
          await createDesktopVoiceCore({
            assets: resolveVoiceAssets({
              stateDir: environment.stateDir,
              resourcesPath,
              env: { BATON_VOICE_MODELS: hostEnvironment["BATON_VOICE_MODELS"] },
              modelsDir: settings.modelsDir,
            }),
            wakeWords: settings.wakeWords,
            // One responder per utterance (R1-P7): her server's arbiter decides before a wake here opens a turn.
            claim: async () => {
              const reply = (await direct(
                "baton.voice.call",
                {
                  kind: "act",
                  op: "claim",
                  args: {
                    deviceId: `desktop-${NodeOS.hostname()}`.slice(0, 60),
                    wakeScore: 1,
                    loudnessDb: null,
                  },
                },
                1_500,
              ).catch(() => null)) as {
                ok?: boolean;
                value?: { answer?: unknown; until?: unknown };
              } | null;
              const v = reply?.ok === true ? reply.value : undefined;
              return typeof v?.answer === "boolean"
                ? { answer: v.answer, ...(typeof v.until === "number" ? { until: v.until } : {}) }
                : null;
            },
            stt,
            stopStt,
            platform: environment.platform,
            intent,
            onReply,
            tts: speaker,
            onEvent: (event) => {
              turnLog.event(event);
              // He is about to say something: have the sessions up before he finishes.
              if (event.type === "wake") {
                // Only the persona he named is warmed (P1), before he has finished speaking.
                screen?.warm(event.word);
                if (!dictating) lastWake = event.word;
              }
              if (event.type === "state") dictating = event.state === "dictation";
              // A turn (or the dictation it starts) answers as the persona named; a name mid-dictation changes nothing.
              if (event.type === "transcript" && !dictating && lastWake !== undefined)
                screen?.addressed(lastWake);
              onEvent(event);
            },
            vocabulary,
            waitMs,
            listening,
            verifyWake,
            trustWake,
            recording,
            ...(echo === undefined ? {} : { echo }),
            speakerMode,
            speaker: voiceSpeaker,
            scorers: onnx,
            ...(screen === null ? {} : { brain: screen }),
          })
        ).core;
      },
    });
    markPhase("voice-start:end");
  }).pipe(Effect.catchDefect((cause) => Effect.logWarning("Tessaya voice did not start", cause)));
});
