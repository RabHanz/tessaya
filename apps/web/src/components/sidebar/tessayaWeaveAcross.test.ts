import { describe, expect, it } from "vite-plus/test";

import {
  weaveAcross,
  weaveSessionsOf,
  type WeaveEnvironment,
  type WeaveReply,
} from "./tessayaWeaveAcross";

const weave = (toLabel: string, createdAt: number) => ({ id: toLabel, toLabel, createdAt });

/** Each environment answers a send from its own sessions, unless told to fail, and a list with its own weaves. */
const machines = (fail: Record<string, WeaveReply> = {}) => {
  const calls: Array<[string, string, unknown]> = [];
  const call = async (environmentId: string, op: string, args: unknown): Promise<WeaveReply> => {
    calls.push([environmentId, op, args]);
    if (op === "list")
      return {
        ok: true,
        value: { items: environmentId === "e-here" ? [weave("build", 1)] : [weave("deploy", 2)] },
      };
    const failed = fail[environmentId];
    if (failed !== undefined) return failed;
    const to = (args as { to: string }).to;
    return { ok: true, value: { weave: { toLabel: to, environmentId } } };
  };
  return { calls, call };
};
const env = (
  id: string,
  label: string,
  sessions: ReadonlyArray<string> | null,
): WeaveEnvironment => ({
  id,
  label,
  sessions,
});
const send = (
  to: string,
  environments: ReadonlyArray<WeaveEnvironment>,
  call: Parameters<typeof weaveAcross>[2],
) => weaveAcross({ kind: "weave", op: "send", args: { to, text: "hi" } }, environments, call);

describe("weave across his connected computers", () => {
  it("picks an exact name on any computer before a part of one here, and names that computer", async () => {
    const { calls, call } = machines();
    const here = env("e-here", "Laptop", ["build-ci"]);
    const office = env("e-office", "office", ["build"]);
    expect(await send("build", [here, office], call)).toEqual({
      weave: { toLabel: "office:build", environmentId: "e-office" },
    });
    expect(calls).toEqual([["e-office", "send", { to: "build", text: "hi" }]]);
  });

  it("refuses a name that fits sessions on two computers, saying which, and sends nothing", async () => {
    const { calls, call } = machines();
    await expect(
      send(
        "build",
        [env("e-here", "Laptop", ["build"]), env("e-office", "office", ["build"])],
        call,
      ),
    ).rejects.toThrow('"build" fits more than one session (Laptop:build, office:build); say which');
    expect(calls).toEqual([]);
  });

  it("goes straight to a named computer, as weave_list shows its sessions", async () => {
    const { calls, call } = machines();
    await send(
      "office:build",
      [env("e-here", "Laptop", ["build"]), env("e-office", "office", ["build"])],
      call,
    );
    expect(calls).toEqual([["e-office", "send", { to: "build", text: "hi" }]]);
  });

  it("a session name that looks like computer:name is that session, and a shared computer name is refused", async () => {
    const { calls, call } = machines();
    const here = env("e-here", "Laptop", ["dev:server"]);
    const dev = env("e-dev", "dev", ["server"]);
    await send("dev:server", [here, dev], call);
    expect(calls).toEqual([["e-here", "send", { to: "dev:server", text: "hi" }]]);
    await expect(
      send("office:build", [here, env("e-a", "office", []), env("e-b", "office", [])], call),
    ).rejects.toThrow('More than one computer is called "office". Nothing was sent.');
  });

  it("never tries a name on each computer: one in no list is refused unless the computer is named", async () => {
    const { calls, call } = machines();
    const here = env("e-here", "Laptop", ["api-v2"]);
    const office = env("e-office", "office", []);
    await expect(send("api", [here, office], call)).resolves.toMatchObject({
      weave: { environmentId: "e-here", toLabel: "api-v2" },
    });
    await expect(send("worker", [here, office], call)).rejects.toThrow(
      '"worker" isn\'t in any session list yet. Say computer:name.',
    );
    // Named, it goes there even before that computer's list has it.
    await send("  office:worker  ", [here, office], call);
    expect(calls.at(-1)).toEqual(["e-office", "send", { to: "worker", text: "hi" }]);
  });

  it("says when the named computer is not connected, and when the chosen one refuses", async () => {
    const { calls, call } = machines({
      "e-office": { ok: false, reason: "not permitted", kind: "unreachable" },
    });
    await expect(
      send("attic:build", [env("e-here", "Laptop", []), env("e-attic", "attic", null)], call),
    ).rejects.toThrow("attic isn't connected. Nothing was sent.");
    await expect(
      send("build", [env("e-here", "Laptop", []), env("e-office", "office", ["build"])], call),
    ).rejects.toThrow("not permitted");
    expect(calls).toEqual([["e-office", "send", { to: "build", text: "hi" }]]);
  });

  it("lists every connected computer's weaves together, newest first, naming another computer's sessions", async () => {
    const { call } = machines();
    expect(
      await weaveAcross(
        { kind: "weave", op: "list", args: { limit: 10 } },
        [env("e-here", "Laptop", []), env("e-office", "office", [])],
        call,
      ),
    ).toEqual({ items: [{ ...weave("deploy", 2), toLabel: "office:deploy" }, weave("build", 1)] });
  });

  it("knows a computer's sessions by their Herdr panes and Claude sessions outside Herdr", () => {
    expect(weaveSessionsOf(null)).toBeNull();
    expect(
      weaveSessionsOf({
        entries: [],
        herdr: [{ label: "build" }],
        claudeSessions: [
          { name: "notes", herdrPane: null, cwd: "/w/notes" },
          { name: null, herdrPane: null, cwd: "/w/shop" },
          { name: "in-herdr", herdrPane: "p1", cwd: "/w/x" },
        ],
        observedAt: "2026-11-07T00:00:00.000Z",
      } as never),
    ).toEqual(["build", "notes", "shop"]);
  });
});
