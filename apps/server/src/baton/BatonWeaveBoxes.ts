// @effect-diagnostics nodeBuiltinImport:off
/**
 * Where a weave on this machine may reach (D149): its Herdr panes, and live sessions outside Herdr. Another machine is
 * reached through its own server over the link, never from here.
 */
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ClaudeLiveSession } from "@t3tools/baton-contracts";

import { AdoptedRuntimeAdapter } from "./AdoptedSessionService.ts";
import { readAllProfileLiveSessions } from "./ClaudeLiveSessions.ts";
import { appendLiveQueue, liveQueueDir } from "./BatonLiveQueue.ts";
import {
  cliLayer,
  HerdrCli,
  parseHerdrSessionList,
  SESSION_SEPARATOR,
} from "./HerdrAdapterLive.ts";

export interface WeaveBox {
  readonly name: string;
  readonly adapter: AdoptedRuntimeAdapter["Service"];
  /** Puts a line into the named sender's own thread, when the sender is a session of this box. */
  readonly notify?: (from: string, line: string) => Effect.Effect<void>;
  /**
   * Every Claude session in a Herdr pane now, by session id: one listing per pass serves every target, and a Herdr
   * restart that renumbers panes still finds each session.
   */
  readonly agents?: Effect.Effect<ReadonlyMap<string, SessionPane>>;
}

export interface SessionPane {
  readonly pane: string;
  /** Herdr's word for the agent: idle, working, blocked (a question or approval is up), done, unknown. */
  readonly status: string;
}

/** The Claude sessions in `herdr agent list`, by session id. */
export const agentsOf = (json: string): ReadonlyMap<string, SessionPane> => {
  const found = new Map<string, SessionPane>();
  try {
    const agents: unknown = (JSON.parse(json) as { result?: { agents?: unknown } })?.result?.agents;
    if (!Array.isArray(agents)) return found;
    for (const a of agents as Array<{
      agent_session?: { value?: unknown };
      pane_id?: unknown;
      agent_status?: unknown;
    }>) {
      const id = a?.agent_session?.value;
      if (typeof id !== "string" || typeof a.pane_id !== "string") continue;
      found.set(id, {
        pane: a.pane_id,
        status: typeof a.agent_status === "string" ? a.agent_status : "unknown",
      });
    }
  } catch {}
  return found;
};

/**
 * Herdr's state, made "blocked" where Claude Code itself says a dialog waits: Herdr does not know every dialog (a held
 * cross-session message), and text typed into one picks its default.
 */
export const withClaudeWaiting = (
  agents: ReadonlyMap<string, SessionPane>,
  sessions: ReadonlyArray<Pick<ClaudeLiveSession, "sessionId" | "status">>,
): ReadonlyMap<string, SessionPane> => {
  const waiting = new Set(sessions.filter((s) => s.status === "waiting").map((s) => s.sessionId));
  return new Map(
    [...agents].map(([id, at]) => [id, waiting.has(id) ? { ...at, status: "blocked" } : at]),
  );
};

/** Every running Herdr session is asked, as discovery does; the pane comes back as `<session>~<pane>` off default. */
export const agentsWith = Effect.fn("BatonWeaveBoxes.agents")(function* (cli: HerdrCli["Service"]) {
  const listed = yield* cli.run(["session", "list"]);
  const names = listed.exitCode === 0 ? parseHerdrSessionList(listed.stdout) : [];
  const all = new Map<string, SessionPane>();
  for (const session of names.length === 0 ? ["default"] : names) {
    const named = session === "default" ? [] : ["--session", session];
    const out = yield* cli.run([...named, "agent", "list"]);
    if (out.exitCode !== 0) continue;
    for (const [id, found] of agentsOf(out.stdout))
      all.set(
        id,
        named.length === 0
          ? found
          : { ...found, pane: `${session}${SESSION_SEPARATOR}${found.pane}` },
      );
  }
  return all;
});

export class BatonWeaveBoxes extends Context.Service<BatonWeaveBoxes, ReadonlyArray<WeaveBox>>()(
  "t3/baton/BatonWeaveBoxes",
) {}

const liveName = (s: ClaudeLiveSession): string => s.name ?? NodePath.basename(s.cwd);

/**
 * Live threads outside Herdr: a Claude Code session in a plain terminal has no pane to type into yet. A weave to one
 * is stored addressed to the session, and the server types it once the session is in a Herdr pane.
 */
export const makeLiveBox = (
  read: Effect.Effect<ReadonlyArray<ClaudeLiveSession>>,
  dir: () => string = liveQueueDir,
): WeaveBox => ({
  name: "live",
  adapter: {
    discover: Effect.map(read, (sessions) => ({
      available: true,
      reason: "",
      candidates: sessions
        .filter((s) => s.herdrPane === null)
        .map((s) => ({
          runtime: "herdr" as const,
          label: liveName(s),
          location: { workspace: "live", pane: s.sessionId, host: null },
          agentKind: "claude",
          runtimeState: s.status === "busy" ? "working" : "idle",
          state: null,
        })),
    })),
  } as unknown as AdoptedRuntimeAdapter["Service"],
  notify: (from, line) =>
    Effect.flatMap(read, (sessions) =>
      Effect.sync(() => {
        const want = from.trim().toLowerCase();
        const me = sessions.find(
          (s) => liveName(s).toLowerCase() === want || s.sessionId.startsWith(from.trim()),
        );
        if (me !== undefined && want !== "") {
          appendLiveQueue(dir(), me.sessionId, { text: line, shown: line, kind: "note" });
        }
      }),
    ),
});

export const layer = Layer.effect(
  BatonWeaveBoxes,
  Effect.gen(function* () {
    const local = yield* AdoptedRuntimeAdapter;
    const cli = yield* HerdrCli;
    return [
      {
        name: "here",
        adapter: local,
        agents: Effect.suspend(() =>
          Effect.zipWith(agentsWith(cli), readAllProfileLiveSessions(), withClaudeWaiting),
        ),
      },
      makeLiveBox(readAllProfileLiveSessions()),
    ] as ReadonlyArray<WeaveBox>;
  }),
).pipe(Layer.provide(cliLayer));
