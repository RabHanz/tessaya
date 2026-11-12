import { SPECIALISTS, type RoomCase } from "./cases.ts";

export interface RoomSample {
  /** Her reply to each sentence, as the room heard it. */
  readonly replies: ReadonlyArray<string>;
  /** Every tool or act she used, across the whole conversation. */
  readonly calls: ReadonlyArray<string>;
  /** The study lamp after each sentence. */
  readonly lamp: ReadonlyArray<"on" | "off">;
  /** Milliseconds from the brain's start to its first word, per sentence. */
  readonly firstMs: ReadonlyArray<number | null>;
}

/** The HA-mode tail he heard after every answer. */
const HOUSE_TAIL = /nothing in the house|house needs|needs changing/i;

/** Why a sample fails, or null when it passes. */
export const failureOf = (c: RoomCase, s: RoomSample): string | null => {
  if (s.replies.length !== c.said.length || s.replies.some((r) => r.trim() === ""))
    return "no reply";
  if (s.replies.some((r) => HOUSE_TAIL.test(r))) return "talked about the house unasked";
  for (const re of c.says ?? []) if (!s.replies.every((r) => re.test(r))) return `not ${re}`;
  const last = s.replies.at(-1)!;
  for (const re of c.lastSays ?? []) if (!re.test(last)) return `last reply not ${re}`;
  for (const tool of c.calls ?? []) if (!s.calls.includes(tool)) return `never called ${tool}`;
  for (const [tool, most] of Object.entries(c.callsAtMost ?? {}))
    if (s.calls.filter((t) => t === tool).length > most) return `called ${tool} more than ${most}`;
  if (c.lampAfter !== undefined && c.lampAfter.some((state, i) => s.lamp[i] !== state))
    return `lamp went ${s.lamp.join(", ")}`;
  if (c.namesAtLeast !== undefined) {
    const named = SPECIALISTS.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(last));
    if (named.length < c.namesAtLeast) return `named ${named.length} of the others`;
  }
  return null;
};

/** A case fails when half or more of its samples fail (evals/README.md). */
export const casePasses = (c: RoomCase, samples: ReadonlyArray<RoomSample>): boolean =>
  samples.filter((s) => failureOf(c, s) === null).length * 2 > samples.length;
