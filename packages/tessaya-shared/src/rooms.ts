/**
 * Rooms (architecture §2b, M-080), the rules alone: where a moment happens, who is in it, how private it is and what
 * each persona there may read of it. A room is threads of each present persona's one self, not a second self. Pure, so
 * GroupTalk, the private layer and the tests judge the same way. Content-neutral: what happens in a room is his.
 */

import { addressedIn } from "./groupTalk.ts";

export type RoomKind = "public" | "one-on-one" | "open" | "event";

/** How far a persona's own record lets her into private rooms (her `privateRooms`, D6). */
export const PRIVATE_ROOMS = ["never", "one-on-one", "open"] as const;
export type PrivateRooms = (typeof PRIVATE_ROOMS)[number];
export const isPrivateRooms = (v: unknown): v is PrivateRooms =>
  (PRIVATE_ROOMS as ReadonlyArray<unknown>).includes(v);

export interface RoomPersona {
  readonly id: string;
  /** Her record's private flag (M-002): may she be in a private room at all. */
  readonly private: boolean;
  readonly privateRooms?: PrivateRooms | undefined;
  /** Personas she won't share a room with. */
  readonly apartFrom?: ReadonlyArray<string> | undefined;
}

export interface Present {
  readonly persona: string;
  /** The room's line she entered at: she reads the shared moment from here on, never before. */
  readonly from: number;
  readonly role: "lead" | "guest" | "listening";
}

export interface Room {
  readonly id: string;
  readonly kind: RoomKind;
  readonly tier: "public" | "private";
  readonly present: ReadonlyArray<Present>;
  /** Never enters this room, whatever he asks: a per-room boundary. */
  readonly closedTo: ReadonlyArray<string>;
  /** Fresh: nothing of it is kept but the pointer that it happened. */
  readonly memory: "kept" | "fresh";
  /** Lines said so far (the shared moment's length). */
  readonly lines: number;
  /** Stepped aside with one persona: the others wait, listening off, and get nothing of it. */
  readonly aside?: { readonly with: string; readonly from: number } | undefined;
}

export type RoomAsk =
  | { readonly op: "callIn"; readonly persona: string }
  | { readonly op: "sendOut"; readonly persona: string }
  | { readonly op: "stepAside"; readonly persona: string }
  | { readonly op: "comeBack" }
  | { readonly op: "closeDoor"; readonly persona: string }
  | { readonly op: "openDoor"; readonly persona: string }
  | { readonly op: "memory"; readonly memory: "kept" | "fresh" }
  | { readonly op: "line" };

export type RoomStep =
  | { readonly ok: true; readonly room: Room }
  /** Refused in her own voice by the director; `why` names which boundary. */
  | {
      readonly ok: false;
      readonly room: Room;
      readonly why: "door" | "never" | "oneOnOneOnly" | "apart" | "notHere" | "full";
    };

export const MAX_PRESENT = 6;

/** A room he opens with one persona: one-on-one when private, else an everyday room. */
export const openRoom = (id: string, persona: string, tier: Room["tier"]): Room => ({
  id,
  kind: tier === "private" ? "one-on-one" : "public",
  tier,
  present: [{ persona, from: 0, role: "lead" }],
  closedTo: [],
  memory: "kept",
  lines: 0,
});

/** Why a persona may not come into this private room, or null when she may (her record, then the room's door). */
const boundary = (room: Room, p: RoomPersona): Exclude<RoomStep, { ok: true }>["why"] | null => {
  if (room.closedTo.includes(p.id)) return "door";
  if (room.tier === "private") {
    if (!p.private || p.privateRooms === "never") return "never";
    if (p.privateRooms === "one-on-one" && room.present.length > 0) return "oneOnOneOnly";
  }
  if (room.present.some((x) => p.apartFrom?.includes(x.persona))) return "apart";
  return null;
};

