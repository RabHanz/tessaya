// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.resolve(import.meta.dirname, "../../../scripts/tessaya/guard-private.mjs");

describe("nothing private ships by default", () => {
  it("passes the repository guard that CI also runs (maintainer names, keys, tailnet addresses, private pack phrases)", () => {
    expect(() =>
      NodeChildProcess.execFileSync("node", [SCRIPT], { encoding: "utf8", stdio: "pipe" }),
    ).not.toThrow();
  });
});
