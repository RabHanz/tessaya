// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * One sentence to the one assistant as it ships (its prompt, its tools on its MCP server, a real
 * `claude -p`), with every tool call refused except those that answer with a recorded text. Nothing
 * runs on the machine. The evals and the learning test both use it; it counts the calls.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { clockLine } from "@t3tools/baton-shared/brain";
import type { Brain } from "@t3tools/baton-shared/osPack";

import { createPersonaConversations } from "../conversation/conversationLog.ts";
import { startVisionSession } from "../screen/claudeVision.ts";
import type { TurnPersona } from "./agentPrompt.ts";
import { createAssistantAgent, type Where } from "./agentSession.ts";
import { startBatonMcp } from "./batonMcp.ts";
import { buildBatonTools, type ToolHost } from "./batonTools.ts";

export const REPLAY_REFUSED =
  "This is a test run and nothing runs. Do not try anything else; reply 'ok'.";

/** Every host call fails: the gate refuses first, so this is only a backstop. */
const host = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error(REPLAY_REFUSED);
    },
  },
) as ToolHost;

export const replayTurn = async (input: {
  readonly claudeBinary: string;
  readonly brain: Brain;
  readonly said: string;
  /** Sentences said after `said` in the same session, such as the same question again. */
  readonly again?: ReadonlyArray<string>;
  /** Turns another persona answered just before, on disk as after a restart, so the hand-off is real. */
  readonly before?: ReadonlyArray<{
    readonly persona: TurnPersona;
    readonly said: string;
    readonly reply: string;
  }>;
  /** The clock the turn is given; the shipped line for a fixed Wednesday morning when left out. */
  readonly now?: { readonly at: Date; readonly timeZone: string };
  readonly where: Where;
  /** Tools that answer with this text; every other call is refused. */
  readonly answers?: Readonly<Record<string, string>>;
  /** Added to the turn the way the per-sentence recall adds it, such as a skill under test. */
  readonly extra?: string;
  /** The session's notes block, such as the pack's frame, as a live session gets it. */
  readonly notes?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly timeoutMs?: number;
}): Promise<{
  readonly calls: ReadonlyArray<string>;
  /** Each call's arguments, in the order of `calls`. */
  readonly inputs: ReadonlyArray<unknown>;
  readonly reply: string;
  /** Every reply, `said` first, then each of `again`. */
  readonly replies: ReadonlyArray<string>;
}> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-replay-"));
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const answers = input.answers ?? {};
  const answered = (tool: string) => answers[tool.replace(/^mcp__baton__/, "")] !== undefined;
  const refuse = async (call: { readonly tool: string }) =>
    answered(call.tool)
      ? { allow: true as const }
      : { allow: false as const, reason: REPLAY_REFUSED };
  const tools = buildBatonTools(host).map((t) => {
    const text = answers[t.name];
    return text === undefined ? t : { ...t, run: async () => ({ text }) };
  });
  const mcp = await startBatonMcp({ tools, gate: refuse });
  const conversations = createPersonaConversations({
    dir: NodePath.join(dir, "conversation"),
    legacy: NodePath.join(dir, "conversation.ndjson"),
    lead: "executive",
  });
  // As after a restart: the turns are on disk and the agent learns who answered last from them.
  for (const earlier of input.before ?? [])
    conversations.of(earlier.persona.id).add({
      route: "answer",
      said: earlier.said,
      reply: earlier.reply,
      persona: earlier.persona.id,
    });
  const previous = input.before?.at(-1)?.persona;
  const agent = createAssistantAgent({
    start: async (systemPrompt, brain = input.brain) =>
      startVisionSession({
        claudeBinary: input.claudeBinary,
        model: brain.model,
        effort: brain.effort,
        systemPrompt,
        workDir: dir,
        env: input.env,
        platform: input.platform,
        timeoutMs: input.timeoutMs ?? 120_000,
        // No harness gate: with one the session gets Bash, Read and the web, and a read-only Bash skips
        // the gate. Without it only Baton's tools exist, behind the tool server's own refusal.
        mcp: { url: mcp.url, token: mcp.token },
        onTool: (call) => {
          calls.push(call.tool);
          inputs.push(call.input);
        },
      }),
    conversation: conversations.current,
    conversationOf: conversations.of,
    ...(previous === undefined ? {} : { previousPersona: previous }),
    clockLine: () =>
      clockLine(
        input.now?.at ?? new Date("2026-11-04T10:00:00Z"),
        input.now?.timeZone ?? "Europe/London",
      ),
    beginTurn: () => undefined,
    ...(input.extra === undefined ? {} : { recall: async () => input.extra! }),
    ...(input.notes === undefined ? {} : { notes: () => input.notes! }),
  });
  try {
    const replies: string[] = [];
    for (const said of [input.said, ...(input.again ?? [])])
      replies.push(await agent.say(said, { ...input.where, brain: input.brain }));
    return { calls, inputs, reply: replies.at(-1)!, replies };
  } finally {
    agent.dispose();
    await mcp.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};
