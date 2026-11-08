import { describe, expect, it } from "vite-plus/test";

import {
  MAX_PER_ACTION,
  addInput,
  checkInput,
  effective,
  normaliseAccelerator,
  parseBindings,
  removeInput,
  toElectronAccelerator,
  withBinding,
  type BindingInput,
} from "./bindings.ts";

const key = (accelerator: string): BindingInput => ({ type: "key", accelerator });
const mouse = (button: "middle" | "back" | "forward" | "left+right"): BindingInput => ({
  type: "mouse",
  button,
});

describe("bindings", () => {
  it("spells a chord one way, whatever the order or the names", () => {
    expect(normaliseAccelerator("Control+shift+space")).toBe("Ctrl+Shift+Space");
    expect(normaliseAccelerator("Alt+Win+x")).toBe("Alt+Meta+X");
    expect(toElectronAccelerator("Ctrl+Alt+Space")).toBe("Control+Alt+Space");
  });

  it("starts with the defaults, and a cleared row is off on purpose", () => {
    const rows = effective([]);
    expect(rows.find((r) => r.def.id === "mute")!.inputs).toEqual([key("Ctrl+Alt+Shift+F7")]);
    expect(rows.find((r) => r.def.id === "stop")!.inputs).toEqual([]);
    const off = effective(withBinding([], "mute", []));
    expect(off.find((r) => r.def.id === "mute")).toMatchObject({ inputs: [], isDefault: false });
  });

  it("names who else has the same key or button, per input and in all", () => {
    const rows = effective([
      { action: "stop", inputs: [key("shift+ctrl+alt+f7")] },
      { action: "clear", inputs: [mouse("middle"), key("Ctrl+Alt+K")] },
      { action: "ask", inputs: [mouse("middle")] },
    ]);
    const mute = rows.find((r) => r.def.id === "mute")!;
    expect(mute.conflictsWith).toEqual(["Stop"]);
    expect(mute.conflicts).toEqual([{ input: key("Ctrl+Alt+Shift+F7"), with: ["Stop"] }]);
    const clear = rows.find((r) => r.def.id === "clear")!;
    expect(clear.conflicts).toEqual([{ input: mouse("middle"), with: ["Ask Tessaya"] }]);
    expect(rows.find((r) => r.def.id === "wake")!.conflictsWith).toEqual([]);
  });

  it("reads old files (one input) and new ones (a list) without trusting them", () => {
    const parsed = parseBindings([
      { action: "mute", input: key("control+m") },
      { action: "bogus", input: null },
      { action: "ask", input: { type: "mouse", button: "wheel" } },
      { action: "stop", input: null },
      {
        action: "wake",
        inputs: [
          key("f9"),
          key("F9"),
          mouse("middle"),
          { type: "x" },
          key("a"),
          key("b"),
          key("c"),
        ],
      },
    ]);
    expect(parsed).toEqual([
      { action: "mute", inputs: [key("Ctrl+M")] },
      { action: "stop", inputs: [] },
      { action: "wake", inputs: [key("F9"), mouse("middle"), key("A"), key("B")] },
    ]);
    expect(withBinding(parsed, "mute", "reset").map((b) => b.action)).toEqual(["stop", "wake"]);
  });

  it("lets the dictation keys come from their own settings", () => {
    const rows = effective([], { hold: key("Ctrl+Alt+H") });
    expect(rows.find((r) => r.def.id === "hold")!.inputs).toEqual([key("Ctrl+Alt+H")]);
  });
});

describe("more than one way to do an action", () => {
  const current = [key("Ctrl+Alt+Shift+F7")];

  it("adds another, up to four, never the same twice, and removes one by place", () => {
    let saved = [] as ReturnType<typeof withBinding>;
    let list: ReadonlyArray<BindingInput> = current;
    for (const next of [key("Ctrl+Alt+M"), mouse("middle"), key("F9")]) {
      const change = addInput(saved, "mute", list, next);
      if ("error" in change) throw new Error(change.error);
      saved = change.saved;
      list = saved.find((b) => b.action === "mute")!.inputs;
    }
    expect(list).toHaveLength(MAX_PER_ACTION);
    expect(addInput(saved, "mute", list, key("Ctrl+Alt+N"))).toEqual({
      error: "Four is the most for one action. Remove one first.",
    });
    expect(addInput(saved, "mute", list, key("f9"))).toEqual({
      error: "That one is already set here.",
    });
    expect(removeInput(saved, "mute", list, 1).find((b) => b.action === "mute")!.inputs).toEqual([
      key("Ctrl+Alt+Shift+F7"),
      mouse("middle"),
      key("F9"),
    ]);
  });

  it("refuses what would get in his way, with the reason in plain words", () => {
    expect(checkInput(key("a"))).toEqual({
      ok: false,
      reason: "Add Ctrl, Alt, Shift or Win so it does not get in the way of typing.",
    });
    expect(checkInput(key("Ctrl+Alt"))).toMatchObject({ ok: false });
    expect(checkInput(key("Ctrl+Alt+Shift+Z"))).toEqual({
      ok: false,
      reason: "Use at most 3 keys together.",
    });
    expect(checkInput(key("Ctrl+Alt+Delete"))).toMatchObject({
      ok: false,
      reason: "Windows keeps Ctrl+Alt+Delete for itself.",
    });
    expect(checkInput(key("alt+f4"))).toMatchObject({ ok: false });
    // A mouse button remapped to F13 to F24 in its own software binds alone; Win+D, which Windows keeps, steers there.
    expect(checkInput(key("F13"))).toEqual({ ok: true });
    expect(checkInput(key("F24"))).toEqual({ ok: true });
    expect(checkInput(key("Win+D"))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("F13"),
    });
    expect(checkInput(key("Ctrl+C"))).toMatchObject({ ok: false });
    for (const fine of [
      key("F9"),
      key("Pause"),
      key("ScrollLock"),
      key("Ctrl+Shift+K"),
      mouse("back"),
      mouse("left+right"),
    ]) {
      expect(checkInput(fine)).toEqual({ ok: true });
    }
  });
});
