/**
 * Live state put in front of her for the next few turns and then gone (VOXTA-STUDY G6, B-011): presence, a screen
 * sighting, motion, a device report. A feeder injects a line with a turn count; each turn on its vessel reads it and
 * spends one, so she never answers from an old world. One store for every feeder and every vessel's turn.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { emitAction } from "./turnActions.ts";

export interface LiveContext {
  /** One line per key and vessel: a newer report of the same thing replaces the old. */
  readonly key: string;
  readonly line: string;
  readonly expiresAfterTurns: number;
  /** The vessel whose turns read it; absent, every vessel's. */
  readonly vessel?: string | undefined;
  /** The persona it is about (her body felt it): only her turns read it, and a turn with none named (the lead's). */
  readonly persona?: string | undefined;
  /** What fed it, for provenance ("motion", "screen", "device", "presence"). */
  readonly source: string;
}

export class TurnLiveContext extends Context.Service<
  TurnLiveContext,
  {
    readonly inject: (live: LiveContext) => Effect.Effect<void>;
    /**
     * The lines for a turn on `vessel`, joined. `spend` false reads without counting the turn (one person's context
     * among several heard at once).
     */
    readonly take: (input: {
      readonly vessel: string;
      readonly persona: string | null;
      readonly spend: boolean;
    }) => Effect.Effect<string>;
  }
>()("t3/tessaya/TurnLiveContext") {}

export const make = Effect.sync(() => {
  // shortcut: in this server's memory; a restart forgets live state, which is what it is for.
  const kept = new Map<string, LiveContext & { left: number }>();
  const inject = Effect.fn("TurnLiveContext.inject")(function* (live: LiveContext) {
    if (live.expiresAfterTurns < 1 || live.line.trim() === "") return;
    kept.set(`${live.vessel ?? "*"}|${live.persona ?? "*"}|${live.key}`, {
      ...live,
      left: live.expiresAfterTurns,
    });
    yield* emitAction({
      kind: "turn.context.injected",
      actor: { kind: "device", id: live.source, certainty: 1 },
      subject: live.key,
      data: { vessel: live.vessel ?? null, expiresAfterTurns: live.expiresAfterTurns },
    });
  });
  const take = Effect.fn("TurnLiveContext.take")(function* (input: {
    readonly vessel: string;
    readonly persona: string | null;
    readonly spend: boolean;
  }) {
    const lines: string[] = [];
    for (const [id, live] of kept) {
      if (live.vessel !== undefined && live.vessel !== input.vessel) continue;
      if (live.persona !== undefined && input.persona !== null && live.persona !== input.persona)
        continue;
      lines.push(live.line);
      if (!input.spend) continue;
      live.left -= 1;
      if (live.left > 0) continue;
      kept.delete(id);
      yield* emitAction({
        kind: "turn.context.expired",
        actor: { kind: "rule", id: "expiresAfterTurns", certainty: 1 },
        subject: live.key,
        persona: input.persona,
        data: { vessel: input.vessel, source: live.source, afterTurns: live.expiresAfterTurns },
      });
    }
    return lines.join(" ");
  });
  return TurnLiveContext.of({ inject, take });
});

export const layer = Layer.effect(TurnLiveContext, make);
