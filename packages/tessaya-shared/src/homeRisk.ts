/**
 * How risky one Home Assistant action is, decided in code, never by a model: `auto` runs and offers undo, `ask`
 * needs his one clear yes (his gate or a phone card, never the R1's microphone alone), `never` is refused and he
 * does it in Home Assistant. Every write goes through here: a call, an undo, and each action an automation would take.
 */

export type HomeTier = "auto" | "ask" | "never";

/** What Home Assistant says about one target. Names come from HA and are only compared, never obeyed. */
export interface HomeEntityFacts {
  readonly entityId: string;
  readonly name?: string | null;
  readonly deviceClass?: string | null;
}

export interface HomeCallFacts {
  readonly domain: string;
  readonly service: string;
  readonly data?: Readonly<Record<string, unknown>>;
  /** Every entity the call reaches, after expanding devices, areas, labels, scenes and scripts. */
  readonly entities: ReadonlyArray<HomeEntityFacts>;
  /** The call targets `all`, or something the expansion could not see into. */
  readonly unbounded?: boolean;
}

export interface HomeVerdict {
  readonly tier: HomeTier;
  readonly reasons: ReadonlyArray<string>;
}

/** His per-device choices in Settings, by entity id. */
export type HomeOverrides = Readonly<Record<string, HomeTier>>;

/** The heating band he approved: a set point outside it, or heating off, asks first. */
export const CLIMATE_MIN_C = 16;
export const CLIMATE_MAX_C = 28;
/** More devices than this in one call asks first. */
export const MAX_FREE_TARGETS = 5;

const NEVER_SERVICES = new Set([
  "homeassistant.stop",
  "hassio.host_shutdown",
  "hassio.host_reboot",
  "hassio.addon_uninstall",
  "hassio.backup_restore_full",
  "hassio.restore_full",
  "hassio.restore_partial",
]);
const ASK_SERVICES = new Set([
  "homeassistant.restart",
  "homeassistant.reload_all",
  "homeassistant.reload_core_config",
  "zha.permit",
  "zwave_js.add_node",
  "update.install",
  "mqtt.publish",
  "shell_command",
  "rest_command",
  "python_script",
  "pyscript",
]);
const ASK_DOMAINS = new Set([
  "lock",
  "alarm_control_panel",
  "siren",
  "valve",
  "water_heater",
  "hassio",
  "shell_command",
  "rest_command",
  "python_script",
  "pyscript",
  "recorder",
  "backup",
  "system_log",
]);
/** Domains whose devices are safe to switch, unless their name or class says otherwise. */
const FREE_DOMAINS = new Set([
  "light",
  "fan",
  "media_player",
  "switch",
  "input_boolean",
  "input_number",
  "input_select",
  "input_text",
  "input_button",
  "input_datetime",
  "button",
  "number",
  "select",
  "scene",
  "script",
  "climate",
  "cover",
  "humidifier",
  "vacuum",
  "remote",
  "timer",
  "counter",
  "notify",
  "persistent_notification",
  "tts",
  "logbook",
  "homeassistant",
  "automation",
  "camera",
]);
const RISKY_COVER_CLASSES = new Set(["garage", "gate", "door"]);
// Substrings of a name or id: conservative on purpose (an "outdoor" light asks; a fryer never slips by).
const RISKY_WORDS = [
  "garage",
  "gate",
  "door",
  "lock",
  "alarm",
  "security",
  "camera",
  "pump",
  "heater",
  "oven",
  "fryer",
  "gas",
  "siren",
  "privacy",
  "recording",
  "permit",
  "restart",
  "reboot",
  "reset",
  "factory",
  "firmware",
];
/** Camera services that only look. */
const CAMERA_READS = new Set(["snapshot", "record"]);

const rank: Readonly<Record<HomeTier, number>> = { auto: 0, ask: 1, never: 2 };
export const higherTier = (a: HomeTier, b: HomeTier): HomeTier => (rank[a] >= rank[b] ? a : b);

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;

const climateReason = (service: string, data: Readonly<Record<string, unknown>>): string | null => {
  if (service === "turn_off") return "turns the heating or cooling off";
  if (service === "set_hvac_mode" && data["hvac_mode"] === "off")
    return "turns the heating or cooling off";
  for (const key of ["temperature", "target_temp_low", "target_temp_high"]) {
    const value = numberOf(data[key]);
    if (value !== null && (value < CLIMATE_MIN_C || value > CLIMATE_MAX_C))
      return `sets ${value} °C, outside ${CLIMATE_MIN_C}-${CLIMATE_MAX_C} °C`;
  }
  return null;
};

