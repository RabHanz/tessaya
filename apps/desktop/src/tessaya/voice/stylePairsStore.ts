// @effect-diagnostics nodeBuiltinImport:off
/**
 * His own past dictations for the clean-up's examples (stylePairs.ts): Wispr's history copied in once, read-only, into
 * `<state dir>/voice/style-pairs.json` (so it outlives Wispr), plus what Tessaya's own History says he kept. They leave
 * this machine only inside a clean-up prompt, to his own Claude or his own key, as the words being cleaned already do.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { modeForApp } from "@t3tools/tessaya-shared/dictationCleanup";
import { detectSecret, REDACTED } from "@t3tools/tessaya-shared/memory";
import {
  pairsFromWispr,
  type StylePair,
  type WisprHistoryRow,
} from "@t3tools/tessaya-shared/stylePairs";

import { createJsonStore } from "../writing/jsonStore.ts";
import type { HistoryTurn } from "./history.ts";

const isPairs = (v: unknown): v is ReadonlyArray<StylePair> =>
  Array.isArray(v) && v.every((p) => typeof p?.raw === "string" && typeof p?.kept === "string");

const clean = (pairs: ReadonlyArray<StylePair>) =>
  pairs.filter((p) => detectSecret(p.raw) === null && detectSecret(p.kept) === null);

/** The copied pairs, after copying Wispr's history in on the first start that finds it. A missing Wispr gives none. */
export const loadStylePairs = async (input: {
  readonly stateDir: string;
  readonly appData: string | undefined;
}): Promise<ReadonlyArray<StylePair>> => {
  const file = NodePath.join(input.stateDir, "voice", "style-pairs.json");
  const store = createJsonStore<ReadonlyArray<StylePair>>(file, [], isPairs);
  if (NodeFS.existsSync(file) || input.appData === undefined) return store.read();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(NodePath.join(input.appData, "Wispr Flow", "flow.sqlite"), {
      readOnly: true,
    });
    const rows = db
      .prepare(
        "select transcriptEntityId, asrText, formattedText, editedText, app, url from History order by timestamp",
      )
      .all() as unknown as ReadonlyArray<WisprHistoryRow>;
    db.close();
    const pairs = clean(pairsFromWispr(rows));
    store.write(pairs);
    NodeFS.chmodSync(file, 0o600);
    return pairs;
  } catch {
    return [];
  }
};

/** Tessaya's own dictations: his fix of the field when it was read back, else the clean-up he let stand. */
export const historyPairs = (turns: ReadonlyArray<HistoryTurn>): ReadonlyArray<StylePair> =>
  clean(
    turns.flatMap((t) => {
      const kept = t.fixed ?? (t.status === "ok" ? t.cleaned : null);
      if (t.kind !== "dictation" || t.hidden !== null || t.raw === REDACTED || kept === null)
        return [];
      const words = t.raw.split(/\s+/).length;
      return words < 4 || words > 120
        ? []
        : [{ raw: t.raw, kept, mode: modeForApp({ exe: t.app, title: "" }), id: t.id }];
    }),
  );
