/**
 * The action envelope (B-046): every action, however small, is one event with who did it, how sure we are, what
 * caused it and what it rests on. Pure: ids, capping, the gap detector's rules and the "why" line. The server's
 * ActionLog stores them; private-layer events are sealed whole and only their id crosses into this log.
 */

export type ActorKind =
  | "owner"
  | "member"
  | "guest"
  | "persona"
  | "agent"
  | "rule"
  | "system"
  | "device";

export interface ActionActor {
  readonly kind: ActorKind;
  readonly id?: string;
  /** 0..1: how sure we are it was this actor (Voice ID score, a signed device, 1 for code). */
  readonly certainty: number;
}

export interface ActionEvidence {
  readonly kind: string;
  /** A pointer (row id, file, sha, clip id), never the content itself. */
  readonly ref: string;
}

export interface ActionInput {
  /** Dotted, family first: "tool.call", "model.call", "rpc.call", "device.cmd", "room.wake". */
  readonly kind: string;
  readonly actor: ActionActor;
  readonly cause?: ReadonlyArray<string> | undefined;
  readonly evidence?: ReadonlyArray<ActionEvidence> | undefined;
  readonly persona?: string | null | undefined;
  readonly subject?: string | undefined;
  readonly outcome?: string | undefined;
  readonly data?: unknown;
  /** Sealed whole into the owner's private store; the public log keeps only the id. */
  readonly private?: boolean | undefined;
  /** Set only by a writer that minted its own id (a vessel, the private layer). */
  readonly id?: string | undefined;
  readonly at?: number | undefined;
}

export interface ActionEnvelope {
  readonly id: string;
  /** Epoch ms. */
  readonly at: number;
  readonly kind: string;
  /** The environment (server) that wrote it. */
  readonly origin: string;
  readonly actor: ActionActor;
  readonly cause: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<ActionEvidence>;
  readonly persona: string | null;
  readonly subject: string;
  readonly outcome: string;
  readonly data: unknown;
}

export const PRIVATE_KIND = "private";
export const SUBJECT_MAX = 200;
export const DATA_MAX = 2_000;
const CAUSE_MAX = 8;
const EVIDENCE_MAX = 8;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: sortable by time, unique without coordination, so any vessel or server can mint one. */
export const newEventId = (now: number, random: (n: number) => Uint8Array): string => {
  let time = "";
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32];
  return time + rand;
};

const cap = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const capData = (data: unknown): unknown => {
  if (data === undefined || data === null) return null;
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return { unserialisable: true };
  }
  return json.length > DATA_MAX ? { truncated: cap(json, DATA_MAX) } : data;
};

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** The stored envelope: capped, the fiber's cause merged in, ids deduped. */
export const toEnvelope = (
  input: ActionInput,
  ctx: {
    readonly id: string;
    readonly at: number;
    readonly origin: string;
    readonly cause: ReadonlyArray<string>;
  },
): ActionEnvelope => ({
  id: input.id ?? ctx.id,
  at: input.at ?? ctx.at,
  kind: cap(input.kind, 60),
  origin: ctx.origin,
  actor: {
    kind: input.actor.kind,
    ...(input.actor.id === undefined ? {} : { id: cap(input.actor.id, 120) }),
    certainty: clamp01(input.actor.certainty),
  },
  cause: [...new Set([...ctx.cause, ...(input.cause ?? [])])].slice(-CAUSE_MAX),
  evidence: (input.evidence ?? [])
    .slice(0, EVIDENCE_MAX)
    .map((e) => ({ kind: cap(e.kind, 40), ref: cap(e.ref, 200) })),
  persona: input.persona ?? null,
  subject: cap(input.subject ?? "", SUBJECT_MAX),
  outcome: cap(input.outcome ?? "ok", 40),
  data: capData(input.data),
});

/** What the public log keeps of a private event: the id, the kind "private", the links. Nothing else. */
export const publicPointer = (envelope: ActionEnvelope): ActionEnvelope => ({
  id: envelope.id,
  at: envelope.at,
  kind: PRIVATE_KIND,
  origin: envelope.origin,
  actor: { kind: "system", certainty: 1 },
  cause: envelope.cause,
  evidence: [],
  persona: null,
  subject: "",
  outcome: "",
  data: null,
});

// ── The gap detector: rules over the log that point at bugs, not at people ──

export type FindingRule =
  | "uncaused_state_change"
  | "repeating_failure"
  | "retry_storm"
  | "setting_overwritten"
  | "owner_turn_unverified";

export interface Finding {
  readonly rule: FindingRule;
  /** Stable for the same problem, so one problem is one finding, counted, not a flood. */
  readonly key: string;
  readonly title: string;
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  /** The events that show it; the trace starts here. */
  readonly eventIds: ReadonlyArray<string>;
}

/** Kinds that change state the owner would ask "why?" about; one with no cause and no person behind it is a gap. */
export const STATE_CHANGE_KINDS: ReadonlySet<string> = new Set([
  "session.opened",
  "settings.changed",
  "device.cmd",
  "mood.changed",
  "persona.changed",
  "room.session.opened",
]);

