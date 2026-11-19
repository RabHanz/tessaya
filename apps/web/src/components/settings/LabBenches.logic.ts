import type { PersonaVoiceRow } from "@t3tools/tessaya-contracts";

/** One persona's clone voice before and after "Use it for": the after is applied, the before is the Undo. */
export interface CloneUse {
  readonly persona: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** What "Use it for" changes: the ticked personas get the clone; the ones already on it are left alone. */
export const cloneUses = (
  personas: ReadonlyArray<Pick<PersonaVoiceRow, "id" | "cloneVoice">>,
  clone: string,
  picked: ReadonlySet<string>,
): ReadonlyArray<CloneUse> =>
  personas
    .filter((p) => picked.has(p.id) && (p.cloneVoice ?? null) !== clone)
    .map((p) => ({ persona: p.id, before: p.cloneVoice ?? null, after: clone }));

/** The same changes the other way round. */
export const undoUses = (uses: ReadonlyArray<CloneUse>): ReadonlyArray<CloneUse> =>
  uses.map((u) => ({ persona: u.persona, before: u.after, after: u.before }));
