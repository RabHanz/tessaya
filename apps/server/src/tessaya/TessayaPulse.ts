/**
 * Her pulse (B-003, M-027): the server owns noticing. A sense pass each minute (code only) folds the Record, presence,
 * mood, coming-up, due commitments and patterns into one digest; a review on the adaptive beat asks one fresh, capped
 * one-shot (Haiku first) and gates it in code. Each review is a Record row `kind: "pulse"`: the decision log.
 */
import { DEFAULT_TESSAYA_PULSE } from "@t3tools/contracts";
import { inQuietHours, quietHoursOf } from "@t3tools/tessaya-shared/comms";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { diagnose, healthNotice } from "@t3tools/tessaya-shared/health";
import { DEFAULT_POLICY } from "@t3tools/tessaya-shared/initiative";
import { PRESENCE_BARS } from "@t3tools/tessaya-shared/presence";
import {
  addToDigest,
  eventFromRecord,
  gateDecision,
  learnFrom,
  needsEscalation,
  noticePatterns,
  patternEvents,
  PULSE_CATEGORIES,
  PULSE_CHEAP_MODEL,
  PULSE_REACTIONS,
  PULSE_SYSTEM,
  pulsePrompt,
  rulesDecision,
  PulseDecisionSchema,
  reviewDue,
  SENSE_MS,
  type PulseDecision,
  type PulseEvent,
  type PulseLearned,
  type PulseLevel,
  type PulsePattern,
} from "@t3tools/tessaya-shared/pulse";
import {
  EMPTY_STATS,
  findings,
  keyOfRow,
  observe,
  type LocalClock,
  type PatternStats,
} from "@t3tools/tessaya-shared/patterns";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { HomeDevices } from "../home/HomeDevices.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { BrainUsage, periodStarts } from "./BrainUsage.ts";
import { houseZone } from "./houseZone.ts";
import { LATE_RUN_MS } from "@t3tools/tessaya-shared/upcoming";
import { readDndUntil, readQuietHours } from "./quietHours.ts";
import { TessayaCommitmentService } from "./TessayaCommitmentService.ts";
import * as TessayaHealth from "./TessayaHealth.ts";
import { ProblemReports } from "./ProblemReports.ts";
import { TessayaMemoryService } from "./TessayaMemoryService.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { TessayaPeople } from "./TessayaPeople.ts";
import { TessayaPhoneInbox } from "./TessayaPhoneInbox.ts";
import { TessayaPresence, whereToSay } from "./TessayaPresence.ts";
import { isBrain } from "./BrainHost.ts";
import { TessayaRecordService } from "./TessayaRecordService.ts";
import { TessayaTurn } from "./TessayaTurn.ts";
import { TurnLiveContext } from "./TurnLiveContext.ts";

export const PULSE_STATE_KEY = "pulse.state";
const DAY = 86_400_000;
/** A line she said with no reaction after this counts as ignored (a weak signal). */
const IGNORED_AFTER_MS = 30 * 60_000;
const PATTERNS_EVERY_MS = 6 * 3_600_000;

const PulseState = Schema.Struct({
  lastSense: Schema.Number,
  lastRowId: Schema.Number,
  lastReview: Schema.Number,
  lastPatterns: Schema.Number,
  digest: Schema.Array(Schema.Any),
  /** Event id -> when it was reviewed, so a standing thing (a date coming up) is raised once. */
  reviewed: Schema.Record(Schema.String, Schema.Number),
  learned: Schema.Record(Schema.String, Schema.Number),
  surfaced: Schema.Record(Schema.String, Schema.Number),
  spoken: Schema.Array(Schema.Number),
  /** Lines said and waiting for his reaction. */
  awaiting: Schema.Array(
    Schema.Struct({ id: Schema.String, category: Schema.String, at: Schema.Number }),
  ),
  /** Member -> nearest vessel at the last sense, and her mood then: the diffs that make events. */
  near: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  mood: Schema.NullOr(Schema.String),
  /** Her own health's worst cause and how many senses it has held (healthNotice). */
  health: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ key: Schema.String, since: Schema.Number, count: Schema.Number }),
    ),
  ),
});
export type PulseState = Omit<typeof PulseState.Type, "digest" | "learned"> & {
  readonly digest: ReadonlyArray<PulseEvent>;
  readonly learned: PulseLearned;
};

