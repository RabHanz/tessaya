/**
 * Where each household member is, from every signal the vessels give (B-043): pure, so fusion, decay and routing are
 * tested once and every vessel reads the same answer. A signal's weight and half-life are data: a new source is a row
 * in PRESENCE_SOURCES, never new code. It is a guess, never a tracker: kept in memory, never camera unless opted in.
 */

export interface PresenceSignal {
  /** Whose it is (a member, or a guest's people-graph id); null when someone is there but not who (a Tessel picked up). */
  readonly member: string | null;
  /** `member` is a guest's people-graph id: present like anyone, never followed or named as a member. */
  readonly guest?: boolean;
  /** A key of PRESENCE_SOURCES. */
  readonly source: string;
  /** The vessel it places them at; null when it says "around" but not where (their phone connected). */
  readonly vessel: string | null;
  readonly at: number;
}

export interface PresenceSource {
  /** How sure one fresh signal makes us, 0..1. */
  readonly weight: number;
  readonly halfLifeMinutes: number;
  /** A newer signal of this source cancels these sources' older signals for the same member (they stepped away). */
  readonly cancels?: ReadonlyArray<string>;
  /** Evidence they are less available, not more: its strength scales their whole estimate down (a meeting). */
  readonly lowers?: true;
  /** Said in Settings and by voice as the reason. */
  readonly says: string;
}

/** Signals that say "at home" without a vessel: leaving home cancels them all. */
const AT_HOME = ["home", "lan", "haHome"];

export const PRESENCE_SOURCES: Readonly<Record<string, PresenceSource>> = {
  // A voice verified on its own audio: about 10 minutes to the follow bar, about 30 to "around".
  voice: { weight: 0.95, halfLifeMinutes: 15, says: "heard your voice" },
  typed: { weight: 0.9, halfLifeMinutes: 10, says: "you typed on your own device" },
  device: { weight: 0.6, halfLifeMinutes: 2, says: "your own device is connected" },
  handled: { weight: 0.6, halfLifeMinutes: 3, says: "someone picked it up or moved it" },
  // Connected stays true until it changes, so it fades slowly; taking them off cancels it.
  headphones: { weight: 0.7, halfLifeMinutes: 30, says: "your headphones are connected" },
  headphonesOff: {
    weight: 0,
    halfLifeMinutes: 1,
    cancels: ["headphones"],
    says: "your headphones disconnected",
  },
  // His phone's app holds the phone route on the Tessel's own network: home, near that Tessel.
  phone: { weight: 0.5, halfLifeMinutes: 20, says: "your phone is on her network" },
  phoneAway: {
    weight: 0,
    halfLifeMinutes: 1,
    cancels: ["phone"],
    says: "your phone left her network",
  },
  deskAway: {
    weight: 0,
    halfLifeMinutes: 1,
    cancels: ["typed"],
    says: "your desktop locked or slept",
  },
  deskIdle: {
    weight: 0,
    halfLifeMinutes: 1,
    cancels: ["typed"],
    says: "your desktop has been idle a while",
  },
  // The app in front of them on their phone; put away, they are no longer at it.
  phoneApp: { weight: 0.85, halfLifeMinutes: 10, says: "you were using the app on your phone" },
  phoneAppAway: {
    weight: 0,
    halfLifeMinutes: 1,
    cancels: ["phoneApp"],
    says: "you put the app away",
  },
  // Their phone's geofence (opt-in): it changes only at the door, so it fades slowly.
  home: { weight: 0.55, halfLifeMinutes: 120, says: "your phone says you're home" },
  away: { weight: 0, halfLifeMinutes: 1, cancels: AT_HOME, says: "your phone says you left home" },
  // One of their own devices on the home network (this machine's neighbour table, or the router via Home Assistant).
  lan: { weight: 0.5, halfLifeMinutes: 15, says: "your device is on the home network" },
  haHome: { weight: 0.6, halfLifeMinutes: 30, says: "Home Assistant has you home" },
  haAway: { weight: 0, halfLifeMinutes: 1, cancels: AT_HOME, says: "Home Assistant has you away" },
  // A room's occupancy sensor: someone is at the vessels in that room, not who.
  occupied: { weight: 0.5, halfLifeMinutes: 5, says: "a room sensor sees someone" },
  // Only for a member who turned it on; seen, never kept beyond this estimate.
  camera: { weight: 0.9, halfLifeMinutes: 5, says: "the camera saw you (you turned this on)" },
  meeting: {
    weight: 0.5,
    halfLifeMinutes: 10,
    lowers: true,
    says: "your calendar has you in a meeting",
  },
  outOfOffice: {
    weight: 0.7,
    halfLifeMinutes: 30,
    lowers: true,
    says: "your calendar has you away",
  },
};

