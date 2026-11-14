// @effect-diagnostics nodeBuiltinImport:off
/**
 * Learning v0 on this machine: skills in his pack folder (`operating-system/skills/<slug>.md`), his
 * decision on each in `skills.json`, and the turns kept to test them in `skills/.cases/`. A skill is
 * written only from his words and fields code wrote, tested by replaying the turn with and without it,
 * and used only after it passed and he tapped Accept.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { redactText } from "@t3tools/tessaya-shared/diagnostics";
import { batonToolName } from "@t3tools/tessaya-shared/operator";
import {
  matchSkills,
  nightlyGroups,
  parseLearnedSkill,
  parseSkillStates,
  skillFileText,
  skillFromWriter,
  skillsBlock,
  SKILLS_FOLDER,
  verdict,
  WRITER_SYSTEM,
  writerInput,
  type KeptTurn,
  type LearnedSkill,
  type RecordedCase,
  type Replay,
  type SkillStates,
  type TurnTrace,
} from "@t3tools/tessaya-shared/skillLearning";

import type { HomeControl } from "../home/batonHome.ts";

const MAX_FILE_BYTES = 64 * 1024;
export const REPLAY_SAMPLES = 3;

const statesFile = (dir: string) => NodePath.join(dir, "skills.json");
const casesDir = (dir: string) => NodePath.join(dir, ".cases");

/** `dir` is the skills folder. Unreadable or malformed files are left out. */
export const readSkills = (dir: string): ReadonlyArray<LearnedSkill> => {
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const file = NodePath.join(dir, name);
      if (NodeFS.statSync(file).size > MAX_FILE_BYTES) return [];
      const skill = parseLearnedSkill(NodeFS.readFileSync(file, "utf8"), name.slice(0, -3));
      return skill === null ? [] : [skill];
    } catch {
      return [];
    }
  });
};

export const readStates = (dir: string): SkillStates => {
  try {
    return parseSkillStates(NodeFS.readFileSync(statesFile(dir), "utf8"));
  } catch {
    return {};
  }
};

const writeStates = (dir: string, states: SkillStates) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(statesFile(dir), `${JSON.stringify(states, null, 2)}\n`);
};

export const skillsDirOf = (packDir: string) => NodePath.join(packDir, SKILLS_FOLDER);

/** What a test result is bound to: everything a skill says, so an edit after the test is noticed. */
export const fingerprint = (s: LearnedSkill): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([s.when, s.apps, s.tools, s.persona, s.project, s.body]))
    .digest("hex");

/**
 * The skills for one sentence, and their block for the turn: only one whose text is the text that
 * passed its test, and whose tools this persona may still use.
 */
export const skillsForTurn = (
  dir: string,
  turn: Parameters<typeof matchSkills>[2],
  allowed: ReadonlyArray<string>,
): { readonly slugs: ReadonlyArray<string>; readonly block: string } => {
  const states = readStates(dir);
  const usable = readSkills(dir).filter(
    (s) => states[s.slug]?.hash === fingerprint(s) && s.tools.every((t) => allowed.includes(t)),
  );
  const skills = matchSkills(usable, states, turn);
  return { slugs: skills.map((s) => s.slug), block: skillsBlock(skills) };
};

/** Accept puts a tested skill to use; Reject keeps the no for 30 days so it is not offered again; Forget deletes it. */
export const decideSkill = (
  dir: string,
  slug: string,
  decision: "accept" | "reject" | "forget",
  now: Date,
): boolean => {
  const states = readStates(dir);
  const skill = readSkills(dir).find((s) => s.slug === slug);
  if (skill === undefined) return false;
  const tested = skill.verified && states[slug]?.hash === fingerprint(skill);
  if (decision === "accept" && !tested) return false;
  const rest = Object.fromEntries(Object.entries(states).filter(([k]) => k !== slug));
  if (decision === "forget") {
    NodeFS.rmSync(NodePath.join(dir, `${slug}.md`), { force: true });
    writeStates(dir, rest);
    return true;
  }
  writeStates(dir, {
    ...rest,
    [slug]: {
      state: decision === "accept" ? "accepted" : "rejected",
      at: now.toISOString(),
      uses: states[slug]?.uses ?? 0,
      ...(states[slug]?.hash === undefined ? {} : { hash: states[slug].hash }),
    },
  });
  return true;
};

