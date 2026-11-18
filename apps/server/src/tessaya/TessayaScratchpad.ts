/**
 * His Scratchpad, one store on her brain (ONE-SPINE-MAP §14): the desktop keeps a cache, the Tessel's note tools and
 * the desktop's own go here. A worker server sends each act to the brain (`tessaya_brain` op `scratchpad`).
 */
import { NOTES_MAX, searchNotes } from "@t3tools/tessaya-shared/scratchpad";
import {
  TessayaScratchpadResult,
  type TessayaScratchNote,
  type TessayaScratchpadAct,
} from "@t3tools/tessaya-contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { makeBrainLink } from "./BrainHost.ts";

const decodeResult = Schema.decodeUnknownOption(TessayaScratchpadResult);

/** On this server's own store, for the brain; None with no Tessaya database here. */
export const scratchpadHere = Effect.fn("Scratchpad.here")(function* (act: TessayaScratchpadAct) {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return Option.none<TessayaScratchpadResult>();
  const db = sql.value;
  const all = db<TessayaScratchNote>`SELECT id, at, text FROM tessaya_scratchpad ORDER BY at DESC, id`;
  switch (act.op) {
    case "list":
      return Option.some({ notes: yield* all });
    case "search":
      return Option.some({ notes: searchNotes(yield* all, act.query).slice(0, 50) });
    case "add": {
      for (const n of act.notes)
        yield* db`INSERT INTO tessaya_scratchpad (id, at, text) VALUES (${n.id}, ${n.at}, ${n.text.trim()}) ON CONFLICT (id) DO NOTHING`;
      // The oldest fall off past the limit, as on the desktop.
      yield* db`DELETE FROM tessaya_scratchpad WHERE id NOT IN (SELECT id FROM tessaya_scratchpad ORDER BY at DESC, id LIMIT ${NOTES_MAX})`;
      return Option.some({ notes: act.notes });
    }
    case "remove":
      for (const id of act.ids) yield* db`DELETE FROM tessaya_scratchpad WHERE id = ${id}`;
      return Option.some({ notes: [] });
  }
});

/** One act on her brain's Scratchpad; None when it has no store or the brain can't be reached. */
export const scratchpad = Effect.fn("Scratchpad.at")(function* (act: TessayaScratchpadAct) {
  const brain = yield* makeBrainLink;
  if (yield* brain.isBrain) return yield* scratchpadHere(act);
  return Option.flatMap(yield* brain.send("scratchpad", act), decodeResult);
});
