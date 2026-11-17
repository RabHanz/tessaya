import { describe, expect, it } from "vite-plus/test";

import { admit, askedKey, faultsOf, feedEventOf } from "./problemReport.ts";
import { toEnvelope, type ActionInput } from "./provenance.ts";

const ev = (input: ActionInput) =>
  toEnvelope(input, { id: "e1", at: 1_000, origin: "env-a", cause: [] });

describe("the feed's events", () => {
  it("never carry his words, a sentence, a nested value or a private event", () => {
    const e = feedEventOf(
      ev({
        kind: "room.voice_id",
        actor: { kind: "owner", id: "owner", certainty: 0.9 },
        data: {
          vessel: "t1",
          asrMs: 640,
          speaker: "owner",
          text: "my bank pin is 1234",
          reason: "he said something private here",
          nested: { text: "hidden" },
        },
      }),
    );
    expect(e).toMatchObject({ vessel: "t1", data: { vessel: "t1", asrMs: 640, speaker: "owner" } });
    expect(JSON.stringify(e)).not.toMatch(/bank|private|hidden/);
    expect(feedEventOf(ev({ kind: "private", actor: { kind: "owner", certainty: 1 } }))).toBe(null);
    expect(feedEventOf(ev({ kind: "rpc.call", actor: { kind: "owner", certainty: 1 } }))).toBe(
      null,
    );
  });
});

describe("faults", () => {
  const finding = (rule: string, key: string) =>
    ({ rule, key, title: `t ${key}`, count: 3, firstAt: 0, lastAt: 1, eventIds: ["x"] }) as never;

  it("are the log's bug rules and a degraded health cause that held the beat before, not a blip", () => {
    const diagnosis = {
      severity: "down" as const,
      summary: "",
      findings: [
        {
          key: "loop:t1",
          severity: "down" as const,
          says: "the loop stopped",
          evidence: ["no report"],
          fix: null,
          symptoms: [],
        },
        {
          key: "memory:box",
          severity: "degraded" as const,
          says: "box swaps",
          evidence: [],
          fix: null,
          symptoms: [],
        },
        {
          key: "wifi:t1",
          severity: "degraded" as const,
          says: "weak wifi",
          evidence: [],
          fix: null,
          symptoms: [],
        },
      ],
    };
    const faults = faultsOf({
      findings: [finding("double_turn", "double_turn|t1"), finding("uncaused_state_change", "x")],
      diagnosis,
      heldBefore: new Set(["loop:t1", "wifi:t1"]),
    });
    expect(faults.map((f) => f.key)).toEqual(["double_turn|t1", "health:loop:t1"]);
    expect(faults[0]!.vessel).toBe("t1");
  });
});

describe("admit", () => {
  const now = 10 * 86_400_000;
  const row = (key: string, ago: number, source: "asked" | "proactive" = "proactive") => ({
    key,
    at: now - ago,
    source,
    status: "open" as const,
  });

  it("drops the same cause within a day and caps her own reports, never one he asked for", () => {
    expect(admit("a", "proactive", [row("a", 3_600_000)], now)).toBe("duplicate");
    expect(admit("a", "proactive", [row("a", 2 * 86_400_000)], now)).toBe("ok");
    const busy = [row("b", 60_000), row("c", 60_000), row("d", 60_000)];
    expect(admit("e", "proactive", busy, now)).toBe("rate-limited");
    expect(admit("e", "asked", busy, now)).toBe("ok");
    expect(admit("a", "proactive", [{ ...row("a", 60_000), status: "deleted" }], now)).toBe("ok");
  });

  it("keys an ask by its words, so asking twice is one report", () => {
    expect(askedKey("She answered TWICE!", "t1")).toBe(askedKey("she answered twice", "t1"));
  });
});
