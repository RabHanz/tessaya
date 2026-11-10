import { describe, expect, it } from "vite-plus/test";

import {
  biasTranscript,
  candidateWords,
  correctionsAtCaret,
  correctionsBetween,
  addNever,
  isNever,
  learnCorrection,
  mergeWispr,
  removeHeard,
  skipWord,
  unteach,
  observeWording,
  parseAddToDictionary,
  parseVocabulary,
  promptTerms,
  upsertEntry,
} from "./vocabulary.ts";

const NOW = "2026-11-01T10:00:00.000Z";

describe("vocabulary file", () => {
  it("reads old files and new, and skips junk", () => {
    expect(
      parseVocabulary([
        { phrase: "Kubernetes", replacement: null },
        { phrase: "gee pee tee", replacement: "GPT", source: "learned", count: 4, lastSeen: NOW },
        { phrase: "Tessaya", replacement: null, source: "wispr", heard: ["Tisia", "tessaya", 3] },
        { phrase: "" },
        "x",
      ]),
    ).toEqual([
      { phrase: "Kubernetes", replacement: null, source: "added", count: 1 },
      { phrase: "gee pee tee", replacement: "GPT", source: "learned", count: 4, lastSeen: NOW },
      { phrase: "Tessaya", replacement: null, source: "wispr", count: 1, heard: ["Tisia"] },
    ]);
    expect(parseVocabulary({})).toEqual([]);
  });

  it("lists the most used terms first, and keeps 'added' once he says it himself", () => {
    let entries = upsertEntry(
      [],
      { phrase: "Parakeet", replacement: null, source: "learned" },
      NOW,
      5,
    );
    entries = upsertEntry(
      entries,
      { phrase: "Baton", replacement: null, source: "learned" },
      NOW,
      1,
    );
    entries = upsertEntry(entries, { phrase: "baton", replacement: null, source: "added" }, NOW);
    const terms = promptTerms(entries);
    // Her own names come first and carry how they are mis-heard; his words follow, most used first.
    expect(terms.slice(0, 3).map((t) => t.split(" ")[0])).toEqual(["Tessaya", "Wispr", "T3"]);
    expect(terms.slice(3)).toEqual(["Parakeet", 'Baton (heard as "Buton")']);
    expect(entries.find((e) => e.phrase === "Baton")).toMatchObject({ source: "added", count: 2 });
  });
});

describe("her own names", () => {
  it("are put back where Parakeet mis-hears them, and only where the name fits", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Quick update on Tisia.", "Quick update on Tessaya."],
      ["Go over the whole of Teceyas code.", "Go over the whole of Tessaya's code."],
      ["To say um", "Tessaya"],
      ["Ship the Buton build.", "Ship the Baton build."],
      ["Move it into D3 code.", "Move it into T3 code."],
      // The dictation app he measures against (0.1.91).
      ["Compare it with WhisperFlow.", "Compare it with Wispr Flow."],
      ["Whisper Flow pastes faster.", "Wispr Flow pastes faster."],
      // Controls: the everyday word, and real names.
      ["Any header button is not working.", "Any header button is not working."],
      ["Press the button to start.", "Press the button to start."],
      [
        "Ask Tessa from accounts, and copy Tasha in.",
        "Ask Tessa from accounts, and copy Tasha in.",
      ],
      ["The D3 chart library is fine.", "The D3 chart library is fine."],
      [
        "Set BATON_THREADS on baton/dictation-magic.",
        "Set BATON_THREADS on baton/dictation-magic.",
      ],
    ];
    for (const [heard, meant] of cases) expect(biasTranscript(heard, [])).toBe(meant);
  });
});

describe("his taught words", () => {
  it("joins a split spelling, and puts an everyday heard form back only in the bare slot after a preposition", () => {
    const his = parseVocabulary([
      { phrase: "Kubernetes", replacement: null },
      { phrase: "Baton", replacement: null, heard: ["button"] },
      { phrase: "Wispr Flow", replacement: null },
    ]);
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Ask Kuber Netes to check, on T 3 code.", "Ask Kubernetes to check, on T3 code."],
      ["WisprFlow and wispr flow", "Wispr Flow and Wispr Flow"],
      ["Add the accounts to button on the laptop.", "Add the accounts to Baton on the laptop."],
      ["Update it from button.", "Update it from Baton."],
      // Controls: the thing itself.
      ["Put a like button there.", "Put a like button there."],
      ["Fix the button UI.", "Fix the button UI."],
      ["Click the button.", "Click the button."],
      ["Play with button presses.", "Play with button presses."],
    ];
    for (const [heard, meant] of cases) expect(biasTranscript(heard, his)).toBe(meant);
  });

  it("never puts a taught word over an everyday word he said, however Wispr learned it (0.1.92 feelIt)", () => {
    const his = parseVocabulary([
      { phrase: "feelIt", replacement: null, heard: ["It"] },
      { phrase: "Hex", replacement: null, heard: ["Have"] },
      { phrase: "UltraThink", replacement: null, heard: ["Think"] },
    ]);
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "It will overlap with it and it will look a bit weird.",
        "It will overlap with it and it will look a bit weird.",
      ],
      ["Talk to have and then go.", "Talk to have and then go."],
      ["Run it with think and see.", "Run it with think and see."],
    ];
    for (const [heard, meant] of cases) expect(biasTranscript(heard, his)).toBe(meant);
    // Nor is the model told that "It" may be one of his words (0.1.92: "part of feelIt" on the Claude path).
    expect(promptTerms(his).join(" ")).not.toMatch(/heard as "(It|Have|Think)"/);
  });
});

