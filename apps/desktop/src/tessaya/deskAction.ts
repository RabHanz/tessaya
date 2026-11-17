/**
 * What the desktop does on its own goes into his server's action log (B-046), as the server's own acts do: names and
 * outcomes only, never what was typed, clicked or set.
 */
type Direct = ((method: string, body: unknown) => Promise<unknown>) | undefined;

export const deskAction = (
  direct: Direct,
  action: {
    readonly kind: "desk.tool" | "settings.changed";
    readonly subject: string;
    readonly outcome?: "ok" | "fail";
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
