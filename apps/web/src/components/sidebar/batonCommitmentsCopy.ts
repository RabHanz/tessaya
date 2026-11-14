/**
 * The desktop once kept its commitments on whichever server connected first, often a linked one. Now that they live on
 * this app's own server, what the linked server holds is copied over once so nothing it kept is hidden. Repeating it is
 * safe: the server's upsert keeps the newer edit by id and never reopens a closed commitment. It runs once per own
 * server, from the first linked server seen, so a different server that later connects first is never copied in.
 */
import type { BatonCommitment } from "@t3tools/tessaya-contracts";
import { commitmentsToPush } from "@t3tools/tessaya-shared/commitments";

const stamp = (c: BatonCommitment): number => c.updatedAt ?? c.closedAt ?? c.createdAt;

export const copyCommitmentsOnce = async (input: {
  /** The first connection; nothing is copied when it is this app's own server. */
  readonly linked: string | undefined;
  readonly own: string;
  readonly list: (environmentId: string) => Promise<ReadonlyArray<BatonCommitment>>;
  readonly upsert: (environmentId: string, items: ReadonlyArray<BatonCommitment>) => Promise<void>;
  readonly done: (key: string) => boolean;
  readonly markDone: (key: string) => void;
}): Promise<number> => {
  const { linked, own } = input;
  if (linked === undefined || linked === own) return 0;
  const key = `->${own}`;
  if (input.done(key)) return 0;
  const [there, here] = await Promise.all([input.list(linked), input.list(own)]);
  const held = new Map(here.map((c) => [c.id, c]));
  // The server lets any closed copy replace an open row; an older one would undo a newer edit made here.
  const push = commitmentsToPush(there, here).filter((c) => {
    const mine = held.get(c.id);
    return !(mine?.status === "open" && c.status !== "open" && stamp(mine) > stamp(c));
  });
  // The upsert takes at most 500 at a time.
  for (let at = 0; at < push.length; at += 500) await input.upsert(own, push.slice(at, at + 500));
  input.markDone(key);
  return push.length;
};
