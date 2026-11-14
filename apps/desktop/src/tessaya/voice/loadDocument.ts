/**
 * Loads an inline page into a small window. A load aborted because the window was closed or
 * replaced meanwhile (a drag's marker window lives a few milliseconds) rejects with ERR_FAILED;
 * that must never surface as an unhandled rejection. Resolves false when it did not load.
 */
export const loadDocument = (
  win: { readonly loadURL: (url: string) => Promise<void>; readonly isDestroyed: () => boolean },
  html: string,
  onFail?: (cause: unknown, closed: boolean) => void,
): Promise<boolean> =>
  win.loadURL(`data:text/html,${encodeURIComponent(html)}`).then(
    () => true,
    (cause: unknown) => {
      onFail?.(cause, win.isDestroyed());
      return false;
    },
  );
