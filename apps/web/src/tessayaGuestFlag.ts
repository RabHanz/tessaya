/** Tessaya's window loads T3's address with this flag for the pages it shows (apps/desktop baton/home/links.ts). */
export const isTessayaGuest = (search: string): boolean =>
  new URLSearchParams(search).get("tessayaGuest") === "1";
