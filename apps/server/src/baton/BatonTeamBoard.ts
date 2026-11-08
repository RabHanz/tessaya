// @effect-diagnostics nodeBuiltinImport:off
/**
 * The team board (INTEGRATION.md 3.1 step 4, P4): for each persona, its current jobs, its latest conversation
 * episode and its newest lines in the Record. A read of what is already kept, never a store of its own. It sees
 * what its caller may recall, as memory does: an outside caller sees nothing walled and names no persona.
 */
import * as NodePath from "node:path";

import type { BatonTeamBoardInput, BatonTeamMember } from "@t3tools/baton-contracts";
import { mayRecall, type Persona } from "@t3tools/baton-shared/osPack";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { BatonJobService } from "./BatonJobService.ts";
import { BatonMemoryService, MemoryViewer } from "./BatonMemoryService.ts";
import { BatonRecordService } from "./BatonRecordService.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

/** Lines of the Record shown per persona. */
const RECENT_LINES = 3;

/** P5 sets `private:` in the pack; until then no persona is private. */
const packPrivate = (persona: Persona): boolean =>
  (persona as Persona & { readonly private?: boolean }).private === true;

/** A conversation episode's last turn (`conversation:<persona>:<first>-<last>`): later turns, later episode. */
const lastTurn = (sourceRef: string | null): number =>
  Number(/-(\d+)$/.exec(sourceRef ?? "")?.[1] ?? 0);

export const teamBoard = Effect.fn("BatonTeamBoard.read")(function* (
  input: BatonTeamBoardInput,
  isPrivate: (persona: string) => boolean = () => false,
) {
  const pack = readPack(NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath));
  const viewer = yield* MemoryViewer;
  // As memory decides it (`viewFor`): only his desktop app may name a persona or ask for his own view.
  const all = viewer === "server" || (viewer === "desktop" && input.admin === true);
  const agent = viewer === "desktop" ? input.agent : undefined;
  const may = (project: string | null) =>
    project === null || all || mayRecall(pack, agent, project);

  const titles = new Map((yield* (yield* BatonEngine).projects).map((p) => [p.id, p.title]));
  const owners = yield* (yield* BatonJobService).personas();
  const terms = new Set((yield* (yield* BatonJobService).allTerms()).map((t) => t.workSessionId));
  const active = (yield* (yield* WorkSessionService)
    .list({})
    .pipe(Effect.orElseSucceed(() => []))).filter((s) => s.status === "active" && terms.has(s.id));
  const episodes = (yield* (yield* BatonMemoryService).list({
    kinds: ["episode"],
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.admin === undefined ? {} : { admin: input.admin }),
  })).toSorted(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || lastTurn(b.sourceRef) - lastTurn(a.sourceRef),
  );
  const record = yield* BatonRecordService;

  const members: BatonTeamMember[] = [];
  for (const persona of pack.personas) {
    const jobs = active.filter((s) => owners.get(s.id) === persona.id);
    const hidden = packPrivate(persona) || isPrivate(persona.id);
    const base = {
      id: persona.id,
      name: persona.name,
      role: persona.role.split(";")[0]!.trim().replace(/\.$/, ""),
      private: hidden,
      busy: jobs.length > 0,
    };
    // A private persona's work is its own: the board says only whether it is busy.
    if (hidden) {
      members.push({ ...base, jobs: [], episode: null, recent: [] });
      continue;
    }
    const seen = jobs.filter((s) => may(titles.get(s.projectId) ?? null));
    const episode = episodes.find((e) => e.sourceRef?.startsWith(`conversation:${persona.id}:`));
    const recent = (yield* record.query({ actor: persona.name, limit: 20 }))
      .filter((r) => may(r.project ?? null))
      .slice(0, RECENT_LINES);
    members.push({
      ...base,
      jobs: seen.map((s) => ({ id: s.id, title: s.title })),
      episode: episode === undefined ? null : { text: episode.text, at: episode.createdAt },
      recent: recent.map((r) => ({ at: r.at, subject: r.subject, outcome: r.outcome })),
    });
  }
  return { members };
});
