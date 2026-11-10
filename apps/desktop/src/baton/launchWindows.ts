/**
 * Which windows open when the app starts, from Settings → General → Start. A login start reads the same two
 * switches. The first run always opens both: setup happens in them. Pure, so the decision is tested alone.
 */
export const launchWindows = (input: {
  readonly openTessaya: boolean;
  readonly openSessions: boolean;
  readonly firstRun: boolean;
}) => ({
  tessaya: input.firstRun || input.openTessaya,
  sessions: input.firstRun || input.openSessions,
});

/** Set while the sessions window is switched off for this start; any request to show it releases the hold. */
let mainHeld = false;
export const holdMainAtLaunch = (hold: boolean): void => {
  mainHeld = hold;
};
export const mainHeldAtLaunch = (): boolean => mainHeld;
/** The hold, released: the first backend-ready reads it once, and an activation clears it. */
export const takeMainHold = (): boolean => {
  const held = mainHeld;
  mainHeld = false;
  return held;
};
