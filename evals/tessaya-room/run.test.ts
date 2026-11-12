import { describe, expect, it } from "vite-plus/test";

import { roomCases } from "./cases.ts";
import { casePasses, failureOf, type RoomSample } from "./grade.ts";

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

  it("fails a case when half or more of its samples fail", () => {
    const c = caseOf("lamp-state");
    const good = sample({ calls: ["home_state"] });
    const bad = sample({ replies: ["It's on."] });
    expect(casePasses(c, [good, good, bad])).toBe(true);
    expect(casePasses(c, [good, bad])).toBe(false);
  });
});
