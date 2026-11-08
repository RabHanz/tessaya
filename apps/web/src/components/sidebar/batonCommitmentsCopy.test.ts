import type { BatonCommitment } from "@t3tools/baton-contracts";
import { describe, expect, it } from "vite-plus/test";

import { copyCommitmentsOnce } from "./batonCommitmentsCopy";

const commitment = (id: string, status: BatonCommitment["status"] = "open"): BatonCommitment => ({
  id,
  text: `check ${id}`,
  owner: "tessaya",
  due: null,
  status,
  source: "voice",
  createdAt: 1,
  updatedAt: status === "open" ? 1 : 2,
  ...(status === "open" ? {} : { closedAt: 2 }),
});

/** Two servers' ledgers, upserted by id with the newer edit kept, and a done-marker store. */
const servers = (ledgers: Record<string, ReadonlyArray<BatonCommitment>>, failList?: string) => {
  const held = new Map(Object.entries(ledgers).map(([id, items]) => [id, [...items]]));
  const upserts: Array<[string, number]> = [];
  const marks = new Set<string>();
  const run = (linked: string | undefined, own: string) =>
    copyCommitmentsOnce({
      linked,
      own,
      list: async (id) => {
        if (id === failList) throw new Error("no answer");
        return held.get(id) ?? [];
      },
      upsert: async (id, items) => {
        upserts.push([id, items.length]);
        const ledger = held.get(id) ?? [];
        for (const c of items) {
          const at = ledger.findIndex((x) => x.id === c.id);
          if (at === -1) ledger.push(c);
          else if (ledger[at]!.status === "open") ledger[at] = c;
        }
        held.set(id, ledger);
      },
      done: (key) => marks.has(key),
      markDone: (key) => marks.add(key),
    });
  return { held, upserts, marks, run };
};

describe("copyCommitmentsOnce", () => {
  it("copies what the linked server holds to the own server, once", async () => {
    const s = servers({
      linked: [commitment("a"), commitment("b", "done")],
      own: [commitment("b"), commitment("c")],
    });
    expect(await s.run("linked", "own")).toBe(2);
    expect(s.held.get("own")!.map((c) => `${c.id}:${c.status}`)).toEqual([
      "b:done",
      "c:open",
      "a:open",
    ]);
    expect(await s.run("linked", "own")).toBe(0);
    expect(s.upserts).toEqual([["own", 2]]);
  });

  it("writes nothing when the own server already holds the same commitments, even with the marker lost", async () => {
    const s = servers({ linked: [commitment("a")], own: [commitment("a")] });
    expect(await s.run("linked", "own")).toBe(0);
    s.marks.clear();
    expect(await s.run("linked", "own")).toBe(0);
    expect(s.upserts).toEqual([]);
  });

  it("copies nothing when the first connection is the own server or there is none", async () => {
    const s = servers({ own: [commitment("a")] });
    expect(await s.run("own", "own")).toBe(0);
    expect(await s.run(undefined, "own")).toBe(0);
    expect(s.marks.size).toBe(0);
  });

  it("tries again next time when the linked server did not answer", async () => {
    const s = servers({ linked: [commitment("a")], own: [] }, "linked");
    await expect(s.run("linked", "own")).rejects.toThrow("no answer");
    expect(s.marks.size).toBe(0);
  });
});
