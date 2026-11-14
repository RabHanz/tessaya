// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { ruleRoute } from "../test/intentRoute.ts";

const rows = JSON.parse(
  NodeFS.readFileSync(new URL("../test/fixtures/utterances.json", import.meta.url), "utf8"),
) as ReadonlyArray<{
  say: string;
  tag: string;
  rule: string;
  assistant: string | null;
}>;

/**
 * Labelled sentences of the kind he actually says. The model is stubbed out, so this pins the cheap
 * rule layer: when a rule changes what a sentence does, a row here changes with it and says so.
 */
describe("intent quality", () => {
  it("is a real spread of what he says", () => {
    expect(rows.length).toBeGreaterThanOrEqual(200);
    expect(new Set(rows.map((r) => r.say.toLowerCase())).size).toBe(rows.length);
    for (const tag of [
      "dismissal",
      "near-miss ask",
      "status",
      "high risk",
      "answer",
      "dictation trigger",
    ]) {
      expect(rows.filter((r) => r.tag === tag).length).toBeGreaterThanOrEqual(10);
    }
  });

  it("sends every sentence where its label says, without a model", async () => {
    const wrong: string[] = [];
    for (const r of rows) {
      const got = await ruleRoute(r.say);
      if (got !== r.rule) wrong.push(`"${r.say}": expected ${r.rule}, got ${got}`);
    }
    expect(wrong).toEqual([]);
  });

  it("never lets a dismissal word swallow a real ask, and no rule runs a risky order past One Trust", async () => {
    for (const r of rows.filter((x) => x.tag === "near-miss ask")) {
      expect(["cancel", "dismiss"]).not.toContain(await ruleRoute(r.say));
    }
    for (const r of rows.filter((x) => x.tag === "high risk" && x.assistant === "refused")) {
      expect(await ruleRoute(r.say)).toBe("model");
    }
  });
});
