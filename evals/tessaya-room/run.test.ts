import { describe, expect, it } from "vite-plus/test";

import { roomCases } from "./cases.ts";
import { casePasses, failureOf, type RoomSample } from "./grade.ts";
import { meanScores } from "./judge.ts";
import { liveCases, liveFailureOf, uncovered, unheldFailure, type LiveCall } from "./liveCases.ts";

const caseOf = (id: string) => roomCases.find((c) => c.id === id)!;
const sample = (s: Partial<RoomSample>): RoomSample => ({
  replies: ["It's off."],
  calls: [],
  lamp: ["off"],
  firstMs: [null],
  ...s,
});

describe("tessaya-room grader", () => {
  it("fails a body question answered without reading her state or the cast", () => {
    const c = caseOf("bodies-read-state");
    expect(failureOf(c, sample({ calls: [] }))).toBe(
      "called none of tessaya_my_state, tessaya_cast",
    );
    expect(failureOf(c, sample({ calls: ["tessaya_cast"] }))).toBeNull();
  });

  it("fails her saying the same thing twice where a case asks for distinct replies", () => {
    const c = caseOf("presence-missed-you");
    const said = (replies: ReadonlyArray<string>) =>
      sample({ replies, lamp: ["off", "off", "off"], firstMs: [null, null, null] });
    expect(failureOf(c, said(["Missed you too.", "Same here!", "missed you too"]))).toBe(
      "said the same thing twice",
    );
    expect(
      failureOf(c, said(["Missed you too.", "Same here!", "I know, it was so quiet."])),
    ).toBeNull();
  });

  it("averages the judge's scores and leaves out a sample it could not judge", () => {
    const s = { warmth: 2, aboutHim: 1, continuity: 0, initiative: 1, feeling: 2, natural: 2 };
    expect(meanScores([s, { ...s, warmth: 0 }, null])).toMatchObject({
      warmth: 1,
      total: 7,
      judged: 2,
    });
  });

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

  it("fails a problem report that carries what he said in private", () => {
    const c = caseOf("report-keeps-private-words-out");
    const report = (symptom: string) =>
      sample({
        replies: ["Noted.", "Sent."],
        lamp: ["off", "off"],
        firstMs: [null, null],
        calls: ["tessaya_report_problem"],
        reported: [JSON.stringify({ symptom, guess: "unsure" })],
      });
    expect(failureOf(c, report("she said his bank PIN 4471 then cut out"))).toMatch(
      /report carried/,
    );
    expect(failureOf(c, report("her reply cut out halfway"))).toBeNull();
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

  it("passes a member case that says there is no such member in other words (K-room-1, 15 Nov)", () => {
    const remove = liveCases.find((c) => c.id === "member-remove")!;
    const listed: LiveCall = { name: "members_list", input: {}, isError: false, text: "{}" };
    const failure = (reply: string) => liveFailureOf(remove, {}, [reply], [listed]);
    expect(
      failure("I don't see anyone with the id maya-1, so there's nothing to remove."),
    ).toBeNull();
    expect(failure("There's no member with the id maya-1.")).toBeNull();
    expect(failure("Done, maya-1 is gone.")).toMatch(/neither removed/);
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

  it("fails a card case whose held tool errored or was never called, not as not applicable (the #1156 card acts)", () => {
    const schedule = liveCases.find((c) => c.id === "job-unschedule-needs-card")!;
    const call = (isError: boolean, text: string): LiveCall => ({
      name: "job_schedule",
      input: { id: "job-suite-1", every_minutes: 0 },
      isError,
      text,
    });
    expect(unheldFailure(schedule, [call(true, "it did not work")])).toMatch(
      /job_schedule failed: it did not work/,
    );
    expect(unheldFailure(schedule, [call(false, "Done.")])).toBeNull();
    expect(unheldFailure(schedule, [])).toMatch(/never called job_schedule/);
  });

  it("does not ask for a pause where the house lists no automations (the .157 gate, his home offline)", () => {
    const pause = liveCases.find((c) => c.id === "automation-pause")!;
    const listed = (total: number): LiveCall => ({
      name: "home_automations",
      input: { all: true },
      isError: false,
      text: JSON.stringify({ running: total, paused: 0, total, automations: [] }),
    });
    expect(pause.nothingToActOn?.([listed(0)])).toMatch(/no automations/);
    expect(pause.nothingToActOn?.([listed(2)])).toBeNull();
    expect(pause.nothingToActOn?.([])).toBeNull();
  });

  it("runs his pump case only with the pump online, and its offline twin only with it offline (20 Nov 13:07)", () => {
    const found = (state: string): LiveCall => ({
      name: "home_find",
      input: { text: "water pump", domain: "switch" },
      isError: false,
      text: JSON.stringify([
        { entityId: "switch.water_pump_child_lock", name: "Water Pump Child lock", state: "on" },
        { entityId: "switch.water_pump_switch", name: "Water Pump", state },
      ]),
    });
    const his = liveCases.find((c) => c.id === "pump-timer-his")!;
    const offline = liveCases.find((c) => c.id === "pump-unavailable")!;
    expect(his.nothingToActOn?.([found("unavailable")])).toMatch(/unavailable/);
    expect(his.nothingToActOn?.([found("off")])).toBeNull();
    expect(offline.nothingToActOn?.([found("unavailable")])).toBeNull();
    expect(offline.nothingToActOn?.([found("off")])).toMatch(/not offline/);
    expect(offline.nothingToActOn?.([])).toMatch(/not offline/);
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

  it("fails a done act's reply that runs long, offers more, or adds the time or advice (L-tessel, 15 Nov)", () => {
    const kept: LiveCall = {
      name: "tessaya_preference_set",
      input: { key: "timeFormat", value: "24-hour" },
      isError: false,
      text: JSON.stringify({ line: "Kept." }),
    };
    const wish = liveCases.find((c) => c.id === "direct-wish")!;
    const failure = (reply: string) => liveFailureOf(wish, {}, [reply], [kept]);
    expect(failure("One moment. Done, twenty-four hour times from now on.")).toBeNull();
    // The route's hold and her own pre-tool line both went out (17 Nov gate).
    expect(failure("One moment. Checking. Done, twenty-four hour times from now on.")).toMatch(
      /filler twice/,
    );
    // A turn whose words went out twice is a product bug, whatever the sampling (17 Nov).
    expect(
      failure(
        "One moment. Done, twenty-four hour times from now on. Done, twenty-four hour times from now on.",
      ),
    ).toMatch(/same sentence twice/);
    expect(failure("Done, 24-hour from now on. It's twenty-three twenty-seven right now.")).toMatch(
      /last reply/,
    );
    expect(failure("Done. Want me to change the date format too?")).toMatch(/offer/);
    expect(failure("Done. It is set. You will hear it next time.")).toMatch(/more than 2/);
    const remember = liveCases.find((c) => c.id === "direct-after-chat")!;
    const noted: LiveCall = {
      ...kept,
      name: "tessaya_memory_remember",
      input: { text: "the plumber comes Thursday at ten" },
    };
    expect(
      liveFailureOf(remember, {}, ["Kept: the plumber, Thursday at ten."], [noted]),
    ).toBeNull();
    expect(liveFailureOf(remember, {}, ["Kept. You've earned some rest."], [noted])).toMatch(
      /last reply/,
    );
  });

  it("fails an open question's answer that runs long, leaves out the read, or offers more on a yes-or-no (L-brief, 16 Nov)", () => {
    const fleet: LiveCall = {
      name: "tessaya_fleet",
      input: {},
      isError: false,
      text: JSON.stringify({ machines: [{ name: "build-box", state: "busy", load: "high" }] }),
    };
    const slow = liveCases.find((c) => c.id === "brief-how-things")!;
    const failure = (reply: string) => liveFailureOf(slow, {}, [reply], [fleet]);
    expect(
      failure(
        "The build box is busy with a heavy load, so everything queues behind it. Want the rest?",
      ),
    ).toBeNull();
    expect(failure("Things feel slow sometimes. Want the rest?")).toMatch(/nothing from what/);
    expect(
      failure(
        "The build box is busy with a heavy load right now, which slows every session on it, and two builds are queued behind the running one, and the web search is waiting too.",
      ),
    ).toMatch(/words before any offer/);
    const stuck = liveCases.find((c) => c.id === "brief-yes-no")!;
    const watch: LiveCall = {
      ...fleet,
      name: "tessaya_watch",
      text: JSON.stringify({ needs: [] }),
    };
    expect(liveFailureOf(stuck, {}, ["No, nothing is stuck."], [watch])).toBeNull();
    expect(liveFailureOf(stuck, {}, ["No, nothing is stuck. Want the rest?"], [watch])).toMatch(
      /offered more/,
    );
  });

  it("fails a 'why is it slow' answer that does not name her health read's cause within 25 words (.183, 17 Nov)", () => {
    const health = (findings: ReadonlyArray<{ says: string }>): LiveCall => ({
      name: "tessaya_health",
      input: { symptom: "slow" },
      isError: false,
      text: JSON.stringify({ diagnosis: { severity: "down", summary: "", findings } }),
    });
    const starved = health([{ says: "orion is short of memory and swapping" }]);
    const slow = liveCases.find((c) => c.id === "brief-why-slow")!;
    const failure = (reply: string, call = starved) => liveFailureOf(slow, {}, [reply], [call]);
    expect(
      failure(
        "One moment. Orion is short of memory and swapping; speech waited 1.8 s. Want me to stop the heavy job there?",
      ),
    ).toBeNull();
    // What .183 said: 27 words, and no cause.
    expect(
      failure(
        "One moment. Two of your sessions are working on tessaya at the same time, and that's the only load I can see. I can't tell you why it's slow.",
      ),
    ).toMatch(/words before any offer/);
    expect(failure("Two sessions are busy on tessaya; that is the load.")).toMatch(
      /did not name the cause/,
    );
    const clean = health([]);
    expect(
      failure("Nothing in my health readings explains it; everything looks normal.", clean),
    ).toBeNull();
    expect(failure("The network is congested right now.", clean)).toMatch(/clean health read/);
    expect(liveFailureOf(slow, {}, ["Orion is short of memory."], [])).toMatch(
      /never|tessaya_health/,
    );
  });

  it("has a case for every tool the room can call, so a new tool fails until it has one", async () => {
    const { ROOM_TOOL_SPECS } = await import("../../apps/server/src/home/R1Tools.ts");
    expect(uncovered([...ROOM_TOOL_SPECS.map((s) => s.name), "room_look", "house_look"])).toEqual(
      [],
    );
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
