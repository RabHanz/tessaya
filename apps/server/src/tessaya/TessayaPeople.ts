// @effect-diagnostics cryptoRandomUUIDInEffect:off globalDate:off
/**
 * The people graph (HOUSEHOLD-DESIGN §11), in the one memory's tables: who a voice that is no member is, across
 * sessions and vessels; introductions; what she is told when she hears them again; the owner's suggestions and changes;
 * and the retention that deletes an unsaved voice. Reached through TessayaHousehold's people ops, so it answers on the
 * household's home server with the caller's role.
 */
import type {
  TessayaHouseholdCallInput,
  TessayaHouseholdCallResult,
  TessayaPerson,
  TessayaPeopleSuggestion,
} from "@t3tools/tessaya-contracts";
import type { Assurance, PrincipalRole } from "@t3tools/tessaya-shared/household";
import { mentions, OWNER_END } from "@t3tools/tessaya-shared/memoryEntities";
import { type PersonStatus, type PersonView, turnLineFor } from "@t3tools/tessaya-shared/people";
import { PRESENCE_BARS } from "@t3tools/tessaya-shared/presence";
import { cosine, unitOrNull } from "@t3tools/tessaya-voice/speaker";
import { vectorFromBase64, vectorToBase64 } from "@t3tools/tessaya-voice/speakerStore";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import {
  mergeCentroid,
  pairKey,
  placeVoice,
  UNNAMED_DAYS_DEFAULT,
  splitTwo,
  suggestionsFor,
  VOICE_RULES,
} from "./peopleGraph.ts";
import { peopleHere, TessayaPresence } from "./TessayaPresence.ts";

type Result = TessayaHouseholdCallResult;
type PeopleOp = Extract<TessayaHouseholdCallInput, { op: `people${string}` }>;

export interface PeopleCaller {
  readonly role: PrincipalRole | null;
  readonly assurance: Assurance;
  readonly tainted?: boolean | undefined;
}

const DAY_MS = 86_400_000;
/** She is told to ask a new voice's name in its first ten minutes, then not again for half a day. */
const ASK_WINDOW_MS = 10 * 60_000;
const ASK_AGAIN_MS = 12 * 60 * 60_000;
export const ASK_NAMES_KEY = "people.askNames";
export const UNNAMED_DAYS_KEY = "people.unnamedDays";
export const BIN_DAYS_KEY = "people.binDays";
/** A forgotten person can be restored this long (the Director, 16 Nov: forgetting must be hard to do by mistake). */
export const BIN_DAYS_DEFAULT = 30;

/** How long anything forgotten (a person, a fact she understood) can be restored: one setting for every bin. */
export const readBinDays = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ value: string }>`SELECT value FROM fabric_settings WHERE key = ${BIN_DAYS_KEY}`,
).pipe(
  Effect.map((rows) => {
    const n = Number(rows[0]?.value);
    return Number.isInteger(n) && n > 0 ? n : BIN_DAYS_DEFAULT;
  }),
  Effect.orElseSucceed(() => BIN_DAYS_DEFAULT),
);

const Forgotten = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.String,
    by: Schema.String,
    name: Schema.NullOr(Schema.String),
    status: Schema.String,
  }),
);
const decodeForgotten = Schema.decodeUnknownOption(Forgotten);
const encodeForgotten = Schema.encodeSync(Forgotten);

const Aliases = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeAliases = Schema.decodeUnknownOption(Aliases);
const encodeAliases = Schema.encodeSync(Aliases);

interface Row {
  readonly id: string;
  readonly name: string;
  readonly aliases_json: string;
  readonly kind: string | null;
  readonly status: PersonStatus | null;
  readonly member_id: string | null;
  readonly voice_model: string | null;
  readonly voice_centroid: string | null;
  readonly voice_samples: number;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
  readonly keep_until: string | null;
  readonly ask_name: number;
  readonly asked_at: string | null;
  readonly impression: string | null;
  /** In the bin: when, by whom, and the name and status to restore. */
  readonly forgotten_json: string | null;
}

const refused = (line: string): Result => ({ status: "refused", line });
const done = (line: string, extra: Omit<Result, "status" | "line"> = {}): Result => ({
  status: "done",
  line,
  ...extra,
});
const iso = (ms: number) => new Date(ms).toISOString();
const named = (r: Row): string | null => (r.status === "unknown" ? null : r.name);
const label = (r: Row): string =>
  named(r) ?? (r.status === "not_person" ? "a TV or radio voice" : "someone new");
/** "ali khan" → "Ali Khan": a name heard in lower case is still a name. */
const nameCase = (name: string): string =>
  name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(^|[\s-])(\p{Ll})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());

export class TessayaPeople extends Context.Service<
  TessayaPeople,
  {
    readonly call: (input: PeopleOp, caller: PeopleCaller) => Effect.Effect<Result>;
    /** Deletes voices and what they said whose keep date passed; how many people it forgot. */
    readonly sweep: Effect.Effect<number>;
    /** Her impression of a person (MA-021), shown to the owner in People and given only in that person's own turns. */
    readonly setImpression: (id: string, text: string | null) => Effect.Effect<void>;
    /** Named guests heard on a vessel: when last, and how often in all (the pulse's "gone quiet" pattern, M-027). */
    readonly lastHeard: Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly lastAt: number;
        readonly seen: number;
      }>
    >;
    /** Someone forgotten, or merged `into` the one they are: what is kept about them elsewhere follows. */
    readonly forgotten: Stream.Stream<{ readonly id: string; readonly into: string | undefined }>;
  }
