import { describe, expect, it } from "vite-plus/test";

import { answerOf, retried } from "./retry.ts";

describe("retried", () => {
  it("runs a sample again until claude answers, and gives up after the last wait", async () => {
    let tries = 0;
    const flaky = async () => {
      tries += 1;
      if (tries < 3) throw new Error("spawn claude ENOENT");
      return "answer";
    };
    expect(await retried("case #0", flaky, [0, 0])).toBe("answer");
    tries = -10;
    await expect(retried("case #0", flaky, [0])).rejects.toThrow("ENOENT");
  });
});

describe("answerOf", () => {
  const ok = '{"type":"result","is_error":false,"result":"The lamp is on."}';
  it("keeps a run that ended in a result", () => {
    expect(answerOf(`{"type":"system"}\n${ok}`, 0, "")).toContain("The lamp is on.");
  });
  it("is an error when claude never gave a result, or gave an error result", () => {
    expect(() => answerOf("", 1, "Not logged in · Please run /login")).toThrow("Not logged in");
    expect(() =>
      answerOf('{"type":"result","is_error":true,"result":"usage limit reached"}', 1, ""),
    ).toThrow("usage limit reached");
  });
});
