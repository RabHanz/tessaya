/** When the resting bar stays out of the way: hidden for a while by choice, or a full-screen app or game has the screen. Pure. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Windows that always fill a display without being a game or a video. */
const NOT_FULLSCREEN =
  /^(explorer|shellexperiencehost|searchhost|searchapp|startmenuexperiencehost|lockapp|textinputhost|applicationframehost|dwm)(\.exe)?$/i;

/** The window covers a whole display (within a few pixels) and is not the desktop itself. */
export const isFullscreenWindow = (
  app: { readonly exe: string; readonly rect: Rect | null },
  displays: ReadonlyArray<Rect>,
  slack = 4,
): boolean => {
  if (app.rect === null || app.exe === "" || NOT_FULLSCREEN.test(app.exe)) return false;
  const r = app.rect;
  return displays.some(
    (d) =>
      Math.abs(r.x - d.x) <= slack &&
      Math.abs(r.y - d.y) <= slack &&
      r.width >= d.width - slack &&
      r.height >= d.height - slack,
  );
};

export const restBarWanted = (input: {
  readonly atRest: boolean;
  readonly hiddenUntil: number;
  readonly hideInFullscreen: boolean;
  readonly fullscreen: boolean;
  readonly now: number;
}): boolean =>
  input.atRest && input.now >= input.hiddenUntil && !(input.hideInFullscreen && input.fullscreen);

export const HIDE_FOR_MS = 60 * 60_000;
