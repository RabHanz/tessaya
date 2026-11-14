// @effect-diagnostics nodeBuiltinImport:off
/**
 * Her lines for every vessel (LEDGER "No idle or dumb moments"): an event and its exact facts in, the brain's decision
 * (words, mood, gesture) out. Picking never waits on a model: wordings written ahead, then the shipped pool, then the
 * plain line. Writing ahead runs on the routing table's `voice` row (persona speech), batched and capped per hour.
 */
import {
  LINE_EVENTS,
  expressionOf,
  keptLines,
  lineId,
  linesPrompt,
  mayExpress,
  pickLine,
  plainExpression,
  poolLines,
  remember,
  timeSlot,
  type Line,
  type LineEvent,
  type LineSpec,
  type TimeSlot,
} from "@t3tools/tessaya-shared/expression";
import { inQuietHours } from "@t3tools/tessaya-shared/comms";
import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import {
  CommsQuietHours,
  EXPRESSION_GESTURES,
  EXPRESSION_MOODS,
  type Expression,
} from "@t3tools/tessaya-contracts";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { readPack } from "./OperatingSystemPack.ts";
import { TessayaMood } from "./TessayaMood.ts";

export interface ExpressInput {
  /** The persona speaking, by id; unset is the lead. */
  readonly persona?: string | undefined;
  /** Whose history keeps the wordings from repeating; unset is the household's. */
  readonly person?: string | undefined;
  readonly facts?: Readonly<Record<string, string>> | undefined;
  /** A call or a work session on the vessel: unprompted lines wait. */
  readonly busy?: boolean | undefined;
  /** Today's words at this call site, where they differ from the event's own: said with the setting off. */
  readonly plain?: string | undefined;
}

export class TessayaExpression extends Context.Service<
  TessayaExpression,
  {
    /** The moment as she expresses it now, or null when it stays silent (the chatter dial, quiet hours, no line). */
    readonly express: (event: LineEvent, input?: ExpressInput) => Effect.Effect<Expression | null>;
    /**
     * The next few wordings (templates, slots unfilled) for a vessel that speaks without asking each time, the room
     * loop: counted as said for no-repeat. `on` false: the setting is off, and the vessel says its plain lines.
     */
    readonly ahead: (
      events: ReadonlyArray<LineEvent>,
      input: { readonly persona?: string | undefined; readonly person?: string | undefined },
      count: number,
    ) => Effect.Effect<{
      readonly on: boolean;
      readonly lines: Readonly<Partial<Record<LineEvent, ReadonlyArray<Line>>>>;
    }>;
    /** Writes wordings ahead for a persona's thin moments; one batch at a time, capped per hour. */
    readonly writeAhead: (
      persona: string,
      slot: TimeSlot,
      first?: LineEvent,
    ) => Effect.Effect<number>;
  }
>()("t3/tessaya/TessayaExpression") {}

/** Below this many wordings for the hour, a persona's moment is written ahead again. */
export const LOW_WATER = 6;
/** Wordings kept per persona, moment and hour; the oldest go first. */
const KEEP = 24;
const PER_EVENT = 6;
const EVENTS_PER_BATCH = 8;
/** At most this many writing calls an hour: cheap however chatty the house is. */
export const BATCHES_PER_HOUR = 6;

const Written = Schema.Struct({
  moments: Schema.Array(
    Schema.Struct({
      event: Schema.String,
      lines: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          mood: Schema.Literals(EXPRESSION_MOODS),
          gesture: Schema.Literals(EXPRESSION_GESTURES),
        }),
      ),
    }),
  ),
});

const decodeQuiet = Schema.decodeUnknownOption(Schema.fromJsonString(CommsQuietHours));

