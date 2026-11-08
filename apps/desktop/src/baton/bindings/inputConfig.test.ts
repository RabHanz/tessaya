import { parseInputBindings } from "@t3tools/baton-shared/inputBindings";
import { describe, expect, it } from "vite-plus/test";

import { ACTIONS } from "./bindings.ts";
import { mouseHookConfig } from "./inputConfig.ts";

describe("what the mouse hook is told", () => {
  it("lists only the mouse bindings, in the hook's schema, and nothing for an unbound button", () => {
    const config = mouseHookConfig([
      {
        def: { id: "wake" },
        inputs: [
          { type: "mouse", button: "middle" },
          { type: "mouse", button: "forward" },
        ],
      },
      { def: { id: "ask" }, inputs: [{ type: "mouse", button: "left+right" }] },
      { def: { id: "mute" }, inputs: [{ type: "key", accelerator: "Ctrl+Alt+M" }] },
      { def: { id: "stop" }, inputs: [] },
      { def: { id: "clear" }, inputs: [{ type: "mouse", button: "back" }] },
    ]);
    expect(config.bindings).toEqual([
      { id: "wake", action: "listen_start", trigger: { kind: "button", button: "middle" } },
      { id: "wake", action: "listen_start", trigger: { kind: "button", button: "x2" } },
      { id: "ask", action: "ask", trigger: { kind: "chord", buttons: ["left", "right"] } },
      { id: "clear", action: "clear_screen", trigger: { kind: "button", button: "x1" } },
    ]);
    expect(parseInputBindings(JSON.parse(JSON.stringify(config))).bindings).toHaveLength(4);
    expect(mouseHookConfig([]).bindings).toEqual([]);
  });
  it("maps every action a mouse button can be given, so the middle button can start dictation (0.1.79)", () => {
    const config = mouseHookConfig(
      ACTIONS.map((def) => ({ def, inputs: [{ type: "mouse", button: "middle" } as const] })),
    );
    // Every row of the Keyboard and mouse page reaches the hook: none saves and then does nothing.
    expect(config.bindings.map((b) => b.id)).toEqual(ACTIONS.map((def) => def.id));
    expect(config.bindings.find((b) => b.id === "toggle")?.action).toBe("dictate_toggle");
    expect(config.bindings.find((b) => b.id === "hold")?.action).toBe("dictate_hold");
    // Each one is an action the hook's schema accepts (one button keeps one action, so they are checked apart).
    for (const binding of config.bindings)
      expect(parseInputBindings({ ...config, bindings: [binding] }).bindings).toEqual([binding]);
  });
});
