import { expect, it } from "vite-plus/test";

import { answerOnDoor } from "./catalogDoor.ts";

it("with T3's window closed, acts on this machine's catalog through its server and refuses another machine's", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const door = {
    here: { environmentId: "env-laptop", label: "Laptop" },
    labelOf: (id: string) => (id === "env-box" ? "Box" : "that computer"),
    direct: async (method: string, input: unknown) => {
      calls.push({ method, input });
      return method === "baton.sessions.list"
        ? { sessions: [{ id: "s1", state: "running", title: "api" }] }
        : { enabled: true };
    },
  };

  expect(
    await answerOnDoor({ kind: "catalogStop", environmentId: "env-laptop", sessionId: "s1" }, door),
  ).toEqual({ ok: true, detail: "Stopped." });
  expect(calls).toEqual([
    { method: "baton.sessions.autoresume", input: { action: "stop", sessionId: "s1" } },
  ]);

  const listed = await answerOnDoor({ kind: "catalogList", query: "" }, door);
  expect(JSON.parse(listed!.detail)).toEqual([
    {
      id: "s1",
      state: "running",
      title: "api",
      environmentId: "env-laptop",
      machine: "Laptop",
      local: true,
    },
  ]);

  calls.length = 0;
  expect(
    await answerOnDoor(
      { kind: "catalogReattach", environmentId: "env-box", sessionId: "s2", cwd: null },
      door,
    ),
  ).toEqual({ ok: false, detail: "Open T3 to reattach that session on Box." });
  expect(calls).toEqual([]);
});

it("says the server did not answer, rather than listing nothing or reporting auto-resume as off", async () => {
  const down = {
    here: { environmentId: "env-laptop", label: "Laptop" },
    labelOf: () => "that computer",
    direct: () => Promise.reject(new Error("down")),
  };
  for (const request of [
    { kind: "catalogList", query: "" },
    { kind: "catalogFolders", environmentId: "env-laptop" },
    { kind: "catalogAutoResume", action: "on" },
  ] as const)
    expect(await answerOnDoor(request, down)).toEqual({
      ok: false,
      detail: "This computer's server did not answer. Nothing changed.",
    });
});
