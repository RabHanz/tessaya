import { describe, expect, it } from "vite-plus/test";

import { dictationStep, type DictationNow } from "./dictationEntry.ts";

const idle: DictationNow = { voice: false, keyRecording: false, heldByButton: false, ready: true };

describe("one dictation, whichever key, button or word moves it", () => {
  it.each([
    // [what he did, the state, what happens]
    ["toggle", idle, "helper_toggle"],
    // The second press of the hands-free key ends his own recording: the helper decides, as it always has.
    ["toggle", { ...idle, keyRecording: true }, "helper_toggle"],
    // During "Tessaya, dictate" the press is that dictation's ✓, never a second recording beside it.
    ["toggle", { ...idle, voice: true }, "voice_insert"],
    ["toggle", { ...idle, ready: false }, "fetch_model"],
    ["hold_down", idle, "helper_start"],
    ["hold_down", { ...idle, voice: true }, "voice_insert"],
    ["hold_down", { ...idle, keyRecording: true }, "none"],
    // A button's release ends only the recording that button started.
    ["hold_up", { ...idle, keyRecording: true, heldByButton: true }, "helper_finish"],
    ["hold_up", { ...idle, keyRecording: true }, "none"],
    ["stop_tool", { ...idle, keyRecording: true }, "helper_finish"],
    ["stop_tool", { ...idle, voice: true }, "voice_insert"],
    ["stop_tool", idle, "none"],
    // A click on the pill never leaves the mic recording.
    ["pill_click", { ...idle, keyRecording: true }, "helper_finish"],
    ["pill_click", { ...idle, voice: true }, "none"],
  ] as const)("%s while %o: %s", (entry, now, step) => {
    expect(dictationStep(entry, now)).toBe(step);
  });
});
