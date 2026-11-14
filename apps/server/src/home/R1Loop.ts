// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalJsonInEffect:off globalDate:off
/**
 * The R1's room voice loop as this server's child process (R1-CONNECT-UNIVERSAL §1, L1), run against its own hub and
 * brain from `<T3 home>/r1-voice` once an R1 is on the hub; a release build installs it there itself (R1VoiceInstall).
 * A loop on another machine already hearing the R1s, or `TESSAYA_TESSEL_LOOP=off` (or the old `TESSAYA_R1_LOOP`), keeps this server out of it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ServerConfig from "../config.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { DEVICE_API, deviceSetting, HUB_PATH, R1Hub } from "./R1Hub.ts";
import { R1_VOICE_BUNDLE } from "./R1VoiceBundle.ts";
import {
  BUNDLE_MARK,
  BUNDLE_TAR,
  gb,
  install,
  missing,
  R1_VOICE_MODELS,
  type InstallProgress,
} from "./R1VoiceInstall.ts";
import { DEVICE } from "@t3tools/tessaya-shared/productNames";

/** What a room loop listens to: a bus client hearing it is a loop on another machine. */
const VOICE_TOPIC = "freya/r1/any/voice/up";
/** After the server starts, a loop elsewhere gets this long to reconnect before this server installs its own. */
const SETTLE_MS = 60_000;

export interface LoopPlan {
  readonly node: string;
  readonly main: string;
  readonly env: Readonly<Record<string, string>>;
  /** Files the server writes before it starts the loop (mode 600): the bus key and the R1's device key. */
  readonly secrets: ReadonlyArray<{ readonly path: string; readonly value: string }>;
}

/** `KEY=value` lines of the loop folder's own `env` (model paths, voice); comments and blanks skipped. */
export const parseEnvFile = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

/**
 * Whether to run the loop here and how: only with the loop installed, an R1 on this server's hub, and not turned off.
 * The hub, the bus login, the brain and the device key are this server's; the folder's own env adds the rest. Pure.
 */
export const loopPlan = (input: {
  readonly dir: string;
  readonly installed: boolean;
  readonly setting: string;
  readonly devices: ReadonlyArray<R1Device>;
  readonly port: number;
  readonly busKey: string;
  readonly folderEnv: Readonly<Record<string, string>>;
  /** Installed from a release bundle: its own recogniser, Pocket and voice, unless the folder's env says otherwise. */
  readonly bundled?: boolean;
}): LoopPlan | null => {
  if (input.setting === "off" || !input.installed) return null;
  const onHub = input.devices.filter((d) => d.deviceId !== null && d.mqttUrl === null);
  const first = onHub[0];
  if (first === undefined || input.busKey === "") return null;
  const secrets = NodePath.join(input.dir, "secrets");
  const base = `127.0.0.1:${input.port}`;
  return {
    node: NodePath.join(input.dir, "node", "bin", "node"),
    main: NodePath.join(input.dir, "app", "main.mjs"),
    env: {
      R1_MODELS: NodePath.join(input.dir, "models"),
      R1_STATE: NodePath.join(input.dir, "state"),
      ...(input.bundled === true
        ? {
            R1_RECOGNIZER_BIN: NodePath.join(input.dir, "bin", "tessaya-recognizer"),
            R1_POCKET_BIN: NodePath.join(input.dir, "models", "pocket", "pocket-tts"),
            R1_VOICE: "eve",
          }
        : {}),
      ...input.folderEnv,
      R1_MQTT_URL: `ws://${base}${HUB_PATH}`,
      R1_MQTT_USER: "tessaya-bus",
      R1_MQTT_PASS_FILE: NodePath.join(secrets, "hub-bus"),
      R1_BRAIN_URL: `http://${base}${DEVICE_API}/chat/completions`,
      R1_DEVICE_KEY_FILE: NodePath.join(secrets, "device-key"),
      // Every R1 on this hub speaks through this loop.
      R1_INHOUSE: onHub.map((d) => d.deviceId!).join(","),
    },
    secrets: [
      { path: NodePath.join(secrets, "hub-bus"), value: input.busKey },
      { path: NodePath.join(secrets, "device-key"), value: first.deviceKey },
    ],
  };
};

