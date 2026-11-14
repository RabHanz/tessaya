// @effect-diagnostics globalTimers:off globalDate:off
/** Sample catalog rows and an in-memory catalog service, for page-state tests and proof recordings only. */
import type { CatalogRow, CatalogService, CatalogState } from "./catalogRows.ts";

export const sampleCatalogRows = (now: number): CatalogRow[] => {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  return [
    ["laptop", "Laptop", "C:\\work\\tessaya", "Wire the sessions browser", 4, "running"],
    ["laptop", "Laptop", "C:\\work\\notes", "Write the launch post", 190, "stopped"],
    ["server", "Build server", "/srv/digest-bot", "Fix the weekly digest", 60 * 30, "stopped"],
    ["server", "Build server", "/srv/baton", "Teach mode quality set", 12, "running"],
    ["server", "Build server", "/srv/old-site", "Old landing page", 60 * 24 * 12, "stopped"],
  ].map(([env, machine, cwd, title, min, state], i) => ({
    id: `s${i}`,
    sessionId: `s${i}`,
    detail: null,
    environmentId: String(env),
    machine: String(machine),
    project: String(cwd).split(/[\\/]/).at(-1) ?? "",
    cwd: String(cwd),
    title: String(title),
    lastActivityAt: ago(Number(min)),
    account: i % 2 === 0 ? "a@example.com" : null,
    state: state as CatalogState,
    source: i === 4 ? ("history" as const) : ("thread" as const),
    canResume: true,
  }));
};

export const mockCatalogService = (): CatalogService => {
  let rows = sampleCatalogRows(Date.now());
  return {
    list: async () => rows,
    resume: async (row) => {
      await new Promise((r) => setTimeout(r, 1500));
      rows = rows.map((x) => (x.id === row.id ? { ...x, state: "running" } : x));
    },
    create: async ({ environmentId, cwd }) => {
      rows = [
        {
          id: `n${rows.length}`,
          sessionId: `n${rows.length}`,
          detail: null,
          environmentId,
          machine: rows.find((r) => r.environmentId === environmentId)?.machine ?? environmentId,
          project: cwd.split(/[\\/]/).at(-1) ?? cwd,
          cwd,
          title: "New session",
          lastActivityAt: new Date().toISOString(),
          account: null,
          state: "running",
          source: "thread",
          canResume: true,
        },
        ...rows,
      ];
    },
    folders: async (environmentId) => [
      ...new Set(rows.filter((r) => r.environmentId === environmentId).map((r) => r.cwd)),
    ],
    open: () => undefined,
  };
};
