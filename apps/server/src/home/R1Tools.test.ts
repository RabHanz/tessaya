import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { TessayaToolkit } from "../mcp/toolkits/tessaya/tools.ts";
import {
  asAdvertised,
  CORE_TOOLS,
  DESK_TOOL_SPECS,
  replayDryRun,
  ROOM_TOOL_SPECS,
} from "./R1Tools.ts";

const decodes = (name: keyof typeof TessayaToolkit.tools, input: unknown) => {
  const spec = ROOM_TOOL_SPECS.find((s) => s.name === name)!;
  const decode = Schema.decodeUnknownOption(TessayaToolkit.tools[name].parametersSchema);
  return Option.isSome(decode(asAdvertised(spec, input)));
};

describe("the room's tools for a replay", () => {
  it("never sends a replay's write, and leaves his own R1's calls alone (01:29, 13 Nov)", () => {
    const ask = { text: "approve the front door" };
    expect(replayDryRun("tessaya_ask", ask, "replay-1")).toMatchObject({
      isError: false,
      status: "done",
    });
    expect(replayDryRun("tessaya_ask", {}, "replay-1")?.isError).toBe(true);
    expect(replayDryRun("tessaya_ask", ask, "r1-3d57b3")).toBeNull();
    expect(replayDryRun("tessaya_record", {}, "replay-1")).toBeNull();
    // The house's writes go through the house's own checks as a dry run (HomeActor.dryRun).
    expect(replayDryRun("home_do", { domain: "fan" }, "replay-1")).toBeNull();
    // What she keeps (13 Nov audit, R1-P9): a replay's "say it this way" is answered, never saved.
    const word = { word: "Tessaya", sayAs: "Tess eye ya" };
    expect(replayDryRun("tessaya_pronounce", word, "replay-1")?.text).toContain("nothing was kept");
    expect(replayDryRun("tessaya_pronounce", word, "r1-3d57b3")).toBeNull();
    expect(replayDryRun("settings_set", { key: "holdKeyCues" }, "replay-1")).toBeNull();
    // The pretend desktop's device acts are answered, never sent.
    const eye = { id: "r1-3d57b3", op: "eye", mood: "happy" };
    expect(replayDryRun("device_act", eye, "replay-desktop")?.isError).toBe(false);
    expect(replayDryRun("device_act", eye, "desktop")).toBeNull();
  });

  it("lists every vessel's tools core first, then by name, so a prompt's tool block stays cached", () => {
    for (const specs of [ROOM_TOOL_SPECS, DESK_TOOL_SPECS]) {
      const planned = specs.map((s) => [!CORE_TOOLS.has(s.name), s.name].join(" "));
      expect(planned).toEqual(planned.toSorted());
    }
    const desk = new Map(DESK_TOOL_SPECS.map((s) => [s.name, s.readonly]));
    expect([desk.get("home_find"), desk.get("home_do"), desk.get("device_act")]).toEqual([
      true,
      false,
      false,
    ]);
    // The desktop's own screen and volume stay its own; the room's laptop and speaker are not its tools.
    expect(["laptop_ask", "set_device_volume", "tessaya_ask"].some((n) => desk.has(n))).toBe(false);
  });

  it("takes a number or a yes/no sent as a string, as every timer was (07:39, 13 Nov)", () => {
    const timer = {
      alias: "Fan off",
      kind: "temporary",
      runInMinutes: "1",
      actions: [],
      request: "on for one minute",
    };
    expect(decodes("home_automation_save", timer)).toBe(true);
    expect(decodes("tessaya_record", { limit: "10" })).toBe(true);
    expect(decodes("home_automations", { all: "true" })).toBe(true);
    expect(decodes("home_automation_save", { ...timer, runInMinutes: "soon" })).toBe(false);
  });
});
