// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Commitment } from "@t3tools/tessaya-shared/commitments";
import { describe, expect, it } from "vite-plus/test";

import { createCommitmentStore } from "./commitmentStore.ts";
import { createCommitmentSync } from "./commitmentSync.ts";

const server = (initial: ReadonlyArray<Commitment> = []) => {
  let rows = [...initial];
  return {
    rows: () => rows,
    call: async (op: "list" | "upsert", args: Record<string, unknown>) => {
      if (op === "list") return { items: rows };
      for (const c of (args["items"] as Commitment[]) ?? []) {
        rows = [...rows.filter((r) => r.id !== c.id), c];
      }
      return { applied: 1 };
    },
  };
};
const device = () => {
  let n = 0;
  return createCommitmentStore(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "csync-")),
    () => 1000,
    () => `id${++n}`,
  );
};

describe("the commitments sync", () => {
  it("sends an older file to the server, and a second device receives it", async () => {
    const remote = server();
    const a = device();
    a.add({ text: "check the deploy" });
    expect(await createCommitmentSync({ store: a, call: remote.call }).sync()).toEqual({
      pulled: 0,
      pushed: 1,
    });
    const b = device();
    expect(await createCommitmentSync({ store: b, call: remote.call }).sync()).toEqual({
      pulled: 1,
      pushed: 0,
    });
    expect(b.list().map((c) => c.text)).toEqual(["check the deploy"]);
  });
  it("carries a close from one device to the other", async () => {
    const remote = server();
    const a = device();
    const b = device();
    const c = a.add({ text: "ring back" });
    await createCommitmentSync({ store: a, call: remote.call }).sync();
    await createCommitmentSync({ store: b, call: remote.call }).sync();
    b.close(c.id, "done");
    await createCommitmentSync({ store: b, call: remote.call }).sync();
    await createCommitmentSync({ store: a, call: remote.call }).sync();
    expect(a.list().find((x) => x.id === c.id)?.status).toBe("done");
  });
  it("keeps working from the file when the server does not answer", async () => {
    const a = device();
    a.add({ text: "still here" });
    const sync = createCommitmentSync({
      store: a,
      call: async () => {
        throw new Error("offline");
      },
    });
    expect(await sync.sync()).toBeNull();
    expect(a.list()).toHaveLength(1);
  });
});