export const emptyPulseState = (now: number): PulseState => ({
  lastSense: now,
  lastRowId: 0,
  lastReview: 0,
  lastPatterns: 0,
  digest: [],
  reviewed: {},
  learned: {},
  surfaced: {},
  spoken: [],
  awaiting: [],
  near: {},
  mood: null,
});

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(PulseState));

const readState = Effect.fn("TessayaPulse.readState")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* sql<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${PULSE_STATE_KEY}`.pipe(Effect.orDie);
  const decoded = rows[0] === undefined ? Option.none() : decodeState(rows[0].value);
  return Option.isSome(decoded) ? (decoded.value as PulseState) : emptyPulseState(now);
});

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const toJson = (value: unknown) => encodeJson(value).pipe(Effect.orDie);

const writeState = Effect.fn("TessayaPulse.writeState")(function* (state: PulseState) {
  const sql = yield* SqlClient.SqlClient;
  const value = yield* toJson(state);
  yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${PULSE_STATE_KEY}, ${value}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
    Effect.orDie,
  );
});

export const PULSE_STATS_KEY = "pulse.stats";

const decodeJson = Schema.decodeUnknownOption(Json);

const readStats = Effect.fn("TessayaPulse.readStats")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${PULSE_STATS_KEY}`.pipe(Effect.orDie);
  // Our own JSON; a bad copy starts afresh.
  const decoded = rows[0] === undefined ? Option.none() : decodeJson(rows[0].value);
  return Option.isSome(decoded) ? (decoded.value as PatternStats) : EMPTY_STATS;
});

const writeStats = Effect.fn("TessayaPulse.writeStats")(function* (stats: PatternStats) {
  const sql = yield* SqlClient.SqlClient;
  const value = yield* toJson(stats);
  yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${PULSE_STATS_KEY}, ${value}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
    Effect.orDie,
  );
});

/** His local weekday and hour for a time, in the house's zone. */
const localClock = (zone: string): LocalClock => {
  const f = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
    timeZone: zone,
  });
  return (at) => {
    const parts = f.formatToParts(at);
    const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
    return {
      weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd),
      hour: Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24,
    };
  };
};

/** A reminder that came due while her brain was down says so, so she can say it is late. */
export const dueText = (text: string, due: number, now: number, zone: string): string =>
  now - due <= LATE_RUN_MS
    ? `Due: ${text}`
    : `Due at ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(due)}, late because Tessaya was offline then: ${text}`;

const settingsNow = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(service)) return { pulse: DEFAULT_TESSAYA_PULSE, level: "calm" as PulseLevel };
  const s = yield* service.value.getSettings.pipe(Effect.option);
  return Option.isNone(s)
    ? { pulse: DEFAULT_TESSAYA_PULSE, level: "calm" as PulseLevel }
    : { pulse: s.value.tessayaPulse, level: s.value.companionMotion };
});

const isoOf = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

/** A pattern lasts a month in memory unless seen again; its id is the provenance, its words the evidence. */
export const patternFact = (p: PulsePattern, now: number) => ({
  kind: "fact" as const,
  text: `A pattern noticed (confidence ${p.confidence.toFixed(2)}): ${p.text}`,
  source: "job" as const,
  sourceRef: `pulse:${p.id}`,
  confidence: p.confidence,
  expiresAt: isoOf(now + 30 * DAY),
});

