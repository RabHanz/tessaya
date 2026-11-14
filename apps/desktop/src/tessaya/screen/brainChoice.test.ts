import { describe, expect, it } from "vite-plus/test";

import {
  brainRows,
  canChoose,
  parseClaudeStatus,
  parseCodexStatus,
  type BrainStatus,
} from "./brainChoice.ts";

const ready: BrainStatus = { claude: { state: "ready" }, codex: { state: "missing" } };

describe("brain choice", () => {
  it("reads codex's login line, and an API-key login as billed to the key", () => {
    expect(parseCodexStatus("Logged in using ChatGPT\n", 0)).toEqual({
      state: "ready",
      apiKey: false,
    });
    expect(parseCodexStatus("Logged in using an API key", 0).apiKey).toBe(true);
    expect(parseCodexStatus("Not logged in", 1).state).toBe("signed-out");
  });
  it("reads claude's status", () => {
    expect(parseClaudeStatus('{"loggedIn":true,"email":"r@example.com"}')).toEqual({
      state: "ready",
      email: "r@example.com",
    });
    expect(parseClaudeStatus('{"loggedIn":false}').state).toBe("signed-out");
    expect(parseClaudeStatus("oops").state).toBe("signed-out");
  });
  it("lets him choose only what is ready", () => {
    expect(canChoose(ready, "claude")).toBe(true);
    expect(canChoose(ready, "codex")).toBe(false);
    expect(canChoose(ready, "api-key")).toBe(false);
  });
  it("lists API key and local model as coming soon, after the two real ones", () => {
    const rows = brainRows(ready);
    expect(rows.map((r) => r.state)).toEqual(["ready", "unavailable", "soon", "soon"]);
    expect(rows[0]!.note).toContain("subscription");
    expect(rows[1]!.note).toContain("Not installed");
  });
});
