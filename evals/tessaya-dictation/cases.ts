/**
 * Made-up dictations in the shapes his real ones fell short of Wispr Flow on (V-038, 15 Nov): a phrase said again in
 * other words, mis-heard words, spoken numbers, a capital the recogniser put on a plain word, and his "btw" entry.
 */
export interface DictationCase {
  readonly id: string;
  readonly heard: string;
  /** What the desktop sends beside it, such as the chat reply he is answering. */
  readonly context?: { readonly replyingTo?: string };
  readonly dictionary?: ReadonlyArray<{
    readonly phrase: string;
    readonly replacement: string | null;
  }>;
  /** Every one must be in the pasted text, case-sensitive. */
  readonly must: ReadonlyArray<string>;
  /** None may be in it, case-insensitive. */
  readonly never: ReadonlyArray<string>;
}

export const CASES: ReadonlyArray<DictationCase> = [
  {
    id: "said-again-other-words",
    heard:
      "And the export should finish and close the dialogue. It'll close the pop up. Then we can ship it.",
    must: ["pop-up"],
    never: ["dialogue"],
  },
  {
    id: "unmarked-correction-across-sentences",
    heard:
      "In some and quite a few screens it still shows the old logo. Most screens actually. Can you fix that today?",
    must: ["ost screens"],
    never: ["quite a few"],
  },
  {
    id: "misheard-product",
    heard:
      "If the training is slow why not run it on Kegle instead of the laptop and keep the laptop free?",
    must: ["Kaggle"],
    never: ["Kegle"],
  },
  {
    id: "misheard-common-word",
    heard: "Put the bug on the jura board now so the team sees it before the tests tonight.",
    must: ["Jira board"],
    never: ["jura"],
  },
  {
    id: "spoken-numbers",
    heard:
      "The three D model of the stand only turns one hundred eighty degrees and it should turn three hundred sixty degrees.",
    must: ["3D", "180 degrees", "360 degrees"],
    never: ["°", "three d"],
  },
  {
    id: "recogniser-capital-on-plain-word",
    heard:
      "So what is going on now and what is next? And what about the Kegle State? Are things moving there?",
    must: ["Kaggle"],
    never: ["Kegle"],
  },
  {
    id: "small-letter-entry-opens-a-sentence",
    heard:
      "By the way, the build is green now so the release can go out tonight after the last check.",
    dictionary: [{ phrase: "btw", replacement: "by the way" }],
    must: ["By the way"],
    never: [],
  },
  // 16 Nov: a phrase said again after a pause stayed twice ("defaulted off. Defaulted off.").
  {
    id: "said-again-after-a-pause",
    heard: "Which of the alerts are still muted for now? Kept on mute. Kept on mute.",
    must: ["alerts", "mute"],
    never: ["mute. kept on mute", "mute kept on mute"],
  },
  // 16 Nov: Haiku wrote "does it not hold?" for words it could not place; Sonnet once wrote "Batons" for "buttons".
  {
    id: "unclear-words-stay-as-said",
    heard:
      "I tested the buttons and they line up with the USB C port. And why is the top open? It doesn't want you.",
    must: ["buttons", "USB-C"],
    never: ["baton", "hold"],
  },
  // 16 Nov, V-050: "color" stayed American in his text; he writes British.
  {
    id: "british-spelling",
    heard:
      "Change the color of the header and organize the settings so the behavior matches the center panel.",
    must: ["colour", "organise", "behaviour", "centre"],
    never: ["color", "organize", "behavior", "center"],
  },
  // 16 Nov, V-050: "Batons" for "buttons" on his press. A control: it passes on the old prompt too without his press.
  {
    id: "buttons-stay-buttons",
    heard:
      "Now the buttons on the Tessel work but the buttons wake it twice. Can you look at the buttons in the Tessaya app as well?",
    must: ["buttons"],
    never: ["baton"],
  },
  // His message so far (cleaned already) and the next press, cleaned as one: the correction crosses the presses.
  {
    id: "correction-across-presses",
    heard:
      "Send the invoice to the Leeds office today and copy Sam. Sorry not Leeds. The Bristol office.",
    must: ["Bristol office", "Sam"],
    never: ["Leeds"],
  },
  {
    id: "misheard-fixed-by-the-reply",
    heard: "Can you rotate the token for back please and rerun it tonight?",
    context: {
      replyingTo:
        "The nightly backup to Backblaze failed again at 02:00 because its token expired.",
    },
    must: ["Backblaze"],
    never: ["back please"],
  },
];
