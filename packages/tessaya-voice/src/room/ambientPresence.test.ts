import { describe, expect, it } from "vite-plus/test";

import type { SpeakerIdentity } from "../speaker.ts";
import {
  AMBIENT_EVERY_MS,
  AMBIENT_OFF_MS,
  createAmbientPresence,
  type AmbientPresenceDeps,
} from "./ambientPresence.ts";
import type { TurnVoices } from "./segments.ts";

const who = (
  kind: SpeakerIdentity["kind"],
  personId: string | null,
  verified = true,
): SpeakerIdentity => ({
  kind,
  personId,
  name: null,
  confidence: 0.8,
  verified,
  inherited: false,
  at: 0,
});
/** Two seconds of speech at about -20 dBFS. */
const speech = (seconds = 2) => new Int16Array(16_000 * seconds).fill(3_000);

const setup = (over: Partial<AmbientPresenceDeps> = {}) => {
  const sent: Array<[string, ReadonlyArray<{ readonly member: string | null }>]> = [];
  let now = 1_000_000;
  let checks = 0;
  const ambient = createAmbientPresence({
    voices: async () => {
      checks += 1;
      return { kind: "one" } satisfies TurnVoices;
    },
    speaker: async () => who("owner", "owner"),
    herVoiceAt: () => null,
    send: async (id, voices) => {
      sent.push([id, voices]);
      return true;
    },
    now: () => now,
    log: () => undefined,
    ...over,
  });
  return {
    ambient,
    sent,
    checks: () => checks,
    later: (ms: number) => void (now += ms),
    at: () => now,
  };
};

describe("ambient presence (M-123)", () => {
  it("one voice it is sure of places that member; one it isn't is only someone", async () => {
    const t = setup();
    await t.ambient.segment("t1", speech());
    expect(t.sent).toEqual([["t1", [{ member: "owner" }]]]);
    const unsure = setup({ speaker: async () => who("owner", "owner", false) });
    await unsure.ambient.segment("t1", speech());
    expect(unsure.sent).toEqual([["t1", [{ member: null }]]]);
  });

  it("two known voices place both; a known voice beside an unknown one places him and someone", async () => {
    const spans = (ids: ReadonlyArray<SpeakerIdentity>): TurnVoices => ({
      kind: "many",
      spans: ids.map((identity, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, identity })),
    });
    const two = setup({ voices: async () => spans([who("owner", "owner"), who("saved", "sara")]) });
    await two.ambient.segment("t1", speech(3));
    expect(two.sent[0]![1]).toEqual([{ member: "owner" }, { member: "sara" }]);
    const guest = setup({ voices: async () => spans([who("owner", "owner"), who("guest", null)]) });
    await guest.ambient.segment("t1", speech(3));
    expect(guest.sent[0]![1]).toEqual([{ member: "owner" }, { member: null }]);
  });

  it("never checks her own last words, a short or quiet segment, or the same Tessel again too soon", async () => {
    const t = setup({ herVoiceAt: () => 1_000_000 - 2_500 });
    await t.ambient.segment("t1", speech());
    expect(t.checks()).toBe(0);
    const u = setup();
    await u.ambient.segment("t1", speech(1));
    await u.ambient.segment("t1", new Int16Array(32_000).fill(20));
    expect(u.checks()).toBe(0);
    await u.ambient.segment("t1", speech());
    await u.ambient.segment("t1", speech());
    expect(u.checks()).toBe(1);
    u.later(AMBIENT_EVERY_MS);
    await u.ambient.segment("t1", speech());
    expect(u.checks()).toBe(2);
  });

  it("stops asking for a while once the owner has turned it off", async () => {
    const t = setup({ send: async () => false });
    await t.ambient.segment("t1", speech());
    t.later(AMBIENT_EVERY_MS);
    await t.ambient.segment("t1", speech());
    expect(t.checks()).toBe(1);
    t.later(AMBIENT_OFF_MS);
    await t.ambient.segment("t1", speech());
    expect(t.checks()).toBe(2);
  });
});
