import { describe, expect, it } from "vite-plus/test";

import { deskCall, serverOnly } from "./deskCall.ts";

describe("a request answered by this machine's server while T3 is closed", () => {
  it("shapes job, memory, commitment and weave calls as the sidebar does, and leaves the window's own requests alone", () => {
    expect(deskCall({ kind: "job", op: "watch", args: {} })).toEqual({
      method: "baton.watch.get",
      input: {},
    });
    expect(deskCall({ kind: "job", op: "refine", args: { id: "w1", text: "smaller" } })).toEqual({
      method: "baton.job.refine",
      input: { id: "w1", text: "smaller", via: "voice", widens: false },
    });
    expect(deskCall({ kind: "memory", op: "search", args: { query: "tea" } })).toEqual({
      method: "baton.memory.search",
      input: { query: "tea" },
    });
    expect(deskCall({ kind: "commitments", op: "upsert", args: { rows: [] } })).toEqual({
      method: "baton.commitments.upsert",
      input: { rows: [] },
    });
    expect(deskCall({ kind: "weave", op: "send", args: { to: "api", text: "hi" } })).toEqual({
      method: "baton.weave.send",
      input: { to: "api", text: "hi" },
    });
    // Delivery is the server's own drainer, never a client's call.
    expect(deskCall({ kind: "weave", op: "tick", args: {} })).toBeNull();
    expect(
      deskCall({ kind: "job", op: "start", args: { project: "shop", title: "t", goal: "g" } }),
    ).toEqual({
      method: "baton.job.place",
      input: { project: "shop", title: "t", goal: "g", folders: [], tools: [] },
    });
    // Another machine's job is placed by the window, which is connected to it; this one's, by name, here.
    expect(deskCall({ kind: "job", op: "start", args: { runOn: "box" } })).toEqual({
      refuse: "Open T3 to start a job on box.",
    });
    const here = { environmentId: "env-laptop", label: "Laptop" };
    for (const runOn of ["laptop", "lap", "this computer"])
      expect(deskCall({ kind: "job", op: "start", args: { runOn } }, here)).toMatchObject({
        method: "baton.job.place",
      });
    // Before the list is read, only the words for here are known to be this computer.
    expect(deskCall({ kind: "job", op: "start", args: { runOn: "here" } })).toMatchObject({
      method: "baton.job.place",
    });
    expect(deskCall({ kind: "cloud", op: "read", args: { op: "list" } })).toEqual({
      method: "baton.cloud.read",
      input: { op: "list" },
    });
    // A hub on another machine, and the list of machines, are the window's.
    expect(
      deskCall({ kind: "cloud", op: "act", args: {}, environmentId: "box" }, here, () => "Box"),
    ).toEqual({ refuse: "Open T3 to use cloud tasks on Box." });
    expect(
      deskCall({ kind: "cloud", op: "act", args: { id: "c1" }, environmentId: "env-laptop" }, here),
    ).toEqual({ method: "baton.cloud.act", input: { id: "c1" } });
    expect(deskCall({ kind: "cloud", op: "environments", args: {} })).toBeNull();
    // The house is the shared tools' now (baton.tools.call); only this server's own sync stays on its door.
    expect(serverOnly({ kind: "home", op: "read" })).toBe(false);
    expect(serverOnly({ kind: "memory", op: "syncRun" })).toBe(true);
    expect(deskCall({ kind: "job", op: "handoff", args: { id: "w1", instance: "Codex" } })).toEqual(
      {
        method: "baton.job.handoff",
        input: { id: "w1", instance: "Codex" },
      },
    );
    expect(deskCall({ kind: "memory", op: "sync", args: {} })).toBeNull();
    expect(deskCall({ kind: "run" })).toBeNull();
  });
});