const REJECT_KEEP_MS = 30 * 24 * 60 * 60_000;

/** The morning brief's line: skills learned in the last day that wait for his tap; null when none. */
export const waitingSkillsLine = (dir: string, now: Date): string | null => {
  const n = Object.values(readStates(dir)).filter(
    (s) => s.state === "waiting" && now.getTime() - Date.parse(s.at) <= 86_400_000,
  ).length;
  if (n === 0) return null;
  return n === 1
    ? "I learned one thing yesterday; it's waiting for you."
    : `I learned ${n} things yesterday; they're waiting for you.`;
};

/** The bare "What I've learned" list, with the button that learns from the last turn. */
export const learnedControls = (
  dir: string,
  input: { readonly lastTurn: string | null; readonly busy: string | null; readonly now: Date },
): ReadonlyArray<HomeControl> => {
  const states = readStates(dir);
  const section = "What I've learned";
  const rows: HomeControl[] = [
    {
      id: "s.learn",
      section,
      label: "Learn from the last turn",
      hint:
        input.busy ??
        (input.lastTurn === null
          ? "Nothing to learn from yet."
          : `Writes a skill from "${input.lastTurn.slice(0, 80)}", tests it on that turn, and shows it here for your yes.`),
      kind: "action",
      button: "Learn from that",
      disabled: input.busy !== null || input.lastTurn === null,
    },
  ];
  for (const skill of readSkills(dir)) {
    const state = states[skill.slug];
    if (
      state?.state === "rejected" &&
      input.now.getTime() - Date.parse(state.at) < REJECT_KEEP_MS
    ) {
      continue;
    }
    const accepted = state?.state === "accepted";
    const tested = skill.verified && state?.hash === fingerprint(skill);
    rows.push({
      id: `s.learned:${skill.slug}`,
      section,
      label: `When ${skill.when}`,
      hint: `${skill.body} ${tested ? `Tested: ${skill.evidence}.` : "Not tested as it reads now, so it is not used."}${accepted ? " In use." : " Waiting for your yes."}`,
      kind: "action",
      ...(accepted
        ? { button: "Forget" }
        : { button: "Accept", secondary: "Reject", disabled: !tested }),
    });
  }
  return rows;
};

/** `s.learned:<slug>` is the main button (Accept, or Forget once in use), `:later` is Reject. */
export const learnedAction = (id: string) => {
  const m = /^s\.learned:([a-z0-9-]+?)(:later)?$/.exec(id);
  return m === null ? null : { slug: m[1]!, secondary: m[2] !== undefined };
};

export interface LastTurn {
  readonly trace: TurnTrace;
  readonly window: string | null;
  readonly answers: Readonly<Record<string, string>>;
  /** The tools this persona may use. */
  readonly allowed: ReadonlyArray<string>;
}

const readCases = (dir: string): ReadonlyArray<RecordedCase> => {
  try {
    return NodeFS.readdirSync(casesDir(dir))
      .filter((n) => n.endsWith(".json"))
      .map(
        (n) =>
          JSON.parse(NodeFS.readFileSync(NodePath.join(casesDir(dir), n), "utf8")) as RecordedCase,
      );
  } catch {
    return [];
  }
};

/**
 * Learn from a turn: write a skill, replay the turn without and with it, replay every kept case it
 * would be given to, and keep it (waiting for his yes) only if the turn got shorter and nothing broke.
 * Returns a sentence for him.
 */
