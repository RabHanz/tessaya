/**
 * Pulse decisions: digests a review really sees, and the actions a good answer may take. Most are "stay quiet":
 * the eval fails a model that speaks on routine events as surely as one that misses a failure.
 */
import type {
  PulseAction,
  PulseEvent,
  PulseWorld,
} from "../../packages/tessaya-shared/src/pulse.ts";

export interface PulseCase {
  readonly id: string;
  readonly digest: ReadonlyArray<PulseEvent>;
  readonly world?: Partial<PulseWorld>;
  readonly level?: "lively" | "calm" | "important";
  /** Answers that pass. */
  readonly ok: ReadonlyArray<PulseAction>;
  /** For speak or ask: the answer must cite this id. */
  readonly about?: string;
}

const NOW = Date.UTC(2026, 10, 16, 11, 0);
const ev = (id: string, over: Partial<PulseEvent>): PulseEvent => ({
  id,
  category: "sessions",
  text: "",
  at: NOW,
  member: null,
  weight: 40,
  urgent: false,
  told: false,
  ...over,
});

export const PULSE_CASES: ReadonlyArray<PulseCase> = [
  {
    id: "routine-done-told",
    digest: [ev("j1", { category: "jobs", text: 'Job "Docs": done', told: true })],
    ok: ["nothing", "note"],
  },
  {
    id: "someone-arrived",
    digest: [
      ev("p1", { category: "people", text: "owner just arrived near tessel-1", weight: 35 }),
    ],
    ok: ["nothing", "note"],
  },
  {
    id: "mood-drift",
    digest: [
      ev("m1", { category: "mood", text: "Her mood moved from calm to content", weight: 20 }),
    ],
    ok: ["nothing", "note"],
  },
  {
    id: "device-chatter",
    digest: [
      ev("d1", { category: "home", text: "Hall lamp: on", weight: 25 }),
      ev("d2", { category: "home", text: "Tessel-1: battery 80%", weight: 25 }),
    ],
    ok: ["nothing", "note"],
  },
  {
    id: "session-waiting",
    digest: [
      ev("wait:s1", {
        text: "The release session has been waiting for you 25 min.",
        weight: 75,
        urgent: true,
      }),
    ],
    ok: ["speak", "ask"],
    about: "wait:s1",
  },
  {
    id: "reminder-due-quiet-hours",
    digest: [
      ev("commit:c1", {
        category: "reminders",
        text: "Due: call the bank about the card",
        weight: 75,
        urgent: true,
      }),
    ],
    world: { quiet: true, localTime: "Mon 07:30" },
    ok: ["speak", "ask"],
    about: "commit:c1",
  },
  {
    id: "failure-in-quiet-hours",
    digest: [
      ev("fail:s2", {
        text: "The nightly build session failed 5 min ago.",
        weight: 85,
        urgent: true,
      }),
    ],
    world: { quiet: true, localTime: "Tue 02:10" },
    ok: ["nothing", "note"],
  },
  {
    id: "already-said",
    digest: [ev("j2", { category: "jobs", text: 'Job "Deploy": failed', weight: 80, told: true })],
    world: { localTime: "Mon 15:00" },
    ok: ["nothing", "note", "ask"],
  },
  {
    id: "important-only-middling",
    level: "important",
    digest: [
      ev("cal:1", { category: "calendar", text: "Coming up Friday: Sara's birthday", weight: 35 }),
    ],
    ok: ["nothing", "note"],
  },
  {
    id: "lively-birthday-tomorrow",
    level: "lively",
    digest: [
      ev("cal:2", {
        category: "calendar",
        text: "Coming up tomorrow: Sara's birthday",
        weight: 35,
      }),
    ],
    ok: ["speak", "ask", "act", "note"],
  },
  {
    id: "pattern-hypothesis",
    digest: [
      ev("pattern:stall:16", {
        category: "patterns",
        text: "Hypothesis (confidence 0.72): Sessions often stall or fail between 16:00 and 18:00 (6 of 9 in two weeks, on 5 days).",
        weight: 43,
      }),
    ],
    world: { localTime: "Wed 15:50" },
    ok: ["nothing", "note", "ask"],
  },
  {
    id: "mixed-noise-and-one-signal",
    digest: [
      ev("d3", { category: "home", text: "Kitchen light: off", weight: 25 }),
      ev("m2", { category: "mood", text: "Her mood moved from content to calm", weight: 20 }),
      ev("msg:1", {
        category: "messages",
        text: "Message: a note from Amna waiting (received)",
        weight: 65,
      }),
    ],
    ok: ["speak", "ask", "note"],
  },
];
