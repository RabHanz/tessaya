// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * MEM-18's third trigger: a persona's conversation that has gone quiet becomes one episode in memory. The turns since
 * that persona's last episode go to the server's `learn` as `origin: "conversation"`; the cheap model writes the
 * sentences there. Where each persona's episodes reached is kept in `episodes.json` beside the conversation files.
 */
import * as NodeFS from "node:fs";

import type { PersonaConversations } from "./conversationLog.ts";

/** A conversation this quiet is over: the same wait after which its warm sessions are dropped. */
export const EPISODE_IDLE_MS = 30 * 60_000;
/** The newest turns an episode is written from. */
const EPISODE_TURNS = 30;
/** Fewer turns than this since the last episode are not worth one. */
const EPISODE_MIN_TURNS = 2;

export interface EpisodeSend {
  readonly persona: string;
  readonly transcript: string;
  /** `conversation:<persona id>:<first turn id>-<last turn id>`, so each stretch is written once. */
  readonly sourceRef: string;
  /** The project every turn of the stretch was in: the episode stays behind its wall. */
  readonly project: string | null;
  /** A turn of it read outside content, so the episode waits for his yes. */
  readonly tainted: boolean;
  /** The last turn's time: the day the episode is dated. */
  readonly at: string;
}

export const createEpisodeWatch = (input: {
  readonly conversations: PersonaConversations;
  /** Where each persona's episodes reached (the last turn id), across restarts. */
  readonly file: string;
  readonly nameOf: (persona: string) => string | undefined;
  /** "done" once the server kept it or turned it down for good; "retry" (or a throw) sends the same turns again. */
  readonly send: (episode: EpisodeSend) => Promise<"done" | "retry">;
  readonly now?: () => number;
  readonly idleMs?: number;
}) => {
  const now = input.now ?? Date.now;
  const read = (): Record<string, number> | null => {
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(input.file, "utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, number>)
        : {};
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : {};
    }
  };
  // Written whole, then moved over the old one: a crash never leaves half a file that restarts every persona at 0.
  const write = (reached: Record<string, number>) => {
    NodeFS.writeFileSync(`${input.file}.tmp`, JSON.stringify(reached));
    NodeFS.renameSync(`${input.file}.tmp`, input.file);
  };
  let busy = false;
  return {
    /** Sends what is due; one tick at a time. */
    tick: async (): Promise<number> => {
      if (busy) return 0;
      busy = true;
      let sent = 0;
      try {
        const found = read();
        // The first run starts at the end of each file: an upgrade does not send months of turns at once.
        if (found === null) {
          const start: Record<string, number> = {};
          for (const persona of input.conversations.byRecent())
            start[persona] = input.conversations.of(persona).recent(1)[0]?.id ?? 0;
          write(start);
          return 0;
        }
        const reached = found;
        for (const persona of input.conversations.byRecent()) {
          const turns = input.conversations
            .of(persona)
            .recent(4_000)
            .filter((t) => t.id > (reached[persona] ?? 0));
          const last = turns.at(-1);
          if (last === undefined) continue;
          if (now() - Date.parse(last.at) < (input.idleMs ?? EPISODE_IDLE_MS)) continue;
          // One stretch per project in a row, so a walled project's talk is never folded into another's episode.
          const stretches: Array<typeof turns> = [];
          for (const t of turns) {
            const open = stretches.at(-1);
            if (open !== undefined && (open[0]!.project ?? null) === (t.project ?? null))
              open.push(t);
            else stretches.push([t]);
          }
          for (const stretch of stretches) {
            const end = stretch.at(-1)!;
            if (stretch.length >= EPISODE_MIN_TURNS) {
              const shown = stretch.slice(-EPISODE_TURNS);
              const answer = await input
                .send({
                  persona,
                  transcript: shown
                    .map(
                      (t) =>
                        `he said: ${t.said}\n${input.nameOf(t.persona ?? persona) ?? t.persona ?? persona} replied: ${t.reply}`,
                    )
                    .join("\n\n"),
                  sourceRef: `conversation:${persona}:${shown[0]!.id}-${end.id}`,
                  project: end.project ?? null,
                  tainted: stretch.some((t) => t.tainted === true),
                  at: end.at,
                })
                .catch(() => "retry" as const);
              if (answer === "retry") break;
              sent += 1;
            }
            reached[persona] = end.id;
            write(reached);
          }
        }
      } catch {
        // An episode is a bonus: a failed read or write is tried again on the next tick.
      } finally {
        busy = false;
      }
      return sent;
    },
  };
};
