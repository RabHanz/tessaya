// @effect-diagnostics nodeBuiltinImport:off
/**
 * What the Claude and Codex harnesses Tessaya drives already have: plugins, skills and MCP servers
 * (D146). Tessaya does not run a plugin system of its own; it reads theirs and flips the one switch
 * Claude Code defines for a plugin (`enabledPlugins` in its settings file).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface HarnessItem {
  readonly id: string;
  readonly name: string;
  readonly harness: "Claude" | "Codex";
  readonly kind: "plugin" | "skill" | "mcp";
  /** Only a plugin has a switch; for the rest `null`. */
  readonly enabled: boolean | null;
  readonly detail: string;
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const skillDirs = (root: string, harness: HarnessItem["harness"]): ReadonlyArray<HarnessItem> => {
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(root);
  } catch {
    return [];
  }
  return names.toSorted().flatMap((name) => {
    try {
      const text = NodeFS.readFileSync(NodePath.join(root, name, "SKILL.md"), "utf8");
      const described = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
      return [
        {
          id: `${harness.toLowerCase()}-skill-${name}`,
          name,
          harness,
          kind: "skill" as const,
          enabled: null,
          detail: described.slice(0, 160),
        },
      ];
    } catch {
      return [];
    }
  });
};

/** `[mcp_servers.name]` tables of a Codex config. A full TOML parser is not needed for the names. */
export const codexMcpNames = (toml: string): ReadonlyArray<string> =>
  [...toml.matchAll(/^\[mcp_servers\.("?)([A-Za-z0-9_-]+)\1\]\s*$/gm)].map((m) => m[2]!);

export const readInventory = (input: {
  readonly claudeDir: string;
  readonly claudeJson: string;
  readonly codexDir: string;
}): ReadonlyArray<HarnessItem> => {
  const settings = readJson(NodePath.join(input.claudeDir, "settings.json"));
  const enabled = (settings?.["enabledPlugins"] ?? {}) as Record<string, unknown>;
  const plugins = Object.entries(enabled).map(([name, on]): HarnessItem => ({
    id: `claude-plugin-${name}`,
    name,
    harness: "Claude",
    kind: "plugin",
    enabled: on === true,
    detail: "Applies to the next session.",
  }));
  const servers = Object.keys(
    (readJson(input.claudeJson)?.["mcpServers"] ?? {}) as Record<string, unknown>,
  ).map((name): HarnessItem => ({
    id: `claude-mcp-${name}`,
    name,
    harness: "Claude",
    kind: "mcp",
    enabled: null,
    detail: "Managed in Claude Code (/mcp).",
  }));
  let codexToml = "";
  try {
    codexToml = NodeFS.readFileSync(NodePath.join(input.codexDir, "config.toml"), "utf8");
  } catch {
    // no Codex config
  }
  const codexServers = codexMcpNames(codexToml).map((name): HarnessItem => ({
    id: `codex-mcp-${name}`,
    name,
    harness: "Codex",
    kind: "mcp",
    enabled: null,
    detail: "Managed in Codex's config.",
  }));
  return [
    ...plugins,
    ...skillDirs(NodePath.join(input.claudeDir, "skills"), "Claude"),
    ...skillDirs(NodePath.join(input.codexDir, "skills"), "Codex"),
    ...servers,
    ...codexServers,
  ];
};

/**
 * Flips one plugin in Claude's settings file, keeping every other key. Refuses a file it cannot read
 * as an object, and a plugin the file does not list (it never adds one), so it cannot damage a config.
 */
export const setPluginEnabled = (
  claudeDir: string,
  name: string,
  enabled: boolean,
): "changed" | "unchanged" | "refused" => {
  const file = NodePath.join(claudeDir, "settings.json");
  const settings = readJson(file);
  const plugins = settings?.["enabledPlugins"];
  if (
    settings === null ||
    typeof plugins !== "object" ||
    plugins === null ||
    !Object.hasOwn(plugins, name)
  ) {
    return "refused";
  }
  if ((plugins as Record<string, unknown>)[name] === enabled) return "unchanged";
  const next = { ...settings, enabledPlugins: { ...(plugins as object), [name]: enabled } };
  NodeFS.writeFileSync(`${file}.tessaya-backup`, NodeFS.readFileSync(file));
  NodeFS.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return "changed";
};
