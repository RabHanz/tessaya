// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { tessayaTargetOf } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DOC_FEATURES,
  DOC_LESSONS,
  helpAnswer,
  lessonDone,
  parseFeatures,
  searchDocs,
} from "./docs.ts";
import { DOCS_FEATURES_MD, DOCS_LESSONS_MD } from "./docsBundle.data.ts";

const page = (name: string) =>
  NodeFS.readFileSync(new URL(`../../../docs/user/${name}`, import.meta.url), "utf8");

describe("Help docs", () => {
  it("ships the docs/user pages as they are (run scripts/tessaya/docs-bundle.mjs after editing them)", () => {
    expect(DOCS_FEATURES_MD).toBe(page("tessaya-features.md"));
    expect(DOCS_LESSONS_MD).toBe(page("tessaya-lessons.md"));
  });

  it("gives every feature a unique id, a page Tessaya's window opens, and a guide that exists", () => {
    expect(DOC_FEATURES.length).toBeGreaterThan(40);
    expect(new Set(DOC_FEATURES.map((f) => f.id)).size).toBe(DOC_FEATURES.length);
    for (const f of DOC_FEATURES) {
      expect(tessayaTargetOf(f.place), f.id).not.toBeNull();
      expect(f.lead.length, f.id).toBeGreaterThan(0);
      if (f.guide !== null) expect(() => page(f.guide!.split("#")[0]!), f.id).not.toThrow();
    }
  });

  it("names a real feature in every lesson step, each with a phrase to say", () => {
    const ids = new Set(DOC_FEATURES.map((f) => f.id));
    expect(DOC_LESSONS.map((l) => l.id)).toEqual(["first", "tessel", "yours", "home", "work"]);
    for (const step of DOC_LESSONS.flatMap((l) => l.steps)) {
      expect(ids.has(step.feature), step.feature).toBe(true);
      expect(step.say.length).toBeGreaterThan(0);
    }
    // the first lesson: wake (Settings, voice), dictation, jobs, approvals
    expect(lessonDone(DOC_LESSONS[0]!, ["voice", "jobs"])).toEqual([true, false, true, false]);
  });

  it("keeps the old hardware name out of what people read", () => {
    expect(DOCS_FEATURES_MD + DOCS_LESSONS_MD).not.toMatch(/\bR1\b|rabbit/i);
  });

  it("refuses a feature with an unknown area instead of hiding it", () => {
    expect(() =>
      parseFeatures(
        "## X\n<!-- id: x | status: live | area: nowhere | on: web | for: new -->\nHi\n",
      ),
    ).toThrow(/unknown value/);
  });

  it("finds the feature a question is about, and says when nothing covers it", () => {
    expect(searchDocs(DOC_FEATURES, "how do I insert my address")[0]?.id).toBe("snippets");
    expect(searchDocs(DOC_FEATURES, "pair my phone")[0]?.id).toBe("phone");
    expect(searchDocs(DOC_FEATURES, "wake me up tomorrow")[0]?.id).toBe("alarms");
    expect(helpAnswer("insert my address")).toContain("## Snippets (Live; page: snippets)");
    expect(helpAnswer("quantum knitting")).toMatch(/^Nothing in Tessaya's help covers that/);
  });
});
