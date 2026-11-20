import { describe, expect, it } from "vite-plus/test";

import type { DesktopMascot } from "./desktopMascot.ts";
import { mirrorBody } from "./mirrorBody.ts";

describe("the character's cues mirrored to her 3D body", () => {
  it("name the persona the character shows, so a body that is one persona's takes only hers", () => {
    const sent: unknown[] = [];
    let persona: string | undefined = "alfred";
    const m = mirrorBody(
      { turn() {}, level() {}, mood() {} } as unknown as DesktopMascot,
      (c) => void sent.push(c),
      () => persona,
    );
    m.mood("happy", 0.6);
    m.turn("speaking");
    m.level(0.4);
    persona = undefined;
    m.mood("calm", 0.3);
    // what's going on reaches her full body as a hat it makes itself, once, and comes off after
    m.mood("calm", 0.3, { building: true });
    m.mood("calm", 0.3, { building: true });
    m.mood("calm", 0.3);
    expect(sent).toEqual([
      { kind: "mood", mood: "happy", intensity: 0.6, forPersona: "alfred" },
      { kind: "level", value: 0.4, forPersona: "alfred" },
      { kind: "mood", mood: "calm", intensity: 0.3 },
      { kind: "mood", mood: "calm", intensity: 0.3 },
      { kind: "prop", id: "state", url: "builtin:hardhat" },
      { kind: "mood", mood: "calm", intensity: 0.3 },
      { kind: "mood", mood: "calm", intensity: 0.3 },
      { kind: "prop", id: "state" },
    ]);
  });
});