/** Confidence bars: around at all (keeps private output careful), followed to a vessel, and alone with her there. */
export const PRESENCE_BARS = { around: 0.25, present: 0.6, alone: 0.75 } as const;
/** Forgotten after a day: presence is a state, never a history. */
export const PRESENCE_FORGET_MS = 24 * 60 * 60_000;

export interface PresenceEvidence {
  readonly source: string;
  readonly vessel: string | null;
  readonly minutesAgo: number;
  /** Its weight after decay, 0..1. */
  readonly strength: number;
}

export interface MemberPresence {
  readonly member: string;
  readonly guest: boolean;
  /** Around at all, 0..1. */
  readonly confidence: number;
  /** The vessel they are most likely nearest, and how sure. */
  readonly nearest: { readonly vessel: string; readonly confidence: number } | null;
  readonly lastSeen: {
    readonly at: number;
    readonly source: string;
    readonly vessel: string | null;
  } | null;
  /** Strongest first. */
  readonly evidence: ReadonlyArray<PresenceEvidence>;
}

export interface PresenceEstimate {
  readonly members: ReadonlyArray<MemberPresence>;
  /** How sure anyone at all is at each vessel, members and unknown alike. */
  readonly occupied: ReadonlyMap<string, number>;
}

const strengthOf = (s: PresenceSignal, now: number, sources: typeof PRESENCE_SOURCES) => {
  const rule = sources[s.source];
  if (rule === undefined || now - s.at > PRESENCE_FORGET_MS) return 0;
  return rule.weight * 0.5 ** (Math.max(0, now - s.at) / 60_000 / rule.halfLifeMinutes);
};
/** One piece of evidence in words, for Settings and her answer ("heard your voice on Tessel, 3 min ago"). */
export const presenceReason = (e: PresenceEvidence, vesselName: string | null): string =>
  `${PRESENCE_SOURCES[e.source]?.says ?? e.source}${vesselName === null ? "" : ` on ${vesselName}`}, ${e.minutesAgo} min ago`;

/** Independent signals: the chance at least one is right. */
const anyOf = (ps: ReadonlyArray<number>) => 1 - ps.reduce((left, p) => left * (1 - p), 1);

export const fusePresence = (
  signals: ReadonlyArray<PresenceSignal>,
  now: number,
  sources: typeof PRESENCE_SOURCES = PRESENCE_SOURCES,
): PresenceEstimate => {
  const live = signals.filter((s) => {
    if (now - s.at > PRESENCE_FORGET_MS) return false;
    if (s.member === null) return true;
    // Gone from there: a newer cancelling signal of theirs drops this one.
    return !signals.some(
      (c) =>
        c.member === s.member && c.at >= s.at && sources[c.source]?.cancels?.includes(s.source),
    );
  });
  const byMember = new Map<string, Array<PresenceSignal>>();
  const atVessel = new Map<string, Array<number>>();
  for (const s of live) {
    const strength = strengthOf(s, now, sources);
    if (s.vessel !== null && strength > 0)
      atVessel.set(s.vessel, [...(atVessel.get(s.vessel) ?? []), strength]);
    if (s.member !== null) byMember.set(s.member, [...(byMember.get(s.member) ?? []), s]);
  }
  const members: Array<MemberPresence> = [];
  for (const [member, mine] of byMember) {
    const evidence = mine
      .map((s) => ({
        source: s.source,
        vessel: s.vessel,
        minutesAgo: Math.floor(Math.max(0, now - s.at) / 60_000),
        strength: strengthOf(s, now, sources),
      }))
      .toSorted((a, b) => b.strength - a.strength);
    const lowered = (e: PresenceEvidence) => sources[e.source]?.lowers === true;
    // A meeting or a trip on their calendar scales the rest down; it never places them.
    const damp = evidence.filter(lowered).reduce((left, e) => left * (1 - e.strength), 1);
    const perVessel = new Map<string, Array<number>>();
    for (const e of evidence)
      if (e.vessel !== null && e.strength > 0 && !lowered(e))
        perVessel.set(e.vessel, [...(perVessel.get(e.vessel) ?? []), e.strength]);
    let nearest: MemberPresence["nearest"] = null;
    for (const [vessel, ps] of perVessel) {
      const confidence = anyOf(ps) * damp;
      // On a tie the vessel noted last wins: they moved there.
      if (nearest === null || confidence >= nearest.confidence) nearest = { vessel, confidence };
    }
    const newest = mine
      .filter((s) => (sources[s.source]?.weight ?? 0) > 0 && sources[s.source]?.lowers !== true)
      .toSorted((a, b) => b.at - a.at)[0];
    members.push({
      member,
      guest: mine.some((s) => s.guest === true),
      confidence: anyOf(evidence.filter((e) => !lowered(e)).map((e) => e.strength)) * damp,
      nearest,
      lastSeen:
        newest === undefined
          ? null
          : { at: newest.at, source: newest.source, vessel: newest.vessel },
      evidence: evidence.filter((e) => e.strength > 0),
    });
  }
  return {
    members: members.toSorted((a, b) => b.confidence - a.confidence),
    occupied: new Map([...atVessel].map(([v, ps]) => [v, anyOf(ps)])),
  };
};

