// @effect-diagnostics globalDate:off
import { computeDeepInsights } from "@t3tools/tessaya-shared/insightsDeep";
import { describe, expect, it } from "vite-plus/test";

import { tabOf } from "../home/tabs.ts";
import { insightControls } from "./insightRows.ts";

const now = Date.parse("2026-11-02T12:00:00");

describe("the Insights area", () => {
  it("says it has nothing yet rather than showing zeros", () => {
    expect(insightControls(null)[0]).toMatchObject({ id: "in.none" });
  });
  it("shows speed, words, fixes, streak, the calendar and usage by kind of app, all on the Insights tab", () => {
    const turn = (days: number, raw: string, cleaned: string) => ({
      at: new Date(now - days * 86_400_000).toISOString(),
      kind: "dictation" as const,
      app: "slack.exe",
      raw,
      cleaned,
      seconds: 30,
    });
    const rows = insightControls(
      computeDeepInsights([turn(1, "um hello there", "Hello there."), turn(2, "ok", "OK.")], now),
    );
    for (const r of rows) expect(tabOf(r.id)).toBe("insights");
    expect(rows.map((r) => r.id)).toEqual([
      "in.speed",
      "in.words",
      "in.fixes",
      "in.streak",
      "in.calendar",
      "in.cat:0",
    ]);
    const cal = rows.find((r) => r.id === "in.calendar");
    expect(cal?.kind === "heat" && cal.cells.filter((c) => c.level > 0)).toHaveLength(2);
    expect(rows.find((r) => r.id === "in.cat:0")).toMatchObject({ label: "Work messages" });
  });
});

describe("the voice profile rows", () => {
  it("are absent until there is a dictation, and then say how he dictates", async () => {
    const { voiceProfileControls } = await import("./insightRows.ts");
    const { computeVoiceProfile } = await import("@t3tools/tessaya-shared/voiceProfile");
    expect(voiceProfileControls(null)).toEqual([]);
    const p = computeVoiceProfile([
      {
        at: "2026-11-02T10:00:00",
        kind: "dictation",
        raw: "um hello there",
        cleaned: "Hello there.",
        seconds: 3,
        corrected: false,
        fixed: null,
      },
    ]);
    const rows = voiceProfileControls(p);
    expect(rows.map((r) => r.label)).toEqual([
      "How you dictate",
      "Filler words",
      "What Tessaya changes",
      "Words you keep correcting",
    ]);
    expect(rows.every((r) => r.section === "Your voice")).toBe(true);
  });
});