/** One sense pass: new events into the digest. Code only; never a model call. */
export const sense = Effect.fn("TessayaPulse.sense")(function* (state: PulseState) {
  const now = yield* Clock.currentTimeMillis;
  const events: Array<PulseEvent> = [];
  const zone = yield* houseZone();
  const clock = localClock(zone);
  let stats = yield* readStats();
  let lastRowId = state.lastRowId;
  let learned = state.learned;
  let awaiting = state.awaiting;
  const statsBefore = stats;
  const record = yield* Effect.serviceOption(TessayaRecordService);
  if (Option.isSome(record)) {
    const rows = yield* record.value.query({ since: isoOf(state.lastSense - 1_000), limit: 200 });
    // Oldest first, so the statistics see the order things happened in; each row once, by its id.
    for (const row of rows.toReversed()) {
      if (row.id <= lastRowId) continue;
      lastRowId = row.id;
      // His reactions arrive as Record rows (`react`): the outcome signal the gate learns from.
      if (row.kind === "pulse" && (row.outcome === "liked" || row.outcome === "told_off")) {
        const category = PULSE_CATEGORIES.find((c) => row.detail.includes(`category: ${c}`));
        if (category !== undefined) learned = learnFrom(learned, category, row.outcome);
        awaiting = awaiting.filter((a) => a.id !== row.ref);
        continue;
      }
      const e = eventFromRecord(row);
      if (e !== null) events.push(e);
      const key = keyOfRow(row);
      if (key !== null) stats = observe(stats, key, Date.parse(row.at), clock);
    }
  }
  // His answer to an ask's card (the one inbox: phone, desktop, voice): yes and stop are reactions, not now drops it.
  const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
  if (Option.isSome(inbox))
    for (const a of awaiting) {
      const answer = yield* inbox.value.promptAnswer(a.id);
      if (answer === null) continue;
      awaiting = awaiting.filter((w) => w.id !== a.id);
      if (answer === ASK_LATER || Option.isNone(record)) continue;
      const row = (yield* record.value.query({ kind: "pulse", limit: 200 })).find(
        (r) => r.ref === a.id && r.outcome === "ask",
      );
      if (row === undefined) continue;
      yield* react(answer === ASK_YES ? "liked" : "stop", row.id);
      const live = yield* Effect.serviceOption(TurnLiveContext);
      if (answer === ASK_YES && Option.isSome(live))
        yield* live.value.inject({
          key: `pulse:${a.id}`,
          source: "pulse",
          expiresAfterTurns: 2,
          line: `He just answered yes to your question "${row.subject}": follow it up if it fits.`,
        });
    }
  // Who is near which vessel: an arrival or a leaving is an event about that person.
  const presence = yield* Effect.serviceOption(TessayaPresence);
  const near: Record<string, string | null> = {};
  if (Option.isSome(presence)) {
    const estimate = yield* presence.value.estimate();
    for (const m of estimate.members) {
      const at = m.confidence >= PRESENCE_BARS.around ? (m.nearest?.vessel ?? "around") : null;
      near[m.member] = at;
      const was = state.near[m.member] ?? null;
      if ((was === null) !== (at === null)) {
        // Back after a plan they told her (a nap, a trip): worth one warm word asking how it went.
        const plan =
          at === null || m.guest
            ? undefined
            : (yield* Effect.serviceOption(TessayaMood).pipe(
                Effect.flatMap((mood) =>
                  Option.isNone(mood)
                    ? Effect.succeed(null)
                    : mood.value.view(undefined, zone, m.member),
                ),
              ))?.shared?.find((x) => x.kind === "plan");
        events.push({
          id: `presence:${m.member}:${at ?? "gone"}:${Math.floor(now / 600_000)}`,
          category: "people",
          text:
            at === null
              ? `${m.member} is no longer around`
              : `${m.member} just arrived${at === "around" ? "" : ` near ${at}`}${plan === undefined ? "" : `, back after their plan: ${JSON.stringify(plan.text)}`}`,
          at: now,
          member: m.member,
          weight: at === null ? 15 : plan === undefined ? 35 : 55,
          urgent: false,
          told: false,
        });
      }
    }
  }
  const moodService = yield* Effect.serviceOption(TessayaMood);
  let mood = state.mood;
  if (Option.isSome(moodService)) {
    const view = yield* moodService.value.view(undefined);
    mood = view.label;
    if (state.mood !== null && state.mood !== mood)
      events.push({
        id: `mood:${mood}:${Math.floor(now / 3_600_000)}`,
        category: "mood",
        text: `Her mood moved from ${state.mood} to ${mood}${view.why[0] === undefined ? "" : `: ${view.why[0]}`}`,
        at: now,
        member: null,
        weight: 20,
        urgent: false,
        told: false,
      });
  }
  const turn = yield* Effect.serviceOption(TessayaTurn);
  if (Option.isSome(turn))
    for (const c of yield* turn.value.comingUp)
      events.push({
        id: `cal:${c.kind}:${c.text}:${c.when}`,
        category: "calendar",
        text: `Coming up ${c.when}: ${c.text}`,
        at: now,
        member: null,
        weight: 35,
        urgent: false,
        told: false,
      });
  const commitments = yield* Effect.serviceOption(TessayaCommitmentService);
  if (Option.isSome(commitments))
    for (const c of yield* commitments.value.list)
      if (c.status === "open" && c.due !== null && c.due <= now)
        events.push({
          id: `commit:${c.id}`,
          category: "reminders",
          text: dueText(c.text, c.due, now, zone),
          at: c.due,
          member: null,
          weight: 75,
          urgent: true,
          told: false,
        });
  let lastPatterns = state.lastPatterns;
  if (now - state.lastPatterns >= PATTERNS_EVERY_MS && Option.isSome(record)) {
    lastPatterns = now;
    const since = isoOf(now - 14 * DAY);
    // The server's watch and the desktop's notices both say when a session stalled or failed.
    const stalls = [
      ...(yield* record.value.query({ kind: "watch", since, limit: 500 })),
      ...(yield* record.value.query({ kind: "notice", since, limit: 500 })),
    ]
      .filter((r) => ["stalled", "failed", "session_stalled", "session_failed"].includes(r.outcome))
      .map((r) => Date.parse(r.at));
    const people = yield* Effect.serviceOption(TessayaPeople);
    const statistical = findings(stats, now, clock).map((f) => ({ ...f, member: null }));
    const patterns = [
      ...noticePatterns({
        now,
        hourOf: (at) => clock(at).hour,
        stalls,
        people: Option.isSome(people) ? yield* people.value.lastHeard : [],
      }),
      ...statistical,
    ];
    const confirmed = patternEvents(patterns, state.surfaced, now);
    events.push(...confirmed);
    // Each confirmed hypothesis, once until it is surfaced again, joins the one memory as a fact she can recall.
    const memory = yield* Effect.serviceOption(TessayaMemoryService);
    const pending = new Set(state.digest.map((e) => e.id));
    if (Option.isSome(memory))
      for (const p of patterns)
        if (confirmed.some((e) => e.id === p.id) && !pending.has(p.id))
          yield* memory.value.add(patternFact(p, now)).pipe(Effect.ignoreCause({ log: true }));
  }
  if (stats !== statsBefore) yield* writeStats(stats);
  // Her own health (17 Nov): a cause that holds a few minutes is one event per episode; the review and its gate decide
  // whether she says it, sends a card or only logs it, by presence and quiet hours like anything else.
  const health = healthNotice(
    state.health ?? null,
    diagnose(yield* TessayaHealth.snapshot(), "any"),
    now,
  );
  if (health.notice !== null)
    events.push({
      ...health.notice,
      category: "home",
      at: now,
      member: null,
      urgent: false,
      told: false,
    });
  // A report she sent on her own, in the owner's developer mode: one short line, once (its id), by the same gate.
  const reports = yield* Effect.serviceOption(ProblemReports);
  if (Option.isSome(reports))
    for (const r of yield* reports.value.toAnnounce)
      events.push({
        ...r,
        category: "home",
        at: now,
        member: null,
        weight: 60,
        urgent: false,
        told: false,
      });
  const fresh = events.filter((e) => state.reviewed[e.id] === undefined);
  return {
    ...state,
    health: health.episode,
    lastSense: now,
    lastRowId,
    learned,
    awaiting,
    lastPatterns,
    near,
    mood,
    digest: addToDigest(state.digest, fresh),
  } satisfies PulseState;
});

