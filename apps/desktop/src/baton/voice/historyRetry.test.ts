import { describe, expect, it } from "vite-plus/test";

import type { HistoryTurn } from "./history.ts";
import {
  NO_HOLD_KEY_RECORDING,
  NO_RECORDING,
  mayPasteInto,
  mayTeach,
  privateReason,
  retryCleanupLevel,
  retryPlan,
  rowMenu,
  rowText,
  undoAiEdit,
  useVersion,
  withRetry,
} from "./historyRetry.ts";

const turn = (over: Partial<HistoryTurn> = {}) => ({
  kind: "dictation" as const,
  status: "ok" as const,
  audio: "C:/a.webm",
  delivery: "oneshot" as string | null,
  at: "2026-11-01T10:00:00.000Z",
  raw: "there's still many",
  cleaned: "There's still many." as string | null,
  model: "haiku" as string | null,
  versions: [] as HistoryTurn["versions"],
  ...over,
});

describe("retry transcript", () => {
  it("re-runs recognition whenever a recording exists, even on an old failed entry", () => {
    expect(retryPlan(turn())).toEqual({ kind: "transcript" });
    expect(retryPlan(turn({ status: "failed", raw: "" }))).toEqual({ kind: "transcript" });
  });

  it("says plainly that no recording was kept, and offers only the clean-up retry where it applies", () => {
    expect(retryPlan(turn({ audio: null, status: "ok" }))).toEqual({
      kind: "none",
      why: NO_RECORDING,
    });
    expect(retryPlan(turn({ audio: null, status: "raw" }))).toEqual({
      kind: "cleanup",
      why: NO_RECORDING,
    });
    expect(retryPlan(turn({ audio: null, delivery: "hold key", status: "failed" }))).toEqual({
      kind: "cleanup",
      why: NO_HOLD_KEY_RECORDING,
    });
    expect(retryPlan(turn({ audio: null, kind: "spoken", status: "none" }))).toMatchObject({
      kind: "none",
    });
  });
});

describe("the row menu", () => {
  it("puts Play and Copy on the row, and Undo AI edit, Retry, Paste again, Edit and teach, Extract audio and Delete under it", () => {
    expect(rowMenu(turn(), false).map((i) => [i.id, i.enabled])).toEqual([
      ["play", true],
      ["copy", true],
      ["undo_ai", true],
      ["retry_transcript", true],
      ["paste", true],
      ["teach", true],
      ["extract", true],
      ["delete", true],
    ]);
  });

  it("greys Play and Extract audio with the reason when no recording was kept", () => {
    const menu = rowMenu(turn({ audio: null }), false);
    expect(menu.find((i) => i.id === "play")).toMatchObject({ enabled: false, note: NO_RECORDING });
    expect(menu.find((i) => i.id === "extract")).toMatchObject({ enabled: false });
    const hold = rowMenu(turn({ audio: null, delivery: "hold key" }), false);
    expect(hold.find((i) => i.id === "play")?.note).toBe(NO_HOLD_KEY_RECORDING);
  });

  it("offers only Delete on a hidden row", () => {
    expect(rowMenu(turn({ hidden: "password field" }), false).map((i) => i.id)).toEqual(["delete"]);
  });

  it("greys Retry transcript with the reason when there is no recording, and while one is running", () => {
    const none = rowMenu(turn({ audio: null }), false).find((i) => i.id === "retry_transcript");
    expect(none).toMatchObject({ enabled: false, note: NO_RECORDING });
    const busy = rowMenu(turn(), true).find((i) => i.id === "retry_transcript");
    expect(busy?.enabled).toBe(false);
  });

  it("adds the clean-up retry only for a raw or failed dictation with no recording", () => {
    const ids = (t: ReturnType<typeof turn>) => rowMenu(t, false).map((i) => i.id);
    expect(ids(turn({ audio: null, status: "raw" }))).toContain("retry");
    expect(ids(turn({ audio: null, status: "ok" }))).not.toContain("retry");
  });
});

describe("versions", () => {
  const first = {
    at: "t2",
    raw: "there's still many experience problems",
    cleaned: null,
    model: null,
  };

  it("keeps the original as v1 and the retry beside it, never over it", () => {
    const t = turn();
    const versions = withRetry(t, first);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      raw: "there's still many",
      cleaned: "There's still many.",
    });
    expect(versions[1]).toEqual(first);
  });

  it("adds a third on a second retry and nothing for an identical result", () => {
    const t = turn({ versions: withRetry(turn(), first) });
    expect(withRetry(t, first)).toHaveLength(2);
    expect(withRetry(t, { ...first, raw: "another" })).toHaveLength(3);
  });

  it("picks a version by index", () => {
    const t = turn({ versions: withRetry(turn(), first) });
    expect(useVersion(t, 1)?.raw).toBe(first.raw);
    expect(useVersion(t, 5)).toBeNull();
  });
});

