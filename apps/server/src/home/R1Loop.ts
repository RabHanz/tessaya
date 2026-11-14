// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalJsonInEffect:off
/**
 * The R1's room voice loop as this server's own child process (R1-CONNECT-UNIVERSAL §1, L1), so a user installs one
 * thing: when the loop is installed under `<T3 home>/r1-voice` (its Node, the app bundle and the models) and an R1 is
 * on this server's hub, the server runs it against its own hub and brain, and restarts it if it stops. A loop run
 * elsewhere (a separate voice host) is untouched: set `TESSAYA_R1_LOOP=off` there, or install none here.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ServerConfig from "../config.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { R1_HUB_PATH, R1Hub } from "./R1Hub.ts";

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
      ...input.folderEnv,
      R1_MQTT_URL: `ws://${base}${R1_HUB_PATH}`,
      R1_MQTT_USER: "tessaya-bus",
      R1_MQTT_PASS_FILE: NodePath.join(secrets, "hub-bus"),
      R1_BRAIN_URL: `http://${base}/api/devices/r1/v1/chat/completions`,
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

export class R1Loop extends Context.Service<
  R1Loop,
  {
    /** Running, and since when; null when this server runs no loop. */
    readonly status: Effect.Effect<{ readonly running: boolean; readonly restarts: number } | null>;
  }
>()("t3/home/R1Loop") {}

export const layer = Layer.effect(
  R1Loop,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const home = yield* HomeAssistantService;
    const hub = yield* R1Hub;
    const setting = yield* Config.String("TESSAYA_R1_LOOP").pipe(
      Config.withDefault(""),
      Effect.orDie,
    );
    const dir = NodePath.join(NodePath.dirname(config.dbPath), "r1-voice");
    let child: NodeChildProcess.ChildProcess | null = null;
    let planned: string | null = null;
    let restarts = 0;
    let backoff = 5_000;
    let nextStart = 0;
    let exited = false;

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
      const installed =
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
        devices: yield* home.devices,
        port: config.port,
        busKey,
        folderEnv,
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
      status: Effect.sync(() => (planned === null ? null : { running: child !== null, restarts })),
    });
  }),
);
