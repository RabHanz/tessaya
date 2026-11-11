import { describe, expect, it } from "vite-plus/test";

import {
  bindingBanner,
  bindingOf,
  pinnedLiveSelection,
  classifierStopReason,
  displayThreadTitle,
  knownTitleSuffixes,
  livePick,
  liveSessionKey,
  liveThreadSwitchRefusal,
  runningLiveSessionKeys,
} from "./liveThread.ts";

describe("a mirrored live thread", () => {
  const live = "baton-live4:cc828d1b";
  it("refuses a turn that would hand it off to another provider instance", () => {
    expect(
      liveThreadSwitchRefusal({
        threadId: live,
        currentInstance: "baton-live",
        targetInstance: "claudeAgent",
      }),
    ).toContain("answered only by it");
  });
  it("lets it stay live, lets a handed-off one go back, and leaves ordinary threads alone", () => {
    const ok = (threadId: string, currentInstance: string, targetInstance: string) =>
      liveThreadSwitchRefusal({ threadId, currentInstance, targetInstance });
    expect(ok(live, "baton-live", "baton-live")).toBeNull();
    expect(ok(live, "claudeAgent", "baton-live")).toBeNull();
    // A thread already moved to a handoff session cannot wake it again.
    expect(ok(live, "claudeAgent", "claudeAgent")).toContain("handoff session");
    expect(ok("import:claudeAgent:x", "claudeAgent", "codex")).toBeNull();
  });
  it("treats a thread moved into Tessaya on its own session id as ordinary, and a twin as a twin", () => {
    const pick = (activeNativeId: string, targetInstance: string) =>
      liveThreadSwitchRefusal({
        threadId: live,
        currentInstance: "claude-work",
        targetInstance,
        activeNativeId,
      });
    expect(pick("cc828d1b", "claude-work")).toBeNull();
    expect(pick("cc828d1b", "claude-home")).toBeNull();
    expect(pick("a-new-session", "claude-work")).toContain("handoff session");
  });
  it("shows its title without the account and machine the mirror appends, and never cuts real text", () => {
    const known = knownTitleSuffixes({
      accounts: [{ label: "Work", email: "someone@example.com" }],
      environmentLabels: ["box-prod.local"],
    });
    expect(displayThreadTitle(live, "Pricing · someone · box-prod", known)).toBe("Pricing");
    expect(displayThreadTitle(live, "Pricing · box-prod", known)).toBe("Pricing");
    expect(displayThreadTitle(live, "Fix A · B bug", known)).toBe("Fix A · B bug");
    expect(displayThreadTitle(live, "Plan · step 2 · Work · box-prod", known)).toBe(
      "Plan · step 2",
    );
    expect(displayThreadTitle("thread-1", "Pricing · box-prod", known)).toBe("Pricing · box-prod");
  });
});

describe("a model picked on a live thread", () => {
  it.each([
    // picked instance, driver, thread's instance, login, route
    ["claudeAgent", "claudeAgent", "baton-live", "same", "session-model"],
    ["claude-work", "claudeAgent", "baton-live", "other", "session-account"],
    ["claude-token", "claudeAgent", "baton-live", "unknown", "continue-in"],
    ["codex", "codex", "baton-live", "same", "continue-in"],
    ["gone", null, "baton-live", "unknown", "continue-in"],
    ["baton-live", "acpRegistry", "baton-live", "same", "unchanged"],
    // Handed off: ordinary, and the Terminal session entry takes it back.
    ["baton-live", "acpRegistry", "codex", "unknown", "switch-back"],
    ["claudeAgent", "claudeAgent", "codex", "same", "normal"],
    ["codex", "codex", "claudeAgent", "unknown", "normal"],
  ] as const)(
    "%s (%s) on %s, login %s: %s",
    (pickedInstance, pickedDriver, currentInstance, account, route) => {
      expect(livePick({ pickedInstance, pickedDriver, currentInstance, account })).toBe(route);
    },
  );
});

