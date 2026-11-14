import { describe, expect, it } from "vite-plus/test";

import { subscriptionEnv } from "./claudeVision.ts";
import {
  candidateDirs,
  maskEmail,
  parseAuthStatus,
  pickEnv,
  type AssistantAccount,
} from "./assistantAccount.ts";

const base = { PATH: "x", CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "k" };
const a: AssistantAccount = { key: "/h/.claude-a", email: "robin@example.com", loggedIn: true };

describe("assistant account", () => {
  it("leaves his environment alone when nothing is chosen", () => {
    expect(pickEnv(null, [a], base)).toEqual({ env: base, notice: null });
  });
  it("points at the chosen directory, drops the token, and still never bills the API", () => {
    const { env } = pickEnv(a.key, [a], base);
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(a.key);
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(subscriptionEnv(env)["ANTHROPIC_API_KEY"]).toBeUndefined();
  });
  it("falls back with a plain message when the login expired or the account is gone", () => {
    const out = pickEnv(a.key, [{ ...a, loggedIn: false }], base);
    expect(out.env).toBe(base);
    expect(out.notice).toContain("robin has signed out");
    expect(pickEnv("/h/.claude-z", [a], base).notice).toContain("gone");
  });
  it("trusts the choice before the first look", () => {
    expect(pickEnv(a.key, null, base).env["CLAUDE_CONFIG_DIR"]).toBe(a.key);
  });
  it("reads claude's status, with or without a banner", () => {
    expect(parseAuthStatus('banner\n{"loggedIn":true,"email":"r@example.com"}')).toEqual({
      loggedIn: true,
      email: "r@example.com",
    });
    expect(parseAuthStatus("not json")).toBeNull();
  });
  it("finds the default, the .claude-* homes and swap sessions once each", () => {
    const list = (dir: string) =>
      dir === "/h"
        ? [".claude", ".claude-a", ".bashrc"]
        : dir === "/h/.local/share/claude-swap/sessions"
          ? ["s1"]
          : [];
    expect(candidateDirs({ home: "/h", env: {}, list })).toEqual([
      "/h/.claude",
      "/h/.claude-a",
      "/h/.local/share/claude-swap/sessions/s1",
    ]);
  });
  it("hides the address until asked", () => {
    expect(maskEmail("robin@example.com")).toBe("r•••@example.com");
  });
});
