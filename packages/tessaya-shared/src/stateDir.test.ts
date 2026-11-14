// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { stateFile, stateSubdir } from "./stateDir.ts";

const home = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "state-"));
const put = (path: string, at: number) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "x");
  NodeFS.utimesSync(path, at, at);
};

describe("state dir fallback", () => {
  it("files: newest wins, new path when neither exists", () => {
    const h = home();
    expect(stateFile(h, "a.json")).toBe(NodePath.join(h, ".t3", "tessaya", "a.json"));
    put(NodePath.join(h, ".t3", "baton", "a.json"), 100);
    expect(stateFile(h, "a.json")).toBe(NodePath.join(h, ".t3", "baton", "a.json"));
    put(NodePath.join(h, ".t3", "tessaya", "a.json"), 50);
    expect(stateFile(h, "a.json")).toBe(NodePath.join(h, ".t3", "baton", "a.json"));
    put(NodePath.join(h, ".t3", "tessaya", "a.json"), 200);
    expect(stateFile(h, "a.json")).toBe(NodePath.join(h, ".t3", "tessaya", "a.json"));
  });
  it("directories: legacy until the new one exists", () => {
    const h = home();
    put(NodePath.join(h, ".t3", "baton", "q", "1.json"), 1);
    expect(stateSubdir(h, "q")).toBe(NodePath.join(h, ".t3", "baton", "q"));
    NodeFS.mkdirSync(NodePath.join(h, ".t3", "tessaya", "q"), { recursive: true });
    expect(stateSubdir(h, "q")).toBe(NodePath.join(h, ".t3", "tessaya", "q"));
  });
});
