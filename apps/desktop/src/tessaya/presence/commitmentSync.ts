/**
 * Follows the commitments file to the server's store and back (D149), so his devices share one
 * list. The file stays the working copy: if the server cannot be reached nothing breaks, and the next
 * sync sends whatever differs. The first sync is also the migration of an older file.
 */
import {
  commitmentsToPush,
  mergeCommitments,
  type Commitment,
} from "@t3tools/tessaya-shared/commitments";

import type { CommitmentStore } from "./commitmentStore.ts";

export type CommitmentCall = (
  op: "list" | "upsert",
  args: Record<string, unknown>,
) => Promise<unknown>;

export const createCommitmentSync = (input: {
  readonly store: CommitmentStore;
  readonly call: CommitmentCall;
}) => {
  let running = false;
  return {
    /** Returns what moved, or null when the server did not answer (the file is still right). */
    sync: async (): Promise<{ pulled: number; pushed: number } | null> => {
      if (running) return null;
      running = true;
      try {
        const reply = (await input.call("list", {})) as {
          items?: ReadonlyArray<Commitment>;
        } | null;
        const remote = reply?.items ?? [];
        const local = input.store.list();
        const merged = mergeCommitments(local, remote);
        const pulled = commitmentsToPush(merged, local).length;
        if (pulled > 0) input.store.replace(merged);
        const push = commitmentsToPush(merged, remote);
        if (push.length > 0) await input.call("upsert", { items: push.slice(0, 500) });
        return { pulled, pushed: push.length };
      } catch {
        return null;
      } finally {
        running = false;
      }
    },
  };
};
