import { describe, expect, it } from "vite-plus/test";

import { conversationOf, HISTORY_LINES } from "./conversationHistory.ts";
import type { TranscriptLine } from "./TessayaTurn.ts";

const line = (
  conversation: string,
  role: "them" | "her",
  who: string | null,
  text: string,
  at = 0,
): TranscriptLine => ({ at, vessel: "tumble", conversation, role, who, text, private: 0 });

describe("conversationOf", () => {
  it("keeps every line of the conversations the person spoke in, and nobody else's", () => {
    const rows = [
      line("person:owner", "them", "owner", "Morning"),
      line("person:owner", "her", null, "Morning. It's raining."),
      line("person:sara", "them", "sara", "Hi"),
      line("person:sara", "her", null, "Hi Sara"),
      line("household", "her", null, "Bins tonight"),
    ];
    expect(conversationOf(rows, "owner", true).map((r) => r.text)).toEqual([
      "Morning",
      "Morning. It's raining.",
    ]);
    expect(conversationOf(rows, "sara", false).map((r) => r.text)).toEqual(["Hi", "Hi Sara"]);
    expect(conversationOf(rows, "guest", false)).toEqual([]);
  });

  it("gives a member of a shared conversation only their own exchanges, the owner all of it", () => {
    const rows = [
      line("household", "them", "owner", "Lights off", 1),
      line("household", "her", null, "Done", 1),
      line("household", "them", "sara", "Is it raining?", 2),
      line("household", "her", null, "Until ten", 2),
    ];
    expect(conversationOf(rows, "sara", false).map((r) => r.text)).toEqual([
      "Is it raining?",
      "Until ten",
    ]);
    expect(conversationOf(rows, "owner", true)).toHaveLength(4);
  });

  it("keeps only the newest lines when the window is long", () => {
    const rows = Array.from({ length: HISTORY_LINES + 5 }, (_, i) =>
      line("person:owner", "them", "owner", `${i}`),
    );
    const kept = conversationOf(rows, "owner", true);
    expect(kept).toHaveLength(HISTORY_LINES);
    expect(kept.at(-1)?.text).toBe(`${HISTORY_LINES + 4}`);
  });
});
