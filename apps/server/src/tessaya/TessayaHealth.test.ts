import { describe, expect, it } from "vite-plus/test";

import { loginMismatch } from "./TessayaHealth.ts";

const account = (active: boolean, headroomPercent: number) =>
  ({
    key: active ? "6" : "5",
    label: active ? "acct6" : "acct5",
    email: null,
    organizationName: null,
    active,
    usable: true,
    unusableReason: null,
    headroomPercent,
    windows: [],
    usageCheckedAt: null,
  }) as const;

describe("her login against the active account", () => {
  it("raises a spent login while the active account has room, and nothing when they agree", () => {
    const pool = { accounts: [account(true, 97), account(false, 0)] };
    // 21 Nov: ~/.claude held a spent login while the active account had 97% left.
    expect(loginMismatch({ until: "Nov 23, 6pm" }, pool)?.note).toContain(
      "the machine login is not that account",
    );
    // The active account is spent too: her answer is true, nothing to raise.
    expect(loginMismatch({ until: "Nov 23" }, { accounts: [account(true, 3)] })).toBeNull();
    // Nothing spent lately: nothing to compare.
    expect(loginMismatch(null, pool)).toBeNull();
  });
});