/** Code acting on its own; a person, persona or agent acts for a reason a turn holds, linked as turns gain events. */
const SELF_STARTING: ReadonlySet<ActorKind> = new Set(["system", "rule", "device"]);
const FAILED = new Set(["fail", "failed", "error"]);
const HOUR = 3_600_000;
const SAMPLE_IDS = 5;

const failureKey = (e: ActionEnvelope) => `${e.kind}|${e.subject}`;

/** Pure: the findings in a window of events (any order). Thresholds are deliberately plain; tune from real logs. */
export const findGaps = (events: ReadonlyArray<ActionEnvelope>): ReadonlyArray<Finding> => {
  const sorted = [...events].toSorted((a, b) => a.at - b.at);
  const groups = new Map<string, { rule: FindingRule; title: string; events: ActionEnvelope[] }>();
  const add = (rule: FindingRule, key: string, title: string, e: ActionEnvelope) => {
    const k = `${rule}|${key}`;
    const g = groups.get(k) ?? { rule, title, events: [] };
    g.events.push(e);
    groups.set(k, g);
  };

  for (const e of sorted) {
    if (STATE_CHANGE_KINDS.has(e.kind) && e.cause.length === 0 && SELF_STARTING.has(e.actor.kind)) {
      add(
        "uncaused_state_change",
        `${e.kind}|${e.actor.kind}:${e.actor.id ?? ""}`,
        `${e.kind} by ${e.actor.id ?? e.actor.kind} with no cause recorded`,
        e,
      );
    }
    if (FAILED.has(e.outcome))
      add("repeating_failure", failureKey(e), `${e.kind} keeps failing: ${e.subject}`, e);
    if (e.outcome === "timeout" || e.outcome === "retry")
      add("retry_storm", e.kind, `${e.kind} retrying or timing out`, e);
  }

  // A setting he changed, changed again by something that is not a person within 10 minutes.
  const lastOwnerSet = new Map<string, number>();
  for (const e of sorted) {
    if (e.kind !== "settings.changed") continue;
    if (e.actor.kind === "owner") lastOwnerSet.set(e.subject, e.at);
    else {
      const ownerAt = lastOwnerSet.get(e.subject);
      if (ownerAt !== undefined && e.at - ownerAt < 10 * 60_000)
        add(
          "setting_overwritten",
          e.subject,
          `${e.subject} he set was overwritten by ${e.actor.id ?? e.actor.kind}`,
          e,
        );
    }
  }

  // A voice held as not-him, then him for sure on the same vessel within two minutes: Voice ID missed him.
  const held = sorted.filter((e) => e.kind === "room.voice_id" && e.outcome !== "owner");
  for (const h of held) {
    const vessel = (h.data as { vessel?: string } | null)?.vessel;
    const confirmed = sorted.find(
      (e) =>
        e.at > h.at &&
        e.at - h.at < 120_000 &&
        e.actor.kind === "owner" &&
        e.actor.certainty >= 0.9 &&
        (e.data as { vessel?: string } | null)?.vessel === vessel,
    );
    if (confirmed !== undefined)
      add(
        "owner_turn_unverified",
        vessel ?? "?",
        `Voice ID held him on ${vessel ?? "a vessel"}`,
        h,
      );
  }

  const minCount: Record<FindingRule, number> = {
    uncaused_state_change: 1,
    repeating_failure: 3,
    retry_storm: 3,
    setting_overwritten: 1,
    owner_turn_unverified: 1,
  };
  const out: Finding[] = [];
  for (const [key, g] of groups) {
    const first = g.events[0]!;
    const last = g.events.at(-1)!;
    // Failures and retries count only when they bunch: three within an hour.
    const bunched =
      g.rule === "repeating_failure" || g.rule === "retry_storm"
        ? g.events.some((e, i) => {
            const third = g.events[i + minCount[g.rule] - 1];
            return third !== undefined && third.at - e.at <= HOUR;
          })
        : g.events.length >= minCount[g.rule];
    if (!bunched) continue;
    out.push({
      rule: g.rule,
      key,
      title: g.title,
      count: g.events.length,
      firstAt: first.at,
      lastAt: last.at,
      eventIds: g.events.slice(-SAMPLE_IDS).map((e) => e.id),
    });
  }
  return out.toSorted((a, b) => b.lastAt - a.lastAt);
};

// ── "Why did that happen?": one line per link, newest first ──

const actorLine = (a: ActionActor) => {
  const who = a.id ?? a.kind;
  return a.certainty < 1 ? `${who} (${Math.round(a.certainty * 100)}% sure)` : who;
};

/** A cause chain (the event first, then what caused it) as short lines a voice can read. */
export const whyLines = (chain: ReadonlyArray<ActionEnvelope>): ReadonlyArray<string> =>
  chain.map((e, i) =>
    e.kind === PRIVATE_KIND
      ? `${i === 0 ? "" : "because "}a private event`
      : `${i === 0 ? "" : "because "}${actorLine(e.actor)} did ${e.kind}${
          e.subject === "" ? "" : `: ${e.subject}`
        }${e.outcome === "ok" ? "" : ` (${e.outcome})`}${e.cause.length === 0 && i === chain.length - 1 ? ", with no recorded cause" : ""}`,
  );
