// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import type { BatonPrivateStore } from "@t3tools/tessaya-contracts";
import type { MemoryItem } from "@t3tools/tessaya-shared/memory";

import type { HomeControl } from "../home/batonHome.ts";
import type { HelloResult } from "../vault/hello.ts";
import { createMemoryTab } from "./memoryTab.ts";
import { createPrivateTab } from "./privateTab.ts";
import type { NotesStore } from "./memoryNotes.ts";

const item = (id: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  kind: "fact",
  text: `fact ${id}`,
  source: "user",
  sourceRef: null,
  scope: "global",
  scopeRef: null,
  confidence: 1,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  supersededBy: null,
  proposed: false,
  ...over,
});

const notes = {
  list: () => [{ id: "n1", text: "likes tea", file: "/x" }],
} as unknown as NotesStore;

const make = (call: (op: string, args: Record<string, unknown>) => Promise<unknown>) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-mtab-"));
  const refresh = vi.fn();
  const reveal = vi.fn();
  const sync = {
    enabled: () => false,
    setEnabled: vi.fn(async () => undefined),
    run: vi.fn(async () => "Synced 1 changes across 2 servers."),
    peers: vi.fn(async () => []),
    issue: vi.fn(async () => "CODE"),
    link: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    start: vi.fn(),
    migrate: vi.fn(async () => undefined),
  };
  const tab = createMemoryTab({ call, sync, notes, stateDir: dir, refresh, reveal });
  return { tab, refresh, reveal, sync, dir };
};
// Lets the promise chains the tab starts finish; no clock is involved.
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("the Memory tab", () => {
  it("shows his notes folder until the server has answered, then the server's memory", async () => {
    const { tab } = make(async (op) => (op === "list" ? { items: [item("a")] } : { items: [] }));
    expect(tab.controls()[0]!.id).toBe("m:n1");
    await tab.load();
    expect(tab.controls().map((c) => c.id)).toEqual(["m.bar", "m:a"]);
  });

  it("falls back to the notes when the server cannot be reached", async () => {
    const { tab } = make(async () => Promise.reject(new Error("down")));
    await tab.load();
    expect(tab.controls().some((c) => c.label === "likes tea")).toBe(true);
    expect(tab.act("m:n1", null)).toBe(false);
  });

  it("edit, pin, forget and accept go to the server and the page is read again", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const { tab } = make(async (op, args) => {
      calls.push([op, args]);
      return op === "list" ? { items: [item("a")] } : {};
    });
    await tab.load();
    expect(tab.act("m.edit:a", "new words")).toBe(true);
    expect(tab.act("m.pin:a", true)).toBe(true);
    expect(tab.act("m.forget:a", null)).toBe(true);
    expect(tab.act("m.accept:a", null)).toBe(true);
    await settle();
    expect(calls.filter(([op]) => op !== "list" && op !== "used" && op !== "pull")).toEqual([
      ["edit", { id: "a", text: "new words" }],
      ["pin", { id: "a", pinned: true }],
      ["forget", { id: "a" }],
      ["accept", { id: "a" }],
    ]);
  });

  it("says why the server refused an edit", async () => {
    const { tab } = make(async (op) => {
      if (op === "edit") throw new Error("that looks like a password, so I did not keep it");
      return op === "list" ? { items: [item("a")] } : {};
    });
    await tab.load();
    tab.act("m.edit:a", "my password is x");
    await settle();
    expect((tab.controls()[0] as { status: string }).status).toContain("password");
  });

  it("searches, filters, exports a file and imports a folder", async () => {
    const { tab, reveal, dir } = make(async (op) => {
      if (op === "list")
        return { items: [item("a"), item("b", { kind: "preference", text: "tea at four" })] };
      if (op === "export") return { markdown: "# Tessaya memory\n- [fact] fact a\n" };
      if (op === "import") return { files: 2, added: 2, refused: 0, unchanged: 0 };
      return { items: [] };
    });
    await tab.load();
    tab.act("m.kind", "preference");
    expect(
      tab
        .controls()
        .filter((c) => c.kind === "memory")
        .map((c) => c.id),
    ).toEqual(["m:b"]);
    tab.act("m.kind", "all");
    tab.act("m.query", "fact a");
    expect(
      tab
        .controls()
        .filter((c) => c.kind === "memory")
        .map((c) => c.id),
    ).toEqual(["m:a"]);
    tab.act("m.export", null);
    await settle();
    expect(NodeFS.readFileSync(NodePath.join(dir, "memory-export.md"), "utf8")).toContain("fact a");
    expect(reveal).toHaveBeenCalled();
    tab.act("m.import", "/some/folder");
    await settle();
    expect((tab.controls()[0] as { status: string }).status).toBe(
      "Read 2 files: 2 added, 0 unchanged, 0 not kept.",
    );
  });

  it("sync is switched and run from the tab", async () => {
    const { tab, sync } = make(async () => ({ items: [] }));
    tab.act("m.syncOn", true);
    expect(sync.setEnabled).toHaveBeenCalledWith(true);
    tab.act("m.sync", null);
    await settle();
    expect(sync.run).toHaveBeenCalled();
  });

  it("says so when the server refuses to switch sync or forget a server", async () => {
    const { tab, sync } = make(async () => ({ items: [] }));
    await tab.load();
    sync.setEnabled.mockRejectedValueOnce(new Error("The server did not answer."));
    tab.act("m.syncOn", true);
    await settle();
    expect((tab.controls()[0] as { status: string }).status).toBe("The server did not answer.");
    sync.forget.mockRejectedValueOnce(new Error("Nothing was changed."));
    tab.act("m.syncForget:box", null);
    await settle();
    expect((tab.controls()[0] as { status: string }).status).toBe("Nothing was changed.");
  });

  it("leaves other ids alone", () => {
    const { tab } = make(async () => ({}));
    expect(tab.act("v.enabled", true)).toBe(false);
  });
});

