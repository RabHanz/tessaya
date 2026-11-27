/**
 * The brain's routing table, read (tessaya-ops research/BRAIN-DESIGN.md §13): which login and model each kind of work
 * uses, and which roles an API key may serve. A row he has not set gives what that role used before the table, except
 * his 13 Nov choices: spoken turns on his subscription, and the API key for cleanup only. Pure: the server and the
 * desktop read the same answer.
 */
import type {
  BrainApiKey,
  BrainCredential,
  BrainCredentials,
  BrainEffort,
  BrainKeyRoles,
  BrainModels,
  BrainRole,
  DictationCleanup,
} from "@t3tools/contracts";

export interface BrainRoute {
  readonly role: BrainRole;
  readonly use: BrainCredential;
  /** Only when the row names one: the table never falls back on its own. */
  readonly fallback: BrainCredential | null;
  readonly model: string;
  readonly effort: BrainEffort | null;
}

/** The settings the table and its defaults are read from. */
export interface BrainSettings {
  readonly brainCredentials: BrainCredentials;
  readonly brainModels: BrainModels;
  readonly brainKeyRoles: BrainKeyRoles;
  readonly dictationCleanup: Pick<DictationCleanup, "model">;
}

const SUBSCRIPTION: BrainCredential = "subscription";
const ANTHROPIC_KEY: BrainCredential = "apiKey:anthropic";

/** A credential read: which kind, and the account, instance or key it names ("" for the server's own login). */
export const credentialOf = (
  credential: BrainCredential,
):
  | { readonly kind: "subscription"; readonly account: string }
  | { readonly kind: "instance"; readonly instanceId: string }
  | { readonly kind: "apiKey"; readonly key: BrainApiKey } =>
  credential.startsWith("apiKey:")
    ? { kind: "apiKey", key: credential.slice("apiKey:".length) as BrainApiKey }
    : credential.startsWith("instance:")
      ? { kind: "instance", instanceId: credential.slice("instance:".length) }
      : { kind: "subscription", account: credential.slice("subscription:".length) };

/** Cleanup's model before the table: the cleanup setting's when it is Claude's, else Sonnet (Director, 16 Nov). */
const CLEANUP_MODEL = "claude-sonnet-5-5";

/** What a row he has not set uses: what the role used before the table, except his 13 Nov choices (voice, the key). */
const before = (
  role: BrainRole,
  settings: BrainSettings,
  /** `routing.json`'s cheap model (D148). */
  cheap: string,
): Omit<BrainRoute, "role"> => {
  const subscription = (model: string, effort: BrainEffort | null) => ({
    use: SUBSCRIPTION,
    fallback: null,
    model,
    effort,
  });
  switch (role) {
    case "cleanup": {
      const chosen = settings.dictationCleanup.model?.model;
      // His 16 Nov rule, as the desktop runs it: his Claude plan first, his key only as the fallback.
      return {
        use: SUBSCRIPTION,
        fallback: ANTHROPIC_KEY,
        model: chosen?.startsWith("claude-") === true ? chosen : CLEANUP_MODEL,
        effort: "low",
      };
    }
    // His choice (13 Nov): spoken turns on his subscription, Sonnet with thinking off at low effort (B0 §14).
    case "voice":
      return subscription("sonnet", "low");
    case "deep":
      return subscription("opus", "medium");
    case "background":
    case "consolidation":
      return subscription(cheap, "low");
    // Reading a sentence against a closed list of names: the cheapest capable model does it.
    case "intent":
      return subscription("haiku", null);
    // Her line while a slow answer comes (B-056): one short sentence at the turn's start, so the fastest tier.
    case "hold":
      return subscription("haiku", null);
    // A few words on what one of her threads is about (architecture D1): the cheapest tier names a topic.
    case "gist":
      return subscription("haiku", null);
    // Writing two sentences about a turn: the cheapest tier does not reliably say what changed.
    case "synopsis":
    case "web":
    case "vision":
      return subscription("sonnet", null);
  }
};

/** His choice (13 Nov): the Anthropic key pays for dictation cleanup only, chosen for speed. Other keys serve nothing. */
const KEY_ROLES: Readonly<Record<BrainApiKey, ReadonlyArray<BrainRole>>> = {
  anthropic: ["cleanup"],
  openai: [],
  google: [],
};

