// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { APP_SCRIPT } from "./appScript.ts";
import { fill, STRINGS, tableFor, text } from "./strings.ts";
import { SETTINGS, TABS } from "./tabs.ts";

const read = (relative: string) => NodeFS.readFileSync(new URL(relative, import.meta.url), "utf8");

describe("the window's words", () => {
  it("has English for every page, introduction and dialog the script names", () => {
    const en = STRINGS.en;
    for (const { id } of TABS) expect(en[`tab.${id}`], `tab.${id}`).toBeTruthy();
    for (const { id } of SETTINGS) expect(en[`cat.${id}`], `cat.${id}`).toBeTruthy();
    for (const id of ["now", "trust", "help", "sessions", "jobs"]) {
      expect(en[`intro.${id}.title`], id).toBeTruthy();
      expect(en[`intro.${id}.text`], id).toBeTruthy();
    }
    // A key ending in a dot is a prefix the script completes (tab.<id>), checked above.
    const used = [...APP_SCRIPT.matchAll(/\bL\('([a-z][a-z0-9.]*)'/g)]
      .map((m) => m[1]!)
      .filter((key) => !key.endsWith("."));
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((key) => en[key] === undefined)).toEqual([]);
  });

  it("falls back to English for a language or a key that is not there, and fills gaps", () => {
    expect(tableFor("fr")).toEqual(STRINGS.en);
    expect(text("wizard.back", {}, "fr")).toBe("Back");
    expect(text("no.such.key")).toBe("no.such.key");
    expect(text("wizard.step", { n: 2, total: 7 })).toBe("Step 2 of 7");
    expect(fill("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });

  it("puts the table into the page without anything that could end the script early", () => {
    expect(APP_SCRIPT.slice(0, 20)).toContain("const STR = {");
    expect(JSON.stringify(STRINGS.en)).not.toMatch(/<\/script|`|\$\{/);
  });

  // A page that has been moved over keeps its words in the table. Add a file to this list when you
  // move it; a new page starts here.
  const MOVED = [
    "../backup/backupRows.ts",
    "../setup/firstRun.ts",
    "../cloud/cloudRows.ts",
    "../memory/privateRows.ts",
    "../memory/privateTab.ts",
    "../memory/householdTab.ts",
  ];
  it.each(MOVED)("%s has no user-facing text of its own", (file) => {
    const source = read(file);
    const literal =
      /\b(?:label|hint|detail|button|secondary|title|text|section|placeholder):\s*(?:"[^"]*[A-Za-z]{3}[^"]*"|`[^`]*[A-Za-z]{3}[^`]*`)/g;
    expect([...source.matchAll(literal)].map((m) => m[0])).toEqual([]);
  });

  // The page script still has text written into it. That number may only go down: when you move
  // some into strings.ts, lower it.
  it("does not grow the text written straight into the page script", () => {
    const body = APP_SCRIPT.slice(APP_SCRIPT.indexOf("const real"));
    const made = [
      ...body.matchAll(
        /\$\(\s*'[a-z0-9]+'\s*,\s*(?:'[^']*'|null)\s*,\s*'([^']*[A-Za-z]{3}[^']*)'\s*\)/g,
      ),
    ].length;
    const set = [
      ...body.matchAll(/(?:placeholder|title|textContent)\s*=\s*'([^']*[A-Za-z]{3}[^']*)'/g),
    ].length;
    expect(made).toBeLessThanOrEqual(90);
    expect(set).toBeLessThanOrEqual(12);
  });
});
