/**
 * One-shot screen captures through Electron's own `desktopCapturer`: every display, the cursor's
 * first, each scaled so its long edge is at most 1280 px (farzaa/clicky's size), as JPEG.
 * Nothing is captured unless the companion asks, and the companion asks only after his approval.
 */
import { captureSize, pickSource, type ScreenShot } from "@t3tools/tessaya-shared/screenCompanion";

type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** A picture of part of the desktop at `bounds` (desktop points), as one shot the model can click in. */
export const shotOf = (picture: Electron.NativeImage, bounds: Rect): CapturedScreen => {
  const size = captureSize(picture.getSize().width, picture.getSize().height);
  const image = size.width < picture.getSize().width ? picture.resize(size) : picture;
  return {
    shot: { screen: 1, ...image.getSize(), cursorHere: true, bounds },
    jpeg: image.toJPEG(80),
  };
};

/** A window's own BMP (top-down BGRA after the 54-byte header). PrintWindow leaves alpha at 0, which would read as clear. */
export const bmpImage = (bmp: Buffer, width: number, height: number): Electron.NativeImage => {
  const pixels = Buffer.from(bmp.subarray(54, 54 + width * height * 4));
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return Electron.nativeImage.createFromBitmap(pixels, { width, height });
};

/** One area of the desktop at the display's full resolution: a closer look at small controls. */
export const captureArea = async (rect: Rect): Promise<CapturedScreen> => {
  const all = Electron.screen.getAllDisplays();
  const display = Electron.screen.getDisplayMatching(rect);
  const scale = display.scaleFactor;
  const sources = await Electron.desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const source = pickSource(sources, display.id, all.indexOf(display));
  if (source === undefined || source.thumbnail.isEmpty())
    throw new Error("That screen could not be captured.");
  const k = source.thumbnail.getSize().width / display.bounds.width;
  const x = Math.max(rect.x, display.bounds.x);
  const y = Math.max(rect.y, display.bounds.y);
  const right = Math.min(rect.x + rect.width, display.bounds.x + display.bounds.width);
  const bottom = Math.min(rect.y + rect.height, display.bounds.y + display.bounds.height);
  if (right <= x || bottom <= y) throw new Error("That area is not on a screen.");
  const crop = source.thumbnail.crop({
    x: Math.round((x - display.bounds.x) * k),
    y: Math.round((y - display.bounds.y) * k),
    width: Math.max(1, Math.round((right - x) * k)),
    height: Math.max(1, Math.round((bottom - y) * k)),
  });
  return shotOf(crop, { x, y, width: right - x, height: bottom - y });
};
import * as Electron from "electron";

export interface CapturedScreen {
  readonly shot: ScreenShot;
  readonly jpeg: Buffer;
}

/** The display he means: the one with the window he is using, else the cursor's. */
const orderedDisplays = (
  anchor?: { readonly x: number; readonly y: number } | null,
): ReadonlyArray<{ display: Electron.Display; cursorHere: boolean }> => {
  const point = anchor ?? Electron.screen.getCursorScreenPoint();
  const here = Electron.screen.getDisplayNearestPoint(point).id;
  return Electron.screen
    .getAllDisplays()
    .map((display) => ({ display, cursorHere: display.id === here }))
    .sort((a, b) => Number(b.cursorHere) - Number(a.cursorHere));
};

export const captureScreens = async (
  anchor?: { readonly x: number; readonly y: number } | null,
): Promise<ReadonlyArray<CapturedScreen>> => {
  const ordered = orderedDisplays(anchor);
  const all = Electron.screen.getAllDisplays();
  const largest = Math.max(
    ...all.map((d) => Math.max(d.size.width, d.size.height) * d.scaleFactor),
  );
  const box = captureSize(largest, largest).width;
  const sources = await Electron.desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: box, height: box },
  });
  const out: CapturedScreen[] = [];
  ordered.forEach(({ display, cursorHere }, i) => {
    const source = pickSource(sources, display.id, all.indexOf(display));
    if (source === undefined || source.thumbnail.isEmpty()) return;
    const physical = captureSize(
      display.size.width * display.scaleFactor,
      display.size.height * display.scaleFactor,
    );
    const image =
      source.thumbnail.getSize().width > physical.width
        ? source.thumbnail.resize(physical)
        : source.thumbnail;
    const size = image.getSize();
    out.push({
      shot: {
        screen: i + 1,
        width: size.width,
        height: size.height,
        cursorHere,
        bounds: display.bounds,
      },
      jpeg: image.toJPEG(80),
    });
  });
  if (out.length === 0) {
    throw new Error(
      "Tessaya could not capture the screen. On macOS allow Screen Recording; on Linux Wayland, X11 is needed.",
    );
  }
  return out;
};

/** A tiny grayscale picture of the cursor's display, for noticing that the screen changed. */
export const screenFingerprint = async (): Promise<ReadonlyArray<Uint8Array>> => {
  const sources = await Electron.desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 320, height: 320 },
  });
  // Every display, in a fixed order: the cursor moving must not read as the screen changing, and
  // his step may land on the display the cursor is not on.
  return Electron.screen.getAllDisplays().flatMap((display, index) => {
    const source = pickSource(sources, display.id, index);
    if (source === undefined) return [];
    const bitmap = source.thumbnail.toBitmap(); // BGRA
    const gray = new Uint8Array(bitmap.length / 4);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = (bitmap[i * 4]! + bitmap[i * 4 + 1]! * 2 + bitmap[i * 4 + 2]!) >> 2;
    }
    return [gray];
  });
};
