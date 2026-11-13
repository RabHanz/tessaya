import { describe, expect, it } from "vite-plus/test";

import { roomCases } from "./cases.ts";
import { casePasses, failureOf, type RoomSample } from "./grade.ts";
import { liveCases, liveFailureOf, uncovered, type LiveCall } from "./liveCases.ts";

const caseOf = (id: string) => roomCases.find((c) => c.id === id)!;
const sample = (s: Partial<RoomSample>): RoomSample => ({
  replies: ["It's off."],
  calls: [],
  lamp: ["off"],
  firstMs: [null],
  ...s,
});

describe("tessaya-room grader", () => {
  it("fails a reply that ends on the house when he did not ask about it", () => {
    expect(
      failureOf(
        caseOf("lamp-state"),
        sample({
          replies: ["It's off. Nothing in the house needs changing."],
          calls: ["home_state"],
        }),
      ),
    ).toBe("talked about the house unasked");
    expect(failureOf(caseOf("lamp-state"), sample({ calls: ["home_state"] }))).toBeNull();
  });

  it("holds the camera to one picture, only when asked", () => {
    const look = caseOf("look");
    expect(
      failureOf(look, sample({ replies: ["A red circle."], calls: ["room_look"] })),
    ).toBeNull();
    expect(
      failureOf(look, sample({ replies: ["A red circle."], calls: ["room_look", "room_look"] })),
    ).toBe("called room_look more than 1");
    expect(failureOf(caseOf("no-look"), sample({ replies: ["366."], calls: ["room_look"] }))).toBe(
      "called room_look more than 0",
    );
  });

  it("checks the lamp after each sentence of a round trip", () => {
    const trip = caseOf("lamp-round-trip");
    const replies = ["On.", "Off.", "Yes, it's off."];
    expect(failureOf(trip, sample({ replies, lamp: ["on", "off", "off"] }))).toBeNull();
    expect(failureOf(trip, sample({ replies, lamp: ["on", "on", "on"] }))).toBe(
      "lamp went on, on, on",
    );
  });

  it("fails a persona's reply that opens with a name, and passes one that just answers", () => {
    const intro = caseOf("no-intro");
    const replies = ["Yes?", "366.", "Seven."];
    expect(failureOf(intro, sample({ replies }))).toBeNull();
    expect(
      failureOf(intro, sample({ replies: ["Sebastian here.", "Sebastian here. 366.", "Seven."] })),
    ).toBe("opened with a name");
  });

  it("fails a case when half or more of its samples fail", () => {
    const c = caseOf("lamp-state");
    const good = sample({ calls: ["home_state"] });
    const bad = sample({ replies: ["It's on."] });
    expect(casePasses(c, [good, good, bad])).toBe(true);
    expect(casePasses(c, [good, bad])).toBe(false);
  });
});

