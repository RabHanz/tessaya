import { DEFAULT_RETENTION } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeRetention, expiredRecords } from "./retention.ts";

describe("retention", () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  // Fixed dates rather than arithmetic on a clock: the repository routes date
  // handling through Effect's `DateTime`, and a fixture does not need one.
  const TWO_DAYS_AGO = "2026-09-16T00:00:00.000Z";
  const FORTY_DAYS_AGO = "2026-08-09T00:00:00.000Z";
  const NINETY_DAYS_AGO = "2026-06-20T00:00:00.000Z";

  it("deletes what is past the horizon and nothing else", () => {
    const expired = expiredRecords({
      records: [
        { id: "old", at: FORTY_DAYS_AGO, refused: false },
        { id: "fresh", at: TWO_DAYS_AGO, refused: false },
      ],
      days: 30,
      keepRefusals: true,
      now,
    });
    expect(expired).toEqual(["old"]);
  });

  it("keeps refusals when the policy says to", () => {
    // A log that keeps only what worked cannot show a grammar its blind spots.
    const records = [{ id: "refused", at: NINETY_DAYS_AGO, refused: true }];
    expect(expiredRecords({ records, days: 30, keepRefusals: true, now })).toEqual([]);
    expect(expiredRecords({ records, days: 30, keepRefusals: false, now })).toEqual(["refused"]);
  });

  it("keeps a row whose date it cannot read", () => {
    // Deleting something because its timestamp would not parse is the wrong
    // way round.
    expect(
      expiredRecords({
        records: [{ id: "broken", at: "not a date", refused: false }],
        days: 1,
        keepRefusals: true,
        now,
      }),
    ).toEqual([]);
  });

  it("says what it keeps, in words a settings screen can show", () => {
    expect(describeRetention(DEFAULT_RETENTION)).toBe(
      "Tessaya keeps sentences for 30 days, rule firings for 90 days, and refusals are kept.",
    );
    expect(describeRetention({ intentDays: 0, firingDays: 0, keepRefusals: false })).toBe(
      "Tessaya keeps sentences are not kept, rule firings are not kept.",
    );
  });
});
