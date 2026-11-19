import { describe, expect, it } from "vite-plus/test";

import {
  groupRefusal,
  groupStage,
  lockAll,
  openRoom,
  readableFor,
  roomStep,
  stageOnto,
  stagePlan,
  traceSeenBy,
  type RoomPersona,
} from "./rooms.ts";

const personas: ReadonlyArray<RoomPersona> = [
  { id: "freya", private: true, privateRooms: "open" },
  { id: "sebastian", private: true, privateRooms: "open" },
  { id: "alfred", private: false },
  { id: "luna", private: true, privateRooms: "one-on-one" },
  { id: "mira", private: true, privateRooms: "open", apartFrom: ["sebastian"] },
];
const lines = (n: number, room = openRoom("r", "freya", "private")) =>
  Array.from({ length: n }).reduce<typeof room>(
    (r) => (roomStep(r, { op: "line" }, personas) as { room: typeof room }).room,
    room,
  );

describe("rooms", () => {
  it("Sebastian called in at line 5 reads from line 5 on, never Freya's one-on-one before it", () => {
    const step = roomStep(lines(5), { op: "callIn", persona: "sebastian" }, personas);
    expect(step.ok).toBe(true);
    expect(step.room.kind).toBe("open");
    expect(readableFor(step.room, "sebastian")).toEqual({ from: 5, exceptAside: null });
    expect(readableFor(step.room, "freya")).toEqual({ from: 0, exceptAside: null });
    // sent out, the room is a one-on-one again and he reads nothing more of it
    const out = roomStep(step.room, { op: "sendOut", persona: "sebastian" }, personas).room;
    expect(out.kind).toBe("one-on-one");
    expect(readableFor(out, "sebastian")).toBeNull();
  });

  it("each persona's boundary holds: her record, the room's door, and who she won't share a room with", () => {
    const room = lines(2);
    expect(roomStep(room, { op: "callIn", persona: "alfred" }, personas)).toMatchObject({
      ok: false,
      why: "never",
    });
    expect(roomStep(room, { op: "callIn", persona: "luna" }, personas)).toMatchObject({
      ok: false,
      why: "oneOnOneOnly",
    });
    const closed = roomStep(room, { op: "closeDoor", persona: "sebastian" }, personas).room;
    expect(roomStep(closed, { op: "callIn", persona: "sebastian" }, personas)).toMatchObject({
      ok: false,
      why: "door",
    });
    const reopened = roomStep(closed, { op: "openDoor", persona: "sebastian" }, personas).room;
    const withSeb = roomStep(reopened, { op: "callIn", persona: "sebastian" }, personas).room;
    expect(roomStep(withSeb, { op: "callIn", persona: "mira" }, personas)).toMatchObject({
      ok: false,
      why: "apart",
    });
    // an everyday room takes anyone he calls
    expect(
      roomStep(openRoom("p", "freya", "public"), { op: "callIn", persona: "alfred" }, personas).ok,
    ).toBe(true);
  });

  it("stepping aside with one keeps the others out of it; coming back resumes the shared moment", () => {
    const open = roomStep(lines(3), { op: "callIn", persona: "sebastian" }, personas).room;
    const aside = roomStep(
      lines(2, roomStep(open, { op: "stepAside", persona: "freya" }, personas).room),
      { op: "line" },
      personas,
    ).room;
    expect(readableFor(aside, "sebastian")).toEqual({ from: 3, exceptAside: { from: 3 } });
    expect(readableFor(aside, "freya")).toEqual({ from: 0, exceptAside: null });
    expect(roomStep(aside, { op: "comeBack" }, personas).room.aside).toBeUndefined();
  });

  it("his group with a private persona in it keeps out whoever only comes one-on-one", () => {
    expect(
      groupRefusal([
        { id: "freya", private: true },
        { id: "luna", private: true, privateRooms: "one-on-one" },
      ]),
    ).toBe("luna");
    expect(groupRefusal([{ id: "freya", private: true }, { id: "alfred" }])).toBeNull();
    // an everyday group holds anyone
    expect(groupRefusal([{ id: "alfred" }, { id: "luna", privateRooms: "never" }])).toBeNull();
  });

  it("a lock closes every private room at once; the trace back is content-free and seen as he allowed (D5)", () => {
    const priv = openRoom("a", "freya", "private");
    const pub = openRoom("b", "alfred", "public");
    expect(lockAll([priv, pub])).toEqual([pub]);
    expect(traceSeenBy(priv, "freya", false)).toBe(true);
    expect(traceSeenBy(priv, "sebastian", false)).toBe(false);
    expect(traceSeenBy(priv, "sebastian", true)).toBe(true);
  });

  it("stages a room per vessel: the speaker faces him, the others face her", () => {
    const room = ["freya", "sebastian", "mira"];
    const desk = stagePlan("desktop", room, "sebastian");
    expect(desk.map((s) => [s.persona, s.x, s.scale, s.front])).toEqual([
      ["freya", 0.2, 1, false],
      ["sebastian", 0.5, 1.1, true],
      ["mira", 0.8, 1, false],
    ]);
    expect(desk.find((s) => s.persona === "mira")?.faces).toEqual({
      kind: "persona",
      id: "sebastian",
    });
    expect(desk.find((s) => s.persona === "sebastian")?.faces).toEqual({ kind: "him" });
    // the mirror puts the speaker in the middle; the phone has her full and the others small
    expect(stagePlan("mirror", room, "freya").find((s) => s.persona === "freya")?.x).toBe(0.5);
    expect(stagePlan("phone", room, "mira").map((s) => [s.persona, s.scale])).toEqual([
      ["mira", 1],
      ["freya", 0.3],
      ["sebastian", 0.3],
    ]);
    expect(stagePlan("tessel", room, "mira").map((s) => s.persona)).toEqual(["mira"]);
    // onto a mount: the bodies it holds are placed; one it lacks is skipped
    const placed: Array<string> = [];
    const bodies = new Map(["freya", "mira"].map((p) => [p, { place: () => void placed.push(p) }]));
    expect(stageOnto(bodies, desk)).toBe(2);
    expect(placed).toEqual(["freya", "mira"]);
  });

  it("a group speaker's step: she takes her spot and turns to whoever she addresses, the others to her", () => {
    const room = ["freya", "sebastian", "mira"];
    const names = { freya: "Freya", sebastian: "Sebastian", mira: "Mira" };
    const faces = (plan: ReadonlyArray<{ persona: string; faces: unknown }>) =>
      Object.fromEntries(plan.map((s) => [s.persona, s.faces]));
    expect(
      faces(groupStage("mirror", room, "sebastian", "Freya, what do you think?", names)),
    ).toEqual({
      sebastian: { kind: "persona", id: "freya" },
      freya: { kind: "persona", id: "sebastian" },
      mira: { kind: "persona", id: "sebastian" },
    });
    // a name only mentioned is not addressing: she speaks to him
    expect(
      faces(groupStage("mirror", room, "mira", "I told Freya yesterday.", names)).mira,
    ).toEqual({ kind: "him" });
    expect(
      groupStage("mirror", room, "mira", "Sebastian?", names).find((s) => s.front)?.persona,
    ).toBe("mira");
  });
});