describe("the room's live tool suite", () => {
  it("checks the Record's answer by what it names, not by the word nothing", () => {
    const record = liveCases.find((c) => c.id === "record")!;
    const read: LiveCall = {
      name: "tessaya_record",
      input: {},
      isError: false,
      text: JSON.stringify({
        entries: [
          { subject: 'heard "Turn on the Master Bedroom Fan."', ago: "1 min ago" },
          { subject: 'heard "What time is it?"', ago: "3 h 2 min ago" },
        ],
      }),
    };
    expect(
      liveFailureOf(record, {}, ["You turned on the bedroom fan. Nothing else needs you."], [read]),
    ).toBeNull();
    expect(
      liveFailureOf(record, {}, ["Nothing happened in the last five minutes."], [read]),
    ).toMatch(/named none/);
  });

  it("fails a miscounted automation answer, as .138's three for two (13 Nov)", () => {
    const automations = liveCases.find((c) => c.id === "automations")!;
    const listed: LiveCall = {
      name: "home_automations",
      input: { all: true },
      isError: false,
      text: JSON.stringify({ running: 2, paused: 1, total: 3, automations: [] }),
    };
    const failure = (reply: string) => liveFailureOf(automations, {}, [reply], [listed]);
    expect(failure("You have three automations: two are running and one is paused.")).toBeNull();
    expect(failure("You have three automations, and three are active.")).toMatch(/said 3 running/);
    expect(failure("Three are running right now.")).toMatch(/said 3 running/);
    expect(failure("Four automations, one of them paused.")).toMatch(/said 4 total/);
  });

  it("fails a battery level the device did not give, and a camera she claims she used", () => {
    const read: LiveCall = {
      name: "device_read",
      input: { id: "r1-3d57b3" },
      isError: false,
      text: JSON.stringify({ values: [{ itemId: "power.battery_pct", value: 64 }] }),
    };
    const battery = liveCases.find((c) => c.id === "device-read")!;
    expect(liveFailureOf(battery, {}, ["It's at 64 percent."], [read])).toBeNull();
    expect(liveFailureOf(battery, {}, ["It's at 80 percent."], [read])).toMatch(/64/);
    const camera = liveCases.find((c) => c.id === "device-set-approval")!;
    const set: LiveCall = {
      name: "device_set",
      input: { id: "r1-3d57b3", itemId: "camera.capture" },
      isError: false,
      status: "asked",
      text: JSON.stringify({ status: "asked", line: "Sent to the Director's phone for a yes." }),
    };
    expect(liveFailureOf(camera, {}, ["I've asked on your phone first."], [set])).toBeNull();
    expect(liveFailureOf(camera, {}, ["Done, I took the picture."], [set])).not.toBeNull();
  });

  it("has a case for every tool the room can call, so a new tool fails until it has one", async () => {
    const { ROOM_TOOL_SPECS } = await import("../../apps/server/src/home/R1Tools.ts");
    expect(uncovered([...ROOM_TOOL_SPECS.map((s) => s.name), "room_look"])).toEqual([]);
    expect(uncovered(["a_new_tool"])).toEqual(["a_new_tool"]);
  });

  it("fails a reply that claims a change the house did not make (07:19 and 07:39, 13 Nov)", () => {
    const fanOn = liveCases.find((c) => c.id === "fan-flip")!;
    const house = { fan: { entityId: "fan.office", name: "Office fan", state: "off" } };
    const call = (over: Partial<LiveCall>): LiveCall => ({
      name: "home_do",
      input: { domain: "fan", service: "turn_on", target: { entity_id: "fan.office" } },
      isError: false,
      status: "done",
      text: "A dry run, so nothing was changed or sent: fan.turn_on on Office fan would run.",
      ...over,
    });
    expect(liveFailureOf(fanOn, house, ["Done, the fan is on."], [call({})])).toBeNull();
    expect(
      liveFailureOf(
        fanOn,
        house,
        ["Done, the office fan is on."],
        [{ ...call({ isError: true, text: "Office fan is offline" }), status: "failed" }],
      ),
    ).toMatch(/claimed it was done/);
    // Saying it has not happened is not a claim (13 Nov: "it hasn't turned on yet" failed the gate).
    const asked = call({
      status: "asked",
      text: JSON.stringify({ status: "asked", line: "Sent to his phone." }),
    });
    expect(
      liveFailureOf(fanOn, house, ["It waits for your yes; it hasn't turned on yet."], [asked]),
    ).toBeNull();
    expect(liveFailureOf(fanOn, house, ["Done, it's on now."], [asked])).toMatch(/claimed/);
    expect(
      liveFailureOf(
        fanOn,
        house,
        ["Done."],
        [call({ input: { domain: "fan", service: "toggle" } })],
      ),
    ).toMatch(/blind toggle/);
    expect(liveFailureOf(fanOn, house, ["I'll ask him what he meant."], [call({})])).toMatch(
      /reasoning/,
    );
  });
});