export type InstallState =
  | { readonly kind: "idle" }
  | { readonly kind: "fetching"; readonly progress: InstallProgress }
  | { readonly kind: "failed"; readonly why: string; readonly at: number };

/** The one line Settings → Hardware shows about the R1's voice on this server. Pure. */
export const voiceLine = (input: {
  readonly setting: string;
  readonly onHub: boolean;
  readonly available: boolean;
  readonly elsewhere: boolean;
  readonly install: InstallState;
  readonly planned: boolean;
  readonly running: boolean;
  readonly restarts: number;
}): string | null => {
  if (!input.onHub) return null;
  if (input.setting === "off")
    return `The ${DEVICE}'s voice is turned off on this server (TESSAYA_TESSEL_LOOP=off).`;
  if (input.elsewhere) return `The ${DEVICE}'s voice runs on another machine.`;
  if (input.install.kind === "fetching") {
    const { done, total } = input.install.progress;
    const pct = total === 0 ? 0 : Math.floor((done / total) * 100);
    return `Downloading the ${DEVICE}'s voice: ${pct}% (${gb(done)} of ${gb(total)}).`;
  }
  if (input.install.kind === "failed")
    return `The ${DEVICE}'s voice did not download: ${input.install.why}. Trying again in a minute.`;
  if (input.planned)
    return input.running
      ? `The ${DEVICE}'s voice runs on this server.`
      : input.restarts > 0
        ? `The ${DEVICE}'s voice stopped; restarting (${input.restarts} so far).`
        : `Starting the ${DEVICE}'s voice…`;
  return input.available
    ? `Getting the ${DEVICE}'s voice ready…`
    : `This server cannot run the ${DEVICE}'s voice itself yet: only Linux (x64) release builds include it.`;
};

export class R1Loop extends Context.Service<
  R1Loop,
  {
    /** Running, how often it restarted, and the line for Settings; null when no R1 is on this server's hub. */
    readonly status: Effect.Effect<{
      readonly running: boolean;
      readonly restarts: number;
      readonly line: string;
    } | null>;
  }
>()("t3/home/R1Loop") {}

