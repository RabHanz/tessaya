// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { MAX_USER_JOBS, type UserJob } from "@t3tools/tessaya-shared/userJobs";

import { createUserJobStore } from "./userJobStore.ts";

const job = (id: string): UserJob => ({
  id,
  title: "Morning CI check",
  instruction: "Check CI and tell me what broke",
  owner: "executive",
  trigger: { kind: "time", hour: 8, minute: 0, days: [] },
  tools: ["jobs_list"],
  on: true,
  proposed: false,
  from: "him",
  missed: "once",
  createdAt: 0,
});

describe("his own standing jobs, kept on this computer", () => {
  it("adds, edits, switches and removes, and never holds more than the cap", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "user-jobs-"));
    const store = createUserJobStore(dir);
    expect(store.nextId()).toBe("user:1");
    expect(store.add(job(store.nextId()))).toEqual({ ok: true });
    expect(store.nextId()).toBe("user:2");
    expect(
      store.update("user:1", { on: false, instruction: "Check CI on tessaya only" }),
    ).toMatchObject({
      on: false,
      instruction: "Check CI on tessaya only",
    });
    expect(store.update("user:9", { on: true })).toBeNull();
    for (let i = 1; i < MAX_USER_JOBS; i += 1) store.add(job(store.nextId()));
    expect(store.add(job(store.nextId()))).toMatchObject({ ok: false });
    expect(store.remove("user:1")).toBe(true);
    expect(store.get("user:1")).toBeUndefined();
    expect(store.list()).toHaveLength(MAX_USER_JOBS - 1);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps proposals to three, and switches one on only from the Trust page", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "user-jobs-"));
    const store = createUserJobStore(dir);
    const proposal = (id: string): UserJob => ({
      ...job(id),
      on: false,
      proposed: true,
      from: "device",
    });
    for (let i = 0; i < 3; i += 1)
      expect(store.add(proposal(store.nextId()))).toEqual({ ok: true });
    expect(store.add(proposal(store.nextId()))).toMatchObject({ ok: false });
    // A tool, or a page it read, cannot approve one; the Trust page can.
    expect(store.update("user:1", { on: true })).toEqual({
      refused: "A proposal is approved by him on the Trust page, not here.",
    });
    expect(store.update("user:1", { on: true }, { approve: true })).toMatchObject({
      on: true,
      proposed: false,
    });
    // Words he rewrites are his from then on.
    expect(store.update("user:2", { instruction: "Check CI" })).toMatchObject({ from: "him" });
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("skips a bad entry and keeps a damaged file aside, so the page never breaks on one", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "user-jobs-"));
    const file = NodePath.join(dir, "user-jobs.json");
    const skipped: string[] = [];
    NodeFS.writeFileSync(
      file,
      JSON.stringify({ next: 3, jobs: [job("user:1"), { id: "user:2" }] }),
    );
    const store = createUserJobStore(dir, (why) => void skipped.push(why));
    expect(store.list().map((j) => j.id)).toEqual(["user:1"]);
    expect(skipped).toHaveLength(1);
    NodeFS.writeFileSync(file, JSON.stringify(["not", "a", "store"]));
    expect(store.list()).toEqual([]);
    expect(NodeFS.existsSync(`${file}.bad`)).toBe(true);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
