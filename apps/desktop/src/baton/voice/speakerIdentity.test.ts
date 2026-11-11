import { describe, expect, it } from "vite-plus/test";

import { CAMPLUS_POLICY, type SpeakerProfile } from "@t3tools/baton-voice";

import { createSpeakerIdentity } from "./speakerIdentity.ts";
import { VOICE_ID_DEFAULTS, type VoiceIdSettings } from "./voiceIdRows.ts";

const v = (...xs: number[]) => Float32Array.from(xs);
const at = (c: number) => v(c, Math.sqrt(1 - c * c), 0);
const owner: SpeakerProfile = {
  id: "owner",
  name: "You",
  kind: "owner",
  model: "m",
  centroid: v(1, 0, 0),
  samples: 10,
  sources: ["spoken"],
  enrolledAt: "2026-11-08T00:00:00Z",
};

const setup = (over: Partial<VoiceIdSettings> = {}, vector = at(0.8)) => {
  let profiles: ReadonlyArray<SpeakerProfile> = [owner];
  let clock = 1_000;
  let settings: VoiceIdSettings = { ...VOICE_ID_DEFAULTS, on: true, ...over };
  const service = createSpeakerIdentity({
    voiceId: {
      embedder: () =>
        settings.on ? { model: "m", embed: async () => vector, close: () => {} } : null,
      profiles: () => profiles,
      save: (p) => (profiles = [p]),
    },
    settings: () => settings,
    policy: { ...CAMPLUS_POLICY, model: "m" },
    now: () => clock,
  });
  const seconds = (s: number) => new Int16Array(s * 16_000);
  return {
    service,
    seconds,
    profiles: () => profiles,
    later: (ms: number) => (clock += ms),
    set: (next: Partial<VoiceIdSettings>) => (settings = { ...settings, ...next }),
  };
};

describe("the speaker identity service", () => {
  it("verifies him on a long clip, and a short follow-up inherits him unverified, for a while", async () => {
    const t = setup();
    expect(await t.service.hear(t.seconds(4), "turn")).toMatchObject({
      kind: "owner",
      personId: "owner",
      verified: true,
      inherited: false,
    });
    t.later(5_000);
    expect(await t.service.hear(t.seconds(1), "turn")).toMatchObject({
      kind: "owner",
      verified: false,
      inherited: true,
    });
    expect(t.service.current()).toMatchObject({ inherited: true });
    t.later(20_000);
    expect((await t.service.hear(t.seconds(1), "turn")).kind).toBe("unverified");
  });

  it("never inherits for a cut-in, and forgets the last voice on another microphone", async () => {
    const t = setup();
    await t.service.hear(t.seconds(4), "turn");
    expect((await t.service.hear(t.seconds(1), "barge")).kind).toBe("unverified");
    t.service.reset();
    expect((await t.service.hear(t.seconds(1), "turn")).kind).toBe("unverified");
  });

  it("with Voice ID off, decides nothing: everyone is unverified and nobody is kept out", async () => {
    const t = setup({ on: false, strictWhenUnavailable: true });
    const who = await t.service.hear(t.seconds(4), "turn");
    expect(who.kind).toBe("unverified");
    expect(t.service.admits(who, "turn")).toBe(true);
    expect(t.service.bargeMs()).toBeNull();
    expect(t.service.running()).toBe(false);
  });

  it("keeps a guest out by default, and judges cut-ins only while it runs", async () => {
    const t = setup({}, at(0.05));
    const guest = await t.service.hear(t.seconds(4), "turn");
    expect(guest.kind).toBe("guest");
    expect(t.service.admits(guest, "turn")).toBe(false);
    expect(t.service.bargeMs()).toBe(CAMPLUS_POLICY.minSpeechMs);
    t.set({ respondToOthers: true });
    expect(t.service.admits(guest, "turn")).toBe(true);
  });

  it("follows his voice from a confident turn only when adaptation is on", async () => {
    const off = setup({ adapt: false });
    await off.service.hear(off.seconds(4), "turn");
    expect(off.profiles()[0]!.sources).toEqual(["spoken"]);
    const on = setup();
    await on.service.hear(on.seconds(4), "turn");
    expect(on.profiles()[0]!.sources).toEqual(["spoken", "adapted"]);
  });
});
