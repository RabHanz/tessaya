/**
 * His Scratchpad (quick notes kept apart from memory) over the wire: one store on her brain that the desktop caches
 * and the Tessel reads and adds to. The pure rules (limits, search) are `@t3tools/tessaya-shared/scratchpad`.
 */
import * as Schema from "effect/Schema";

export const BATON_SCRATCHPAD_WS_METHODS = { call: "baton.scratchpad.call" } as const;

export const TessayaScratchNote = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  /** Epoch ms. */
  at: Schema.Number,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
});
export type TessayaScratchNote = typeof TessayaScratchNote.Type;

/** `add` keeps notes by id, so a desktop replaying what it wrote offline adds each once. */
export const TessayaScratchpadAct = Schema.Union([
  Schema.Struct({ op: Schema.Literal("list") }),
  Schema.Struct({
    op: Schema.Literal("search"),
    query: Schema.String.check(Schema.isMaxLength(400)),
  }),
  Schema.Struct({
    op: Schema.Literal("add"),
    notes: Schema.Array(TessayaScratchNote).check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({
    op: Schema.Literal("remove"),
    ids: Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(Schema.isMaxLength(1_000)),
  }),
]);
export type TessayaScratchpadAct = typeof TessayaScratchpadAct.Type;

/** `list`: every note, newest first; `search`: the matches; `add`: the notes added; `remove`: none. */
export const TessayaScratchpadResult = Schema.Struct({ notes: Schema.Array(TessayaScratchNote) });
export type TessayaScratchpadResult = typeof TessayaScratchpadResult.Type;
