import type { DesktopVoiceSettings } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HomeControl } from "../home/batonHome.ts";
import { createRemoteSettings, voiceControls } from "./remoteSettings.ts";

const saved: DesktopVoiceSettings = {
  dictationCleanup: "local",
  pillStyle: "pill",
  pillDesign: "tessaya",
  pillWaveform: "match",
  showWords: true,
  holdKey: "Ctrl+Shift+Win",
  holdKeyCues: false,
  frosted: false,
  doubleTap: true,
  learnWords: true,
  duckWhileDictating: "off",
  recognizeOnServers: false,
  gpuRecognition: "auto",
  openTessayaOnStart: false,
  openSessionsOnStart: true,
  devicesMayLook: false,
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
      patch: {
        dictationCleanup: "claude",
        pillDesign: "quiet",
        pillWaveform: "beads",
        holdKey: "F9",
        showWords: false,
        openTessayaOnStart: true,
        openSessionsOnStart: false,
      },
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
        if (id === "v.pillDesign") settings = { ...settings, pillDesign: "quiet" };
        if (id === "v.pillWaveform") settings = { ...settings, pillWaveform: "beads" };
        if (id === "v.startSessions") settings = { ...settings, openSessionsOnStart: false };
      },
    });
    expect(await remote.tick()).toBe(true);
    expect(clicked).toEqual([
      ["v.cleanup", "claude"],
      ["v.pillDesign", "quiet"],
      ["v.pillWaveform", "beads"],
      ["v.showWords", false],
      ["setup.hold", "F9"],
      ["v.startHome", true],
      ["v.startSessions", false],
    ]);
    // The second report is after the change, names its version, and carries nothing outside the list.
    expect(sent[1]).toEqual({
      effective: {
        ...saved,
        dictationCleanup: "claude",
        pillDesign: "quiet",
        pillWaveform: "beads",
        showWords: false,
        openSessionsOnStart: false,
      },
      applied: 7,
    });
    // The same change again, or an answer that is not one, changes nothing.
    expect(await remote.tick()).toBe(false);
    change = { version: 8, patch: { dictationCleanup: "always" } };
    expect(await remote.tick()).toBe(false);
    change = { version: 9, patch: { pillDesign: "neon" } };
    expect(await remote.tick()).toBe(false);
    expect(clicked).toHaveLength(7);
  });

  it("publishes every Settings toggle and choice for voice once, with its class, and sets one as his click (13 Nov)", async () => {
    const controls: ReadonlyArray<HomeControl> = [
      {
        id: "v.conversation",
        section: "Listening",
        label: "Keep listening",
        kind: "toggle",
        on: true,
      },
      {
        id: "v.rateChoice",
        section: "Voice",
        label: "How fast she speaks",
        kind: "choice",
        value: "normal",
        options: [
          { value: "slower", label: "Slower" },
          { value: "normal", label: "Normal" },
        ],
        tab: "voice",
      },
      { id: "rs.share", section: "Memory", label: "Share memory", kind: "toggle", on: false },
      // A setting already typed, and something that is not a setting, stay out.
      { id: "v.showWords", section: "Dictation", label: "Show words", kind: "toggle", on: true },
      { id: "n:thread-1", section: "Sessions", label: "A session", kind: "action", button: "Open" },
    ];
    expect(voiceControls(controls).map((c) => [c.id, c.voice])).toEqual([
      ["v.conversation", "free"],
      ["v.rateChoice", "free"],
      ["rs.share", "owner"],
    ]);
    const sent: Array<{ controls?: unknown }> = [];
    const clicked: Array<readonly [string, string | boolean]> = [];
    let change: unknown = null;
    const remote = createRemoteSettings({
      sync: async (body) => (sent.push(body), { change }),
      current: () => saved,
      apply: (id, value) => void clicked.push([id, value]),
      controls: () => controls,
      now: () => 0,
    });
    await remote.tick();
    await remote.tick();
    expect(sent.map((b) => b.controls !== undefined)).toEqual([true, false]);
    change = { version: 3, patch: {}, controls: [{ id: "v.rateChoice", value: "slower" }] };
    expect(await remote.tick()).toBe(true);
    expect(clicked).toEqual([["v.rateChoice", "slower"]]);
  });
});
