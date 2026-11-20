import { describe, expect, it } from "vite-plus/test";

import {
  ambientSignals,
  fusePresence,
  peopleAt,
  PRESENCE_BARS,
  routeProactive,
  arpMacs,
  devicesOf,
  homeAssistantSignals,
  lanSignals,
  ownerOfDevice,
  type PresenceSignal,
  type ProactiveKind,
} from "./presence.ts";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const sig = (
  member: string | null,
  source: string,
  vessel: string | null,
  minutesAgo: number,
): PresenceSignal => ({ member, source, vessel, at: NOW - minutesAgo * MIN });
const of = (signals: ReadonlyArray<PresenceSignal>, member: string) =>
  fusePresence(signals, NOW).members.find((m) => m.member === member);

describe("fusePresence", () => {
  it("decays each signal by its half-life and forgets after a day", () => {
    const fresh = of([sig("omid", "voice", "kitchen", 0)], "omid");
    const half = of([sig("omid", "voice", "kitchen", 15)], "omid");
    expect(fresh?.confidence).toBeCloseTo(0.95);
    expect(half?.confidence).toBeCloseTo(0.475);
    // About ten minutes to the follow bar, about thirty to "around", as the old fixed windows were.
    expect(of([sig("omid", "voice", "k", 9)], "omid")!.confidence).toBeGreaterThan(
      PRESENCE_BARS.present,
    );
    expect(of([sig("omid", "voice", "k", 12)], "omid")!.confidence).toBeLessThan(
      PRESENCE_BARS.present,
    );
    expect(of([sig("omid", "voice", "k", 28)], "omid")!.confidence).toBeGreaterThan(
      PRESENCE_BARS.around,
    );
    expect(of([sig("omid", "voice", "k", 31)], "omid")!.confidence).toBeLessThan(
      PRESENCE_BARS.around,
    );
    expect(of([sig("omid", "voice", "k", 25 * 60)], "omid")).toBeUndefined();
  });

  it("fuses independent signals and places them at the strongest vessel", () => {
    const p = of(
      [
        sig("omid", "voice", "kitchen", 20),
        sig("omid", "device", null, 0),
        sig("omid", "typed", "desk", 1),
      ],
      "omid",
    )!;
    // More than any one signal alone.
    expect(p.confidence).toBeGreaterThan(0.95);
    expect(p.nearest?.vessel).toBe("desk");
    expect(p.lastSeen).toEqual({ at: NOW, source: "device", vessel: null });
    expect(p.evidence.map((e) => e.source)).toEqual(["typed", "device", "voice"]);
  });

  it("keeps many members apart, and an unknown someone only marks the vessel occupied", () => {
    const e = fusePresence(
      [
        sig("omid", "voice", "kitchen", 1),
        sig("sara", "voice", "study", 2),
        sig(null, "handled", "lounge", 0),
      ],
      NOW,
    );
    expect(e.members.map((m) => [m.member, m.nearest?.vessel])).toEqual([
      ["omid", "kitchen"],
      ["sara", "study"],
    ]);
    expect(e.occupied.get("lounge")).toBeCloseTo(0.6);
    expect(e.members.some((m) => m.nearest?.vessel === "lounge")).toBe(false);
  });

  it("a locked desktop cancels the typing before it, not after, nor their voice", () => {
    const away = [sig("omid", "typed", "desk", 3), sig("omid", "deskAway", null, 1)];
    expect(of(away, "omid")?.nearest).toBeNull();
    expect(of([...away, sig("omid", "typed", "desk", 0)], "omid")?.nearest?.vessel).toBe("desk");
    expect(of([...away, sig("omid", "voice", "kitchen", 0)], "omid")?.nearest?.vessel).toBe(
      "kitchen",
    );
  });

  it("the phone places them at it until put away, and leaving home cancels every at-home sign before it", () => {
    const phone = [sig("omid", "phoneApp", "phone-1", 5)];
    expect(of(phone, "omid")!.nearest!.confidence).toBeCloseTo(0.85 * 0.5 ** 0.5);
    expect(of([...phone, sig("omid", "phoneAppAway", null, 1)], "omid")?.nearest).toBeNull();
    const home = [
      sig("omid", "home", null, 60),
      sig("omid", "lan", null, 2),
      sig("omid", "haHome", null, 3),
    ];
    // Slow geofence, quick network: together past "around", each decaying at its own rate.
    expect(of([sig("omid", "home", null, 120)], "omid")!.confidence).toBeCloseTo(0.275);
    expect(of([sig("omid", "lan", null, 15)], "omid")!.confidence).toBeCloseTo(0.25);
    expect(of(home, "omid")!.confidence).toBeGreaterThan(PRESENCE_BARS.present);
    for (const away of ["away", "haAway"]) {
      const gone = [...home, sig("omid", away, null, 1)];
      expect(of(gone, "omid")!.confidence).toBe(0);
      // Back on the Wi-Fi after leaving counts again.
      expect(of([...gone, sig("omid", "lan", null, 0)], "omid")!.confidence).toBeCloseTo(0.5);
    }
  });

  it("an occupancy sensor marks the room's vessel, and the camera places only who it saw", () => {
    const e = fusePresence(
      [sig(null, "occupied", "office", 0), sig("sara", "camera", "desk", 5)],
      NOW,
    );
    expect(e.occupied.get("office")).toBeCloseTo(0.5);
    expect(e.members.map((m) => m.member)).toEqual(["sara"]);
    expect(e.members[0]!.nearest!.confidence).toBeCloseTo(0.45);
  });

  it("a meeting or a trip on the calendar lowers them, fades after it ends, and never places them", () => {
    const here = [sig("omid", "typed", "desk", 0)];
    expect(of([...here, sig("omid", "meeting", null, 0)], "omid")!.nearest!.confidence).toBeCloseTo(
      0.45,
    );
    // Below the follow bar in a meeting, so her own lines stay quiet; ten minutes after its last sweep, half as low.
    expect(of([...here, sig("omid", "meeting", null, 10)], "omid")!.confidence).toBeCloseTo(
      0.9 * 0.75,
    );
    expect(of([...here, sig("omid", "outOfOffice", null, 0)], "omid")!.confidence).toBeCloseTo(
      0.27,
    );
    const alone = of([sig("omid", "meeting", null, 0)], "omid")!;
    expect([alone.confidence, alone.nearest, alone.lastSeen]).toEqual([0, null, null]);
    expect(alone.evidence.map((x) => x.source)).toEqual(["meeting"]);
  });

  it("a new source is a row of data", () => {
    const e = fusePresence([sig("omid", "headphones", null, 0)], NOW, {
      headphones: { weight: 0.5, halfLifeMinutes: 5, says: "your headphones are on" },
    });
    expect(e.members[0]?.confidence).toBeCloseTo(0.5);
    // An unknown source counts for nothing.
    expect(of([sig("omid", "nonsense", "k", 0)], "omid")?.confidence).toBe(0);
  });
});

