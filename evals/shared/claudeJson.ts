// @effect-diagnostics nodeBuiltinImport:off
/**
 * One `claude -p --json-schema` call as `TessayaOneShot` makes it, on the subscription: any metered key is stripped,
 * no tools, hooks, CLAUDE.md or session. Resolves the structured output, or null when there is none.
 */
import * as NodeChildProcess from "node:child_process";

const METERED =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/;

export const askClaudeJson = <A>(
  prompt: string,
  schema: string,
  options: { readonly model: string; readonly claude: string },
): Promise<A | null> =>
  new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !METERED.test(k)));
    const child = NodeChildProcess.spawn(
      options.claude,
      [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        schema,
        "--model",
        options.model,
        "--settings",
        JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false }),
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
      ],
      { env: { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }, stdio: ["pipe", "pipe", "inherit"] },
    );
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", () => {
      try {
        resolve((JSON.parse(stdout) as { structured_output?: A }).structured_output ?? null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(prompt);
  });
