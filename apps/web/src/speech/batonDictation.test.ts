import { describe, expect, it, vi } from "vite-plus/test";

import { withTessayaDictation } from "./batonDictation";

describe("T3's microphones on a desktop where Tessaya's voice runs", () => {
  const speech = {
    available: false,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(),
  };
  it("dictate through Tessaya, with no T3 setup or consent step first", async () => {
    const dictation = { start: vi.fn(), stop: vi.fn(), openSettings: vi.fn() };
    const routed = withTessayaDictation(speech, dictation);
    expect(routed.available).toBe(true);
    await routed.start();
    await routed.stop();
    routed.cancel();
    expect(dictation.start).toHaveBeenCalledTimes(1);
    expect(dictation.stop).toHaveBeenCalledTimes(2);
    expect(speech.start).not.toHaveBeenCalled();
  });
  it("stay T3's own elsewhere (web, mobile, a desktop without Tessaya's voice)", () => {
    expect(withTessayaDictation(speech, undefined)).toBe(speech);
  });
});
