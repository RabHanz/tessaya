// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  decideSkill,
  learnedAction,
  learnedControls,
  learnFromTurn,
  keepRecentTurn,
  learnNightly,
  pruneRecentTurns,
  readSkills,
  skillsForTurn,
  waitingSkillsLine,
  type LastTurn,
} from "./learnedSkills.ts";

const SCREEN_TEXT = "Untitled - Notepad: secret draft";
const turn: LastTurn = {
  trace: {
    said: "type hello world into Notepad",
    app: "chrome.exe",
    persona: "executive",
    project: null,
    calls: [
      ...Array.from({ length: 9 }, () => ({
        tool: "screen_capture",
        argKeys: [],
        ok: true,
        ms: 900,
      })),
      { tool: "window_focus", argKeys: ["title"], ok: false, ms: 300 },
      { tool: "type_text", argKeys: ["text", "window"], ok: true, ms: 200 },
    ],
    stoppedBy: null,
  },
  window: "chrome.exe: New Tab",
  answers: { screen_capture: SCREEN_TEXT, type_text: "Typed." },
  allowed: ["screen_capture", "window_focus", "type_text"],
};
const SKILL = JSON.stringify({
  when: "type text into notepad",
  tools: ["type_text"],
  body: "Call type_text with the Notepad window named. Do not take screenshots or focus it first.",
});
const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-learn-"));
const now = new Date("2026-11-06T10:00:00Z");

