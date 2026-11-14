/**
 * Each limit window is optional per account (D126). An account can report a weekly window and no
 * session one, so what is shown follows the windows actually reported, never a plan's name, and a
 * plan that gets its session window back shows it again with no change here.
 */
export const absentSessionWindow = (
  windows: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
): boolean =>
  windows.some((window) => window.kind === "weekly") &&
  !windows.some((window) => window.kind === "session");

export const NOT_APPLICABLE = "Not applicable";
