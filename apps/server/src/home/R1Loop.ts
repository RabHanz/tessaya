// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalJsonInEffect:off globalDate:off
/**
 * The R1's room voice loop as this server's child process, run against its own hub and brain from `<T3 home>/r1-voice`
 * once an R1 is paired to the hub; a release build installs it there itself. It runs only while an R1 or a phone vessel is
 * on this hub and no other loop is heard here, so a standby costs nothing until she falls over to it and hands back when the
 * other loop returns (A9). `TESSAYA_TESSEL_LOOP=off` (or the old `TESSAYA_R1_LOOP`) keeps this server out of it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";

import * as ServerConfig from "../config.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { DEVICE_API, deviceSetting, R1Hub } from "./R1Hub.ts";
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
import { emitAction } from "../provenance/ActionLog.ts";
import { brainOn, makeBrainLink } from "../tessaya/BrainHost.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/** What a room loop listens to: a bus client hearing it is a loop on another machine. */
const VOICE_TOPIC = "freya/r1/any/voice/up";
/** After the server starts, a loop elsewhere gets this long to reconnect before this server installs its own. */
const SETTLE_MS = 60_000;
/** A loop that just went quiet gets this long to reconnect (a network blip) before the standby here answers. */
const TAKEOVER_MS = 3_000;
/** After this server starts, a loop elsewhere gets this long to reconnect (its retries reach 30 s) before this one answers. */
const STARTUP_MS = 30_000;
/** A loop that ran this long before stopping by itself starts again quickly; one that keeps dying waits longer each time. */
const HEALTHY_MS = 120_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** How often a standby asks her brain for its address and hub login. */
const BRAIN_HUB_MS = 10 * 60_000;
const decodeHubLogin = Schema.decodeUnknownOption(
  Schema.Struct({ user: Schema.String, key: Schema.String }),
);

/** A Tessel gone from this hub this long stops the loop here; a relink or a hub hop back within it keeps it warm. */
const LINGER_MS = 60_000;

/**
 * One tick of the election for this hub: its loop runs only while a Tessel is on this hub (or left it under LINGER_MS
 * ago), no other loop has been heard on the hub for TAKEOVER_MS, and the server has been up STARTUP_MS. Another loop
 * always wins, so two never answer at once. It claims the room only while that loop is up, subscribed here (`ready`),
 * and a Tessel is here to hear: a loop turned off or never started claims nothing. Pure.
 */
export const elect = (input: {
  readonly others: number;
  /** Tessels connected to this hub now. */
  readonly here: number;
  /** This server's own loop is running and subscribed to the Tessels' voice on this hub. */
  readonly ready: boolean;
  readonly lastOtherAt: number;
  readonly lastHereAt: number;
  readonly bornAt: number;
  readonly now: number;
}): {
  readonly answers: boolean;
  readonly claims: boolean;
  readonly lastOtherAt: number;
  readonly lastHereAt: number;
} => {
  const lastOtherAt = input.others > 0 ? input.now : input.lastOtherAt;
  const lastHereAt = input.here > 0 ? input.now : input.lastHereAt;
  const answers =
    input.others === 0 &&
    input.now - lastOtherAt >= TAKEOVER_MS &&
    input.now - input.bornAt >= STARTUP_MS &&
    lastHereAt > 0 &&
    input.now - lastHereAt < LINGER_MS;
  return {
    lastOtherAt,
    lastHereAt,
    answers,
    claims: answers && input.ready && input.here > 0,
  };
};

/** The devices this hub's loop would hear now: Tessels on this hub, and phone vessels exactly like them. Pure. */
export const devicesHere = (
  devices: ReadonlyArray<R1Device>,
  connected: (id: string) => boolean,
  vessels: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...devices
    .filter((d) => d.deviceId !== null && d.mqttUrl === null && connected(d.deviceId))
    .map((d) => d.deviceId!),
  ...vessels,
];

/**
 * The loops serving the Tessels on this hub: ours while it claims, else any other loop heard here while a Tessel is
 * here (a voice service run outside this server, such as a host's own systemd loop). Pure.
 */
export const servingLoops = (input: {
  readonly claims: boolean;
  readonly ours: string | null;
  readonly others: ReadonlyArray<string>;
  readonly here: number;
}): ReadonlyArray<string> =>
  input.claims && input.ours !== null
    ? [input.ours]
    : input.here > 0
      ? [...input.others].sort()
      : [];

