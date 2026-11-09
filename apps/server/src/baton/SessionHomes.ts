// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
/**
 * Tessaya threads in a terminal. A Tessaya (claudeAgent) thread's session can be resumed in a terminal (Open in
 * terminal, `tessaya resume <thread>`, or by hand). Whichever way, once the mirror sees that session running it puts
 * the thread on the live instance, so it keeps working as a Terminal thread, and puts it back on its own instance
 * when the terminal closes. The thread → session map is kept in a file (TessayaSessionsFile) for the CLI.
 */
import type { ClaudeLiveSession } from "@t3tools/baton-contracts";
import { BATON_LIVE_INSTANCE } from "./BatonLiveInstance.ts";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";

import type { BatonEngineShape } from "./BatonEngine.ts";
import { claudeHomeOf, pointAtSessionEvents } from "./MoveIntoTessaya.ts";
import {
  SESSIONS_FILE,
  handBackDue,
  readSessionsFile,
  writeSessionsFile,
  type SessionHome,
} from "./TessayaSessionsFile.ts";

const REFRESH_MS = 30_000;

export const makeSessionHomes = (input: {
  readonly engine: BatonEngineShape;
  readonly stateDir: string;
  readonly instances: Effect.Effect<
    Readonly<
      Record<
        string,
        {
          readonly config?: unknown;
          readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
        }
      >
    >
  >;
  readonly log: (record: Record<string, unknown>) => void;
  /** The live instance's driver and model, for a thread put on its terminal session. */
  readonly live: { readonly driver: string; readonly model: string };
}) => {
  const { engine } = input;
  const path = NodePath.join(input.stateDir, SESSIONS_FILE);
  const homes = new Map(readSessionsFile(path).map((home) => [home.threadId, home]));
  const seen = new Map<string, string>();
  const seenRunning = new Set<string>();
  const missing = new Map<string, number>();
  let refreshedAt = 0;

  const save = () => {
    try {
      writeSessionsFile(path, homes.values());
    } catch (cause) {
      input.log({ event: "sessions-file-failed", cause: String(cause).slice(0, 200) });
    }
  };

  const ofSession = (sessionId: string): SessionHome | null => {
    for (const home of homes.values()) if (home.sessionId === sessionId) return home;
    return null;
  };

  const point = Effect.fn("SessionHomes.point")(function* (
    home: SessionHome,
    target: { driver: string; instanceId: string; model: string },
  ) {
    const thread = yield* engine.appThread(ThreadId.make(home.threadId));
    if (thread === null) return false;
    yield* engine.writeEvents({
      events: pointAtSessionEvents({
        thread,
        ...target,
        sessionId: home.sessionId,
        now: yield* DateTime.now,
        stamp: Date.now(),
      }),
    });
    return true;
  });

  /** Every Tessaya thread with a Claude session, re-read for threads that changed since the last pass. */
  const refresh = Effect.gen(function* () {
    if (Date.now() - refreshedAt < REFRESH_MS) return;
    refreshedAt = Date.now();
    const instances = yield* input.instances;
    const shells = yield* engine.threadShells;
    const projects = yield* engine.projects;
    const open = new Set(shells.map((shell) => String(shell.id)));
    for (const id of homes.keys())
      if (!open.has(id) && !homes.get(id)!.inTerminal) homes.delete(id);
    for (const shell of shells) {
      const id = String(shell.id);
      const stamp = `${DateTime.toEpochMillis(shell.updatedAt)}:${shell.providerInstanceId}`;
      if (seen.get(id) === stamp || homes.get(id)?.inTerminal === true) continue;
      seen.set(id, stamp);
      const active = yield* engine.activeProviderThread(shell.id);
      const sessionId = active?.nativeThreadRef?.nativeId ?? null;
      const cwd =
        shell.worktreePath ?? projects.find((p) => p.id === shell.projectId)?.workspaceRoot ?? null;
      if (active?.driver !== "claudeAgent" || sessionId === null || cwd === null) {
        homes.delete(id);
        continue;
      }
      homes.set(id, {
        threadId: id,
        title: shell.title,
        sessionId,
        cwd,
        configDir: claudeHomeOf(instances[String(shell.providerInstanceId)]),
        instanceId: String(shell.providerInstanceId),
        model: shell.modelSelection.model,
        inTerminal: false,
        openedAt: 0,
      });
    }
    save();
  });

  /** Puts threads on their terminal sessions when those run, and back on Tessaya when they close. */
  const link = Effect.fn("SessionHomes.link")(function* (live: ReadonlyArray<ClaudeLiveSession>) {
    const now = Date.now();
    // Only existing keys are set while iterating, which a Map allows.
    for (const home of homes.values()) {
      const running = live.some((s) => s.sessionId === home.sessionId);
      if (running) {
        seenRunning.add(home.threadId);
        missing.delete(home.threadId);
        if (home.inTerminal) continue;
        const shell = yield* engine.threadShell(ThreadId.make(home.threadId));
        // A Tessaya turn still running: two writers; link once it ends rather than take its run away.
        if (shell === null || (shell.activeRunId !== null && shell.activeRunId !== undefined)) {
          input.log({ event: "terminal-while-tessaya-busy", thread: home.threadId });
          continue;
        }
        if (yield* point(home, { ...input.live, instanceId: BATON_LIVE_INSTANCE })) {
          homes.set(home.threadId, { ...home, inTerminal: true, openedAt: now });
          input.log({ event: "opened-in-terminal", thread: home.threadId });
          save();
        }
        continue;
      }
      if (!home.inTerminal) continue;
      if (seenRunning.has(home.threadId) && !missing.has(home.threadId))
        missing.set(home.threadId, now);
      const due = handBackDue({
        home,
        running,
        missingSince: missing.get(home.threadId) ?? null,
        seenRunning: seenRunning.has(home.threadId),
        nowMs: now,
      });
      if (!due) continue;
      const shell = yield* engine.threadShell(ThreadId.make(home.threadId));
      if (shell !== null && shell.activeRunId !== null && shell.activeRunId !== undefined) continue;
      if (
        shell === null ||
        (yield* point(home, {
          driver: "claudeAgent",
          instanceId: home.instanceId,
          model: home.model,
        }))
      ) {
        homes.set(home.threadId, { ...home, inTerminal: false, openedAt: 0 });
        seenRunning.delete(home.threadId);
        missing.delete(home.threadId);
        seen.delete(home.threadId);
        input.log({ event: "back-from-terminal", thread: home.threadId });
        save();
      }
    }
  });

  return { ofSession, refresh, link, path };
};
