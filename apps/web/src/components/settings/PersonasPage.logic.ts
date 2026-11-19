import type { CastBody } from "@t3tools/tessaya-contracts";

/** Where a persona is now and where it lives, from Cast's bodies, in one line for its card. */
export const placeLine = (
  persona: string,
  bodies: ReadonlyArray<Pick<CastBody, "name" | "on" | "home" | "wearing">>,
): string => {
  const on = bodies.filter((b) => b.on.includes(persona)).map((b) => b.name);
  const home = bodies.filter((b) => b.home === persona).map((b) => b.name);
  const parts = [
    on.length === 0 ? "Not on any body now" : `On ${on.join(", ")} now`,
    home.length === 0 ? null : `lives on ${home.join(", ")}`,
  ].filter((x) => x !== null);
  return `${parts.join("; ")}. Bring them to another body, or say “bring them here”.`;
};