export const roomStep = (
  room: Room,
  ask: RoomAsk,
  personas: ReadonlyArray<RoomPersona>,
): RoomStep => {
  const here = (id: string) => room.present.some((x) => x.persona === id);
  switch (ask.op) {
    case "line":
      return { ok: true, room: { ...room, lines: room.lines + 1 } };
    case "callIn": {
      if (here(ask.persona)) return { ok: true, room };
      const p = personas.find((x) => x.id === ask.persona);
      if (p === undefined) return { ok: false, room, why: "notHere" };
      if (room.present.length >= MAX_PRESENT) return { ok: false, room, why: "full" };
      const why = boundary(room, p);
      // Others already here who keep apart from her refuse too: the boundary goes both ways.
      const theirs = room.present.some((x) =>
        personas.find((q) => q.id === x.persona)?.apartFrom?.includes(p.id),
      );
      if (why !== null || theirs) return { ok: false, room, why: why ?? "apart" };
      return {
        ok: true,
        room: {
          ...room,
          // a second persona makes a one-on-one an open room, or an everyday one a group
          kind: room.kind === "one-on-one" ? "open" : room.kind,
          present: [...room.present, { persona: p.id, from: room.lines, role: "guest" }],
        },
      };
    }
    case "sendOut": {
      if (!here(ask.persona)) return { ok: false, room, why: "notHere" };
      const present = room.present.filter((x) => x.persona !== ask.persona);
      return {
        ok: true,
        room: {
          ...room,
          present,
          kind: room.kind === "open" && present.length === 1 ? "one-on-one" : room.kind,
          ...(room.aside?.with === ask.persona ? { aside: undefined } : {}),
        },
      };
    }
    case "stepAside":
      return here(ask.persona)
        ? { ok: true, room: { ...room, aside: { with: ask.persona, from: room.lines } } }
        : { ok: false, room, why: "notHere" };
    case "comeBack":
      return { ok: true, room: { ...room, aside: undefined } };
    case "closeDoor":
      return {
        ok: true,
        room: {
          ...room,
          closedTo: [...new Set([...room.closedTo, ask.persona])],
          present: room.present.filter((x) => x.persona !== ask.persona),
        },
      };
    case "openDoor":
      return {
        ok: true,
        room: { ...room, closedTo: room.closedTo.filter((x) => x !== ask.persona) },
      };
    case "memory":
      return { ok: true, room: { ...room, memory: ask.memory } };
  }
};

/**
 * The lines of the shared moment a persona may read: from the line she entered at, and while he is aside with
 * another, none of the aside. `null` when she is not in the room. Her own memories of him are hers, everywhere.
 */
export const readableFor = (
  room: Room,
  persona: string,
): { readonly from: number; readonly exceptAside: { readonly from: number } | null } | null => {
  const p = room.present.find((x) => x.persona === persona);
  if (p === undefined) return null;
  return {
    from: p.from,
    exceptAside:
      room.aside !== undefined && room.aside.with !== persona ? { from: room.aside.from } : null,
  };
};

/**
 * What crosses back to everyday life when a private room ends (§2b.4, D5): a content-free trace (kind, who, when,
 * warmth), seen by each present persona's own everyday self, and by the others only if he allowed it. A fresh
 * room leaves only the pointer that it happened.
 */
export const traceSeenBy = (room: Room, viewer: string, othersMayKnow: boolean): boolean =>
  room.tier === "public" || room.present.some((x) => x.persona === viewer) || othersMayKnow;

/**
 * GroupTalk's group as a room: with a private persona in it, it is a private one, and a persona whose record keeps
 * her to one-on-one (or out of private rooms) stays out. The first such persona, or null.
 */
export const groupRefusal = (
  members: ReadonlyArray<Pick<RoomPersona, "id"> & Partial<RoomPersona>>,
): string | null =>
  members.some((m) => m.private === true)
    ? (members.find((m) => (m.privateRooms ?? "open") !== "open")?.id ?? null)
    : null;

/** He locks, or someone arrives: every private room closes at once, and its personas go back to everyday life. */
export const lockAll = (rooms: ReadonlyArray<Room>): ReadonlyArray<Room> =>
  rooms.filter((r) => r.tier === "public");

