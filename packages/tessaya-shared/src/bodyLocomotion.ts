/**
 * Where her body turns, walks and aims (architecture step 8, M-087): targets in her vessel's world and the decode a
 * move's `toward`, `turn` and `walk` go through. The renderer owns how she moves there (real steps through the rig);
 * this is only what was asked, bounded.
 */

/** Where a move points: him, another body on this vessel, a spot in her world (0..1 across, y down), or her back. */
export type BodyTarget =
  | { readonly kind: "him" }
  | { readonly kind: "persona"; readonly id: string }
  | { readonly kind: "point"; readonly x: number; readonly y: number }
  | { readonly kind: "away" };

export const WALK_STYLES = ["stroll", "sneak", "bounce", "stomp", "tiptoe"] as const;
export type WalkStyle = (typeof WALK_STYLES)[number];

/** Her whole body turning to a target: hips first, head leading; natural speed without `ms`. */
export interface Turn {
  readonly to: BodyTarget;
  readonly ms?: number;
}
/** Walking to a target: 0 a stroll to 1 a hurry; `stop` short of it by this much of her height. */
export interface Walk {
  readonly to: BodyTarget;
  readonly speed: number;
  readonly style: WalkStyle;
  readonly stop: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const unit = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;

/** A target from what was asked: "him", "away", a persona's id, or {x, y}; null when it names nothing. */
export const decodeTarget = (raw: unknown): BodyTarget | null => {
  if (raw === "him" || raw === "away") return { kind: raw };
  if (typeof raw === "string")
    return /^[a-z0-9][a-z0-9-]{0,39}$/.test(raw) ? { kind: "persona", id: raw } : null;
  if (!isObj(raw)) return null;
  // the decoded shape again (a cue the renderer parses): him, away, a persona, a point
  if (raw["kind"] === "him" || raw["kind"] === "away") return { kind: raw["kind"] };
  if (raw["kind"] === "persona") return decodeTarget(raw["id"]);
  const x = unit(raw["x"]);
  const y = unit(raw["y"]);
  return x === null || y === null ? null : { kind: "point", x, y };
};

export const TARGET_HELP =
  'a target is "him", "away", a persona\'s id, or {x, y} from 0 to 1 across her world';

export const decodeTurn = (raw: unknown): Turn | string => {
  const to = decodeTarget(isObj(raw) && "to" in raw ? raw["to"] : raw);
  if (to === null) return `turn needs a target: ${TARGET_HELP}`;
  const ms =
    isObj(raw) && typeof raw["ms"] === "number"
      ? Math.max(200, Math.min(4000, raw["ms"]))
      : undefined;
  return ms === undefined ? { to } : { to, ms };
};

export const decodeWalk = (raw: unknown): Walk | string => {
  if (!isObj(raw)) return `walk is {to, speed, style}: ${TARGET_HELP}`;
  const to = decodeTarget(raw["to"]);
  if (to === null || to.kind === "away")
    return `walk needs somewhere to go: ${TARGET_HELP} (not "away")`;
  const style = raw["style"] ?? "stroll";
  if (!(WALK_STYLES as ReadonlyArray<unknown>).includes(style))
    return `walk style is one of ${WALK_STYLES.join(", ")}`;
  return {
    to,
    speed: unit(raw["speed"]) ?? 0.3,
    style: style as WalkStyle,
    stop: unit(raw["stop"]) ?? 0.2,
  };
};
