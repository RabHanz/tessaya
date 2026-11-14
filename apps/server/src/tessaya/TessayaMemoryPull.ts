// @effect-diagnostics nodeBuiltinImport:off
/**
 * Cross-venture learnings (D150): on a schedule he switches on, ask the history index for learnings and
 * propose them as memory, held for his yes. Each proposal is a short quote with its session id; no
 * transcript is copied and nothing is written to the index. Without the index it says so and does nothing.
 */
import * as NodeCrypto from "node:crypto";

import * as NodePath from "node:path";

import {
  askHistory,
  historyRunner,
  keepHistory,
  NOT_HERE,
  PEER_ASK_TIMEOUT_MS,
  parseLearnings,
  type HistoryAnswer,
} from "@t3tools/tessaya-shared/historyIndex";
import { redactSecretLines, sharesPrivateText } from "@t3tools/tessaya-shared/memory";
import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { TessayaMemoryService, MemoryViewer } from "./TessayaMemoryService.ts";
import { TessayaMemorySync } from "./TessayaMemorySync.ts";
import { packFileTexts, readPack } from "./OperatingSystemPack.ts";

export const PULL_FLAG = "learnings-pull";
/** What to ask the index for; the index's own tags decide what a venture is. */
const QUERIES = ["learned", "lesson", "what worked", "what failed"];

type Env = Readonly<Record<string, string | undefined>>;
type Runner = Parameters<typeof askHistory>[2];

export const NO_SERVER =
  "No server with the history index could be reached, so past work cannot be searched right now. The index lives on one of his servers; pair it with this one for memory sync, or try again when it is up.";

export const TOO_SLOW =
  "The history search did not answer in time, so past work could not be searched.";
/** Over this server's own 15 s script, under the desktop's 20 s wait for its own server. */
const DEADLINE = "18 seconds";
export const SESSION_OWN_VIEW =
  "A whole session's summary is read only in his own view on the desktop, since it may be a walled project's work. Search with words instead.";

/** "Kai Hair", "kai_hair" and "kai-hair" are one project. */
const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

/** What this server's own index may give this caller: no walled project's hits or private pack text unless it is his own view, and never a secret. */
const answerFromHere = Effect.fn("BatonMemoryPull.answerFromHere")(function* (
  text: string,
  admin: boolean,
) {
  if (admin) return redactSecretLines(text);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const userdata = Option.isNone(config) ? null : NodePath.dirname(config.value.dbPath);
  const walled = new Set(
    (userdata === null ? DEFAULT_OS_PACK : readPack(userdata)).walled.map(slug),
  );
  const privateTexts = userdata === null ? [] : packFileTexts(userdata);
  return redactSecretLines(
    keepHistory(
      text,
      (folder, hit) =>
        // By prefix, failing closed: a wall on "shop" also hides "shop-x", and covers its worktrees and lanes.
        (folder !== null &&
          [...walled].some((w) => slug(folder) === w || slug(folder).startsWith(`${w}-`))) ||
        sharesPrivateText(hit, privateTexts),
    ),
  );
});

const findHistory = Effect.fn("BatonMemoryPull.find")(function* (
  ask: { readonly query?: string; readonly session?: string; readonly admin?: boolean },
  env: Env,
  run: Runner | undefined,
) {
  const { admin, ...words } = ask;
  const viewer = yield* MemoryViewer;
  const own = admin === true && viewer === "desktop";
  // A summary carries no project to judge its wall by.
  if (words.session !== undefined && !own) return { ok: false, why: SESSION_OWN_VIEW } as const;
  const here = yield* Effect.promise(() =>
    askHistory(
      env,
      words,
      run ?? (viewer === "server" ? historyRunner(PEER_ASK_TIMEOUT_MS) : undefined),
    ),
  );
  if (here.ok)
    return { ok: true, text: yield* answerFromHere(here.text, own) } satisfies HistoryAnswer;
  // A peer's ask is answered from this server's own index only, so two servers never ask each other in a loop.
  if (here.why !== NOT_HERE || viewer === "server") return here;
  const there = yield* (yield* TessayaMemorySync).history(words);
  return Option.match(there, {
    onNone: (): HistoryAnswer => ({ ok: false, why: NO_SERVER }),
    onSome: (answer): HistoryAnswer =>
      answer.found ? { ok: true, text: answer.text } : { ok: false, why: answer.text },
  });
});

/** This server's own index (D5: one server holds it), else the first paired peer whose index finds it, within one deadline. */
export const searchHistory = Effect.fn("BatonMemoryPull.search")(function* (
  ask: { readonly query?: string; readonly session?: string; readonly admin?: boolean },
  env: Env = process.env,
  run?: Runner,
) {
  const answer = yield* findHistory(ask, env, run).pipe(Effect.timeoutOption(DEADLINE));
  return Option.getOrElse(answer, (): HistoryAnswer => ({ ok: false, why: TOO_SLOW }));
});

export const pullLearnings = Effect.fn("BatonMemoryPull.pull")(function* (
  env: Env = process.env,
  run?: Runner,
) {
  const memory = yield* TessayaMemoryService;
  let found = 0;
  let held = 0;
  let why: string | null = null;
  for (const query of QUERIES) {
    const answer = yield* searchHistory({ query }, env, run);
    if (!answer.ok) {
      why = answer.why;
      break;
    }
    for (const hit of parseLearnings(answer.text)) {
      const key = `pull:${hit.sessionId}:${NodeCrypto.createHash("sha1").update(hit.quote).digest("hex")}`;
      if (!(yield* memory.noteOnce(key, "1"))) continue;
      found++;
      const item = yield* memory
        .add({
          kind: "learning",
          text: `${hit.quote} (session ${hit.sessionId})`.slice(0, 500),
          source: "import",
          sourceRef: `session:${hit.sessionId}`,
          scope: hit.venture === null ? "global" : "project",
          scopeRef: hit.venture,
          // From the index, not from him: nothing becomes memory until he says yes.
          tainted: true,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (item?.proposed === true) held++;
    }
  }
  return { found, held, why };
});

export const pullAction = Effect.fn("BatonMemoryPull.action")(function* (
  action: "status" | "enable" | "disable" | "run",
) {
  const memory = yield* TessayaMemoryService;
  if (action === "enable" || action === "disable")
    yield* memory.setFlag(PULL_FLAG, action === "enable");
  const enabled = yield* memory.flag(PULL_FLAG);
  if (action !== "run") {
    return {
      enabled,
      found: 0,
      held: 0,
      message: enabled ? "Pulling learnings daily." : "Not pulling learnings.",
    };
  }
  const out = yield* pullLearnings();
  return {
    enabled,
    found: out.found,
    held: out.held,
    message: out.why ?? `Found ${out.found} new, ${out.held} waiting for your yes in Memory.`,
  };
});

/** The daily pass, when he has switched it on. */
export const pullIfEnabled = Effect.gen(function* () {
  const memory = yield* TessayaMemoryService;
  if (yield* memory.flag(PULL_FLAG)) yield* pullLearnings();
});
