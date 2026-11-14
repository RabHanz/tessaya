import { describe, expect, it } from "vite-plus/test";

import { instanceName, providerChangeRefusal, providerIdentity } from "./providerChange.ts";

const refused = (current: string | null, target: string | null, approved = false) =>
  providerChangeRefusal({
    started: true,
    approved,
    current: { name: "from", provider: current },
    target: { name: "to", provider: target },
  }) !== null;

describe("providerChangeRefusal", () => {
  it.each([
    [
      "another Claude account",
      providerIdentity("claudeAgent", "a"),
      providerIdentity("claudeAgent", "b"),
      false,
    ],
    ["another driver", "claudeAgent", "codex", true],
    ["a provider this server cannot name", "claudeAgent", null, true],
    ["a thread whose provider is gone", null, "codex", true],
    [
      "another ACP agent",
      providerIdentity("acpRegistry", "acpRegistry:instance:baton-live"),
      providerIdentity("acpRegistry", "acpRegistry:instance:gemini"),
      true,
    ],
  ])("moving to %s refused: %s", (_name, current, target, expected) => {
    expect(refused(current, target)).toBe(expected);
    expect(refused(current, target, true)).toBe(false);
  });
  it("lets a thread pointed at its terminal go on with its last turn's provider, without the flag", () => {
    const pointedAtTerminal = (lastTurnProvider: string, target: string) =>
      providerChangeRefusal({
        started: true,
        approved: false,
        current: {
          name: "Terminal session",
          provider: providerIdentity("acpRegistry", "acpRegistry:instance:baton-live"),
        },
        target: { name: "Claude (Work)", provider: target },
        lastTurnProvider,
      });
    expect(pointedAtTerminal("claudeAgent", "claudeAgent")).toBeNull();
    expect(pointedAtTerminal("claudeAgent", "codex")).not.toBeNull();
  });
});

describe("instanceName", () => {
  it.each([
    ["baton-live", { displayName: "Terminal session", driver: "acpRegistry" }, "Terminal session"],
    ["baton-live", undefined, "Terminal session"],
    ["claudeAgent", undefined, "Claude"],
    ["claude-work", { displayName: "Claude (Work)", driver: "claudeAgent" }, "Claude (Work)"],
    ["claude-work", { driver: "claudeAgent" }, "Claude"],
    ["mystery", undefined, "mystery"],
  ])("%s is shown as its name", (id, entry, expected) => {
    expect(instanceName(id, entry)).toBe(expected);
  });
});
