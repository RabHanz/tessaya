// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { beginStart, EMPTY_GUARD, markHealthy } from "@t3tools/tessaya-shared/startGuard";
import { describe, expect, it } from "vite-plus/test";

import { readGuard, writeGuard } from "./startGuardFile.ts";

describe("the start guard file", () => {
  it("survives a restart, and a damaged file is no guard rather than a failure", () => {
    const file = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "guard-")),
      "g.json",
    );
    expect(readGuard(file)).toEqual(EMPTY_GUARD);
    const f = markHealthy(beginStart(EMPTY_GUARD, "0.1.34", false).file);
    writeGuard(file, f);
    expect(readGuard(file).lastGood).toBe("0.1.34");
    NodeFS.writeFileSync(file, "{broken");
    expect(readGuard(file)).toEqual(EMPTY_GUARD);
  });
});
