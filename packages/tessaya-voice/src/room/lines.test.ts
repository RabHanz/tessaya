import { LINE_POOL, lineId } from "@t3tools/tessaya-shared/expression";
import { describe, expect, it } from "vite-plus/test";

import { createLines, type LinesAsk, type LinesGot } from "./lines.ts";

const setup = (answer: (ask: LinesAsk) => LinesGot | Error) => {
  const asks: Array<LinesAsk> = [];
  const lines = createLines({
    fetch: async (ask) => {
      asks.push(ask);
      const got = answer(ask);
      if (got instanceof Error) throw got;
      return got;
    },
    random: () => 0,
    hour: () => 9,
    log: () => undefined,
  });
  return { lines, asks };
};

const l = (text: string) => ({ text, mood: "happy" as const, gesture: "nodSmall" as const });

describe("the room loop's own words", () => {
  it("says the plain line while her own words are off, except a persona's own greeting once", async () => {
    let greeting = [l("Ahoy, you again!")];
    const off = setup(() => {
      const got = { on: false, lines: { "ack.name": greeting } };
      greeting = [];
      return got;
    });
    expect(off.lines.take("ack.name", "executive", "owner", "Yes?").text).toBe("Yes?");
    await off.lines.prime("executive", "owner");
    // Woken with a full request, the greeting goes unsaid: the next wake's prime must not drop it.
    await off.lines.prime("executive", "owner");
    expect(off.lines.take("ack.name", "executive", "owner", "Yes?").text).toBe("Ahoy, you again!");
    expect(off.lines.take("ack.name", "executive", "owner", "Yes?")).toEqual({
      text: "Yes?",
      mood: null,
    });
    // With her words on, later wakes' fresh lines queue behind it rather than push it out.
    let first = true;
    const on = setup(() => {
      const ack = first ? [l("Ahoy!"), l("Yes?")] : [l("Hm?"), l("Here."), l("Go on.")];
      first = false;
      return { on: true, lines: { "ack.name": ack } };
    });
    for (let i = 0; i < 3; i++) await on.lines.prime("executive", "owner");
    expect(on.lines.take("ack.name", "executive", "owner", "Yes?").text).toBe("Ahoy!");
  });

  it("takes the server's wordings in order, facts exact, and asks for more when few are left", async () => {
    const t = setup(() => ({
      on: true,
      lines: { "id.phrase": [l('Say "{phrase}", please.'), l("Repeat: {phrase}.")] },
    }));
    await t.lines.prime("executive", "owner");
    expect(
      t.lines.take("id.phrase", "executive", "owner", "plain", { phrase: "amber river" }),
    ).toEqual({
      text: 'Say "amber river", please.',
      mood: "happy",
    });
    expect(t.asks.map((a) => a.events)).toEqual([
      expect.arrayContaining(["ack.name"]),
      ["id.phrase"],
    ]);
    // A wording whose fact is missing gives way to the plain line, never a hole.
    expect(t.lines.take("id.phrase", "executive", "owner", "plain").text).toBe("plain");
  });

  it("offline after being on, rotates the shipped pool without repeating", async () => {
    let online = true;
    const t = setup(() => (online ? { on: true, lines: {} } : new Error("offline")));
    await t.lines.prime("executive", "owner");
    online = false;
    const said = Array.from(
      { length: 5 },
      () => t.lines.take("ack.name", "executive", "owner", "Yes?").text,
    );
    const pool = (LINE_POOL["executive"]?.["ack.name"] ?? []).map((x) =>
      lineId("ack.name", x.text),
    );
    expect(new Set(said).size).toBe(5);
    for (const s of said) expect(pool).toContain(lineId("ack.name", s));
  });
});
