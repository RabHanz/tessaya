// @effect-diagnostics nodeBuiltinImport:off
/** One small JSON file in Tessaya's state folder, written whole and renamed into place; a damaged file is kept aside. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const createJsonStore = <T>(
  file: string,
  fallback: T,
  valid: (value: unknown) => value is T,
) => ({
  read: (): T => {
    let text: string;
    try {
      text = NodeFS.readFileSync(file, "utf8");
    } catch {
      return fallback;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return valid(parsed) ? parsed : fallback;
    } catch {
      NodeFS.renameSync(file, `${file}.bad`);
      return fallback;
    }
  },
  write: (value: T): void => writeJsonFile(file, value),
});

/** Written whole and renamed into place, so a crash leaves the old file or the new one, never half of one. */
export const writeJsonFile = (file: string, value: unknown): void => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  NodeFS.renameSync(`${file}.tmp`, file);
};

/** Only what differs from the defaults, so a default changed in a later release still reaches him. */
export const changedFrom = <T extends object>(value: T, defaults: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([key, v]) => v !== defaults[key as keyof T]),
  ) as Partial<T>;
