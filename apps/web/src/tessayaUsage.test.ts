import { describe, expect, it } from "vite-plus/test";

import { tessayaUsageSummaries } from "./tessayaUsage";

describe("the limits Tessaya's window shows", () => {
  it("names each window the way the tile does, with when it resets", () => {
    const out = tessayaUsageSummaries([
      {
        box: "orbit",
        providers: [
          {
            instanceId: "claudeAgent_a",
            displayName: "robin",
            enabled: true,
            usageLimits: {
              windows: [
                {
                  kind: "session",
                  label: "5h",
                  usedPercent: 35,
                  resetsAt: "2026-11-01T12:00:00Z",
                },
                { kind: "weekly", label: "7d", usedPercent: 61 },
              ],
            },
          },
          { instanceId: "codex", enabled: true },
          {
            instanceId: "off",
            enabled: false,
            usageLimits: { windows: [{ kind: "weekly", label: "7d", usedPercent: 1 }] },
          },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        account: "robin",
        box: "orbit",
        boxes: ["orbit"],
        windows: [
          { label: "Session", usedPercent: 35, resetsAt: "2026-11-01T12:00:00Z" },
          { label: "Week", usedPercent: 61, resetsAt: null },
        ],
      },
    ]);
  });

  const login = (over: Record<string, unknown> = {}) => ({
    instanceId: "claudeAgent",
    driver: "claudeAgent" as never,
    displayName: "robin",
    enabled: true,
    auth: { email: "robin@example.com" },
    usageLimits: {
      checkedAt: "2026-11-01T10:00:00Z",
      windows: [{ kind: "weekly" as const, label: "7d", usedPercent: 40 }],
    },
    ...over,
  });

  it("shows one row for a login on two machines, from the freshest reading", () => {
    const out = tessayaUsageSummaries([
      { box: "onyx", providers: [login()] },
      {
        box: "sablebox-prod",
        providers: [
          login({
            displayName: "Robin",
            usageLimits: {
              checkedAt: "2026-11-01T11:00:00Z",
              windows: [
                { kind: "session", label: "5h", usedPercent: 12 },
                { kind: "weekly", label: "7d", usedPercent: 44 },
              ],
            },
          }),
        ],
      },
    ]);
    expect(out).toEqual([
      {
        account: "robin",
        box: "onyx + sablebox-prod",
        boxes: ["onyx", "sablebox-prod"],
        windows: [
          { label: "Week", usedPercent: 44, resetsAt: null },
          { label: "Session", usedPercent: 12, resetsAt: null },
        ],
      },
    ]);
  });

  it("keeps two logins apart, and takes the higher percent when no time is given", () => {
    const noTime = (p: number) => ({
      windows: [{ kind: "weekly" as const, label: "7d", usedPercent: p }],
    });
    const out = tessayaUsageSummaries([
      {
        box: "a",
        providers: [
          login({ usageLimits: noTime(30) }),
          login({ displayName: "other", auth: { email: "o@example.com" }, usageLimits: noTime(5) }),
        ],
      },
      { box: "b", providers: [login({ usageLimits: noTime(55) })] },
    ]);
    expect(out.map((r) => [r.account, r.boxes, r.windows[0]!.usedPercent])).toEqual([
      ["robin", ["a", "b"], 55],
      ["other", ["a"], 5],
    ]);
  });
});
