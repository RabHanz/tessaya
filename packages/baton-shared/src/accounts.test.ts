import type { BatonAccount } from "@t3tools/baton-contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  liveSwitchRefusal,
  oneEntryPerProvider,
  pickModelFor,
  sessionLoginKey,
  threadAccount,
  accountPickHint,
  accountPickTarget,
  accountTicks,
  credentialKind,
  cswapTokenKinds,
  withProviderModels,
  unifyAccounts,
} from "./accounts.ts";

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
      { ...entry("claudeAgent_work", "claudeAgent", "Claude"), accentColor: undefined },
      entries[2],
      entry("baton-live", "acpRegistry", "Terminal"),
    ]);
  });

  it("names the provider, not a default instance he named after a person, and keeps ACP agents apart", () => {
    // The laptop: its default instance is called "Rabee" but runs the machine's own login.
    const laptop = [
      { ...entry("claudeAgent", "claudeAgent", "Rabee", true), accentColor: "#c96" },
      entry("claudeAgent_optima", "claudeAgent", "Optima"),
      entry("acp_cursor", "acpRegistry", "Cursor"),
      entry("acp_grok", "acpRegistry", "Grok"),
    ];
    expect(
      oneEntryPerProvider(laptop, "claudeAgent").map((shown) => [
        shown.instanceId,
        shown.displayName,
        "accentColor" in shown ? shown.accentColor : "none",
      ]),
    ).toEqual([
      ["claudeAgent", "Claude", undefined],
      ["acp_cursor", "Cursor", "none"],
      ["acp_grok", "Grok", "none"],
    ]);
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

describe("the account a thread runs as", () => {
  const pool = [
    { key: "1", email: "work@example.com", active: true },
    { key: "2", email: "home@example.com", active: false },
  ];
  const accounts = [
    { id: "work", instanceIds: ["claudeAgent"], liveSwitchKey: "1" },
    { id: "home", instanceIds: ["claude_home"], liveSwitchKey: "2" },
  ];

  it("goes by the instance, or on a terminal thread by the session's own login over cswap's active one", () => {
    expect(threadAccount(accounts, "claude_home", null)?.id).toBe("home");
    expect(threadAccount(accounts, "baton-live", sessionLoginKey(pool, "home"))?.id).toBe("home");
    expect(threadAccount(accounts, "baton-live", sessionLoginKey(pool, null))?.id).toBe("work");
    expect(threadAccount(accounts, "baton-live", sessionLoginKey(pool, "gone"))).toBeUndefined();
  });

  it("ticks the login a terminal session runs as, not a pick waiting in the composer, which it names apart", () => {
    // He picked the home account in the composer; the session still runs on work, as the header chip says.
    const ticks = accountTicks(accounts, {
      storedInstanceId: "baton-live",
      shownInstanceId: "claude_home",
      loginKey: sessionLoginKey(pool, "work"),
    });
    expect(ticks.runsAs?.id).toBe("work");
    expect(ticks.setTo?.id).toBe("home");
    expect(
      accountTicks(accounts, {
        storedInstanceId: "baton-live",
        shownInstanceId: "baton-live",
        loginKey: "2",
      }),
    ).toEqual({ runsAs: accounts[1], setTo: undefined });
  });
});

describe("his real logins", () => {
  // Shapes read from hetzner, onnyx and the laptop (fields and expiry only; values replaced).
  const setupToken = {
    claudeAiOauth: { accessToken: "sk-ant-oat01-x", scopes: ["user:inference"] },
  };
  const emptyBrowserFile = {
    claudeAiOauth: {
      accessToken: "",
      refreshToken: "",
      expiresAt: null,
      refreshTokenExpiresAt: null,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
    },
  };
  const browserSignIn = {
    claudeAiOauth: { accessToken: "x", refreshToken: "y", expiresAt: 1_800_000_000_000 },
  };
  const tokenStatus = [
    "Accounts:",
    "  4: rabee (se***@token.local) [personal]",
    "     └ 7d:  10%   resets Nov 16 14:00",
    "     • stored backup: unknown expiry, refresh token no",
    "  5: optima (op***@example.com) [personal]",
    "     • stored backup: unknown expiry, refresh token no",
    "  6: signzart (si***@example.com) [personal] (active)",
    "     • active profile: unknown expiry, refresh token no",
    "  7: other (ot***@example.com) [personal]",
    "     • stored backup: expires Nov 10, refresh token yes",
  ].join("\n");

  it("classifies a credential by its shape: no refresh token is a setup token, an empty file no login", () => {
    expect(credentialKind(setupToken)).toBe("setup-token");
    expect(credentialKind(browserSignIn)).toBe("browser");
    expect(credentialKind(emptyBrowserFile)).toBeNull();
    expect(cswapTokenKinds(tokenStatus)).toEqual({
      "4": "setup-token",
      "5": "setup-token",
      "6": "setup-token",
      "7": "browser",
    });
  });

  const laptop = (loginEmails: Record<string, string>, defaultEmail?: string) =>
    unifyAccounts({
      providers: [
        provider("claudeAgent", { displayName: "Rabee", email: defaultEmail }),
        provider("claudeAgent_optima", { displayName: "Optima" }),
        provider("claudeAgent_signzart", { displayName: "Signzart" }),
      ],
      pool: [
        { ...slot("4", "setup-token-4@token.local"), label: "rabee" },
        { ...slot("5", "optima@example.com"), label: "optima" },
        { ...slot("6", "signzart@example.com", true), label: "signzart" },
      ],
      slots: {},
      credentialKinds: {
        claudeAgent: "setup-token",
        claudeAgent_optima: null,
        claudeAgent_signzart: null,
      },
      slotKinds: cswapTokenKinds(tokenStatus),
      loginEmails,
    });
  const rows = (accounts: ReturnType<typeof laptop>) =>
    accounts.map((account) => [
      account.label,
      account.instanceIds,
      account.methods.map((method) => method.kind),
      account.liveSwitchKey,
      accountPickTarget(account),
    ]);

  it("merges the laptop's logins by the address each instance signed in as, as tokens that switch live", () => {
    expect(
      rows(
        laptop(
          {
            claudeAgent_optima: "optima@example.com",
            claudeAgent_signzart: "signzart@example.com",
          },
          "signzart@example.com",
        ),
      ),
    ).toEqual([
      [
        "Signzart",
        ["claudeAgent", "claudeAgent_signzart"],
        ["setup-token"],
        "6",
        { instanceId: "claudeAgent_signzart", runsAsActive: false },
      ],
      [
        "Optima",
        ["claudeAgent_optima"],
        ["setup-token"],
        "5",
        { instanceId: "claudeAgent_optima", runsAsActive: false },
      ],
      ["Rabee", [], ["setup-token"], "4", null],
    ]);
  });

  it("never merges by name, and never names or routes an unconfirmed default as an account", () => {
    // No address anywhere: "Optima" the instance and "optima" the slot stay apart; the default is the machine's.
    expect(rows(laptop({}))).toEqual([
      [
        "This machine's login",
        ["claudeAgent"],
        ["setup-token"],
        null,
        { instanceId: "claudeAgent", runsAsActive: true },
      ],
      [
        "Optima",
        ["claudeAgent_optima"],
        [],
        null,
        { instanceId: "claudeAgent_optima", runsAsActive: false },
      ],
      [
        "Signzart",
        ["claudeAgent_signzart"],
        [],
        null,
        { instanceId: "claudeAgent_signzart", runsAsActive: false },
      ],
      ["Rabee", [], ["setup-token"], "4", null],
      ["Optima", [], ["setup-token"], "5", null],
      // Active, with no instance of its own: a tick runs as the machine's active login, and says so.
      ["Signzart", [], ["setup-token"], "6", { instanceId: "claudeAgent", runsAsActive: true }],
    ]);
    expect(accountPickHint({ instanceId: "claudeAgent", runsAsActive: true }, false)).toBe(
      "Runs as this machine's active login",
    );
    expect(accountPickHint(null, false)).toBe("No instance here: add one in Settings");
  });

  it("does not send a tick to the default once its login is no longer cswap's active one", () => {
    // The default last reported Signzart, but cswap has rotated to Rabee: Signzart has no instance of its own here.
    const accounts = unifyAccounts({
      providers: [provider("claudeAgent", { email: "signzart@example.com" })],
      pool: [
        { ...slot("4", "rabee@example.com", true), label: "rabee" },
        { ...slot("6", "signzart@example.com"), label: "signzart" },
      ],
      slots: {},
    });
    const signzart = accounts.find((account) => account.email === "signzart@example.com")!;
    expect(signzart.instanceIds).toEqual(["claudeAgent"]);
    expect(accountPickTarget(signzart)).toBeNull();
  });

  it("lists the provider's models for a login whose instance has none, picks still going to that login", () => {
    const byInstance = new Map([
      ["claudeAgent", ["opus", "sonnet"]],
      ["claudeAgent_optima", []],
      ["acp_grok", []],
    ]);
    const filled = withProviderModels(byInstance, (id) =>
      id.startsWith("claudeAgent") ? "claudeAgent" : "acpRegistry",
    );
    expect(filled.get("claudeAgent_optima")).toEqual(["opus", "sonnet"]);
    expect(filled.get("acp_grok")).toEqual([]);
  });
});