const OWNER_TZ_FORMAT = (zone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  });

/** Today's pulse calls and tokens, from the one usage record (no counter of its own). */
const spentToday = Effect.gen(function* () {
  const usage = yield* Effect.serviceOption(BrainUsage);
  if (Option.isNone(usage)) return { calls: 0, tokens: 0 };
  const zone = yield* houseZone();
  const now = yield* Clock.currentTimeMillis;
  const totals = yield* usage.value.totals({ since: periodStarts(zone, now).day, timeZone: zone });
  return totals
    .filter((t) => t.feature === "pulse")
    .reduce(
      (n, t) => ({
        calls: n.calls + t.calls,
        tokens: n.tokens + t.input + t.cacheRead + t.cacheWrite + t.output,
      }),
      { calls: 0, tokens: 0 },
    );
});

export interface ReviewResult {
  readonly state: PulseState;
  readonly decision: PulseDecision | null;
  readonly held: string | null;
}

/** One review, if one is due: decide, gate, act, and log it to the Record. */
export const review = Effect.fn("TessayaPulse.review")(function* (state: PulseState) {
  const now = yield* Clock.currentTimeMillis;
  const { pulse, level } = yield* settingsNow;
  const zone = yield* houseZone();
  const quietSpec = (yield* readQuietHours) ?? quietHoursOf(DEFAULT_POLICY.quietHours, zone);
  const quiet = inQuietHours(now, quietSpec) || (yield* readDndUntil(OWNER_MEMBER_ID)) !== null;
  const presence = yield* Effect.serviceOption(TessayaPresence);
  const estimate = Option.isSome(presence) ? yield* presence.value.estimate() : null;
  const owner = estimate?.members.find((m) => m.member === OWNER_MEMBER_ID);
  const ownerHere = (owner?.confidence ?? 0) >= PRESENCE_BARS.around;
  const record = yield* Effect.serviceOption(TessayaRecordService);
  const log = (subject: string, outcome: string, detail: string, ref: string | null = null) =>
    Option.isNone(record)
      ? Effect.void
      : record.value.append({ kind: "pulse", actor: "Tessaya", ref, subject, outcome, detail });

  // Lines he let pass without a word are a weak "not that".
  let learned = state.learned;
  const stale = state.awaiting.filter((a) => now - a.at >= IGNORED_AFTER_MS);
  for (const a of stale) {
    learned = learnFrom(learned, a.category as PulseDecision["category"], "ignored");
    yield* log(a.id, "ignored", "no reaction within 30 minutes");
  }
  const base = {
    ...state,
    learned,
    awaiting: state.awaiting.filter((a) => now - a.at < IGNORED_AFTER_MS),
  };
  if (
    !pulse.enabled ||
    !reviewDue({ now, lastReview: state.lastReview, level, ownerHere, quiet, digest: state.digest })
  )
    return { state: base, decision: null, held: null } satisfies ReviewResult;

  const categories = PULSE_CATEGORIES.filter((c) => pulse.categories[c]);
  const recent = Option.isNone(record)
    ? []
    : (yield* record.value.query({ kind: "pulse", limit: 5 }))
        .filter((r) => r.outcome === "speak" || r.outcome === "ask")
        .map((r) => r.subject);
  const oneShot = yield* Effect.serviceOption(TessayaOneShot);
  const spent = yield* spentToday;
  // Near the cap (90%) she goes rules-only, like the brain near a plan limit.
  const overBudget =
    spent.calls >= pulse.dailyCalls * 0.9 || spent.tokens >= pulse.dailyTokens * 0.9;
  const prompt = pulsePrompt({
    digest: state.digest,
    world: {
      localTime: OWNER_TZ_FORMAT(zone).format(now),
      quiet,
      here: (estimate?.members ?? []).map(
        (m) =>
          `${m.member}: ${m.nearest === null ? "around" : `near ${m.nearest.vessel}`} (${m.confidence.toFixed(2)})`,
      ),
      mood: state.mood,
    },
    level,
    categories,
    recent,
  });
  const ask = (model: string | undefined) =>
    Option.isNone(oneShot)
      ? Effect.succeed(rulesDecision(state.digest, "no model here"))
      : oneShot.value
          .run({
            prompt,
            system: PULSE_SYSTEM,
            outputSchema: PulseDecisionSchema,
            role: "background",
            feature: "pulse",
            ...(model === undefined ? {} : { model }),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.succeed(
                rulesDecision(state.digest, `the model did not answer: ${error.detail}`),
              ),
            ),
          );
  const cheap = overBudget
    ? rulesDecision(state.digest, "the pulse's daily budget is nearly spent")
    : yield* ask(PULSE_CHEAP_MODEL);
  // A weighty proposal to do something is checked by the role's own (stronger) model; most reviews never get here.
  const proposed =
    !overBudget && needsEscalation(cheap, state.digest) ? yield* ask(undefined) : cheap;
  const spokenLastHour = state.spoken.filter((at) => now - at < 3_600_000);
  const gated = gateDecision({
    decision: proposed,
    digest: state.digest,
    level,
    categories,
    muted: pulse.muted.map((m) => m.toLowerCase()),
    quiet,
    learned,
    spokenLastHour: spokenLastHour.length,
  });
  let { decision, held } = gated;
  const logId = `pulse:${now}`;
  // A question also goes to the one inbox, so he can answer it later, anywhere, even with no vessel near him.
  const inbox = yield* Effect.serviceOption(TessayaPhoneInbox);
  const carded = decision.action === "ask" && Option.isSome(inbox);
  if (carded)
    yield* inbox.value.mirror({
      id: logId,
      title: "Tessaya asks",
      detail: decision.text,
      buttons: ASK_BUTTONS,
      yes: ASK_YES,
      cancel: ASK_LATER,
    });
  const out = decision.action === "speak" || decision.action === "ask";
  if (out) {
    const member = decision.member ?? OWNER_MEMBER_ID;
    const where = yield* whereToSay(
      member,
      null,
      decision.category === "reminders" ? "reminder" : "personal",
    );
    const devices = yield* Effect.serviceOption(HomeDevices);
    if (where === null || Option.isNone(devices)) {
      if (!carded) {
        decision = { ...decision, action: "note" };
        held = "nobody to tell nearby";
      }
    } else
      yield* devices.value
        .command(
          where,
          { op: "say", text: decision.text },
          { who: "Tessaya", surface: "assistant" },
        )
        .pipe(Effect.ignoreCause({ log: true }));
  }
  if (decision.action === "act" && decision.remindInMinutes !== null) {
    const commitments = yield* Effect.serviceOption(TessayaCommitmentService);
    if (Option.isSome(commitments))
      yield* commitments.value
        .upsert([
          {
            id: `pulse-${now.toString(36)}`,
            text: decision.text.slice(0, 300) || "Something she noticed",
            owner: "tessaya",
            due: now + Math.max(1, decision.remindInMinutes) * 60_000,
            status: "open",
            source: "assistant",
            createdAt: now,
          },
        ])
        .pipe(Effect.ignoreCause({ log: true }));
  }
  const said = decision.action === "speak" || decision.action === "ask";
  yield* log(
    decision.text || "nothing worth raising",
    decision.action,
    [decision.why, held === null ? "" : `held: ${held}`, `category: ${decision.category}`]
      .filter((x) => x !== "")
      .join(" · "),
    said ? logId : (decision.about[0] ?? null),
  );
  const reviewed = Object.fromEntries(
    Object.entries(state.reviewed).filter(([, at]) => now - at < 7 * DAY),
  );
  for (const e of state.digest) reviewed[e.id] = now;
  const surfaced = { ...state.surfaced };
  for (const e of state.digest) if (e.category === "patterns") surfaced[e.id] = now;
  return {
    state: {
      ...base,
      lastReview: now,
      digest: [],
      reviewed,
      surfaced,
      spoken: said ? [...spokenLastHour, now] : spokenLastHour,
      awaiting: said
        ? [...base.awaiting, { id: logId, category: decision.category, at: now }]
        : base.awaiting,
    },
    decision,
    held,
  } satisfies ReviewResult;
});