export const layer = Layer.effect(
  R1Loop,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const home = yield* HomeAssistantService;
    const hub = yield* R1Hub;
    const setting = yield* deviceSetting("LOOP").pipe(Effect.orDie);
    const dir = NodePath.join(NodePath.dirname(config.dbPath), "r1-voice");
    let child: NodeChildProcess.ChildProcess | null = null;
    let planned: string | null = null;
    let restarts = 0;
    let backoff = 5_000;
    let nextStart = 0;
    let exited = false;
    const bornAt = yield* Clock.currentTimeMillis;
    let installState: InstallState = { kind: "idle" };
    let elsewhere = false;
    /** A loop elsewhere was seen since the server started: this server does not fetch one of its own. */
    let seenElsewhere = false;
    let onHub = false;
    const bundle =
      R1_VOICE_BUNDLE !== null &&
      R1_VOICE_BUNDLE.platform ===
        `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`
        ? R1_VOICE_BUNDLE
        : null;

    const stop = () => {
      child?.kill("SIGTERM");
      child = null;
    };
    const start = (plan: LoopPlan) => {
      NodeFS.mkdirSync(NodePath.join(dir, "secrets"), { recursive: true, mode: 0o700 });
      NodeFS.mkdirSync(NodePath.join(dir, "state"), { recursive: true });
      for (const s of plan.secrets) NodeFS.writeFileSync(s.path, s.value, { mode: 0o600 });
      const log = NodeFS.openSync(NodePath.join(dir, "state", "loop.log"), "a");
      const proc = NodeChildProcess.spawn(plan.node, [plan.main], {
        cwd: dir,
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...plan.env },
        stdio: ["ignore", log, log],
      });
      NodeFS.closeSync(log);
      child = proc;
      proc.on("exit", () => {
        if (child !== proc) return;
        child = null;
        exited = true;
      });
    };

    const tick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (exited) {
        // It stopped by itself: back off before the next start (5 s, doubling to a minute).
        exited = false;
        restarts += 1;
        nextStart = now + backoff;
        backoff = Math.min(backoff * 2, 60_000);
      }
      const busKey = yield* hub.busLogin.pipe(Effect.map((l) => l.key));
      const devices = yield* home.devices;
      onHub = devices.some((d) => d.deviceId !== null && d.mqttUrl === null);
      // Another machine's loop hears the R1s here (his own voice host): this server neither installs nor runs one.
      // Ours counts as one while it runs: a second is a loop elsewhere, and two would both answer.
      elsewhere = hub.busHears(VOICE_TOPIC) > (child === null ? 0 : 1);
      seenElsewhere ||= elsewhere;
      const bundleMark = NodeFS.existsSync(NodePath.join(dir, BUNDLE_MARK))
        ? NodeFS.readFileSync(NodePath.join(dir, BUNDLE_MARK), "utf8")
        : null;
      const byHand =
        bundleMark === null && NodeFS.existsSync(NodePath.join(dir, "app", "main.mjs"));
      const wanted =
        bundle !== null &&
        !byHand &&
        onHub &&
        setting !== "off" &&
        !seenElsewhere &&
        installState.kind !== "fetching" &&
        now - bornAt >= SETTLE_MS &&
        (installState.kind !== "failed" || now - installState.at >= 60_000);
      const todo = wanted
        ? yield* Effect.promise(() =>
            missing(dir, { ...bundle, file: BUNDLE_TAR }, R1_VOICE_MODELS),
          )
        : [];
      if (bundle !== null && todo.length > 0) {
        const progress = (p: InstallProgress) => {
          installState = { kind: "fetching", progress: p };
        };
        yield* Effect.promise(() =>
          install({ dir, bundle, onProgress: progress }).then(
            () => {
              installState = { kind: "idle" };
            },
            (error: unknown) => {
              installState = {
                kind: "failed",
                why: error instanceof Error ? error.message : String(error),
                at: Date.now(),
              };
            },
          ),
        ).pipe(Effect.forkDetach);
        installState = { kind: "fetching", progress: { done: 0, total: 0 } };
      }
      const installed =
        installState.kind !== "fetching" &&
        !elsewhere &&
        NodeFS.existsSync(NodePath.join(dir, "app", "main.mjs")) &&
        NodeFS.existsSync(NodePath.join(dir, "node", "bin", "node"));
      const folderEnv = installed
        ? parseEnvFile(
            yield* Effect.sync(() => {
              try {
                return NodeFS.readFileSync(NodePath.join(dir, "env"), "utf8");
              } catch {
                return "";
              }
            }),
          )
        : {};
      const plan = loopPlan({
        dir,
        installed,
        setting,
        devices,
        port: config.port,
        busKey,
        folderEnv,
        bundled: bundleMark !== null,
      });
      const key = plan === null ? null : JSON.stringify(plan);
      // A changed plan (a new R1, a new key) restarts it; none stops it.
      if (key !== planned) {
        stop();
        planned = key;
        backoff = 5_000;
        nextStart = 0;
      }
      if (plan !== null && child === null && now >= nextStart) start(plan);
    });

    yield* tick.pipe(
      Effect.ignoreCause({ log: true }),
      Effect.repeat(Schedule.spaced("10 seconds")),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => Effect.sync(stop));

    return R1Loop.of({
      status: Effect.sync(() => {
        const line = voiceLine({
          setting,
          onHub,
          available: bundle !== null,
          elsewhere,
          install: installState,
          planned: planned !== null,
          running: child !== null,
          restarts,
        });
        return line === null ? null : { running: child !== null, restarts, line };
      }),
    });
  }),
);
