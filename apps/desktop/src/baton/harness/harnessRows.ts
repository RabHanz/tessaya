/** The Skills and tools area of Baton's window (D146): the harnesses' own plugins, skills and servers. */
import {
  CONNECTOR_INFO,
  CONNECTOR_KINDS,
  connectorKindOf,
} from "@t3tools/tessaya-shared/connectors";

import type { HomeControl } from "../home/batonHome.ts";
import type { HarnessItem } from "./harnessInventory.ts";

/** Add a skill from a web address: reviewed first, installed only after his yes. MCP servers are added with the harness' own command, not from here. */
export const addSkillControl: HomeControl = {
  id: "k.addskill",
  section: "Add a skill",
  label: "Add a skill from a web address",
  hint: "A GitHub page or any https address of a SKILL.md. Tessaya shows where it is from, what it claims and anything risky in it, and installs nothing until you say yes. MCP servers are added with Claude Code's own command (claude mcp add); they are listed here once installed.",
  kind: "list",
  items: [],
  placeholder: "https://github.com/owner/repo/blob/main/skills/name/SKILL.md",
  addLabel: "Review",
};

/** Calendar, mail and chat: what is connected (MCP servers whose names say so) and a box to add one, reviewed first. */
export const connectorControls = (items: ReadonlyArray<HarnessItem>): ReadonlyArray<HomeControl> =>
  CONNECTOR_KINDS.flatMap((kind): ReadonlyArray<HomeControl> => {
    const info = CONNECTOR_INFO[kind];
    const have = items
      .filter((i) => i.kind === "mcp" && connectorKindOf(i.name) === kind)
      .map((i) => i.name);
    return [
      {
        id: `k.connected.${kind}`,
        section: "Connectors",
        label: info.label,
        hint: `Reaches ${info.reads}.`,
        kind: "check",
        status: have.length > 0 ? "ok" : "warn",
        detail: have.length > 0 ? `Connected: ${have.join(", ")}.` : "Not connected.",
      },
      {
        id: `k.conn.${kind}`,
        section: "Connectors",
        label: `Connect ${info.label.toLowerCase()}`,
        hint: "Paste the https address of an MCP server you trust, or the command that starts one. Tessaya shows the exact command and what it could reach, and adds nothing until you say yes.",
        kind: "list",
        items: [],
        placeholder: info.placeholder,
        addLabel: "Review",
      },
    ];
  });

export const harnessControls = (items: ReadonlyArray<HarnessItem>): ReadonlyArray<HomeControl> => {
  if (items.length === 0) {
    return [
      {
        id: "k.empty",
        section: "Plugins",
        label: "Nothing found",
        hint: "Tessaya reads the plugins, skills and servers of Claude Code and Codex on this computer.",
        kind: "check",
        status: "ok",
        detail: "Neither has any installed here.",
      },
      ...connectorControls(items),
      addSkillControl,
    ];
  }
  const section = { plugin: "Plugins", skill: "Skills", mcp: "MCP servers" } as const;
  return [
    ...items.map((i): HomeControl =>
      i.kind === "plugin"
        ? {
            id: `k:${i.name}`,
            section: section.plugin,
            label: `${i.name} (${i.harness})`,
            hint: i.detail,
            kind: "toggle",
            on: i.enabled === true,
          }
        : {
            id: `k.${i.id}`,
            section: section[i.kind],
            label: `${i.name} (${i.harness})`,
            kind: "check",
            status: "ok",
            detail: i.detail === "" ? "Installed." : i.detail,
            ...(i.kind === "skill" ? { more: true } : {}),
          },
    ),
    ...connectorControls(items),
    addSkillControl,
  ];
};

/** `k:<plugin name>` is the switch of one Claude plugin; anything else is not. */
export const pluginOfControl = (id: string): string | null =>
  id.startsWith("k:") ? id.slice(2) : null;
