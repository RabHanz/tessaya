/**
 * What a worker used, read from its own session transcript: Claude Code writes the usage on every
 * assistant message, Codex writes a running total on each token_count event. Sums per model; the
 * server prices them. Pure: it reads lines, never files.
 */
export interface Totals {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface ModelUsage {
  readonly model: string;
  readonly totals: Totals;
}

const ZERO: Totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const add = (a: Totals, b: Totals): Totals => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
});

const parse = (line: string): Record<string, unknown> | null => {
  if (!line.includes("usage") && !line.includes("turn_context")) return null;
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Claude Code: one usage block per assistant message, repeated on each content block of it; the last of each message id counts. */
export const claudeUsage = (lines: Iterable<string>): ReadonlyArray<ModelUsage> => {
  const byMessage = new Map<string, { model: string; totals: Totals }>();
  let anon = 0;
  for (const line of lines) {
    const rec = parse(line);
    const message = rec?.["message"] as Record<string, unknown> | undefined;
    const usage = message?.["usage"] as Record<string, unknown> | undefined;
    if (rec?.["type"] !== "assistant" || message === undefined || usage === undefined) continue;
    const model = typeof message["model"] === "string" ? message["model"] : "";
    if (model === "" || model === "<synthetic>") continue;
    const id = typeof message["id"] === "string" ? message["id"] : `anon-${anon++}`;
    byMessage.set(`${id}:${typeof rec["requestId"] === "string" ? rec["requestId"] : ""}`, {
      model,
      totals: {
        input: n(usage["input_tokens"]),
        cacheRead: n(usage["cache_read_input_tokens"]),
        cacheWrite: n(usage["cache_creation_input_tokens"]),
        output: n(usage["output_tokens"]),
      },
    });
  }
  return group([...byMessage.values()]);
};

/**
 * Codex: `total_token_usage` is cumulative for the session, so the last one is the whole. Its input
 * count includes the cached part, which is split out here. The model is the last turn_context's.
 */
export const codexUsage = (lines: Iterable<string>): ReadonlyArray<ModelUsage> => {
  let model = "";
  let total: Totals | null = null;
  for (const line of lines) {
    const rec = parse(line);
    if (rec === null) continue;
    const payload = rec["payload"] as Record<string, unknown> | undefined;
    if (rec["type"] === "turn_context" && typeof payload?.["model"] === "string")
      model = payload["model"];
    if (rec["type"] === "event_msg" && payload?.["type"] === "token_count") {
      const info = payload["info"] as Record<string, unknown> | undefined;
      const t = info?.["total_token_usage"] as Record<string, unknown> | undefined;
      if (t === undefined) continue;
      const cached = n(t["cached_input_tokens"]);
      total = {
        input: Math.max(0, n(t["input_tokens"]) - cached),
        cacheRead: cached,
        cacheWrite: n(t["cache_write_input_tokens"]),
        output: n(t["output_tokens"]),
      };
    }
  }
  return total === null || model === "" ? [] : [{ model, totals: total }];
};

const group = (items: ReadonlyArray<ModelUsage>): ReadonlyArray<ModelUsage> => {
  const by = new Map<string, Totals>();
  for (const i of items) by.set(i.model, add(by.get(i.model) ?? ZERO, i.totals));
  return [...by.entries()].map(([model, totals]) => ({ model, totals }));
};

export const sumUsage = (
  lists: ReadonlyArray<ReadonlyArray<ModelUsage>>,
): ReadonlyArray<ModelUsage> => group(lists.flat());

export const tokenCount = (items: ReadonlyArray<ModelUsage>): number =>
  items.reduce(
    (s, i) => s + i.totals.input + i.totals.cacheRead + i.totals.cacheWrite + i.totals.output,
    0,
  );
