/**
 * His accepted skills for a turn on any vessel (SPINE-UNIFY §9): they live in the one memory as `kind: skill`, and a
 * turn gets the ones that match its words, app and persona and that name only tools this turn has.
 */
import {
  matchSkills,
  parseLearnedSkill,
  skillsBlock,
  type LearnedSkill,
} from "@t3tools/baton-shared/skillLearning";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BatonMemoryService } from "./BatonMemoryService.ts";
import type { TurnEnvelope } from "./TessayaTurn.ts";

const SKILL_REF = "skill:";
/** shortcut: read at most once a minute; a skill he just accepted reaches turns within the minute. */
const FRESH_MS = 60_000;
let held: { readonly at: number; readonly skills: ReadonlyArray<LearnedSkill> } | null = null;

/** Every skill item as the skill it is; a text that no longer parses is left out. */
export const skillsOf = (
  items: ReadonlyArray<{ readonly text: string; readonly sourceRef: string | null }>,
): ReadonlyArray<LearnedSkill> =>
  items.flatMap((item) => {
    const slug = item.sourceRef?.startsWith(SKILL_REF)
      ? item.sourceRef.slice(SKILL_REF.length)
      : "";
    const skill = slug === "" ? null : parseLearnedSkill(item.text, slug);
    return skill === null ? [] : [skill];
  });

export const turnSkills = Effect.fn("TurnSkills.forTurn")(function* (
  turn: Pick<TurnEnvelope, "text" | "persona" | "project" | "app">,
  tools: ReadonlyArray<string>,
) {
  const memory = yield* Effect.serviceOption(BatonMemoryService);
  if (Option.isNone(memory)) return "";
  const now = yield* Clock.currentTimeMillis;
  if (held === null || now - held.at > FRESH_MS)
    held = {
      at: now,
      skills: skillsOf(
        yield* memory.value
          .list({ kinds: ["skill"], limit: 500 })
          .pipe(Effect.orElseSucceed(() => [])),
      ),
    };
  // Each one in memory is one he accepted after its test: that is what being kept as a skill means.
  const usable = held.skills.filter((s) => s.tools.every((t) => tools.includes(t)));
  const accepted = Object.fromEntries(
    usable.map((s) => [s.slug, { state: "accepted" as const, at: "", uses: 0 }]),
  );
  return skillsBlock(
    matchSkills(usable, accepted, {
      text: turn.text,
      app: turn.app ?? null,
      persona: turn.persona ?? "",
      project: turn.project ?? null,
    }),
  );
});
