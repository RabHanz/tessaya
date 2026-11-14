import { tessayaPlaceOf, type TessayaPlaceId } from "@t3tools/tessaya-contracts";

export const TESSAYA_SCHEME = "tessaya";

export const isTessayaLink = (value: string): boolean => /^tessaya:\/\//i.test(value);

/** The place a launch asks for, from `tessaya://settings/hardware` among its arguments; null for none or an unknown one. */
export const placeInArgs = (argv: ReadonlyArray<string>): TessayaPlaceId | null => {
  const link = argv.find(isTessayaLink);
  return link === undefined ? null : tessayaPlaceOf(link);
};

const EMBED_PREFIX = "?tessayaGuest=1#/tessaya/";

/** One of the T3 pages Tessaya's window shows inline: T3's guest page at its address, hash-routed to `/tessaya/<page>`. */
export const isEmbedSrc = (appUrl: string, src: string): boolean =>
  src.startsWith(`${appUrl}${EMBED_PREFIX}`) &&
  /^[a-z]+$/.test(src.slice(`${appUrl}${EMBED_PREFIX}`.length));

/** The T3 path a guest page's link leads to, for T3's own window; null for one of the guest's own pages. */
export const guestLinkOut = (appUrl: string, url: string): string | null => {
  const guest = `${appUrl}${EMBED_PREFIX.slice(0, EMBED_PREFIX.indexOf("#") + 1)}`;
  if (!url.startsWith(guest) || isEmbedSrc(appUrl, url)) return null;
  return url.slice(guest.length).split("?")[0] ?? "";
};
