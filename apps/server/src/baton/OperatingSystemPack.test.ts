// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import { describe, expect, it } from "vite-plus/test";

import { planningFrame, readPack } from "./OperatingSystemPack.ts";

describe("reading the user's own pack", () => {
  it("is the neutral default with no folder, and the user's files win by name when there is one", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-pack-"));
    expect(readPack(dir)).toEqual(DEFAULT_OS_PACK);
    const pack = NodePath.join(dir, "operating-system");
    NodeFS.mkdirSync(NodePath.join(pack, "roles"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(pack, "executive.md"), "Their way.");
    NodeFS.writeFileSync(NodePath.join(pack, "roles", "research.md"), "Their researcher.");
    NodeFS.writeFileSync(NodePath.join(pack, "roles", "notes.txt"), "ignored");
    const read = readPack(dir);
    expect(read.executive).toBe("Their way.");
    expect(read.roles["research"]).toBe("Their researcher.");
    expect(read.roles["engineering"]).toBe(DEFAULT_OS_PACK.roles["engineering"]);
    expect(planningFrame(dir)).toContain("Their way.");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
