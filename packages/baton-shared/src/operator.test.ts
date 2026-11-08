import { describe, expect, it } from "vite-plus/test";

import { guardDecision } from "./brain.ts";
import { describeToolCall, judgeToolCall, keyIsNavigation, type ToolCall } from "./operator.ts";

const on = { actWithoutAsking: true, tainted: false };
const off = { actWithoutAsking: false, tainted: false };
const bash = (command: string): ToolCall => ({ tool: "Bash", input: { command } });

describe("a tool call", () => {
  it("that only reads always runs", () => {
    for (const tool of ["Read", "Glob", "Grep"]) {
      expect(judgeToolCall({ tool, input: { file_path: "C:/x" } }, off).verdict).toBe("allow");
    }
  });

  it("runs by itself only with Act without asking on", () => {
    expect(judgeToolCall(bash("npm test"), on).verdict).toBe("allow");
    expect(judgeToolCall(bash("npm test"), off).verdict).toBe("ask");
  });

  it("asks for a spoken yes where a sentence is refused, whatever the setting", () => {
    for (const command of ["rm -rf /", "git push --force origin main", "git reset --hard"]) {
      for (const context of [on, off, { ...on, tainted: true }]) {
        expect(judgeToolCall(bash(command), context)).toMatchObject({
          verdict: "ask",
          risky: true,
        });
      }
    }
  });

  it("asks before a command that drives apps itself, whatever the setting", () => {
    for (const command of [
      'powershell -c "Add-Type -AssemblyName UIAutomationClient"',
      "powershell -c \"(New-Object -ComObject WScript.Shell).SendKeys('x')\"",
      "rundll32 user32.dll,LockWorkStation",
    ]) {
      expect(judgeToolCall(bash(command), on).verdict).toBe("ask");
      expect(judgeToolCall({ tool: "commandExecution", input: { command } }, on).verdict).toBe(
        "ask",
      );
    }
    expect(judgeToolCall(bash("npm run test:keys"), on).verdict).toBe("allow");
  });

  it("never lets a Codex file change or a blank command through on its own", () => {
    const change = { tool: "fileChange", input: { path: "a.ts" } };
    expect(judgeToolCall(change, on).verdict).toBe("ask");
    expect(judgeToolCall({ tool: "commandExecution", input: { cwd: "C:/x" } }, on).verdict).toBe(
      "ask",
    );
    expect(judgeToolCall({ tool: "commandExecution", input: { command: "ls" } }, on).verdict).toBe(
      "allow",
    );
  });

  it("asks before a search on a tainted turn, since the query can carry a secret", () => {
    const search = { tool: "WebSearch", input: { query: "site:x.io token" } };
    expect(judgeToolCall(search, off).verdict).toBe("allow");
    expect(judgeToolCall(search, { ...on, tainted: true }).verdict).toBe("ask");
  });

  it("gets a yes for deleting, sending, paying or publishing, even with the setting on", () => {
    for (const command of ["del notes.txt", "npm publish", "gh pr merge 5", "curl -X POST x.io"]) {
      expect(judgeToolCall(bash(command), on).verdict).toBe("ask");
    }
  });

  it("gets a yes once the turn has read something, so a file cannot act alone", () => {
    expect(judgeToolCall(bash("npm test"), { ...on, tainted: true }).verdict).toBe("ask");
    const fetched = { tool: "WebFetch", input: { url: "https://x.io/?q=secret" } };
    expect(judgeToolCall(fetched, { ...on, tainted: true }).verdict).toBe("ask");
  });

  it("gets a yes for a tool nobody has classified", () => {
    expect(judgeToolCall({ tool: "CronCreate", input: {} }, on).verdict).toBe("ask");
  });

  it("is judged by what it does, not by what a file says", () => {
    const write = { tool: "Write", input: { file_path: "a.md", content: "rm -rf / and publish" } };
    expect(judgeToolCall(write, on).verdict).toBe("allow");
    expect(describeToolCall(write)).toBe("a.md");
  });
});

