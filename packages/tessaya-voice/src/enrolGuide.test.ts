import { describe, expect, it } from "vite-plus/test";

import {
  alignHeard,
  createEnrolGuide,
  enrolScript,
  ISSUE_LINE,
  oddVoice,
  sameWord,
  scriptName,
  takeIssue,
} from "./enrolGuide.ts";

const tone = (ms: number, amplitude: number) =>
  Int16Array.from({ length: (ms * 16_000) / 1000 }, (_, i) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * 180 * i) / 16_000)),
  );
const hiss = (ms: number, amplitude = 40) =>
  Int16Array.from({ length: (ms * 16_000) / 1000 }, (_, i) =>
    i % 2 === 0 ? amplitude : -amplitude,
  );
const unit = (...v: number[]) => {
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
};

const guide = (sentences = ["one two three four five six", "seven eight nine ten", "a b c d"]) =>
  createEnrolGuide({
    sentences,
    title: "Read these aloud",
    lead: "",
    mic: "Desk mic",
    tip: "Enrol on the R1 too.",
    otherVoiceBelow: 0.36,
    strongFrom: 0.68,
  });

/** Room hum, then a read of `ms` at `amplitude`, then a pause long enough to end the sentence. */
const read = (g: ReturnType<typeof guide>, ms: number, amplitude = 3_000) => {
  g.frame(hiss(400));
  g.frame(tone(ms, amplitude));
  return g.frame(hiss(800));
};

describe("alignHeard", () => {
  const sentence =
    "Please move Thursday's meeting to half past ten and remind me the night before.";
  it.each([
    ["", 0],
    ["please move thursdays meeting", 4],
    // A misread word is skipped: "meting" and "sheeting" still land on the right words.
    ["please move thursdays sheeting to half", 6],
    ["please move", 2],
    // Words it cannot place still move the highlight, three behind what was heard.
    ["blah blah blah blah blah blah blah", 4],
    ["please move thursday's meeting to half past ten and remind me the night before and more", 14],
  ])("%j reaches %i", (heard, reached) => {
    expect(alignHeard(sentence, heard)).toBe(reached);
  });

  it("matches her name and possessives as a recogniser writes them", () => {
    expect(sameWord("tessaya", "tessa")).toBe(true);
    expect(sameWord("thursdays", "thursday")).toBe(true);
    expect(sameWord("ten", "two")).toBe(false);
    expect(alignHeard("Hi Tessaya, it's me", "hi tessa its me")).toBe(4);
  });

  it("puts a real first name in the script and nothing else", () => {
    expect(scriptName("maya")).toBe("Maya");
    expect(scriptName("dev")).toBeNull();
    expect(scriptName("admin1")).toBeNull();
    expect(enrolScript("Maya")[0]).toContain("it's Maya");
    expect(enrolScript(null)[0]).toContain("it's me");
  });
});

describe("takeIssue", () => {
  it.each([
    [{ speechRms: 3_000, noiseRms: 50, clipShare: 0 }, null],
    [{ speechRms: 300, noiseRms: 20, clipShare: 0 }, "quiet"],
    [{ speechRms: 9_000, noiseRms: 50, clipShare: 0.01 }, "loud"],
    [{ speechRms: 2_000, noiseRms: 700, clipShare: 0 }, "noisy"],
  ] as const)("%j is %s", (stats, issue) => {
    expect(takeIssue(stats)).toBe(issue);
  });

  it("finds the one voice unlike the rest, and only with three to compare", () => {
    const me = new Map([
      [0, unit(1, 0.1, 0)],
      [1, unit(1, 0, 0.1)],
    ]);
    expect(oddVoice(me, 0.36)).toBeNull();
    expect(oddVoice(new Map([...me, [2, unit(0, 1, 0)]]), 0.36)).toBe(2);
    expect(oddVoice(new Map([...me, [2, unit(1, 0.05, 0.05)]]), 0.36)).toBeNull();
  });
});

