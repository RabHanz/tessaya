import { describe, expect, it } from "vite-plus/test";

import { openState } from "./pageStates.ts";
import { SETTINGS, TABS, tabOf } from "./tabs.ts";

const drawn = new Set<string>([...TABS.map((t) => t.id), ...SETTINGS.map((t) => t.id)]);

/** Every setting the window has (ids as the producers make them), and the one place each must be. */
const PLACES: Readonly<Record<string, ReadonlyArray<string>>> = {
  general: ["v.login", "v.notice", "v.dnd", "v.snooze", "v.quiet", "v.brief", "u.act"],
  voice: [
    "v.enabled",
    "v.muted",
    "v.mic",
    "v.wake:tessaya",
    "v.direct",
    "v.listenAfterWake",
    "v.conversation",
    "v.waitMs",
    "v.verifyWake",
    "v.quietSpeech",
    "v.headphones",
    "v.voiceBargeIn",
    "v.silence",
    "s.output",
    "s.volume",
    "v.cues",
    "v.holdKeyCues",
    "v.pillPlace",
    "v.pillMove",
    "v.pillRest",
    "v.pillHide",
    "v.pillFull",
  ],
  personas: ["s.voice", "v.persona:alfred"],
  assistant: [
    "s.brain",
    "s.brainCheck",

    "s.account",
    "s.accountEmail",
    "s.act",
    "s.capture",
    "s.chrome",
    "s.chromeCheck",
    "s.social",
    "s.cursor",
    "s.hands",
    "s.handsAway",
    "pr.initiative",
    "pr.perHour",
    "pr.needsRepos",
    "pr.ciRepos",
    "pr.feeds",
    "pr.expect",
    "pr.deadlines",
  ],
  privacy: [
    "v.keepVoice",
    "v.keepDays",
    "v.keepCap",
    "v.keepSpace",
    "v.hideFromCapture",
    "pr.awWindow",
    "pr.awIdle",
    "pr.awFocus",
    "pr.awJobs",
    "rs.history",
    "rs.recordings",
    "rs.memory",
  ],
  appearance: ["v.appearance", "v.palette", "v.motion", "v.glass"],
  advanced: ["v.check", "v.diag", "v.micTest", "v.result:mic", "v.file"],
  cloud: ["setup.cloud.github", "setup.cloud.always"],
  dictation: [
    "v.dictation",
    "v.cleanup",
    "v.appMode",
    "v.speechModel",
    "v.recognition",
    "v.cloudProvider",
    "v.cloudKey",
    "v.cloudModel",
    "v.cloudTest",
    "v.language",
    "v.duck",
    "d.import",
  ],
};

describe("where each control lives", () => {
  it("puts every setting in exactly one place that the window draws", () => {
    for (const [place, ids] of Object.entries(PLACES)) {
      expect(drawn.has(place), place).toBe(true);
      for (const id of ids) expect(tabOf(id), id).toBe(place);
    }
  });
  it("keeps the pages' own rows on their pages", () => {
    expect(tabOf("n:claude:abc")).toBe("sessions");
    expect(tabOf("trust.revoke:chrome")).toBe("trust");
    expect(tabOf("help.say:needs_me")).toBe("help");
    expect(tabOf("tr.enabled")).toBe("transforms");
    expect(tabOf("bk.export")).toBe("history");
    expect(tabOf("s.learned:x")).toBe("memory");
  });
  it("sends an id it does not know somewhere drawn, never nowhere", () => {
    expect(drawn.has(tabOf("x.new"))).toBe(true);
  });
  it("lands an old page or Settings section on the category that now holds it", async () => {
    const page = await openState("empty");
    for (const [old, now] of [
      ["screen", "Working for you"],
      ["checks", "Advanced"],
      ["account", "Working for you"],
      ["updates", "General"],
      ["system", "Advanced"],
    ] as const) {
      page.show(old);
      expect(page.textOf("mbody"), old).toContain(now);
      page.closeModal();
    }
    expect(page.errors).toEqual([]);
  });
});