describe("the operate route", () => {
  it("sees the high-risk list", () => {
    const risky = guardDecision(
      { route: "operate", text: "deploy this to production", source: "model" },
      "deploy this to production",
    );
    expect(risky.route).toBe("refused");
  });
});

describe("Baton's own tools (D143)", () => {
  const typed = (text: string, why = "type his reply into the chat box"): ToolCall => ({
    tool: "mcp__baton__type_text",
    input: { text, why },
  });
  it("types plain text into a named box with no Run it, whatever the setting", () => {
    expect(judgeToolCall(typed("Here is the answer I gave you."), off).verdict).toBe("allow");
    expect(judgeToolCall(typed("Here is the answer I gave you."), on).verdict).toBe("allow");
  });
  it("asks for a yes, default no, when the text is high risk or the window is a command line", () => {
    expect(judgeToolCall(typed("git push --force origin main"), on)).toMatchObject({
      verdict: "ask",
      risky: true,
    });
    expect(judgeToolCall(typed("hello"), { ...on, focusedShell: true }).verdict).toBe("ask");
    // Keys into a command line ask too, so he gets a box rather than a refusal as they are sent.
    const keys = { tool: "mcp__baton__press_keys", input: { keys: ["up"], why: "w" } };
    expect(judgeToolCall(keys, { ...on, focusedShell: true })).toMatchObject({
      verdict: "ask",
      why: "It would press keys in a command line.",
    });
    expect(judgeToolCall(keys, on).verdict).toBe("allow");
  });
  it("asks when the text follows something it read, unless the text is his own", () => {
    const read = { ...on, tainted: true };
    expect(judgeToolCall(typed("buy this now"), read).verdict).toBe("ask");
    expect(judgeToolCall(typed("what I just told you"), { ...read, textIsHis: true }).verdict).toBe(
      "allow",
    );
  });
  it("lets a job start and be agreed to with his words, asks after a read, and always asks for a standing permission", () => {
    const start = {
      tool: "mcp__baton__job_start",
      input: { title: "Site", goal: "rebuild the site", project: "Site" },
    };
    const split = {
      tool: "mcp__baton__job_split",
      input: { id: "j1", parts: [{ title: "A", goal: "do a" }] },
    };
    expect(judgeToolCall(split, off).verdict).toBe("allow");
    expect(judgeToolCall(split, { ...off, tainted: true }).verdict).toBe("ask");
    const agree = { tool: "mcp__baton__job_agree", input: { id: "j1" } };
    expect(judgeToolCall(start, off).verdict).toBe("allow");
    expect(judgeToolCall(agree, off).verdict).toBe("allow");
    const read = { ...off, tainted: true };
    expect(judgeToolCall(start, read).verdict).toBe("ask");
    expect(judgeToolCall(start, { ...read, textIsHis: true }).verdict).toBe("allow");
    expect(judgeToolCall(agree, { ...read, textIsHis: true }).verdict).toBe("ask");
    expect(judgeToolCall({ tool: "mcp__baton__job_stop", input: { id: "j1" } }, off).verdict).toBe(
      "allow",
    );
    expect(
      judgeToolCall(
        { tool: "mcp__baton__job_schedule", input: { id: "j1", every_minutes: 60 } },
        off,
      ).verdict,
    ).toBe("ask");
    // His own standing jobs (KIRO-1): changing or removing one asks every time, even in a turn that read nothing.
    for (const tool of ["job_update", "job_delete"]) {
      expect(
        judgeToolCall({ tool: `mcp__baton__${tool}`, input: { id: "user:1" } }, off).verdict,
      ).toBe("ask");
    }
    const note = { tool: "mcp__baton__memory_remember", input: { text: "likes tea" } };
    expect(judgeToolCall(note, off).verdict).toBe("allow");
    expect(judgeToolCall(note, read).verdict).toBe("ask");
    const commit = { tool: "mcp__baton__commit_add", input: { text: "check the deploy" } };
    expect(judgeToolCall(commit, off).verdict).toBe("allow");
    expect(judgeToolCall(commit, read).verdict).toBe("ask");
    const weave = {
      tool: "mcp__baton__weave_send",
      input: { session: "build", text: "rerun the tests", job: "j1" },
    };
    expect(judgeToolCall(weave, off).verdict).toBe("ask");
    expect(judgeToolCall(weave, { ...off, weaveStanding: true }).verdict).toBe("allow");
    expect(judgeToolCall(weave, { ...off, weaveStanding: true, tainted: true }).verdict).toBe(
      "ask",
    );
    expect(judgeToolCall({ tool: "mcp__baton__weave_list", input: {} }, off).verdict).toBe("allow");
    const retry = { tool: "mcp__baton__job_retry", input: { id: "j1", reason: "timed out" } };
    expect(judgeToolCall(retry, off).verdict).toBe("allow");
    expect(judgeToolCall(retry, read).verdict).toBe("ask");
    expect(
      judgeToolCall(
        { tool: "mcp__baton__job_handoff", input: { id: "j1", instance: "codex" } },
        off,
      ).verdict,
    ).toBe("ask");
    expect(
      judgeToolCall({ tool: "mcp__baton__skill_draft", input: { id: "j1" } }, off).verdict,
    ).toBe("allow");
    expect(
      judgeToolCall({ tool: "mcp__baton__skill_draft", input: { id: "j1" } }, read).verdict,
    ).toBe("ask");
    const jot = { tool: "mcp__baton__note_add", input: { text: "buy milk" } };
    expect(judgeToolCall(jot, off).verdict).toBe("allow");
    expect(judgeToolCall(jot, read).verdict).toBe("ask");
    expect(
      judgeToolCall({ tool: "mcp__baton__note_search", input: { query: "x" } }, read).verdict,
    ).toBe("allow");
    const rewrite = { tool: "mcp__baton__text_transform", input: { name: "polish" } };
    expect(judgeToolCall(rewrite, off).verdict).toBe("allow");
    expect(judgeToolCall(rewrite, read).verdict).toBe("ask");
    expect(judgeToolCall(rewrite, { ...off, focusedShell: true }).verdict).toBe("ask");
    // 0.1.73: clearing a text box was asked about as "a destructive database operation".
    const clear = {
      tool: "mcp__baton__text_command",
      input: { instruction: "select all and delete everything in the input box" },
    };
    expect(judgeToolCall(clear, off).verdict).toBe("allow");
    expect(
      judgeToolCall({ tool: "Bash", input: { command: "psql -c 'drop the table users'" } }, on),
    ).toMatchObject({ verdict: "ask", why: "This is a destructive database operation." });
    expect(judgeToolCall({ tool: "mcp__baton__text_undo", input: {} }, read).verdict).toBe("allow");
    expect(judgeToolCall({ tool: "mcp__baton__commit_list", input: {} }, read).verdict).toBe(
      "allow",
    );
    expect(
      judgeToolCall({ tool: "mcp__baton__memory_forget", input: { id: "a" } }, off).verdict,
    ).toBe("ask");
    expect(
      judgeToolCall({ tool: "mcp__baton__vault_use", input: { name: "x" } }, off).verdict,
    ).toBe("allow");
    expect(
      judgeToolCall({ tool: "mcp__baton__vault_use", input: { name: "x" } }, read).verdict,
    ).toBe("allow"); // the vault asks, naming the secret, when the turn read something
    expect(
      judgeToolCall({ tool: "mcp__baton__vault_save_pending", input: { name: "x" } }, off).verdict,
    ).toBe("ask");
    expect(
      judgeToolCall({ tool: "mcp__baton__browser_accessibility_on", input: {} }, off),
    ).toMatchObject({ verdict: "ask", risky: true });
    const grant = judgeToolCall(
      { tool: "mcp__baton__job_grant", input: { id: "j1", channel: "email" } },
      off,
    );
    expect(grant).toMatchObject({ verdict: "ask", risky: true });
  });
  it("lets it look and click, but not send, drag or press Enter on its own", () => {
    for (const tool of [
      "screen_capture",
      "ui_tree",
      "sessions_list",
      "fleet_status",
      "memory_search",
      "memory_used",
      "vault_list",
      "history_search",
      "browser_route",
      "memory_pin",
      "dictation_start",
      "jobs_list",
      "job_revoke",
    ]) {
      expect(judgeToolCall({ tool: `mcp__baton__${tool}`, input: {} }, off).verdict).toBe("allow");
    }
    expect(
      judgeToolCall({ tool: "mcp__baton__click", input: { x: 1, y: 2, why: "the text box" } }, off)
        .verdict,
    ).toBe("allow");
    expect(
      judgeToolCall(
        { tool: "mcp__baton__click", input: { x: 1, y: 2, why: "the Send button" } },
        off,
      ).verdict,
    ).toBe("ask");
    // Putting the cursor in a message box only focuses it; the same words on a button still ask.
    const focusBox = {
      tool: "mcp__baton__click_element",
      input: { id: 7, why: "Put the cursor in the middle pane's message box" },
    };
    expect(judgeToolCall(focusBox, { ...off, pointerField: true }).verdict).toBe("allow");
    expect(judgeToolCall(focusBox, off).verdict).toBe("ask");
    expect(
      judgeToolCall(
        { tool: "mcp__baton__click_element", input: { label: "Save", why: "save the note" } },
        off,
      ).verdict,
    ).toBe("allow");
    expect(
      judgeToolCall(
        { tool: "mcp__baton__click_element", input: { label: "Send", why: "send it" } },
        off,
      ).verdict,
    ).toBe("ask");
    expect(
      judgeToolCall({ tool: "mcp__baton__wait_for", input: { label: "Save", seconds: 3 } }, off)
        .verdict,
    ).toBe("allow");
    expect(
      judgeToolCall({ tool: "mcp__baton__press_keys", input: { keys: ["enter"] } }, on).verdict,
    ).toBe("ask");
    expect(judgeToolCall({ tool: "mcp__baton__drag", input: {} }, on).verdict).toBe("ask");
  });
  it("keeps the harness's own tools exactly as they were", () => {
    expect(judgeToolCall(bash("npm test"), off).verdict).toBe("ask");
    expect(judgeToolCall({ tool: "mcp__baton__unknown_tool", input: {} }, on).verdict).toBe("ask");
  });
});

