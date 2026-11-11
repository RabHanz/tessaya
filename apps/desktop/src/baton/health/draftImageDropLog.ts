// @effect-diagnostics nodeBuiltinImport:off
/**
 * The web app prints one console line when a draft image vanishes unexplained
 * (apps/web/src/composerImageDropLog.ts). Every renderer's lines with that prefix land here, so a
 * report can be read from the laptop: <stateDir>/logs/draft-image-drops.ndjson.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as Electron from "electron";

const PREFIX = "baton:draft-image-drop ";
const MAX_BYTES = 512 * 1024;

/** The JSON payload of a drop line, or null for any other console message. */
export const dropLogPayload = (message: unknown): string | null =>
  typeof message === "string" && message.startsWith(PREFIX) ? message.slice(PREFIX.length) : null;

export const captureDraftImageDrops = (
  app: Electron.App,
  existing: ReadonlyArray<Electron.WebContents>,
  logDir: string,
): void => {
  const file = NodePath.join(logDir, "draft-image-drops.ndjson");
  const append = (payload: string) => {
    try {
      if (NodeFS.existsSync(file) && NodeFS.statSync(file).size > MAX_BYTES) {
        NodeFS.renameSync(file, `${file}.1`);
      }
      NodeFS.appendFileSync(file, `${payload}\n`);
    } catch {
      // A diagnostic must never break the window it watches.
    }
  };
  const watch = (contents: Electron.WebContents) =>
    contents.on("console-message", (...args: ReadonlyArray<unknown>) => {
      const first = args[0] as { message?: unknown } | undefined;
      const payload = dropLogPayload(typeof args[2] === "string" ? args[2] : first?.message);
      if (payload !== null) append(payload);
    });
  existing.forEach(watch);
  app.on("web-contents-created", (_event, contents) => watch(contents));
};
