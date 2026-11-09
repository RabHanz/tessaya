import { describe, expect, it } from "vite-plus/test";

import { providerChangeRefusal, providerIdentity } from "./providerChange.ts";

const refused = (current: string | null, target: string | null, approved = false) =>
  providerChangeRefusal({
    started: true,
    approved,
    current: { instance: "from", provider: current },
    target: { instance: "to", provider: target },
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
});
