import { inQuietHours } from "@t3tools/tessaya-shared/attention";

/** This phone as the `sleeve` preference names it: its registry id, its own name and its model. */
export interface PhoneNames {
  readonly id: string;
  readonly names: ReadonlyArray<string>;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[’']/g, "'");
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

/**
 * Whether the Sleeve covers this phone: her Sleeve by his preference, unless he gave it back here while the preference
 * still read `given` (his brain not reached yet, or refusing). A new preference value, his own or cleared, ends that.
 */
export const sleeveCovers = (
  value: string | undefined,
  phone: PhoneNames,
  given: string | null,
): boolean => isSleeve(value, phone) && (given === null || (value ?? "") !== given);

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

/** Alone this long on its charger, her Sleeve rests (REQ-25-157). */
export const ALONE_MS = 2 * 60_000;

/**
 * How her Sleeve rests alone on its charger: dimmed to her dock, or dark for the night (its screen let go to sleep),
 * by his quiet hours ("22-8"). A touch, a raise or a turn with her brings her back.
 */
export const restOf = (quietHours: string, hour: number): "dock" | "night" =>
  inQuietHours(quietHours, hour) ? "night" : "dock";
