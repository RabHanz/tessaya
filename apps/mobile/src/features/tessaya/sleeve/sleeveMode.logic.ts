/** This phone as the `sleeve` preference names it: its registry id, its own name and its model. */
export interface PhoneNames {
  readonly id: string;
  readonly names: ReadonlyArray<string>;
}

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'");
const entries = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "" && !/^(off|none|no)$/i.test(e));

/** Whether the member's `sleeve` preference makes this phone her Sleeve. */
export const isSleeve = (value: string | undefined, phone: PhoneNames): boolean => {
  const mine = new Set([phone.id, ...phone.names].filter((n) => n !== "").map(norm));
  return entries(value).some((e) => mine.has(norm(e)));
};

/** The preference with this phone added or taken out, or null (cleared) when no phone is left. */
export const withSleeve = (
  value: string | undefined,
  phone: PhoneNames,
  on: boolean,
): string | null => {
  const others = entries(value).filter((e) => !isSleeve(e, phone));
  const next = on ? [...others, phone.names[0] ?? phone.id] : others;
  return next.length === 0 ? null : next.join(", ").slice(0, 120);
};