describe("peopleAt", () => {
  it("is everyone placed at a vessel, guests included, and lets them go as they move or fade", () => {
    const guest = { ...sig("p-1", "voice", "lounge", 2), guest: true };
    const e = fusePresence(
      [sig("omid", "voice", "lounge", 0), guest, sig("sara", "voice", "study", 0)],
      NOW,
    );
    expect(peopleAt(e, "lounge").map((m) => [m.member, m.guest])).toEqual([
      ["omid", false],
      ["p-1", true],
    ]);
    // The guest heard since in the study is there now, not in the lounge.
    const moved = fusePresence([guest, { ...sig("p-1", "voice", "study", 0), guest: true }], NOW);
    expect(peopleAt(moved, "lounge")).toEqual([]);
    // A guest heard 20 minutes ago still keeps private things careful, but is no longer "just heard".
    const faded = fusePresence([{ ...sig("p-1", "voice", "lounge", 20), guest: true }], NOW);
    expect(peopleAt(faded, "lounge").map((m) => m.member)).toEqual(["p-1"]);
    expect(peopleAt(faded, "lounge", PRESENCE_BARS.present)).toEqual([]);
  });
});

describe("ambient voices (M-123)", () => {
  it("places each member it is sure of, and anyone else only as someone there", () => {
    expect(ambientSignals([{ member: "omid" }], "study", NOW)).toEqual([
      { member: "omid", source: "ambientVoice", vessel: "study", at: NOW },
    ]);
    const two = ambientSignals(
      [{ member: "omid" }, { member: "sara" }, { member: "omid" }],
      "study",
      NOW,
    );
    expect(two.map((s) => s.member)).toEqual(["omid", "sara"]);
    const plusGuest = ambientSignals([{ member: "omid" }, { member: null }], "study", NOW);
    expect(plusGuest.map((s) => s.member)).toEqual(["omid", null]);
    const estimate = fusePresence(plusGuest, NOW);
    expect(estimate.members.find((m) => m.member === "omid")?.nearest?.vessel).toBe("study");
    expect(estimate.occupied.get("study")).toBeGreaterThan(0.8);
  });

  it("two weak sources together place him more surely than either alone", () => {
    const one = (source: string) =>
      fusePresence([sig("omid", source, "study", 0)], NOW).members[0]!.confidence;
    const both = fusePresence(
      [sig("omid", "phone", "study", 0), sig("omid", "occupied", "study", 0)],
      NOW,
    ).members[0]!.confidence;
    expect(both).toBeGreaterThan(Math.max(one("phone"), one("occupied")));
  });
});

