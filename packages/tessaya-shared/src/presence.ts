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
  /** Said in Settings and by voice as the reason. */
  readonly says: string;
}

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
    const perVessel = new Map<string, Array<number>>();
    for (const e of evidence)
      if (e.vessel !== null && e.strength > 0)
        perVessel.set(e.vessel, [...(perVessel.get(e.vessel) ?? []), e.strength]);
    let nearest: MemberPresence["nearest"] = null;
    for (const [vessel, ps] of perVessel) {
      const confidence = anyOf(ps);
      // On a tie the vessel noted last wins: they moved there.
      if (nearest === null || confidence >= nearest.confidence) nearest = { vessel, confidence };
    }
    const newest = mine
      .filter((s) => (sources[s.source]?.weight ?? 0) > 0)
      .toSorted((a, b) => b.at - a.at)[0];
    members.push({
      member,
      guest: mine.some((s) => s.guest === true),
      confidence: anyOf(evidence.map((e) => e.strength)),
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
