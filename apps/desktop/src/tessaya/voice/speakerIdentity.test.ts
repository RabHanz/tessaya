import { describe, expect, it } from "vite-plus/test";

import { CAMPLUS_POLICY, type SpeakerProfile } from "@t3tools/tessaya-voice";

import { createSpeakerIdentity, pillWho } from "./speakerIdentity.ts";
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

  it("judges a cut-in at the listen cut-off and a turn at the stricter steer one", async () => {
    const { listen, steer } = CAMPLUS_POLICY.single;
    const t = setup({}, at((listen + steer) / 2));
    expect((await t.service.hear(t.seconds(2), "barge")).kind).toBe("owner");
    expect((await t.service.hear(t.seconds(2), "turn")).kind).toBe("guest");
  });

  it("follows his voice from a confident turn only when adaptation is on", async () => {
    const off = setup({ adapt: false });
    await off.service.hear(off.seconds(4), "turn");
    expect(off.profiles()[0]!.sources).toEqual(["spoken"]);
    const on = setup();
    await on.service.hear(on.seconds(4), "turn");
    expect(on.profiles()[0]!.sources).toEqual(["spoken", "adapted"]);
  });

  it("keeps the session's recognition for the pill: their initial once verified, nothing unsure or after it goes quiet", async () => {
    const t = setup();
    const names = (m: string) => (m === "owner" ? "rab" : null);
    expect(pillWho(t.service.session(), names)).toBeNull();
    await t.service.hear(t.seconds(1), "turn");
    expect(pillWho(t.service.session(), names)).toBeNull();
    await t.service.hear(t.seconds(4), "turn");
    expect(pillWho(t.service.session(), names)).toBe("R");
    // The seeded owner row and the desktop's "You" are no name: a plain person.
    expect(pillWho(t.service.session(), () => "Owner")).toBe("");
    expect(pillWho(t.service.session(), () => null)).toBe("");
    expect(pillWho(t.service.session(), () => "ثمینہ")).toBe("ث");
    t.later(10 * 60_000 + 1);
    expect(pillWho(t.service.session(), names)).toBeNull();
    t.later(-(10 * 60_000 + 1));
    t.service.reset();
    expect(t.service.session()).toBeNull();
  });

  it("asks once when an act needs him and it can't tell, explains the first time, and not at all once verified", async () => {
    const t = setup({}, at(0.4));
    await t.service.hear(t.seconds(2), "turn");
    expect(t.service.stepUp("Rab")).toEqual({ kind: "confirm", name: "Rab", explain: true });
    expect(t.service.stepUp("Rab")).toMatchObject({ kind: "confirm", explain: false });
    // Nobody heard yet and no name: a tap instead.
    t.service.reset();
    expect(t.service.stepUp(null)).toEqual({ kind: "phone", explain: true });
    const sure = setup();
    await sure.service.hear(sure.seconds(4), "turn");
    expect(sure.service.stepUp("Rab")).toEqual({ kind: "none" });
  });
});
