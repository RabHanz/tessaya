// @effect-diagnostics globalDate:off globalDateInEffect:off nodeBuiltinImport:off
/** The day's episode (D150): what he talked about and which jobs moved, as one short memory that decays like any episode. */
import * as NodePath from "node:path";

import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { BatonJobService } from "./BatonJobService.ts";
import type { MemoryItem } from "@t3tools/tessaya-shared/memory";

import { BatonMemoryService, MemoryViewer } from "./BatonMemoryService.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const DAY_MS = 86_400_000;

/** The day before `nowMs` (UTC), once: a restart or a second tick that day adds nothing. */
export const dailyEpisode = Effect.fn("BatonMemoryReactor.dailyEpisode")(function* (nowMs: number) {
  const memory = yield* BatonMemoryService;
  const day = dayOf(nowMs - DAY_MS);
  const done = `episode:${day}`;
  if (yield* memory.flag(done)) return null;
  const start = `${day}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + DAY_MS).toISOString();
  const said = yield* memory.talks(day);
  const jobs = (yield* (yield* BatonJobService).allTerms()).filter(
    (t) => t.updatedAt >= start && t.updatedAt < end,
  );
  // Each work session's own summary, so "what did my sessions do yesterday" has a line per session.
  const sessions = (yield* (yield* WorkSessionService)
    .list({ includeArchived: true })
    .pipe(Effect.orElseSucceed(() => []))).flatMap((s) =>
    s.synopsis?.currentAction != null && s.synopsis.updatedAt >= start
      ? [`${s.title.slice(0, 40)}: ${s.synopsis.currentAction.slice(0, 100)}`]
      : [],
  );
  if (said.length === 0 && jobs.length === 0 && sessions.length === 0) return null;
  const parts = [
    said.length === 0 ? null : `Talked about: ${said.slice(0, 6).join("; ")}.`,
    jobs.length === 0
      ? null
      : `Jobs: ${jobs
          .slice(0, 4)
          .map((j) => `${j.goal.slice(0, 50)} (${j.phase.replace("_", " ")})`)
          .join("; ")}.`,
    sessions.length === 0 ? null : `Sessions: ${sessions.slice(0, 6).join("; ")}.`,
  ].filter((x): x is string => x !== null);
  const episode = yield* memory
    .add({
      kind: "episode",
      text: `${day}. ${parts.join(" ")}`.slice(0, 500),
      source: "job",
      sourceRef: `day:${day}`,
    })
    .pipe(Effect.orElseSucceed(() => null));
  // Marked only once it is written, so a failed write is tried again on the next tick.
  if (episode !== null) yield* memory.setFlag(done, true);
  return episode;
});

const CONVERSATION_REF = /^conversation:([a-z0-9][a-z0-9-]{0,63}):/;

/**
 * Each persona's day before `nowMs` (CS7), once: how many conversations it had and what was said in the ones any
 * reader may recall. Only the count of a walled, private or held one, as the presence board tells members; no names,
 * since recall cannot tell the owner from an unknown voice. A persona with one conversation has its episode already.
 */
export const personaDayEpisodes = Effect.fn("BatonMemoryReactor.personaDayEpisodes")(function* (
  nowMs: number,
) {
  const memory = yield* BatonMemoryService;
  const day = dayOf(nowMs - DAY_MS);
  const start = `${day}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + DAY_MS).toISOString();
  const byPersona = new Map<string, MemoryItem[]>();
  // Upkeep's view, so a walled or private conversation is counted, never quoted.
  const all = yield* memory
    .list({ kinds: ["episode"], limit: 100_000 })
    .pipe(Effect.provideService(MemoryViewer, "server"));
  for (const e of all) {
    const persona = CONVERSATION_REF.exec(e.sourceRef ?? "")?.[1];
    if (persona === undefined || e.createdAt < start || e.createdAt >= end) continue;
    byPersona.set(persona, [...(byPersona.get(persona) ?? []), e]);
  }
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const pack = Option.isNone(config)
    ? DEFAULT_OS_PACK
    : readPack(NodePath.dirname(config.value.dbPath));
  const kept: MemoryItem[] = [];
  for (const [persona, episodes] of byPersona) {
    const done = `episode:${day}:${persona}`;
    if (episodes.length < 2 || (yield* memory.flag(done))) continue;
    const open = episodes
      .filter(
        (e) =>
          e.scope !== "project" && e.visibility !== "persona" && e.speaker == null && !e.proposed,
      )
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((e) => e.text.slice(e.text.indexOf(": ") + 2, e.text.indexOf(": ") + 122));
    const name = pack.personas.find((p) => p.id === persona)?.name ?? persona;
    const text = `${day}, ${name}'s day: ${episodes.length} conversations.${
      open.length === 0 ? "" : ` Talked about: ${open.slice(0, 4).join("; ")}`
    }`.slice(0, 500);
    const item = yield* memory
      .add({ kind: "episode", text, source: "thread", sourceRef: `day:${day}:${persona}`, persona })
      .pipe(Effect.orElseSucceed(() => null));
    if (item === null) continue;
    yield* memory.setFlag(done, true);
    kept.push(item);
  }
  return kept;
});