const OWNER = "0b1f7c55-0000-4000-8000-000000000001";
const SARA = "0b1f7c55-0000-4000-8000-000000000002";
const store = (id: string, over: Partial<BatonPrivateStore> = {}): BatonPrivateStore => ({
  id,
  personId: id === OWNER ? "owner" : "sara",
  name: id === OWNER ? "You" : "Sara",
  kind: id === OWNER ? "owner" : "person",
  items: 2,
  open: false,
  openUntil: null,
  recallOff: false,
  lastOpenedAt: null,
  waitUntil: null,
  recoveryOnly: false,
  ...over,
});

/** A stand-in for the server's private stores: opens on PIN 24681357, keeps what was listed for an open store. */
const makePrivate = (over: { hello?: HelloResult; noOwner?: boolean } = {}) => {
  const open = new Set<string>();
  const calls: Array<[string, Record<string, unknown>]> = [];
  const locked = new Set<() => void>();
  const clip = { value: "" };
  const memory = {
    people: async () =>
      (over.noOwner && !open.has(OWNER) ? [store(SARA)] : [store(OWNER), store(SARA)]).map((s) =>
        open.has(s.id) ? { ...s, open: true, openUntil: "2026-01-01T00:05:00.000Z" } : s,
      ),
    call: async (op: string, args: Record<string, unknown> = {}) => {
      calls.push([op, args]);
      if (op === "unlock") {
        if (args.pin !== undefined && args.pin !== "24681357")
          throw new Error("That PIN is not right.");
        open.add(args.storeId as string);
        return {};
      }
      if (op === "lock") {
        open.delete(args.storeId as string);
        return { locked: 1 };
      }
      if (op === "setup") {
        open.add(OWNER);
        return { store: store(OWNER), recoveryCode: "ABCD-EFGH-IJKL-MNOP" };
      }
      if (op === "list")
        return {
          items: [
            item("p1", { text: "Sara's birthday is 3 March" }),
            item("p2", { proposed: true }),
          ],
        };
      return {};
    },
    onLocked: (f: () => void) => void locked.add(f),
  };
  const hello = vi.fn(async () => over.hello ?? ("unavailable" as HelloResult));
  const tab = createPrivateTab({
    memory,
    hello,
    clipboard: {
      read: () => clip.value,
      write: (t) => void (clip.value = t),
      clear: () => void (clip.value = ""),
    },
    saveFile: async () => "/picked/file.md",
    everydayCount: () => 3,
    voices: () => [
      { id: "sara", name: "Sara" },
      { id: "kim", name: "Kim" },
    ],
    refresh: () => undefined,
    now: () => Date.parse("2026-01-01T00:01:30.000Z"),
  });
  return { tab, calls, hello, clip, lockAll: () => locked.forEach((f) => f()) };
};
const rowsOf = (tab: { controls: () => ReadonlyArray<HomeControl> }) =>
  tab
    .controls()
    .filter((c) => c.kind === "memory")
    .map((c) => c.label);

