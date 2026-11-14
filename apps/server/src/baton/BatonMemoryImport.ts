// @effect-diagnostics nodeBuiltinImport:off
/**
 * Learnings from a folder of markdown (D150, MEMORY.md section 7): ventures keep their learnings as
 * files, and this feeds them to the brain. The folder is only ever read. A file already imported and
 * unchanged is skipped, so running it again adds nothing and does not inflate confidence.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { BatonMemoryRefusedError } from "@t3tools/tessaya-contracts";
import { parseLearningFile } from "@t3tools/tessaya-shared/memory";
import * as Effect from "effect/Effect";

import { BatonMemoryService, MemoryViewer } from "./BatonMemoryService.ts";

const MAX_FILES = 500;
const same = (text: string): string => text.trim().replace(/\s+/g, " ");
const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 3;

const markdownFiles = (root: string): ReadonlyArray<string> => {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= MAX_FILES) return;
      const path = NodePath.join(dir, entry.name);
      // A link could lead out of the folder he chose, so none is followed.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // His private pack (D148) can sit in a state folder he points at; it never becomes memory.
        if (depth < MAX_DEPTH && !entry.name.startsWith(".") && entry.name !== "operating-system")
          walk(path, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        found.push(path);
      }
    }
  };
  walk(root, 0);
  return found.toSorted();
};

/** The file's text, or null when it is too big or cannot be read; never throws. */
const readSmallFile = (file: string): string | null => {
  try {
    return NodeFS.statSync(file).size > MAX_BYTES ? null : NodeFS.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export const importFolder = Effect.fn("BatonMemoryImport.importFolder")(
  function* (folder: string) {
    const memory = yield* BatonMemoryService;
    if (!NodePath.isAbsolute(folder)) {
      return yield* new BatonMemoryRefusedError({ reason: "give the full path of the folder" });
    }
    const listed = yield* Effect.sync(() => {
      try {
        return markdownFiles(folder);
      } catch {
        return null;
      }
    });
    if (listed === null) {
      return yield* new BatonMemoryRefusedError({ reason: "that folder cannot be read" });
    }
    const files: ReadonlyArray<string> = listed;
    let added = 0;
    let refused = 0;
    let unchanged = 0;
    for (const file of files) {
      const text = readSmallFile(file);
      if (text === null) {
        refused++;
        continue;
      }
      const rel = NodePath.relative(folder, file).split(NodePath.sep).join("/");
      const digest = NodeCrypto.createHash("sha1").update(text).digest("hex");
      if (!(yield* memory.noteOnce(`import:${folder}:${rel}`, digest))) {
        unchanged++;
        continue;
      }
      // An edited file: lines he removed are forgotten, unchanged lines are left alone (not reinforced).
      const drafts = parseLearningFile(text);
      const fresh = new Set(drafts.map((d) => same(d.text)));
      // The file's full path: another folder's file of the same name is a different source.
      const ref = NodePath.join(folder, rel);
      const before = (yield* memory.list({ includeProposed: true, limit: 100_000 })).filter(
        (i) => i.source === "import" && i.sourceRef === ref,
      );
      const kept = new Set(before.map((i) => same(i.text)));
      for (const old of before) if (!fresh.has(same(old.text))) yield* memory.forget(old.id);
      for (const draft of drafts.filter((d) => !kept.has(same(d.text)))) {
        const item = yield* memory
          .add({ ...draft, source: "import", sourceRef: ref })
          .pipe(Effect.orElseSucceed(() => null));
        if (item === null) refused++;
        else added++;
      }
    }
    return { files: files.length, added, refused, unchanged };
    // Reading his own folder is upkeep: it replaces what the same file put in, walled or not.
  },
  Effect.provideService(MemoryViewer, "server"),
);
