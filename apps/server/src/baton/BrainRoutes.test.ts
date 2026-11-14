// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * Every place Tessaya reaches a model, and how it asks the brain's routing table (BRAIN-DESIGN §13.4). A new file that
 * calls a model, names a model id or spawns `claude --model` fails here until it is listed: routed through the table,
 * or excluded with the reason.
 */
const ROOT = NodePath.resolve(import.meta.dirname, "../../../..");
const SCANNED = ["apps/server/src", "apps/desktop/src/baton", "packages/baton-shared/src"];
const REACHES_A_MODEL =
  /api\.anthropic\.com|"--model"|claude-(?:haiku|sonnet|opus)-\d|readRouting\(|\.cheap\b|\bBatonOneShot\b|\bDictationCleanupApi\b/;
/** What a routed file must contain: it asks the table, or names its role to a service that does. */
const ASKS_THE_TABLE =
  /\b(?:routeFor|brainRoute|onSubscription|keyRefusal)\(|role: "(?:cleanup|voice|deep|background|consolidation|web|vision|intent|synopsis)"|\.cleanup\(/;

type Site =
  | { readonly table: string }
  | { readonly routed: string }
  | { readonly wiring: string }
  | { readonly pending: string }
  | { readonly excluded: string };

const SITES: Readonly<Record<string, Site>> = {
  // The table itself and the one place each credential is spent.
  "packages/baton-shared/src/brainRoutes.ts": {
    table: "the rows, their defaults and the spend guard",
  },
  "apps/server/src/baton/BrainRoutes.ts": { routed: "reads the table on the server" },
  "apps/server/src/speech/DictationCleanupApi.ts": {
    routed: "the API key: every call names a role and is refused off the key's roles",
  },
  "apps/server/src/baton/BatonOneShot.ts": {
    routed: "the subscription one-shot: the role picks the model",
  },
  // Callers.
  "apps/server/src/home/R1Brain.ts": { routed: "spoken turns: the voice row" },
  "apps/server/src/home/VoiceSessions.ts": {
    wiring: "the warm subscription sessions run the model R1Brain reads from the voice row",
  },
  "apps/server/src/home/DeviceTriggers.ts": {
    routed: "judging a natural-language device rule: the intent row",
  },
  "apps/server/src/home/R1Device.ts": { routed: "the Agora path's one-shot: the voice row" },
  "apps/server/src/baton/TessayaExpression.ts": {
    routed: "her lines written ahead are persona speech: the voice row",
  },
  "apps/server/src/baton/BatonMemoryLearning.ts": {
    routed: "learning and episodes: the background row",
  },
  "apps/server/src/baton/IntentInterpreter.ts": { routed: "reading a sentence: the intent row" },
  "apps/server/src/baton/SynopsisReactor.ts": {
    routed: "a work session's synopsis: the synopsis row",
  },
  "apps/server/src/baton/BatonJobFlow.ts": { routed: "a job's routine parts: the background row" },
  "apps/server/src/baton/BatonPlaybook.ts": {
    routed: "a job template's playbook: the background row",
  },
  "apps/server/src/tessaya/PromptLab.ts": {
    routed: "the prompt lab: the voice row, on each model he chose to compare",
  },
  "apps/server/src/baton/BatonMemoryReactor.ts": {
    wiring: "carries the one-shot service to the learning it starts",
  },
  "apps/server/src/baton/BatonRpcHandlers.ts": {
    routed: "dictation cleanup over RPC: the cleanup row",
  },
  "apps/server/src/speech/http.ts": { wiring: "the key's status and test only, no model call" },
  "packages/baton-shared/src/costRouting.ts": {
    table: "routing.json's cheap model, read only to fill the background row's default",
  },
  // Layer wiring, no model call.
  "apps/server/src/baton/BatonServerLayer.ts": { wiring: "builds the services" },
  "apps/server/src/server.ts": { wiring: "builds the services" },
  // The desktop reads the table in B1c (BRAIN-DESIGN §13.5).
  "apps/desktop/src/baton/screen/claudeVision.ts": {
    pending: "B1c: the desktop's sessions take the table's model",
  },
  "apps/desktop/src/baton/screen/ScreenCompanion.ts": {
    pending: "B1c: the desktop reads the table, not routing.json",
  },
  // Not Tessaya's brain.
  "apps/server/src/baton/BatonPhoneVoice.ts": {
    excluded: "speech recognition's model file, not a language model",
  },
  "apps/server/src/baton/BatonSessionCatalogService.ts": {
    excluded: "work sessions run on the member's own provider (ACCOUNTS-IDENTITY §9.5)",
  },
  "apps/server/src/cli/triage.ts": { excluded: "T3's triage command runs the CLI the user picks" },
  "apps/server/src/provider/ClaudeModelCatalog.ts": { excluded: "T3's provider model list" },
  "apps/server/src/provider/claudeResetCredits.ts": { excluded: "T3's provider usage" },
  "apps/server/src/provider/Drivers/antigravityUsageReader.ts": { excluded: "T3's provider usage" },
  "apps/server/src/provider/Drivers/ClaudeSkills.ts": { excluded: "T3's provider driver" },
  "apps/server/src/telemetry/ProviderDimensions.ts": { excluded: "T3's telemetry labels" },
  "apps/server/src/textGeneration/ClaudeTextGeneration.ts": {
    excluded: "T3's titles and commit messages",
  },
  "apps/server/src/textGeneration/CodexTextGeneration.ts": {
    excluded: "T3's titles and commit messages",
  },
  "apps/server/src/usage/cliproxyApi.ts": { excluded: "T3's usage proxy" },
};

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(NodePath.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory())
      return entry.name === "testkit" || entry.name === "fixtures" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

describe("every model call goes through the brain's routing table", () => {
  const reaching = SCANNED.flatMap(sourceFiles).filter((path) =>
    REACHES_A_MODEL.test(NodeFS.readFileSync(NodePath.join(ROOT, path), "utf8")),
  );

  it("lists every file that reaches a model", () => {
    expect(reaching.filter((path) => SITES[path] === undefined)).toEqual([]);
  });

  it("has every routed file ask the table", () => {
    const silent = Object.entries(SITES)
      .filter(([, site]) => "routed" in site)
      .map(([path]) => path)
      .filter(
        (path) => !ASKS_THE_TABLE.test(NodeFS.readFileSync(NodePath.join(ROOT, path), "utf8")),
      );
    expect(silent).toEqual([]);
  });

  it("keeps no stale entries", () => {
    expect(Object.keys(SITES).filter((path) => !reaching.includes(path))).toEqual([]);
  });
});