describe("Wispr's dictionary", () => {
  const rows = [
    {
      phrase: "Kubernetes",
      replacement: null,
      observedSource: "Cooper Netties",
      isSnippet: 0,
      frequencyUsed: 34,
    },
    {
      phrase: "Opus",
      replacement: "",
      observedSource: new Uint8Array([1]),
      isSnippet: 0,
      frequencyUsed: 55,
    },
    {
      phrase: "my sign-off",
      replacement: "Kind regards, Sam",
      observedSource: null,
      isSnippet: 1,
      frequencyUsed: 0,
    },
    { phrase: "Dee", replacement: null, observedSource: "she", isSnippet: 0, frequencyUsed: 2 },
  ];

  it("keeps the form each word was mis-heard as, its use, and moves snippets out", () => {
    const old = [
      { phrase: "Kubernetes", replacement: null, source: "added" as const, count: 1 },
      {
        phrase: "my sign-off",
        replacement: "Kind regards, Sam",
        source: "added" as const,
        count: 1,
      },
    ];
    const { entries, snippets } = mergeWispr(old, rows, ["Dee"]);
    expect(entries).toEqual([
      {
        phrase: "Kubernetes",
        replacement: null,
        source: "added",
        count: 34,
        heard: ["Cooper Netties"],
      },
      { phrase: "Opus", replacement: null, source: "wispr", count: 55 },
    ]);
    expect(snippets).toEqual([{ cue: "my sign-off", text: "Kind regards, Sam" }]);
  });

  it("never brings back a word he deleted after the first import", () => {
    expect(mergeWispr([], rows, [], false).entries).toEqual([]);
  });

  it("takes one heard form off", () => {
    const entries = [{ phrase: "Tessaya", replacement: null, heard: ["Tisia", "Tessa"] }];
    expect(removeHeard(entries, "tessaya", "tessa")).toEqual([
      { phrase: "Tessaya", replacement: null, heard: ["Tisia"] },
    ]);
    expect(removeHeard(entries, "Tessaya", "Tisia").map((e) => e.heard)).toEqual([["Tessa"]]);
  });
});

describe("the voice command", () => {
  it("finds the word to add", () => {
    expect(parseAddToDictionary("Add Kubernetes to my dictionary")).toBe("Kubernetes");
    expect(parseAddToDictionary("Baton, please add “Wispr Flow” to the vocabulary.")).toBe(
      "Wispr Flow",
    );
    expect(parseAddToDictionary("add the milk to the shopping list")).toBeNull();
  });
});

describe("learning from his corrections", () => {
  it("learns a heard form from one fix, the rule from two, and ignores rewrites", () => {
    // A span he typed over as one word is a correction; a swap that keeps the old words is not.
    expect(
      correctionsBetween(
        "Ask Sam about the Cooper Netties cluster",
        "Ask Sam about the Kubernetes cluster",
      ),
    ).toEqual([{ heard: "Cooper Netties", meant: "Kubernetes" }]);
    expect(correctionsBetween("Ask the git hub team", "Ask the GitHub team")).toEqual([
      { heard: "git hub", meant: "GitHub" },
    ]);
    expect(
      correctionsBetween(
        "Deploy it to Cooper Nettie today",
        "Deploy it to Cooper Kubernetes today",
      ),
    ).toEqual([]);
    expect(
      correctionsBetween("Send the deck to Sam", "Email it to the whole team instead"),
    ).toEqual([]);
    const one = correctionsBetween("Please call Tomas about it", "Please call Thomas about it");
    expect(one).toEqual([{ heard: "Tomas", meant: "Thomas" }]);
    let state = learnCorrection({}, [], one[0]!, NOW);
    expect(state.entries).toEqual([
      {
        phrase: "Thomas",
        replacement: null,
        source: "learned",
        count: 1,
        lastSeen: NOW,
        heard: ["Tomas"],
      },
    ]);
    expect(state.taught).toEqual(one);
    state = learnCorrection(state.seen, state.entries, one[0]!, NOW);
    expect(state.taught).toEqual([]);
    expect(state.entries).toMatchObject([
      { phrase: "Thomas", heard: ["Tomas"] },
      { phrase: "Tomas", replacement: "Thomas", source: "learned", count: 2 },
    ]);
    // Grammar is never taught, whatever its capitals or spacing.
    for (const fix of [
      { heard: "Their", meant: "There" },
      { heard: "in to", meant: "into" },
      { heard: "may be", meant: "maybe" },
    ])
      expect(
        learnCorrection({ [`${fix.heard.toLowerCase()}>${fix.meant}`]: 1 }, [], fix, NOW).entries,
      ).toEqual([]);
    // A dictation pasted after text already in the field, then shortened by his fix, is still found.
    expect(
      correctionsAtCaret(
        "Ask the git hub team today",
        "Notes from Monday. The build is green. Ask the GitHub team today",
      ),
    ).toEqual({
      fixes: [{ heard: "git hub", meant: "GitHub" }],
      fixed: "Ask the GitHub team today",
    });
    // Undo takes the form off, and the word with it when that form was all it had learned.
    expect(unteach(learnCorrection({}, [], one[0]!, NOW).entries, one[0]!)).toEqual([]);
    // After two fixes, Discard takes the literal rule too.
    expect(unteach(state.entries, one[0]!)).toEqual([]);
    const his = [{ phrase: "Tessaya", replacement: null, source: "added" as const, count: 4 }];
    const taught = learnCorrection({}, his, { heard: "Tisia", meant: "Tessaya" }, NOW);
    expect(taught.entries[0]?.heard).toEqual(["Tisia"]);
    expect(unteach(taught.entries, { heard: "Tisia", meant: "Tessaya" })).toEqual([
      { ...his[0], lastSeen: NOW },
    ]);
  });
});

