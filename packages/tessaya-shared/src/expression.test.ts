import { describe, expect, it } from "vite-plus/test";

import {
  LINE_EVENTS,
  LINE_EVENT_IDS,
  LINE_POOL,
  RECENT_KEEP,
  fillLine,
  keptLines,
  lineId,
  lineProblem,
  mayExpress,
  pickLine,
  poolLines,
  remember,
  type Line,
  type LineEvent,
} from "./expression.ts";

const l = (text: string, more: Partial<Line> = {}): Line => ({
  text,
  mood: "neutral",
  gesture: "none",
  ...more,
});

describe("the guard on a wording", () => {
  it.each<[LineEvent, string, string | null]>([
    ["job.done", "{title} is finished.", null],
    ["job.done", "It's finished.", "drops {title}"],
    ["job.done", "{title} is done, {title}!", "repeats {title}"],
    ["job.done", "{title} is done for {name}.", "invents {name}"],
    ["job.done", "{title} took 3 minutes.", "a number outside a slot"],
    [
      "ok.done",
      "All done and dusted, my friend, nothing left now to do here.",
      "longer than 4 words",
    ],
    ["filler.web", "Let me think about that.", "narrates her reasoning"],
    ["alarm.clear", "{label} is over, all clear.", 'leaves out "false alarm"'],
    ["alarm.clear", "False alarm. {label} has ended; all clear, everyone.", null],
    ["ok.sentphone", "That's waiting on your phone for a yes.", null],
    ["ok.sentphone", "That's waiting for you.", 'leaves out "phone"'],
    ["ack.name", "Mm-hm?\nYes?", "more than one line"],
  ])("%s %j → %s", (event, text, problem) => {
    expect(lineProblem(event, l(text))).toBe(problem);
  });

  it("rejects a mood or gesture no vessel can show", () => {
    expect(lineProblem("ack.name", l("Yes?", { mood: "giddy" as never }))).toBe("an unknown mood");
    expect(lineProblem("ack.name", l("Yes?", { gesture: "moonwalk" as never }))).toBe(
      "an unknown gesture",
    );
  });

  it("passes every event's own plain line, so the fallback is always sayable", () => {
    for (const event of LINE_EVENT_IDS) {
      const s = LINE_EVENTS[event];
      if (s.fixed === "") continue;
      expect([event, lineProblem(event, l(s.fixed, { mood: s.mood, gesture: s.gesture }))]).toEqual(
        [event, null],
      );
    }
  });

  it("keeps every id short enough for the R1 line pack", () => {
    for (const event of LINE_EVENT_IDS) expect(event.length).toBeLessThanOrEqual(16);
  });

  it("passes every shipped pool line", () => {
    for (const [persona, events] of Object.entries(LINE_POOL))
      for (const [event, lines] of Object.entries(events))
        for (const line of lines ?? [])
          expect([persona, event, line.text, lineProblem(event as LineEvent, line)]).toEqual([
            persona,
            event,
            line.text,
            null,
          ]);
  });
});

describe("facts", () => {
  it("fills slots with the exact value, including characters a model would change", () => {
    expect(
      fillLine("From {from}: {text}", { from: "Zara", text: "Dinner's at 7:30 — {not a slot}" }),
    ).toBe("From Zara: Dinner's at 7:30 — {not a slot}");
  });
  it("is null when a fact is missing, so the caller never says a hole", () => {
    expect(fillLine("{title} is done.", {})).toBeNull();
  });
});

describe("no repeats", () => {
  const set = [l("Yes?"), l("Mm?"), l("Go on.")];
  it("never picks a wording among the recent ones while another is left", () => {
    const recent = [lineId("ack.name", "Yes?"), lineId("ack.name", "Mm?")];
    for (const r of [0, 0.5, 0.99])
      expect(pickLine("ack.name", set, recent, "morning", r)?.text).toBe("Go on.");
  });
  it("falls back to the one said longest ago once all were said", () => {
    const recent = ["Mm?", "Yes?", "Go on."].map((t) => lineId("ack.name", t));
    expect(pickLine("ack.name", set, recent, "morning", 0)?.text).toBe("Mm?");
  });
  it("keeps a wording for its hour", () => {
    expect(pickLine("ack.name", [l("Morning.", { when: "morning" })], [], "evening", 0)).toBeNull();
  });
  it("treats case and punctuation as the same wording", () => {
    expect(lineId("ack.name", "Yes?")).toBe(lineId("ack.name", "yes"));
    expect(lineId("ack.name", "Yes?")).not.toBe(lineId("ok.done", "Yes?"));
  });
  it("remembers the newest last, once, and only so many", () => {
    let recent: ReadonlyArray<string> = [];
    for (let i = 0; i < RECENT_KEEP + 5; i++)
      recent = remember(recent, `x${i % (RECENT_KEEP + 2)}`);
    expect(recent.length).toBe(RECENT_KEEP);
    expect(remember(["a", "b"], "a")).toEqual(["b", "a"]);
  });
  it("drops model wordings that fail the guard or repeat one already held", () => {
    const kept = keptLines(
      "job.done",
      [
        { text: "{title}: finished.", mood: "proud", gesture: "hop" },
        { text: "{title}: finished!", mood: "proud", gesture: "hop" },
        { text: "All finished.", mood: "proud", gesture: "hop" },
        { text: "{title} wrapped up.", mood: "happy", gesture: "nodSmall" },
      ],
      [l("{title} wrapped up.")],
      "evening",
    );
    expect(kept.map((k) => [k.text, k.when])).toEqual([["{title}: finished.", "evening"]]);
  });
});

describe("the chatter dial and quiet", () => {
  const at = (motion: "lively" | "calm" | "important", quiet = false, busy = false) => ({
    motion,
    quiet,
    busy,
  });
  it("always answers him and always plays safety", () => {
    expect(mayExpress("normal", at("important", true, true))).toBe(true);
    expect(mayExpress("safety", at("important", true, true))).toBe(true);
  });
  it("holds unprompted lines through quiet hours, calls and sessions", () => {
    expect(mayExpress("important", at("lively", true))).toBe(false);
    expect(mayExpress("ambient", at("lively", false, true))).toBe(false);
  });
  it("keeps ambient lines to the face on important only", () => {
    expect(mayExpress("ambient", at("important"))).toBe(false);
    expect(mayExpress("ambient", at("calm"))).toBe(true);
    expect(mayExpress("important", at("important"))).toBe(true);
  });
});

describe("the pool", () => {
  it("uses the lead's wordings for a persona without its own", () => {
    const pool = { executive: { "ok.done": [l("Sorted.")] } };
    expect(poolLines("marketing", "ok.done", pool).map((x) => x.text)).toEqual(["Sorted."]);
    expect(poolLines("marketing", "ack.name", pool)).toEqual([]);
  });
});
