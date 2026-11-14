// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createMemorySync } from "./memorySync.ts";

const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-msync-"));
const protection = () => ({
  protect: (plain: string) => Buffer.from(plain).toString("base64"),
  unprotect: (wrapped: string) => Buffer.from(wrapped, "base64").toString(),
});

/** This app's own server as the desktop sees it: the switch, the peers it holds, and the window's list. */
const fakeServer = (window: { open: boolean } = { open: true }) => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let enabled = false;
  const peers = new Map<string, Record<string, unknown>>();
  const call = async (op: string, args: Record<string, unknown>) => {
    calls.push([op, args]);
    if (op === "syncState")
      return {
        enabled,
        peers: [...peers].map(([environmentId, p]) => ({
          environmentId,
          label: p["label"],
          expiresAt: p["expiresAt"],
        })),
      };
    if (op === "syncSetEnabled") return (void (enabled = args["on"] === true), {});
    if (op === "syncAddPeer") return (void peers.set(String(args["environmentId"]), args), {});
    if (op === "syncForget") return (void peers.delete(String(args["environmentId"])), {});
    if (op === "syncRun") return { servers: 1 + peers.size, applied: 2, refused: [] };
    if (op === "syncLink")
      return {
        origin: "https://box.example",
        baseUrl: "https://box.example/relay",
        token: "sync-token",
        expiresAt: 10_000,
      };
    if (op === "syncPeers") {
      if (!window.open) throw new Error("T3's window is closed.");
      return [
        { environmentId: "here", label: "Laptop", local: true },
        {
          environmentId: "box",
          label: "Server",
          local: false,
          baseUrl: "https://relay.example/e/box",
        },
      ];
    }
    throw new Error(`unexpected ${op}`);
  };
  return { call, calls, peers };
};

describe("memory sync, carried by this app's own server", () => {
  it("is off until he turns it on, then the server runs the round", async () => {
    const dir = tmp();
    const server = fakeServer();
    const sync = createMemorySync({
      file: NodePath.join(dir, "baton-memory.json"),
      call: server.call,
    });
    expect(await sync.run()).toBe("Memory sync is off.");
    await sync.setEnabled(true);
    expect(await sync.run()).toContain("nothing to carry");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("hands a paired server's credential to this server, never to a file here, and forgets it there", async () => {
    const dir = tmp();
    const server = fakeServer();
    const sync = createMemorySync({
      file: NodePath.join(dir, "baton-memory.json"),
      call: server.call,
      now: () => 1_000,
    });
    const box = async () => (await sync.peers()).find((p) => p.environmentId === "box");
    expect((await box())?.paired).toBe(false);
    await sync.link("box", "CODE");
    expect(server.peers.get("box")).toMatchObject({
      label: "Server",
      baseUrl: "https://box.example/relay",
      token: "sync-token",
    });
    expect(NodeFS.readdirSync(dir)).toEqual([]);
    expect(await box()).toMatchObject({ paired: true, expiresAt: 10_000 });
    await sync.forget("box");
    expect((await box())?.paired).toBe(false);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("moves an older build's encrypted credentials and switch to the server once, then deletes them", async () => {
    const dir = tmp();
    const file = NodePath.join(dir, "baton-memory.json");
    const peersFile = NodePath.join(dir, "memory-sync-peers.json");
    NodeFS.writeFileSync(file, JSON.stringify({ sync: true }));
    const credential = { origin: "https://box.example", token: "old-token", expiresAt: 10_000 };
    NodeFS.writeFileSync(
      peersFile,
      JSON.stringify({
        box: protection().protect(JSON.stringify(credential)),
        gone: protection().protect(JSON.stringify({ ...credential, expiresAt: 500 })),
        broken: "garbage",
      }),
    );
    const server = fakeServer();
    const sync = createMemorySync({
      file,
      peersFile,
      protection,
      now: () => 1_000,
      call: server.call,
    });
    await sync.migrate();
    expect([...server.peers.keys()]).toEqual(["box"]);
    // Moved under his name for it, from the window's list.
    expect(server.peers.get("box")).toMatchObject({
      label: "Server",
      baseUrl: "https://relay.example/e/box",
      token: "old-token",
      origin: "https://box.example",
    });
    expect(sync.enabled()).toBe(true);
    expect(NodeFS.existsSync(peersFile)).toBe(false);
    expect(NodeFS.existsSync(file)).toBe(false);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("never deletes the old credentials file it could not read, and moves it at a later start", async () => {
    const dir = tmp();
    const file = NodePath.join(dir, "baton-memory.json");
    const peersFile = NodePath.join(dir, "memory-sync-peers.json");
    const credential = { origin: "https://box.example", token: "old-token", expiresAt: 10_000 };
    NodeFS.writeFileSync(
      peersFile,
      JSON.stringify({ box: protection().protect(JSON.stringify(credential)) }),
    );
    const server = fakeServer();
    let encrypts = false;
    const sync = createMemorySync({
      file,
      peersFile,
      now: () => 1_000,
      protection: () => (encrypts ? protection() : null),
      call: server.call,
    });
    await sync.migrate();
    expect(NodeFS.existsSync(peersFile)).toBe(true);
    expect(server.peers.size).toBe(0);
    encrypts = true;
    await sync.migrate();
    expect(NodeFS.existsSync(peersFile)).toBe(false);
    expect([...server.peers.keys()]).toEqual(["box"]);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("waits for the server when switching sync or forgetting a server, and passes its refusal on", async () => {
    const dir = tmp();
    const sync = createMemorySync({
      file: NodePath.join(dir, "baton-memory.json"),
      call: async () => Promise.reject(new Error("The server did not answer.")),
    });
    await expect(sync.setEnabled(true)).rejects.toThrow("The server did not answer.");
    expect(sync.enabled()).toBe(false);
    await expect(sync.forget("box")).rejects.toThrow("The server did not answer.");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("shows the last list of servers when the window cannot be asked", async () => {
    const dir = tmp();
    const window = { open: true };
    const sync = createMemorySync({
      file: NodePath.join(dir, "baton-memory.json"),
      call: fakeServer(window).call,
    });
    expect(await sync.peers()).toHaveLength(2);
    window.open = false;
    expect(await sync.peers()).toHaveLength(2);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
