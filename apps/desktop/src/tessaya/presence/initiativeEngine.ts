// @effect-diagnostics nodeBuiltinImport:off
/**
 * Runs the initiative policy on a timer's tick: gather triggers, decide, show each offer as a card
 * (Yes, Later, Never), and carry out a Yes through `act`. A Yes only starts a plan-first job or notes
 * a commitment, so nothing here acts unattended. State is one small JSON file.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  allowTopic,
  answerOffer,
  decide,
  EMPTY_INITIATIVE,
  resumeAbout,
  stopAbout,
  type Answer,
  type InitiativeState,
  type Policy,
  type Trigger,
} from "@t3tools/tessaya-shared/initiative";

export interface InitiativeDeps {
  readonly dir: string;
  readonly now: () => number;
  readonly hour: () => number;
  readonly policy: () => Policy | null;
  readonly gather: () => Promise<ReadonlyArray<Trigger>>;
  /** Shows one offer and returns his answer. No answer in time is "later". */
  readonly present: (offer: Trigger) => Promise<Answer>;
  /** Carries out a Yes; returns a sentence to show, and throws when it cannot. */
  readonly act: (offer: Trigger) => Promise<string>;
  readonly tell: (text: string) => void;
}

export const createInitiative = (deps: InitiativeDeps) => {
  const file = NodePath.join(deps.dir, "initiative.json");
  const load = (): InitiativeState => {
    try {
      return { ...EMPTY_INITIATIVE, ...(JSON.parse(NodeFS.readFileSync(file, "utf8")) as object) };
    } catch {
      return EMPTY_INITIATIVE;
    }
  };
  const save = (state: InitiativeState): void => {
    NodeFS.mkdirSync(deps.dir, { recursive: true });
    NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    NodeFS.renameSync(`${file}.tmp`, file);
  };
  let busy = false;
  return {
    state: load,
    /** One pass. Re-entrant calls while a card is open do nothing. */
    tick: async (): Promise<number> => {
      const policy = deps.policy();
      if (policy === null || busy) return 0;
      busy = true;
      try {
        const triggers = await deps.gather();
        const result = decide(triggers, load(), policy, deps.now(), deps.hour());
        save(result.state);
        for (const offer of result.offers) {
          const answer = await deps.present(offer);
          save(answerOffer(load(), offer, answer, deps.now()));
          if (answer !== "yes") continue;
          try {
            deps.tell(await deps.act(offer));
          } catch (error) {
            deps.tell(
              `I could not do that: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return result.offers.length;
      } finally {
        busy = false;
      }
    },
    stop: (words: string): string => {
      const { state, stopped } = stopAbout(load(), words);
      if (stopped.length === 0)
        return "I have not raised anything like that, so there is nothing to stop.";
      save(state);
      return `I will stop telling you about: ${stopped.join("; ")}.`;
    },
    resume: (words: string): string => {
      const { state, resumed } = resumeAbout(load(), words);
      if (resumed.length === 0) return "Nothing matching was muted.";
      save(state);
      return `I will tell you about these again: ${resumed.join("; ")}.`;
    },
    allow: (topic: string): void => save(allowTopic(load(), topic)),
  };
};
export type Initiative = ReturnType<typeof createInitiative>;
