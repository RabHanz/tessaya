import { describe, expect, it } from "vite-plus/test";

import { homeOf, resolveRunOn } from "./runOn.ts";

const targets = [
  { id: "e1", label: "Desk" },
  { id: "e2", label: "sablebox" },
  { id: "e3", label: "orbit" },
];

describe("run on", () => {
  it("means this computer when nothing, or 'here', is said", () => {
    expect(resolveRunOn("", targets, "e1")).toEqual({ ok: true, id: "e1", label: "Desk" });
    expect(resolveRunOn("This computer", targets, "e1")).toMatchObject({ ok: true, id: "e1" });
  });
  it("finds a connected server by name, loosely", () => {
    expect(resolveRunOn("sablebox", targets, "e1")).toEqual({
      ok: true,
      id: "e2",
      label: "sablebox",
    });
    expect(resolveRunOn("  ORBIT ", targets, "e1")).toMatchObject({ ok: true, id: "e3" });
    expect(resolveRunOn("sable", targets, "e1")).toMatchObject({ ok: true, id: "e2" });
  });
  it("says which are connected when the name matches none", () => {
    const r = resolveRunOn("mars", targets, "e1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("Connected: Desk, sablebox, orbit");
  });
  it("asks the server a job was started on", () => {
    const homes = new Map([["job-1", "e2"]]);
    expect(homeOf("job-1", homes, "e1")).toBe("e2");
    expect(homeOf("job-2", homes, "e1")).toBe("e1");
  });
});
