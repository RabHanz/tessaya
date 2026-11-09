import type { BatonAccount } from "@t3tools/baton-contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { liveSwitchRefusal, oneEntryPerProvider, pickModelFor, unifyAccounts } from "./accounts.ts";

const provider = (
  instanceId: string,
  over: {
    email?: string;
    displayName?: string;
    enabled?: boolean;
    type?: string;
    driver?: string;
  } = {},
  windows: ReadonlyArray<{ kind: "session" | "weekly"; usedPercent: number }> = [],
): ServerProvider =>
  ({
    instanceId,
    driver: over.driver ?? "claudeAgent",
    ...(over.displayName ? { displayName: over.displayName } : {}),
    enabled: over.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      ...(over.email ? { email: over.email } : {}),
      ...(over.type ? { type: over.type } : {}),
    },
    checkedAt: "2026-11-09T09:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(windows.length > 0
      ? {
          usageLimits: {
            checkedAt: "2026-11-09T09:00:00.000Z",
            windows: windows.map((window) => ({ ...window, id: window.kind, label: window.kind })),
          },
        }
      : {}),
  }) as unknown as ServerProvider;

const slot = (key: string, email: string, active = false): BatonAccount =>
  ({
    key,
    label: email.split("@")[0],
    email,
    organizationName: null,
    active,
    usable: true,
    unusableReason: null,
    headroomPercent: 60,
    windows: [{ id: "seven_day", label: "7d", usedPercent: 40, resetsAt: null }],
    usageCheckedAt: "2026-11-09T08:00:00.000Z",
  }) as BatonAccount;

describe("unifyAccounts", () => {
  it("merges the machine login and a token for the same address into one account", () => {
    const accounts = unifyAccounts({
      providers: [
        provider("claudeAgent", { displayName: "Claude", email: "work@example.com" }, [
          { kind: "session", usedPercent: 34 },
          { kind: "weekly", usedPercent: 62 },
        ]),
        provider("claudeAgent_work", { displayName: "Work" }),
        provider("claudeAgent_side", { displayName: "Side" }),
        provider("baton-live", { displayName: "Terminal session", driver: "acpRegistry" }),
      ],
      pool: [slot("4", "setup-token-4@token.local"), slot("6", "work@example.com", true)],
      slots: { claudeAgent_work: "6", claudeAgent_side: "4" },
    });
    expect(accounts.map((account) => account.label)).toEqual(["Work", "Side"]);
    const [work, side] = accounts;
    expect(work).toMatchObject({
      id: "claudeAgent:work@example.com",
      instanceIds: ["claudeAgent", "claudeAgent_work"],
      isDefault: true,
      liveSwitchKey: "6",
      methods: [
        { kind: "browser", instanceId: "claudeAgent", liveSwitch: false },
        { kind: "setup-token", instanceId: "claudeAgent_work", liveSwitch: true },
      ],
      // The provider's own reading is newer than cswap's.
      fiveHour: { usedPercent: 34 },
      weekly: { usedPercent: 62 },
    });
    // A token cswap could not name keeps its slot as identity and never borrows another login.
    expect(side).toMatchObject({ id: "claudeAgent:slot:4", email: null, liveSwitchKey: "4" });
    expect(side?.weekly).toEqual({ usedPercent: 40, resetsAt: null });
  });

  it("shows an API key, a paused account, and a switcher-only login", () => {
    const accounts = unifyAccounts({
      providers: [
        provider("codex", { driver: "codex", email: "me@example.com" }),
        provider("codex_key", {
          driver: "codex",
          type: "apiKey",
          enabled: false,
          displayName: "Key",
        }),
      ],
      pool: [slot("5", "other@example.com")],
      slots: {},
    });
    expect(accounts.map((account) => [account.id, account.health, account.methods])).toEqual([
      ["codex:me@example.com", "ok", [{ kind: "browser", instanceId: "codex", liveSwitch: false }]],
      [
        "codex:codex_key",
        "paused",
        [{ kind: "api-key", instanceId: "codex_key", liveSwitch: false }],
      ],
      [
        "claudeAgent:other@example.com",
        "ok",
        [{ kind: "browser", instanceId: null, liveSwitch: false }],
      ],
    ]);
  });
});

describe("oneEntryPerProvider", () => {
  const entry = (
    instanceId: string,
    driverKind: string,
    displayName: string,
    isDefault = false,
  ) => ({
    instanceId,
    driverKind,
    displayName,
    isDefault,
  });
  const entries = [
    entry("claudeAgent", "claudeAgent", "Claude", true),
    entry("claudeAgent_work", "claudeAgent", "Work"),
    entry("codex", "codex", "Codex", true),
    entry("baton-live", "acpRegistry", "Terminal session"),
  ];

  it("keeps the selected login for its provider under the provider's name, and Terminal apart", () => {
    expect(oneEntryPerProvider(entries, "claudeAgent_work")).toEqual([
      entry("claudeAgent_work", "claudeAgent", "Claude"),
      entries[2],
      entry("baton-live", "acpRegistry", "Terminal"),
    ]);
    expect(oneEntryPerProvider(entries, "codex")[0]).toBe(entries[0]);
  });
});

describe("two people's logins", () => {
  it("never merge: the default instance takes the active slot only when its address matches", () => {
    const accounts = unifyAccounts({
      providers: [
        provider("claudeAgent", { email: "ann@example.com" }),
        provider("claudeAgent_bob", { displayName: "Bob" }),
      ],
      pool: [slot("6", "bob@example.com", true)],
      slots: { claudeAgent_bob: "6" },
    });
    expect(accounts.map((account) => [account.id, account.instanceIds])).toEqual([
      ["claudeAgent:ann@example.com", ["claudeAgent"]],
      ["claudeAgent:bob@example.com", ["claudeAgent_bob"]],
    ]);
    // Ann's browser login has no slot, so no running session is ever switched to it.
    expect(accounts[0]?.liveSwitchKey).toBeNull();
    expect(liveSwitchRefusal(accounts, "6")).toBeNull();
    expect(liveSwitchRefusal(accounts, "7")).toContain("browser");
  });
});

describe("pickModelFor", () => {
  it("keeps the thread's model on its own provider and takes the default on another", () => {
    const codex = {
      driverKind: "codex",
      models: [{ slug: "gpt-a" }, { slug: "gpt-b", isDefault: true }],
    };
    expect(pickModelFor({ ...codex, driverKind: "claudeAgent" }, "claudeAgent", "opus")).toBe(
      "opus",
    );
    expect(pickModelFor(codex, "claudeAgent", "opus")).toBe("gpt-b");
  });
});
