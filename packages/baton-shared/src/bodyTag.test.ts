import { describe, expect, it } from "vitest";

import { bodyTagCommands, configPageOf, ndefPages } from "./bodyTag.ts";

const NTAG213 = [0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x0f, 0x03];
const URL = "https://tags.example.com/b/1/dock/abcd2345.AAAAAAAAAAAAAAAA";

describe("bodyTag", () => {
  it("finds the configuration pages of NTAG213/215/216 and nothing else", () => {
    expect(configPageOf(NTAG213)).toBe(0x29);
    expect(configPageOf([0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x11, 0x03])).toBe(0x83);
    expect(configPageOf([0x00, 0x04, 0x03, 0x01, 0x01, 0x00, 0x0b, 0x03])).toBeNull();
  });

  it("writes one URI record with the https:// prefix code, terminated, from page 4", () => {
    const bytes = ndefPages(URL).flat();
    const rest = URL.length - "https://".length;
    expect(bytes.slice(0, 7)).toEqual([0x03, rest + 5, 0xd1, 0x01, rest + 1, 0x55, 0x04]);
    expect(String.fromCharCode(...bytes.slice(7, 7 + rest))).toBe(URL.slice(8));
    expect(bytes[7 + rest]).toBe(0xfe);
  });

  it("locks the tag last, and authenticates first when it is already locked", () => {
    const base = { url: URL, password: "a1b2c3d4", pack: "e5f6", configPage: 0x29 };
    const fresh = bodyTagCommands({ ...base, cfg0: [0x04, 0x00, 0x00, 0xff] });
    expect(fresh[0]![0]).toBe(0xa2);
    expect(fresh.at(-3)).toEqual([0xa2, 0x2b, 0xa1, 0xb2, 0xc3, 0xd4]);
    expect(fresh.at(-2)).toEqual([0xa2, 0x2c, 0xe5, 0xf6, 0x00, 0x00]);
    expect(fresh.at(-1)).toEqual([0xa2, 0x29, 0x04, 0x00, 0x00, 0x04]);
    const locked = bodyTagCommands({ ...base, cfg0: [0x04, 0x00, 0x00, 0x04] });
    expect(locked[0]).toEqual([0x1b, 0xa1, 0xb2, 0xc3, 0xd4]);
  });

  it("refuses a link longer than the tag holds", () => {
    expect(() =>
      bodyTagCommands({
        url: `https://${"x".repeat(200)}.example.com/b/1/dock/abcd2345.AAAAAAAAAAAAAAAA`,
        password: "a1b2c3d4",
        pack: "e5f6",
        configPage: 0x29,
        cfg0: [0, 0, 0, 0xff],
      }),
    ).toThrow("does not fit");
  });
});