const hourIn = (at: number, timeZone: string): number => {
  try {
    return Number(
      new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(at),
    );
  } catch {
    return Math.floor(at / 3_600_000) % 24;
  }
};

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const oneShot = yield* TessayaOneShot;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const scope = yield* Scope.Scope;
  const home = yield* Effect.serviceOption(HomeAssistantService);
  const mood = yield* Effect.serviceOption(TessayaMood);

  const pack = () =>
    Option.isNone(config) ? DEFAULT_OS_PACK : readPack(NodePath.dirname(config.value.dbPath));
  /** The persona by id, or the lead for an unknown one, so every caller shares one set of wordings per voice. */
  const personaOf = (id: string | undefined) => {
    const { personas } = pack();
    return personas.find((p) => p.id === id) ?? personas.find((p) => p.lead) ?? personas[0];
  };
  // The house's own clock picks the hour; the quiet hours' zone when there is no house.
  const timeZone = Option.isNone(home)
    ? Effect.succeed<string | null>(null)
    : Effect.map(home.value.timeZone, (z): string | null => z);

  // shortcut: held in this server's memory, so a restart starts afresh (the pool and history refill in minutes);
  // persist when a repeat across a restart is heard.
  const written = new Map<string, Array<Line>>();
  const history = new Map<string, ReadonlyArray<string>>();
  const batches: Array<number> = [];
  const tried = new Map<string, number>();
  let writing = false;

  const quietHours = sql<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${"comms.quietHours"}`.pipe(
    Effect.map((rows) =>
      rows[0] === undefined ? null : Option.getOrNull(decodeQuiet(rows[0].value)),
    ),
    Effect.orElseSucceed(() => null),
  );

  const writeAhead: TessayaExpression["Service"]["writeAhead"] = Effect.fn(
    "TessayaExpression.writeAhead",
  )(function* (personaId, slot, first) {
    const now = yield* Clock.currentTimeMillis;
    while (batches.length > 0 && now - batches[0]! > 3_600_000) batches.shift();
    if (writing || batches.length >= BATCHES_PER_HOUR) return 0;
    const persona = personaOf(personaId);
    if (persona === undefined) return 0;
    const key = (event: LineEvent) => `${persona.id}|${event}|${slot}`;
    // The moment just asked for first, then the ones asked of the brain longest ago, so one it keeps failing never
    // starves the rest.
    const thin = (Object.keys(LINE_EVENTS) as Array<LineEvent>)
      .filter((event) => (written.get(key(event))?.length ?? 0) < LOW_WATER)
      .toSorted(
        (a, b) =>
          Number(b === first) - Number(a === first) ||
          (tried.get(key(a)) ?? 0) - (tried.get(key(b)) ?? 0),
      )
      .slice(0, EVENTS_PER_BATCH);
    if (thin.length === 0) return 0;
    writing = true;
    batches.push(now);
    for (const event of thin) tried.set(key(event), now);
    const prompt = linesPrompt({
      persona,
      events: thin,
      slot,
      perEvent: PER_EVENT,
      avoid: Object.fromEntries(
        thin.map((e) => [e, (written.get(key(e)) ?? []).map((l) => l.text).slice(-8)]),
      ),
    });
    const result = yield* oneShot.run({ prompt, outputSchema: Written, role: "voice" }).pipe(
      Effect.tapError((e) =>
        Effect.logWarning("expression: writing ahead failed", { why: e.detail }),
      ),
      Effect.option,
      Effect.ensuring(Effect.sync(() => void (writing = false))),
    );
    if (Option.isNone(result)) return 0;
    let added = 0;
    for (const moment of result.value.moments) {
      const event = thin.find((e) => e === moment.event);
      if (event === undefined) continue;
      const held = written.get(key(event)) ?? [];
      const fresh = keptLines(event, moment.lines, held, slot);
      added += fresh.length;
      written.set(key(event), [...held, ...fresh].slice(-KEEP));
    }
    return added;
  });

  /** The next wording for a person, persona and moment, never one of their recent ones while another is left. */
  const pickTemplate = Effect.fn("TessayaExpression.pickTemplate")(function* (
    event: LineEvent,
    persona: string,
    person: string | undefined,
    at: number,
    zone: string,
  ) {
    const slot = timeSlot(hourIn(at, zone));
    const own = written.get(`${persona}|${event}|${slot}`) ?? [];
    if (own.length < LOW_WATER) yield* Effect.forkIn(writeAhead(persona, slot, event), scope);
    const who = `${person ?? "household"}|${persona}|${event}`;
    const recent = history.get(who) ?? [];
    const random = yield* Random.next;
    const cached = pickLine(event, own, recent, slot, random);
    const pooled = pickLine(event, poolLines(persona, event), recent, slot, random);
    const fresh = (l: Line | null) => l !== null && !recent.includes(lineId(event, l.text));
    const picked: { readonly line: Line; readonly source: Expression["source"] } | null =
      cached !== null && fresh(cached)
        ? { line: cached, source: "cache" }
        : pooled !== null && (fresh(pooled) || cached === null)
          ? { line: pooled, source: "pool" }
          : cached !== null
            ? { line: cached, source: "cache" }
            : null;
    if (picked !== null) history.set(who, remember(recent, lineId(event, picked.line.text)));
    return picked;
  });

  const now = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const at = yield* Clock.currentTimeMillis;
    const quiet = yield* quietHours;
    const zone = (yield* timeZone) ?? quiet?.timeZone ?? "UTC";
    return { current, at, quiet, zone };
  });

  const express: TessayaExpression["Service"]["express"] = Effect.fn("TessayaExpression.express")(
    function* (event, input = {}) {
      const s: LineSpec = LINE_EVENTS[event];
      const facts = input.facts ?? {};
      const { current, at, quiet, zone } = yield* now;
      const allowed = mayExpress(s.priority, {
        motion: current?.companionMotion ?? "calm",
        quiet: inQuietHours(at, quiet),
        busy: input.busy === true,
      });
      if (!allowed) return null;
      const persona = personaOf(input.persona)?.id ?? "executive";
      const fixed = plainExpression(event, persona, facts, input.plain);
      const picked =
        current?.tessayaExpression === true
          ? yield* pickTemplate(event, persona, input.person, at, zone)
          : null;
      const said =
        (picked === null
          ? null
          : expressionOf(event, persona, picked.line, facts, picked.source)) ?? fixed;
      // A moment with no feeling of its own shows her mood (CS6), so every vessel's face agrees.
      if (said === null || said.mood !== "neutral" || Option.isNone(mood)) return said;
      const felt = yield* mood.value.view(persona, zone);
      return felt.label === "neutral"
        ? said
        : { ...said, mood: felt.label, intensity: felt.intensity };
    },
  );

  const ahead: TessayaExpression["Service"]["ahead"] = Effect.fn("TessayaExpression.ahead")(
    function* (events, input, count) {
      const { current, at, zone } = yield* now;
      if (current?.tessayaExpression !== true) return { on: false, lines: {} };
      const persona = personaOf(input.persona)?.id ?? "executive";
      const lines: Partial<Record<LineEvent, ReadonlyArray<Line>>> = {};
      for (const event of events) {
        const got: Array<Line> = [];
        for (let i = 0; i < count; i++) {
          const picked = yield* pickTemplate(event, persona, input.person, at, zone);
          if (picked !== null && !got.some((g) => g.text === picked.line.text))
            got.push(picked.line);
        }
        lines[event] = got;
      }
      return { on: true, lines };
    },
  );

  return { express, ahead, writeAhead } satisfies TessayaExpression["Service"];
});

export const layer = Layer.effect(TessayaExpression, make);

/** The words for a moment where the service may be missing (a bare server, a test): its decision, else the plain line. */
export const expressOr = Effect.fn("TessayaExpression.expressOr")(function* (
  event: LineEvent,
  input: ExpressInput = {},
) {
  const service = yield* Effect.serviceOption(TessayaExpression);
  return Option.isSome(service)
    ? yield* service.value.express(event, input)
    : plainExpression(event, input.persona ?? "executive", input.facts, input.plain);
});