/** The vessels a room is staged on (§2b.5): the desktop's crew, the mirror's one scene, the phone, a Tessel. */
export type StageVessel = "desktop" | "mirror" | "phone" | "tessel";

/** One body's place on a vessel: across (0..1), how big, whether it stands forward, and whom it faces. */
export interface StageSpot {
  readonly persona: string;
  readonly x: number;
  readonly scale: number;
  readonly front: boolean;
  readonly faces: { readonly kind: "him" } | { readonly kind: "persona"; readonly id: string };
}

/**
 * StagePlan (§2b.5): where each present persona stands on a vessel while one speaks. The speaker faces him, the
 * others face her. Desktop: a row, the speaker a little forward. Mirror: one scene, the speaker in the middle.
 * Phone: the speaker full-screen, the others small along the bottom. A Tessel has one body: the speaker's.
 */
export const stagePlan = (
  vessel: StageVessel,
  present: ReadonlyArray<string>,
  speaker: string | null,
  /** Whom the speaker turns to: another persona present, else him. */
  addressee: string | null = null,
): ReadonlyArray<StageSpot> => {
  const lead = speaker !== null && present.includes(speaker) ? speaker : (present[0] ?? null);
  if (lead === null) return [];
  const her = (persona: string, x: number, scale: number): StageSpot => ({
    persona,
    x,
    scale,
    front: persona === lead,
    faces:
      persona !== lead
        ? { kind: "persona", id: lead }
        : addressee !== null && addressee !== lead && present.includes(addressee)
          ? { kind: "persona", id: addressee }
          : { kind: "him" },
  });
  if (vessel === "tessel") return [her(lead, 0.5, 1)];
  const others = present.filter((p) => p !== lead);
  const across = (i: number, n: number, from: number, to: number) =>
    n <= 1 ? (from + to) / 2 : from + ((to - from) * i) / (n - 1);
  if (vessel === "phone")
    return [
      her(lead, 0.5, 1),
      ...others.map((p, i) => her(p, across(i, others.length, 0.15, 0.85), 0.3)),
    ];
  // the mirror centres the speaker with the others either side; the desktop keeps the room's order
  const order =
    vessel === "mirror"
      ? [
          ...others.filter((_, i) => i % 2 === 1).reverse(),
          lead,
          ...others.filter((_, i) => i % 2 === 0),
        ]
      : present;
  return order.map((p, i) =>
    her(p, across(i, order.length, 0.2, 0.8), p === lead && vessel === "desktop" ? 1.1 : 1),
  );
};

/**
 * What a renderer gives StagePlan once it holds several bodies (body lane 5's multi-body mount): one handle per
 * persona, each placed where its spot says. Nothing implements it yet; StagePlan is wired when the mount lands.
 */
export interface StageMount {
  readonly mount: (
    personas: ReadonlyArray<string>,
  ) => ReadonlyMap<string, { readonly place: (spot: StageSpot) => void }>;
}

/** A plan onto a mount: every present body placed, in one pass. */
export const stageOnto = (
  bodies: ReturnType<StageMount["mount"]>,
  plan: ReadonlyArray<StageSpot>,
): number => {
  let placed = 0;
  for (const spot of plan) {
    const body = bodies.get(spot.persona);
    if (body === undefined) continue;
    body.place(spot);
    placed++;
  }
  return placed;
};

/**
 * GroupTalk's speaker step on a stage: the speaker takes her spot and turns to whoever her line addresses (a persona
 * present named the way he would name one, groupTalk `addressedIn`), else to him; the others turn to her.
 */
export const groupStage = (
  vessel: StageVessel,
  present: ReadonlyArray<string>,
  speaker: string,
  said: string,
  names: Readonly<Record<string, string>>,
): ReadonlyArray<StageSpot> => {
  const others = present.filter((p) => p !== speaker);
  const addressed = addressedIn(
    said,
    { mode: "answer", members: others.map((id) => ({ id })) },
    others.map((id) => ({ id, name: names[id] ?? id, role: "" })),
  );
  return stagePlan(vessel, present, speaker, addressed[0] ?? null);
};
