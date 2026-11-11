/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Effects from the mode machine → the existing Baton intent path → §14's
 * destination. The router decides nothing the intent path already decides:
 * the grammar, learned phrasings and the model reading all live behind
 * `fabric.intent.resolve` / `fabric.intent.run` (IntentService). What it adds
 * is the voice-only part:
 *
 *   1. The §24.1 high-risk check runs on the raw transcript *before* anything
 *      leaves the client, and again on the resolution that comes back.
 *   2. A resolution that is not low risk is read back and needs a spoken
 *      "confirm" in a later utterance (modeMachine enforces "later" and that a
 *      wake word is never the yes). High risk is refused outright by voice.
 *   3. Dictation never reaches the environment (batonDictation's rule).
 *   4. Destination: explicit target (grammar) → conversation target → the
 *      context bus ladder (resolveContextWorkSession).
 *
 * @module baton-voice/router
 */
import type { SpeakerIdentity } from "./speaker.ts";
import type { CutIn } from "@t3tools/baton-shared/endOfTurn";
import type { BatonIntentResolution } from "@t3tools/baton-contracts";
import {
  resolveContextWorkSession,
  resolveInjectionTarget,
  type ContextBusState,
} from "@t3tools/baton-shared/contextBus";
import { highRiskSubject } from "@t3tools/baton-shared/intentParser";

import type { VoiceEffect } from "./modeMachine.ts";

/** The intent RPCs, as the host app already calls them. */
export interface VoiceIntentClient {
  readonly resolve: (input: {
    readonly text: string;
    readonly focusedWorkSessionId: string | null;
    readonly allowModel: boolean;
  }) => Promise<BatonIntentResolution>;
  readonly run: (input: {
    readonly text: string;
    readonly focusedWorkSessionId: string | null;
  }) => Promise<{ readonly resolution: BatonIntentResolution; readonly reply: string }>;
  /** Direct-session mode: a user message to the session, verbatim. */
  readonly sendToSession: (input: {
    readonly workSessionId: string;
    readonly text: string;
  }) => Promise<{ readonly reply: string }>;
  /** Dictation: insert into the focused field (§18). Never reaches the environment. */
  readonly insertText: (input: {
    readonly text: string;
  }) => Promise<{ readonly inserted: boolean }>;
}

export interface RouteContext {
  readonly bus: ContextBusState;
  readonly now: number;
  readonly mostRecentWorkSessionId?: string | null;
  /** The wake word this sentence answers to (the last one said before it); null for a hotkey or none. */
  readonly wake?: string | null;
  /** He cut her off: what she had said by then. His words carry on from it. */
  readonly cutIn?: CutIn | null;
  /** Whose voice said it (Voice ID); absent or null when unknown, typed, or Voice ID is off. */
  readonly speaker?: SpeakerIdentity | null;
}

export type RouteOutcome =
  | {
      readonly kind: "ran";
      readonly reply: string;
      readonly workSessionId: string | null;
      readonly source: string;
    }
  | {
      readonly kind: "needs_confirmation";
      readonly token: string;
      readonly prompt: string;
      readonly workSessionId: string | null;
    }
  | { readonly kind: "refused"; readonly reply: string; readonly reason: string }
  | { readonly kind: "sent_to_session"; readonly reply: string; readonly workSessionId: string }
  | { readonly kind: "dictated"; readonly inserted: boolean; readonly reply: string }
  | { readonly kind: "none" };

interface Parked {
  readonly text: string;
  readonly focusedWorkSessionId: string | null;
  readonly workSessionId: string | null;
}

const highRiskReply = (subject: string): string =>
  `That asks for ${subject}. A spoken sentence never does that — do it yourself, with the change in front of you.`;

export interface VoiceRouter {
  readonly route: (effect: VoiceEffect, context: RouteContext) => Promise<RouteOutcome>;
  /**
   * Think a command through before he has surely finished: reads only, never speaks or acts. The
   * returned `go` does the rest, as `route` would; a turn he carried on from is never sent.
   */
  readonly prepare?: (
    effect: Extract<VoiceEffect, { kind: "command" }>,
    context: RouteContext,
  ) => Promise<() => Promise<RouteOutcome>>;
}

export const createVoiceRouter = (client: VoiceIntentClient): VoiceRouter => {
  const parked = new Map<string, Parked>();
  let counter = 0;

  const focusFor = (inherited: string | null, context: RouteContext): string | null =>
    inherited ??
    resolveContextWorkSession(context.bus, {
      now: context.now,
      mostRecentWorkSessionId: context.mostRecentWorkSessionId ?? null,
    }).workSessionId;

  const run = async (text: string, focusedWorkSessionId: string | null): Promise<RouteOutcome> => {
    const { resolution, reply } = await client.run({ text, focusedWorkSessionId });
    if (resolution.outcome === "refused") {
      return {
        kind: "refused",
        reply: reply || resolution.refusal.message,
        reason: resolution.refusal.reason,
      };
    }
    return { kind: "ran", reply, workSessionId: resolution.workSessionId, source: "intent" };
  };

  const prepare: NonNullable<VoiceRouter["prepare"]> = async (effect, context) => {
    const done = (outcome: RouteOutcome) => async () => outcome;
    // Before: never send a high-risk sentence anywhere.
    const subject = highRiskSubject(effect.text);
    if (subject !== null)
      return done({ kind: "refused", reply: highRiskReply(subject), reason: "high_risk" });
    const focusedWorkSessionId = focusFor(effect.inheritedTarget, context);
    const resolution = await client.resolve({
      text: effect.text,
      focusedWorkSessionId,
      allowModel: true,
    });
    if (resolution.outcome === "refused") {
      return done({
        kind: "refused",
        reply: resolution.refusal.message,
        reason: resolution.refusal.reason,
      });
    }
    // After: whatever read it (grammar or model), the answer is re-checked.
    if (resolution.risk === "high") {
      return done({
        kind: "refused",
        reply: highRiskReply("a high-risk action"),
        reason: "high_risk",
      });
    }
    const reads = resolution.command.kind.startsWith("status_");
    if (resolution.risk === "medium" || (effect.restated === true && !reads)) {
      return async () => {
        counter += 1;
        const token = `confirm-${counter}`;
        parked.set(token, {
          text: effect.text,
          focusedWorkSessionId,
          workSessionId: resolution.workSessionId,
        });
        return {
          kind: "needs_confirmation",
          token,
          prompt: `${effect.restated === true ? `I took that as: ${effect.text} ` : ""}${resolution.description} Say "confirm" to go ahead.`,
          workSessionId: resolution.workSessionId,
        };
      };
    }
    return () => run(effect.text, focusedWorkSessionId);
  };

  const route = async (effect: VoiceEffect, context: RouteContext): Promise<RouteOutcome> => {
    switch (effect.kind) {
      case "dictate": {
        const target = resolveInjectionTarget(context.bus, { now: context.now });
        if (target === null) {
          return { kind: "dictated", inserted: false, reply: "Nothing editable is focused." };
        }
        const { inserted } = await client.insertText({ text: effect.text });
        return {
          kind: "dictated",
          inserted,
          reply: inserted ? "" : `${target.label} did not take the text.`,
        };
      }

      case "session_message": {
        const subject = highRiskSubject(effect.text);
        if (subject !== null)
          return { kind: "refused", reply: highRiskReply(subject), reason: "high_risk" };
        const ladder = resolveContextWorkSession(context.bus, {
          now: context.now,
          mostRecentWorkSessionId: null,
        });
        // Direct-session speech goes only where the user is looking. "Most
        // recent" is not looking, so it is not enough here.
        if (ladder.workSessionId === null || ladder.rung === "most_recent") {
          return { kind: "refused", reply: "No session is focused.", reason: "no_focus" };
        }
        const { reply } = await client.sendToSession({
          workSessionId: ladder.workSessionId,
          text: effect.text,
        });
        return { kind: "sent_to_session", reply, workSessionId: ladder.workSessionId };
      }

      case "command":
        return (await prepare(effect, context))();

      case "confirmed": {
        const item = parked.get(effect.token);
        if (item === undefined)
          return {
            kind: "refused",
            reply: "There is nothing to confirm.",
            reason: "nothing_parked",
          };
        parked.delete(effect.token);
        // Re-resolve at execution time: if the world moved (gate answered, session gone),
        // the run path refuses rather than doing what was true fifteen seconds ago.
        return run(item.text, item.focusedWorkSessionId);
      }

      case "cancelled":
        parked.delete(effect.token);
        return { kind: "none" };

      case "speak":
      case "ignored":
        return { kind: "none" };
    }
  };

  return { route, prepare };
};
