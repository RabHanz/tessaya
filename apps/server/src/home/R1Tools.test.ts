import { describe, expect, it } from "vite-plus/test";

import { replayDryRun } from "./R1Tools.ts";

describe("the room's tools for a replay", () => {
  it("never changes his house for the replay harness, and leaves his own R1's calls alone (01:29, 13 Nov)", () => {
    const fan = {
      domain: "script",
      service: "turn_on",
      target: { entity_id: "script.office_fan_toggle" },
    };
    for (const name of ["home_do", "home_undo", "home_automation_save", "home_automation_set"])
      expect(replayDryRun(name, fan, "replay-1")).toMatchObject({ isError: false, status: "done" });
    expect(replayDryRun("home_do", fan, "replay-1")?.text).toContain(
      "nothing in the house was changed",
    );
    expect(replayDryRun("home_do", fan, "r1-3d57b3")).toBeNull();
    expect(replayDryRun("home_do", fan, undefined)).toBeNull();
    expect(replayDryRun("home_state", { entityId: "fan.fan" }, "replay-1")).toBeNull();
  });
});
