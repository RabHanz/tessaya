/**
 * Her overlay windows (her body, her private body, the pill, the pointer) stand on whichever virtual desktop he is on.
 * Electron's setVisibleOnAllWorkspaces covers macOS and Linux only. On Windows the shell keeps a tool window
 * (WS_EX_TOOLWINDOW) on every virtual desktop; that also keeps it off the taskbar and Alt-Tab, as her windows already are.
 */
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80n;

export interface ExStyleApi {
  readonly get: (hwnd: bigint) => bigint;
  readonly set: (hwnd: bigint, style: bigint) => void;
}

interface Pinnable {
  readonly getNativeWindowHandle: () => Buffer;
  readonly isDestroyed: () => boolean;
  readonly isVisible: () => boolean;
  readonly hide: () => void;
  readonly showInactive: () => void;
  readonly setVisibleOnAllWorkspaces: (
    visible: boolean,
    options?: { readonly visibleOnFullScreen?: boolean },
  ) => void;
}

let api: Promise<ExStyleApi> | undefined;
const exStyleApi = (): Promise<ExStyleApi> =>
  (api ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const user32 = "tessaya-user32";
    open({ library: user32, path: "user32.dll" });
    return {
      get: (hwnd) =>
        BigInt(
          load({
            library: user32,
            funcName: "GetWindowLongPtrW",
            retType: DataType.BigInt,
            paramsType: [DataType.BigInt, DataType.I32],
            paramsValue: [hwnd, GWL_EXSTYLE],
          }) as bigint,
        ),
      set: (hwnd, style) =>
        void load({
          library: user32,
          funcName: "SetWindowLongPtrW",
          retType: DataType.BigInt,
          paramsType: [DataType.BigInt, DataType.I32, DataType.BigInt],
          paramsValue: [hwnd, GWL_EXSTYLE, style],
        }),
    };
  }));

const handleOf = (buffer: Buffer): bigint =>
  buffer.length === 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());

/**
 * Resolves once the window is on every desktop; never throws. macOS and Linux take the workspaces setting (a no-op on
 * Windows); only Windows has user32, so elsewhere the style step finds no library and changes nothing.
 */
export const onEveryDesktop = async (
  win: Pinnable,
  load: () => Promise<ExStyleApi> = exStyleApi,
): Promise<void> => {
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const styles = await load().catch(() => null);
  if (styles === null || win.isDestroyed()) return;
  const hwnd = handleOf(win.getNativeWindowHandle());
  const style = styles.get(hwnd);
  if ((style & WS_EX_TOOLWINDOW) !== 0n) return;
  // the shell reads the style when a window shows: one already up is shown again under it
  const shown = win.isVisible();
  if (shown) win.hide();
  styles.set(hwnd, style | WS_EX_TOOLWINDOW);
  if (shown) win.showInactive();
};
