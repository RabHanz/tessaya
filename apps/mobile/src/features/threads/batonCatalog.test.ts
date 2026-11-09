import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { accountPickOption, batonProviderGroups, liveTraits, loadedLoginKey } from "./batonCatalog";

const group = (
  providerKey: string,
  providerLabel: string,
  driver: string,
  models: ReadonlyArray<string>,
): ProviderGroup => ({
  providerKey,
  providerLabel,
  models: models.map((model, index): ModelOption => ({
    key: `${providerKey}:${model}`,
    label: model,
    subtitle: "",
    providerKey,
    providerLabel,
    providerDriver: driver,
    isDefault: index === models.length - 1,
    isLegacy: false,
    capabilities: null,
    selection: { instanceId: ProviderInstanceId.make(providerKey), model },
  })),
});

// The owner's sheet listed every login as its own provider, one of them twice.
const groups = [
  group("baton-live", "Terminal session", "claudeAgent", ["opus"]),
  group("claudeAgent", "Work", "claudeAgent", ["opus", "sonnet"]),
  group("claude_work", "Work", "claudeAgent", ["opus", "sonnet"]),
  group("claude_home", "Home", "claudeAgent", ["opus", "sonnet"]),
  group("codex", "Codex", "codex", ["gpt-a", "gpt-b"]),
  group("acp_cursor", "Cursor", "acpRegistry", ["auto"]),
  group("acp_grok", "Grok", "acpRegistry", ["grok"]),
];

describe("the sheet's providers", () => {
  it("are one group each, Terminal its own, the shown login's models under a key that holds", () => {
    const shown = batonProviderGroups(groups, "claude_home");
    expect(shown.map((entry) => [entry.providerKey, entry.providerLabel])).toEqual([
      ["baton-live", "Terminal"],
      ["claudeAgent", "Work"],
      ["codex", "Codex"],
      ["acp_cursor", "Cursor"],
      ["acp_grok", "Grok"],
    ]);
    expect(shown[1]?.models[0]?.key).toBe("claude_home:opus");
    expect(batonProviderGroups(groups, "codex")[1]?.models[0]?.key).toBe("claudeAgent:opus");
  });
});

describe("an account tap", () => {
  const account = (instanceId: string) => ({ instanceIds: [instanceId], methods: [] });

  it("keeps the thread's model on its own provider and takes the default on another", () => {
    const thread = { driver: "claudeAgent", model: "opus" };
    expect(accountPickOption(account("claude_home"), groups, thread)?.key).toBe("claude_home:opus");
    expect(accountPickOption(account("codex"), groups, thread)?.key).toBe("codex:gpt-b");
    expect(accountPickOption(account("missing"), groups, thread)).toBeNull();
  });
});

describe("a terminal thread's effort", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: [
          { id: "session", label: "Current" },
          { id: "high", label: "High" },
        ],
      },
    ],
  };
  const selection = (instanceId: string) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    model: "opus",
    options: [{ id: "effort", value: "session" }],
  });

  it("reads as the session's own level, never Current, and leaves other threads alone", () => {
    const live = liveTraits(capabilities, selection("baton-live"), "high");
    expect(live.selections).toEqual([{ id: "effort", value: "high" }]);
    expect(live.capabilities?.optionDescriptors?.[0]).toMatchObject({
      options: [{ id: "high", label: "High" }],
    });
    expect(liveTraits(capabilities, selection("claudeAgent"), "high").selections).toEqual([
      { id: "effort", value: "session" },
    ]);
  });
});

describe("a terminal session's login", () => {
  const pool = [
    { key: "1", email: "work@example.com", active: true },
    { key: "2", email: "home@example.com", active: false },
  ];

  it("is unknown until the catalog answers for this session, never cswap's active login", () => {
    expect(loadedLoginKey(null, "abc", pool)).toBeNull();
    expect(loadedLoginKey({ sessionId: "old", login: "home" }, "abc", pool)).toBeNull();
    expect(loadedLoginKey({ sessionId: "abc", login: "home" }, "abc", pool)).toBe("2");
  });
});
