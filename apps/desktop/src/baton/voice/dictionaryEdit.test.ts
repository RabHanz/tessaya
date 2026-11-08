// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { readSettings } from "./DesktopBatonVoice.ts";
import {
  addEntry,
  editEntry,
  forgetLearned,
  removeEntry,
  saveDictionary,
} from "./dictionaryEdit.ts";
import { dictionaryPath, importWispr, readDictionary } from "./dictationRewriter.ts";

describe("the vocabulary", () => {
  it("adds a word, keeps one entry per phrase, and ignores an empty one", () => {
    const one = addEntry([], { phrase: " venture os ", replacement: "VantageOS" });
    expect(one).toEqual([{ phrase: "venture os", replacement: "VantageOS", source: "added" }]);
    const two = addEntry(one, { phrase: "Venture OS", replacement: "" });
    expect(two).toEqual([{ phrase: "Venture OS", replacement: null, source: "added" }]);
    expect(addEntry(two, { phrase: "  ", replacement: "x" })).toBe(two);
  });
  it("removes a word whatever its capitals", () => {
    expect(removeEntry([{ phrase: "Airdeck", replacement: null }], "airdeck")).toEqual([]);
  });
  it("edits a word and keeps what was learned about it", () => {
    const list = [
      {
        phrase: "airdeck",
        replacement: null,
        source: "learned" as const,
        count: 7,
        lastSeen: "2026-11-01T09:00:00Z",
      },
    ];
    expect(editEntry(list, "Airdeck", { phrase: "airdeck", replacement: "Airdeck" })).toEqual([
      {
        phrase: "airdeck",
        replacement: "Airdeck",
        source: "learned",
        count: 7,
        lastSeen: "2026-11-01T09:00:00Z",
      },
    ]);
    expect(editEntry(list, "missing", { phrase: "x", replacement: null })).toBe(list);
  });
  it("forgets what Tessaya learned and keeps what he added", () => {
    const list = [
      { phrase: "a", replacement: null, source: "learned" as const },
      { phrase: "b", replacement: "B", source: "added" as const },
      { phrase: "c", replacement: null },
    ];
    expect(forgetLearned(list).map((e) => e.phrase)).toEqual(["b", "c"]);
  });
  it("never takes a damaged file for an empty list: it keeps it aside and keeps the words it had", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vocab-"));
    const had = [{ phrase: "airdeck", replacement: "Airdeck" }];
    saveDictionary(dir, had);
    const read = readDictionary(dir, []);
    expect(read.map((e) => e.replacement)).toEqual(["Airdeck"]);
    // One stray comma from a hand edit.
    NodeFS.writeFileSync(dictionaryPath(dir), '[{"phrase":"airdeck","replacement":"Airdeck"},]');
    expect(readDictionary(dir, read)).toEqual(read);
    expect(NodeFS.existsSync(`${dictionaryPath(dir)}.bad`)).toBe(true);

    const settings = NodePath.join(dir, "fabric-voice.json");
    NodeFS.writeFileSync(settings, '{"holdKey":"F9",');
    readSettings(settings);
    expect(NodeFS.readFileSync(`${settings}.bad`, "utf8")).toBe('{"holdKey":"F9",');
  });

  it("reads Wispr's table once, read-only: heard forms onto his words, snippets to his snippets", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const appData = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wispr-"));
    NodeFS.mkdirSync(NodePath.join(appData, "Wispr Flow"));
    const db = new DatabaseSync(NodePath.join(appData, "Wispr Flow", "flow.sqlite"));
    db.exec(
      "create table Dictionary (phrase text, replacement text, observedSource, isSnippet int, frequencyUsed int, isDeleted int)",
    );
    db.exec(`insert into Dictionary values
      ('Hetzner', null, 'Hexner', 0, 34, 0), ('Gone', null, null, 0, 1, 1),
      ('Weavia', null, 'Wavia', 0, 3, 0), ('my email address', 'a@b.co', null, 1, 0, 0)`);
    db.close();
    const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vocab-"));
    saveDictionary(state, [{ phrase: "Hetzner", replacement: null }]);
    const put: Array<{ cue: string; text: string }> = [];
    const once = {
      stateDir: state,
      appData,
      putSnippet: (s: { cue: string; text: string }) => put.push(s),
    };
    const entries = await importWispr({ ...once, entries: readDictionary(state, []) });
    // An existing list is only enriched: Weavia was deleted after the first import, or never taken.
    expect(entries).toEqual([
      { phrase: "Hetzner", replacement: null, source: "added", count: 34, heard: ["Hexner"] },
    ]);
    expect(readDictionary(state, [])).toEqual(entries);
    expect(put).toEqual([{ cue: "my email address", text: "a@b.co" }]);
    expect(await importWispr({ ...once, entries: [] })).toEqual([]);
    expect(put).toHaveLength(1);
  });
});
