/**
 * The turn rules every vessel decides with (tessaya-ops research/MEMORY-V2-DESIGN.md step 2d): whether a line began
 * while her own voice was in the room, whether it is her echo, and whether it was said to her. Pure, so the desk
 * device's loop (`room/roomVoice.ts`), the desktop (`core.ts`) and a phone decide the same way on the same facts.
 * @module baton-voice/turnRules
 */
import { isAddressedFollowUp } from "@t3tools/baton-shared/followUp";

import { isBackchannel } from "./room/addressing.ts";

/** Where her own playback stands on the vessel, in its clock (ms). */
export interface Playback {
  /** When the last audio she was sent ends. */
  readonly playUntil: number;
  /** How long the speaker plays behind what it was sent. */
  readonly downDelayMs: number;
  /** How long her voice still rings in the room after it stops. */
  readonly echoTailMs: number;
  /** How far the mic's audio runs behind the vessel's clock. */
  readonly upDelayMs: number;
}

/** When her voice stops being audible. */
export const audibleEnd = (p: Playback) => p.playUntil + p.downDelayMs;

/** A line that began while her own voice could still be heard: some of it may be hers. */
export const beganOverHer = (startedAt: number, p: Playback) =>
  startedAt <= audibleEnd(p) + p.echoTailMs;

/** A Bluetooth speaker plays a little behind what the vessel has been sent. */
const BT_SLACK_MS = 300;

export interface EchoFacts {
  readonly startedAt: number;
  /** When the mic last heard voice in this line. */
  readonly lastVoice: number;
  /** He called a persona by name in it. */
  readonly called: boolean;
  /** Its words match a line she said lately. */
  readonly own: boolean;
  /** How closely its loudness follows hers (0 to 1), asked only when needed. */
  readonly likeness: () => number;
}

/** Whether a line is her own voice coming back through the mic, and how alike it sounded (0 when never asked). */
export const echoVerdict = (
  facts: EchoFacts,
  p: Playback,
): {
  readonly hers: boolean;
  readonly during: boolean;
  /** It was compared with her voice by sound (it began close enough to her playback to need it). */
  readonly compared: boolean;
  readonly likeness: number;
} => {
  const end = audibleEnd(p);
  const herEnd = end + p.echoTailMs;
  const during = facts.startedAt <= end + BT_SLACK_MS;
  if (facts.startedAt > herEnd) return { hers: false, during, compared: false, likeness: 0 };
  // A name inside her own words ("Freya here") is not him calling; a name otherwise is him.
  if (facts.called && !(during && facts.own))
    return { hers: false, during, compared: false, likeness: 0 };
  if (!during && facts.lastVoice - p.upDelayMs > herEnd)
    return { hers: false, during, compared: false, likeness: 0 };
  const like = facts.likeness();
  // How it sounds decides, never her words alone: on 13 Nov (10:36-10:37) lines of his at likeness 0.00 to 0.41 that
  // shared words with her were lost, while her real echo measured 0.82 to 0.91. Her words only tip a near match.
  const hers = during
    ? like >= 0.6 || (like >= 0.5 && facts.own)
    : like >= 0.75 || (like >= 0.6 && facts.own);
  return { hers, during, compared: true, likeness: like };
};

/** The windows a vessel keeps open after waking or answering (its clock, ms). */
export interface Windows {
  /** Just woken by name or button: whatever he says first is hers. */
  readonly firstUntil: number;
  /** After her reply: a follow-up needs no name. */
  readonly openUntil: number;
  /** Her last line asked him something, so his next words are the answer. */
  readonly invited: boolean;
}

/**
 * Said to her: she was named, it began inside the first window, or inside the follow-up window it is more than a
 * stray "yeah" she did not ask for. The rule a room hears with, where the TV is far and he often says one word.
 */
export const addressedInRoom = (
  words: string,
  called: boolean,
  startedAt: number,
  w: Windows,
): boolean =>
  called ||
  startedAt <= w.firstUntil ||
  (startedAt <= w.openUntil && (w.invited || !isBackchannel(words)));

/**
 * A follow-up with no name at a desk: only what reads as meant for her (a question, a request, a continuation, her
 * name), or anything once she asked him something. Stricter than the room's, since the desk mic hears his calls and
 * dictation. shortcut: two rules until the room and desk evals show one serves both.
 */
export const addressedAtDesk = (words: string, invited: boolean): boolean =>
  invited || isAddressedFollowUp(words);
