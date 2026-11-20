/**
 * What the desktop does on its own goes into his server's action log (B-046), as the server's own acts do: names and
 * outcomes only, never what was typed, clicked or set.
 */
type Direct = ((method: string, body: unknown) => Promise<unknown>) | undefined;

export const deskAction = (
  direct: Direct,
  action: {
    readonly kind: "desk.tool" | "desk.look" | "settings.changed";
    readonly subject: string;
    readonly outcome?: "ok" | "fail";
    /** How long the step took, so where a turn's seconds go can be read back (D-004). */
    readonly ms?: number;
  },
): void => void direct?.("action", action).catch(() => undefined);

/** One `settings.changed` per key whose value a save really changed. */
export const settingsSaved = <S extends object>(
  direct: Direct,
  area: string,
  before: S,
  next: Partial<S>,
): void => {
  for (const key of Object.keys(next) as Array<keyof S>)
    if (JSON.stringify(before[key]) !== JSON.stringify(next[key]))
      deskAction(direct, { kind: "settings.changed", subject: `${area}.${String(key)}` });
};
