/**
 * Writing a body tag (VESSEL-BODIES §1): the raw NTAG21x commands that put the server's signed link on the tag and lock
 * it against rewriting with its password. Pure, so the phone only sends the bytes; the reader adds the CRC.
 */

/** GET_VERSION byte 6 → the first configuration page (CFG0) of NTAG213, 215 and 216. */
const CFG0_BY_SIZE: Readonly<Record<number, number>> = { 0x0f: 0x29, 0x11: 0x83, 0x13: 0xe3 };
const FIRST_USER_PAGE = 4;

export const GET_VERSION = [0x60];
export const read = (page: number) => [0x30, page];
const write = (page: number, bytes: ReadonlyArray<number>) => [0xa2, page, ...bytes.slice(0, 4)];
const hexBytes = (hex: string) => (hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));

/** CFG0's page for this tag, or null for a chip that isn't an NTAG213/215/216. */
export const configPageOf = (version: ReadonlyArray<number>): number | null =>
  version.length >= 8 && version[1] === 0x04 && version[2] === 0x04
    ? (CFG0_BY_SIZE[version[6]!] ?? null)
    : null;

/** One NDEF message with one URI record, in a TLV, as 4-byte pages from page 4. */
export const ndefPages = (url: string): Array<Array<number>> => {
  const https = url.startsWith("https://");
  const rest = [...new TextEncoder().encode(https ? url.slice(8) : url)];
  // Payload: the URI prefix code (0x04 = https://, 0x00 = none), then the rest of the URI.
  const payload = [https ? 0x04 : 0x00, ...rest];
  if (payload.length > 250) throw new Error("The link is too long for one tag.");
  const record = [0xd1, 0x01, payload.length, 0x55, ...payload];
  const bytes = [0x03, record.length, ...record, 0xfe];
  while (bytes.length % 4 !== 0) bytes.push(0x00);
  const pages: Array<Array<number>> = [];
  for (let i = 0; i < bytes.length; i += 4) pages.push(bytes.slice(i, i + 4));
  return pages;
};

/**
 * In order: authenticate if already locked (a re-tag), write the link, set PWD and PACK, and set AUTH0 last, so a
 * write failing halfway never leaves a tag locked with nothing on it. ACCESS stays as found (PROT 0): anyone reads,
 * only the password writes.
 */
export const bodyTagCommands = (input: {
  readonly url: string;
  readonly password: string;
  readonly pack: string;
  readonly configPage: number;
  /** CFG0 as read from the tag (its first 4 bytes). */
  readonly cfg0: ReadonlyArray<number>;
}): Array<Array<number>> => {
  const pages = ndefPages(input.url);
  const userPages = input.configPage - 1 - FIRST_USER_PAGE;
  if (pages.length > userPages) throw new Error("The link does not fit on this tag.");
  const pwd = hexBytes(input.password);
  const pack = hexBytes(input.pack);
  if (pwd.length !== 4 || pack.length !== 2) throw new Error("The tag password is not right.");
  const locked = (input.cfg0[3] ?? 0xff) < input.configPage + 4;
  return [
    ...(locked ? [[0x1b, ...pwd]] : []),
    ...pages.map((p, i) => write(FIRST_USER_PAGE + i, p)),
    write(input.configPage + 2, pwd),
    write(input.configPage + 3, [...pack, 0x00, 0x00]),
    write(input.configPage, [...input.cfg0.slice(0, 3), FIRST_USER_PAGE]),
  ];
};
