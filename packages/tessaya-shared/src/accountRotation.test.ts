import type { TessayaAccount, TessayaAccountPool } from "@t3tools/tessaya-contracts";
import { ProviderDriverKind } from "@t3tools/tessaya-contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountStanding,
  decideRotation,
  deferNearLimit,
  DEFAULT_ROTATION_THRESHOLDS,
  instancePool,
  rankRotationTargets,
  rotationLine,
} from "./accountRotation.ts";

const NOW = "2026-09-18T18:00:00.000Z";

const account = (input: Partial<TessayaAccount> & { readonly key: string }): TessayaAccount => ({
  label: input.key,
  email: `${input.key}@example.com`,
  organizationName: null,
  active: false,
  usable: true,
  unusableReason: null,
  headroomPercent: 80,
  windows: [],
  usageCheckedAt: NOW,
  ...input,
});

const pool = (accounts: ReadonlyArray<TessayaAccount>): TessayaAccountPool => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  source: "cswap",
  configDir: "/home/dev/.claude",
  accounts,
  checkedAt: NOW,
});

describe("rankRotationTargets", () => {
  it("puts the most headroom first and leaves out what cannot be used", () => {
    const ranked = rankRotationTargets(
      pool([
        account({ key: "1", active: true, headroomPercent: 2 }),
        account({ key: "2", usable: false, unusableReason: "signed-out", headroomPercent: null }),
        account({ key: "3", headroomPercent: 55 }),
        account({ key: "4", headroomPercent: 94 }),
        // Limits that could not be read are not evidence of headroom.
        account({ key: "5", headroomPercent: null }),
      ]),
      20,
    );
    expect(ranked.map((entry) => entry.key)).toEqual(["4", "3"]);
  });
});

describe("decideRotation", () => {
  const spent = account({ key: "3", active: true, headroomPercent: 1, label: "optima" });
  const fresh = account({ key: "1", headroomPercent: 79, label: "sablebox" });
  const deadLogin = account({
    key: "2",
    usable: false,
    unusableReason: "signed-out",
    headroomPercent: null,
    label: "robin",
  });

  it("moves to the account with the most room when the provider says the current one is spent", () => {
    const decision = decideRotation({
      pool: pool([spent, deadLogin, fresh]),
      policy: "auto",
      lastAutoRotationAt: null,
      sourceWindowResetsAt: "2026-09-21T13:00:00.000Z",
      limitReached: true,
      now: NOW,
    });
    expect(decision).toMatchObject({ outcome: "rotate", reason: "limit" });
    expect(decision.outcome === "rotate" ? decision.target.key : null).toBe("1");
  });

  it.each(["ask", "hold"] as const)("does nothing on its own when the policy is %s", (policy) => {
    expect(
      decideRotation({
        pool: pool([spent, fresh]),
        policy,
        lastAutoRotationAt: null,
        sourceWindowResetsAt: null,
        limitReached: true,
        now: NOW,
      }),
    ).toEqual({ outcome: "hold", reason: "policy-off" });
  });

  // The bound that matters: a spent weekly window limits again immediately, and
  // without this the work walks through every account in seconds.
  it("switches once per limit window, then holds and asks", () => {
    const decision = decideRotation({
      pool: pool([spent, fresh]),
      policy: "auto",
      // Two hours ago — past the cooldown, inside the window.
      lastAutoRotationAt: "2026-09-18T16:00:00.000Z",
      sourceWindowResetsAt: "2026-09-21T13:00:00.000Z",
      limitReached: true,
      now: NOW,
    });
    expect(decision).toEqual({ outcome: "hold", reason: "already-rotated-this-window" });
  });

  it("switches again once the window it was limited on has reset", () => {
    const decision = decideRotation({
      pool: pool([spent, fresh]),
      policy: "auto",
      lastAutoRotationAt: "2026-09-18T10:00:00.000Z",
      // The window that caused the earlier rotation has since reset.
      sourceWindowResetsAt: "2026-09-18T12:00:00.000Z",
      limitReached: true,
      now: NOW,
    });
    expect(decision).toMatchObject({ outcome: "rotate" });
  });

  it("holds inside the cooldown however low it is", () => {
    expect(
      decideRotation({
        pool: pool([spent, fresh]),
        policy: "auto",
        lastAutoRotationAt: "2026-09-18T17:55:00.000Z",
        sourceWindowResetsAt: null,
        limitReached: true,
        now: NOW,
      }),
    ).toEqual({ outcome: "hold", reason: "cooling-down" });
  });

  it("holds while the account in use still has room", () => {
    expect(
      decideRotation({
        pool: pool([account({ key: "3", active: true, headroomPercent: 40 }), fresh]),
        policy: "auto",
        lastAutoRotationAt: null,
        sourceWindowResetsAt: null,
        limitReached: false,
        now: NOW,
      }),
    ).toEqual({ outcome: "hold", reason: "not-low-enough" });
  });

  // Every other account on his local box is exactly this: authenticated, with a
  // dead refresh token and no readable limits.
  it("says so when the only other account is signed out", () => {
    expect(
      decideRotation({
        pool: pool([spent, deadLogin]),
        policy: "auto",
        lastAutoRotationAt: null,
        sourceWindowResetsAt: null,
        limitReached: true,
        now: NOW,
      }),
    ).toEqual({ outcome: "hold", reason: "no-usable-account" });
  });

  it("will not move to an account barely better than the one it is leaving", () => {
    expect(
      decideRotation({
        pool: pool([
          account({ key: "3", active: true, headroomPercent: 4 }),
          account({ key: "1", headroomPercent: 8 }),
        ]),
        policy: "auto",
        lastAutoRotationAt: null,
        sourceWindowResetsAt: null,
        limitReached: true,
        now: NOW,
      }),
    ).toEqual({ outcome: "hold", reason: "no-account-with-headroom" });
  });
});