describe("routeProactive", () => {
  const speakers = new Set(["kitchen", "study", "desk"]);
  const route = (
    kind: ProactiveKind,
    signals: ReadonlyArray<PresenceSignal>,
    origin: string | null = "study",
    follow = true,
  ) =>
    routeProactive({
      kind,
      member: "omid",
      origin,
      estimate: fusePresence(signals, NOW),
      speakers,
      follow,
    });
  const here = [sig("omid", "voice", "kitchen", 1)];

  it("her own line follows him to the vessel he is nearest", () => {
    expect(route("personal", here)).toMatchObject({ action: "speak", vessel: "kitchen" });
  });

  it("stays quiet when he is not there, or only someone else is", () => {
    expect(route("personal", [])).toMatchObject({ action: "quiet", why: "they are not around" });
    expect(route("personal", [sig("sara", "voice", "study", 0)])).toMatchObject({
      action: "quiet",
    });
    // Around (his phone) but not placed: still not out loud.
    expect(route("personal", [sig("omid", "device", null, 0)])).toMatchObject({
      action: "quiet",
      why: "they can't be placed at a vessel",
    });
    // Placed, but nowhere that can speak.
    expect(route("personal", [sig("omid", "voice", "phone", 0)])).toMatchObject({
      action: "quiet",
    });
  });

  it("a welcome back after his plan speaks where he is: the Tessel, the desk, or nowhere", () => {
    expect(route("personal", [sig("omid", "voice", "study", 1)], null)).toMatchObject({
      action: "speak",
      vessel: "study",
    });
    expect(route("personal", [sig("omid", "voice", "desk", 1)], null)).toMatchObject({
      action: "speak",
      vessel: "desk",
    });
    expect(route("personal", [], null)).toMatchObject({ action: "quiet" });
  });

  it("with follow off, speaks only where it started", () => {
    expect(route("personal", here, "study", false)).toMatchObject({ action: "quiet" });
    expect(route("personal", [sig("omid", "voice", "study", 1)], "study", false)).toMatchObject({
      action: "speak",
      vessel: "study",
    });
  });

  it("reminders, broadcasts and planned items follow him when they can, else land where they were set", () => {
    for (const kind of ["reminder", "broadcast", "planned"] as const) {
      expect(route(kind, here)).toMatchObject({ action: "speak", vessel: "kitchen" });
      expect(route(kind, [])).toMatchObject({ action: "speak", vessel: "study" });
      expect(route(kind, here, "study", false)).toMatchObject({ action: "speak", vessel: "study" });
      expect(route(kind, [], null)).toMatchObject({ action: "quiet" });
    }
  });
});

describe("the watching feeders", () => {
  const members = [
    {
      id: "owner",
      name: "Rab Hanz",
      devices: devicesOf("Rab's iPhone, AA-BB-CC-DD-EE-01; WH-1000XM5"),
    },
    { id: "sara", name: "Sara", devices: devicesOf("aa:bb:cc:dd:ee:02") },
  ];

  it("ties a device to its owner by name or address, and nobody's to no one", () => {
    expect(members[0]!.devices).toEqual(["rab's iphone", "aa:bb:cc:dd:ee:01", "wh:1000xm5"]);
    expect(ownerOfDevice(members, "AA:BB:CC:DD:EE:02")).toBe("sara");
    expect(ownerOfDevice(members, "00:11:22:33:44:55", "Sony WH-1000XM5")).toBe("owner");
    expect(ownerOfDevice(members, "00:11:22:33:44:55", "Somebody's Buds")).toBeNull();
  });

  it("finds their devices in the neighbour table, complete entries only", () => {
    const arp = [
      "IP address       HW type     Flags       HW address            Mask     Device",
      "192.168.1.20     0x1         0x2         aa:bb:cc:dd:ee:02     *        eth0",
      "192.168.1.21     0x1         0x0         aa:bb:cc:dd:ee:01     *        eth0",
    ].join("\n");
    expect(arpMacs(arp)).toEqual(["aa:bb:cc:dd:ee:02"]);
    expect(lanSignals(arpMacs(arp), members, NOW)).toEqual([
      { member: "sara", source: "lan", vessel: null, at: NOW },
    ]);
  });

  it("reads Home Assistant's people, routers, room sensors and calendars", () => {
    const e = (entityId: string, name: string, state: string, more: object = {}) => ({
      entityId,
      name,
      area: null,
      state,
      attributes: {},
      ...more,
    });
    const signals = homeAssistantSignals({
      entities: [
        e("person.rab", "Rab", "home"),
        e("person.sara", "Sara", "not_home"),
        e("person.ghost", "Ghost", "home"),
        e("device_tracker.rabs_iphone", "Rab's iPhone", "home"),
        e("device_tracker.sara_phone", "Sara phone", "home"),
        e("binary_sensor.office_occ", "Office", "on", {
          area: "Office",
          attributes: { device_class: "occupancy" },
        }),
        e("binary_sensor.door", "Door", "on", {
          area: "Office",
          attributes: { device_class: "door" },
        }),
        e("calendar.work", "Work", "on", { attributes: { message: "Standup" } }),
        e("calendar.sara", "Sara's calendar", "on", {
          attributes: { message: "Flight to Dubai" },
        }),
        e("calendar.family", "Family", "off"),
      ],
      members,
      vessels: [
        { id: "t-1", name: "Office Tessel" },
        { id: "t-2", name: "Kitchen Tessel" },
      ],
      owner: "owner",
      at: NOW,
    });
    expect(signals.map((s) => [s.member, s.source, s.vessel])).toEqual([
      ["owner", "haHome", null],
      ["sara", "haAway", null],
      ["owner", "lan", null],
      [null, "occupied", "t-1"],
      ["owner", "meeting", null],
      ["sara", "outOfOffice", null],
    ]);
  });
});