describe("a reply stopped by the safety classifier", () => {
  it("names the reason from the session's own wording, and only then", () => {
    expect(
      classifierStopReason(
        "Your response above was stopped by a safety classifier. Try rephrasing.",
      ),
    ).toBe("Stopped by a safety classifier: rephrase or switch model for this session");
    expect(classifierStopReason("Here is the plan.")).toBeNull();
    expect(classifierStopReason(null)).toBeNull();
  });
});

describe("a live thread's own selection", () => {
  const sel = (instanceId: string, model: string) => ({ instanceId, model });
  it("keeps the live selection when a stale one names another model on the live instance", () => {
    const current = sel("baton-live", "live");
    const stale = sel("baton-live", "claude-opus-5-5");
    expect(pinnedLiveSelection("baton-live4:abc", stale, current)).toBe(current);
  });
  it("sends to the live instance when a stale picker names another instance", () => {
    const current = sel("baton-live", "live");
    expect(pinnedLiveSelection("baton-live4:abc", sel("claudeAgent", "x"), current)).toBe(current);
  });
  it("keeps a thread that is not on its terminal session off the Terminal session entry", () => {
    const current = sel("claudeAgent_work", "opus");
    expect(pinnedLiveSelection("import:claudeAgent:abc", sel("baton-live", "live"), current)).toBe(
      current,
    );
    // A live thread moved into Tessaya may still be switched back to its session.
    const back = sel("baton-live", "live");
    expect(pinnedLiveSelection("baton-live4:abc", back, current)).toBe(back);
  });
  it("leaves other threads, a handed-off thread and an unchanged selection alone", () => {
    const other = sel("claudeAgent", "x");
    expect(pinnedLiveSelection("baton-live4:abc", other, sel("codex", "y"))).toBe(other);
    const current = sel("baton-live", "live");
    expect(
      pinnedLiveSelection("import:claudeAgent:abc", sel("baton-live", "m"), current).model,
    ).toBe("m");
  });
});

describe("the thread's connection banner", () => {
  const row = (state: string, source: string) => ({ state, source });
  it("shows nothing while the session runs, or before its state is known", () => {
    expect(bindingBanner(null)).toBeNull();
    expect(bindingBanner(row("running", "live"))).toBeNull();
  });
  it("says the thread is not connected when the session is stopped or missing, and offers Resume", () => {
    for (const found of [
      row("stopped", "transcript"),
      row("failed", "transcript"),
      row("stopped", "history"),
    ]) {
      expect(bindingBanner(found)).toEqual({
        text: "Not connected to its session.",
        actions: ["resume"],
      });
    }
    expect(bindingBanner("missing")?.text).toBe("Not connected to its session.");
  });
});

describe("what the thread is bound to", () => {
  it("names the pane, the handoff session or stopped", () => {
    const run = { state: "running", source: "live" };
    expect(bindingOf({ ...run, pane: "fab~w1:p2", answeredBy: "baton-live" })?.text).toBe(
      "Herdr pane fab~w1:p2",
    );
    expect(bindingOf({ ...run, pane: "fab~w1:p2", answeredBy: "claudeAgent" })?.kind).toBe(
      "handoff",
    );
    expect(bindingOf({ ...run, pane: null })?.kind).toBe("terminal");
    expect(bindingOf({ state: "stopped", source: "transcript" })?.kind).toBe("stopped");
    expect(bindingOf("missing")?.kind).toBe("stopped");
    expect(bindingOf(null)).toBeNull();
  });
});

describe("which live threads are Live", () => {
  it("is what each computer reports running: a live thread whose session ended, or another computer's, is not", () => {
    const running = runningLiveSessionKeys([
      { environmentId: "office", sessions: [{ sessionId: "s1" }] },
      { environmentId: "laptop", sessions: [] },
    ]);
    const live = (environmentId: string, threadId: string) => {
      const key = liveSessionKey(environmentId, threadId);
      return key !== null && running.has(key);
    };
    expect(live("office", "baton-live4:s1")).toBe(true);
    expect(live("office", "baton-live4:s2")).toBe(false);
    expect(live("laptop", "baton-live4:s1")).toBe(false);
    expect(live("office", "thread-s1")).toBe(false);
  });
});
