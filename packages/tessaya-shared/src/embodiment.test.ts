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

  it("names every other body with its live state and wearer, and who stands with her", () => {
    expect(
      alsoLine(
        [
          {
            name: "Desk body",
            kind: "desktop",
            online: true,
            wearer: "Freya",
            you: false,
            shown: true,
            screen: "DELL U2720Q",
          },
          { name: "Tumble", kind: "r1", online: true, wearer: null, you: true },
          { name: "his phone", kind: "phone", online: false, wearer: "Freya", you: false },
          {
            name: "Office desk",
            kind: "desktop",
            online: true,
            wearer: null,
            you: false,
            shown: false,
          },
        ],
        ["Alfred"],
      ),
    ).toBe(
      "Your other bodies right now, live: Desk body (on his desktop (DELL U2720Q), Freya wears it); Tumble (on, you wear it); his phone (offline); Office desk (hidden on his desktop). Answer about them from this, not from memory. Alfred stands beside you here.",
    );
    expect(alsoLine([], [])).toBe("");
  });
});
