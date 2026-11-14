import type { TessayaFleet } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { fleetForOutside } from "./fleetForOutside.ts";
import { DEFAULT_OS_PACK } from "./osPack.ts";

const said = "the deploy key is hunter2";
const fleet = {
  observedAt: "2026-11-07T10:00:00.000Z",
  entries: [
    {
      workSessionId: "w1",
      title: "Rotate the payroll keys",
      projectId: "p-secret",
      lifecycle: "active",
      state: "running",
      needsUser: false,
      activeThreadId: "t1",
      threads: [
        {
          threadId: "t1",
          title: "Rotate the payroll keys",
          state: "running",
          providerInstanceId: null,
          providerDriver: null,
          branch: "fix/payroll",
          worktreePath: "/home/dev/payroll",
          lastActivityAt: null,
        },
      ],
      adopted: [],
      synopsis: { goal: said, currentAction: said, recentFindings: [], next: [said] },
      updatedAt: "2026-11-07T10:00:00.000Z",
    },
    {
      workSessionId: "w2",
      title: "Tidy the README",
      projectId: "p-shop",
      lifecycle: "active",
      state: "idle",
      needsUser: false,
      activeThreadId: null,
      threads: [],
      adopted: [],
      synopsis: { goal: said },
      updatedAt: "2026-11-07T10:00:00.000Z",
    },
  ],
  herdr: [
    {
      label: "payroll pane",
      project: { key: "dir:payroll", label: "Payroll" },
      blockedPrompt: said,
      cwd: "/home/dev/payroll",
      foreground: said,
    },
  ],
  claudeSessions: [
    {
      sessionId: "s1",
      cwd: "/home/dev/payroll",
      name: "keys",
      project: { key: "dir:payroll", label: "Payroll" },
      configDir: "/home/dev/.claude-work",
      account: "alex@example.com",
    },
  ],
} as unknown as TessayaFleet;

describe("the fleet an outside agent reads", () => {
  it("carries no words that were said, no folders, no account, and a walled project's work only by its project's name", () => {
    const pack = { ...DEFAULT_OS_PACK, walled: ["Payroll"] };
    const titles: Record<string, string> = { "p-secret": "Payroll", "p-shop": "Shop" };
    const out = fleetForOutside(fleet, pack, (id) => titles[id] ?? null);
    const text = JSON.stringify(out);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("/home/dev");
    expect(text).not.toContain("Rotate the payroll keys");
    expect(text).not.toContain("fix/payroll");
    expect(text).not.toContain("payroll pane");
    expect(text).not.toContain('keys"');
    // Account names are personal.
    expect(text).not.toContain("alex@example.com");
    expect(out.entries.map((e) => e.title)).toEqual(["Payroll", "Tidy the README"]);
    expect(out.entries.map((e) => e.state)).toEqual(["running", "idle"]);
  });
  it("gives a linked server of his each entry's project and account, and keeps the Claude account, still saying nothing", () => {
    const out = fleetForOutside(fleet, DEFAULT_OS_PACK, () => null, {
      project: (id) => (id === "p-shop" ? { key: "github.com/x/shop", label: "Shop" } : null),
      account: (entry) => (entry.workSessionId === "w2" ? "Work Max" : null),
    });
    expect(out.entries.map((e) => [e.project?.label ?? null, e.account])).toEqual([
      [null, null],
      ["Shop", "Work Max"],
    ]);
    expect(out.claudeSessions?.[0]?.account).toBe("alex@example.com");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });
});
