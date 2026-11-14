// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { codexMcpNames, readInventory, setPluginEnabled } from "./harnessInventory.ts";

describe("the harnesses' own plugins, skills and servers", () => {
  it("lists them, and flips only a listed plugin, keeping the rest of the file and a backup", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-harness-"));
    const claude = NodePath.join(root, ".claude");
    const codex = NodePath.join(root, ".codex");
    NodeFS.mkdirSync(NodePath.join(claude, "skills", "review"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(codex, "skills", "plan"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(claude, "settings.json"),
      JSON.stringify({ model: "x", enabledPlugins: { "a@m": true, "b@m": false } }),
    );
    NodeFS.writeFileSync(
      NodePath.join(claude, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Reviews a change\n---\nbody",
    );
    NodeFS.writeFileSync(NodePath.join(codex, "skills", "plan", "SKILL.md"), "no front matter");
    NodeFS.writeFileSync(
      NodePath.join(root, ".claude.json"),
      JSON.stringify({ mcpServers: { docs: {} } }),
    );
    NodeFS.writeFileSync(
      NodePath.join(codex, "config.toml"),
      '[mcp_servers.fs]\ncommand = "x"\n[mcp_servers."web"]\n',
    );

    const items = readInventory({
      claudeDir: claude,
      claudeJson: NodePath.join(root, ".claude.json"),
      codexDir: codex,
    });
    expect(items.map((i) => `${i.harness}:${i.kind}:${i.name}:${i.enabled}`)).toEqual([
      "Claude:plugin:a@m:true",
      "Claude:plugin:b@m:false",
      "Claude:skill:review:null",
      "Codex:skill:plan:null",
      "Claude:mcp:docs:null",
      "Codex:mcp:fs:null",
      "Codex:mcp:web:null",
    ]);
    expect(items.find((i) => i.name === "review")?.detail).toBe("Reviews a change");

    expect(setPluginEnabled(claude, "a@m", false)).toBe("changed");
    expect(setPluginEnabled(claude, "a@m", false)).toBe("unchanged");
    expect(setPluginEnabled(claude, "nope@m", true)).toBe("refused");
    const after = JSON.parse(NodeFS.readFileSync(NodePath.join(claude, "settings.json"), "utf8"));
    expect(after).toEqual({ model: "x", enabledPlugins: { "a@m": false, "b@m": false } });
    expect(NodeFS.existsSync(NodePath.join(claude, "settings.json.tessaya-backup"))).toBe(true);
    NodeFS.writeFileSync(NodePath.join(claude, "settings.json"), "not json");
    expect(setPluginEnabled(claude, "a@m", true)).toBe("refused");
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
  it("reads server names from a Codex config", () => {
    expect(
      codexMcpNames('[a]\n[mcp_servers.x]\n[mcp_servers."y-z"]\n[mcp_servers.x.env]\n'),
    ).toEqual(["x", "y-z"]);
  });
});
