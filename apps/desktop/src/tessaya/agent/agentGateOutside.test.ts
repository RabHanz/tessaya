import { describe, expect, it } from "vite-plus/test";

import { createAgentGate, createTaint } from "./agentGate.ts";

const rig = (outside: boolean) => {
  const asked: string[] = [];
  const taint = createTaint();
  const gate = createAgentGate({
    actWithoutAsking: () => true,
    taint,
    textIsHis: () => true,
    outside: () => outside,
    focusedWindow: async () => ({ label: "notepad.exe: notes", shell: false }),
    confirm: async (p) => (asked.push(p.title), true),
    record: () => undefined,
  });
  taint.reset("tell the build session to rerun the tests");
  return { gate, asked };
};
const send = {
  tool: "mcp__baton__session_send",
  input: { id: "build", text: "rerun the tests" },
};
const typing = { tool: "mcp__baton__type_text", input: { text: "rerun the tests", why: "w" } };

describe("words a paired device or agent left, not his", () => {
  it("are never his: what his own words would do quietly asks him first", async () => {
    const his = rig(false);
    await his.gate(send);
    await his.gate(typing);
    expect(his.asked).toEqual([]);

    const device = rig(true);
    await device.gate(send);
    await device.gate(typing);
    expect(device.asked).toHaveLength(2);
  });

  it("ask before every act One Trust lets his own words do quietly, and read Tessaya's state without asking", async () => {
    const acts = [
      { tool: "mcp__baton__click_element", input: { label: "Save", why: "w" } },
      { tool: "mcp__baton__scroll", input: { x: 1, y: 1, dy: 3, why: "w" } },
      { tool: "mcp__baton__press_keys", input: { keys: ["delete"], why: "w" } },
      { tool: "mcp__baton__press_keys", input: { keys: ["ctrl", "a"], why: "w" } },
      { tool: "mcp__baton__text_undo", input: {} },
      { tool: "mcp__baton__cloud_cancel", input: { id: "c1" } },
      { tool: "mcp__baton__job_stop", input: { id: "j1" } },
      { tool: "mcp__baton__job_revoke", input: { id: "j1", what: "email" } },
      { tool: "mcp__baton__permission_off", input: { what: "screen" } },
      { tool: "mcp__baton__memory_pin", input: { id: "m1", pinned: true } },
      { tool: "mcp__baton__session_resume", input: { id: "s1" } },
      { tool: "mcp__baton__window_focus", input: { title: "Notepad" } },
      {
        tool: "mcp__baton__act_batch",
        input: { steps: [{ tool: "click_element", args: { label: "Save" } }], why: "w" },
      },
    ];
    const his = rig(false);
    for (const act of acts) await his.gate(act);
    const device = rig(true);
    for (const act of acts) await device.gate(act);
    expect(device.asked.length).toBe(acts.length);
    expect(device.asked.length).toBeGreaterThan(his.asked.length);

    const reads = rig(true);
    await reads.gate({ tool: "mcp__baton__jobs_list", input: {} });
    await reads.gate({ tool: "mcp__baton__needs_me", input: {} });
    expect(reads.asked).toEqual([]);
  });
});