/** An ask's card: "Yes" is a liked, "Stop asking" turns that kind off, "Not now" (and no answer) only drops it. */
const ASK_BUTTONS = ["Yes", "Not now", "Stop asking these"];
const ASK_YES = 0;
const ASK_LATER = 1;

/** One pulse: sense, then review if due. The loop and "check now" both run this. */
export const beat = Effect.fn("TessayaPulse.beat")(function* () {
  const sensed = yield* sense(yield* readState());
  const result = yield* review(sensed);
  yield* writeState(result.state);
  return result;
});

/**
 * His reaction ("that was helpful", "don't tell me that"): the outcome signal the gate learns from. With a row id it
 * is that decision (Settings → Pulse), else the last thing she raised. "stop" is a told-off plus that kind turned off.
 */
export const react = Effect.fn("TessayaPulse.react")(function* (
  reaction: "liked" | "told_off" | "stop",
  row?: number,
) {
  const record = yield* Effect.serviceOption(TessayaRecordService);
  if (Option.isNone(record)) return "I haven't raised anything lately.";
  // shortcut: a row id is looked up among the last 200 pulse rows; Settings only lists the newest.
  const last = (yield* record.value.query({
    kind: "pulse",
    limit: row === undefined ? 20 : 200,
  })).find((r) =>
    row === undefined
      ? r.outcome === "speak" || r.outcome === "ask" || r.outcome === "act"
      : r.id === row && !PULSE_REACTIONS.has(r.outcome),
  );
  if (last === undefined)
    return row === undefined ? "I haven't raised anything lately." : "I can't find that one.";
  const category = PULSE_CATEGORIES.find((c) => last.detail.includes(`category: ${c}`)) ?? "jobs";
  // The pulse's next sense pass reads this row and learns from it; `row:` ties it to its decision in Settings.
  yield* record.value.append({
    kind: "pulse",
    actor: "Tessaya",
    ref: last.ref,
    subject: last.subject,
    outcome: reaction === "liked" ? "liked" : "told_off",
    detail: `category: ${category} · row: ${last.id}${reaction === "stop" ? " · stopped" : ""}`,
    // His reaction is the outcome of what she raised (B-046): the learning loop reads it as cause and effect.
    ...(last.eventId == null ? {} : { cause: [last.eventId] }),
  });
  if (reaction === "stop") {
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isSome(settings))
      yield* settings.value
        .updateSettings({ tessayaPulse: { categories: { [category]: false } } })
        .pipe(Effect.orDie);
    return `I'll stop raising ${category} things. They can go back on in Settings, Brain, Pulse.`;
  }
  return reaction === "liked"
    ? "Noted, I'll keep raising things like that."
    : `Sorry. I'll hold back on ${category} things.`;
});

