import { describe, expect, it } from "vite-plus/test";

import {
  exportDictionaryCsv,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  importDictionary,
} from "./dictionaryIO.ts";

describe("dictionary import and export", () => {
  it("reads lines, arrows, CSV and JSON, counting what it skipped", () => {
    const lines = importDictionary(
      'Kubernetes\nwisper flow -> Wispr Flow\n"o,k",OK\n' + "x".repeat(61),
    );
    expect(lines.rows).toEqual([
      { phrase: "Kubernetes", replacement: null },
      { phrase: "wisper flow", replacement: "Wispr Flow" },
      { phrase: "o,k", replacement: "OK" },
    ]);
    expect(lines.skipped).toBe(1);
    expect(
      importDictionary('["Tessaya", {"phrase":"tess aya","replacement":"Tessaya"}]').rows,
    ).toHaveLength(2);
    expect(importDictionary("same,same").rows).toEqual([{ phrase: "same", replacement: null }]);
  });
  it("refuses a huge or broken file and keeps at most 1,000 words", () => {
    expect(importDictionary("a".repeat(IMPORT_MAX_BYTES + 1)).refused).toContain("3 MB");
    expect(importDictionary("{nope").refused).toContain("JSON");
    const many = importDictionary(
      Array.from({ length: IMPORT_MAX_ROWS + 5 }, (_, i) => `word${i}`).join("\n"),
    );
    expect(many.rows).toHaveLength(IMPORT_MAX_ROWS);
    expect(many.skipped).toBe(5);
  });
  it("exports what it can import", () => {
    const rows = [
      { phrase: "a, b", replacement: 'say "x"' },
      { phrase: "plain", replacement: null },
    ];
    expect(
      importDictionary(exportDictionaryCsv(rows).replace(/^heard,written\n/, "")).rows,
    ).toEqual(rows);
  });
});