export const learnFromTurn = async (input: {
  readonly dir: string;
  readonly turn: LastTurn;
  /** The writer: his words and code-written fields in, a skill out. */
  readonly ask: (system: string, user: string) => Promise<string>;
  /** One replay of a sentence with recorded answers; `extra` is added the way a matched skill is. */
  readonly replay: (c: RecordedCase, extra?: string) => Promise<ReadonlyArray<string>>;
  readonly now: Date;
  readonly progress?: (line: string) => void;
}): Promise<string> => {
  const { trace } = input.turn;
  if (trace.calls.length < 3 && trace.stoppedBy === null) {
    return "That turn was already short, so there is nothing to learn from it.";
  }
  input.progress?.("Writing a skill from that turn…");
  const written = skillFromWriter(
    await input.ask(WRITER_SYSTEM, writerInput(trace, input.turn.allowed)),
    trace,
    input.turn.allowed,
  );
  if (!written.ok) return `I could not learn from that. ${written.why}`;
  const skill = written.skill;
  const states = readStates(input.dir);
  const before = states[skill.slug];
  if (
    before?.state === "rejected" &&
    input.now.getTime() - Date.parse(before.at) < REJECT_KEEP_MS
  ) {
    return `You said no to a skill for "${skill.when}" in the last 30 days, so I left it.`;
  }
  const done = [...trace.calls].toReversed().find((c) => c.ok) ?? trace.calls.at(-1);
  const target: RecordedCase = {
    id: `${skill.slug}-${input.now.getTime()}`,
    said: trace.said,
    window: input.turn.window,
    persona: trace.persona,
    answers: input.turn.answers,
    goal: done?.tool ?? "none",
    maxCalls: trace.calls.length,
  };
  const block = skillsBlock([skill]);
  const run = async (c: RecordedCase, extra?: string): Promise<ReadonlyArray<Replay>> => {
    const out: Replay[] = [];
    for (let i = 0; i < REPLAY_SAMPLES; i += 1) {
      const calls = await input.replay(c, extra).catch(() => ["error"]);
      out.push({
        reached: calls.some((t) => batonToolName(t) === c.goal),
        calls: calls.length,
      });
    }
    return out;
  };
  input.progress?.("Testing it on that turn…");
  const without = await run(target);
  const withSkill = await run(target, block);
  // Only the kept cases this skill would be given to can change.
  const others = readCases(input.dir).filter(
    (c) =>
      matchSkills(
        [{ ...skill, verified: true }],
        { [skill.slug]: { state: "accepted", at: "", uses: 0 } },
        {
          text: c.said,
          app: skill.apps[0] ?? null,
          persona: c.persona,
          project: skill.project,
        },
      ).length > 0,
  );
  const otherResults = [];
  for (const c of others) {
    const passes = (r: ReadonlyArray<Replay>) =>
      r.filter((x) => x.reached && x.calls <= c.maxCalls).length * 2 > r.length;
    otherResults.push({ before: passes(await run(c)), after: passes(await run(c, block)) });
  }
  const result = verdict({ without, with: withSkill, others: otherResults });
  if (!result.pass)
    return `I tried a skill for "${skill.when}", but it did not help (${result.evidence}), so I did not keep it.`;
  NodeFS.mkdirSync(casesDir(input.dir), { recursive: true });
  const after = withSkill
    .filter((r) => r.reached)
    .map((r) => r.calls)
    .toSorted((a, b) => a - b);
  // The fixed turn stays as a case, held to what the skill achieved.
  NodeFS.writeFileSync(
    NodePath.join(casesDir(input.dir), `${target.id}.json`),
    JSON.stringify({ ...target, maxCalls: after.at(-1) ?? target.maxCalls }),
  );
  const file = NodePath.join(input.dir, `${skill.slug}.md`);
  if (NodeFS.existsSync(file)) {
    NodeFS.mkdirSync(NodePath.join(input.dir, ".history"), { recursive: true });
    NodeFS.copyFileSync(
      file,
      NodePath.join(input.dir, ".history", `${skill.slug}-${input.now.getTime()}.md`),
    );
  }
  const kept = { ...skill, verified: true, evidence: result.evidence };
  NodeFS.writeFileSync(file, skillFileText(kept));
  writeStates(input.dir, {
    ...states,
    [skill.slug]: {
      state: "waiting",
      at: input.now.toISOString(),
      uses: 0,
      hash: fingerprint(kept),
    },
  });
  return `I learned a skill for "${skill.when}" and tested it: ${result.evidence}. It waits for your yes under What I've learned.`;
};

