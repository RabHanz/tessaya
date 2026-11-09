/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off
/**
 * Two actions on live sessions that need no account (D73, D74).
 *
 * attach: a file sent from any device lands in the session's own directory under
 * `.baton/inbox/`, excluded from git, and the caller sends its path. Claude Code
 * reads a path mentioned as `@path`; a shell can use it as is.
 *
 * adopt: a Claude session running in a plain terminal or VS Code is moved into
 * Herdr with the same conversation: it is asked to exit with SIGTERM (only when
 * Claude Code itself reports it idle), and `baton --resume <id>` reopens it in a
 * Herdr pane. The private peer socket Claude Code writes is never used.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BATON_ATTACH_MAX_BYTES,
  type BatonLiveAdoptInput,
  type BatonLiveAdoptResult,
  type BatonLiveAttachInput,
  type BatonLiveAttachResult,
  type BatonLiveSetModelInput,
  type BatonLiveSetModelResult,
} from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";
import { claudeProjectSlug } from "@t3tools/baton-shared/liveTranscript";
import { setLiveModel } from "@t3tools/baton-shared/liveModel";
import { herdrSend } from "./HerdrSend.ts";

import type { AdoptedSessionService } from "./AdoptedSessionService.ts";
import { readClaudeLiveSessions } from "./ClaudeLiveSessions.ts";

/** A file name that cannot leave the inbox or hide. */
export const safeInboxName = (fileName: string, stamp: string): string => {
  const base = NodePath.basename(fileName)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  return `${stamp}-${base.length === 0 ? "file" : base.slice(0, 120)}`;
};

/** Keeps `.baton/` out of git (and the diff panel) without touching the project's own ignore files. */
const ignoreBatonDir = (cwd: string): void => {
  const ignore = NodePath.join(cwd, ".baton", ".gitignore");
  if (!NodeFS.existsSync(ignore)) NodeFS.writeFileSync(ignore, "*\n");
};

export const liveAttach = (
  adopted: AdoptedSessionService["Service"],
  input: BatonLiveAttachInput,
): Effect.Effect<BatonLiveAttachResult> =>
  Effect.gen(function* () {
    let cwd: string | null = null;
    if (input.target.pane !== undefined) {
      const found = yield* adopted.discover;
      cwd = found.candidates.find((c) => c.location.pane === input.target.pane)?.cwd ?? null;
    } else if (input.target.sessionId !== undefined) {
      const live = yield* readClaudeLiveSessions({ account: null });
      cwd = live.find((s) => s.sessionId === input.target.sessionId)?.cwd ?? null;
    }
    if (cwd === null)
      return { saved: false, path: null, detail: "That session is not running here now." };
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.byteLength > BATON_ATTACH_MAX_BYTES) {
      return { saved: false, path: null, detail: "Files up to 8 MB." };
    }
    const dir = cwd;
    return yield* Effect.sync(() => {
      const inbox = NodePath.join(dir, ".baton", "inbox");
      NodeFS.mkdirSync(inbox, { recursive: true });
      ignoreBatonDir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = NodePath.join(inbox, safeInboxName(input.fileName, stamp));
      NodeFS.writeFileSync(path, bytes, { mode: 0o600 });
      return { saved: true, path, detail: `Saved ${bytes.byteLength} bytes.` };
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        saved: false,
        path: null,
        detail: `Not saved: ${String(cause)}`.slice(0, 300),
      }),
    ),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const BATON = NodePath.join(NodeOS.homedir(), ".local", "bin", "baton");

export const liveAdopt = (input: BatonLiveAdoptInput): Effect.Effect<BatonLiveAdoptResult> =>
  Effect.gen(function* () {
    const live = yield* readClaudeLiveSessions({ account: null });
    const session = live.find((s) => s.sessionId === input.sessionId);
    if (session === undefined)
      return { adopted: false, pane: null, detail: "That session is not running here now." };
    if (session.herdrPane !== null)
      return { adopted: true, pane: session.herdrPane, detail: "Already in Herdr." };
    if (session.status === "busy") {
      return {
        adopted: false,
        pane: null,
        detail: "It is working right now. Adopt it when it is idle.",
      };
    }
    return yield* Effect.promise(async () => {
      process.kill(session.pid, "SIGTERM");
      for (let i = 0; i < 40 && alive(session.pid); i += 1) await sleep(250);
      if (alive(session.pid))
        return { adopted: false, pane: null, detail: "It did not exit; left as it was." };
      const out = await new Promise<string>((resolve) =>
        NodeChildProcess.execFile(
          BATON,
          ["--resume", session.sessionId, session.cwd],
          {
            timeout: 30_000,
            env: { ...process.env, PATH: `${NodePath.dirname(BATON)}:${process.env.PATH ?? ""}` },
          },
          (_error, stdout, stderr) => resolve(`${stdout}${stderr}`),
        ),
      );
      const pane = /running in (\S+) pane (\S+)/.exec(out);
      return pane === null
        ? { adopted: false, pane: null, detail: `baton --resume said: ${out.trim().slice(0, 200)}` }
        : { adopted: true, pane: `${pane[1]}~${pane[2]}`, detail: `Now in Herdr ${pane[1]}.` };
    });
  });

/** Tell a live Claude session its model and effort, and report only what it confirmed (D-live-model). */
export const liveSetModel = (
  adopted: AdoptedSessionService["Service"],
  input: BatonLiveSetModelInput,
  claudeModels: ReadonlyArray<string>,
): Effect.Effect<BatonLiveSetModelResult> =>
  Effect.gen(function* () {
    const live = yield* readClaudeLiveSessions({ account: null });
    const found = live.find((s) => s.sessionId === input.sessionId) ?? null;
    const path =
      found === null
        ? null
        : NodePath.join(
            found.configDir ?? NodePath.join(NodeOS.homedir(), ".claude"),
            "projects",
            claudeProjectSlug(found.cwd),
            `${found.sessionId}.jsonl`,
          );
    const services = yield* Effect.context<never>();
    return yield* Effect.promise(() =>
      setLiveModel(
        {
          session: found,
          send: async (pane, text) =>
            (
              await Effect.runPromiseWith(services)(
                herdrSend(adopted, { pane, text, submit: true }),
              )
            ).delivered,
          mark: () => {
            try {
              return path === null ? null : NodeFS.statSync(path).size;
            } catch {
              // A fresh session has no transcript until its first line, which may be this command's.
              return path === null ? null : 0;
            }
          },
          since: (mark) => {
            try {
              return path === null ? "" : NodeFS.readFileSync(path).subarray(mark).toString("utf8");
            } catch {
              return "";
            }
          },
          wait: async (ms) => void (await sleep(ms)),
          claudeModels,
        },
        {
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
        },
      ),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        state: "not_confirmed" as const,
        detail: `Not changed: ${String(cause)}`.slice(0, 300),
        confirmed: [],
      }),
    ),
  );