describe("the People area", () => {
  it("passes a PIN to the server and never back into what the window draws", async () => {
    const { tab, calls, hello } = makePrivate({ hello: "verified" });
    await tab.load();
    tab.act(`m.pv.pick:${OWNER}`, null);
    await settle();
    tab.act(`m.pv.unlock:${OWNER}`, "24681357");
    await settle();
    expect(hello).toHaveBeenCalledOnce();
    expect(calls).toContainEqual(["unlock", { storeId: OWNER, pin: "24681357" }]);
    expect(JSON.stringify(tab.controls())).not.toContain("24681357");
    expect(rowsOf(tab)).toEqual(["fact p2", "Sara's birthday is 3 March"]);
    // His review list: what waits for his yes.
    expect(tab.controls().find((c) => c.id.endsWith("/p2"))?.section).toBe("Waiting for your yes");
    // A wrong PIN says so, and is not drawn either.
    tab.act(`m.pv.lock:${OWNER}`, null);
    await settle();
    tab.act(`m.pv.unlock:${OWNER}`, "11112222");
    await settle();
    const drawn = JSON.stringify(tab.controls());
    expect(drawn).not.toContain("11112222");
    expect(drawn).toContain("That PIN is not right.");
  });

  it("does not open his store when Windows Hello says no", async () => {
    const { tab, calls } = makePrivate({ hello: "declined" });
    await tab.load();
    tab.act(`m.pv.unlock:${OWNER}`, "24681357");
    await settle();
    expect(calls.some(([op]) => op === "unlock")).toBe(false);
  });

  it("drops what it read when a store locks, the screen locks, or the tab closes", async () => {
    const { tab, lockAll } = makePrivate();
    await tab.load();
    tab.act(`m.pv.pick:${OWNER}`, null);
    tab.act(`m.pv.unlock:${OWNER}`, "24681357");
    await settle();
    expect(rowsOf(tab)).toHaveLength(2);
    tab.act(`m.pv.lock:${OWNER}`, null);
    expect(rowsOf(tab)).toEqual([]);
    await settle();
    tab.act(`m.pv.unlock:${OWNER}`, "24681357");
    await settle();
    lockAll();
    expect(rowsOf(tab)).toEqual([]);
    expect(JSON.stringify(tab.controls())).not.toContain("birthday");
    tab.act(`m.pv.unlock:${OWNER}`, "24681357");
    await settle();
    tab.close();
    expect(rowsOf(tab)).toEqual([]);
  });

  it("shows the recovery code once: gone when he has saved it or the tab closes, and copied only for 30 s", async () => {
    vi.useFakeTimers();
    try {
      const { tab, clip } = makePrivate({ noOwner: true });
      await tab.load();
      tab.act("m.pv.setup", JSON.stringify({ pin: "24681357", again: "2468135" }));
      expect(JSON.stringify(tab.controls())).toContain("The two PINs are not the same.");
      tab.act("m.pv.setup", JSON.stringify({ pin: "24681357", again: "24681357" }));
      await settle();
      const people = () =>
        tab.controls().find((c) => c.kind === "privatePeople") as { recovery: unknown };
      expect(people().recovery).toEqual({ name: "You, private", code: "ABCD-EFGH-IJKL-MNOP" });
      tab.act("m.pv.recoveryCopy", null);
      expect(clip.value).toBe("ABCD-EFGH-IJKL-MNOP");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(clip.value).toBe("");
      tab.act("m.pv.recoveryDone", null);
      expect(people().recovery).toBeNull();
      expect(JSON.stringify(tab.controls())).not.toContain("ABCD-EFGH");
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes a person's store only for a voice Voice ID saved, named as Voice ID named them", async () => {
    const { tab, calls } = makePrivate();
    await tab.load();
    tab.act(`m.pv.unlock:${OWNER}`, "24681357");
    await settle();
    const people = tab.controls().find((c) => c.kind === "privatePeople") as {
      voices: ReadonlyArray<{ id: string }>;
    };
    // Sara already has a store; only Kim is offered.
    expect(people.voices.map((v) => v.id)).toEqual(["kim"]);
    tab.act(
      "m.pv.addPerson",
      JSON.stringify({ personId: "kim", name: "", pin: "135792", again: "135792" }),
    );
    await settle();
    expect(calls).toContainEqual(["setup", { personId: "kim", name: "Kim", pin: "135792" }]);
  });

  it("opens a person's store as admin with no PIN, only once his own is open", async () => {
    const { tab, calls } = makePrivate();
    await tab.load();
    tab.act(`m.pv.unlock:${OWNER}`, "24681357");
    await settle();
    tab.act(`m.pv.pick:${SARA}`, null);
    tab.act(`m.pv.admin:${SARA}`, null);
    await settle();
    expect(calls).toContainEqual(["unlock", { storeId: SARA }]);
    const bar = tab.controls().find((c) => c.kind === "privateBar") as { canChangePin: boolean };
    expect(bar.canChangePin).toBe(false);
  });
});