export const brainRoute = (settings: BrainSettings, role: BrainRole, cheap: string): BrainRoute => {
  const was = before(role, settings, cheap);
  const credential = settings.brainCredentials[role];
  const model = settings.brainModels[role];
  return {
    role,
    use: credential?.use ?? was.use,
    fallback:
      credential === undefined
        ? was.fallback
        : credential.fallback === undefined || credential.fallback === "none"
          ? null
          : credential.fallback,
    model: model?.model ?? was.model,
    effort: model === undefined ? was.effort : (model.effort ?? null),
  };
};

/** The roles this key may serve: his list when he has set one, else cleanup only. */
export const keyRoles = (settings: BrainSettings, key: BrainApiKey): ReadonlyArray<BrainRole> =>
  settings.brainKeyRoles[key] ?? KEY_ROLES[key];

/** The spend guard: null when the key may serve the role, else why not, in words for the log and the Record. */
export const keyRefusal = (
  settings: BrainSettings,
  key: BrainApiKey,
  role: BrainRole,
): string | null =>
  keyRoles(settings, key).includes(role)
    ? null
    : `${role} is not allowed on the ${key} API key (it serves: ${keyRoles(settings, key).join(", ") || "nothing"})`;

/** For logs and the Usage page: "subscription", "subscription (work)", "codex instance", "API key anthropic". */
export const credentialLabel = (credential: BrainCredential): string => {
  const read = credentialOf(credential);
  return read.kind === "apiKey"
    ? `API key ${read.key}`
    : read.kind === "instance"
      ? `${read.instanceId} instance`
      : read.account === ""
        ? "subscription"
        : `subscription (${read.account})`;
};

/** Each role as he would name it, for the Brain and Usage pages. */
export const BRAIN_ROLE_LABELS: Readonly<Record<BrainRole, string>> = {
  cleanup: "Dictation cleanup",
  voice: "Talking",
  deep: "Hard tasks",
  background: "Background learning",
  consolidation: "Memory upkeep",
  web: "Looking things up",
  vision: "Seeing the screen",
  intent: "Reading a sentence",
  synopsis: "Session summaries",
  hold: "Words while she thinks",
  gist: "What each conversation is about",
};

/** Provider logins that bill per token: Claude's key, Bedrock or a custom endpoint, Codex's key, Gemini's key. */
const API_AUTH_TYPES: ReadonlySet<string> = new Set([
  "apiKey",
  "bedrock",
  "customEndpoint",
  "gemini-api-key",
  "agent-platform",
]);

/** Who pays for a provider instance's turns, from its login (`ServerProviderAuth.type`); unknown is his plan. */
export const billingOfAuth = (type: string | undefined): "subscription" | "apiKey" =>
  type !== undefined && API_AUTH_TYPES.has(type) ? "apiKey" : "subscription";

/** Her own CLI calls run from a folder of this name: her usage ledger records them, so T3's transcript scan skips it. */
export const LEDGERED_DIR = "tessaya-ledgered";

/** Claude Code keeps a session under its cwd with every other character a dash, so the tag survives as the suffix. */
export const isLedgeredDir = (name: string) => name.endsWith(`-${LEDGERED_DIR}`);

/** One call's tokens on one model. `input` is the uncached part, as the API counts it. */
export interface CallTokens {
  readonly model: string;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** The Messages API's `usage` (a whole response, or a stream's `message_start` and last `message_delta` merged). */
export const apiTokens = (model: string, usage: unknown): CallTokens | null => {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  return {
    model,
    input: count(u["input_tokens"]),
    cacheRead: count(u["cache_read_input_tokens"]),
    cacheWrite: count(u["cache_creation_input_tokens"]),
    output: count(u["output_tokens"]),
  };
};

/**
 * Claude Code's `result` event: `modelUsage` per resolved model id (a turn can use more than one), else its `usage`
 * under the model it was asked for.
 */
export const cliTokens = (result: unknown, asked: string): ReadonlyArray<CallTokens> => {
  if (typeof result !== "object" || result === null) return [];
  const r = result as Record<string, unknown>;
  const perModel = r["modelUsage"];
  if (typeof perModel === "object" && perModel !== null) {
    const rows = Object.entries(perModel as Record<string, Record<string, unknown>>).map(
      ([model, u]) => ({
        model,
        input: count(u["inputTokens"]),
        cacheRead: count(u["cacheReadInputTokens"]),
        cacheWrite: count(u["cacheCreationInputTokens"]),
        output: count(u["outputTokens"]),
      }),
    );
    if (rows.length > 0) return rows;
  }
  const one = apiTokens(asked, r["usage"]);
  return one === null ? [] : [one];
};
