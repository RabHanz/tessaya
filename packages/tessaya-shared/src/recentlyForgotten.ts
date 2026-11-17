/**
 * Recently forgotten on web and mobile Settings: people and facts from her understanding, restorable for the bin's
 * days. Copy and behaviour mirror the desktop's People section (apps/desktop/src/tessaya/memory/peopleSection.ts).
 */
import type {
  TessayaHouseholdCallInput,
  TessayaHouseholdCallResult,
} from "@t3tools/tessaya-contracts";

export type Forgotten = NonNullable<TessayaHouseholdCallResult["forgotten"]>[number];

export const FORGOTTEN_COPY = {
  section: "Recently forgotten",
  days: "Keep forgotten people and facts for",
  hint: "Until then you can restore them; after, they are deleted for good.",
  empty: "Nobody forgotten lately.",
  restore: "Restore",
  purge: "Delete for good",
  purgeAll: "Empty",
  purgeAllLabel: "Empty Recently forgotten",
  purgeAllConfirm:
    "Delete everyone in Recently forgotten for good? This can't be undone. Tap Empty again to do it.",
} as const;

export const BIN_DAY_CHOICES = [7, 30, 90] as const;

const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** One row: whose (and the fact, when one fact of her understanding went), and who forgot it when. */
export const forgottenRow = (f: Forgotten) => {
  const label =
    f.fact === undefined
      ? (f.name ?? "Someone new")
      : `${f.name ?? "Someone"}: ${f.fact.replace(/^\s*-\s*/, "")}`;
  // A member forgetting a fact of their own forgot it themselves.
  const by = f.by === "member" ? "themselves" : f.by;
  const at = DAY.format(Date.parse(f.at));
  return {
    label,
    hint:
      by === "themselves"
        ? `Forgot themselves on ${at}`
        : by === "expiry"
          ? `Forgotten on ${at}: no one saved them`
          : by === "tidy"
            ? `Tidied away on ${at}`
            : `Forgotten by you on ${at}`,
    confirm: `Delete ${label} for good? This can't be undone. Tap Delete for good again to do it.`,
  };
};

/** Deleting for good can't be undone: the first tap on a row (no id: Empty) only asks, the second sends. */
export const purgeTap = (
  confirming: string | null,
  id?: string,
): { readonly confirm: string } | { readonly send: TessayaHouseholdCallInput } => {
  const key = id ?? "all";
  if (confirming !== key) return { confirm: key };
  return {
    send:
      id === undefined
        ? { op: "peopleManage", action: "purge" }
        : { op: "peopleManage", action: "purge", id },
  };
};