/**
 * Everyone placed at this vessel past `bar` (members and guests), surest first: the one answer to "who is at this
 * vessel" for the private-output gate, the mood's face at rest and "the person I just heard".
 */
export const peopleAt = (
  estimate: PresenceEstimate,
  vessel: string,
  bar: number = PRESENCE_BARS.around,
): ReadonlyArray<MemberPresence> =>
  estimate.members
    .filter((m) => m.nearest?.vessel === vessel && m.nearest.confidence >= bar)
    // Reversed first so a full tie (two voices in the same millisecond) goes to the one noted last.
    .toReversed()
    .toSorted(
      (a, b) =>
        b.nearest!.confidence - a.nearest!.confidence ||
        (b.lastSeen?.at ?? 0) - (a.lastSeen?.at ?? 0),
    );

/**
 * What she may say unprompted: `personal` is her own initiative (a job's news, a nudge); `reminder`, `broadcast` and
 * `planned` are what someone set up, so they still land when the person can't be placed.
 */
export type ProactiveKind = "personal" | "reminder" | "broadcast" | "planned";

export type ProactiveRoute =
  | { readonly action: "speak"; readonly vessel: string; readonly why: string }
  /** Not out loud: a quiet card on their own device, or held for when they are next seen. */
  | { readonly action: "quiet"; readonly why: string };

export const routeProactive = (input: {
  readonly kind: ProactiveKind;
  /** Who it is for; null for everyone. */
  readonly member: string | null;
  /** The vessel it was set up on or asked from, if any. */
  readonly origin: string | null;
  readonly estimate: PresenceEstimate;
  /** Vessels that can speak now. */
  readonly speakers: ReadonlySet<string>;
  /** Their "follow me" (on unless they turned it off): her lines go to whichever vessel they are nearest. */
  readonly follow: boolean;
}): ProactiveRoute => {
  const { kind, origin, speakers } = input;
  const me = input.estimate.members.find((m) => m.member === input.member);
  const near = me?.nearest;
  const placed =
    near !== null &&
    near !== undefined &&
    near.confidence >= PRESENCE_BARS.present &&
    speakers.has(near.vessel);
  if (placed && (input.follow || near.vessel === origin))
    return { action: "speak", vessel: near.vessel, why: "they are nearest it" };
  if (kind === "personal")
    return {
      action: "quiet",
      why:
        me === undefined || me.confidence < PRESENCE_BARS.around
          ? "they are not around"
          : "they can't be placed at a vessel",
    };
  // What someone set up keeps its own rule: on the vessel it was set up on.
  if (origin !== null && speakers.has(origin))
    return { action: "speak", vessel: origin, why: "where it was set up" };
  return { action: "quiet", why: "no vessel to say it on" };
};

/** A member as the feeders see them: their name and their own devices' names or addresses (the `devices` preference). */
export interface PresenceMember {
  readonly id: string;
  readonly name: string;
  readonly devices: ReadonlyArray<string>;
}

