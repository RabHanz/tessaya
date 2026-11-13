import * as Schema from "effect/Schema";

// Apart from composerDraftStore so a page can make draft ids without loading (and persisting) the drafts store.
export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;
