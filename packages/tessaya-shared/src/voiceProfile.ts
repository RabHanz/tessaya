// @effect-diagnostics globalDate:off
/**
 * The Voice Profile on Insights: how he dictates, worked out from the turn log alone. Nothing is compared with anyone,
 * nothing leaves the computer, and each line says how many dictations it rests on.
 */
import { wordsIn } from "./insightsDeep.ts";

export interface ProfileTurn {
  readonly at: string;
  readonly kind: "dictation" | "spoken";
  readonly raw: string;
  readonly cleaned: string | null;
  readonly seconds: number | null;
  /** He fixed words in the field afterwards. */
  readonly corrected: boolean;
  /** The text in the field after he fixed it, when it could be read back. */
  readonly fixed: string | null;
}

export interface VoiceProfile {
  readonly dictations: number;
  readonly averageWords: number;
  /** Fillers per 100 spoken words, with the ones he says most. */
  readonly fillers: { readonly per100: number; readonly top: ReadonlyArray<string> };
  /** Share of dictations Tessaya had to change at all, 0 to 1. */
  readonly changedShare: number;
  /** Share he fixed himself afterwards, 0 to 1. */
  readonly correctedShare: number;
  /** Local hour 0 to 23 with the most dictations, null under five dictations. */
  readonly busiestHour: number | null;
  /** Words he keeps correcting: what Tessaya wrote and what he changed it to, at least twice. */
  readonly recurringFixes: ReadonlyArray<{
    readonly wrote: string;
    readonly meant: string;
    readonly times: number;
  }>;
}

const FILLERS = new Set(["um", "uh", "umm", "uhh", "er", "erm", "ah", "hmm"]);
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w !== "");

/** One-for-one word swaps between what was written and what he left in the field; anything longer is a rewrite, not a fix. */
export const swaps = (written: string, fixed: string): ReadonlyArray<readonly [string, string]> => {
  const a = words(written);
  const b = words(fixed);
  if (a.length !== b.length) return [];
  const out: Array<readonly [string, string]> = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) out.push([a[i]!, b[i]!]);
  return out.length > 3 ? [] : out;
};

export const computeVoiceProfile = (all: ReadonlyArray<ProfileTurn>): VoiceProfile | null => {
  const dictations = all.filter((t) => t.kind === "dictation");
  if (dictations.length === 0) return null;
  let spoken = 0;
  let fillerCount = 0;
  const fillerWords = new Map<string, number>();
  let changed = 0;
  let corrected = 0;
  const hours = new Array<number>(24).fill(0);
  const fixes = new Map<string, number>();
  for (const t of dictations) {
    spoken += wordsIn(t.raw);
    for (const w of words(t.raw)) {
      if (FILLERS.has(w)) {
        fillerCount += 1;
        fillerWords.set(w, (fillerWords.get(w) ?? 0) + 1);
      }
    }
    if (t.cleaned !== null && t.cleaned.trim() !== t.raw.trim()) changed += 1;
    if (t.corrected) corrected += 1;
    const hour = new Date(t.at).getHours();
    if (!Number.isNaN(hour)) hours[hour] = (hours[hour] ?? 0) + 1;
    if (t.fixed !== null && t.cleaned !== null) {
      for (const [wrote, meant] of swaps(t.cleaned, t.fixed)) {
        const key = `${wrote}\u0000${meant}`;
        fixes.set(key, (fixes.get(key) ?? 0) + 1);
      }
    }
  }
  const peak = Math.max(...hours);
  return {
    dictations: dictations.length,
    averageWords: Math.round(spoken / dictations.length),
    fillers: {
      per100: spoken === 0 ? 0 : Math.round((fillerCount / spoken) * 1000) / 10,
      top: [...fillerWords.entries()]
        .toSorted((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([w]) => w),
    },
    changedShare: changed / dictations.length,
    correctedShare: corrected / dictations.length,
    busiestHour: dictations.length >= 5 ? hours.indexOf(peak) : null,
    recurringFixes: [...fixes.entries()]
      .filter(([, n]) => n >= 2)
      .toSorted((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([key, times]) => {
        const [wrote, meant] = key.split("\u0000");
        return { wrote: wrote!, meant: meant!, times };
      }),
  };
};

const pct = (share: number): string => `${Math.round(share * 100)}%`;
const hourText = (h: number): string => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;

/** The sentences the Insights page shows, each with what it rests on. */
export const describeProfile = (
  p: VoiceProfile,
): ReadonlyArray<{ readonly label: string; readonly detail: string }> => [
  {
    label: "How you dictate",
    detail: `${p.dictations} dictations, ${p.averageWords} words each on average${p.busiestHour === null ? "" : `, most often around ${hourText(p.busiestHour)}`}.`,
  },
  {
    label: "Filler words",
    detail:
      p.fillers.per100 === 0
        ? "You hardly use any (um, uh, er)."
        : `${p.fillers.per100} in every 100 words${p.fillers.top.length === 0 ? "" : `, mostly ${p.fillers.top.join(", ")}`}. Tessaya takes them out.`,
  },
  {
    label: "What Tessaya changes",
    detail: `It changed the words in ${pct(p.changedShare)} of your dictations; you fixed ${pct(p.correctedShare)} of them yourself afterwards.`,
  },
  {
    label: "Words you keep correcting",
    detail:
      p.recurringFixes.length === 0
        ? "Nothing yet. When you fix the same word twice, it shows here."
        : p.recurringFixes
            .map((f) => `"${f.wrote}" to "${f.meant}" (${f.times} times)`)
            .join("; ") + ". Add them to your dictionary to stop it.",
  },
];
