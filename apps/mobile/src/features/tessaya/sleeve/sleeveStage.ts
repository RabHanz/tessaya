import type { StageCard } from "@t3tools/tessaya-shared/sleeveEstate";

// her stage in the Sleeve while it shows her cartoon (TalkView): the card she holds, or null to put it away
let show: ((card: StageCard | null) => void) | null = null;
export const setSleeveStage = (next: ((card: StageCard | null) => void) | null) => {
  show = next;
};
/** False when no stage of hers is showing on this phone to hold it. */
export const sleeveStage = (card: StageCard | null): boolean => {
  if (show === null) return false;
  show(card);
  return true;
};
