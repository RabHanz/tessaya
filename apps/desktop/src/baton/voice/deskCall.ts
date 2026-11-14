/**
 * A job, watch, memory, commitments or weave request as one call to this machine's own server, for while T3's window is closed
 * (GEN-6). The arguments are shaped as the sidebar shapes them; the server decodes and checks them. Null for a
 * request only the window can answer; a refusal for acting on another machine, which only T3's own session to it does.
 */
import type { BatonJobBridgeRequest } from "@t3tools/tessaya-contracts";
import { resolveRunOn } from "@t3tools/tessaya-shared/runOn";

const MEMORY_OPS = new Set([
  "list",
  "history",
  "restore",
  "search",
  "add",
  "edit",
  "pin",
  "forget",
  "accept",
  "recall",
  "used",
  "export",
  "learn",
  "import",
  "pull",
  "syncState",
  "syncSetEnabled",
  "syncAddPeer",
  "syncForget",
  "syncRun",
]);

const COMMITMENT_OPS = new Set(["list", "upsert"]);
const WEAVE_OPS = new Set(["send", "list"]);
const CLOUD_OPS = new Set(["read", "act", "approve"]);
/** This server's own memory sync, and running the learnings pull: only its door answers, whether or not the window is open. */
const SERVER_ONLY = new Set([
  "pull",
  "syncState",
  "syncSetEnabled",
  "syncAddPeer",
  "syncForget",
  "syncRun",
]);
export const serverOnly = (body: { readonly kind: string; readonly op?: unknown }): boolean =>
  body.kind === "memory" && typeof body.op === "string" && SERVER_ONLY.has(body.op);

export const deskCall = (
  body: {
    readonly kind: string;
    readonly op?: unknown;
    readonly args?: unknown;
    readonly environmentId?: unknown;
  },
  /** This machine's server as its session list names it, once read. */
  here: { readonly environmentId: string; readonly label: string } | null = null,
  labelOf: (environmentId: string) => string = () => "that computer",
): { readonly method: string; readonly input: unknown } | { readonly refuse: string } | null => {
  const args = (body.args ?? {}) as Readonly<Record<string, unknown>>;
  // Cloud tasks on this machine's own hub; acting on another machine stays on T3's own session to it.
  if (body.kind === "cloud") {
    if (typeof body.op !== "string" || !CLOUD_OPS.has(body.op)) return null;
    return body.environmentId === undefined ||
      body.environmentId === "" ||
      body.environmentId === here?.environmentId
      ? { method: `baton.cloud.${body.op}`, input: args }
      : { refuse: `Open T3 to use cloud tasks on ${labelOf(String(body.environmentId))}.` };
  }
  if (body.kind === "memory") {
    return typeof body.op === "string" && MEMORY_OPS.has(body.op)
      ? { method: `baton.memory.${body.op}`, input: args }
      : null;
  }
  // The shared ledger and weave's record are the server's own; the weave tick is the server's drainer, not a client's.
  if (body.kind === "commitments" || body.kind === "weave") {
    const ops = body.kind === "commitments" ? COMMITMENT_OPS : WEAVE_OPS;
    return typeof body.op === "string" && ops.has(body.op)
      ? { method: `baton.${body.kind}.${body.op}`, input: args }
      : null;
  }
  if (body.kind !== "job") return null;
  const text = (key: string) => (typeof args[key] === "string" ? args[key] : "");
  const id = { id: text("id") };
  switch (body.op as BatonJobBridgeRequest["op"]) {
    case "list":
      return { method: "baton.job.list", input: {} };
    case "team":
      return {
        method: "baton.job.team",
        input: {
          ...(text("agent") === "" ? {} : { agent: text("agent") }),
          ...(args["admin"] === true ? { admin: true } : {}),
        },
      };
    // The server places a job here; one he asked to run on another machine stays on T3's own session to it.
    case "start": {
      const runOn = text("runOn").trim();
      // "this computer", its name or the start of it; with the list not read yet only the words for here match.
      if (
        runOn !== "" &&
        !resolveRunOn(
          runOn,
          here === null ? [] : [{ id: here.environmentId, label: here.label }],
          here?.environmentId ?? "",
        ).ok
      )
        return { refuse: `Open T3 to start a job on ${runOn}.` };
      const strings = (key: string) =>
        Array.isArray(args[key]) ? args[key].filter((v) => typeof v === "string") : [];
      return {
        method: "baton.job.place",
        input: {
          project: text("project"),
          title: text("title"),
          goal: text("goal"),
          folders: strings("folders"),
          tools: strings("tools"),
          ...(text("worker") === "" ? {} : { worker: text("worker") }),
          ...(typeof args["reportEveryMinutes"] === "number"
            ? { reportEveryMinutes: args["reportEveryMinutes"] }
            : {}),
        },
      };
    }
    case "handoff":
      return {
        method: "baton.job.handoff",
        input: {
          ...id,
          instance: text("instance"),
          ...(text("note") === "" ? {} : { note: text("note") }),
        },
      };
    case "watch":
      return { method: "baton.watch.get", input: {} };
    case "agree":
      return { method: "baton.job.agree", input: id };
    case "stop":
      return { method: "baton.job.stop", input: id };
    case "split":
      return {
        method: "baton.job.split",
        input: { ...id, parts: Array.isArray(args["parts"]) ? args["parts"] : [] },
      };
    case "schedule":
      return {
        method: "baton.job.schedule",
        input: {
          ...id,
          everyMinutes: typeof args["everyMinutes"] === "number" ? args["everyMinutes"] : null,
        },
      };
    case "refine":
      return {
        method: "baton.job.refine",
        input: {
          ...id,
          text: text("text"),
          via: args["via"] === "text" ? "text" : "voice",
          widens: args["widens"] === true,
          ...(args["note"] === true ? { note: true } : {}),
        },
      };
    case "grant":
    case "revoke":
      return { method: `baton.job.${String(body.op)}`, input: { ...id, channel: text("channel") } };
    default:
      return null;
  }
};
