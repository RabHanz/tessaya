// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import { actionSentence, parseLogEntries, todayStats } from "./activityLog.ts";

const at = (day: string, time: string) => new Date(`${day}T${time}`).toISOString();
const lines = [
  { at: at("2026-10-31", "09:00:00"), kind: "turn", transcript: "yesterday" },
  { at: at("2026-11-01", "09:00:00"), kind: "turn", transcript: "what is VantageOS doing" },
  { at: at("2026-11-01", "09:05:00"), kind: "dictated", chars: 120 },
  { at: at("2026-11-01", "09:06:00"), kind: "nothing_heard" },
  { at: at("2026-11-01", "09:07:00"), kind: "stop", text: "stop" },
  {
    at: at("2026-11-01", "09:08:00"),
    kind: "action",
    tool: "mcp__baton__needs_me",
    action: "mcp__baton__needs_me",
    outcome: "allowed",
  },
  {
    at: at("2026-11-01", "09:09:00"),
    kind: "action",
    tool: "mcp__baton__wait",
    outcome: "allowed",
  },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

describe("what Tessaya did, in plain words", () => {
  it.each([
    ["mcp__baton__needs_me", "mcp__baton__needs_me", "assistant", "Asked you to look at a session"],
    ["mcp__tessaya__needs_me", "", "assistant", "Asked you to look at a session"],
    ["mcp__baton__window_focus", "Chrome", "command", "Focused Chrome"],
    ["mcp__baton__window_focus", "mcp__baton__window_focus", "command", "Brought a window forward"],
    ["mcp__baton__type_text", "my secret words", "assistant", "Typed for you"],
    ["mcp__baton__job_refine", "", "assistant", "Updated a job"],
    ["mcp__baton__cloud_dispatch", "", "assistant", "Worked with a cloud machine"],
    ["mcp__baton__brand_new_tool", "", "assistant", "Did something for you"],
    ["mcp__claude-in-chrome__navigate", "https://x.test", "assistant", "Opened a page in Chrome"],
    ["mcp__someone__thing", "", "assistant", "Did something for you"],
    ["Bash", "rm -rf build", "assistant", "Ran a command"],
  ])("%s (%s) reads as a sentence", (tool, action, kind, text) => {
    const said = actionSentence({ tool, action, outcome: "allowed" });
    expect(said).toMatchObject({ kind, text });
    expect(`${said?.text} ${said?.detail ?? ""}`).not.toMatch(/mcp__|_/);
  });
  it("says when he refused or was refused", () => {
    expect(actionSentence({ tool: "mcp__baton__click", outcome: "he said no" })?.detail).toBe(
      "You said no, so it did not",
    );
    expect(actionSentence({ tool: "Bash", outcome: "refused" })?.detail).toBe(
      "Not allowed, so it did not",
    );
  });
  it("lists commands and actions newest first, leaving out waits, dictations and turns History already holds", () => {
    const items = parseLogEntries(`${lines}\nnot json\n`);
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ["assistant", "Asked you to look at a session"],
      ["command", "Stopped: you said stop"],
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });
  it("counts today's turns and dictations only", () => {
    expect(todayStats(lines, new Date("2026-11-01T12:00:00"))).toEqual({ turns: 1, dictations: 1 });
  });
});