/** The room.loop record a change of serving loops makes: a new loop takes the room, none hands it back. Pure. */
export const claimChange = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): "room.loop.takeover" | "room.loop.handback" | null =>
  after.join(",") === before.join(",")
    ? null
    : after.length > 0
      ? "room.loop.takeover"
      : "room.loop.handback";

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
  /**
   * Her brain on another server, and its hub's bus login: turns go there while the Tessels stay on this hub. Absent
   * (this server is the brain, or the brain gave no login): this server answers.
   */
  readonly brain?: { readonly url: string; readonly busKey: string } | null;
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
      R1_MQTT_USER: "tessaya-bus",
      R1_MQTT_PASS_FILE: NodePath.join(secrets, "hub-bus"),
      // 21 Nov: a standby on the laptop ran Tumble's turns on the laptop's own server; the brain's URL when it has one
      R1_BRAIN_URL: `${input.brain ? input.brain.url.replace(/\/+$/, "") : `http://${base}`}${DEVICE_API}/chat/completions`,
      ...(input.brain
        ? {
            R1_HUB_URL: `ws://${base}/api/tessel/mqtt`,
            R1_BRAIN_MQTT_USER: "tessaya-bus",
            R1_BRAIN_MQTT_PASS_FILE: NodePath.join(secrets, "brain-bus"),
          }
        : {}),
      R1_DEVICE_KEY_FILE: NodePath.join(secrets, "device-key"),
      // Every R1 on this hub speaks through this loop.
      R1_INHOUSE: onHub.map((d) => d.deviceId!).join(","),
    },
    secrets: [
      { path: NodePath.join(secrets, "hub-bus"), value: input.busKey },
      { path: NodePath.join(secrets, "device-key"), value: first.deviceKey },
      ...(input.brain ? [{ path: NodePath.join(secrets, "brain-bus"), value: input.brain.busKey }] : []),
    ],
  };
};

/** The fixed local ports the loop's own Pocket and recogniser listen on (room/main.ts defaults). */
export const loopPorts = (env: Readonly<Record<string, string>>): ReadonlyArray<number> => [
  Number(env["R1_POCKET_PORT"] ?? "58232"),
  Number(env["R1_RECOGNIZER_PORT"] ?? "58233"),
];

/** The socket inodes listening on `port` in a /proc/net/tcp or tcp6 table. Pure. */
export const listenInodes = (table: string, port: number): ReadonlyArray<string> =>
  table
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length > 9 && f[3] === "0A" && parseInt(f[1]!.split(":")[1]!, 16) === port)
    .map((f) => f[9]!);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const gone = async (pid: number, ms: number) => {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
};

/**
 * SIGTERM to `pid` (a negative pid is its whole process group), then SIGKILL if it is still there after `graceMs`;
 * resolves once it is gone (or after a further 2 s), so a new start never races it for the ports.
 */
export const terminate = async (pid: number, graceMs = 5_000): Promise<void> => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (await gone(pid, graceMs)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await gone(pid, 2_000);
};

/**
 * Stops whatever still listens on the loop's fixed ports, but only a process of the loop's own (its program or working
 * folder inside `dir`): a Pocket or recogniser orphaned by an older loop otherwise makes every new start die with
 * "bind: AddrInUse". Returns what it did, for the log. Linux only (reads /proc); elsewhere it finds nothing.
 */
