/** The commit_* tools' arguments, checked, then applied to the store. */
import type { CommitmentStore } from "./commitmentStore.ts";

type Args = Readonly<Record<string, unknown>>;

const MAX_DAYS = 366;

/** A due time from "in N minutes" or an ISO time; null when neither is given. */
export const dueFrom = (args: Args, now: number): number | null => {
  const minutes = args["due_in_minutes"];
  if (minutes !== undefined) {
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
      throw new Error("due_in_minutes must be a number of minutes from now.");
    }
    if (minutes > MAX_DAYS * 1440) throw new Error("That is more than a year away.");
    return now + minutes * 60_000;
  }
  const at = args["due_at"];
  if (at === undefined) return null;
  const ms = typeof at === "string" ? Date.parse(at) : NaN;
  if (Number.isNaN(ms)) throw new Error("due_at must be an ISO date and time.");
  return ms;
};

export const runCommitOp = (
  store: CommitmentStore,
  op: "commit_add" | "commit_done" | "commit_list",
  args: Args,
  now: number,
): string => {
  if (op === "commit_list") return store.describe(args["include_closed"] === true);
  if (op === "commit_done") {
    const id = args["id"];
    if (typeof id !== "string" || id === "") throw new Error("id must be a commitment id.");
    store.close(id, args["status"] === "dropped" ? "dropped" : "done");
    return args["status"] === "dropped" ? "Dropped." : "Marked done.";
  }
  const text = args["text"];
  if (typeof text !== "string") throw new Error("text must be words.");
  const ref = args["ref"];
  const c = store.add({
    text,
    owner: args["owner"] === "you" ? "you" : "tessaya",
    due: dueFrom(args, now),
    source: args["source"] === "assistant" ? "assistant" : "voice",
    ...(typeof ref === "string" && ref !== "" ? { ref: ref.slice(0, 200) } : {}),
  });
  return `Keeping track of it [id: ${c.id}].`;
};
