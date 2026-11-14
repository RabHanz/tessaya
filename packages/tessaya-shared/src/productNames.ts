/**
 * The names people see for Tessaya's hardware; copy reads them from here, so a rename is one edit. Ids, topics and
 * stored literals keep their old spellings (`r1-…`, `agora-r1`, `freya/r1/`), which the rename plan moves separately.
 */
export const DEVICE = "Tessel";
/** The shell the board sits in. */
export const MAIN_BODY = "Tumble";
export const PLUSH_BODY = "Tuft";
/** The bare board, for development only. */
export const BARE_BOARD = "Seed";
export const FLASH_TOOL = "tessel-flash";