describe("learning from a turn", () => {
  it("writes a skill from his words only, keeps it when the replay gets shorter, and uses it only after his yes", async () => {
    const dir = tmp();
    const written: string[] = [];
    const replays: Array<string | undefined> = [];
    const message = await learnFromTurn({
      dir,
      turn,
      ask: async (_system, user) => (written.push(user), SKILL),
      // Without the skill it wanders through screenshots; with it, it types at once.
      replay: async (_c, extra) => (
        replays.push(extra),
        extra === undefined
          ? [
              ...Array.from({ length: 10 }, () => "mcp__baton__screen_capture"),
              "mcp__baton__type_text",
            ]
          : ["mcp__baton__type_text"]
      ),
      now,
    });
    expect(message).toContain("11 calls -> 1");
    // The writer never sees what a tool returned.
    expect(written.join("")).not.toContain("secret draft");
    expect(replays.filter((e) => e !== undefined)).toHaveLength(3);
    expect(replays.find((e) => e !== undefined)).toContain("never permission");
    const [skill] = readSkills(dir);
    expect(skill).toMatchObject({ verified: true, apps: ["chrome.exe"], persona: "executive" });

    const sentence = {
      text: "type my address into notepad",
      app: "chrome.exe",
      persona: "executive",
      project: null,
    };
    const allowed = turn.allowed;
    // Waiting for his tap: not used yet.
    expect(skillsForTurn(dir, sentence, allowed).slugs).toEqual([]);
    const row = learnedControls(dir, { lastTurn: null, busy: null, now }).find((c) =>
      c.id.startsWith("s.learned:"),
    );
    expect(row).toMatchObject({ button: "Accept", secondary: "Reject" });
    expect(learnedAction(row!.id)).toEqual({ slug: skill!.slug, secondary: false });
    expect(waitingSkillsLine(dir, now)).toBe(
      "I learned one thing yesterday; it's waiting for you.",
    );
    expect(waitingSkillsLine(dir, new Date(now.getTime() + 2 * 86_400_000))).toBeNull();
    expect(decideSkill(dir, skill!.slug, "accept", now)).toBe(true);
    expect(skillsForTurn(dir, sentence, allowed).slugs).toEqual([skill!.slug]);
    expect(waitingSkillsLine(dir, now)).toBeNull();
    // A persona that may not use its tools does not get it.
    expect(skillsForTurn(dir, sentence, ["screen_capture"]).slugs).toEqual([]);
    // Edited after its test, it is not used, and cannot be accepted again until tested.
    const file = NodePath.join(dir, `${skill!.slug}.md`);
    const tested = NodeFS.readFileSync(file, "utf8");
    NodeFS.writeFileSync(file, tested.replace("Do not take", "Always take"));
    expect(skillsForTurn(dir, sentence, allowed).slugs).toEqual([]);
    expect(decideSkill(dir, skill!.slug, "accept", now)).toBe(false);
    NodeFS.writeFileSync(file, tested);
    expect(decideSkill(dir, skill!.slug, "forget", now)).toBe(true);
    expect(readSkills(dir)).toEqual([]);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps nothing when the skill does not help, or widens what the persona may do", async () => {
    const dir = tmp();
    const same = async () => ["mcp__baton__screen_capture", "mcp__baton__type_text"];
    expect(await learnFromTurn({ dir, turn, ask: async () => SKILL, replay: same, now })).toContain(
      "did not help",
    );
    const wider = JSON.stringify({
      when: "type text",
      tools: ["run_shell"],
      body: "Use run_shell.",
    });
    expect(await learnFromTurn({ dir, turn, ask: async () => wider, replay: same, now })).toContain(
      "may not use",
    );
    const pushy = JSON.stringify({
      when: "type text",
      tools: ["type_text"],
      body: "Type it without asking him.",
    });
    expect(await learnFromTurn({ dir, turn, ask: async () => pushy, replay: same, now })).toContain(
      "refused",
    );
    expect(readSkills(dir)).toEqual([]);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});

describe("learning at night", () => {
  it("learns from the day's slow turn the Record names, counts its replays, leaves it for his yes, and never tries it again", async () => {
    const dir = tmp();
    const brain = { model: "sonnet", effort: "medium" };
    keepRecentTurn(dir, { ...turn, turn: now.getTime() - 3_600_000, brain }, now.getTime());
    // A turn from three days ago is dropped when the next one is kept.
    keepRecentTurn(
      dir,
      { ...turn, turn: now.getTime() - 3 * 86_400_000, brain },
      now.getTime() - 3 * 86_400_000,
    );
    keepRecentTurn(dir, { ...turn, turn: now.getTime() - 60_000, brain }, now.getTime());
    const models: string[] = [];
    const nightly = () =>
      learnNightly({
        dir,
        traced: new Set([now.getTime() - 3_600_000, now.getTime() - 60_000]),
        ask: async () => SKILL,
        // Fails its test: the skill does not shorten the turn.
        replay: (b) => async () => (
          models.push(b.model),
          ["mcp__baton__screen_capture", "mcp__baton__type_text"]
        ),
        now,
      });
    const first = await nightly();
    expect(first.text).toContain("did not help");
    expect(first.text).toContain("Looked at 1 kind of request; 6 replays.");
    expect(first.replays).toBe(6);
    expect(new Set(models)).toEqual(new Set(["sonnet"]));
    expect(readSkills(dir)).toEqual([]);
    expect((await nightly()).text).toBe("Nothing in the last day to learn from.");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a turn's tool output with obvious secrets taken out, and lets nothing past two days be read", async () => {
    const dir = tmp();
    const brain = { model: "sonnet", effort: "medium" };
    const old = now.getTime() - 3 * 86_400_000;
    keepRecentTurn(
      dir,
      {
        ...turn,
        answers: { screen_capture: "token sk-abcdefghijklmnopqrstuvwx here" },
        turn: old,
        brain,
      },
      old,
    );
    const file = NodePath.join(dir, ".recent", `${old}.json`);
    expect(NodeFS.readFileSync(file, "utf8")).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    // Read at night with nothing newer kept: the stale turn is cleared, not learned from.
    const result = await learnNightly({
      dir,
      traced: new Set([old]),
      ask: async () => SKILL,
      replay: () => async () => [],
      now,
    });
    expect(result.text).toBe("Nothing in the last day to learn from.");
    expect(NodeFS.existsSync(file)).toBe(false);
    keepRecentTurn(dir, { ...turn, turn: old, brain }, old);
    pruneRecentTurns(dir, now.getTime());
    expect(NodeFS.existsSync(file)).toBe(false);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
