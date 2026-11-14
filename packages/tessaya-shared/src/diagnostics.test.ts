import { describe, expect, it } from "vite-plus/test";

import { buildDiagnostics, redactText, scrubLog, scrubSettings } from "./diagnostics.ts";

describe("diagnostics", () => {
  it("removes tokens, emails, user names and addresses from any text", () => {
    const out = redactText(
      "key sk-abcdefghijklmnopqrstuv mail me@example.com at C:\\Users\\Ann\\AppData and /home/bob/x from 10.0.0.12 Bearer abcdefghijklmnop1234",
    );
    expect(out).not.toMatch(/sk-abc|me@example|Ann|bob|10\.0\.0\.12|abcdefghijklmnop1234/);
    expect(out).toContain("C:\\Users\\<user>\\AppData");
  });
  it("keeps timings and kinds in a log and drops every word he said or heard", () => {
    const line = JSON.stringify({
      kind: "agent_turn",
      totalMs: 3707,
      said: "my password is x",
      reply: "ok",
      tools: ["screen_capture"],
      nested: { text: "hello", ms: 4 },
    });
    const out = JSON.parse(scrubLog(`${line}\nnot json me@example.com`).split("\n")[0]!);
    expect(out).toMatchObject({
      kind: "agent_turn",
      totalMs: 3707,
      said: "<removed>",
      reply: "<removed>",
      tools: ["screen_capture"],
      nested: { text: "<removed>", ms: 4 },
    });
    expect(scrubLog("plain me@example.com")).toBe("plain <email>");
  });
  it("hides tokens and accounts in the settings and builds one file with a plain heading", () => {
    const settings = JSON.parse(
      scrubSettings({
        claudeToken: "abc",
        accountEmail: "a@example.com",
        appearance: "dark",
        waitMs: 800,
      }),
    );
    expect(settings).toEqual({
      claudeToken: "<removed>",
      accountEmail: "<removed>",
      appearance: "dark",
      waitMs: 800,
    });
    const file = buildDiagnostics({
      at: "2026-11-02",
      sections: [{ title: "Version", body: "0.1.34 on C:\\Users\\Ann" }],
    });
    expect(file).toContain("never uploaded");
    expect(file).toContain("===== Version =====");
    expect(file).not.toContain("Ann");
  });
});
