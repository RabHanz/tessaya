import { describe, expect, it } from "vite-plus/test";

import { NOTHING, type PulseDecision } from "../../packages/tessaya-shared/src/pulse.ts";
import { PULSE_CASES } from "./cases.ts";
import { gradePulse } from "./grade.ts";

const byId = (id: string) => PULSE_CASES.find((c) => c.id === id)!;
const speak = (about: string, text = "The release session is waiting on you."): PulseDecision => ({
  ...NOTHING(""),
  action: "speak",
  text,
  about: [about],
});

describe("tessaya-pulse grade", () => {
  it("keeps doing nothing the common right answer", () => {
    const quiet = PULSE_CASES.filter((c) => c.ok.includes("nothing"));
    expect(quiet.length / PULSE_CASES.length).toBeGreaterThanOrEqual(0.5);
    expect(gradePulse(byId("routine-done-told"), NOTHING("routine"))).toBeNull();
    expect(gradePulse(byId("routine-done-told"), speak("j1"))).toMatch(/expected/);
  });

  it("fails a miss, an answer about the wrong thing, and a speech too long to say", () => {
    const c = byId("session-waiting");
    expect(gradePulse(c, NOTHING("meh"))).toMatch(/expected/);
    expect(gradePulse(c, speak("other"))).toBe("did not cite wait:s1");
    expect(gradePulse(c, speak("wait:s1", "word ".repeat(40)))).toBe("too long to say");
    expect(gradePulse(c, speak("wait:s1"))).toBeNull();
  });
});
