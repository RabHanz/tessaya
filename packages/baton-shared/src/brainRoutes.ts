/**
 * The brain's routing table, read (tessaya-ops research/BRAIN-DESIGN.md §13): which login and model each kind of work
 * uses, and which roles an API key may serve. A row he has not set gives exactly what the settings before the table
 * chose, so nothing changes until he changes a row. Pure: the server and the desktop read the same answer.
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
  RoomBrain,
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
  readonly roomBrain: RoomBrain;
  readonly dictationCleanup: Pick<DictationCleanup, "model">;
}

const SUBSCRIPTION: BrainCredential = "subscription";
const ANTHROPIC_KEY: BrainCredential = "apiKey:anthropic";

/** A credential read: which kind, and the account or key it names ("" for the server's own login). */
export const credentialOf = (
  credential: BrainCredential,
):
  | { readonly kind: "subscription"; readonly account: string }
  | { readonly kind: "apiKey"; readonly key: BrainApiKey } =>
  credential.startsWith("apiKey:")
    ? { kind: "apiKey", key: credential.slice("apiKey:".length) as BrainApiKey }
    : { kind: "subscription", account: credential.slice("subscription:".length) };

/** Cleanup's model before the table: the cleanup setting's when it is Claude's, else Haiku. */
const CLEANUP_MODEL = "claude-haiku-5-5";

/** What each role used before the table existed, so an unset row changes nothing. */
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
      return {
        use: ANTHROPIC_KEY,
        fallback: null,
        model: chosen?.startsWith("claude-") === true ? chosen : CLEANUP_MODEL,
        effort: "low",
      };
    }
    case "voice": {
      // roomBrain: "auto" was the key with the subscription behind it.
      const model = "claude-haiku-5-5";
      if (settings.roomBrain === "subscription") return subscription(model, null);
      return {
        use: ANTHROPIC_KEY,
        fallback: settings.roomBrain === "auto" ? SUBSCRIPTION : null,
        model,
        effort: null,
      };
    }
    case "deep":
      return subscription("opus", "medium");
    case "background":
    case "consolidation":
      return subscription(cheap, "low");
    // Reading a sentence against a closed list of names: the cheapest capable model does it.
    case "intent":
      return subscription("haiku", null);
    // Writing two sentences about a turn: the cheapest tier does not reliably say what changed.
    case "synopsis":
    case "web":
    case "vision":
      return subscription("sonnet", null);
  }
};

/** The roles each key served before the table: cleanup, and the room's turns unless they went by the subscription. */
const keyRolesBefore = (
  settings: BrainSettings,
): Readonly<Record<BrainApiKey, ReadonlyArray<BrainRole>>> => ({
  anthropic: settings.roomBrain === "subscription" ? ["cleanup"] : ["cleanup", "voice"],
});

export const brainRoute = (settings: BrainSettings, role: BrainRole, cheap: string): BrainRoute => {
  const was = before(role, settings, cheap);
  const credential = settings.brainCredentials[role];
  const model = settings.brainModels[role];
  return {
    role,
    use: credential?.use ?? was.use,
    fallback: credential === undefined ? was.fallback : (credential.fallback ?? null),
    model: model?.model ?? was.model,
    effort: model === undefined ? was.effort : (model.effort ?? null),
  };
};

/** The roles this key may serve: his list when he has set one, else what it served before the table. */
export const keyRoles = (settings: BrainSettings, key: BrainApiKey): ReadonlyArray<BrainRole> =>
  settings.brainKeyRoles[key] ?? keyRolesBefore(settings)[key];

/** The spend guard: null when the key may serve the role, else why not, in words for the log and the Record. */
export const keyRefusal = (
  settings: BrainSettings,
  key: BrainApiKey,
  role: BrainRole,
): string | null =>
  keyRoles(settings, key).includes(role)
    ? null
    : `${role} is not allowed on the ${key} API key (it serves: ${keyRoles(settings, key).join(", ") || "nothing"})`;

/** For logs and the Usage page: "subscription", "subscription (work)", "API key anthropic". */
export const credentialLabel = (credential: BrainCredential): string => {
  const read = credentialOf(credential);
  return read.kind === "apiKey"
    ? `API key ${read.key}`
    : read.account === ""
      ? "subscription"
      : `subscription (${read.account})`;
};
