// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/** One structured line per resume step in `baton-resume.ndjson` beside the other logs, rotated by size. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 3;

export const appendResumeLog = (file: string, record: Record<string, unknown>): void => {
  const line = `${JSON.stringify({ at: new Date().toISOString(), source: "server", ...record })}\n`;
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    if (NodeFS.existsSync(file) && NodeFS.statSync(file).size + line.length > MAX_BYTES) {
      for (let i = KEEP - 1; i >= 1; i -= 1) {
        if (NodeFS.existsSync(`${file}.${i}`))
          NodeFS.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
      NodeFS.renameSync(file, `${file}.1`);
    }
    NodeFS.appendFileSync(file, line);
  } catch {
    // A log must never fail a resume.
  }
};