export const clearStalePorts = async (
  dir: string,
  ports: ReadonlyArray<number>,
): Promise<ReadonlyArray<string>> => {
  const lines: Array<string> = [];
  const read = (path: string) => {
    try {
      return NodeFS.readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  const tables = read("/proc/net/tcp") + read("/proc/net/tcp6");
  const wanted = new Map<string, number>(
    ports.flatMap((port) =>
      listenInodes(tables, port).map((inode) => [`socket:[${inode}]`, port] as const),
    ),
  );
  if (wanted.size === 0) return lines;
  const root = NodeFS.realpathSync(dir) + NodePath.sep;
  const inside = (link: string) => {
    try {
      return (NodeFS.realpathSync(link) + NodePath.sep).startsWith(root);
    } catch {
      return false;
    }
  };
  const holds = (pid: number) => {
    try {
      return NodeFS.readdirSync(`/proc/${pid}/fd`)
        .map((fd) => {
          try {
            return wanted.get(NodeFS.readlinkSync(`/proc/${pid}/fd/${fd}`));
          } catch {
            return undefined;
          }
        })
        .find((port) => port !== undefined);
    } catch {
      return undefined; // another user's process, or gone
    }
  };
  for (const pid of NodeFS.readdirSync("/proc").map(Number).filter(Number.isInteger)) {
    const port = pid === process.pid ? undefined : holds(pid);
    if (port === undefined) continue;
    if (!inside(`/proc/${pid}/exe`) && !inside(`/proc/${pid}/cwd`)) {
      lines.push(`port ${port} is held by pid ${pid}, which is not the room loop's; leaving it`);
      continue;
    }
    lines.push(`stopping pid ${pid}, a leftover of an earlier room loop holding port ${port}`);
    await terminate(pid);
  }
  return lines;
};

export type InstallState =
  | { readonly kind: "idle" }
  | { readonly kind: "fetching"; readonly progress: InstallProgress }
  | { readonly kind: "failed"; readonly why: string; readonly at: number };

/** The one line Tessels shows about the R1's voice on this server. Pure. */
export const voiceLine = (input: {
  readonly setting: string;
  readonly onHub: boolean;
  readonly available: boolean;
  readonly elsewhere: boolean;
  /** Installed here, ready to take over. */
  readonly standby: boolean;
  readonly install: InstallState;
  readonly planned: boolean;
  readonly running: boolean;
  readonly restarts: number;
}): string | null => {
  if (!input.onHub) return null;
  if (input.setting === "off")
    return `The ${DEVICE}'s voice is turned off on this server (TESSAYA_TESSEL_LOOP=off).`;
  if (input.install.kind === "fetching") {
    const { done, total } = input.install.progress;
    const pct = total === 0 ? 0 : Math.floor((done / total) * 100);
    return `Downloading the ${DEVICE}'s voice: ${pct}% (${gb(done)} of ${gb(total)}).`;
  }
  if (input.install.kind === "failed")
    return `The ${DEVICE}'s voice did not download: ${input.install.why}. Trying again in a minute.`;
  if (input.elsewhere)
    return input.standby
      ? `The ${DEVICE}'s voice runs on another machine; this server stands by to take over.`
      : `The ${DEVICE}'s voice runs on another machine.`;
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
    /**
     * Whether a Tessel on this hub would be heard: a loop can run here (not turned off, and a bundle or an install
     * here) or one was heard on this hub. A hub that cannot is left out of her list (R1Reach), so she is never deaf.
     */
    readonly serves: Effect.Effect<boolean>;
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
    const brain = yield* makeBrainLink;
    const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    const self = Option.isSome(environment)
      ? String(yield* environment.value.getEnvironmentId)
      : "local";
    const home = yield* HomeAssistantService;
    const hub = yield* R1Hub;
    const peers = yield* Effect.serviceOption(PeerLinks.PeerLinks);
    /** The brain's address and hub login, asked at most every ten minutes; the last answer stands while it is away. */
    let brainHub: { readonly url: string; readonly busKey: string } | null = null;
    let brainHubAt = Number.NEGATIVE_INFINITY;
    const brainHubNow = Effect.fn("R1Loop.brainHub")(function* (now: number) {
      const label = yield* brainOn;
      if (label === null) return (brainHub = null);
      if (now - brainHubAt < BRAIN_HUB_MS) return brainHub;
      brainHubAt = now;
      const link =
        Option.isNone(peers)
          ? undefined
          : (yield* peers.value.list.pipe(Effect.orElseSucceed(() => []))).find(
              (l) => l.status !== "expired" && l.label === label,
            );
      const login = Option.flatMap(yield* brain.send("hubLogin", null), decodeHubLogin);
      if (link?.urls[0] !== undefined && Option.isSome(login) && login.value.key !== "")
        brainHub = { url: link.urls[0], busKey: login.value.key };
      return brainHub;
    });
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
    let lastOtherAt = bornAt;
    let lastHereAt = 0;
    let answering = false;
    let claimed: ReadonlyArray<string> = [];
    let standby = false;
    let onHub = false;
    let heardLoop = false;
    const bundle =
      R1_VOICE_BUNDLE !== null &&
      R1_VOICE_BUNDLE.platform ===
        `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`
        ? R1_VOICE_BUNDLE
        : null;

    let startedAt = 0;
    let lastExit = "";
    // The loop's process group once it exited by itself: its Pocket and recogniser may still be in it.
    let leftover: number | null = null;

    // The loop runs in its own process group, so stopping it also stops the Pocket and recogniser it started.
    const stop = async () => {
      const pid = child?.pid;
      child = null;
      if (pid !== undefined) await terminate(-pid);
    };
    const start = (plan: LoopPlan, now: number) => {
      NodeFS.mkdirSync(NodePath.join(dir, "secrets"), { recursive: true, mode: 0o700 });
      NodeFS.mkdirSync(NodePath.join(dir, "state"), { recursive: true });
      for (const s of plan.secrets) NodeFS.writeFileSync(s.path, s.value, { mode: 0o600 });
      const log = NodeFS.openSync(NodePath.join(dir, "state", "loop.log"), "a");
      const proc = NodeChildProcess.spawn(plan.node, [plan.main], {
        cwd: dir,
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...plan.env },
        stdio: ["ignore", log, log],
        detached: true,
      });
      NodeFS.closeSync(log);
      child = proc;
      startedAt = now;
      proc.on("exit", (code, signal) => {
        if (child !== proc) return;
        child = null;
        exited = true;
        leftover = proc.pid ?? null;
        lastExit = signal === null ? `code ${code}` : signal;
      });
    };

    const tick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (exited) {
        // It stopped by itself: back off before the next start (5 s, doubling to 10 minutes; a long run resets it).
        exited = false;
        restarts += 1;
        if (now - startedAt >= HEALTHY_MS) backoff = 5_000;
        nextStart = now + backoff;
        yield* Effect.logWarning(
          `room loop exited (${lastExit}) after ${Math.round((now - startedAt) / 1000)} s; restart ${restarts} in ${backoff / 1000} s (see r1-voice/state/loop.log)`,
        );
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        if (leftover !== null) yield* Effect.promise(() => terminate(-leftover!));
        leftover = null;
      }
      const busKey = yield* hub.busLogin.pipe(Effect.map((l) => l.key));
      const devices = yield* home.devices;
      onHub = devices.some((d) => d.deviceId !== null && d.mqttUrl === null);
      // Another loop hearing the R1s here (his own voice host) keeps ours silent; the hub drops one whose heartbeat stops.
      const ours = child?.pid === undefined ? null : `tessaya-room-${child.pid}`;
      const hearing = hub.busHears(VOICE_TOPIC);
      const others = hearing.filter((id) => id !== ours);
      if (others.length > 0) heardLoop = true;
      const here = devicesHere(devices, hub.connected, hub.vessels());
      const quietMs = now - lastOtherAt;
      const vote = elect({
        others: others.length,
        here: here.length,
        ready: ours !== null && hearing.includes(ours),
        lastOtherAt,
        lastHereAt,
        bornAt,
        now,
      });
      lastOtherAt = vote.lastOtherAt;
      lastHereAt = vote.lastHereAt;
      answering = vote.answers;
      // Another loop on this hub, or the Tessels on another server's hub: either way her voice runs elsewhere.
      elsewhere = others.length > 0 || (!answering && here.length === 0);
      // The room is claimed only by a loop that is up and hearing a Tessel here, ours or another; the record says which.
      const serving = servingLoops({ claims: vote.claims, ours, others, here: here.length });
      const change = claimChange(claimed, serving);
      if (change !== null) {
        claimed = serving;
        const outcome = change === "room.loop.takeover" ? "answering here" : "standing by";
        const data = { others, quietMs, devices: here, loop: serving[0] ?? ours };
        const id = yield* emitAction({
          kind: change,
          actor: { kind: "system", id: "room-loop", certainty: 1 },
          subject: "room-loop",
          outcome,
          data,
        });
        // The brain keeps one record of who serves each Tessel, whichever hub she is on.
        if (!(yield* brain.isBrain))
          yield* brain
            .send("roomLoop", { id, at: now, kind: change, from: self, outcome, data })
            .pipe(Effect.forkDetach);
      }
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
      standby =
        installState.kind !== "fetching" &&
        NodeFS.existsSync(NodePath.join(dir, "app", "main.mjs")) &&
        NodeFS.existsSync(NodePath.join(dir, "node", "bin", "node"));
      const installed = standby && answering;
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
        brain: installed ? yield* brainHubNow(now) : null,
      });
      const key = plan === null ? null : JSON.stringify(plan);
      // A changed plan (a new R1, a new key) restarts it; none stops it.
      if (key !== planned) {
        yield* Effect.promise(stop);
        planned = key;
        backoff = 5_000;
        nextStart = 0;
      }
      if (plan !== null && child === null && now >= nextStart) {
        const cleared = yield* Effect.promise(() => clearStalePorts(dir, loopPorts(plan.env)));
        for (const line of cleared) yield* Effect.logWarning(line);
        start(plan, now);
      }
    });

    yield* tick.pipe(
      Effect.ignoreCause({ log: true }),
      // Often enough that a handback stops ours within a couple of seconds of the other loop returning.
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => Effect.promise(stop));

    return R1Loop.of({
      serves: Effect.sync(
        () =>
          setting !== "off" &&
          (bundle !== null ||
            heardLoop ||
            NodeFS.existsSync(NodePath.join(dir, "app", "main.mjs"))),
      ),
      status: Effect.sync(() => {
        const line = voiceLine({
          setting,
          onHub,
          available: bundle !== null,
          elsewhere,
          standby,
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
