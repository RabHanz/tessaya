/** The Style area of the window: a style for each kind of writing, the cleanup level, and a guided setup. */
import {
  CATEGORY_LABELS,
  cleanupChoiceOf,
  STYLE_CATEGORIES,
  STYLE_EXAMPLES,
  STYLE_LABELS,
  STYLES,
  type CleanupChoice,
  type StyleCategory,
  type StyleChoices,
  type WritingStyle,
} from "@t3tools/tessaya-shared/writingStyle";

import type { HomeControl } from "../home/batonHome.ts";

export const styleControls = (
  choices: StyleChoices,
  cleanup: "off" | "local" | "claude",
): ReadonlyArray<HomeControl> => [
  {
    id: "st.guide",
    section: "Style",
    label: "Make Tessaya write like you",
    hint: "Four quick questions, one for each kind of writing. You can change any of them below.",
    kind: "action",
    button: "Guide me",
    lead: true,
  },
  ...STYLE_CATEGORIES.map((c): HomeControl => ({
    id: `st.cat:${c}`,
    section: "Style",
    label: CATEGORY_LABELS[c],
    hint: `${STYLE_EXAMPLES[choices[c]]}`,
    kind: "choice",
    value: choices[c],
    options: STYLES.map((s) => ({ value: s, label: STYLE_LABELS[s] })),
  })),
  {
    id: "st.level",
    section: "Auto cleanup",
    label: "How much Tessaya tidies what you said",
    hint: "None: exactly as heard. Light: punctuation, capitals and filler words, on this computer. Medium: also fixes what code cannot, using your own Claude. Private windows always stay light.",
    kind: "choice",
    value: cleanupChoiceOf(cleanup),
    options: [
      { value: "none", label: "None" },
      { value: "light", label: "Light" },
      { value: "medium", label: "Medium" },
    ],
  },
];

export const styleAction = (id: string, value: string | boolean | null) => {
  if (id === "st.guide") return { kind: "guide" } as const;
  const cat = /^st\.cat:(personal|work|email|other)$/.exec(id);
  if (
    cat !== null &&
    typeof value === "string" &&
    (STYLES as ReadonlyArray<string>).includes(value)
  ) {
    return {
      kind: "style",
      category: cat[1] as StyleCategory,
      style: value as WritingStyle,
    } as const;
  }
  if (id === "st.level" && (value === "none" || value === "light" || value === "medium")) {
    return { kind: "level", level: value as CleanupChoice } as const;
  }
  return null;
};

/** The buttons of one guided question; the last one skips. */
export const GUIDE_BUTTONS: ReadonlyArray<string> = [
  STYLE_LABELS.formal,
  STYLE_LABELS.casual,
  STYLE_LABELS["very-casual"],
  STYLE_LABELS.excited,
  "Skip",
];
export const guideAnswer = (index: number): WritingStyle | null =>
  (["formal", "casual", "very-casual", "excited"] as const)[index] ?? null;
export const guideQuestion = (c: StyleCategory): { title: string; detail: string } => ({
  title: "How do you write?",
  detail: `${CATEGORY_LABELS[c]}: pick a style. Example of casual: "${STYLE_EXAMPLES.casual}".`,
});