>()("t3/tessaya/TessayaPeople") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = Clock.currentTimeMillis;
  const forgotten = yield* PubSub.unbounded<{
    readonly id: string;
    readonly into: string | undefined;
  }>();
  // Where they were seen goes (or moves to the one they are) with them; TessayaMood follows `forgotten`.
  const forgetPresence = (id: string, into?: string) =>
    Effect.serviceOption(TessayaPresence).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.void, onSome: (p) => p.forget(id, into) }),
      ),
      Effect.andThen(PubSub.publish(forgotten, { id, into })),
      Effect.asVoid,
    );

  const row = (id: string) =>
    sql<Row>`SELECT * FROM fabric_memory_entities WHERE id = ${id} AND forgotten_json IS NULL`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orDie,
    );
  const byName = (name: string) =>
    sql<Row>`
      SELECT * FROM fabric_memory_entities WHERE lower(name) = ${name.toLowerCase()} AND forgotten_json IS NULL
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orDie,
    );
  const centroidOf = (r: Row) =>
    r.voice_centroid === null
      ? null
      : unitOrNull(vectorFromBase64(r.voice_centroid) ?? new Float32Array());
  const aliasesOf = (r: Row) => Option.getOrElse(decodeAliases(r.aliases_json), () => []);

  const askNamesOn = sql<{ value: string }>`
    SELECT value FROM fabric_settings WHERE key = ${ASK_NAMES_KEY}
  `.pipe(
    Effect.map((rows) => rows[0]?.value !== "off"),
    Effect.orElseSucceed(() => true),
  );

  const unnamedDays = sql<{ value: string }>`
    SELECT value FROM fabric_settings WHERE key = ${UNNAMED_DAYS_KEY}
  `.pipe(
    Effect.map((rows) => {
      const n = Number(rows[0]?.value);
      return Number.isInteger(n) && n > 0 ? n : UNNAMED_DAYS_DEFAULT;
    }),
    Effect.orElseSucceed(() => UNNAMED_DAYS_DEFAULT),
  );
  /** When a new unnamed voice goes: never, unless the owner set an expiry. */
  const unnamedUntil = (at: number) =>
    Effect.map(unnamedDays, (days) => (days === 0 ? null : iso(at + days * DAY_MS)));

  /** What his memory says about them, each with the memory that says it. */
  const relationsOf = Effect.fn("TessayaPeople.relationsOf")(function* (id: string) {
    const out = yield* sql<{
      relation: string;
      to_id: string;
      to_name: string | null;
      to_kind: string | null;
      why: string | null;
    }>`
      SELECT e.relation, e.to_id, t.name AS to_name, t.kind AS to_kind, i.text AS why
      FROM fabric_memory_edges e
      LEFT JOIN fabric_memory_entities t ON t.id = e.to_id
      LEFT JOIN fabric_memory_items i ON i.id = e.item_id
      WHERE e.from_id = ${id} AND e.relation NOT IN ('not_same', 'says they are')
    `;
    const into = yield* sql<{ relation: string; from_name: string; why: string | null }>`
      SELECT e.relation, f.name AS from_name, i.text AS why
      FROM fabric_memory_edges e
      JOIN fabric_memory_entities f ON f.id = e.from_id
      LEFT JOIN fabric_memory_items i ON i.id = e.item_id
      WHERE e.to_id = ${id} AND e.relation NOT IN ('not_same', 'says they are', 'was at')
    `;
    const seen = new Set<string>();
    return [
      ...out.map((e) => ({
        text:
          e.to_id === OWNER_END
            ? e.relation === "works with"
              ? "works with the owner"
              : `the owner's ${e.relation}`
            : e.relation === "was at"
              ? `was at ${e.to_name ?? "an event"}`
              : `${e.to_name ?? "someone"}'s ${e.relation}`,
        why: e.why,
      })),
      ...into.map((e) => ({ text: `${e.from_name} is their ${e.relation}`, why: e.why })),
    ].filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true)));
  }, Effect.orDie);

  const topicsOf = (id: string, limit = 5) =>
    sql<{ at: string; said: string }>`
      SELECT at, said FROM fabric_memory_sightings WHERE entity_id = ${id} AND said != ''
      ORDER BY at DESC LIMIT ${limit}
    `.pipe(Effect.orDie);

  const viewOf = Effect.fn("TessayaPeople.viewOf")(function* (r: Row) {
    return {
      name: named(r),
      status: r.status ?? "guest",
      relations: (yield* relationsOf(r.id)).map((x) => x.text),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      topics: yield* topicsOf(r.id, 3),
      impression: r.impression,
    } satisfies PersonView;
  });

  const personOf = Effect.fn("TessayaPeople.personOf")(function* (r: Row) {
    const heard = yield* sql<{ n: number }>`
      SELECT count(*) AS n FROM fabric_memory_sightings WHERE entity_id = ${r.id}
    `.pipe(Effect.orDie);
    return {
      id: r.id,
      name: named(r),
      status: r.status ?? "guest",
      relations: yield* relationsOf(r.id),
      heard: Math.max(heard[0]?.n ?? 0, r.voice_samples),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      keepUntil: r.keep_until,
      askName: r.ask_name !== 0,
      impression: r.impression,
      topics: yield* topicsOf(r.id),
    } satisfies TessayaPerson;
  });

  /** A voice, and what it said, gone for good; a person his own memories name stays, as a name. */
  const forgetNode = Effect.fn("TessayaPeople.forgetNode")(function* (r: Row) {
    const was = Option.getOrNull(decodeForgotten(r.forgotten_json));
    yield* sql`DELETE FROM fabric_memory_sightings WHERE entity_id = ${r.id}`;
    yield* sql`
      DELETE FROM fabric_memory_edges WHERE item_id = '' AND (from_id = ${r.id} OR to_id = ${r.id})
    `;
    yield* forgetPresence(r.id);
    const kept = yield* sql<{ n: number }>`
      SELECT (SELECT count(*) FROM fabric_memory_links WHERE entity_id = ${r.id})
           + (SELECT count(*) FROM fabric_memory_edges WHERE from_id = ${r.id} OR to_id = ${r.id}) AS n
    `;
    if ((kept[0]?.n ?? 0) > 0 && r.status !== "unknown")
      yield* sql`
        UPDATE fabric_memory_entities SET status = NULL, kind = NULL, member_id = NULL, voice_model = NULL,
          voice_centroid = NULL, voice_samples = 0, first_seen = NULL, last_seen = NULL, keep_until = NULL,
          asked_at = NULL, impression = NULL, forgotten_json = NULL,
          name = ${was?.name !== null && was?.name !== undefined && (yield* byName(was.name)) === null ? was.name : r.name}
        WHERE id = ${r.id}
      `;
    else {
      yield* sql`DELETE FROM fabric_memory_edges WHERE from_id = ${r.id} OR to_id = ${r.id}`;
      yield* sql`DELETE FROM fabric_memory_links WHERE entity_id = ${r.id}`;
      yield* sql`DELETE FROM fabric_memory_entities WHERE id = ${r.id}`;
    }
    return (
      (yield* sql<{ n: number }>`
      SELECT count(*) AS n FROM fabric_memory_links WHERE entity_id = ${r.id}
    `)[0]?.n ?? 0
    );
  }, Effect.orDie);

  const binDays = Effect.provideService(readBinDays, SqlClient.SqlClient, sql);

  /** What forgetting them takes away, said back before anything goes. */
  const whatGoes = Effect.fn("TessayaPeople.whatGoes")(function* (r: Row) {
    const n = yield* sql<{ said: number; items: number }>`
      SELECT (SELECT count(*) FROM fabric_memory_sightings WHERE entity_id = ${r.id}) AS said,
             (SELECT count(*) FROM fabric_memory_links WHERE entity_id = ${r.id}) AS items
    `.pipe(Effect.orDie);
    const said = n[0]?.said ?? 0;
    const items = n[0]?.items ?? 0;
    return [
      r.voice_centroid === null ? null : "their voice",
      said > 0 ? `${said} thing${said === 1 ? "" : "s"} they said` : null,
      items > 0 ? `${items} memor${items === 1 ? "y" : "ies"} about them` : null,
    ]
      .filter((x) => x !== null)
      .join(", ");
  });

  /** Into the bin: hidden everywhere, restorable for the bin's days, then purged. */
  const softForget = Effect.fn("TessayaPeople.softForget")(function* (r: Row, by: string) {
    const at = iso(yield* now);
    yield* sql`
      UPDATE fabric_memory_entities
      SET forgotten_json = ${encodeForgotten({ at, by, name: named(r), status: r.status ?? "guest" })},
        name = ${`~${r.id}`}
      WHERE id = ${r.id}
    `.pipe(Effect.orDie);
    yield* forgetPresence(r.id);
    return `${yield* binDays} days`;
  });

  const binned =
    sql<Row>`SELECT * FROM fabric_memory_entities WHERE forgotten_json IS NOT NULL`.pipe(
      Effect.orDie,
    );

  const restore = Effect.fn("TessayaPeople.restore")(function* (id: string) {
    const r = (yield* binned).find((x) => x.id === id);
    const was = r === undefined ? null : Option.getOrNull(decodeForgotten(r.forgotten_json));
    if (r === undefined || was === null) return null;
    const name =
      was.name === null
        ? `?${r.id.slice(0, 8)}`
        : (yield* byName(was.name)) === null
          ? was.name
          : `${was.name} (2)`;
    yield* sql`
      UPDATE fabric_memory_entities SET forgotten_json = NULL, name = ${name} WHERE id = ${r.id}
    `.pipe(Effect.orDie);
    return was.name ?? "someone new";
  });

  /** One person from two: voice, sightings, edges, links and names move to `to`, and `from` goes. */
  const moveInto = Effect.fn("TessayaPeople.moveInto")(function* (from: Row, to: Row) {
    const a = centroidOf(from);
    const b = centroidOf(to);
    const centroid =
      a === null ? b : b === null ? a : mergeCentroid(b, to.voice_samples, a, from.voice_samples);
    const earliest = [from.first_seen, to.first_seen].filter((x) => x !== null).sort()[0] ?? null;
    const latest =
      [from.last_seen, to.last_seen]
        .filter((x) => x !== null)
        .sort()
        .at(-1) ?? null;
    // Kept if either was kept; else the later of the two dates.
    const keep =
      (from.keep_until === null && from.status !== null) ||
      (to.keep_until === null && to.status !== null)
        ? null
        : ([from.keep_until, to.keep_until]
            .filter((x) => x !== null)
            .sort()
            .at(-1) ?? null);
    const status: PersonStatus =
      to.status === "member" || from.status === "member"
        ? "member"
        : to.status === "unknown" || to.status === null
          ? from.status === "unknown" || from.status === null
            ? "unknown"
            : from.status
          : to.status;
    const aliases = [...new Set([...aliasesOf(to), ...aliasesOf(from)])];
    yield* sql`
      UPDATE fabric_memory_entities SET kind = 'person', status = ${status},
        member_id = ${to.member_id ?? from.member_id},
        voice_model = ${to.voice_model ?? from.voice_model},
        voice_centroid = ${centroid === null ? null : vectorToBase64(centroid)},
        voice_samples = ${to.voice_samples + from.voice_samples},
        first_seen = ${earliest}, last_seen = ${latest}, keep_until = ${keep},
        impression = ${to.impression ?? from.impression},
        aliases_json = ${encodeAliases(aliases)}
      WHERE id = ${to.id}
    `;
    yield* sql`UPDATE fabric_memory_sightings SET entity_id = ${to.id} WHERE entity_id = ${from.id}`;
    yield* sql`UPDATE OR IGNORE fabric_memory_edges SET from_id = ${to.id} WHERE from_id = ${from.id}`;
    yield* sql`UPDATE OR IGNORE fabric_memory_edges SET to_id = ${to.id} WHERE to_id = ${from.id}`;
    yield* sql`UPDATE OR IGNORE fabric_memory_links SET entity_id = ${to.id} WHERE entity_id = ${from.id}`;
    // An edge between the two is now a loop; and what didn't move (duplicates) goes with `from`.
    yield* sql`
      DELETE FROM fabric_memory_edges
      WHERE (from_id = ${to.id} AND to_id = ${to.id}) OR from_id = ${from.id} OR to_id = ${from.id}
    `;
    yield* sql`DELETE FROM fabric_memory_links WHERE entity_id = ${from.id}`;
    yield* sql`DELETE FROM fabric_memory_entities WHERE id = ${from.id}`;
    yield* forgetPresence(from.id, to.id);
  }, Effect.orDie);

  /** The guest just heard on a vessel, from presence, while they are still known. */
  const justHeard = Effect.fn("TessayaPeople.justHeard")(function* (vessel: string | undefined) {
    if (vessel === undefined) return null;
    const guest = (yield* peopleHere(vessel, PRESENCE_BARS.present)).find((p) => p.guest);
    return guest === undefined ? null : yield* row(guest.member);
  });

  const target = Effect.fn("TessayaPeople.target")(function* (
    id: string | undefined,
    vessel?: string,
  ) {
    if (id === undefined || id === "") return null;
    if (id === "last") return yield* justHeard(vessel);
    return (yield* row(id)) ?? (yield* byName(id));
  });

  const memberPrints = (model: string) =>
    sql<{
      centroid: string;
    }>`SELECT centroid FROM tessaya_voice_profiles WHERE model = ${model}`.pipe(
      Effect.map((rows) =>
        rows.flatMap((r) => {
          const v = vectorFromBase64(r.centroid);
          const u = v === null ? null : unitOrNull(v);
          return u === null ? [] : [u];
        }),
      ),
      Effect.orElseSucceed(() => []),
    );

  const observe = Effect.fn("TessayaPeople.observe")(function* (
    input: Extract<PeopleOp, { op: "peopleObserve" }>,
  ) {
    const raw = vectorFromBase64(input.print.vector);
    const vector = raw === null ? null : unitOrNull(raw);
    if (vector === null || input.print.ms < VOICE_RULES.minMs) return done("", { person: null });
    // A member's voice on a poor clip is theirs, never filed as a stranger.
    if (
      (yield* memberPrints(input.print.model)).some((m) => cosine(m, vector) >= VOICE_RULES.suggest)
    )
      return done("", { person: null });
    const at = yield* now;
    const rows = yield* sql<Row>`
      SELECT * FROM fabric_memory_entities
      WHERE voice_centroid IS NOT NULL AND voice_model = ${input.print.model} AND forgotten_json IS NULL
    `.pipe(Effect.orDie);
    const nodes = rows.flatMap((r) => {
      const c = centroidOf(r);
      return c === null
        ? []
        : [{ id: r.id, status: r.status ?? "guest", centroid: c, samples: r.voice_samples }];
    });
    const placed = placeVoice(vector, nodes);
    let id: string;
    if (placed.kind === "join") {
      id = placed.id;
      const n = nodes.find((x) => x.id === id)!;
      yield* sql`
        UPDATE fabric_memory_entities
        SET voice_centroid = ${vectorToBase64(mergeCentroid(n.centroid, n.samples, vector))},
          voice_samples = voice_samples + 1, last_seen = ${iso(at)}
        WHERE id = ${id}
      `.pipe(Effect.orDie);
    } else {
      id = globalThis.crypto.randomUUID();
      yield* sql`
        INSERT INTO fabric_memory_entities (id, name, aliases_json, updated_at, kind, status, voice_model,
          voice_centroid, voice_samples, first_seen, last_seen, keep_until)
        VALUES (${id}, ${`?${id.slice(0, 8)}`}, '[]', ${iso(at)}, 'person', 'unknown', ${input.print.model},
          ${vectorToBase64(vector)}, 1, ${iso(at)}, ${iso(at)}, ${yield* unnamedUntil(at)})
      `.pipe(Effect.orDie);
    }
    const r = (yield* row(id))!;
    // A guest is present like anyone (B-043): the gate, her face and "the one I just heard" read it there.
    if (r.status !== "not_person")
      yield* Effect.serviceOption(TessayaPresence).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (p) =>
              p.note({ member: id, guest: true, source: "voice", vessel: input.vessel, at }),
          }),
        ),
      );
    // Read before this turn is kept: "last time" is the time before.
    const view = yield* viewOf(r);
    if (r.status !== "not_person")
      yield* sql`
        INSERT INTO fabric_memory_sightings (id, entity_id, at, vessel, said, model, vector, ms)
        VALUES (${globalThis.crypto.randomUUID()}, ${id}, ${iso(at)}, ${input.vessel},
          ${input.said.trim().slice(0, 200)}, ${input.print.model}, ${vectorToBase64(vector)},
          ${Math.round(input.print.ms)})
      `.pipe(Effect.orDie);
    const askedAt = r.asked_at === null ? null : Date.parse(r.asked_at);
    const ask =
      r.status === "unknown" &&
      r.ask_name !== 0 &&
      (yield* askNamesOn) &&
      (askedAt === null || at - askedAt < ASK_WINDOW_MS || at - askedAt > ASK_AGAIN_MS);
    if (ask && (askedAt === null || at - askedAt > ASK_AGAIN_MS))
      yield* sql`UPDATE fabric_memory_entities SET asked_at = ${iso(at)} WHERE id = ${id}`.pipe(
        Effect.orDie,
      );
    return done("", {
      person: {
        id,
        name: named(r),
        status: r.status ?? "guest",
        recognised: placed.kind === "join" && named(r) !== null,
        line: turnLineFor(view, { recognised: true, askName: ask }),
      },
    });
  });

  /** A name for a voice: its own new row, or the person of that name his memory or an earlier voice already holds. */
  const bind = Effect.fn("TessayaPeople.bind")(function* (
    node: Row,
    name: string,
    options: { readonly byOwner: boolean },
  ) {
    const existing = yield* byName(name);
    if (existing !== null && existing.id !== node.id) {
      const a = centroidOf(existing);
      const b = centroidOf(node);
      // Identity only narrows: a name the voice doesn't back is kept apart, for the owner to settle.
      if (!options.byOwner && a !== null && b !== null && cosine(a, b) < VOICE_RULES.suggest) {
        const at = iso(yield* now);
        yield* sql`
          INSERT OR IGNORE INTO fabric_memory_edges (from_id, relation, to_id, item_id, confidence, at)
          VALUES (${node.id}, 'says they are', ${existing.id}, '', 0.5, ${at})
        `.pipe(Effect.orDie);
        return { row: node, recognised: false };
      }
      yield* moveInto(node, existing);
      const merged = (yield* row(existing.id))!;
      if (merged.status === "unknown" || merged.status === null)
        yield* sql`UPDATE fabric_memory_entities SET status = 'guest', kind = 'person' WHERE id = ${merged.id}`.pipe(
          Effect.orDie,
        );
      yield* sql`UPDATE fabric_memory_entities SET keep_until = NULL WHERE id = ${existing.id}`.pipe(
        Effect.orDie,
      );
      return { row: (yield* row(existing.id))!, recognised: true };
    }
    yield* sql`
      UPDATE fabric_memory_entities
      SET name = ${name}, status = CASE WHEN status = 'member' THEN 'member' ELSE 'guest' END,
        keep_until = NULL
      WHERE id = ${node.id}
    `.pipe(Effect.orDie);
    return { row: (yield* row(node.id))!, recognised: true };
  });

  const introduce = Effect.fn("TessayaPeople.introduce")(function* (
    input: Extract<PeopleOp, { op: "peopleIntroduce" }>,
  ) {
    const node = yield* justHeard(input.vessel);
    if (node === null)
      return refused("I didn't catch whose voice that was. Could you say your name again?");
    if (node.status === "member") return done("You're already one of the household.");
    if (node.status === "not_person") return refused("That voice is marked as a TV or radio.");
    const name = nameCase(input.name).slice(0, 60);
    const bound = yield* bind(node, name, { byOwner: false });
    const r = (yield* row(bound.row.id))!;
    const line = turnLineFor(
      { ...(yield* viewOf(r)), name },
      { recognised: bound.recognised, askName: false },
    );
    return done(
      bound.recognised ? `Nice to meet you, ${name}. I'll remember you.` : `I'll call you ${name}.`,
      {
        person: { id: r.id, name, status: r.status ?? "guest", recognised: bound.recognised, line },
      },
    );
  });

  const sweep = Effect.gen(function* () {
    const at = iso(yield* now);
    const due = yield* sql<Row>`
      SELECT * FROM fabric_memory_entities
      WHERE keep_until IS NOT NULL AND keep_until <= ${at} AND status = 'unknown'
        AND forgotten_json IS NULL
    `.pipe(Effect.orDie);
    for (const r of due) yield* softForget(r, "expiry");
    const days = yield* binDays;
    let purged = 0;
    for (const r of yield* binned) {
      const was = Option.getOrNull(decodeForgotten(r.forgotten_json));
      if (was !== null && Date.parse(was.at) + days * DAY_MS <= Date.parse(at)) {
        yield* forgetNode(r);
        purged += 1;
      }
    }
    return due.length + purged;
  }).pipe(Effect.withSpan("TessayaPeople.sweep"));

  const list = Effect.fn("TessayaPeople.list")(function* () {
    const rows = yield* sql<Row>`
      SELECT * FROM fabric_memory_entities
      WHERE forgotten_json IS NULL AND (status IS NOT NULL
         OR id IN (SELECT from_id FROM fabric_memory_edges WHERE item_id != '' AND relation != 'was at'))
      ORDER BY coalesce(last_seen, updated_at) DESC
    `.pipe(Effect.orDie);
    const people: TessayaPerson[] = [];
    for (const r of rows) people.push(yield* personOf(r));
    const different = new Set(
      (yield* sql<{ from_id: string; to_id: string }>`
        SELECT from_id, to_id FROM fabric_memory_edges WHERE relation = 'not_same'
      `.pipe(Effect.orDie)).map((e) => pairKey(e.from_id, e.to_id)),
    );
    const nodes = [];
    for (const r of rows) {
      const c = centroidOf(r);
      if (c === null) continue;
      const vectors = (yield* sql<{ vector: string }>`
        SELECT vector FROM fabric_memory_sightings WHERE entity_id = ${r.id} ORDER BY at DESC LIMIT 40
      `.pipe(Effect.orDie)).flatMap((s) => {
        const v = vectorFromBase64(s.vector);
        return v === null ? [] : [v];
      });
      nodes.push({
        id: r.id,
        status: r.status ?? "guest",
        centroid: c,
        samples: r.voice_samples,
        heard: people.find((p) => p.id === r.id)?.heard ?? 0,
        split: splitTwo(vectors)?.score ?? null,
      });
    }
    const nameOf = (id: string) => {
      const p = people.find((x) => x.id === id);
      return p?.name ?? (p?.status === "not_person" ? "a TV or radio voice" : "someone new");
    };
    const suggestions: TessayaPeopleSuggestion[] = suggestionsFor(nodes, different).map((s) =>
      s.kind === "same"
        ? {
            kind: "same",
            id: s.a,
            other: s.b,
            score: s.score,
            line: `Is ${nameOf(s.a)} the same person as ${nameOf(s.b)}? Their voices sound alike (${s.score.toFixed(2)}).`,
          }
        : s.kind === "name"
          ? {
              kind: "name",
              id: s.id,
              other: null,
              score: null,
              line: `Someone new, heard ${s.heard} times. Who is it?`,
            }
          : {
              kind: "split",
              id: s.id,
              other: null,
              score: s.score,
              line: `${nameOf(s.id)} may be two people: their clips fall into two groups (${s.score.toFixed(2)}).`,
            },
    );
    return done(
      people.length === 0 ? "I don't know anyone by voice yet." : `${people.length} people.`,
      {
        people,
        suggestions,
        retentionDays: yield* unnamedDays,
        askNames: yield* askNamesOn,
        binDays: yield* binDays,
        forgotten: (yield* binned).flatMap((r) => {
          const was = Option.getOrNull(decodeForgotten(r.forgotten_json));
          return was === null ? [] : [{ id: r.id, name: was.name, by: was.by, at: was.at }];
        }),
      },
    );
  });

  /** Who someone is, for whoever asks: the owner hears it all, a member the household facts, a guest only themselves. */
  const who = Effect.fn("TessayaPeople.who")(function* (
    input: Extract<PeopleOp, { op: "peopleWho" }>,
    caller: PeopleCaller,
  ) {
    const owner = (caller.role === "owner" || caller.role === "admin") && caller.assurance >= 1;
    const member = owner || caller.role === "adult" || caller.role === "child";
    const self = yield* justHeard(input.vessel);
    if (input.day !== undefined) {
      if (!owner) return refused("That's for the owner to see.");
      const rows = yield* sql<Row>`
        SELECT DISTINCT e.* FROM fabric_memory_sightings s JOIN fabric_memory_entities e ON e.id = s.entity_id
        WHERE substr(s.at, 1, 10) = ${input.day} AND e.status != 'not_person' AND e.forgotten_json IS NULL
      `.pipe(Effect.orDie);
      return done(
        rows.length === 0
          ? `I didn't hear anyone new on ${input.day}.`
          : `On ${input.day} I heard: ${rows.map(label).join(", ")}.`,
      );
    }
    if (input.event !== undefined) {
      if (!member) return refused("That's the household's to share.");
      const words = input.event.toLowerCase().replace(/^(?:the|our|my) /, "");
      const rows = yield* sql<{ name: string; event: string }>`
        SELECT f.name, t.name AS event FROM fabric_memory_edges e
        JOIN fabric_memory_entities f ON f.id = e.from_id JOIN fabric_memory_entities t ON t.id = e.to_id
        WHERE e.relation = 'was at' AND lower(t.name) LIKE ${`%${words}%`}
      `.pipe(Effect.orDie);
      return done(
        rows.length === 0
          ? `I don't know who was at ${input.event}.`
          : `At ${rows[0]!.event}: ${[...new Set(rows.map((r) => r.name))].join(", ")}.`,
      );
    }
    if (input.name === undefined || input.name.trim() === "") {
      if (self === null) return done("I haven't heard anyone I don't know just now.");
      if (!member) return refused("I can't share that.");
      return done(
        named(self) === null
          ? `That was ${label(self)}; I don't know their name yet.`
          : `That was ${named(self)}.`,
        {
          person: {
            id: self.id,
            name: named(self),
            status: self.status ?? "guest",
            recognised: true,
            line: "",
          },
        },
      );
    }
    const asked = input.name.trim();
    const r =
      (yield* byName(asked)) ??
      (yield* sql<Row>`SELECT * FROM fabric_memory_entities WHERE forgotten_json IS NULL`.pipe(
        Effect.orDie,
      )).find((e) => mentions(asked, { name: e.name, aliases: aliasesOf(e) })) ??
      null;
    if (r === null) return done(`I don't know anyone called ${asked}.`);
    const isSelf = self !== null && self.id === r.id;
    if (!member && !isSelf) return refused(`That's ${asked}'s to share.`);
    const p = yield* personOf(r);
    const facts = p.relations.map((x) => x.text);
    const parts = [`${p.name ?? asked}${facts.length > 0 ? `: ${facts.join("; ")}` : ""}.`];
    // What they said is theirs and the owner's; another member hears only who they are.
    if (owner || isSelf) {
      if (p.firstSeen !== null)
        parts.push(`First heard ${p.firstSeen.slice(0, 10)}, ${p.heard} times in all.`);
      if (p.topics.length > 0)
        parts.push(
          `Last time (${p.topics[0]!.at.slice(0, 10)}): ${p.topics
            .slice(0, 3)
            .map((t) => `"${t.said}"`)
            .join("; ")}.`,
        );
    }
    if (owner) {
      if (p.keepUntil !== null && p.status !== "member")
        parts.push(
          `Their voice is kept until ${p.keepUntil.slice(0, 10)} unless you name or keep them.`,
        );
      if (p.impression !== null) parts.push(`My impression: ${p.impression}.`);
    }
    return done(parts.join(" "));
  });

  const manage = Effect.fn("TessayaPeople.manage")(function* (
    input: Extract<PeopleOp, { op: "peopleManage" }>,
    caller: PeopleCaller,
  ) {
    const owner = caller.role === "owner";
    if (!owner && caller.role !== "admin")
      return refused("Only the owner or an admin changes people.");
    if (caller.assurance < 2) return refused("I need to be sure it's you first.");
    if (caller.tainted === true)
      return refused("People can't be changed from a turn that read outside content.");
    if ((input.action === "merge" || input.action === "forget") && !owner)
      return refused("Only the owner merges or forgets people.");
    if (input.action === "ask" && input.id === undefined) {
      yield* sql`
        INSERT INTO fabric_settings (key, value) VALUES (${ASK_NAMES_KEY}, ${input.on === false ? "off" : "on"})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `.pipe(Effect.orDie);
      return done(
        input.on === false
          ? "I won't ask new people their names."
          : "I'll ask new people their names, at a natural moment.",
      );
    }
    if (input.action === "retention") {
      const days = Math.max(0, Math.min(365, Math.round(input.days ?? 0)));
      yield* sql`
        INSERT INTO fabric_settings (key, value) VALUES (${UNNAMED_DAYS_KEY}, ${String(days)})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `.pipe(Effect.orDie);
      return done(
        days === 0
          ? "I'll keep every voice until you or they ask me to forget it."
          : `New voices I can't put a name to will be forgotten after ${days} days, unless you keep them. Everyone named stays.`,
      );
    }
    if (input.action === "bin") {
      const days = Math.max(1, Math.min(365, Math.round(input.days ?? BIN_DAYS_DEFAULT)));
      yield* sql`
        INSERT INTO fabric_settings (key, value) VALUES (${BIN_DAYS_KEY}, ${String(days)})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `.pipe(Effect.orDie);
      return done(`Forgotten people can be restored for ${days} days.`);
    }
    if (input.action === "restore") {
      const back = yield* restore(input.id ?? "");
      return back === null
        ? refused("That isn't in Recently forgotten.")
        : done(`Restored: ${back}.`);
    }
    if (input.action === "purge") {
      // Permanent, so the owner's alone: one person, or the whole bin with no id.
      if (!owner) return refused("Only the owner deletes people for good.");
      const gone = (yield* binned).filter((x) => input.id === undefined || x.id === input.id);
      for (const x of gone) yield* forgetNode(x);
      return done(gone.length === 0 ? "Nothing to delete." : `Deleted for good: ${gone.length}.`);
    }
    const r = yield* target(input.id, input.vessel);
    if (r === null)
      return refused(
        input.id === "last" ? "I haven't heard anyone new just now." : "I don't know who that is.",
      );
    const at = yield* now;
    switch (input.action) {
      case "name": {
        const name = nameCase(input.name ?? "").slice(0, 60);
        if (name === "") return refused("Say their name.");
        const bound = yield* bind(r, name, { byOwner: true });
        yield* sql`UPDATE fabric_memory_entities SET keep_until = NULL WHERE id = ${bound.row.id}`.pipe(
          Effect.orDie,
        );
        const relation =
          input.relation
            ?.trim()
            .toLowerCase()
            .replace(/^(?:my|our|the) /, "") ?? "";
        if (relation !== "") {
          const works = /^works? with/.test(relation);
          yield* sql`
            INSERT OR IGNORE INTO fabric_memory_edges (from_id, relation, to_id, item_id, confidence, at)
            VALUES (${bound.row.id}, ${works ? "works with" : relation}, ${OWNER_END}, '', 1, ${iso(at)})
          `.pipe(Effect.orDie);
          if (!works) {
            const aliases = [...new Set([...aliasesOf(bound.row), `my ${relation}`])];
            yield* sql`UPDATE fabric_memory_entities SET aliases_json = ${encodeAliases(aliases)} WHERE id = ${bound.row.id}`.pipe(
              Effect.orDie,
            );
          }
        }
        return done(
          `Saved: that's ${name}${relation === "" ? "" : `, your ${relation}`}. I'll know them next time.`,
        );
      }
      case "merge": {
        const into = yield* target(input.into, input.vessel);
        if (into === null || into.id === r.id) return refused("Merge into whom?");
        yield* moveInto(r, into);
        return done(`${label(r)} and ${label(into)} are one person now.`);
      }
      case "split": {
        const sightings = yield* sql<{ id: string; vector: string }>`
          SELECT id, vector FROM fabric_memory_sightings WHERE entity_id = ${r.id} ORDER BY at
        `.pipe(Effect.orDie);
        const vectors = sightings.map((s) => vectorFromBase64(s.vector) ?? new Float32Array());
        const parts = splitTwo(vectors);
        if (parts === null) return refused("I haven't heard enough of that voice to split it.");
        const centre = (idx: ReadonlyArray<number>) =>
          idx.reduce<Float32Array | null>(
            (c, i, n) => (c === null ? vectors[i]! : mergeCentroid(c, n, vectors[i]!)),
            null,
          )!;
        const id = globalThis.crypto.randomUUID();
        yield* sql`
          INSERT INTO fabric_memory_entities (id, name, aliases_json, updated_at, kind, status, voice_model,
            voice_centroid, voice_samples, first_seen, last_seen, keep_until)
          VALUES (${id}, ${`?${id.slice(0, 8)}`}, '[]', ${iso(at)}, 'person', 'unknown', ${r.voice_model},
            ${vectorToBase64(centre(parts.b))}, ${parts.b.length}, ${iso(at)}, ${iso(at)},
            ${yield* unnamedUntil(at)})
        `.pipe(Effect.orDie);
        const moved = parts.b.map((i) => sightings[i]!.id);
        yield* sql`UPDATE fabric_memory_sightings SET entity_id = ${id} WHERE id IN ${sql.in(moved)}`.pipe(
          Effect.orDie,
        );
        yield* sql`
          UPDATE fabric_memory_entities SET voice_centroid = ${vectorToBase64(centre(parts.a))},
            voice_samples = ${parts.a.length}
          WHERE id = ${r.id}
        `.pipe(Effect.orDie);
        yield* sql`
          INSERT OR IGNORE INTO fabric_memory_edges (from_id, relation, to_id, item_id, confidence, at)
          VALUES (${r.id}, 'not_same', ${id}, '', 1, ${iso(at)})
        `.pipe(Effect.orDie);
        return done(`Split: ${moved.length} of ${label(r)}'s turns are someone new now.`);
      }
      case "notSame": {
        const other = yield* target(input.into, input.vessel);
        if (other === null) return refused("Not the same as whom?");
        yield* sql`
          INSERT OR IGNORE INTO fabric_memory_edges (from_id, relation, to_id, item_id, confidence, at)
          VALUES (${r.id}, 'not_same', ${other.id}, '', 1, ${iso(at)})
        `.pipe(Effect.orDie);
        return done(`Got it: ${label(r)} and ${label(other)} are different people.`);
      }
      case "notPerson": {
        // A TV's voice is kept, so it is recognised and ignored; what it said is no one's and goes.
        yield* sql`DELETE FROM fabric_memory_sightings WHERE entity_id = ${r.id}`.pipe(
          Effect.orDie,
        );
        yield* sql`
          UPDATE fabric_memory_entities SET status = 'not_person', keep_until = NULL, ask_name = 0 WHERE id = ${r.id}
        `.pipe(Effect.orDie);
        return done("Marked as a TV or radio: I'll ignore it.");
      }
      case "setStatus": {
        if (input.status === "member") {
          const m = yield* sql<{ id: string; name: string }>`
            SELECT id, name FROM tessaya_household_members WHERE id = ${input.member ?? ""} AND removed_at IS NULL
          `.pipe(Effect.orDie);
          if (m[0] === undefined)
            return refused("Which member is it? Add them in Household first.");
          yield* sql`
            UPDATE fabric_memory_entities SET status = 'member', member_id = ${m[0].id}, keep_until = NULL
            WHERE id = ${r.id}
          `.pipe(Effect.orDie);
          return done(`Marked as ${m[0].name}, a member.`);
        }
        if (named(r) === null) return refused("Name them first.");
        yield* sql`UPDATE fabric_memory_entities SET status = 'guest', member_id = NULL WHERE id = ${r.id}`.pipe(
          Effect.orDie,
        );
        return done(`${label(r)} is a guest.`);
      }
      case "save":
        yield* sql`UPDATE fabric_memory_entities SET keep_until = NULL WHERE id = ${r.id}`.pipe(
          Effect.orDie,
        );
        return done(`I'll keep ${label(r)}.`);
      case "unsave": {
        const days = yield* unnamedDays;
        if (named(r) !== null)
          return refused(
            `${label(r)} is named, so I remember them; ask me to forget them instead.`,
          );
        if (days === 0)
          return refused("Unnamed voices are kept until you forget them: set an expiry first.");
        const until = iso(at + days * DAY_MS);
        yield* sql`UPDATE fabric_memory_entities SET keep_until = ${until} WHERE id = ${r.id}`.pipe(
          Effect.orDie,
        );
        return done(`${label(r)} is kept until ${until.slice(0, 10)}, then forgotten.`);
      }
      case "ask":
        yield* sql`UPDATE fabric_memory_entities SET ask_name = ${input.on === false ? 0 : 1} WHERE id = ${r.id}`.pipe(
          Effect.orDie,
        );
        return done(input.on === false ? "I won't ask their name." : "I may ask their name.");
      case "forget": {
        if (input.confirmed !== true)
          return {
            status: "asked",
            line: `Forget everything about ${label(r)}: ${(yield* whatGoes(r)) || "what I know of them"}? It can be undone for ${yield* binDays} days. Ask for a clear yes, then call again with confirmed.`,
          } satisfies Result;
        const days = yield* softForget(r, "owner");
        return done(`Forgotten: ${label(r)}. You can restore them in People for ${days}.`);
      }
    }
  });

  const call = Effect.fn("TessayaPeople.call")(function* (input: PeopleOp, caller: PeopleCaller) {
    switch (input.op) {
      case "peopleObserve":
        // Only a vessel's turn files a voice: its caller is the vessel's, whoever spoke.
        return yield* observe(input);
      case "peopleIntroduce":
        return yield* introduce(input);
      case "peopleForgetMe": {
        const node = yield* justHeard(input.vessel);
        if (node === null)
          return refused("I didn't catch whose voice that was. Could you say it again?");
        if (node.status === "member")
          return refused("You're a member here: the owner removes members, in Household.");
        if (input.confirmed !== true)
          return {
            status: "asked",
            line: `Before I do: forgetting you removes ${(yield* whatGoes(node)) || "what I know of you"}. Ask them for a clear yes, then call again with confirmed.`,
          } satisfies Result;
        yield* softForget(node, "themselves");
        return done(
          "Done. I've forgotten you. If you change your mind, the owner can bring it back for a while.",
        );
      }
      case "peopleList": {
        if ((caller.role !== "owner" && caller.role !== "admin") || caller.assurance < 2)
          return refused("Only the owner or an admin sees everyone.");
        yield* sweep;
        return yield* list();
      }
      case "peopleWho":
        return yield* who(input, caller);
      case "peopleManage":
        return yield* manage(input, caller);
    }
  });

  return TessayaPeople.of({
    call,
    sweep,
    lastHeard: sql<{ id: string; name: string; last_at: string; seen: number }>`
      SELECT e.id, e.name, MAX(s.at) AS last_at, COUNT(*) AS seen
      FROM fabric_memory_entities e JOIN fabric_memory_sightings s ON s.entity_id = e.id
      WHERE e.status = 'guest' GROUP BY e.id
    `.pipe(
      Effect.map((rows) =>
        rows.map((r) => ({ id: r.id, name: r.name, lastAt: Date.parse(r.last_at), seen: r.seen })),
      ),
      Effect.orDie,
      Effect.withSpan("TessayaPeople.lastHeard"),
    ),
    setImpression: Effect.fn("TessayaPeople.setImpression")(function* (
      id: string,
      text: string | null,
    ) {
      const value = text?.trim().slice(0, 400) ?? "";
      yield* sql`
        UPDATE fabric_memory_entities SET impression = ${value === "" ? null : value} WHERE id = ${id}
      `.pipe(Effect.orDie);
    }),
    forgotten: Stream.fromPubSub(forgotten),
  });
});

/** The service, and the retention job: unsaved voices go when their date passes, checked every six hours. */
export const layer = Layer.effect(
  TessayaPeople,
  Effect.gen(function* () {
    const people = yield* make;
    yield* people.sweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("people retention sweep failed", cause)),
      Effect.repeat(Schedule.spaced("6 hours")),
      Effect.forkScoped,
    );
    return people;
  }),
);
