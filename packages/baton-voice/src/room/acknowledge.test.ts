import { describe, expect, it } from "vite-plus/test";

import { ackLines, pickAck, type AckContext } from "./acknowledge.ts";

/** A repeatable random: the same sequence each run. */
const seeded = (seed: number) => () => {
  seed = (seed * 16_807) % 2_147_483_647;
  return seed / 2_147_483_647;
};
const at = (over: Partial<AckContext> = {}): AckContext => ({
  personaId: "executive",
  hour: 15,
  sinceExchangeMs: Number.POSITIVE_INFINITY,
  sinceAckMs: Number.POSITIVE_INFINITY,
  name: null,
  last: null,
  ...over,
});

describe("her 'I'm here' when he only says her name", () => {
  it("never says the same line twice running", () => {
    const random = seeded(7);
    let last: string | null = null;
    for (let i = 0; i < 300; i += 1) {
      const line = pickAck(at({ last }), random);
      if (line !== null) {
        expect(line).not.toBe(last);
        last = line;
      }
    }
  });

  it("fits the moment: the morning, a conversation still going, his name once, Alfred's own lines", () => {
    const lines = (c: AckContext) => {
      const random = seeded(11);
      return new Set(Array.from({ length: 400 }, () => pickAck(c, random)));
    };
    expect(lines(at({ hour: 8 }))).toContain("Morning.");
    expect(lines(at({ hour: 15 }))).not.toContain("Morning.");
    expect(lines(at({ sinceExchangeMs: 60_000 }))).toContain("Still here.");
    expect(lines(at({ name: "Rab" }))).toContain("What's up, Rab?");
    expect(lines(at())).not.toContain("What's up, Rab?");
    expect(lines(at({ personaId: "engineering" }))).toContain("At your service.");
    expect(ackLines("engineering")).toContain("Sir?");
  });

  it("often says nothing, only her look, when woken again within minutes", () => {
    const random = seeded(3);
    const again = Array.from({ length: 400 }, () => pickAck(at({ sinceAckMs: 60_000 }), random));
    const first = Array.from({ length: 400 }, () => pickAck(at(), random));
    const silent = (xs: ReadonlyArray<string | null>) =>
      xs.filter((x) => x === null).length / xs.length;
    expect(silent(again)).toBeGreaterThan(0.5);
    expect(silent(first)).toBeLessThan(0.25);
  });
});
