import { describe, expect, it } from "vite-plus/test";

import { accumulate, cueOf, NEW_SESSION, SESSION_IDLE_MS, stepUpFor } from "./recognition.ts";
import type { SpeakerIdentity } from "./speaker.ts";

const said = (over: Partial<SpeakerIdentity>): SpeakerIdentity => ({
  kind: "owner",
  personId: "owner",
  name: "Maya",
  confidence: 0.5,
  verified: false,
  inherited: false,
  at: 0,
  ...over,
});
const fixed = () => 0;

describe("recognition across a session", () => {
  it("builds from several shorter turns of the same voice, and stays theirs once verified", () => {
    let s = accumulate(null, said({}), 2_000, 0);
    expect(s.verified).toBe(false);
    s = accumulate(s, said({}), 2_000, 1_000);
    expect([s.member, s.verified]).toEqual(["owner", true]);
    // A short "yes" too brief to judge keeps the session as it is.
    s = accumulate(s, said({ kind: "unverified", personId: null, confidence: null }), 600, 2_000);
    expect(s.verified).toBe(true);
  });

  it("drops it on a different voice, a guest, a poor match or a long silence, and lends nobody another's", () => {
    const him = accumulate(null, said({ verified: true }), 4_000, 0);
    const sara = accumulate(him, said({ kind: "saved", personId: "sara", name: "Sara" }), 2_000, 1);
    expect([sara.member, sara.verified, sara.evidenceMs]).toEqual(["sara", false, 2_000]);
    expect(accumulate(him, said({ kind: "guest", personId: null }), 2_000, 1).member).toBeNull();
    expect(accumulate(him, said({ confidence: 0.2 }), 2_000, 1).verified).toBe(false);
    expect(accumulate(him, said({}), 2_000, SESSION_IDLE_MS + 1).verified).toBe(false);
  });

  it("glances and names them once a session, only once verified, never when it can't tell", () => {
    expect(cueOf(NEW_SESSION(0))).toMatchObject({ glance: false, name: null });
    const first = cueOf(accumulate(null, said({ verified: true }), 4_000, 0));
    expect([first.glance, first.name]).toEqual([true, "Maya"]);
    expect(cueOf(first.session)).toMatchObject({ glance: false, name: null });
  });

  it("asks once instead of refusing, explains only the first time, and asks for a phrase on a shared vessel", () => {
    const unsure = accumulate(null, said({}), 2_000, 0);
    const mine = stepUpFor(unsure, { shared: false }, fixed);
    expect(mine.step).toEqual({ kind: "confirm", name: "Maya", explain: true });
    expect(stepUpFor(mine.session, { shared: false }, fixed).step).toMatchObject({
      explain: false,
    });
    expect(stepUpFor(unsure, { shared: true }, fixed).step).toEqual({
      kind: "phrase",
      phrase: "amber amber",
      explain: true,
    });
    expect(stepUpFor(NEW_SESSION(0), { shared: false }, fixed).step.kind).toBe("phone");
    expect(
      stepUpFor(accumulate(null, said({ verified: true }), 4_000, 0), { shared: true }, fixed).step,
    ).toEqual({
      kind: "none",
    });
  });
});
