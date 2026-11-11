import * as NodeOS from "node:os";

/**
 * Task Scheduler starts its tasks at BelowNormal, and Windows hands a BelowNormal or Idle class to
 * every child, so a Tessaya an install or relaunch task started ran its server below the work it
 * competes with. Lifting the app before the server starts gives the server Normal too.
 */
export const liftInheritedPriority = (
  os: Pick<typeof NodeOS, "getPriority" | "setPriority"> = NodeOS,
): number | null => {
  const normal = NodeOS.constants.priority.PRIORITY_NORMAL;
  try {
    const inherited = os.getPriority();
    // A higher number is a lower priority; an above-normal start is his choice and stays.
    if (inherited <= normal) return null;
    os.setPriority(normal);
    return inherited;
  } catch {
    return null;
  }
};