/** "Rab's iPhone, aa:bb:cc:dd:ee:ff; AirPods" → lowercased names and addresses, MACs in one spelling. */
export const devicesOf = (preference: string | undefined): ReadonlyArray<string> =>
  (preference ?? "")
    .split(/[,;\n]+/)
    .map((d) => d.trim().toLowerCase().replaceAll("-", ":"))
    .filter((d) => d.length >= 2);

const ownsDevice = (m: PresenceMember, ...said: ReadonlyArray<string | null | undefined>) =>
  said.some((s) => {
    const t = s?.trim().toLowerCase().replaceAll("-", ":") ?? "";
    return t !== "" && m.devices.some((d) => t === d || t.includes(d));
  });

/** Whose device this is (a headphone's address or name, a router's tracker): its owner, else null. */
export const ownerOfDevice = (
  members: ReadonlyArray<PresenceMember>,
  ...said: ReadonlyArray<string | null | undefined>
): string | null => members.find((m) => ownsDevice(m, ...said))?.id ?? null;

/** Members whose own devices are in this machine's neighbour table (`/proc/net/arp`): one `lan` signal each. */
export const lanSignals = (
  macs: ReadonlyArray<string>,
  members: ReadonlyArray<PresenceMember>,
  at: number,
): ReadonlyArray<PresenceSignal> =>
  members
    .filter((m) => ownsDevice(m, ...macs))
    .map((m) => ({ member: m.id, source: "lan", vessel: null, at }));

/** The MACs of reachable neighbours in `/proc/net/arp` (flags 0x2: complete). */
export const arpMacs = (table: string): ReadonlyArray<string> =>
  table
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f[2] === "0x2" && f[3] !== undefined && f[3] !== "00:00:00:00:00:00")
    .map((f) => f[3]!.toLowerCase());

export interface PresenceEntity {
  readonly entityId: string;
  readonly name: string;
  readonly area: string | null;
  readonly state: string;
  readonly attributes: Readonly<Record<string, string>>;
}

const OCCUPANCY = new Set(["occupancy", "presence", "motion"]);
const AWAY_EVENT = /\b(out of office|ooo|vacation|holiday|leave|travel|trip|flight|away|abroad)\b/i;
const nameIn = (m: PresenceMember, text: string) =>
  new RegExp(`\\b${m.name.split(/\s+/)[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
    text,
  );

/**
 * Home Assistant's view of who is where: a `person` home or away, a router's `device_tracker` for a member's own
 * device, an occupancy sensor at the vessels in its room, and a calendar event now (a meeting, or out of office).
 * `owner` gets the calendars that name no member.
 */
export const homeAssistantSignals = (input: {
  readonly entities: ReadonlyArray<PresenceEntity>;
  readonly members: ReadonlyArray<PresenceMember>;
  readonly vessels: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly owner: string;
  readonly at: number;
}): ReadonlyArray<PresenceSignal> => {
  const { members, at } = input;
  const out: Array<PresenceSignal> = [];
  for (const e of input.entities) {
    const domain = e.entityId.split(".")[0];
    if (domain === "person") {
      const m = members.find(
        (x) => x.name.toLowerCase() === e.name.toLowerCase() || nameIn(x, e.name),
      );
      if (m !== undefined && e.state !== "unavailable" && e.state !== "unknown")
        out.push({
          member: m.id,
          source: e.state === "home" ? "haHome" : "haAway",
          vessel: null,
          at,
        });
    } else if (domain === "device_tracker" && e.state === "home") {
      const member = ownerOfDevice(members, e.name, e.entityId.slice("device_tracker.".length));
      if (member !== null) out.push({ member, source: "lan", vessel: null, at });
    } else if (
      domain === "binary_sensor" &&
      e.state === "on" &&
      OCCUPANCY.has(e.attributes["device_class"] ?? "") &&
      e.area !== null
    ) {
      // shortcut: a vessel is in a room when its name says so ("Office Tessel"); a vessel area setting when one exists.
      const area = e.area.toLowerCase();
      for (const v of input.vessels)
        if (v.name.toLowerCase().includes(area))
          out.push({ member: null, source: "occupied", vessel: v.id, at });
    } else if (domain === "calendar" && e.state === "on") {
      const said = `${e.attributes["message"] ?? ""}`;
      const member = members.find((x) => nameIn(x, e.name))?.id ?? input.owner;
      out.push({
        member,
        source: AWAY_EVENT.test(said) ? "outOfOffice" : "meeting",
        vessel: null,
        at,
      });
    }
  }
  return out;
};
