import { describe, expect, it } from "vite-plus/test";

import { createRemoteHandsLoop, type HubPost } from "./remoteHandsLoop.ts";

const make = (over: { enabled?: boolean; post?: HubPost } = {}) => {
  const posts: Array<{ path: string; body: unknown }> = [];
  const post: HubPost =
    over.post ??
    (async (path, body) => {
      posts.push({ path, body });
      return path === "take"
        ? {
            status: 200,
            json: {
              call: { id: "c1", tool: "ui_tree", args: { window: "Notepad" }, session: "s" },
            },
          }
        : { status: 200, json: { ok: true } };
    });
  const ran: string[] = [];
  const loop = createRemoteHandsLoop({
    post,
    enabled: () => over.enabled ?? true,
    run: async (c) => (ran.push(c.tool), { ok: true, text: "Notepad" }),
  });
  return { loop, posts, ran };
};

describe("remote hands loop", () => {
  it("runs a taken call and sends its answer back under the same id", async () => {
    const { loop, posts, ran } = make();
    expect(await loop.tick()).toBe("ran");
    expect(ran).toEqual(["ui_tree"]);
    expect(posts.at(-1)).toEqual({
      path: "reply",
      body: { id: "c1", result: { ok: true, text: "Notepad" } },
    });
  });

  it("does not poll the hub while remote hands are off, and waits out a hub that does not answer", async () => {
    const off = make({ enabled: false });
    expect(await off.loop.tick()).toBe("off");
    expect(off.posts).toEqual([]);
    const down = make({
      post: async () => {
        throw new Error("down");
      },
    });
    expect(await down.loop.tick()).toBe("away");
    const refused = make({ post: async () => ({ status: 403, json: {} }) });
    expect(await refused.loop.tick()).toBe("away");
  });

  it("answers with the error when a call throws", async () => {
    const posts: unknown[] = [];
    const loop = createRemoteHandsLoop({
      post: async (path, body) => (
        posts.push([path, body]),
        path === "take"
          ? { status: 200, json: { call: { id: "c2", tool: "x", args: {}, session: "s" } } }
          : { status: 200, json: {} }
      ),
      enabled: () => true,
      run: async () => {
        throw new Error("boom");
      },
    });
    await loop.tick();
    expect(posts.at(-1)).toEqual(["reply", { id: "c2", result: { ok: false, error: "boom" } }]);
  });

  it("offers its own hands to the brain only when they change, again after the hub was away, and passes the turn on", async () => {
    const takes: Array<unknown> = [];
    let up = true;
    const origin = { label: "R1", hisVoice: true, member: "owner", assurance: 2, tainted: false };
    const seen: Array<unknown> = [];
    const loop = createRemoteHandsLoop({
      post: async (path, body) => {
        if (!up) throw new Error("down");
        if (path === "take") takes.push(body);
        return path === "take"
          ? {
              status: 200,
              json: {
                call: { id: "c3", tool: "screen_capture", args: {}, session: "turn:R1", origin },
              },
            }
          : { status: 200, json: {} };
      },
      enabled: () => true,
      offered: () => [{ name: "screen_capture", description: "d", input_schema: {} }],
      run: async (call) => (seen.push(call.origin), { ok: true }),
    });
    await loop.tick();
    await loop.tick();
    up = false;
    await loop.tick();
    up = true;
    await loop.tick();
    expect(takes.map((b) => "tools" in (b as object))).toEqual([true, false, true]);
    expect(seen[0]).toEqual(origin);
  });
});
