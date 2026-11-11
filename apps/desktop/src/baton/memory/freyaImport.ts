// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Freya's memories (the Agora R1 assistant) come in once through the same doors as everything else. The plan is
 * deleted afterwards so its words are not left on disk; only counts stay.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { MemoryCall } from "./memoryClient.ts";
import type { PrivateCall } from "./privateMemoryClient.ts";

export interface FreyaPlanItem {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly sourceRef: string;
  readonly scopeRef: string | null;
  readonly confidence: number;
  readonly proposed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly store: "owner-general" | "owner-private" | "owner-private-about-person";
}

export interface FreyaImportCounts {
  /** Everyday memories added, merged by memory's door into one he had, already imported, or refused. */
  readonly general: { added: number; merged: number; already: number; refused: number };
  /** Into his private store: added, already there; and of those, how many wait for his yes. */
  readonly private: { added: number; already: number; waiting: number };
}

export const PLAN_FILE = NodePath.join("import", "freya-plan.json");
export const REPORT_FILE = NodePath.join("import", "freya-import-report.json");

export const importFreyaPlan = async (
  items: ReadonlyArray<FreyaPlanItem>,
  deps: { readonly memory: MemoryCall; readonly private: PrivateCall },
): Promise<FreyaImportCounts> => {
  const general = { added: 0, merged: 0, already: 0, refused: 0 };
  const listed = (await deps.memory("list", {
    admin: true,
    includeProposed: true,
    includeSuperseded: true,
    limit: 100_000,
  })) as { items?: ReadonlyArray<{ sourceRef: string | null }> } | null;
  const done = new Set((listed?.items ?? []).map((i) => i.sourceRef));
  for (const item of items.filter((i) => i.store === "owner-general" && !i.proposed)) {
    if (done.has(item.sourceRef)) {
      general.already++;
      continue;
    }
    const kept = (await deps
      .memory("add", {
        kind: item.kind,
        text: item.text,
        source: "import",
        sourceRef: item.sourceRef,
        confidence: item.confidence,
        createdAt: item.createdAt,
      })
      .catch(() => null)) as { item?: { sourceRef: string | null } } | null;
    if (kept?.item === undefined) general.refused++;
    // Memory's door found the same memory already there and strengthened it instead.
    else if (kept.item.sourceRef !== item.sourceRef) general.merged++;
    else general.added++;
  }
  const privately = items.filter((i) => i.store !== "owner-general" || i.proposed);
  const deposited = (await deps.private("deposit", {
    personId: "owner",
    items: privately.map((i) => ({
      id: i.id,
      draft: {
        kind: i.kind,
        text: i.text,
        sourceRef: i.sourceRef,
        about: i.scopeRef,
        confidence: i.confidence,
        proposed: i.proposed,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      },
    })),
  })) as { added: number; skipped: number };
  return {
    general,
    private: {
      added: deposited.added,
      already: deposited.skipped,
      waiting: privately.filter((i) => i.proposed).length,
    },
  };
};

/**
 * Imports a dropped plan, then deletes it and keeps the counts. Without his private store yet, everyday memories go in
 * and the plan waits for the next start; a re-run adds nothing twice.
 */
export const runFreyaImport = async (
  stateDir: string,
  deps: { readonly memory: MemoryCall; readonly private: PrivateCall },
): Promise<FreyaImportCounts | null> => {
  const file = NodePath.join(stateDir, PLAN_FILE);
  if (!NodeFS.existsSync(file)) return null;
  const plan = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
    items?: ReadonlyArray<FreyaPlanItem>;
  };
  const counts = await importFreyaPlan(plan.items ?? [], deps);
  NodeFS.writeFileSync(
    NodePath.join(stateDir, REPORT_FILE),
    JSON.stringify({ at: new Date().toISOString(), ...counts }, null, 1),
  );
  NodeFS.rmSync(file, { force: true });
  return counts;
};
