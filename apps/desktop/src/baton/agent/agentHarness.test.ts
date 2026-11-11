// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
/**
 * The dry run of the hands' harness: recorded tool traces go through Baton's real tool server and
 * real gate with a host that moves no pointer and takes no screenshot. It proves the plumbing and
 * the rules the real run depends on, on any machine, at any time.
 */
import { describe, expect, it } from "vite-plus/test";

import { createAgentGate, createTaint } from "./agentGate.ts";
import { startBatonMcp } from "./batonMcp.ts";
import { buildBatonTools, type ToolHost } from "./batonTools.ts";

interface Step {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

const notepadTrace: ReadonlyArray<Step> = [
  { tool: "screen_capture", args: {} },
  { tool: "click_element", args: { label: "Start", why: "open the start menu" } },
  { tool: "wait_for", args: { label: "Search", seconds: 3 } },
  { tool: "type_text", args: { text: "notepad", why: "search for Notepad" } },
  { tool: "click_element", args: { label: "Notepad", why: "open Notepad" } },
  { tool: "wait_for", args: { label: "Text Editor", seconds: 5 } },
  { tool: "type_text", args: { text: "Tessaya task one", why: "the line he asked for" } },
  { tool: "press_keys", args: { keys: ["ctrl", "s"], why: "save" } },
];

const rig = async (opts: { yes: boolean; his?: (t: string) => boolean; window?: () => string }) => {
  const log: string[] = [];
  const asked: string[] = [];
  const host: ToolHost = {
    capture: async () => ({ text: "screen 1", images: [] }),
    remember: async () => "kept",
    forget: async () => "gone",
    jobs: async () => "jobs",
    uiTree: async () => "Window",
    clickElement: async (l) => (log.push(`element ${l}`), `Clicked ${l}.`),
    waitFor: async (l) => (log.push(`wait ${l}`), `${l} is there.`),
    click: async () => "Clicked.",
    scroll: async () => "Scrolled.",
    drag: async () => "Dragged.",
    type: async (t) => (log.push(`type ${t}`), "Typed."),
    press: async (k) => (log.push(`press ${k.join("+")}`), "Pressed."),
    sessions: async () => "",
    session: async () => "",
    send: async () => "",
    fleet: async () => "",
    dictation: async () => "",
    assistantModel: async () => "",
    memory: async () => "",
    conversationSearch: async () => "",
    target: async () => "",
  };
  const gate = createAgentGate({
    actWithoutAsking: () => false,
    taint: createTaint(),
    textIsHis: opts.his ?? (() => false),
    focusedWindow: async () => ({ label: opts.window?.() ?? "Notepad", shell: false }),
    confirm: async (p) => (asked.push(p.title), opts.yes),
    record: () => undefined,
  });
  const mcp = await startBatonMcp({ tools: buildBatonTools(host), gate });
  const call = async (step: Step) => {
    const r = await fetch(mcp.url, {
      method: "POST",
      headers: { authorization: `Bearer ${mcp.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: step.tool, arguments: step.args },
      }),
    });
    return ((await r.json()) as { result: { isError?: boolean } }).result;
  };
  return { mcp, call, log, asked };
};

describe("the hands, dry", () => {
  it("lets a clean Notepad run through, asking nothing except for the words typed after a screenshot", async () => {
    const r = await rig({ yes: false, his: (t) => t === "Tessaya task one" });
    const outcomes: boolean[] = [];
    for (const step of notepadTrace) outcomes.push((await r.call(step)).isError !== true);
    // "notepad" was typed after a screenshot and is not his words, and Ctrl+S is not a navigation key: both asked.
    expect(outcomes).toEqual([true, true, true, false, true, true, true, false]);
    expect(r.asked).toEqual(["Tessaya wants to do this", "Tessaya wants to do this"]);
    await r.mcp.close();
  });

  it("asks again when the box changes, and for a key that is not navigation, even after a yes", async () => {
    const r = await rig({ yes: true });
    const outcomes: boolean[] = [];
    for (const step of notepadTrace) outcomes.push((await r.call(step)).isError !== true);
    expect(outcomes.every(Boolean)).toBe(true);
    // "notepad", then the text in the box he opened (a new box), then Ctrl+S.
    expect(r.asked).toHaveLength(3);
    await r.mcp.close();
  });

  it("lets one yes cover more typing into the same window and box, until Enter ends it", async () => {
    const r = await rig({ yes: true });
    const type = (text: string) =>
      r.call({ tool: "type_text", args: { text, why: "into the box" } });
    await r.call({ tool: "screen_capture", args: {} });
    await r.call({ tool: "click_element", args: { label: "Body", why: "the box" } });
    await type("first");
    await type("second");
    expect(r.asked).toHaveLength(1);
    await r.call({ tool: "press_keys", args: { keys: ["enter"], why: "send" } });
    expect(r.asked).toHaveLength(2);
    await type("third");
    expect(r.asked).toHaveLength(3);
    await r.mcp.close();
  });

  it("asks again when the window with the keyboard is another one", async () => {
    let window = "Notepad";
    const r = await rig({ yes: true, window: () => window });
    const type = (text: string) =>
      r.call({ tool: "type_text", args: { text, why: "into the box" } });
    await r.call({ tool: "screen_capture", args: {} });
    await type("one");
    await type("two");
    expect(r.asked).toHaveLength(1);
    window = "Slack";
    await type("three");
    expect(r.asked).toHaveLength(2);
    await r.mcp.close();
  });

  it("never presses Enter or sends on its own, whatever the trace says", async () => {
    const r = await rig({ yes: false });
    const out = await r.call({ tool: "press_keys", args: { keys: ["enter"], why: "send it" } });
    expect(out.isError).toBe(true);
    expect(r.log).toEqual([]);
    await r.mcp.close();
  });
});
