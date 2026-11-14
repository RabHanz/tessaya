// @effect-diagnostics nodeBuiltinImport:off
/** Where a skill draft is kept for him to read and edit: its own folder, never Claude's skills folder. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { slugOf } from "@t3tools/tessaya-shared/skillReview";

export const draftsDir = (stateDir: string): string => NodePath.join(stateDir, "skill-drafts");

/** A new file; a name already used gets -2, -3, so a draft he edited is never overwritten. */
export const writeDraft = (stateDir: string, title: string, text: string): string => {
  const base = slugOf(title) || "finished-job";
  let name = base;
  for (let n = 2; NodeFS.existsSync(NodePath.join(draftsDir(stateDir), name)); n += 1)
    name = `${base}-${n}`;
  const file = NodePath.join(draftsDir(stateDir), name, "SKILL.md");
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
  return file;
};

/** A path inside the drafts folder, else null: the review reads only what Tessaya wrote there. */
export const draftPath = (stateDir: string, address: string): string | null => {
  const resolved = NodePath.resolve(address.trim());
  const root = NodePath.resolve(draftsDir(stateDir)) + NodePath.sep;
  return resolved.startsWith(root) && NodePath.basename(resolved) === "SKILL.md" ? resolved : null;
};
