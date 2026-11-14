/**
 * His accepted skills in the one memory (SPINE-UNIFY §9): exactly the ones he accepted after their replay test, so
 * every vessel's turn can use them. Drafts and their replay cases stay in this machine's pack folder.
 */
import {
  skillFileText,
  type LearnedSkill,
  type SkillStates,
} from "@t3tools/tessaya-shared/skillLearning";

/** One call to the server's `baton.memory.*`. */
export type MemoryCall = (op: string, args: Record<string, unknown>) => Promise<unknown>;

interface SkillItem {
  readonly id: string;
  readonly text: string;
  readonly sourceRef: string | null;
}

/**
 * Makes memory's skills the accepted ones: adds what is new, replaces what changed, forgets what he forgot or rejected.
 * `isTested` says a skill's text is the one that passed its test (the pack's fingerprint).
 */
export const syncSkillsToMemory = async (input: {
  readonly skills: ReadonlyArray<LearnedSkill>;
  readonly states: SkillStates;
  readonly isTested: (skill: LearnedSkill) => boolean;
  readonly call: MemoryCall;
}): Promise<{ readonly added: number; readonly forgotten: number }> => {
  const accepted = new Map(
    input.skills
      .filter((s) => s.verified && input.states[s.slug]?.state === "accepted" && input.isTested(s))
      .map((s) => [`skill:${s.slug}`, skillFileText(s).trim()]),
  );
  const kept = (
    (await input.call("list", { kinds: ["skill"], limit: 500 })) as {
      readonly items: ReadonlyArray<SkillItem>;
    }
  ).items;
  let added = 0;
  let forgotten = 0;
  for (const item of kept) {
    if (item.sourceRef !== null && accepted.get(item.sourceRef) === item.text) {
      accepted.delete(item.sourceRef);
      continue;
    }
    await input.call("forget", { id: item.id });
    forgotten += 1;
  }
  for (const [ref, text] of accepted) {
    await input.call("add", { kind: "skill", text, source: "user", sourceRef: ref, pinned: false });
    added += 1;
  }
  return { added, forgotten };
};
