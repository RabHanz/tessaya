/**
 * The desktop's door to the private memory stores on this machine's own server (tessaya-ops research/PRIVATE-MEMORIES.md).
 * The server owns the keys and every rule; this only asks. Every request goes to this machine's server, never through
 * T3's window, because the stores live here.
 */
import type { BatonPrivateStore } from "@t3tools/baton-contracts";
import type { PrivateTurn } from "@t3tools/baton-shared/privateMemory";

/** One request to `/tessaya/private`; rejects with the server's reason in plain words. */
export type PrivateCall = (op: string, args?: Record<string, unknown>) => Promise<unknown>;

export const createPrivateMemory = (call: PrivateCall) => ({
  call,
  people: async (): Promise<ReadonlyArray<BatonPrivateStore>> =>
    ((await call("people")) as { stores: ReadonlyArray<BatonPrivateStore> }).stores,
  /** This desktop's own leases end: the screen locked, the machine slept, or he asked. */
  lockAll: () => call("lock", {}).catch(() => undefined),
  /** The speaker's own private memories for this turn's prompt; empty when the turn may not have them. */
  recall: async (
    turn: PrivateTurn,
    text: string,
  ): Promise<{ readonly block: string; readonly count: number; readonly whose: string | null }> => {
    try {
      return (await call("recall", { turn, text })) as {
        block: string;
        count: number;
        whose: string | null;
      };
    } catch {
      return { block: "", count: 0, whose: null };
    }
  },
  remember: (turn: PrivateTurn, text: string, about?: string | null) =>
    call("remember", { turn, text, ...(about ? { about } : {}) }) as Promise<{
      readonly stored: boolean;
      readonly whose: string | null;
      readonly reason: string | null;
    }>,
  /** Voice ID deleted this person: their store goes with them. Pass this to `createVoiceId`. */
  onPersonDeleted: (personId: string) =>
    call("personDeleted", { personId }).then(
      () => undefined,
      () => undefined,
    ),
});

export type PrivateMemory = ReturnType<typeof createPrivateMemory>;
