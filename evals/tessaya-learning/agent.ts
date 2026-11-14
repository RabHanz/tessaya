// @effect-diagnostics nodeBuiltinImport:off
/**
 * One `claude -p` run in a job's folder, on his own Claude login, with only file and shell tools and none of this
 * machine's settings, skills or MCP servers. Returns what the graders and the learners need from its stream.
 */
import * as NodeChildProcess from "node:child_process";

export interface Run {
  readonly steps: ReadonlyArray<string>;
  /** Tool results, for the taint scan and for a learner that reads the whole conversation. */
  readonly results: ReadonlyArray<string>;
  readonly final: string;
  readonly tokens: number;
  readonly costUsd: number;
  readonly ms: number;
  readonly ok: boolean;
}

const summarize = (name: string, input: Record<string, unknown>): string => {
  const v = input["command"] ?? input["file_path"] ?? input["pattern"] ?? input["path"] ?? "";
  return `${name}(${String(v).replace(/\s+/g, " ").slice(0, 160)})`;
};

export const runClaude = (input: {
  readonly cwd: string;
  readonly prompt: string;
  readonly system?: string;
  readonly model: string;
  /** No tools: a learner's one answer. */
  readonly tools: boolean;
  readonly claude?: string;
}): Promise<Run> =>
  new Promise((resolve) => {
    const started = Date.now();
    const args = [
      "-p",
      input.prompt,
      "--safe-mode",
      "--model",
      input.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      ...(input.tools
        ? ["--tools", "Bash,Read,Write,Edit,Glob,Grep", "--permission-mode", "bypassPermissions"]
        : ["--tools", ""]),
      // A learner replaces Claude Code's own prompt; a worker keeps it and gets the arm's memory on top.
      ...(input.system === undefined || input.system === ""
        ? []
        : [input.tools ? "--append-system-prompt" : "--system-prompt", input.system]),
    ];
    const child = NodeChildProcess.spawn(input.claude ?? "claude", args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const steps: string[] = [];
    const results: string[] = [];
    let final = "";
    let tokens = 0;
    let costUsd = 0;
    let ok = false;
    const line = (l: string) => {
      let e: Record<string, any>;
      try {
        e = JSON.parse(l);
      } catch {
        return;
      }
      if (e.type === "assistant") {
        for (const c of e.message?.content ?? []) {
          if (c.type === "tool_use") steps.push(summarize(c.name, c.input ?? {}));
          if (c.type === "text" && typeof c.text === "string") final = c.text;
        }
      }
      if (e.type === "user") {
        for (const c of e.message?.content ?? []) {
          if (c.type !== "tool_result") continue;
          const text = Array.isArray(c.content)
            ? c.content.map((x: { text?: string }) => x.text ?? "").join("\n")
            : String(c.content ?? "");
          results.push(text.slice(0, 4000));
        }
      }
      if (e.type === "result") {
        const u = e.usage ?? {};
        tokens =
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.output_tokens ?? 0);
        costUsd = e.total_cost_usd ?? 0;
        ok = e.subtype === "success";
        if (typeof e.result === "string" && e.result !== "") final = e.result;
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 6 * 60_000);
    child.on("close", () => {
      clearTimeout(timer);
      if (buf.trim() !== "") line(buf);
      resolve({ steps, results, final, tokens, costUsd, ms: Date.now() - started, ok });
    });
  });
