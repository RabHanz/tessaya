// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off
/**
 * Learning Tessaya's progress for the person this server serves, in `<userdata>/tessaya-learn.json`, so a tip seen
 * on the phone is not shown again on the desktop. The rules are `@t3tools/tessaya-shared/learn`'s.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { TessayaLearnCallInput, TessayaLearnCallResult } from "@t3tools/tessaya-contracts";
import {
  applyLearnOp,
  readLearnProgress,
  type LearnOp,
  type LearnProgress,
} from "@t3tools/tessaya-shared/learn";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";

const read = (file: string): LearnProgress => {
  try {
    return readLearnProgress(JSON.parse(NodeFS.readFileSync(file, "utf8")));
  } catch {
    return readLearnProgress(null);
  }
};

const write = (file: string, progress: LearnProgress) => {
  const part = `${file}.${process.pid}.part`;
  NodeFS.writeFileSync(part, JSON.stringify(progress));
  NodeFS.renameSync(part, file);
};

/** Read and write happen in one synchronous step, so two devices' changes never overwrite each other. */
export const serveLearnCall = Effect.fn("BatonLearn.call")(function* (
  input: TessayaLearnCallInput,
) {
  const config = yield* ServerConfig.ServerConfig;
  const file = NodePath.join(config.stateDir, "tessaya-learn.json");
  return yield* Effect.try({
    try: (): TessayaLearnCallResult => {
      const now = read(file);
      if (input.kind === "read")
        return input.op === "get" ? { ok: true, value: now } : { ok: false, error: "Not known." };
      const next = applyLearnOp(now, { ...input.args, op: input.op } as LearnOp);
      if (next !== now) write(file, next);
      return { ok: true, value: next };
    },
    catch: () => "unsaved",
  }).pipe(
    Effect.orElseSucceed((): TessayaLearnCallResult => ({
      ok: false,
      error: "Tips could not be saved.",
    })),
  );
});
