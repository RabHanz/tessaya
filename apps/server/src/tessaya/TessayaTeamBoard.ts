// @effect-diagnostics nodeBuiltinImport:off
/**
 * The team board and record (P4, B-033): each persona's duties, templates with what their playbooks learned, track
 * record, current jobs, latest episode, newest Record lines and lead moves. A read of what is kept, never a store, so
 * another system can sync the team through this one read (`baton.job.team`). Walls apply as memory's do.
 */
import * as NodePath from "node:path";

import type { TessayaTeamBoardInput, TessayaTeamMember } from "@t3tools/tessaya-contracts";
import { trackOf } from "@t3tools/tessaya-shared/jobs";
import { mayRecall, type Persona } from "@t3tools/tessaya-shared/osPack";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import { TessayaEngine } from "./TessayaEngine.ts";
import { TessayaJobService } from "./TessayaJobService.ts";
import { TessayaMemoryService, MemoryViewer } from "./TessayaMemoryService.ts";
import { TessayaRecordService } from "./TessayaRecordService.ts";
import { readPack, readTemplates } from "./OperatingSystemPack.ts";
import { playbookStats } from "./TessayaPlaybook.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

/** Lines of the Record shown per persona. */
const RECENT_LINES = 3;
/** Lead moves shown per persona. */
const RECENT_MOVES = 3;

/** P5 sets `private:` in the pack; until then no persona is private. */
const packPrivate = (persona: Persona): boolean =>
  (persona as Persona & { readonly private?: boolean }).private === true;

/** A conversation episode's last turn (`conversation:<persona>:<first>-<last>`): later turns, later episode. */
const lastTurn = (sourceRef: string | null): number =>
  Number(/-(\d+)$/.exec(sourceRef ?? "")?.[1] ?? 0);

/** `isPrivate` beside the pack's flag: P5 passes its grants here (a persona private to this caller). */
export const teamBoard = Effect.fn("BatonTeamBoard.read")(function* (
  input: TessayaTeamBoardInput,
  isPrivate: (persona: string) => boolean = () => false,
) {
  const userdata = NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath);
  const pack = readPack(userdata);
  const templates = readTemplates(userdata).filter((t) => t.kind === "job");
  const viewer = yield* MemoryViewer;
  // As memory decides it (`viewFor`): only his desktop app may name a persona or ask for his own view.
  const all = viewer === "server" || (viewer === "desktop" && input.admin === true);
  const agent = viewer === "desktop" ? input.agent : undefined;
  const may = (project: string | null) =>
    project === null || all || mayRecall(pack, agent, project);

  const titles = new Map((yield* (yield* TessayaEngine).projects).map((p) => [p.id, p.title]));
  const owners = yield* (yield* TessayaJobService).personas();
  const allTerms = yield* (yield* TessayaJobService).allTerms();
  const terms = new Set(allTerms.map((t) => t.workSessionId));
  const sessions = yield* (yield* WorkSessionService)
    .list({ includeArchived: true })
    .pipe(Effect.orElseSucceed(() => []));
  const sessionOf = new Map(sessions.map((s) => [s.id as string, s]));
  // Archived and settled sessions are not current jobs; the track record reads them all.
  const active = sessions.filter((s) => s.status === "active" && terms.has(s.id));
  const episodes = (yield* (yield* TessayaMemoryService).list({
    kinds: ["episode"],
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.admin === undefined ? {} : { admin: input.admin }),
  })).toSorted(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || lastTurn(b.sourceRef) - lastTurn(a.sourceRef),
  );
  const record = yield* TessayaRecordService;

  const members: TessayaTeamMember[] = [];
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
    const visible = (job: string) => {
      const project = sessionOf.get(job)?.projectId;
      const title = project === undefined ? undefined : titles.get(project);
      return title === undefined ? all : may(title);
    };
    const led = allTerms.filter(
      (t) =>
        visible(t.workSessionId) &&
        (t.lead === persona.id ||
          (t.leadMoves ?? []).some((m) => m.declined === undefined && m.to === persona.id)),
    );
    const moves = allTerms
      .filter((t) => visible(t.workSessionId))
      .flatMap((t) =>
        (t.leadMoves ?? [])
          .filter((m) => m.from === persona.id || m.to === persona.id || m.declined === persona.id)
          .map((m) => ({
            job: t.workSessionId as string,
            title: sessionOf.get(t.workSessionId)?.title ?? t.goal,
            from: m.from,
            to: m.to,
            at: m.at,
            ...(m.declined === undefined ? {} : { declined: m.declined }),
          })),
      )
      .toSorted((a, b) => b.at.localeCompare(a.at))
      .slice(0, RECENT_MOVES);
    const own = templates.filter(
      (t) => t.persona?.toLowerCase() === persona.name.toLowerCase() || t.persona === persona.id,
    );
    const books = [];
    for (const t of own)
      books.push({ id: t.id, title: t.title, ...(yield* playbookStats(`template:${t.id}`)) });
    const ended = (yield* record.query({ actor: persona.name, kind: "job", limit: 500 })).filter(
      (r) => may(r.project ?? null),
    );
    // A project it cannot name is treated as walled: only the server and his own view see its work.
    const seen = jobs.filter((s) => {
      const title = titles.get(s.projectId);
      return title === undefined ? all : may(title);
    });
    const episode = episodes.find((e) => e.sourceRef?.startsWith(`conversation:${persona.id}:`));
    const recent = (yield* record.query({ actor: persona.name, limit: 20 }))
      .filter((r) => may(r.project ?? null))
      .slice(0, RECENT_LINES);
    members.push({
      ...base,
      // Busy only with work this caller may see: a walled job must not show through as "busy".
      busy: seen.length > 0,
      jobs: seen.map((s) => ({ id: s.id, title: s.title })),
      episode: episode === undefined ? null : { text: episode.text, at: episode.createdAt },
      recent: recent.map((r) => ({ at: r.at, subject: r.subject, outcome: r.outcome })),
      duties: persona.role,
      templates: books,
      track: { led: led.length, ...trackOf(ended) },
      moves,
    });
  }
  return { members };
});
