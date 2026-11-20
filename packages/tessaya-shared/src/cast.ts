/**
 * Who wears which body (B-002, MA-015; Director 16 Nov 18:05): one persona is one mind in many bodies. Each body has a
 * home persona, may follow whoever its person last talked to, may hold several at once (the desktop), and a called
 * persona visits until the conversation ends, unless he said "stay". Mood is not here: a body asks the one mood
 * function (TessayaMood) with the persona it wears.
 */
import type { TessayaBodyForm } from "@t3tools/contracts";

/** A body's standing rule, kept in the `tessayaCast` server setting (the desktop's in its own settings). */
export interface BodyCast {
  /** Pinned: "Freya lives on the desktop". Unset is the roster's lead. */
  readonly home?: string | undefined;
  /** Whoever its person last talked to on any body moves here. */
  readonly follows?: boolean | undefined;
  /** Others beside the one it wears, where the body can show several (the desktop). */
  readonly crew?: ReadonlyArray<string> | undefined;
  /** The form she takes here, when he chose one (formOf). */
  readonly form?: TessayaBodyForm | undefined;
}

/**
 * The form she takes on a body: a Tessel is always Tumble's own, any other body his choice, else what it draws today
 * (the phone's Talk tab draws a human body; her cartoon everywhere else). One self in every form: mood isn't here.
 */
export const formOf = (kind: string, cast: BodyCast | undefined): TessayaBodyForm =>
  // the registry's kind for a Tessel, and the devices door's
  kind === "r1" || kind === "agora-r1"
    ? "tumble"
    : cast?.form !== undefined && cast.form !== "tumble"
      ? cast.form
      : kind === "phone"
        ? "human"
        : "cartoon";

/** A called-upon move: temporary, it returns home once the conversation lapses, unless he said "stay". */
export interface Visit {
  readonly persona: string;
  /** When it came, or its body's last turn since. */
  readonly at: number;
  readonly stay: boolean;
}

export type WearingWhy = "visit" | "stay" | "follows" | "home" | "lead";

export interface Wearing {
  readonly persona: string;
  readonly why: WearingWhy;
}

interface RosterEntry {
  readonly id: string;
  readonly name: string;
}

/** As long as a conversation itself lasts (TessayaTurn's idle boundary, CurrentPersona's hold). */
export const VISIT_MS = 10 * 60_000;

/** A persona named by id or name, any case, among the live roster (a retired one has left it). */
export const personaIn = (roster: ReadonlyArray<RosterEntry>, key: string | null | undefined) => {
  if (key === null || key === undefined) return null;
  const k = key.trim().toLowerCase();
  return roster.find((p) => p.id === k || p.name.toLowerCase() === k)?.id ?? null;
};

export const visitLive = (visit: Visit | undefined, now: number): visit is Visit =>
  visit !== undefined && (visit.stay || now - visit.at <= VISIT_MS);

/** The persona a body wears now: a live visit, then whom its person follows, then its home, then the lead. */
export const wearing = (
  cast: BodyCast | undefined,
  ctx: {
    readonly roster: ReadonlyArray<RosterEntry>;
    readonly visit?: Visit | undefined;
    /** The persona its person last talked to anywhere (CurrentPersona), when it is still held. */
    readonly followed?: string | null | undefined;
    readonly now: number;
  },
): Wearing | null => {
  const visitor = visitLive(ctx.visit, ctx.now) ? personaIn(ctx.roster, ctx.visit.persona) : null;
  if (visitor !== null) return { persona: visitor, why: ctx.visit?.stay ? "stay" : "visit" };
  const followed = cast?.follows === true ? personaIn(ctx.roster, ctx.followed) : null;
  if (followed !== null) return { persona: followed, why: "follows" };
  const home = personaIn(ctx.roster, cast?.home);
  if (home !== null) return { persona: home, why: "home" };
  const lead = ctx.roster[0];
  return lead === undefined ? null : { persona: lead.id, why: "lead" };
};

/** Everyone on a body: the one it wears first, then its crew, each once, at most `max` in all. */
export const onBody = (
  cast: BodyCast | undefined,
  worn: Wearing | null,
  roster: ReadonlyArray<RosterEntry>,
  max: number,
): ReadonlyArray<string> => {
  const all = [worn?.persona, ...(cast?.crew ?? []).map((c) => personaIn(roster, c))];
  return [...new Set(all.filter((p): p is string => p !== null && p !== undefined))].slice(0, max);
};

/**
 * May this change who wears a body? Only his own ask, from a verified voice or a signed-in surface. A wake word
 * (true or false) and the persona a turn was answered in never do: they last only for that session, so a false wake
 * can't silently re-home a body.
 */
export const mayRecast = (how: "wake" | "turn" | "ask", verified: boolean) =>
  how === "ask" && verified;