describe("rotationLine", () => {
  it("names the account, what is left, and why", () => {
    expect(
      rotationLine({
        toLabel: "sablebox",
        fromLabel: "optima",
        toHeadroomPercent: 79.4,
        reason: "limit",
      }),
    ).toBe("Moved to sablebox with 79% left — optima had run out");
  });
});

describe("accountStanding", () => {
  it.each([
    [80, "ok"],
    [12, "warn"],
    [3, "spent"],
  ])("reads %i%% headroom as %s", (headroomPercent, tone) => {
    expect(
      accountStanding(
        account({ key: "1", label: "sablebox", headroomPercent }),
        DEFAULT_ROTATION_THRESHOLDS,
      )?.tone,
    ).toBe(tone);
  });

  it("calls a signed-out account signed out rather than empty", () => {
    expect(
      accountStanding(
        account({ key: "2", label: "robin", usable: false, unusableReason: "signed-out" }),
      ),
    ).toEqual({ label: "robin — signed out", tone: "spent" });
  });
});

describe("deferNearLimit (one account)", () => {
  const week = (usedPercent: number) => ({
    id: "weekly",
    label: "Weekly",
    usedPercent,
    resetsAt: "2026-11-16T13:00:00.000Z",
  });
  it("waits for the reset when the only account is nearly spent, and not before", () => {
    const only = (headroomPercent: number) =>
      pool([
        account({
          key: "1",
          active: true,
          headroomPercent,
          windows: [week(100 - headroomPercent)],
        }),
      ]);
    expect(deferNearLimit(only(10))).toEqual({
      until: "2026-11-16T13:00:00.000Z",
      headroomPercent: 10,
    });
    expect(deferNearLimit(only(40))).toBeNull();
  });
  it("lets rotation move the work when another account has room", () => {
    const two = pool([
      account({ key: "1", active: true, headroomPercent: 3, windows: [week(97)] }),
      account({ key: "2", headroomPercent: 60 }),
    ]);
    expect(deferNearLimit(two)).toBeNull();
    // A spare that is itself nearly spent is no way out.
    const spentSpare = pool([
      account({ key: "1", active: true, headroomPercent: 3, windows: [week(97)] }),
      account({ key: "2", headroomPercent: 8 }),
    ]);
    expect(deferNearLimit(spentSpare)?.headroomPercent).toBe(3);
  });
});

describe("instancePool (any provider)", () => {
  const provider = (id: string, driver: string, usedPercent: number, groupKey?: string) =>
    ({
      instanceId: id,
      driver,
      displayName: id,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      ...(groupKey === undefined ? {} : { continuation: { groupKey } }),
      usageLimits: {
        checkedAt: NOW,
        windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent, resetsAt: null }],
      },
    }) as unknown as ServerProvider;

  it("makes one Codex login a pool of one, so it defers near its limit with no switcher installed", () => {
    const codex = instancePool([provider("codex", "codex", 92)], "codex", NOW);
    expect(codex?.accounts.map((a) => [a.key, a.active])).toEqual([["codex", true]]);
    expect(codex === null ? null : deferNearLimit(codex)?.headroomPercent).toBe(8);
  });

  it("pools only the same driver's instances that share the transcripts", () => {
    const providers = [
      provider("codex", "codex", 92, "g"),
      provider("codex-2", "codex", 10, "g"),
      provider("claude", "claudeAgent", 0, "g"),
      provider("codex-3", "codex", 0, "other"),
    ];
    expect(instancePool(providers, "codex", NOW)?.accounts.map((a) => a.key)).toEqual([
      "codex",
      "codex-2",
    ]);
    expect(instancePool(providers, "missing", NOW)).toBeNull();
  });
});