describe("keys after a read", () => {
  it("are free only when they are navigation or editing, with no Windows key and no Alt", () => {
    for (const keys of [
      ["up"],
      ["tab"],
      ["shift", "tab"],
      ["home"],
      ["pagedown"],
      ["backspace"],
      ["delete"],
      ["escape"],
      ["ctrl", "a"],
      ["ctrl", "c"],
      ["ctrl", "v"],
      ["ctrl", "z"],
      ["ctrl", "f"],
      ["ctrl", "shift", "left"],
      ["shift", "end"],
    ]) {
      expect(keyIsNavigation(keys)).toBe(true);
    }
  });
  it("ask when they open, close, navigate, send or are not sure", () => {
    for (const keys of [
      ["win", "r"],
      ["alt", "f4"],
      ["alt", "tab"],
      ["alt", "space"],
      ["ctrl", "alt", "delete"],
      ["ctrl", "shift", "escape"],
      ["ctrl", "w"],
      ["ctrl", "t"],
      ["ctrl", "n"],
      ["ctrl", "q"],
      ["ctrl", "r"],
      ["ctrl", "l"],
      ["enter"],
      ["f5"],
      ["ctrl", "s"],
      ["ctrl", "shift", "delete"],
      ["a"],
      ["ctrl", "k", "j"],
    ]) {
      expect(keyIsNavigation(keys)).toBe(false);
    }
  });
  it("is judged by that after a read, and left alone before one", () => {
    const press = (keys: string[]): ToolCall => ({
      tool: "mcp__baton__press_keys",
      input: { keys, why: "a key" },
    });
    expect(judgeToolCall(press(["ctrl", "a"]), { ...on, tainted: true }).verdict).toBe("allow");
    expect(judgeToolCall(press(["win", "r"]), { ...on, tainted: true }).verdict).toBe("ask");
    expect(judgeToolCall(press(["alt", "f4"]), { ...on, tainted: true }).verdict).toBe("ask");
    expect(judgeToolCall(press(["win", "r"]), on).verdict).toBe("allow");
  });
});

