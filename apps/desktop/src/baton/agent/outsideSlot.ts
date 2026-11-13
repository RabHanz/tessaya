// @effect-diagnostics globalTimers:off
/**
 * Everything a paired device's or an agent's turn runs with, fixed when the slot is built. Nothing here reads which
 * turn is current, so his sentence arriving mid-turn cannot lend this turn his trust, his memory view or his plan.
 */
import { detectSecret } from "@t3tools/baton-shared/memory";

import { createDesktopMemory } from "../memory/memoryClient.ts";
import type { MemoryCall } from "../memory/memoryClient.ts";
import type { NotesStore } from "../memory/memoryNotes.ts";
import { createAgentGate, createTaint } from "./agentGate.ts";
import type { BatonTool } from "./batonMcp.ts";
import type { ToolHost } from "./batonTools.ts";

const STOPPED = "Stopped: the Director started talking to Tessaya. Do nothing more.";
/** Typed this many characters at a time, so a stop lands between chunks rather than after the whole text. */
const TYPE_CHUNK = 24;

type GateInput = Parameters<typeof createAgentGate>[0];

export const createOutsideSlot = (input: {
  /** His tool host; memory and the vault are replaced here. */
  readonly host: ToolHost;
  readonly memoryCall: MemoryCall;
  readonly notes: NotesStore;
  readonly focusedWindow: GateInput["focusedWindow"];
  /** Asks him, labelled as a paired device's request. */
  readonly confirm: GateInput["confirm"];
  readonly record: GateInput["record"];
  readonly jobProjects?: GateInput["jobProjects"];
  readonly chrome?: GateInput["chrome"];
  /** A standing job's owning persona: its memory view. A device's turn has none. */
  readonly agent?: string;
  /** Who is speaking when it is a saved person or a guest: their role narrows what this turn may do. */
  readonly principal?: GateInput["principal"];
}) => {
  const taint = createTaint();
  // Once he speaks the turn is over: nothing it started may go on acting.
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();
  const track = <A>(work: Promise<A>): Promise<A> => {
    inFlight.add(work);
    void work.then(
      () => inFlight.delete(work),
      () => inFlight.delete(work),
    );
    return work;
  };
  // A device's turn has no persona: the walled view, whoever is speaking to him at the time.
  const memory = createDesktopMemory({
    call: input.memoryCall,
    notes: input.notes,
    agent: () => input.agent,
  });
  // No plan grant, no typing grant and no "act without asking": every allow but Tessaya's own reads becomes an ask.
  const judge = createAgentGate({
    actWithoutAsking: () => false,
    taint,
    textIsHis: () => false,
    outside: () => true,
    focusedWindow: input.focusedWindow,
    // Nobody answering is never a yes to a device.
    confirm: (prompt) => input.confirm({ ...prompt, noOnExpiry: true }),
    record: input.record,
    ...(input.jobProjects === undefined ? {} : { jobProjects: input.jobProjects }),
    ...(input.chrome === undefined ? {} : { chrome: input.chrome }),
    ...(input.principal === undefined ? {} : { principal: input.principal }),
  });
  const gate: typeof judge = async (call) => {
    if (closed) return { allow: false, reason: STOPPED };
    const verdict = await track(judge(call));
    return closed ? { allow: false, reason: STOPPED } : verdict;
  };
  // A device's or agent's turn never reaches the vault or a private store.
  const { vault: _noVault, rememberPrivate: _noPrivate, ...rest } = input.host;
  const host: ToolHost = {
    ...rest,
    // Memory only, never his conversation: "what did he say about X" has nothing to find here.
    memory: async (query) => {
      const kept = await memory.search(query);
      return kept.length === 0 ? "Nothing earlier matches." : kept.join("\n\n");
    },
    conversationSearch: async () => "A paired device's request cannot read his conversations.",
    remember: (text) => memory.remember(text),
    forget: (id) => memory.forget(id),
    pin: (id, pinned) => memory.pin(id, pinned),
    used: () => memory.used(),
    // The device's walled view: a walled item has no history to it.
    memoryHistory: (id) => memory.history(id),
    type: async (text, window) => {
      for (let at = 0; at < text.length; at += TYPE_CHUNK) {
        if (closed) return STOPPED;
        await input.host.type(text.slice(at, at + TYPE_CHUNK), window);
      }
      return "Typed.";
    },
    // A plan or a lesson would carry his yes across steps a device chose; a device asks one step at a time.
    planShow: async () =>
      "A paired device's request cannot set up a plan. Do one step at a time; each asks him.",
    guided: async () => "A paired device's request cannot start a lesson on his screen.",
    // A weave never carries a secret, and a device's turn never offers one to his vault.
    // A device or another agent may propose a standing job, never set one up or change his: it waits, off, for his yes.
    jobs: async (op, args) =>
      op === "weave_send" && detectSecret(String(args["text"] ?? "")) !== null
        ? "That looks like a secret, and a weave never carries one. Nothing was sent."
        : op === "team"
          ? // A device's view names no persona and never asks for his own: walled work stays hidden.
            input.host.jobs("team", {})
          : op === "user_job_create"
            ? input.host.jobs("user_job_propose", args)
            : op === "user_job_update" || op === "user_job_delete"
              ? "Only he can change or remove his standing jobs; they are on his Trust page."
              : input.host.jobs(op, args),
  };
  return {
    gate,
    host,
    memory,
    /** Each tool does nothing once the turn is closed, and is counted while it runs. */
    guard: (tools: ReadonlyArray<BatonTool>): ReadonlyArray<BatonTool> =>
      tools.map((tool) => ({
        ...tool,
        run: async (args) => (closed ? { text: STOPPED } : track(tool.run(args))),
      })),
    /** Ends the turn: refuses from now on, and waits up to `capMs` for what was running to finish. */
    close: async (capMs = 2_000): Promise<void> => {
      closed = true;
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise((resolve) => setTimeout(resolve, capMs)),
      ]);
    },
    closed: (): boolean => closed,
    beginTurn: (said: string) => {
      memory.beginTurn();
      taint.reset(said);
    },
  };
};

export type OutsideSlot = ReturnType<typeof createOutsideSlot>;
