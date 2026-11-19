import { describe, expect, it } from "vite-plus/test";

import { alsoLine, bodyLine } from "./embodiment.ts";

const ids = (...xs: Array<string>) => xs.map((id) => ({ id }));

describe("embodiment", () => {
  it("says what her Tessel body feels and shows, from its own manifest", () => {
    expect(
      bodyLine(
        ids("imu.posture", "touch.tap", "key.press", "eye.mood", "motor.vibrate", "camera.capture"),
      ),
    ).toBe(
      "In this body you feel being picked up, carried or shaken, a tap on your shell and its buttons pressed; your feelings show in your eyes on its screen; you can buzz; you can see through its camera when he asks you to look.",
    );
    expect(bodyLine(ids("mascot.do", "mascot.do.alfred"))).toBe(
      "Your body here is your character on his desktop: he can drag, poke and throw you.",
    );
    expect(bodyLine(ids("power.battery_pct"))).toBe("");
  });

  it("names the other bodies she wears now, and who stands with her", () => {
    expect(alsoLine(["Tumble", "his phone"], ["Alfred"])).toBe(
      "Right now you are also in your body on Tumble and his phone. Alfred stands beside you here.",
    );
    expect(alsoLine([], [])).toBe("");
  });
});
