import type { BatonCommitment } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { copyCommitmentsOnce } from "./batonCommitmentsCopy";

const commitment = (
  id: string,
  status: BatonCommitment["status"] = "open",
  at = 1,
): BatonCommitment => ({
  id,
  text: `check ${id}`,
  owner: "tessaya",
  due: null,
  status,
  source: "voice",
  createdAt: 1,
  updatedAt: at,
  ...(status === "open" ? {} : { closedAt: at }),
});

const stamp = (c: BatonCommitment) => c.updatedAt ?? c.closedAt ?? c.createdAt;

/** Servers' ledgers with `BatonCommitmentService.upsert`'s rules, and a done-marker store. */
const servers = (ledgers: Record<string, ReadonlyArray<BatonCommitment>>, failList?: string) => {
  const held = new Map(Object.entries(ledgers).map(([id, items]) => [id, [...items]]));
  const upserts: Array<[string, ReadonlyArray<string>]> = [];
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
        upserts.push([id, items.map((c) => c.id)]);
        const ledger = held.get(id) ?? [];
        for (const c of items) {
          const at = ledger.findIndex((x) => x.id === c.id);
          const old = ledger[at];
          if (old === undefined) {
            ledger.push(c);
            continue;
          }
          if (old.status !== "open" && c.status === "open") continue;
          if (old.status === c.status && stamp(old) >= stamp(c)) continue;
          ledger[at] = c;
        }
        held.set(id, ledger);
      },
      done: (key) => marks.has(key),
      markDone: (key) => marks.add(key),
    });
  const statuses = (id: string) => held.get(id)!.map((c) => `${c.id}:${c.status}`);
  return { upserts, marks, run, statuses };
};

describe("copyCommitmentsOnce", () => {
  it("copies what the linked server holds to the own server, once", async () => {
    const s = servers({
      linked: [commitment("a"), commitment("b", "done", 2)],
      own: [commitment("b"), commitment("c")],
    });
    expect(await s.run("linked", "own")).toBe(2);
    expect(s.statuses("own")).toEqual(["b:done", "c:open", "a:open"]);
    expect(await s.run("linked", "own")).toBe(0);
    expect(s.upserts).toEqual([["own", ["a", "b"]]]);
  });

  it("never copies from a different server that later connects first", async () => {
    const s = servers({ linked: [commitment("a")], other: [commitment("x")], own: [] });
    await s.run("linked", "own");
    expect(await s.run("other", "own")).toBe(0);
    expect(s.statuses("own")).toEqual(["a:open"]);
  });

  it("keeps a newer open edit here over an older closed copy there", async () => {
    const s = servers({ linked: [commitment("a", "done", 2)], own: [commitment("a", "open", 5)] });
    expect(await s.run("linked", "own")).toBe(0);
    expect(s.statuses("own")).toEqual(["a:open"]);
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
