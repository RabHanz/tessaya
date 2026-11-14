import { BatonDesktopState } from "@t3tools/tessaya-contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { desktopState, type DesktopStateInput } from "./desktopState.ts";

const decodeState = Schema.decodeUnknownOption(BatonDesktopState);
const secrets = [
  "sk-live-abc123",
  "/home/ann/.local/bin/claude",
  "ann@example.com",
  "vault-github",
];

/** His real settings objects carry much more than the snapshot names: keys, paths, his account. */
const input = {
  screen: {
    output: "spoken",
    captureApproval: "ask",
    actWithoutAsking: false,
    socialOn: true,
    browserChrome: false,
    remoteHands: false,
    assistantModel: "auto",
    assistantEffort: "auto",
    voice: "anna",
    claudeBinary: secrets[1],
    assistantAccount: secrets[2],
  },
  voice: {
    enabled: true,
    recognition: "cloud",
    cloudProvider: "openai",
    cloudModel: null,
    cloudApiKey: secrets[0],
    languages: ["en"],
    wakeWords: [
      { word: "freya", enabled: true, threshold: 0.5 },
      { word: "off", enabled: false, threshold: 0.5 },
    ],
    dictationCleanup: "claude",
  },
  personas: [
    { id: "executive", name: "Tessaya", role: "The lead.", lead: true, prompt: secrets[3] },
  ],
  skills: [{ slug: "rename-files", verified: true, body: secrets[3] }],
  appVersion: "1.2.3",
  brain: "claude-opus-5-5",
  voiceEngine: "kokoro",
  environments: [{ label: "Laptop", state: "connected" }],
  errors: [{ code: "timeout", at: "2026-11-07T10:00:00.000Z" }],
} as unknown as DesktopStateInput;

describe("the desktop's account of itself", () => {
  it("carries only the named fields: no key, path, account, prompt or skill text", () => {
    const state = desktopState(input);
    const text = JSON.stringify(state);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(state.voice.wakeWords).toEqual(["freya"]);
    expect(state.diagnostics.recognition).toBe("cloud");
    // What the desktop sends always decodes on the server.
    expect(decodeState(state)._tag).toBe("Some");
  });

  it("cuts every section to its cap", () => {
    const state = desktopState({
      ...input,
      personas: Array.from({ length: 50 }, (_, i) => ({
        id: `p${i}`,
        name: "x".repeat(500),
        role: "y".repeat(500),
        lead: false,
      })),
      skills: Array.from({ length: 300 }, (_, i) => ({ slug: `s${i}`, verified: false })),
    });
    expect(state.personas).toHaveLength(30);
    expect(state.personas[0]!.name).toHaveLength(80);
    expect(state.personas[0]!.role).toHaveLength(200);
    expect(state.skills).toHaveLength(100);
    expect(decodeState(state)._tag).toBe("Some");
  });
});
