import { describe, expect, it } from "vite-plus/test";

import { makeCodexClient } from "./codexOperator.ts";

const rig = (allow: boolean) => {
  const sent: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const seen: Array<Record<string, unknown>> = [];
  const client = makeCodexClient({
    write: (line) => sent.push(JSON.parse(line)),
    gate: async (call) => {
      asked.push(call.tool);
      seen.push(call.input);
      return allow ? { allow: true } : { allow: false, reason: "no" };
    },
  });
  return { client, sent, asked, seen };
};
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe("Codex as the operator", () => {
  it("puts each command through the gate, and a no declines it", async () => {
    const r = rig(false);
    r.client.onLine(
      JSON.stringify({
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: { command: "rm x" },
      }),
    );
    await settle();
    expect(r.asked).toEqual(["commandExecution"]);
    expect(r.sent).toEqual([{ id: 7, result: { decision: "decline" } }]);
  });

  it("accepts on a yes, and treats a file change the same way", async () => {
    const r = rig(true);
    r.client.onLine(JSON.stringify({ id: 8, method: "item/fileChange/requestApproval" }));
    await settle();
    expect(r.asked).toEqual(["fileChange"]);
    expect(r.sent[0]).toEqual({ id: 8, result: { decision: "accept" } });
  });

  it("hands the gate the command and the grant root it can judge", async () => {
    const r = rig(true);
    r.client.onLine(
      JSON.stringify({
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: { command: "git push --force", cwd: "C:/x", itemId: "i" },
      }),
    );
    r.client.onLine(
      JSON.stringify({
        id: 2,
        method: "item/fileChange/requestApproval",
        params: { grantRoot: "C:/x", itemId: "j" },
      }),
    );
    await settle();
    expect(r.seen).toEqual([{ command: "git push --force", cwd: "C:/x" }, { path: "C:/x" }]);
  });

  it("refuses a request it does not know, rather than ignoring it", () => {
    const r = rig(true);
    r.client.onLine(JSON.stringify({ id: 9, method: "account/chatgptAuthTokens/refresh" }));
    expect(r.sent[0]).toMatchObject({ id: 9, error: { code: -32601 } });
  });

  it("streams a turn's words and ends with them", async () => {
    const r = rig(true);
    const words: string[] = [];
    const answer = r.client.ask("t1", "hello", (delta) => words.push(delta));
    r.client.onLine(
      JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "Hi " } }),
    );
    r.client.onLine(
      JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "you" } }),
    );
    r.client.onLine(JSON.stringify({ method: "turn/completed", params: {} }));
    expect(await answer).toBe("Hi you");
    expect(words).toEqual(["Hi ", "you"]);
  });
});
