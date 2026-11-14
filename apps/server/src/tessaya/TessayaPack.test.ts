// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { packHash } from "@t3tools/tessaya-shared/packSync";
import { expect, it } from "vite-plus/test";

import { acceptPackPush, readPackFiles } from "./TessayaPack.ts";

it("takes a push only over the copy the pusher last saw, and serves only the files that sync", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pack-"));
  try {
    expect(acceptPackPush(dir, "roles/nova.md", "v1", null)).toEqual({ ok: true });
    // Changed at the home since the pusher's base: refused, so nothing made there is lost.
    expect(acceptPackPush(dir, "roles/nova.md", "v2", packHash("v0"))).toEqual({
      refused: "The home's copy changed; it comes back on the next sync.",
    });
    expect(acceptPackPush(dir, "roles/nova.md", "v2", packHash("v1"))).toEqual({ ok: true });
    expect(acceptPackPush(dir, "wake-models.json", "{}", null)).toEqual({
      refused: "That file is not part of the pack.",
    });
    NodeFS.mkdirSync(NodePath.join(dir, "skills"));
    NodeFS.writeFileSync(NodePath.join(dir, "skills", "draft.md"), "draft");
    NodeFS.writeFileSync(NodePath.join(dir, ".sync-base.json"), "{}");
    expect(readPackFiles(dir)).toEqual({ "roles/nova.md": "v2" });
    expect(acceptPackPush(dir, "roles/nova.md", null, packHash("v2"))).toEqual({ ok: true });
    expect(readPackFiles(dir)).toEqual({});
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
