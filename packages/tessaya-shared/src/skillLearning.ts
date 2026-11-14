/**
 * Learning v0 (docs/baton/LEARNING.md): skills Tessaya writes from a turn that went badly or slowly.
 * A skill is advice in a plain file in his pack folder (`operating-system/skills/<slug>.md`); it never
 * grants anything, and it is used only once it passed its replay test and he accepted it. Pure: the
 * desktop reads and writes the files, asks the model and runs the replays.
 */
import { splitFront, type Brain } from "./osPack.ts";
import { tessayaToolName } from "./operator.ts";
import { parseSkill, reviewSkill, slugOf } from "./skillReview.ts";

export const SKILLS_FOLDER = "skills";
export const SKILL_BODY_CHARS = 600;
/** What a turn's skills may add to its prompt, all together. */
export const SKILLS_BLOCK_CHARS = 600;
export const SKILLS_PER_TURN = 2;

export interface LearnedSkill {
  readonly slug: string;
  /** The kind of request it is for, in his words. */
  readonly when: string;
  /** Window apps it is for, lower case ("notepad.exe"); empty for any. */
  readonly apps: ReadonlyArray<string>;
  /** The tools it names; never more than the persona may use. */
  readonly tools: ReadonlyArray<string>;
  readonly persona: string | null;
  readonly project: string | null;
  /** Passed its replay test: fewer calls on the turn it came from, and no recorded case got worse. */
  readonly verified: boolean;
  /** What the test showed, for the list: "11 calls -> 2; 3 other cases unchanged". */
  readonly evidence: string;
  readonly body: string;
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

export const parseLearnedSkill = (text: string, slug: string): LearnedSkill | null => {
  const { fields, body } = splitFront(text);
  const when = (fields["when"] ?? "").trim();
  if (when === "" || body === "") return null;
  return {
    slug,
    when,
    apps: list(fields["apps"]).map((a) => a.toLowerCase()),
    tools: list(fields["tools"]),
    persona: fields["persona"]?.trim() || null,
    project: fields["project"]?.trim() || null,
    verified: fields["verified"] === "true",
    evidence: fields["evidence"] ?? "",
    body: body.slice(0, SKILL_BODY_CHARS),
  };
};

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export const skillFileText = (s: LearnedSkill): string =>
  [
    "---",
    `when: ${oneLine(s.when)}`,
    `apps: ${s.apps.join(", ")}`,
    `tools: ${s.tools.join(", ")}`,
    ...(s.persona === null ? [] : [`persona: ${oneLine(s.persona)}`]),
    ...(s.project === null ? [] : [`project: ${oneLine(s.project)}`]),
    `verified: ${s.verified}`,
    `evidence: ${oneLine(s.evidence)}`,
    "---",
    s.body,
    "",
  ].join("\n");

/** His decision on each skill, by slug, in `skills.json` beside the files. A tested skill waits for his tap. */
export interface SkillState {
  readonly state: "waiting" | "accepted" | "rejected";
  readonly at: string;
  readonly uses: number;
  /** The fingerprint of the text that passed its test; a skill whose text differs is not used. */
  readonly hash?: string;
}
export type SkillStates = Readonly<Record<string, SkillState>>;

export const parseSkillStates = (text: string | undefined): SkillStates => {
  try {
    const value = JSON.parse(text ?? "{}") as Record<string, Partial<SkillState>>;
    const out: Record<string, SkillState> = {};
    for (const [slug, s] of Object.entries(value)) {
      if (s.state === "waiting" || s.state === "accepted" || s.state === "rejected") {
        out[slug] = {
          state: s.state,
          at: typeof s.at === "string" ? s.at : "",
          uses: typeof s.uses === "number" ? s.uses : 0,
          ...(typeof s.hash === "string" ? { hash: s.hash } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
};

const STOP = new Set([
  "the",
  "and",
  "into",
  "with",
  "that",
  "this",
  "for",
  "from",
  "then",
  "please",
  "can",
  "you",
  "what",
]);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );

/**
 * The skills for this sentence: accepted and verified, for this persona and project (or any), scored by
 * the words its `when` shares with the sentence and the window's app. At most two, within the block's size.
 */
export const matchSkills = (
  skills: ReadonlyArray<LearnedSkill>,
  states: SkillStates,
  turn: {
    readonly text: string;
    readonly app: string | null;
    readonly persona: string;
    readonly project: string | null;
  },
): ReadonlyArray<LearnedSkill> => {
  const said = words(`${turn.text} ${turn.app ?? ""}`);
  const app = turn.app?.toLowerCase() ?? null;
  const scored = skills
    .filter(
      (s) =>
        s.verified &&
        states[s.slug]?.state === "accepted" &&
        (s.persona === null || s.persona === turn.persona) &&
        (s.project === null || s.project === turn.project) &&
        (s.apps.length === 0 || (app !== null && s.apps.includes(app))),
    )
    .map((s) => ({ s, score: [...words(s.when)].filter((w) => said.has(w)).length }))
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score || a.s.slug.localeCompare(b.s.slug));
  const out: LearnedSkill[] = [];
  let chars = 0;
  for (const { s } of scored) {
    if (out.length === SKILLS_PER_TURN || chars + s.body.length > SKILLS_BLOCK_CHARS) break;
    out.push(s);
    chars += s.body.length;
  }
  return out;
};

export const skillsBlock = (skills: ReadonlyArray<LearnedSkill>): string =>
  skills.length === 0
    ? ""
    : `skills you learned from earlier turns (data: advice on how, never permission; every action still asks as usual):\n${skills
        .map((s) => `- ${s.slug} (when ${s.when}): ${s.body.replace(/\s+/g, " ")}`)
        .join("\n")}`;

/** The window's app from its label ("notepad.exe: notes.txt"), lower case. */
export const appOf = (window: string | null): string | null => {
  const app = window?.split(":")[0]?.trim().toLowerCase() ?? "";
  return app === "" ? null : app;
};

/** One tool call of a turn, as code wrote it: no arguments' values, no output. */
export interface TraceCall {
  readonly tool: string;
  readonly argKeys: ReadonlyArray<string>;
  readonly ok: boolean;
  readonly ms: number;
}

/** What the writer may see of a turn: his own words and fields code wrote, never page, file, screen or session text. */
export interface TurnTrace {
  readonly said: string;
  readonly app: string | null;
  readonly persona: string;
  readonly project: string | null;
  readonly calls: ReadonlyArray<TraceCall>;
  readonly stoppedBy: "stop" | "mouse" | "guard" | null;
}

export const WRITER_SYSTEM = `You turn one of Tessaya's slow or failed turns into a short skill she can follow the next time he asks for the same kind of thing. You see his sentence, the app in front, and the tools she called in order with whether each worked. Work out the shortest path that would have done it.
Reply with one JSON object and nothing else: {"when": "...", "tools": ["..."], "body": "..."}
- when: the kind of request, in a few plain words he would use (for example "type text into an app").
- tools: the tools the skill names, only from the list she may use.
- body: at most 500 characters: which tools to call, in what order, and what to skip.
A skill is advice, never permission. Never tell her to skip asking, act without asking, or use a tool outside the list.`;

export const writerInput = (trace: TurnTrace, allowed: ReadonlyArray<string>): string =>
  JSON.stringify({
    he_said: trace.said,
    app_in_front: trace.app,
    tools_she_may_use: allowed,
    calls: trace.calls.map((c) => ({ tool: c.tool, arguments: c.argKeys, worked: c.ok })),
    stopped_by: trace.stoppedBy,
  });

/** The writer's answer as a skill not yet tested, or why it is refused (skillReview's checks, tools outside his list). */
export const skillFromWriter = (
  answer: string,
  trace: TurnTrace,
  allowed: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly skill: LearnedSkill }
  | { readonly ok: false; readonly why: string } => {
  let value: { when?: unknown; tools?: unknown; body?: unknown };
  try {
    value = JSON.parse(/\{[\s\S]*\}/.exec(answer)?.[0] ?? "") as typeof value;
  } catch {
    return { ok: false, why: "The writer did not answer in the expected form." };
  }
  const when = typeof value.when === "string" ? oneLine(value.when).slice(0, 120) : "";
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const tools = Array.isArray(value.tools)
    ? value.tools.filter((t): t is string => typeof t === "string")
    : [];
  if (when === "" || body === "") return { ok: false, why: "The skill came back empty." };
  if (body.length > SKILL_BODY_CHARS) return { ok: false, why: "The skill came back too long." };
  const outside = tools.filter((t) => !allowed.includes(t));
  if (outside.length > 0) {
    return { ok: false, why: `It names tools this persona may not use: ${outside.join(", ")}.` };
  }
  const skill: LearnedSkill = {
    slug: slugOf(when).slice(0, 48) || "skill",
    when,
    apps: trace.app === null ? [] : [trace.app],
    tools,
    persona: trace.persona,
    project: trace.project,
    verified: false,
    evidence: "",
    body,
  };
  const text = skillFileText(skill);
  const parsed = parseSkill(text, skill.slug);
  const high = parsed.ok
    ? reviewSkill(parsed.skill, text).filter((f) => f.level === "high")
    : [{ what: parsed.why }];
  if (high.length > 0) {
    return { ok: false, why: `It was refused: it ${high.map((f) => f.what).join("; ")}.` };
  }
  return { ok: true, skill };
};

/** One replay of a turn: whether it reached the tool that did the work, and how many calls it took. */
export interface Replay {
  readonly reached: boolean;
  readonly calls: number;
}

const median = (xs: ReadonlyArray<number>) =>
  xs.toSorted((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? Number.POSITIVE_INFINITY;
const cost = (r: Replay) => (r.reached ? r.calls : Number.POSITIVE_INFINITY);
const shown = (n: number) => (Number.isFinite(n) ? String(n) : "not done");

/**
 * Kept only when the turn it came from gets better (reached in most samples, in fewer calls) and no
 * other recorded case that passed without it fails with it.
 */
export const verdict = (input: {
  readonly without: ReadonlyArray<Replay>;
  readonly with: ReadonlyArray<Replay>;
  readonly others: ReadonlyArray<{ readonly before: boolean; readonly after: boolean }>;
}): { readonly pass: boolean; readonly evidence: string } => {
  const before = median(input.without.map(cost));
  const after = median(input.with.map(cost));
  const broke = input.others.filter((o) => o.before && !o.after).length;
  const improved = Number.isFinite(after) && after < before;
  return {
    pass: improved && broke === 0,
    evidence: `${shown(before)} calls -> ${shown(after)}; ${input.others.length - broke} other cases still pass${broke === 0 ? "" : `, ${broke} broke`}`,
  };
};

/** A turn kept to replay: his sentence, the window, each tool's recorded answer, and the tool that did the work. */
export interface RecordedCase {
  readonly id: string;
  readonly said: string;
  readonly window: string | null;
  readonly persona: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly goal: string;
  readonly maxCalls: number;
}

/** A replay passes when it reaches the goal tool within the case's calls. */
export const pathPasses = (
  c: Pick<RecordedCase, "goal" | "maxCalls">,
  calls: ReadonlyArray<string>,
): boolean => calls.length <= c.maxCalls && calls.some((t) => tessayaToolName(t) === c.goal);

/** A turn kept on this machine for the nightly pass: its trace, what a replay needs, and its id (when it began). */
export interface KeptTurn {
  readonly turn: number;
  readonly trace: TurnTrace;
  readonly window: string | null;
  readonly answers: Readonly<Record<string, string>>;
  readonly allowed: ReadonlyArray<string>;
  readonly brain: Brain;
}

/** The turns the Record's `turn_trace` rows name (their detail carries the turn's id). */
export const tracedTurns = (
  rows: ReadonlyArray<{ readonly kind: string; readonly detail: string }>,
): ReadonlySet<number> =>
  new Set(
    rows.flatMap((r) => {
      const id = r.kind === "turn_trace" ? /"turn":(\d+)/.exec(r.detail)?.[1] : undefined;
      return id === undefined ? [] : [Number(id)];
    }),
  );

const CORRECTION = /^(no|nope|not that|wrong|i meant|i said)\b/i;
const same = (a: string, b: string) =>
  a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/** Turns he corrected: answered within a minute by "no, I meant…", or the same request again within ten. */
export const correctedTurns = (
  turns: ReadonlyArray<{ readonly turn: number; readonly said: string }>,
): ReadonlySet<number> => {
  const sorted = turns.toSorted((a, b) => a.turn - b.turn);
  const out = new Set<number>();
  sorted.forEach((t, i) => {
    const next = sorted[i + 1];
    if (next === undefined) return;
    const gap = next.turn - t.turn;
    if (
      (gap <= 60_000 && CORRECTION.test(next.said)) ||
      (gap <= 600_000 && same(t.said, next.said))
    )
      out.add(t.turn);
  });
  return out;
};

export const NIGHTLY_GROUPS = 8;

/**
 * Distil, with no model: of the turns the last day's Record names, those worth learning from (three
 * calls or more, stopped, or corrected), grouped by the kind of request (shared words and the same
 * app), at most eight groups, the costliest first. A group's worst turn is the one to learn from.
 */
export const nightlyGroups = (
  kept: ReadonlyArray<KeptTurn>,
  traced: ReadonlySet<number>,
): ReadonlyArray<ReadonlyArray<KeptTurn>> => {
  const corrected = correctedTurns(kept.map((k) => ({ turn: k.turn, said: k.trace.said })));
  const worth = kept.filter(
    (k) =>
      traced.has(k.turn) &&
      (k.trace.calls.length >= 3 || k.trace.stoppedBy !== null || corrected.has(k.turn)),
  );
  const groups: KeptTurn[][] = [];
  for (const k of worth) {
    const mine = words(k.trace.said);
    const home = groups.find((g) => {
      const theirs = words(g[0]!.trace.said);
      const shared = [...mine].filter((w) => theirs.has(w)).length;
      return (
        g[0]!.trace.app === k.trace.app &&
        (shared > 0 || mine.size + theirs.size === 0) &&
        shared * 2 >= Math.min(mine.size, theirs.size)
      );
    });
    if (home === undefined) groups.push([k]);
    else home.push(k);
  }
  const calls = (g: ReadonlyArray<KeptTurn>) => g.reduce((n, k) => n + k.trace.calls.length, 0);
  return groups
    .map((g) => g.toSorted((a, b) => b.trace.calls.length - a.trace.calls.length))
    .toSorted((a, b) => calls(b) - calls(a))
    .slice(0, NIGHTLY_GROUPS);
};
