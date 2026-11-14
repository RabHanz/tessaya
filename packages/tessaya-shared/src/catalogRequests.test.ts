import { describe, expect, it } from "vite-plus/test";

import { answerCatalogRequest, type CatalogCommands } from "./catalogRequests.ts";

const row = {
  id: "s1",
  machine: "host",
  project: "app",
  cwd: "/w/app",
  title: "T",
  lastActivityAt: null,
  account: null,
  state: "stopped",
  source: "transcript",
  canResume: true,
  detail: null,
  waiting: 0,
};

const commands = (over: Partial<Record<keyof CatalogCommands, unknown>> = {}) =>
  ({
    list: async ({ environmentId }: { environmentId: string }) =>
      environmentId === "bad"
        ? Promise.reject(new Error("down"))
        : { _tag: "Success", value: { machine: "host", sessions: [row], more: false } },
    resume: async () => ({
      _tag: "Success",
      value: { state: "resuming", pane: null, detail: null },
    }),
    create: async () => ({ _tag: "Failure" }),
    folders: async () => ({
      _tag: "Success",
      value: { folders: [{ cwd: "/w/app", project: "app", lastActivityAt: null }] },
    }),
    ...over,
  }) as unknown as CatalogCommands;

const deps = (c: CatalogCommands) => ({
  commands: c,
  environmentIds: ["e1", "bad", "e2"],
  label: (id: string) => `Env ${id}`,
});

describe("the catalog requests Baton's window makes of the sidebar", () => {
  it("lists every environment that answers, labelled, and skips one that is down", async () => {
    const answer = await answerCatalogRequest({ kind: "catalogList", query: "" }, deps(commands()));
    const rows = JSON.parse(answer!.detail) as Array<{ environmentId: string; machine: string }>;
    expect(rows.map((r) => [r.environmentId, r.machine])).toEqual([
      ["e1", "Env e1"],
      ["e2", "Env e2"],
    ]);
  });

  it("passes a resume through, says when a start failed, and lists folders", async () => {
    const d = deps(commands());
    expect(
      JSON.parse(
        (await answerCatalogRequest(
          { kind: "catalogResume", environmentId: "e1", sessionId: "s1", cwd: null },
          d,
        ))!.detail,
      ).state,
    ).toBe("resuming");
    expect(
      (await answerCatalogRequest({ kind: "catalogCreate", environmentId: "e1", cwd: "/w" }, d))!
        .ok,
    ).toBe(false);
    expect(
      JSON.parse(
        (await answerCatalogRequest({ kind: "catalogFolders", environmentId: "e1" }, d))!.detail,
      ),
    ).toEqual(["/w/app"]);
    expect(
      await answerCatalogRequest({ kind: "open", environmentId: "e1", threadId: "t" }, d),
    ).toBeNull();
  });
});