/** One entity's own tier for this call, before his override. */
const entityVerdict = (
  call: HomeCallFacts,
  entity: HomeEntityFacts,
): { tier: HomeTier; reason?: string } => {
  const entityDomain = entity.entityId.split(".")[0] ?? "";
  const label = `${entity.entityId} ${entity.name ?? ""}`.toLowerCase();
  if (ASK_DOMAINS.has(entityDomain))
    return { tier: "ask", reason: `${entity.entityId} is a ${entityDomain}` };
  if (entityDomain === "cover" && RISKY_COVER_CLASSES.has(entity.deviceClass ?? ""))
    return { tier: "ask", reason: `${entity.entityId} is a ${entity.deviceClass}` };
  if (entityDomain === "camera")
    return call.domain === "camera" && CAMERA_READS.has(call.service)
      ? { tier: "auto" }
      : { tier: "ask", reason: `${entity.entityId} is a camera` };
  const word = RISKY_WORDS.find((w) => label.includes(w));
  if (word !== undefined) return { tier: "ask", reason: `${entity.entityId} is named "${word}"` };
  if (!FREE_DOMAINS.has(entityDomain))
    return {
      tier: "ask",
      reason: `${entity.entityId} is a ${entityDomain}, not a known safe kind`,
    };
  return { tier: "auto" };
};

export const homeRisk = (call: HomeCallFacts, overrides: HomeOverrides = {}): HomeVerdict => {
  const domain = call.domain.toLowerCase();
  const service = call.service.toLowerCase();
  const full = `${domain}.${service}`;
  const data = call.data ?? {};
  if (NEVER_SERVICES.has(full) || (domain === "hassio" && /shutdown|reboot/.test(service)))
    return { tier: "never", reasons: [`${full} is done in Home Assistant itself`] };

  let tier: HomeTier = "auto";
  const reasons: Array<string> = [];
  const raise = (to: HomeTier, reason: string) => {
    tier = higherTier(tier, to);
    reasons.push(reason);
  };
  if (ASK_SERVICES.has(full) || ASK_SERVICES.has(domain))
    raise("ask", `${full} changes the house itself`);
  else if (ASK_DOMAINS.has(domain)) raise("ask", `${domain} needs a yes`);
  else if (!FREE_DOMAINS.has(domain)) raise("ask", `${domain} is not a known safe kind`);
  if (domain === "mqtt" && /permit_join/.test(String(data["topic"] ?? "")))
    raise("ask", "opens the Zigbee network to new devices");
  if (domain === "climate") {
    const why = climateReason(service, data);
    if (why !== null) raise("ask", why);
  }
  if (call.unbounded === true) raise("ask", "reaches every device or ones it cannot list");
  if (call.entities.length > MAX_FREE_TARGETS)
    raise("ask", `reaches ${call.entities.length} devices (more than ${MAX_FREE_TARGETS})`);

  for (const entity of call.entities) {
    const own = overrides[entity.entityId];
    if (own !== undefined) {
      if (own !== "auto") raise(own, `${entity.entityId} is set to "${own}" in Settings`);
      continue;
    }
    const verdict = entityVerdict(call, entity);
    if (verdict.tier !== "auto") raise(verdict.tier, verdict.reason ?? entity.entityId);
  }
  return { tier, reasons };
};

/** The service calls in an automation's or script's actions, however deeply nested (choose, if, repeat, parallel). */
export interface HomeActionCall {
  readonly domain: string;
  readonly service: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly data: Readonly<Record<string, unknown>>;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const actionCalls = (actions: unknown): ReadonlyArray<HomeActionCall> => {
  const out: Array<HomeActionCall> = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 20) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = asRecord(node);
    const name = record["action"] ?? record["service"];
    if (typeof name === "string" && name.includes(".")) {
      const [domain = "", service = ""] = name.split(".", 2);
      const data = { ...asRecord(record["data"]), ...asRecord(record["service_data"]) };
      const target = { ...asRecord(record["target"]) };
      // Old-style entity_id beside the action is a target too.
      if (record["entity_id"] !== undefined) target["entity_id"] = record["entity_id"];
      if (data["entity_id"] !== undefined && target["entity_id"] === undefined)
        target["entity_id"] = data["entity_id"];
      out.push({ domain, service, target, data });
    } else if (record["scene"] !== undefined) {
      out.push({
        domain: "scene",
        service: "turn_on",
        target: { entity_id: record["scene"] },
        data: {},
      });
    }
    for (const key of ["sequence", "then", "else", "default", "parallel", "actions", "choose"]) {
      if (record[key] !== undefined) walk(record[key], depth + 1);
    }
    const repeat = asRecord(record["repeat"]);
    if (repeat["sequence"] !== undefined) walk(repeat["sequence"], depth + 1);
  };
  walk(actions, 0);
  return out;
};
