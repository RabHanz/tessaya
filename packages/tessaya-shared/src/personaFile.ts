// @effect-diagnostics nodeBuiltinImport:off
/**
 * One front-matter field of a persona's own pack file (`executive.md` or `roles/<id>.md`), shared by the desktop's
 * roster and the server's voice library so both write his file the same way. A missing file is made from the
 * default first; clearing a field he never set leaves no file behind.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DEFAULT_PACK_FILES, withFrontField } from "./osPack.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const personaFileOf = (packDir: string, personaId: string): string | null =>
  personaId === "executive"
    ? NodePath.join(packDir, "executive.md")
    : NAME.test(personaId)
      ? NodePath.join(packDir, "roles", `${personaId}.md`)
      : null;

/** False for an id that is not a pack file. */
export const setPersonaField = (
  packDir: string,
  personaId: string,
  key: string,
  value: string | null,
): boolean => {
  const file = personaFileOf(packDir, personaId);
  if (file === null) return false;
  if (!NodeFS.existsSync(file)) {
    if (value === null) return true;
    const base =
      personaId === "executive"
        ? DEFAULT_PACK_FILES.executive
        : (DEFAULT_PACK_FILES.roles[personaId] ?? "");
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, `${base}\n`, { flag: "wx" });
  }
  NodeFS.writeFileSync(file, withFrontField(NodeFS.readFileSync(file, "utf8"), key, value));
  return true;
};