describe("learning from his wording", () => {
  it("promotes a repeated name or term at the threshold and never a wake word or common word", () => {
    expect(
      candidateWords(
        "We shipped to Lahore. Then Monday we met Zohaib about GitHub2 and the Baton app.",
      ),
    ).toEqual(expect.arrayContaining(["Lahore", "Zohaib", "GitHub2", "Baton"]));
    let state = {
      seen: {} as Record<string, number>,
      entries: [] as ReturnType<typeof parseVocabulary>,
    };
    for (let i = 0; i < 3; i += 1) {
      state = observeWording(
        state.seen,
        state.entries,
        "We spoke to Zohaib and Baton today.",
        NOW,
        ["Baton"],
      );
    }
    expect(state.entries).toMatchObject([
      { phrase: "Zohaib", replacement: null, source: "learned", count: 3 },
    ]);
  });
});

describe("recognition bias", () => {
  it("puts a near-miss of a name right, and leaves ordinary words alone", () => {
    const entries = parseVocabulary([
      { phrase: "Zohaib", replacement: null },
      { phrase: "Kubernetes", replacement: null },
    ]);
    expect(biasTranscript("Ask Zohayb about Kubernetis and colour.", entries)).toBe(
      "Ask Zohaib about Kubernetes and colour.",
    );
  });
});

describe("what is never learned", () => {
  it("skips paths, files, URLs, code, numbers, acronyms and common names, and keeps real names", () => {
    const skipped: ReadonlyArray<readonly [string, string]> = [
      ["C:\\Users\\sam", "path"],
      ["src/app", "path"],
      ["report.pdf", "file"],
      ["main.ts", "file"],
      ["https://x.dev/a", "url"],
      ["www.example", "url"],
      ["example.com", "url"],
      ["my_var", "code"],
      ["a=b", "code"],
      ["2026", "number"],
      ["3.5", "number"],
      ["£40", "number"],
      ["API", "acronym"],
      ["NASA", "acronym"],
      ["Thomas", "common name"],
    ];
    for (const [word, why] of skipped) expect(skipWord(word), word).toBe(why);
    for (const fine of ["Kowalczyk", "Zohaib", "Kubernetes", "GitHub", "Tomas"])
      expect(skipWord(fine), fine).toBeNull();
  });

  it("never brings back a word he discarded, and reports what it added", () => {
    let never = addNever([], "Kowalczyk");
    expect(isNever(never, "kowalczyk")).toBe(true);
    let state = {
      seen: {} as Record<string, number>,
      entries: [] as ReturnType<typeof parseVocabulary>,
    };
    for (let i = 0; i < 4; i += 1) {
      const next = observeWording(
        state.seen,
        state.entries,
        "We met Kowalczyk and Zohaib today.",
        NOW,
        [],
        never,
      );
      state = { seen: next.seen, entries: next.entries };
    }
    expect(state.entries.map((e) => e.phrase)).toEqual(["Zohaib"]);
    never = [];
    let seen = {} as Record<string, number>;
    let added: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const next = observeWording(seen, [], "Then Kowalczyk wrote.", NOW);
      seen = next.seen;
      added = next.added.map((e) => e.phrase);
    }
    expect(added).toEqual(["Kowalczyk"]);
    // A correction to a discarded word is dropped too.
    const fix = learnCorrection(
      { "kowalchick>Kowalczyk": 1 },
      [],
      { heard: "Kowalchick", meant: "Kowalczyk" },
      NOW,
      ["Kowalczyk"],
    );
    expect(fix.entries).toEqual([]);
    expect(fix.added).toEqual([]);
  });
});