/** "Stop telling me about X" and its way back: the words go into Settings → Pulse, which the gate reads. */
export const mute = Effect.fn("TessayaPulse.mute")(function* (words: string, on: boolean) {
  const service = yield* Effect.serviceOption(ServerSettingsService);
  const w = words.trim().toLowerCase();
  if (Option.isNone(service) || w === "") return "I couldn't change that.";
  const current = (yield* service.value.getSettings.pipe(Effect.orDie)).tessayaPulse.muted;
  const muted = on
    ? [...new Set([...current, w])]
    : current.filter((m) => !m.includes(w) && !w.includes(m));
  yield* service.value.updateSettings({ tessayaPulse: { muted } }).pipe(Effect.orDie);
  return on
    ? `I'll stop raising things about ${w}.`
    : muted.length === current.length
      ? "Nothing like that was muted."
      : `I'll raise things about ${w} again.`;
});

/** The decision log, newest first: what she noticed and why she acted or stayed quiet. */
export const noticed = Effect.fn("TessayaPulse.noticed")(function* (limit: number) {
  const record = yield* Effect.serviceOption(TessayaRecordService);
  if (Option.isNone(record)) return [];
  return yield* record.value.query({ kind: "pulse", limit });
});

/** The loop: a sense pass every minute; reviews follow their own adaptive beat inside it. Only her brain decides. */
export const layer = Layer.effectDiscard(
  Effect.flatMap(isBrain, (here) => (here ? Effect.asVoid(beat()) : Effect.void)).pipe(
    Effect.catchCause((cause) => Effect.logWarning("pulse failed", cause)),
    Effect.repeat(Schedule.spaced(SENSE_MS)),
    Effect.delay("30 seconds"),
    Effect.forkScoped,
  ),
);
