import type { TessayaPerson } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { nameAndRelation, peopleControls, peopleRequest } from "./peopleSection.ts";

const person = (over: Partial<TessayaPerson>): TessayaPerson => ({
  id: "p1",
  name: null,
  status: "unknown",
  relations: [],
  heard: 3,
  firstSeen: "2026-11-03T10:00:00.000Z",
  lastSeen: "2026-11-12T10:00:00.000Z",
  keepUntil: "2026-12-03T10:00:00.000Z",
  askName: true,
  impression: null,
  topics: [],
  ...over,
});

describe("People in the Household area", () => {
  it("asks the server what each click means, and forgetting needs a second click", () => {
    expect(peopleRequest("m.hh.ppl.same:a|b", undefined, null)).toEqual({
      op: "peopleManage",
      args: { action: "merge", id: "a", into: "b" },
    });
    expect(peopleRequest("m.hh.ppl.same:a|b:later", undefined, null)).toMatchObject({
      args: { action: "notSame", id: "a", into: "b" },
    });
    expect(peopleRequest("m.hh.ppl.name:p1:add", "Ali, my cousin", null)).toMatchObject({
      args: { action: "name", id: "p1", name: "Ali", relation: "my cousin" },
    });
    expect(peopleRequest("m.hh.ppl.status:p1", "member:sara-1", null)).toMatchObject({
      args: { action: "setStatus", id: "p1", status: "member", member: "sara-1" },
    });
    expect(peopleRequest("m.hh.ppl.status:p1", "tv", null)).toMatchObject({
      args: { action: "notPerson" },
    });
    expect(peopleRequest("m.hh.ppl.keep:p1", false, null)).toMatchObject({
      args: { action: "unsave" },
    });
    expect(peopleRequest("m.hh.ppl.askAll", false, null)).toMatchObject({
      args: { action: "ask", on: false },
    });
    expect(peopleRequest("m.hh.ppl.forget:p1", undefined, null)).toEqual({ confirm: "forget:p1" });
    expect(peopleRequest("m.hh.ppl.forget:p1", undefined, "forget:p1")).toEqual({
      op: "peopleManage",
      args: { action: "forget", id: "p1", confirmed: true },
    });
    // Recently forgotten: restore at once; deleting one or all for good takes a second click.
    expect(peopleRequest("m.hh.ppl.gone:p1", undefined, null)).toMatchObject({
      args: { action: "restore", id: "p1" },
    });
    expect(peopleRequest("m.hh.ppl.gone:p1:later", undefined, null)).toEqual({
      confirm: "purge:p1",
    });
    expect(peopleRequest("m.hh.ppl.gone:p1:later", undefined, "purge:p1")).toEqual({
      op: "peopleManage",
      args: { action: "purge", id: "p1" },
    });
    expect(peopleRequest("m.hh.ppl.purgeAll", undefined, "purge:p1")).toEqual({
      confirm: "purge:all",
    });
    expect(peopleRequest("m.hh.ppl.purgeAll", undefined, "purge:all")).toEqual({
      op: "peopleManage",
      args: { action: "purge" },
    });
    expect(peopleRequest("m.hh.ppl.bin", "90", null)).toMatchObject({
      args: { action: "bin", days: 90 },
    });
    expect(peopleRequest("m.hh.role:sara-1", "adult", null)).toBeNull();
    expect(nameAndRelation("  ")).toBeNull();
    expect(nameAndRelation("Sara")).toEqual({ name: "Sara" });
  });

  it("states the retention, puts suggestions first and shows how long each voice is kept", () => {
    const rows = peopleControls({
      people: [person({}), person({ id: "p2", name: "Ali", status: "guest", keepUntil: null })],
      suggestions: [{ kind: "same", id: "p1", other: "p2", score: 0.4, line: "Same as Ali?" }],
      retentionDays: 30,
      askNames: true,
      members: [],
      confirmForget: null,
      forgotten: [{ id: "p9", name: null, by: "themselves", at: "2026-11-15T10:00:00.000Z" }],
      binDays: 30,
      status: null,
    });
    expect(rows[0]).toMatchObject({ id: "m.hh.ppl.retention", value: "30" });
    // Under an expiry only the unnamed voice has a keep switch: everyone named is remembered.
    expect(rows.some((r) => r.id === "m.hh.ppl.keep:p1")).toBe(true);
    expect(rows.some((r) => r.id === "m.hh.ppl.keep:p2")).toBe(false);
    expect(peopleRequest("m.hh.ppl.retention", "0", null)).toMatchObject({
      args: { action: "retention", days: 0 },
    });
    expect(rows[2]).toMatchObject({ id: "m.hh.ppl.same:p1|p2", label: "Same as Ali?" });
    const ali = rows.find((r) => r.id === "m.hh.ppl.person:p2");
    expect(ali?.kind === "check" && ali.detail).toContain("kept");
    expect(rows.find((r) => r.id === "m.hh.ppl.person:p1")?.label).toBe("Someone new");
    // A named guest is no longer asked about; an unnamed voice may be.
    expect(rows.some((r) => r.id === "m.hh.ppl.ask:p2")).toBe(false);
    expect(rows.some((r) => r.id === "m.hh.ppl.ask:p1")).toBe(true);
    // Someone who forgot themselves shows so, with Restore and Delete for good.
    expect(rows.find((r) => r.id === "m.hh.ppl.gone:p9")?.hint).toContain("Forgot themselves");
  });
});
