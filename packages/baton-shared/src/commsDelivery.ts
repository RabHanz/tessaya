/**
 * Where one note goes (COMMS-DESIGN §2.2, §2.4, §5.3): pure, so the ladder is tested once. A person is followed: the
 * vessel they were last verified at (if lately and awake), then their own devices; otherwise it waits for them. A
 * room or vessel stays put. Quiet hours and do-not-disturb keep speakers silent and screens quiet, except an adult's
 * urgent note.
 */
import type { CommsNote } from "@t3tools/baton-contracts";

import { breaksQuiet, type CommsCaps, GROUP_ROLES, parseAddress } from "./comms.ts";

export interface DeliveryMember {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

export interface DeliveryVessel {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly caps: CommsCaps;
  /** The member it belongs to (their phone, their desktop); null for a shared room vessel. */
  readonly personalOf: string | null;
}

export interface DeliveryPresence {
  readonly member: string;
  /** The vessel their voice was last verified at, and how long ago. */
  readonly vessel: string;
  readonly minutesAgo: number;
}

export interface DeliveryTarget {
  readonly vessel: string;
  /** Who it is for there; null for a room or everyone. */
  readonly person: string | null;
  readonly forName: string | null;
  readonly personal: boolean;
  /** Shown without a sound (quiet hours or do-not-disturb). */
  readonly silent: boolean;
}

export interface DeliveryPlan {
  readonly targets: ReadonlyArray<DeliveryTarget>;
  /** Recipients it reached nowhere yet: it waits for their next verified presence. */
  readonly waiting: ReadonlyArray<string>;
}

/** A person is followed to the vessel they were verified at within this long. */
export const FOLLOW_MINUTES = 10;

const speaks = (v: DeliveryVessel) => v.online && v.caps.audioOut;
const shows = (v: DeliveryVessel) => v.online && (v.caps.display === "screen" || v.caps.push);

export const planDelivery = (input: {
  readonly note: Pick<CommsNote, "kind" | "from" | "to" | "urgency">;
  readonly senderRole: string | null;
  readonly members: ReadonlyArray<DeliveryMember>;
  readonly vessels: ReadonlyArray<DeliveryVessel>;
  readonly presence: ReadonlyArray<DeliveryPresence>;
  /** The household's quiet hours are on now. */
  readonly quietNow: boolean;
  /** Members with do-not-disturb on now. */
  readonly dnd: ReadonlySet<string>;
}): DeliveryPlan => {
  const { note, members, vessels } = input;
  const loud = breaksQuiet(note.urgency, input.senderRole);
  const hushed = (person: string | null) =>
    !loud && (input.quietNow || (person !== null && input.dnd.has(person)));
  const targets = new Map<string, DeliveryTarget>();
  const add = (v: DeliveryVessel, person: DeliveryMember | null) => {
    if (targets.has(v.id)) return;
    const silent = hushed(person?.id ?? null);
    // A shared speaker never sounds in quiet hours; a screen still shows the note, silently.
    if (silent && v.personalOf === null) return;
    targets.set(v.id, {
      vessel: v.id,
      person: person?.id ?? null,
      forName: person?.name ?? null,
      personal: v.personalOf !== null,
      silent,
    });
  };

  const people = new Map<string, DeliveryMember>();
  const shared: Array<DeliveryVessel> = [];
  for (const address of note.to) {
    const t = parseAddress(address);
    if (t === null) continue;
    if (t.kind === "person") {
      const m = members.find((x) => x.id.toLowerCase() === t.id);
      if (m !== undefined) people.set(m.id, m);
    } else if (t.kind === "group" || t.kind === "all") {
      const roles = t.kind === "all" ? null : (GROUP_ROLES[t.id] ?? []);
      for (const m of members)
        if (m.role !== "guest" && (roles === null || roles.includes(m.role))) people.set(m.id, m);
      // A broadcast to everyone plays in every room at once.
      if (t.kind === "all" && note.kind === "announce")
        shared.push(...vessels.filter((v) => v.personalOf === null && speaks(v)));
    } else {
      // shortcut: a room is the vessels whose id or name carries its name; rooms become registry data with HOUSEHOLD §7.
      const matches = vessels.filter((v) =>
        t.kind === "vessel"
          ? v.id.toLowerCase() === t.id
          : `${v.id} ${v.name}`
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .includes(t.id),
      );
      shared.push(...matches.filter((v) => speaks(v) || shows(v)));
    }
  }
  if (note.from !== null) people.delete(note.from);

  for (const v of shared) add(v, null);
  const waiting: Array<string> = [];
  const rooms = vessels.filter((v) => v.personalOf === null && speaks(v));
  for (const person of people.values()) {
    const seen = input.presence.find(
      (p) => p.member === person.id && p.minutesAgo <= FOLLOW_MINUTES,
    );
    const there = rooms.find((v) => v.id === seen?.vessel);
    if (there !== undefined) add(there, person);
    // An announcement for someone we can't place plays in every room (§2.6).
    else if (note.kind === "announce") for (const v of rooms) add(v, null);
    for (const v of vessels) if (v.personalOf === person.id && shows(v)) add(v, person);
    const reached = [...targets.values()].some(
      (t) =>
        t.person === person.id || (note.kind === "announce" && t.person === null && !t.personal),
    );
    if (!reached) waiting.push(person.id);
  }
  return { targets: [...targets.values()], waiting };
};
