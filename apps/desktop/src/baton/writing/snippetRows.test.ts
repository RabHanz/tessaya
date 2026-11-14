// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseSnippet } from "@t3tools/tessaya-shared/snippets";
import { describe, expect, it } from "vite-plus/test";

import { tabOf } from "../home/tabs.ts";
import { snippetAction, snippetControls } from "./snippetRows.ts";
import { createSnippetStore } from "./snippetStore.ts";

describe("snippets in the window", () => {
  it("lists rows on the Snippets tab and turns a row into the action it means", () => {
    const list = [parseSnippet("my email = me@example.com")!];
    const rows = snippetControls(list, "");
    expect(rows[0]).toMatchObject({ kind: "list", items: ["my email = me@example.com"] });
    for (const r of rows) expect(tabOf(r.id)).toBe("snippets");
    expect(snippetAction("sn.list:add", "a = b")).toMatchObject({ kind: "put" });
    expect(snippetAction("sn.list:add", "nonsense")).toEqual({ kind: "bad" });
    expect(snippetAction("sn.list:rm", "my email = me@example.com")).toEqual({
      kind: "remove",
      cue: "my email",
    });
    expect(snippetAction("sn.import:later", null)).toEqual({ kind: "export" });
  });
  it("keeps snippets on disk, replaces by cue, and imports a file", () => {
    const store = createSnippetStore(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "snip-")));
    expect(store.put(parseSnippet("a = 1")!)).toBe(true);
    store.put(parseSnippet("a = 2")!);
    expect(store.list().map((s) => s.text)).toEqual(["2"]);
    expect(store.importText("b = 3\nc,4\nbad")).toEqual({ added: 2, skipped: 1 });
    store.remove("a");
    expect(store.list().map((s) => s.cue)).toEqual(["b", "c"]);
  });
});
