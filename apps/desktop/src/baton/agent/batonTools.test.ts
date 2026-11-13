import { BATON_TOOLS, REMOTE_ONLY_TOOLS, ROOM_ONLY_TOOLS } from "@t3tools/baton-shared/operator";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildBatonTools,
  COVERED_BY_OWN,
  clickTargetsField,
  focusIsOn,
  treeText,
  type FocusState,
  type ToolHost,
} from "./batonTools.ts";

const host = (log: string[], windows: string[] = ["w1"]): ToolHost => ({
  windowKey: async () => windows.shift() ?? "w1",
  capture: async () => ({ text: "shot" }),
  remember: async () => "kept",
  forget: async () => "gone",
  jobs: async (op) => `jobs ${op}`,
  uiTree: async () => "Window\nButton: Save",
  clickElement: async (l, d) => (log.push(`element ${l}${d ? " double" : ""}`), "clicked"),
  waitFor: async (l, s) => (log.push(`wait_for ${l} ${s}`), "found"),
  click: async (a) => (
    log.push(`click ${a.x},${a.y}${a.double === true ? " double" : ""}`),
    "clicked"
  ),
  scroll: async (n) => (log.push(`scroll ${n}`), "scrolled"),
  drag: async () => "dragged",
  type: async (t) => (log.push(`type ${t}`), "typed"),
  press: async (k) => (log.push(`press ${k.join("+")}`), "pressed"),
  sessions: async () => "sessions",
  session: async () => "session",
  send: async (id, t) => (log.push(`send ${id} ${t}`), "sent"),
  fleet: async () => "fleet",
  dictation: async (on) => (log.push(`dictation ${on}`), "ok"),
  assistantModel: async (model, effort) => (log.push(`model ${model} ${effort}`), "ok"),
  memory: async (q) => (log.push(`memory ${q}`), "found"),
  conversationSearch: async (q) => (log.push(`conversation ${JSON.stringify(q)}`), "found"),
  target: async () => "noted",
});

