import {
  accountForInstance,
  setClaudeAccountInstances,
  type BatonAccount,
} from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { accountDisplayName, limitsFromAccount, withAccount } from "./ClaudeProbeLimits.ts";

const account = (overrides: Partial<BatonAccount>): BatonAccount => ({
  key: "4",
  label: "robin",
  email: null,
  organizationName: null,
  active: false,
  usable: true,
  unusableReason: null,
  headroomPercent: 77,
  windows: [
    { id: "five_hour", label: "5h", usedPercent: 4, resetsAt: "2026-10-30T20:50:00.000Z" },
    { id: "seven_day", label: "7d", usedPercent: 23, resetsAt: null },
    { id: "seven_day_opus", label: "7d (large model)", usedPercent: 10, resetsAt: null },
  ],
  usageCheckedAt: "2026-10-30T17:42:49.000Z",
  ...overrides,
});

setClaudeAccountInstances({
  claudeAgent_robin: "4",
  claudeAgent_optima: "5",
  claudeAgent_sablebox: "6",
});

describe("accountForInstance", () => {
  const pool = [
    account({ active: true }),
    account({ key: "5", label: "optima" }),
    account({ key: "6", label: "sablebox" }),
  ];

  it("gives a token instance its own slot, whoever is active", () => {
    expect(accountForInstance("claudeAgent_optima", pool)?.label).toBe("optima");
    expect(accountForInstance("claudeAgent_sablebox", pool)?.label).toBe("sablebox");
  });

  it("gives the default instance the active account", () => {
    expect(accountForInstance("claudeAgent", pool)?.label).toBe("robin");
  });
});

describe("limitsFromAccount", () => {
  it("keeps the reading's own time and T3's session and weekly windows", () => {
    const limits = limitsFromAccount(account({}));
    expect(limits?.checkedAt).toBe("2026-10-30T17:42:49.000Z");
    expect(limits?.unavailable).toBeUndefined();
    expect(limits?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 4],
      ["seven_day", 23],
    ]);
    expect(limits?.windows[0]?.resetsAt).toBe("2026-10-30T20:50:00.000Z");
    expect(limits?.windows[1]).not.toHaveProperty("resetsAt");
  });

  it("fingerprints the slot alone, so every machine's instance merges into one account", () => {
    expect(limitsFromAccount(account({ key: "5" }))?.credentialFingerprint).toBe("5");
  });

  it("offers nothing rather than an empty reading", () => {
    expect(limitsFromAccount(undefined)).toBeUndefined();
    expect(limitsFromAccount(account({ usageCheckedAt: null }))).toBeUndefined();
    expect(limitsFromAccount(account({ windows: [] }))).toBeUndefined();
  });
});

describe("accountDisplayName", () => {
  it("reads as a name", () => {
    expect(accountDisplayName(account({}))).toBe("Robin");
  });
});

describe("withAccount", () => {
  const provider = { auth: { status: "authenticated", email: "someone@example.com" } };

  it("names the instance and keys it on the account, not the box's login", () => {
    const next = withAccount(
      provider,
      account({ email: "setup-token-4@token.local" }),
    ) as typeof provider & {
      displayName: string;
      usageLimits: { credentialFingerprint: string };
    };
    expect(next.displayName).toBe("Robin");
    expect(next.usageLimits.credentialFingerprint).toBe("4");
    expect(next.auth).toEqual({ status: "authenticated", email: "setup-token-4@token.local" });
  });

  it("changes nothing without a reading", () => {
    expect(withAccount(provider, account({ usageCheckedAt: null }))).toBe(provider);
  });
});
