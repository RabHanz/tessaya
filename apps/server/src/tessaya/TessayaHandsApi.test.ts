import { createHandsBroker } from "@t3tools/tessaya-shared/remoteHands";
import { describe, expect, it } from "vite-plus/test";

import { handleHands, HANDS_HOST_SCOPE, HANDS_SCOPE } from "./TessayaHandsApi.ts";

const broker = () => {
  let n = 0;
  return createHandsBroker({ now: () => 0, newId: () => `c${(n += 1)}`, callTimeoutMs: 2_000 });
};
const asker = {
  method: "POST",
  path: "call",
  scopes: new Set([HANDS_SCOPE]),
  session: "remote-1",
} as const;
const host = { scopes: new Set([HANDS_HOST_SCOPE]), session: "desktop" } as const;

describe("remote hands API", () => {
  it("does nothing for a session without baton:hands, whatever else it holds", async () => {
    const b = broker();
    const r = await handleHands(b, {
      ...asker,
      scopes: new Set(["orchestration:operate", "orchestration:read"]),
      json: { tool: "ui_tree" },
    });
    expect(r.status).toBe(403);
    expect(b.audit()).toEqual([]);
  });

  it("lets only the desktop's session take and answer a call", async () => {
    const b = broker();
    expect((await handleHands(b, { ...asker, path: "take" }, 1)).status).toBe(403);
    // What the desktop offers a brain turn comes only with its own take, and only well-formed.
    expect(
      (await handleHands(b, { method: "POST", path: "take", ...host, json: { tools: "all" } }, 1))
        .status,
    ).toBe(400);
    expect(b.published()).toEqual([]);
    expect(
      (await handleHands(b, { ...asker, path: "reply", json: { id: "c1", result: { ok: true } } }))
        .status,
    ).toBe(403);
    const taking = handleHands(b, { method: "POST", path: "take", ...host }, 500);
    const asking = handleHands(b, { ...asker, json: { tool: "ui_tree", args: {} } });
    const call = (await taking).json["call"] as { id: string; session: string };
    expect(call.session).toBe("remote-1");
    expect(
      (
        await handleHands(b, {
          method: "POST",
          path: "reply",
          ...host,
          json: { id: call.id, result: { ok: true, text: "Notepad" } },
        })
      ).status,
    ).toBe(200);
    expect((await asking).json).toMatchObject({ ok: true, text: "Notepad" });
  });

  it("refuses a raw-coordinate tool and shows the audit to a holder only", async () => {
    const b = broker();
    await handleHands(b, { method: "POST", path: "take", ...host }, 1);
    const r = await handleHands(b, { ...asker, json: { tool: "click", args: { x: 1, y: 2 } } });
    expect(r.json["error"]).toContain("not a remote hands tool");
    const audit = await handleHands(b, {
      method: "GET",
      path: "audit",
      scopes: new Set(["orchestration:read"]),
      session: "x",
    });
    expect(audit.status).toBe(403);
    expect(
      (await handleHands(b, { method: "GET", path: "audit", ...host })).json["entries"],
    ).toHaveLength(1);
  });
});
