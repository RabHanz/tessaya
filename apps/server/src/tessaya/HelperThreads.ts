/**
 * Threads that only exist because Tessaya's own helper Claude sessions were mirrored (the assistant, rewrite and
 * clean-up prompts, an account's login): they are not work. Pure, so the rules are tested without a server.
 */
import { isTessayaOwnFolder } from "./ClaudeLiveSessions.ts";

export interface HelperThreadInput {
  readonly title: string;
  readonly projectRoot: string | null;
  /** A turn is running in it now. */
  readonly running: boolean;
  /** Messages the thread holds (user and assistant). */
  readonly messages: number;
}

export type HelperThreadVerdict =
  | { readonly kind: "archive"; readonly reason: string }
  | { readonly kind: "leave"; readonly reason: string }
  | null;

const MIRROR_TITLE = /^userdata-[0-9a-f]+ · /i;
const CLEANUP_PROMPT = /^Add sentence punctuation and capitals/i;
const DELETED_SHELL = /^shell in .*\(deleted\)\s*$/i;

/**
 * Archive when it is a helper's mirror and nothing is running in it. A project folder under .t3 is Tessaya's own data,
 * so everything in it is helper work. Elsewhere a helper-looking title is archived only when the thread is empty;
 * with messages in it, it is left for a person to look at.
 */
export const classifyHelperThread = (input: HelperThreadInput): HelperThreadVerdict => {
  const own = isTessayaOwnFolder(input.projectRoot);
  const looksLike =
    MIRROR_TITLE.test(input.title) ||
    CLEANUP_PROMPT.test(input.title) ||
    DELETED_SHELL.test(input.title);
  if (!own && !looksLike) return null;
  if (input.running) return { kind: "leave", reason: "a turn is running in it" };
  if (own)
    return {
      kind: "archive",
      reason: "a mirror of one of Tessaya's own helper sessions (its project folder is under .t3)",
    };
  if (input.messages > 0)
    return { kind: "leave", reason: "it has messages and is not in Tessaya's own folder" };
  return { kind: "archive", reason: "an empty thread with a helper's name" };
};
