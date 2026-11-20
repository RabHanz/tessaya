/**
 * Tool loading by native tool search (BRAIN-DESIGN §3.1): the core tools stay loaded, every other tool is deferred and
 * found by name, and the system prompt carries one line per family naming them all.
 */

/**
 * Kept loaded on every vessel. Picked by use: his voice turns' tool calls to 20 Nov (683 turns) put home_find,
 * home_do, device_set, conversation_end, settings_find, home_automations, home_state, memory remember and search,
 * set_device_volume, home_automation_save and device_read on top; plus approvals, alarms, Opus and his laptop.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  "home_find",
  "home_do",
  "home_state",
  "home_automations",
  "home_automation_save",
  "device_set",
  "device_read",
  "set_device_volume",
  "settings_find",
  "settings_set",
  "tessaya_memory_search",
  "tessaya_memory_remember",
  "tessaya_ask",
  "tessaya_alarm",
  "laptop_ask",
  "conversation_end",
  "brain_escalate",
]);

/** A tool's family for the index: its first word, or its second after "tessaya_". */
const familyOf = (name: string) => {
  const words = name.split("_");
  return (words[0] === "tessaya" && words.length > 2 ? words[1] : words[0]) ?? name;
};

/**
 * The deferred tools' names, one line per family ("home: home_undo home_automation_set"), for her system prompt: she
 * knows every tool exists and loads one by its exact name. Empty when nothing is deferred.
 */
export const toolIndex = (names: ReadonlyArray<string>): string => {
  const families = new Map<string, Array<string>>();
  for (const name of names.filter((n) => !CORE_TOOLS.has(n)).toSorted()) {
    const family = familyOf(name);
    families.set(family, [...(families.get(family) ?? []), name]);
  }
  if (families.size === 0) return "";
  return [
    "more tools than the loaded ones exist; search for one by its exact name to load it before calling it:",
    ...[...families].map(([family, list]) => `${family}: ${list.join(" ")}`),
  ].join("\n");
};
