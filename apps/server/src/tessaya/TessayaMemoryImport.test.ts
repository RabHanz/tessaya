// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { importFolder } from "./TessayaMemoryImport.ts";
import { TessayaMemoryService, layer as memoryLayer } from "./TessayaMemoryService.ts";

const layer = it.layer(memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("importFolder", (it) => {
  it.effect("imports learnings once, skips unchanged files, refuses secrets, never writes", () =>
    Effect.gen(function* () {
      const memory = yield* TessayaMemoryService;
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-import-"));
      NodeFS.mkdirSync(NodePath.join(dir, "shop"));
      NodeFS.writeFileSync(
        NodePath.join(dir, "shop", "a.md"),
        "---\nkind: learning\nproject: shop\n---\n- Retry the upload once\n- my password is hunter22x\n",
      );
      NodeFS.writeFileSync(NodePath.join(dir, "b.md"), "# Notes\nKeep the cache warm.\n");
      NodeFS.writeFileSync(NodePath.join(dir, "ignore.txt"), "not markdown");
      const before = NodeFS.readFileSync(NodePath.join(dir, "b.md"), "utf8");

      const first = yield* importFolder(dir);
      assert.deepEqual(first, { files: 2, added: 2, refused: 1, unchanged: 0 });
      const found = yield* memory.search({ text: "upload", scopeRef: "shop" });
      assert.strictEqual(found[0]?.item.source, "import");
      assert.strictEqual(found[0]?.item.sourceRef, NodePath.join(dir, "shop", "a.md"));

      const again = yield* importFolder(dir);
      assert.deepEqual(again, { files: 2, added: 0, refused: 0, unchanged: 2 });
      assert.strictEqual(NodeFS.readFileSync(NodePath.join(dir, "b.md"), "utf8"), before);

      // Edits: a line changed, a line added, a file rewritten. An untouched line is not reinforced.
      const keepBefore = (yield* memory.search({ text: "upload", scopeRef: "shop" }))[0]!.item;
      NodeFS.writeFileSync(
        NodePath.join(dir, "shop", "a.md"),
        "---\nkind: learning\nproject: shop\n---\n- Retry the upload once\n- Build at night\n",
      );
      NodeFS.writeFileSync(NodePath.join(dir, "b.md"), "# Notes\nKeep the cache cold.\n");
      yield* importFolder(dir);
      const imported = (yield* memory.list({ limit: 100 })).filter((i) => i.source === "import");
      assert.sameMembers(
        imported.map((i) => i.text),
        ["Retry the upload once", "Build at night", "Keep the cache cold."],
      );
      const keepAfter = imported.find((i) => i.text === "Retry the upload once")!;
      assert.strictEqual(keepAfter.confidence, keepBefore.confidence);

      // Another folder with a file of the same name leaves this folder's items alone.
      const other = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-import-"));
      NodeFS.mkdirSync(NodePath.join(other, "shop"));
      NodeFS.writeFileSync(NodePath.join(other, "shop", "a.md"), "- Pack the van on Thursdays\n");
      yield* importFolder(other);
      const both = (yield* memory.list({ limit: 100 })).map((i) => i.text);
      assert.includeMembers(both, ["Retry the upload once", "Pack the van on Thursdays"]);
      NodeFS.rmSync(other, { recursive: true, force: true });

      // His private pack in the folder is never read into memory.
      NodeFS.mkdirSync(NodePath.join(dir, "operating-system"));
      NodeFS.writeFileSync(
        NodePath.join(dir, "operating-system", "executive.md"),
        "- Private rule\n",
      );
      assert.strictEqual((yield* importFolder(dir)).files, 2);
      NodeFS.rmSync(dir, { recursive: true, force: true });

      const missing = yield* Effect.flip(importFolder(dir));
      assert.include(missing.reason, "cannot be read");
      const relative = yield* Effect.flip(importFolder("shop"));
      assert.include(relative.reason, "full path");
    }),
  );
});