describe("createEnrolGuide", () => {
  it("moves on at his pause once the sentence is read, keeping only his speech", () => {
    const g = guide();
    expect(g.view().lines.map((l) => l.state)).toEqual(["now", "todo", "todo"]);
    const { no } = g.take();
    g.frame(hiss(400));
    g.frame(tone(1_000, 3_000));
    expect(g.heard("one two three four", no)).toBe(true);
    expect(g.view().lines[0]!.heard).toBe(4);
    // A late transcription of an older take is dropped.
    expect(g.heard("one two three four five six", no - 1)).toBe(false);
    g.frame(tone(400, 3_000));
    g.heard("one two three four five six", no);
    const step = g.frame(hiss(800));
    expect(step.accepted?.index).toBe(0);
    // 180 ms before he started, his 1.4 s, and none of the pause after it.
    expect(step.accepted!.pcm.length).toBe(16 * (180 + 1_400));
    expect(g.view().lines.map((l) => l.state)).toEqual(["done", "now", "todo"]);
  });

  it("waits through a pause mid-sentence when too little was read", () => {
    const g = guide();
    expect(read(g, 700).accepted).toBeNull();
    expect(g.view().lines[0]!.state).toBe("now");
    // Speaking long enough counts even when the recogniser heard nothing: it never stalls.
    expect(read(g, 1_000).accepted?.index).toBe(0);
  });

  it("hears the R1's quiet mic with its own floors, and moves on when his last words land after the pause", () => {
    const desk = guide();
    const r1 = createEnrolGuide({
      sentences: ["one two three four five six"],
      title: "",
      lead: "",
      mic: "R1",
      tip: null,
      otherVoiceBelow: 0.36,
      strongFrom: 0.68,
      floors: { speech: 30, quiet: 60 },
    });
    // His voice on the R1 on 13 Nov: block RMS about 250 over a room at 3.
    const quietRead = (g: ReturnType<typeof guide>) => {
      g.frame(hiss(400, 3));
      g.frame(tone(1_000, 350));
      return g.frame(hiss(800, 3));
    };
    expect(quietRead(desk).accepted).toBeNull();
    expect(desk.view().lines[0]!.state).toBe("now");
    const { no } = r1.take();
    expect(quietRead(r1).accepted).toBeNull();
    r1.heard("one two three four five", no);
    expect(r1.frame(hiss(100, 3)).accepted?.index).toBe(0);
  });

  it("asks for that one sentence again, saying why, and nothing else", () => {
    const g = guide();
    read(g, 2_000);
    read(g, 2_000, 450);
    const view = g.view();
    expect(view.lines.map((l) => l.state)).toEqual(["done", "again", "todo"]);
    expect(view.lines[1]!.why).toBe(ISSUE_LINE.quiet);
    expect(read(g, 2_000).accepted?.index).toBe(1);
    expect(g.view().lines[1]!.why).toBeNull();
  });

  it("flags a clipped read as too loud", () => {
    const g = guide();
    read(g, 2_000, 32_767);
    expect(g.view().lines[0]!.why).toBe(ISSUE_LINE.loud);
  });

  it("sends back a sentence in another voice, then is ready once every vector is in", () => {
    const g = guide();
    for (const i of [0, 1, 2]) expect(read(g, 2_000).accepted?.index).toBe(i);
    expect(g.voice(0, unit(1, 0.1, 0)).ready).toBe(false);
    expect(g.voice(1, unit(1, 0, 0.1)).ready).toBe(false);
    const odd = g.voice(2, unit(0, 1, 0));
    expect(odd.ready).toBe(false);
    expect(g.view().lines[2]!.why).toBe(ISSUE_LINE.otherVoice);
    expect(read(g, 2_000).accepted?.index).toBe(2);
    expect(g.voice(2, unit(1, 0.05, 0.05)).ready).toBe(true);
    expect(g.phase()).toBe("saving");
    expect(g.clips()).toHaveLength(3);
    g.finish({ saved: true, headline: "Your voice profile is ready" });
    const summary = g.view().summary!;
    expect(summary.quality).toBe(3);
    expect(summary.rows).toContainEqual({
      label: "Read again",
      value: "1 sentence (another voice)",
    });
    expect(summary.tip).toBe("Enrol on the R1 too.");
    g.restart();
    expect(g.view().lines.map((l) => l.state)).toEqual(["now", "todo", "todo"]);
    expect(g.view().summary).toBeNull();
  });
});
