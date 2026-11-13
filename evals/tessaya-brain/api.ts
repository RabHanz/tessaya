// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off
/**
 * The Messages API as the device brain calls it (`DictationCleanupApi.converse`): raw HTTP, streamed, the system prompt
 * and tools cached. Raw HTTP on purpose: the timing has to be the production path's, not an SDK's.
 */
const API = "https://api.anthropic.com/v1";

export interface Arm {
  readonly id: string;
  readonly model: string;
  /** Request fields that differ per arm: thinking and effort. */
  readonly extra: Readonly<Record<string, unknown>>;
  /** Server tools added after the device's own (web search). */
  readonly serverTools?: ReadonlyArray<Record<string, unknown>>;
  /** Dollars per million tokens: input, output, cache read, 5-minute cache write. */
  readonly price: {
    readonly in: number;
    readonly out: number;
    readonly read: number;
    readonly write: number;
  };
}

export const ARMS: ReadonlyArray<Arm> = [
  {
    // Today's device brain, exactly: Haiku 5.5, thinking disabled.
    id: "haiku-off",
    model: "claude-haiku-5-5",
    extra: { thinking: { type: "disabled" } },
    price: { in: 0.1, out: 0.5, read: 0.01, write: 0.125 },
  },
  {
    // BRAIN-DESIGN §1.1's voice role: no thinking before the first word, low effort.
    id: "sonnet-bt-low",
    model: "claude-sonnet-5-5",
    extra: { thinking: { type: "between_tools" }, output_config: { effort: "low" } },
    price: { in: 2, out: 10, read: 0.2, write: 2.5 },
  },
  {
    id: "sonnet-bt-medium",
    model: "claude-sonnet-5-5",
    extra: { thinking: { type: "between_tools" }, output_config: { effort: "medium" } },
    price: { in: 2, out: 10, read: 0.2, write: 2.5 },
  },
  {
    // For comparison only: the Director keeps web search on the subscription (BRAIN-DESIGN §5).
    id: "sonnet-bt-low-web",
    model: "claude-sonnet-5-5",
    extra: { thinking: { type: "between_tools" }, output_config: { effort: "low" } },
    serverTools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
    price: { in: 2, out: 10, read: 0.2, write: 2.5 },
  },
];

export interface Usage {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface Round {
  /** Ms from sending to the first text or tool call: the model has started acting. */
  readonly firstActMs: number | null;
  /** Ms from sending to the first word of text. */
  readonly firstTextMs: number | null;
  readonly ms: number;
  readonly content: ReadonlyArray<Record<string, unknown>>;
  readonly stop: string | null;
  readonly usage: Usage;
}

const headers = (key: string) => ({
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
});

/** One streamed request; rebuilds the assistant content (thinking, text, tool calls) to send back next round. */
export const stream = async (key: string, body: Record<string, unknown>): Promise<Round> => {
  const started = performance.now();
  const response = await fetch(`${API}/messages`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok || response.body === null)
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  let firstActMs: number | null = null;
  let firstTextMs: number | null = null;
  let stop: string | null = null;
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const blocks: Array<Record<string, unknown> & { json?: string }> = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5)) as Record<string, any>;
      const at = performance.now() - started;
      if (event.type === "message_start") {
        const u = event.message.usage;
        usage.input = u.input_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      } else if (event.type === "content_block_start") {
        const block = { ...event.content_block };
        if (block.type === "tool_use") {
          firstActMs ??= at;
          block.json = "";
        }
        blocks[event.index] = block;
      } else if (event.type === "content_block_delta") {
        const block = blocks[event.index]!;
        const d = event.delta;
        if (d.type === "text_delta") {
          firstActMs ??= at;
          firstTextMs ??= at;
          block.text = `${(block.text as string | undefined) ?? ""}${d.text}`;
        } else if (d.type === "input_json_delta") block.json += d.partial_json;
        else if (d.type === "thinking_delta")
          block.thinking = `${(block.thinking as string | undefined) ?? ""}${d.thinking}`;
        else if (d.type === "signature_delta") block.signature = d.signature;
      } else if (event.type === "message_delta") {
        stop = event.delta.stop_reason ?? null;
        usage.output = event.usage?.output_tokens ?? usage.output;
      } else if (event.type === "error") throw new Error(JSON.stringify(event.error));
    }
  }
  const content = blocks.map(({ json, ...block }) =>
    block.type === "tool_use" ? { ...block, input: json === "" ? {} : JSON.parse(json!) } : block,
  );
  return { firstActMs, firstTextMs, ms: performance.now() - started, content, stop, usage };
};

export const countTokens = async (key: string, body: Record<string, unknown>): Promise<number> => {
  const response = await fetch(`${API}/messages/count_tokens`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { input_tokens?: number; error?: unknown };
  if (json.input_tokens === undefined) throw new Error(JSON.stringify(json.error ?? json));
  return json.input_tokens;
};

export const percentile = (values: ReadonlyArray<number>, p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);
};
