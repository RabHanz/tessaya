/**
 * The last mile of opening the main window (D119): a reveal reports success for a window that is
 * off every display or whose page has died, and he sees nothing. Pure parts first, for testing.
 */
import type * as Electron from "electron";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Enough of the window to see and grab. */
const VISIBLE_DIP = 80;

const overlap = (a: Box, b: Box): { readonly width: number; readonly height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
});

/** Where to put a window no display shows; null when he can already see it. */
export const rescuedPosition = (
  bounds: Box,
  displays: ReadonlyArray<Box>,
  home: Box,
): { readonly x: number; readonly y: number } | null => {
  const seen = displays.some((display) => {
    const shared = overlap(bounds, display);
    return shared.width >= VISIBLE_DIP && shared.height >= VISIBLE_DIP;
  });
  if (seen) return null;
  return {
    x: Math.round(home.x + Math.max(0, home.width - bounds.width) / 2),
    y: Math.round(home.y + Math.max(0, home.height - bounds.height) / 2),
  };
};

export const rescueMainWindow = (window: Electron.BrowserWindow, screen: Electron.Screen): void => {
  if (window.isDestroyed()) return;
  // Upstream's recovery gives up after a few crashes. He just asked for the window, so try again.
  if (window.webContents.isCrashed()) window.webContents.reload();
  const place = rescuedPosition(
    window.getBounds(),
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  if (place !== null) window.setPosition(place.x, place.y);
};
