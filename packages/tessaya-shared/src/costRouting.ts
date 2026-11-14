/**
 * Routine work (rewrites, sorting, extraction) runs on the cheap model (D148). Each persona's own model
 * is in its pack file; this table (`routing.json` in his operating-system folder) names the cheap one.
 */
export interface Routing {
  readonly cheap: string;
}

/** An alias the Claude command line accepts, so it follows the newest model of that size. */
export const DEFAULT_ROUTING: Routing = { cheap: "haiku" };

/** Routine work thinks little. */
export const ROUTINE_EFFORT = "low";

/** A user's table over the default; anything that is not a short model name is ignored. */
export const parseRouting = (text: string | undefined): Routing => {
  if (text === undefined) return DEFAULT_ROUTING;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_ROUTING;
  }
  const cheap =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)["cheap"]
      : undefined;
  return {
    cheap:
      typeof cheap === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,60}$/.test(cheap)
        ? cheap
        : DEFAULT_ROUTING.cheap,
  };
};
