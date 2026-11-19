/**
 * Rooms (architecture §2b, M-080), the rules alone: where a moment happens, who is in it, how private it is and what
 * each persona there may read of it. A room is threads of each present persona's one self, not a second self. Pure, so
 * GroupTalk, the private layer and the tests judge the same way. Content-neutral: what happens in a room is his.
 */

export type RoomKind = "public" | "one-on-one" | "open" | "event";

/** How far a persona's own record lets her into private rooms (her `privateRooms`, D6). */
export type PrivateRooms = "never" | "one-on-one" | "open";

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

/** He locks, or someone arrives: every private room closes at once, and its personas go back to everyday life. */
export const lockAll = (rooms: ReadonlyArray<Room>): ReadonlyArray<Room> =>
  rooms.filter((r) => r.tier === "public");
