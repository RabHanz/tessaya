import { describe, expect, it } from "vite-plus/test";

import { claudeAccountInstances } from "./ClaudeAccountInstances.ts";

describe("which instances run on which slot", () => {
  it("reads the setting, and nothing else", () => {
    expect(claudeAccountInstances('{"claudeAgent_work":"2"}')).toEqual({ claudeAgent_work: "2" });
    expect(claudeAccountInstances(undefined)).toEqual({});
    expect(claudeAccountInstances("not json")).toEqual({});
  });
});