describe("the assistant's tool table", () => {
  it("names exactly the tools the gate knows, the house and devices from his server's registry", () => {
    const spec = (name: string, readonly = false) => ({
      name,
      description: name,
      input_schema: { type: "object" },
      readonly,
    });
    const house = ["home_find", "home_state", "home_automations", "device_list"].map((n) =>
      spec(n, true),
    );
    const acts = ["home_do", "home_undo", "home_automation_save", "home_automation_set"];
    const devices = ["device_act", "device_owner", "device_tag"];
    const registry = {
      specs: [...house, ...[...acts, ...devices].map((n) => spec(n))],
      call: async () => "done",
    };
    const names = buildBatonTools({ ...host([]), shared: registry }).map((t) => t.name);
    expect(new Set(names)).toEqual(
      new Set([...BATON_TOOLS].filter((t) => !REMOTE_ONLY_TOOLS.has(t) && !ROOM_ONLY_TOOLS.has(t))),
    );
    expect(buildBatonTools(host([])).some((t) => t.name === "home_do")).toBe(false);
  });

  it("adds each shared tool once, with whether it reads, and never one its own tools cover", async () => {
    const own = new Set(buildBatonTools(host([])).map((t) => t.name));
    expect(Object.values(COVERED_BY_OWN).filter((name) => !own.has(name))).toEqual([]);
    const spec = (name: string, readonly: boolean, core?: boolean) => ({
      name,
      description: name,
      input_schema: { type: "object" },
      readonly,
      ...(core === undefined ? {} : { core }),
    });
    const called: Array<[string, unknown]> = [];
    const tools = buildBatonTools({
      ...host([]),
      shared: {
        specs: [
          spec("settings_find", true, true),
          spec("settings_set", false),
          spec("tessaya_memory_search", true),
          spec("memory_search", true),
        ],
        call: async (name, args) => (called.push([name, args]), "changed"),
      },
    });
    const shared = tools.filter((t) => t.shared !== undefined);
    expect(shared.map((t) => [t.name, t.shared, t.core])).toEqual([
      ["settings_find", "read", true],
      ["settings_set", "write", undefined],
    ]);
    expect(await shared[1]!.run({ key: "desktop:chime", value: false })).toEqual({
      text: "changed",
    });
    expect(called).toEqual([["settings_set", { key: "desktop:chime", value: false }]]);
    expect(
      buildBatonTools(
        { ...host([]), shared: { specs: [spec("settings_set", false)], call: async () => "" } },
        { remote: true },
      ).some((t) => t.name === "settings_set"),
    ).toBe(false);
  });
  it("checks arguments before touching anything", async () => {
    const log: string[] = [];
    const tools = new Map(buildBatonTools(host(log)).map((t) => [t.name, t]));
    await expect(tools.get("click")!.run({ x: "a", y: 2, why: "w" })).rejects.toThrow(
      "x must be a number",
    );
    await expect(tools.get("type_text")!.run({ text: "", why: "w" })).rejects.toThrow("non-empty");
    await expect(tools.get("type_text")!.run({ text: "x".repeat(5000), why: "w" })).rejects.toThrow(
      "too long",
    );
    await expect(tools.get("press_keys")!.run({ keys: [], why: "w" })).rejects.toThrow(
      "one to four",
    );
    expect(log).toEqual([]);
    await expect(tools.get("click_element")!.run({ label: "", why: "w" })).rejects.toThrow(
      "non-empty",
    );
    await tools.get("wait_for")!.run({ label: "Save", seconds: 99 });
    await tools.get("scroll")!.run({ amount: 99, why: "w" });
    await tools.get("click")!.run({ x: 3, y: 4, double: true, why: "w" });
    expect(log).toEqual(["wait_for Save 10", "scroll 10", "click 3,4 double"]);
  });

  it("lets the assistant type into a named window behind another, by value", async () => {
    const typed: Array<[string, string | undefined]> = [];
    const tools = buildBatonTools({
      ...host([]),
      type: async (t, w) => (typed.push([t, w]), "added"),
    });
    const typeText = tools.find((t) => t.name === "type_text")!;
    expect(Object.keys((typeText.inputSchema as { properties: object }).properties)).toContain(
      "window",
    );
    await typeText.run({ text: "hello world", window: "Notepad", why: "w" });
    expect(typed).toEqual([["hello world", "Notepad"]]);
  });

  it("tells the keyboard is in the named box only by its whole name, and not without a name", () => {
    expect(focusIsOn('edit: Message t3code-a2 = "hi"', "Message t3code-a2")).toBe(true);
    expect(focusIsOn("edit: Message t3code-a2 (focused)", "Message t3code-a2")).toBe(true);
    expect(focusIsOn("button: Send a message", "Send")).toBe(false);
    expect(focusIsOn("edit: Notes", "")).toBe(null);
    expect(focusIsOn(null, "Notes")).toBe(null);
  });

  it("knows a click on a text box from the last tree", () => {
    const tree = [
      "[1] button: Send",
      "[2] edit: Message t3code-a2 (focused)",
      "[3] document: Notes",
    ];
    expect(clickTargetsField(tree, { id: 2 })).toBe(true);
    // Never by name, even the box's own: a name can be a button's as well.
    expect(clickTargetsField(tree, { label: "Message t3code-a2" })).toBe(false);
    expect(clickTargetsField(tree, { id: 1 })).toBe(false);
    expect(clickTargetsField(['[5] edit: Notes = "draft"'], { id: 5 })).toBe(true);
    expect(clickTargetsField(tree, { label: "Send" })).toBe(false);
    expect(clickTargetsField(tree, { x: 1, y: 2 })).toBe(false);
  });

  it("clicks a tree line by its number and says when the tree was cut", async () => {
    const log: string[] = [];
    const tools = new Map(buildBatonTools(host(log)).map((t) => [t.name, t]));
    await tools.get("click_element")!.run({ id: 3, why: "w" });
    await expect(tools.get("click_element")!.run({ id: 0, why: "w" })).rejects.toThrow(
      "line number",
    );
    expect(log).toEqual(["element 3"]);
    expect(treeText({ window: "Files", controls: ["[1] list item: a"], shown: 400 })).toContain(
      "showing 1 of 400 controls; pass find",
    );
    expect(treeText({ window: "Files", controls: ["[1] list item: a"], shown: 1 })).toBe(
      "Files\n[1] list item: a",
    );
  });

  it("an action says what it changed, or that nothing changed; a batch step does not read back", async () => {
    vi.useFakeTimers();
    using _real = { [Symbol.dispose]: () => void vi.useRealTimers() };
    const states: FocusState[] = [];
    const read = async () => states.shift() ?? null;
    const tools = buildBatonTools({ ...host([]), focusState: read });
    const run = async (name: string, args: Record<string, unknown>) => {
      const out = tools.find((t) => t.name === name)!.run(args);
      await vi.runAllTimersAsync();
      return (await out).text;
    };
    const notepad = (focus: string): FocusState => ({ window: "Notepad", focus });
    states.push(notepad('document: Text = ""'), notepad('document: Text = "hi"'));
    expect(await run("type_text", { text: "hi", why: "w" })).toBe(
      'typed\nNow: same window; the keyboard is in document: Text = "hi".',
    );
    states.push(notepad("document: Text"), { window: "Save as", focus: "edit: File name" });
    expect(await run("press_keys", { keys: ["ctrl", "s"], why: "w" })).toContain(
      'the window is "Save as" (was "Notepad")',
    );
    states.push(...[1, 2, 3].map(() => notepad("button: Save")));
    expect(await run("click_element", { label: "Save", why: "w" })).toContain("No change seen");
    expect(states).toEqual([]);
    states.push(notepad("a"), notepad("b"));
    const batch = await run("act_batch", { steps: [{ tool: "type_text", args: { text: "x" } }] });
    expect(batch).not.toContain("Now:");
    expect(states).toHaveLength(2);
    states.length = 0;
    // A checkbox pressed by its pattern: the keyboard stays put, which is not "nothing happened".
    const pressing = buildBatonTools({
      ...host([]),
      focusState: read,
      clickElement: async () =>
        "Pressed Word wrap (toggle, no pointer, no focus change); it now reads [checked].",
    });
    states.push(...[1, 2, 3].map(() => notepad("document: Text")));
    const pressed = pressing.find((t) => t.name === "click_element")!.run({ id: 4, why: "w" });
    await vi.runAllTimersAsync();
    const said = (await pressed).text;
    expect(said).toContain("[checked]");
    expect(said).toContain("a press does not move the keyboard");
    expect(said).not.toContain("No change seen");
  });

  describe("act_batch", () => {
    const batch = (log: string[], windows?: string[]) =>
      new Map(buildBatonTools(host(log, windows)).map((t) => [t.name, t])).get("act_batch")!;
    const click = (label: string) => ({ tool: "click_element", args: { label, why: "w" } });

    it("runs the steps in order and ends with the window's controls", async () => {
      const log: string[] = [];
      const out = await batch(log).run({
        steps: [click("Help"), { tool: "type_text", args: { text: "hi", why: "w" } }],
      });
      expect(log).toEqual(["element Help", "type hi"]);
      expect(out.text).toContain("Button: Save");
    });

    it("stops when the window with the keyboard changes, and says so", async () => {
      const log: string[] = [];
      // start, then the check before step 2 sees another window
      const out = await batch(log, ["w1", "w2"]).run({ steps: [click("Save"), click("Ok")] });
      expect(log).toEqual(["element Save"]);
      expect(out.text).toContain("Stopped before step 2");
    });

    it("stops at the first failure and treats a wait_for timeout as one", async () => {
      const log: string[] = [];
      const tools = buildBatonTools({
        ...host(log),
        waitFor: async () => 'No control named "X" appeared in 3 seconds.',
      });
      const run = tools.find((t) => t.name === "act_batch")!.run;
      const out = await run({
        steps: [{ tool: "wait_for", args: { label: "X", seconds: 3 } }, click("Never")],
      });
      expect(out.text).toContain("FAILED");
      expect(log).toEqual([]);
    });

    it("refuses a step that is not batchable and is absent without window tracking", async () => {
      await expect(batch([]).run({ steps: [{ tool: "drag", args: {} }] })).rejects.toThrow(
        "steps must be",
      );
      const { windowKey: _omit, ...bare } = host([]);
      expect(buildBatonTools(bare).some((t) => t.name === "act_batch")).toBe(false);
    });
  });
});
