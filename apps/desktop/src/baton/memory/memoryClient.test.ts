import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopMemory, createMemoryClient } from "./memoryClient.ts";
import type { NotesStore } from "./memoryNotes.ts";

const notes = (): NotesStore =>
  ({
    dir: "/x",
    list: () => [],
    add: (text: string) => ({ id: "n1", text, file: "/x/n1.md" }),
    remove: (id: string) => id === "n1",
    search: () => [{ id: "n1", text: "likes tea", file: "/x/n1.md" }],
  }) as unknown as NotesStore;

describe("desktop memory", () => {
  it("asks the server, and says why when it refuses", async () => {
    const call = vi.fn(async (op: string) => {
      if (op === "add") throw new Error("that looks like a password, so I did not keep it");
      return {};
    });
    const memory = createDesktopMemory({ call, notes: notes() });
    expect(await memory.remember("my password is x")).toContain("password");
  });

  it("moves notes kept while the server was away into memory once it answers", async () => {
    const kept = [
      { id: "n1", text: "the boiler code is in the blue folder", file: "/x/n1.md" },
      { id: "n2", text: "my password is hunter2-x", file: "/x/n2.md" },
    ];
    const folder = {
      ...notes(),
      list: () => kept,
      remove: (id: string) =>
        kept.splice(
          kept.findIndex((n) => n.id === id),
          1,
        ).length === 1,
    } as unknown as NotesStore;
    let up = false;
    const added: unknown[] = [];
    const call = vi.fn(async (op: string, args: Record<string, unknown>) => {
      if (!up) throw new Error("not reachable");
      if (op === "add") {
        if (String(args["text"]).includes("password")) throw new Error("refused");
        added.push(args);
        return { item: { id: "m1" } };
      }
      return { hits: [] };
    });
    const memory = createDesktopMemory({ call, notes: folder });
    await memory.search("boiler");
    expect(added).toEqual([]);
    up = true;
    await memory.search("boiler");
    expect(added).toEqual([
      { kind: "note", text: "the boiler code is in the blue folder", source: "user", pinned: true },
    ]);
    // A refused note stays where he can see it; it is not tried again on every call.
    expect(kept.map((n) => n.id)).toEqual(["n2"]);
    await memory.search("boiler");
    expect(added).toHaveLength(1);
  });

  it("falls back to the notes folder when the server does not answer", async () => {
    const memory = createDesktopMemory({ notes: notes() });
    expect(await memory.remember("likes tea")).toBe("Kept as a note [id: n1].");
    expect(await memory.forget("n1")).toBe("Forgotten.");
    expect((await memory.search("tea"))[0]).toContain("likes tea");
    expect(await memory.standing()).toBe("");
  });

  it("reads the standing block as the persona whose session it is (P3)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const memory = createDesktopMemory({
      call: async (_op, args) => (calls.push(args), { block: "b" }),
      notes: notes(),
    });
    await memory.standing("engineering");
    await memory.standing();
    // His zone goes with it, so "yesterday" and an episode's day are his (MEM-18).
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(calls).toEqual([
      { budgetTokens: 600, agent: "engineering", timeZone },
      { budgetTokens: 600, timeZone },
    ]);
  });

  it("recalls for the sentence under the turn's reference and reads what was used", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const call = async (op: string, args: Record<string, unknown>) => {
      calls.push([op, args]);
      if (op === "recall") return { block: "what you remember...\n- likes tea", ids: ["a"] };
      if (op === "used") return { items: [{ text: "likes tea", kind: "note" }] };
      return {};
    };
    const memory = createDesktopMemory({ call, notes: notes() });
    const ref = memory.beginTurn();
    expect(await memory.forSentence("make me tea")).toContain("likes tea");
    expect(calls[0]![1]).toMatchObject({ text: "make me tea", turnRef: ref });
    expect(await memory.used()).toBe("- likes tea (note)");
  });

  it("names the turn's persona only when there is one: a device's turn reads the walled view", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let persona: string | undefined = "engineering";
    const memory = createDesktopMemory({
      call: async (_op, args) => (calls.push(args), { block: "", ids: [] }),
      notes: notes(),
      agent: () => persona,
    });
    await memory.forSentence("deploy key");
    persona = undefined;
    await memory.forSentence("deploy key");
    expect(calls[0]).toMatchObject({ agent: "engineering" });
    expect(calls[1]).not.toHaveProperty("agent");
  });

  it("a stuck server costs the turn no more than the wait", async () => {
    vi.useFakeTimers();
    const memory = createDesktopMemory({
      call: () => new Promise(() => undefined),
      notes: notes(),
    });
    const pending = memory.forSentence("hello");
    await vi.advanceTimersByTimeAsync(900);
    expect(await pending).toBe("");
    vi.useRealTimers();
  });
});

describe("the MemoryClient other lanes call", () => {
  it("maps each method to its server call and unwraps the answer", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = createMemoryClient(async (op, args) => {
      calls.push([op, args]);
      return {
        item: { id: "a" },
        items: [{ id: "a" }],
        hits: [],
        forgotten: true,
        markdown: "# m",
        block: "",
        ids: [],
      };
    });
    expect((await client.add({ kind: "fact", text: "x", source: "user" })).id).toBe("a");
    expect(await client.forget("a")).toBe(true);
    expect(await client.list({ kinds: ["fact"] })).toHaveLength(1);
    expect(await client.exportMarkdown()).toBe("# m");
    await client.pin("a", true);
    expect(calls.map(([op]) => op)).toEqual(["add", "forget", "list", "export", "pin"]);
    expect(calls[4]![1]).toEqual({ id: "a", pinned: true });
  });
});
