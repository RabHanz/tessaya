import { describe, expect, it } from "vite-plus/test";

import { commsCaps } from "./comms.ts";
import { planDelivery, type DeliveryVessel } from "./commsDelivery.ts";

const vessel = (
  id: string,
  kind: string,
  personalOf: string | null,
  online = true,
): DeliveryVessel => ({
  id,
  name: id,
  online,
  caps: commsCaps({ kind, values: [] }),
  personalOf,
});
const members = [
  { id: "owner", name: "Omid", role: "owner" },
  { id: "sara", name: "Sara", role: "adult" },
  { id: "maya", name: "Maya", role: "child" },
  { id: "gus", name: "Gus", role: "guest" },
];
const vessels = [
  vessel("r1-kitchen", "r1", null),
  vessel("r1-office", "r1", null),
  vessel("r1-nursery", "r1", null, false),
  vessel("owner-phone", "phone", "owner"),
  vessel("owner-desktop", "desktop", "owner"),
];
const plan = (
  over: Omit<Partial<Parameters<typeof planDelivery>[0]>, "note"> & {
    note?: Partial<Parameters<typeof planDelivery>[0]["note"]>;
  } = {},
) =>
  planDelivery({
    senderRole: "adult",
    members,
    vessels,
    presence: [],
    quietNow: false,
    dnd: new Set(),
    ...over,
    note: { kind: "text", from: "sara", to: ["person:owner"], urgency: "normal", ...over.note },
  });
const where = (p: ReturnType<typeof planDelivery>) =>
  p.targets.map(
    (t) => `${t.vessel}${t.person === null ? "" : `>${t.person}`}${t.silent ? " (silent)" : ""}`,
  );

describe("planDelivery", () => {
  it("follows a person to the room they were just heard in, and to their own devices", () => {
    const p = plan({ presence: [{ member: "owner", vessel: "r1-office", minutesAgo: 3 }] });
    expect(where(p)).toEqual(["r1-office>owner", "owner-phone>owner", "owner-desktop>owner"]);
    expect(p.waiting).toEqual([]);
  });

  it("does not follow a stale or asleep presence, and holds a note for someone it can't reach", () => {
    expect(
      where(plan({ presence: [{ member: "owner", vessel: "r1-office", minutesAgo: 30 }] })),
    ).toEqual(["owner-phone>owner", "owner-desktop>owner"]);
    const toMaya = plan({
      note: { to: ["person:maya"] },
      presence: [{ member: "maya", vessel: "r1-nursery", minutesAgo: 1 }],
    });
    expect(toMaya.targets).toEqual([]);
    expect(toMaya.waiting).toEqual(["maya"]);
  });

  it("plays an announcement for someone it can't place in every awake room", () => {
    const p = plan({ note: { kind: "announce", to: ["group:kids"] } });
    expect(where(p)).toEqual(["r1-kitchen", "r1-office"]);
    expect(p.waiting).toEqual([]);
  });

  it("broadcasts to all rooms and every member's own devices, never to the sender or a guest", () => {
    const p = plan({ note: { kind: "announce", to: ["all"], from: "owner" } });
    expect(where(p)).toEqual(["r1-kitchen", "r1-office"]);
    expect(p.waiting).toEqual([]);
  });

  it("reaches a room or one vessel directly", () => {
    expect(where(plan({ note: { kind: "announce", to: ["room:kitchen"] } }))).toEqual([
      "r1-kitchen",
    ]);
    expect(where(plan({ note: { to: ["vessel:r1-office"] } }))).toEqual(["r1-office"]);
  });

  it("keeps speakers silent in quiet hours and do-not-disturb; screens show it quietly", () => {
    const heard = [{ member: "owner", vessel: "r1-office", minutesAgo: 1 }];
    expect(where(plan({ presence: heard, quietNow: true }))).toEqual([
      "owner-phone>owner (silent)",
      "owner-desktop>owner (silent)",
    ]);
    expect(where(plan({ presence: heard, dnd: new Set(["owner"]) }))).toEqual([
      "owner-phone>owner (silent)",
      "owner-desktop>owner (silent)",
    ]);
    expect(where(plan({ presence: heard, quietNow: true, note: { urgency: "urgent" } }))).toEqual([
      "r1-office>owner",
      "owner-phone>owner",
      "owner-desktop>owner",
    ]);
    // A child's urgent does not break quiet.
    expect(
      where(
        plan({ presence: heard, quietNow: true, senderRole: "child", note: { urgency: "urgent" } }),
      ),
    ).toEqual(["owner-phone>owner (silent)", "owner-desktop>owner (silent)"]);
    // A broadcast in quiet hours sounds nowhere; it waits on screens.
    expect(where(plan({ quietNow: true, note: { kind: "announce", to: ["all"] } }))).toEqual([
      "owner-phone>owner (silent)",
      "owner-desktop>owner (silent)",
    ]);
  });
});
