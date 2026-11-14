/** Session monitoring (D146): sessions left alone when they should not be, read from the fleet's state. */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "@t3tools/contracts";

import { WorkSessionId } from "./workSession.ts";

export const BATON_WATCH_WS_METHODS = { watchGet: "baton.watch.get" } as const;

export const WatchFinding = Schema.Struct({
  workSessionId: WorkSessionId,
  title: TrimmedNonEmptyString,
  kind: Schema.Literals(["failed", "limited", "offline", "stalled", "unanswered", "unseen"]),
  /** How long since anything happened in it. */
  minutes: Schema.Number,
  /** What it last did, from its synopsis. */
  lastDid: Schema.optionalKey(Schema.String),
});
export type WatchFinding = typeof WatchFinding.Type;

export const WatchResult = Schema.Struct({ findings: Schema.Array(WatchFinding) });
export type WatchResult = typeof WatchResult.Type;
