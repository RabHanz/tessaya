import { describe, expect, it } from "vite-plus/test";

import { createAgentGate, createTaint } from "./agentGate.ts";

const rig = (yes = true) => {
  const asked: string[] = [];
  const taint = createTaint();
  const gate = createAgentGate({
    actWithoutAsking: () => true,
    taint,
    textIsHis: () => false,
    focusedWindow: async () => ({ label: "x", shell: false }),
    confirm: async (p) => (asked.push(p.detail), yes),
    record: () => undefined,
  });
  return { gate, asked, taint };
};
const weave = (session: string, text: string, job?: string) => ({
  tool: "mcp__baton__weave_send",
  input: { session, text, ...(job === undefined ? {} : { job }) },
});

describe("the gate on weaving", () => {
  it("asks with the exact text the first time in a job, then it is routine for that session only", async () => {
    const r = rig();
    expect((await r.gate(weave("build", "please rerun the tests", "j1"))).allow).toBe(true);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toContain("please rerun the tests");
    expect((await r.gate(weave("build", "and the lint too", "j1"))).allow).toBe(true);
    expect(r.asked).toHaveLength(1);
    await r.gate(weave("docs", "hello there", "j1"));
    expect(r.asked).toHaveLength(2);
    await r.gate(weave("build", "other job message", "j2"));
    expect(r.asked).toHaveLength(3);
  });
  it("a no is not remembered, and a message after a read asks again", async () => {
    const no = rig(false);
    expect((await no.gate(weave("build", "please rerun", "j1"))).allow).toBe(false);
    expect((await no.gate(weave("build", "please rerun", "j1"))).allow).toBe(false);
    expect(no.asked).toHaveLength(2);

    const r = rig();
    await r.gate(weave("build", "first one", "j1"));
    r.taint.mark();
    await r.gate(weave("build", "second one", "j1"));
    expect(r.asked).toHaveLength(2);
  });
});
