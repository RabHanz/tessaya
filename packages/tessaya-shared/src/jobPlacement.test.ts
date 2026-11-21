import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { tessayaProjectKey, handoffTarget, placeJob, projectsNamed } from "./jobPlacement.ts";

const provider = (instanceId: string, driver: string, extra: Record<string, unknown> = {}) =>
  ({
    instanceId,
    driver,
    displayName: instanceId === "codex" ? "Codex" : undefined,
    enabled: true,
    status: "ready",
    availability: "available",
    models: [
      { slug: "small", name: "Small" },
      { slug: "big", name: "Big", isDefault: true },
    ],
    ...extra,
  }) as unknown as ServerProvider;

const projects = [
  { id: "p1", title: "Shop", workspaceRoot: "/w/shop-site", repositoryIdentity: null },
  {
    id: "p2",
    title: "Api",
    workspaceRoot: "/w/api",
    repositoryIdentity: { canonicalKey: "github.com/o/api", name: "api-server" },
  },
];

describe("placing a job from his words", () => {
  it("finds the project he means by a spoken name: words, run-together letters, one slip; two fits ask", () => {
    const mine = [
      ...projects,
      { id: "p3", title: "The Margin", workspaceRoot: "/w/the-margin", repositoryIdentity: null },
      { id: "p4", title: "Lakehouse", workspaceRoot: "/w/LakeHouse", repositoryIdentity: null },
      { id: "p5", title: "Cart", workspaceRoot: "/w/cart", repositoryIdentity: null },
      { id: "p6", title: "Card", workspaceRoot: "/w/card", repositoryIdentity: null },
    ];
    const ids = (said: string) => projectsNamed(said, mine).map((p) => p.id);
    const rows: Array<[string, Array<string>]> = [
      ["margin", ["p3"]],
      ["the margin project", ["p3"]],
      ["The-Margin.", ["p3"]],
      ["lake house", ["p4"]],
      ["lakhouse", ["p4"]],
      ["shop site", ["p1"]],
      ["shopsite", ["p1"]],
      ["api server", ["p2"]],
      // Too short for a slip, and an exact name beats a near one.
      ["cart", ["p5"]],
      ["car", []],
      ["carts", ["p5"]],
      ["carx", ["p5", "p6"]],
      ["weather", []],
    ];
    for (const [said, want] of rows) expect(ids(said), said).toEqual(want);
    expect(placeJob("carx", mine, [provider("claudeAgent", "claudeAgent")])).toEqual({
      ok: false,
      why: '"carx" could be cart or card. Ask him which.',
    });
  });

  it("finds the project by its name or title, and the first ready Claude on its default model", () => {
    const providers = [
      provider("claudeAgent_off", "claudeAgent", { status: "error" }),
      provider("codex", "codex"),
      provider("claudeAgent", "claudeAgent"),
    ];
    const placed = placeJob("API-server", projects, providers);
    expect(placed.ok && [placed.value.project.id, placed.value.label, placed.value.worker]).toEqual(
      [
        "p2",
        "api-server",
        { instanceId: "claudeAgent", label: "claudeAgent", driver: "claudeAgent", model: "big" },
      ],
    );
    expect(placeJob("shop", projects, providers).ok).toBe(true);
    expect(tessayaProjectKey(projects[0]!)).toEqual({ key: "dir:shop-site", label: "shop-site" });
  });

  it("says what is there when the project or a worker is missing", () => {
    expect(placeJob("nope", projects, [provider("claudeAgent", "claudeAgent")])).toEqual({
      ok: false,
      why: 'No project is called "nope". Projects: shop-site, api-server.',
    });
    expect(placeJob("shop", projects, [provider("codex", "codex")])).toEqual({
      ok: false,
      why: "No signed-in Claude is ready to be the worker.",
    });
  });

  it("puts the job on the worker he named, by its kind when no name fits", () => {
    const providers = [provider("claudeAgent", "claudeAgent"), provider("codex_work", "codex")];
    const placed = placeJob("shop", projects, providers, "Codex");
    expect(placed.ok && placed.value.worker.instanceId).toBe("codex_work");
    expect(placeJob("shop", projects, providers, "gemini")).toMatchObject({ ok: false });
  });

  it("hands off to the worker named by id or name, and lists the ready ones when none matches", () => {
    const providers = [provider("codex", "codex"), provider("claudeAgent", "claudeAgent")];
    expect(handoffTarget("codex", providers)).toMatchObject({ ok: true, value: { model: "big" } });
    expect(handoffTarget("gemini", providers)).toEqual({
      ok: false,
      why: 'No worker is called "gemini". Ready: Codex, claudeAgent.',
    });
  });
});
