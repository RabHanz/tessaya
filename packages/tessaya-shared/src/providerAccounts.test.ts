/**
 * Adding an account is a decision before it is a mkdir, and the decisions are
 * the part worth pinning: which directory, whether an existing login is being
 * reused, and exactly what the person has to type.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  accountSlug,
  cswapSessionsRoot,
  planProviderAccount,
  type CswapSession,
} from "./providerAccounts.ts";

const home = "/home/dev";

const sessions: ReadonlyArray<CswapSession> = [
  {
    index: 1,
    email: "sableboxco@example.com",
    path: "/home/dev/.local/share/claude-swap/sessions/1-sableboxco_example.com",
  },
  {
    index: 2,
    email: "robinharlow@example.com",
    path: "/home/dev/.local/share/claude-swap/sessions/2-robinharlow_example.com",
  },
];

describe("adding a Claude account", () => {
  it("reuses a claude-swap session rather than making a second home for one login", () => {
    const plan = planProviderAccount({
      driver: "claudeAgent",
      label: "robin",
      home,
      cswapSessions: sessions,
    });

    expect(plan.reusedExistingProfile).toBe(true);
    expect(plan.accountHomePath).toBe(
      "/home/dev/.local/share/claude-swap/sessions/2-robinharlow_example.com",
    );
    // Already logged in there, so the command is a check, not a login.
    expect(plan.loginCommand).toContain("claude auth status");
    expect(plan.instanceId).toBe("claude-robin");
  });

  it("matches the account by its email as well as by a nickname", () => {
    const byEmail = planProviderAccount({
      driver: "claudeAgent",
      label: "sableboxco@example.com",
      home,
      cswapSessions: sessions,
    });
    expect(byEmail.accountHomePath).toBe(
      "/home/dev/.local/share/claude-swap/sessions/1-sableboxco_example.com",
    );
  });

  it("creates its own directory when claude-swap is not managing that account", () => {
    const plan = planProviderAccount({
      driver: "claudeAgent",
      label: "Third Account",
      home,
      cswapSessions: sessions,
    });

    expect(plan.reusedExistingProfile).toBe(false);
    expect(plan.accountHomePath).toBe("/home/dev/.claude-accounts/third-account");
    expect(plan.loginCommand).toBe(
      "CLAUDE_CONFIG_DIR=/home/dev/.claude-accounts/third-account claude auth login",
    );
    expect(plan.sharedHomePath).toBe("/home/dev/.claude");
  });

  it("works with no claude-swap at all", () => {
    const plan = planProviderAccount({ driver: "claudeAgent", label: "work", home });
    expect(plan.accountHomePath).toBe("/home/dev/.claude-accounts/work");
  });
});

describe("adding a Codex account", () => {
  it("names the shadow home upstream already knows how to materialise", () => {
    const plan = planProviderAccount({ driver: "codex", label: "personal", home });

    expect(plan.accountHomePath).toBe("/home/dev/.codex-t3/personal");
    expect(plan.sharedHomePath).toBe("/home/dev/.codex");
    expect(plan.loginCommand).toBe("CODEX_HOME=/home/dev/.codex-t3/personal codex login");
    // Baton does not reinvent Codex's sharing; it points at the setting that
    // already does it, which is the difference between extending T3 and forking
    // it.
    expect(plan.notes.join(" ")).toContain("Shadow home path");
  });
});

describe("the small rules", () => {
  it("turns whatever the user typed into a stable directory name", () => {
    expect(accountSlug("Robin Harlow")).toBe("robin-harlow");
    expect(accountSlug("sableboxco@example.com")).toBe("sableboxco");
    expect(accountSlug("  ")).toBe("account");
  });

  it("follows XDG for claude-swap's sessions, as claude-swap does", () => {
    expect(cswapSessionsRoot({ home })).toBe("/home/dev/.local/share/claude-swap/sessions");
    expect(cswapSessionsRoot({ home, xdgDataHome: "/data" })).toBe("/data/claude-swap/sessions");
  });
});
