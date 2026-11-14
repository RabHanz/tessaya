/**
 * Shared brain slots for many vessels (MEMORY-V2-DESIGN §2.0a): interactive turns go first and keep `reserved` slots;
 * within a class, vessels and personas take turns so none starves another (CS5); one thread has one turn in flight.
 * Batch work runs in small units, so a turn waits at most one unit.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type TurnClass = "interactive" | "proactive" | "background" | "batch";
const CLASSES: ReadonlyArray<TurnClass> = ["interactive", "proactive", "background", "batch"];

export interface PoolSpec {
  readonly slots: number;
  /** Slots only an interactive turn may take. */
  readonly reserved: number;
}

/** What the pools hold today: the brain's turns and the learning loop's model calls. */
export const DEFAULT_POOLS: Readonly<Record<string, PoolSpec>> = {
  // shortcut: a fixed count; tie it to the box's measured load when degradation lands (§2.0a).
  // One per vessel in a five-vessel home (the load test); two are kept for turns, so batch units never crowd them.
  brain: { slots: 5, reserved: 2 },
  learn: { slots: 1, reserved: 0 },
};

export interface PoolStats {
  readonly pool: string;
  readonly running: number;
  readonly waiting: Readonly<Record<TurnClass, number>>;
  /** Queue waits per vessel over its last few uses (ms), for the Now page. */
  readonly waits: Readonly<Record<string, { readonly p50: number; readonly p95: number }>>;
}

export class TurnPools extends Context.Service<
  TurnPools,
  {
    /** Runs `work` in a slot of `pool`, queued by class and vessel; logs how long it waited and ran. */
    readonly run: <A, E, R>(
      pool: string,
      by: TurnBy,
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly stats: Effect.Effect<ReadonlyArray<PoolStats>>;
  }
>()("t3/tessaya/TurnPools") {}

/** Who a slot is for: the vessel, its class, and (for a turn) the persona and its thread. */
interface TurnBy {
  readonly vessel: string;
  readonly class: TurnClass;
  readonly persona?: string | null;
  readonly thread?: string;
}

interface Waiter {
  readonly vessel: string;
  readonly persona: string | null;
  readonly thread: string | undefined;
  readonly gate: Deferred.Deferred<void>;
}

const RECENT = 50;
const quantile = (xs: ReadonlyArray<number>, q: number) => {
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

export const makeWith = (specs: Readonly<Record<string, PoolSpec>>) =>
  Effect.sync(() => {
    const pools = new Map(
      Object.entries(specs).map(([name, spec]) => [
        name,
        {
          spec,
          running: 0,
          queues: new Map<TurnClass, Array<Waiter>>(CLASSES.map((c) => [c, []])),
          // The vessel and persona served last in each class, so the next one in line is someone else.
          last: new Map<TurnClass, { vessel: string; persona: string | null }>(),
          // Threads with a turn in a slot now: the next turn of the same thread waits for it.
          threads: new Set<string>(),
          waits: new Map<string, Array<number>>(),
        },
      ]),
    );
    const poolOf = (name: string) => {
      const pool = pools.get(name);
      if (pool === undefined) throw new Error(`no pool named ${name}`);
      return pool;
    };
    type Pool = ReturnType<typeof poolOf>;
    const mayTake = (pool: Pool, cls: TurnClass) =>
      pool.running < pool.spec.slots - (cls === "interactive" ? 0 : pool.spec.reserved);

    /** The next waiter to get a free slot: the highest class that may take one, then the vessel after the last served. */
    const next = (pool: Pool): Waiter | null => {
      for (const cls of CLASSES) {
        const queue = pool.queues.get(cls)!;
        if (queue.length === 0 || !mayTake(pool, cls)) continue;
        const free = queue.filter((w) => w.thread === undefined || !pool.threads.has(w.thread));
        if (free.length === 0) continue;
        const last = pool.last.get(cls);
        const chosen =
          free.find((w) => w.persona !== last?.persona && w.vessel !== last?.vessel) ??
          free.find((w) => w.persona !== last?.persona) ??
          free.find((w) => w.vessel !== last?.vessel) ??
          free[0]!;
        queue.splice(queue.indexOf(chosen), 1);
        pool.last.set(cls, { vessel: chosen.vessel, persona: chosen.persona });
        if (chosen.thread !== undefined) pool.threads.add(chosen.thread);
        return chosen;
      }
      return null;
    };
    const wake = (pool: Pool) => {
      for (let w = next(pool); w !== null; w = next(pool)) {
        pool.running += 1;
        Deferred.doneUnsafe(w.gate, Effect.void);
      }
    };

    const run = Effect.fn("TurnPools.run")(function* <A, E, R>(
      name: string,
      by: TurnBy,
      work: Effect.Effect<A, E, R>,
    ) {
      const pool = poolOf(name);
      const queuedAt = yield* Clock.currentTimeMillis;
      const gate = yield* Deferred.make<void>();
      const waiter: Waiter = {
        vessel: by.vessel,
        persona: by.persona ?? null,
        thread: by.thread,
        gate,
      };
      const release = () => {
        pool.running -= 1;
        if (by.thread !== undefined) pool.threads.delete(by.thread);
        wake(pool);
      };
      yield* Effect.sync(() => {
        pool.queues.get(by.class)!.push(waiter);
        wake(pool);
      });
      yield* Deferred.await(gate).pipe(
        // Given up while waiting: out of the queue; given up just after its slot came: the slot goes back.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            const queue = pool.queues.get(by.class)!;
            const at = queue.indexOf(waiter);
            if (at >= 0) queue.splice(at, 1);
            else release();
          }),
        ),
      );
      const startedAt = yield* Clock.currentTimeMillis;
      const waits = pool.waits.get(by.vessel) ?? [];
      waits.push(startedAt - queuedAt);
      pool.waits.set(by.vessel, waits.slice(-RECENT));
      return yield* work.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Effect.sync(release);
            yield* Effect.logDebug("turn pool", {
              pool: name,
              vessel: by.vessel,
              class: by.class,
              waitMs: startedAt - queuedAt,
              runMs: (yield* Clock.currentTimeMillis) - startedAt,
            });
          }),
        ),
      );
    });

    const stats = Effect.sync(() =>
      [...pools.entries()].map(([pool, p]) => ({
        pool,
        running: p.running,
        waiting: Object.fromEntries(CLASSES.map((c) => [c, p.queues.get(c)!.length])) as Record<
          TurnClass,
          number
        >,
        waits: Object.fromEntries(
          [...p.waits.entries()].map(([v, xs]) => [
            v,
            { p50: quantile(xs, 0.5), p95: quantile(xs, 0.95) },
          ]),
        ),
      })),
    );

    return TurnPools.of({ run, stats });
  });

export const layer = Layer.effect(TurnPools, makeWith(DEFAULT_POOLS));
