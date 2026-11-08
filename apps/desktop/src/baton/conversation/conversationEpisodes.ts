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
}

export const createEpisodeWatch = (input: {
  readonly conversations: PersonaConversations;
  /** Where each persona's episodes reached (the last turn id), across restarts. */
  readonly file: string;
  readonly nameOf: (persona: string) => string | undefined;
  /** True once the server kept it (or turned it down for good); false to try again on the next tick. */
  readonly send: (episode: EpisodeSend) => Promise<boolean>;
  readonly now?: () => number;
  readonly idleMs?: number;
}) => {
  const now = input.now ?? Date.now;
  const read = (): Record<string, number> => {
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(input.file, "utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, number>)
        : {};
    } catch {
      return {};
    }
  };
  let busy = false;
  return {
    /** Sends what is due; one tick at a time. */
    tick: async (): Promise<number> => {
      if (busy) return 0;
      busy = true;
      let sent = 0;
      try {
        const reached = read();
        for (const persona of input.conversations.byRecent()) {
          const turns = input.conversations
            .of(persona)
            .recent(4_000)
            .filter((t) => t.id > (reached[persona] ?? 0));
          const last = turns.at(-1);
          if (last === undefined || turns.length < EPISODE_MIN_TURNS) continue;
          if (now() - Date.parse(last.at) < (input.idleMs ?? EPISODE_IDLE_MS)) continue;
          const name = input.nameOf(persona) ?? persona;
          const shown = turns.slice(-EPISODE_TURNS);
          const ok = await input
            .send({
              persona,
              transcript: shown
                .map((t) => `he said: ${t.said}\n${name} replied: ${t.reply}`)
                .join("\n\n"),
              sourceRef: `conversation:${persona}:${shown[0]!.id}-${last.id}`,
            })
            .catch(() => false);
          if (!ok) continue;
          reached[persona] = last.id;
          NodeFS.writeFileSync(input.file, JSON.stringify(reached));
          sent += 1;
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