describe("cloud tools", () => {
  const ctx = (tainted: boolean) => ({ actWithoutAsking: false, tainted, textIsHis: false });
  const call = (tool: string, input: Record<string, unknown> = {}) => ({
    tool: `mcp__baton__${tool}`,
    input,
  });
  it("treats a dispatch as routine, but a brief built from something it read must say so", () => {
    const brief = { repo: "o/r", branch: "b", brief: "Fix the test" };
    expect(judgeToolCall(call("cloud_dispatch", brief), ctx(false)).verdict).toBe("allow");
    expect(judgeToolCall(call("cloud_dispatch", brief), ctx(true)).verdict).toBe("ask");
    expect(
      judgeToolCall(call("cloud_dispatch", { ...brief, from_web_or_file: true }), ctx(true))
        .verdict,
    ).toBe("allow");
  });
  it("lets it look and withdraw freely; the approval dialog is the ask", () => {
    for (const t of [
      "cloud_status",
      "cloud_list",
      "cloud_usage",
      "cloud_cancel",
      "cloud_approve",
    ]) {
      expect(judgeToolCall(call(t, { id: "3", account: "robin" }), ctx(true)).verdict).toBe(
        "allow",
      );
    }
  });
});

describe("act_batch", () => {
  const step = (tool: string, input: Record<string, unknown>) => ({ tool, args: input });
  const batch = (steps: unknown[]): ToolCall => ({
    tool: "mcp__baton__act_batch",
    input: { steps },
  });

  it("is judged step by step, the strictest verdict standing", () => {
    expect(
      judgeToolCall(
        batch([step("click_element", { label: "Help" }), step("type_text", { text: "hi" })]),
        off,
      ).verdict,
    ).toBe("allow");
    expect(
      judgeToolCall(
        batch([step("click_element", { label: "Help" }), step("press_keys", { keys: ["enter"] })]),
        off,
      ).verdict,
    ).toBe("ask");
    // typing after a read asks, as it would alone
    expect(
      judgeToolCall(batch([step("type_text", { text: "hi" })]), { ...off, tainted: true }).verdict,
    ).toBe("ask");
    expect(
      judgeToolCall(batch([step("click_element", { label: "Pay", why: "delete it" })]), off)
        .verdict,
    ).toBe("ask");
  });

  it("refuses what cannot be batched or is malformed", () => {
    for (const bad of [
      [],
      [step("drag", {})],
      [step("click", { x: 1, y: 2 })],
      new Array(7).fill(step("wait_for", {})),
    ]) {
      expect(judgeToolCall(batch(bad), on).verdict).toBe("deny");
    }
  });
});

describe("the target text a baton tool names", () => {
  const baton = (tool: string, input: Record<string, unknown>): ToolCall => ({
    tool: `mcp__baton__${tool}`,
    input,
  });

  it("is read from every field that carries it, not only why", () => {
    expect(
      judgeToolCall(baton("click_element", { label: "Delete", why: "tidy up" }), off).verdict,
    ).toBe("ask");
    expect(
      judgeToolCall(baton("click_element", { label: "Send", why: "go on" }), off).verdict,
    ).toBe("ask");
    expect(
      judgeToolCall(baton("click_element", { label: "Help", why: "open the menu" }), off).verdict,
    ).toBe("allow");
    for (const [tool, input] of [
      ["job_start", { goal: "delete the production database" }],
      ["job_refine", { instruction: "pay the invoice" }],
    ] as const) {
      expect(judgeToolCall(baton(tool, input), off).verdict, tool).not.toBe("allow");
    }
  });
});
