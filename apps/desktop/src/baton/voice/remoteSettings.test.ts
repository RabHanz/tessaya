import type { DesktopVoiceSettings } from "@t3tools/baton-contracts";
import { describe, expect, it } from "vite-plus/test";

import { createRemoteSettings } from "./remoteSettings.ts";

const saved: DesktopVoiceSettings = {
  dictationCleanup: "local",
  pillStyle: "pill",
  showWords: true,
  holdKey: "Ctrl+Shift+Win",
  holdKeyCues: false,
  frosted: false,
  doubleTap: true,
  learnWords: true,
  duckWhileDictating: "off",
  recognizeOnServers: false,
  gpuRecognition: "auto",
};

describe("createRemoteSettings", () => {
  it("applies a change through his Settings controls once, then reports what it runs with", async () => {
    let settings: DesktopVoiceSettings & { readonly claudeBinary: string } = {
      ...saved,
      claudeBinary: "C:/secret/claude.exe",
    };
    const sent: Array<{ effective: unknown; applied: number }> = [];
    const clicked: Array<readonly [string, string | boolean]> = [];
    let change: unknown = {
      version: 7,
      patch: { dictationCleanup: "claude", holdKey: "F9", showWords: false },
    };
    const remote = createRemoteSettings({
      sync: async (body) => {
        sent.push(body);
        return { change };
      },
      current: () => settings,
      apply: (id, value) => {
        clicked.push([id, value]);
        if (id === "v.cleanup") settings = { ...settings, dictationCleanup: "claude" };
        if (id === "v.showWords") settings = { ...settings, showWords: false };
      },
    });
    expect(await remote.tick()).toBe(true);
    expect(clicked).toEqual([
      ["v.cleanup", "claude"],
      ["v.showWords", false],
      ["setup.hold", "F9"],
    ]);
    // The second report is after the change, names its version, and carries nothing outside the list.
    expect(sent[1]).toEqual({
      effective: { ...saved, dictationCleanup: "claude", showWords: false },
      applied: 7,
    });
    // The same change again, or an answer that is not one, changes nothing.
    expect(await remote.tick()).toBe(false);
    change = { version: 8, patch: { dictationCleanup: "always" } };
    expect(await remote.tick()).toBe(false);
    expect(clicked).toHaveLength(3);
  });
});