describe("Undo AI edit", () => {
  it("is offered only when the written words differ from the heard ones", () => {
    const ids = (raw: string, cleaned: string | null) =>
      rowMenu({ ...turn(), raw, cleaned }, false).map((i) => i.id);
    expect(ids("ths is it", "This is it.")).toContain("undo_ai");
    expect(ids("same", "same")).not.toContain("undo_ai");
    expect(ids("same", null)).not.toContain("undo_ai");
  });

  it("makes the heard words the row's words and keeps the written ones as a version to go back to", () => {
    const t = turn({ raw: "ths is it", cleaned: "This is it." });
    const undone = undoAiEdit(t, "t2");
    expect(undone).toMatchObject({ cleaned: "ths is it", fixed: null, status: "raw" });
    expect(undone.versions.map((v) => v.cleaned)).toEqual(["This is it.", "ths is it"]);
    expect(rowText({ raw: t.raw, ...undone })).toBe("ths is it");
    expect(useVersion({ versions: undone.versions }, 0)?.cleaned).toBe("This is it.");
  });

  it("copies and pastes his own fix first, then the written words, then the heard ones", () => {
    expect(rowText({ raw: "a", cleaned: "B", fixed: "C" })).toBe("C");
    expect(rowText({ raw: "a", cleaned: "B", fixed: null })).toBe("B");
    expect(rowText({ raw: "a", cleaned: null, fixed: null })).toBe("a");
  });
});

describe("a History retry's clean-up level", () => {
  it("never sends to Claude what his setting or the app keeps local", () => {
    expect(retryCleanupLevel("claude", "notepad.exe")).toBe("claude");
    // His setting is local: a retry stays local (it used to go to Claude for anything not "off").
    expect(retryCleanupLevel("local", "notepad.exe")).toBe("local");
    expect(retryCleanupLevel("off", "notepad.exe")).toBe("local");
    // A password manager, or a row with no app (voice dictation), counts as secret.
    expect(retryCleanupLevel("claude", "1password.exe")).toBe("local");
    expect(retryCleanupLevel("claude", "")).toBe("local");
    // Decided local when he dictated (a bank or sign-in page, known only by its title then): a retry stays local.
    expect(retryCleanupLevel("claude", "chrome.exe", "local")).toBe("local");
    expect(retryCleanupLevel("claude", "chrome.exe", "claude")).toBe("claude");
  });
});

describe("what stays private", () => {
  it("hides a password box and a private app, never an ordinary or unnamed one", () => {
    expect(privateReason({ exe: "slack.exe", title: "" }, true)).toBe("password field");
    expect(privateReason({ exe: "1password", title: "" }, false)).toBe("private app");
    expect(privateReason({ exe: "chrome.exe", title: "Sign in - Bank" }, false)).toBe(
      "private app",
    );
    expect(privateReason({ exe: "slack.exe", title: "#ops" }, false)).toBeNull();
    expect(privateReason({ exe: "", title: "" }, false)).toBeNull();
  });

  it("pastes again only into the app it was said into", () => {
    expect(mayPasteInto("Slack.exe", "slack.exe")).toBe(true);
    expect(mayPasteInto("slack.exe", "chrome.exe")).toBe(false);
    expect(mayPasteInto("", "chrome.exe")).toBe(false);
  });

  it("teaches from an ordinary row at any clean-up level, never from a private one", () => {
    const row = { app: "slack.exe", hidden: null };
    expect(mayTeach(row, "Herdr pane", true)).toBe(true);
    expect(mayTeach({ ...row, cleanup: "local" }, "Herdr pane", true)).toBe(true);
    expect(mayTeach(row, "Herdr pane", false)).toBe(false);
    expect(mayTeach({ ...row, app: "1password" }, "Herdr pane", true)).toBe(false);
    expect(mayTeach({ ...row, hidden: "password field" }, "Herdr pane", true)).toBe(false);
    expect(mayTeach(row, "The password is hunter-fake-77.", true)).toBe(false);
  });
});