const recentDir = (dir: string) => NodePath.join(dir, ".recent");
const KEEP_RECENT_MS = 2 * 86_400_000;
/** The groups the nightly pass learns from; the rest wait for the next night. */
export const NIGHTLY_LEARN = 2;

/** Deletes kept turns older than two days. */
export const pruneRecentTurns = (dir: string, now: number): void => {
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(recentDir(dir));
  } catch {
    return;
  }
  for (const name of names) {
    if (Number(name.replace(/\.json$/, "")) < now - KEEP_RECENT_MS)
      NodeFS.rmSync(NodePath.join(recentDir(dir), name), { force: true });
  }
};

/** Keeps a turn for the nightly pass on this machine, obvious secrets in its tool output taken out. */
export const keepRecentTurn = (dir: string, kept: KeptTurn, now: number): void => {
  NodeFS.mkdirSync(recentDir(dir), { recursive: true });
  const answers = Object.fromEntries(
    Object.entries(kept.answers).map(([tool, text]) => [tool, redactText(text)]),
  );
  NodeFS.writeFileSync(
    NodePath.join(recentDir(dir), `${kept.turn}.json`),
    JSON.stringify({ ...kept, answers }),
  );
  pruneRecentTurns(dir, now);
};

const readRecent = (dir: string): ReadonlyArray<KeptTurn> => {
  try {
    return NodeFS.readdirSync(recentDir(dir)).flatMap((name) => {
      try {
        return [
          JSON.parse(NodeFS.readFileSync(NodePath.join(recentDir(dir), name), "utf8")) as KeptTurn,
        ];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

/**
 * The lead's nightly pass: the last day's slow, stopped or corrected turns the Record names, grouped by
 * kind, and a skill learned from the worst turn of the top two groups, each tested by replay and left
 * for his yes. A group it tried is dropped whatever the result, so a failed test is logged, not retried.
 */
export const learnNightly = async (input: {
  readonly dir: string;
  readonly traced: ReadonlySet<number>;
  readonly ask: (system: string, user: string) => Promise<string>;
  /** A replay on the model the turn used. */
  readonly replay: (
    brain: KeptTurn["brain"],
  ) => (c: RecordedCase, extra?: string) => Promise<ReadonlyArray<string>>;
  readonly now: Date;
}): Promise<{ readonly text: string; readonly replays: number }> => {
  pruneRecentTurns(input.dir, input.now.getTime());
  const groups = nightlyGroups(readRecent(input.dir), input.traced);
  if (groups.length === 0) return { text: "Nothing in the last day to learn from.", replays: 0 };
  let replays = 0;
  const lines: string[] = [];
  for (const group of groups.slice(0, NIGHTLY_LEARN)) {
    const worst = group[0]!;
    const replay = input.replay(worst.brain);
    lines.push(
      await learnFromTurn({
        dir: input.dir,
        turn: worst,
        ask: input.ask,
        replay: (c, extra) => ((replays += 1), replay(c, extra)),
        now: input.now,
      }).catch(
        (error: unknown) =>
          `I could not learn from "${worst.trace.said.slice(0, 80)}": ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    for (const k of group)
      NodeFS.rmSync(NodePath.join(recentDir(input.dir), `${k.turn}.json`), { force: true });
  }
  return {
    text: `${lines.join(" ")} Looked at ${groups.length} kind${groups.length === 1 ? "" : "s"} of request; ${replays} replays.`,
    replays,
  };
};
