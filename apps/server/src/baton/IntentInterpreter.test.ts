/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Which account reads a sentence.
 *
 * Found on the Director's local box rather than here: the first configured
 * instance there is a claude-swap account whose refresh token has expired. It
 * reports enabled, installed and `authenticated` — the CLI still knows whose
 * account it is — and it cannot answer. Choosing it turned "a model reads your
 * sentence" into "the grammar refused", in 215ms, with nothing on screen to say
 * why.
 */
import { describe, expect, it } from "vite-plus/test";

import type { IntentProvider, IntentVocabulary } from "@t3tools/baton-shared/intentParser";

import { chooseInterpreterInstance } from "./IntentInterpreter.ts";

/** The routing table's `intent` model; the choice of account does not depend on it. */
const MODEL = "haiku";

const provider = (
  overrides: Partial<IntentProvider> & { readonly instanceId: string },
): IntentProvider => ({
  aliases: [overrides.instanceId],
  driver: "claudeAgent",
  label: overrides.instanceId,
  model: "claude-fable-5-1",
  available: true,
  signedIn: true,
  ...overrides,
});

const vocabularyOf = (providers: ReadonlyArray<IntentProvider>): IntentVocabulary => ({
  workSessions: [],
  projects: [],
  providers,
  openGates: [],
  hostAliases: [],
  focusedWorkSessionId: null,
});

describe("choosing the account that reads a sentence", () => {
  it("skips a configured account whose login has expired", () => {
    const chosen = chooseInterpreterInstance(
      vocabularyOf([
        // Exactly the shape of the two claude-swap accounts on the local box:
        // configured first, available, and unable to answer.
        provider({ instanceId: "claude-robin", signedIn: false }),
        provider({ instanceId: "claude-sablebox", signedIn: false }),
        provider({ instanceId: "claudeAgent" }),
      ]),
      MODEL,
    );

    expect(chosen).toEqual({ instanceId: "claudeAgent", model: MODEL });
  });

  it("keeps the environment's own order among accounts that can answer", () => {
    const chosen = chooseInterpreterInstance(
      vocabularyOf([
        provider({ instanceId: "claude-sablebox" }),
        provider({ instanceId: "claudeAgent" }),
      ]),
      MODEL,
    );

    // Stable and predictable: not "the one with most quota", because the
    // account is what the call is billed to.
    expect(chosen?.instanceId).toBe("claude-sablebox");
  });

  it("skips a signed-in account whose driver cannot read a sentence", () => {
    // The second live finding, from the same box: Codex is available, signed in
    // and first in the list, and only the Claude driver implements the one-shot
    // (D50 made it optional per driver). Choosing it spent a round trip to be
    // told so, and the sentence came back as the grammar's refusal.
    const chosen = chooseInterpreterInstance(
      vocabularyOf([
        provider({ instanceId: "codex", driver: "codex" }),
        provider({ instanceId: "claudeAgent" }),
      ]),
      MODEL,
    );

    expect(chosen).toEqual({ instanceId: "claudeAgent", model: MODEL });
  });

  it("has nothing to choose when the only accounts are on drivers that cannot", () => {
    expect(
      chooseInterpreterInstance(
        vocabularyOf([provider({ instanceId: "codex", driver: "codex" })]),
        MODEL,
      ),
    ).toBeNull();
  });

  it("still tries an available account that publishes no address", () => {
    // A provider that does not report an email is not thereby broken, and
    // refusing to try would be the same silence in a different costume.
    const chosen = chooseInterpreterInstance(
      vocabularyOf([provider({ instanceId: "codex", signedIn: false })]),
      MODEL,
    );

    expect(chosen?.instanceId).toBe("codex");
  });

  it("has nothing to choose when no account is available", () => {
    expect(
      chooseInterpreterInstance(
        vocabularyOf([provider({ instanceId: "claudeAgent", available: false })]),
        MODEL,
      ),
    ).toBeNull();
  });
});
