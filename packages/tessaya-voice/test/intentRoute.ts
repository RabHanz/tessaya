/** The cheap, model-free part of routing a spoken sentence: what the rules decide before the assistant is asked. */
import { guardDecision, instantDecision } from "@t3tools/tessaya-shared/brain";
import { isCancelPhrase, isDismissPhrase } from "@t3tools/tessaya-shared/voiceTurn";

import { stripWake } from "../src/modeMachine.ts";

/**
 * "cancel" and "dismiss" are the two spoken endings; "<route>:instant|guard" is a rule that placed the
 * sentence; "model" means no rule did, so the one assistant decides, behind One Trust.
 */
export const ruleRoute = async (said: string): Promise<string> => {
  // The voice core strips the wake word before either check, so the rows can say one.
  const words = stripWake(said, ["baton", "jarvis", "alfred", "freya", "tessaya"]);
  if (isCancelPhrase(words)) return "cancel";
  if (isDismissPhrase(said)) return "dismiss";
  const instant = instantDecision(said, false);
  if (instant === null) return "model";
  const decision = guardDecision(instant, said);
  return `${decision.route}:${decision.source}`;
};
