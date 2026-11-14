// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { EMPTY_GUARD, type GuardFile } from "@t3tools/tessaya-shared/startGuard";

export const readGuard = (file: string): GuardFile => {
  try {
    const v = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Partial<GuardFile>;
    return {
      current: v.current ?? null,
      lastGood: typeof v.lastGood === "string" ? v.lastGood : null,
      bad: Array.isArray(v.bad) ? v.bad.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return EMPTY_GUARD;
  }
};

export const writeGuard = (file: string, guard: GuardFile): void => {
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(guard));
    NodeFS.renameSync(`${file}.tmp`, file);
  } catch {
    // The guard must never be the thing that stops Tessaya starting.
  }
};
