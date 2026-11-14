/** The providers a computer can run itself (transport 1), in one place for the desktop and the hub's server. */
import {
  claudeHarness,
  codexHarness,
  localProvider,
  type BriefStore,
  type LocalSettings,
  type PendingStore,
} from "./local.ts";
import type { CloudProvider, Exec, ProviderId } from "./types.ts";

export const buildLocalProviders = (
  exec: Exec,
  stores: { readonly store: PendingStore; readonly briefs: BriefStore },
  settings: LocalSettings = {},
): ReadonlyMap<ProviderId, CloudProvider> =>
  new Map<ProviderId, CloudProvider>([
    ["claude", localProvider(claudeHarness(exec, settings), stores.store, stores.briefs)],
    ["codex", localProvider(codexHarness(exec, settings), stores.store, stores.briefs)],
  ]);

/** The hub's optional settings, from BATON_CLOUD_CONFIG (JSON); anything unreadable is the defaults. */
export const settingsFromEnv = (raw: string | undefined): LocalSettings => {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const o = JSON.parse(raw) as { codexEnv?: unknown; codexHomes?: unknown };
    return {
      ...(typeof o.codexEnv === "string" ? { codexEnv: o.codexEnv } : {}),
      ...(typeof o.codexHomes === "object" && o.codexHomes !== null
        ? { codexHomes: o.codexHomes as Record<string, string> }
        : {}),
    };
  } catch {
    return {};
  }
};
