import { describe, expect, it } from "vite-plus/test";

import { buildTessayaTools, type ToolHost } from "../agent/tessayaTools.ts";
import { helpControls, TROUBLE, undocumented } from "./helpRows.ts";

describe("help page", () => {
  it("has an example for every tool the assistant really has, or says it is internal", () => {
    const names = buildTessayaTools({} as ToolHost).map((t) => t.name);
    expect(undocumented(names)).toEqual([]);
  });

  it("lists what to try for each failing check, and says when nothing is wrong", () => {
    const rows = helpControls({
      tools: ["needs_me"],
      bindings: [{ label: "Hold to dictate", keys: "F9" }],
      checks: [{ id: "mic", title: "Microphone", status: "bad", detail: "No microphone found." }],
    });
    expect(rows.find((r) => r.id === "help.say:needs_me")?.label).toBe('"What needs me?"');
    const t = rows.find((r) => r.id === "help.trouble:mic");
    expect(t?.kind === "check" && t.detail).toContain(TROUBLE["mic"]!);
    const none = helpControls({
      tools: [],
      bindings: [],
      checks: [{ id: "mic", title: "Mic", status: "ok", detail: "" }],
    });
    expect(none.some((r) => r.id === "help.trouble:none")).toBe(true);
  });
});
