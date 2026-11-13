// node --test scripts/tessaya/live/answer-review.test.mjs
// Answering the last question of a form must also confirm Claude Code's "Ready to submit your answers?" screen.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { parsePanePrompt } from "./pane-prompt.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixture = (name) => NodeFS.readFileSync(NodePath.join(here, "__fixtures__", name), "utf8");
/** What the question card sends back: its question (with the prompt's ref), then the choice. */
const cardAnswer = (screen, choice) => `${parsePanePrompt(screen).question}\n${choice}`;

/** A herdr that shows the screens in order, moving to the next each time keys are sent. */
const fakePane = (screens) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "answer-review-"));
  screens.forEach((text, i) => NodeFS.writeFileSync(NodePath.join(dir, `screen-${i}`), text));
  NodeFS.writeFileSync(NodePath.join(dir, "stage"), "0");
  const bin = NodePath.join(dir, "herdr");
  NodeFS.writeFileSync(
    bin,
    `#!/bin/sh
case " $* " in
  *" send-keys "*) echo "$*" | sed 's/.*send-keys [^ ]* //' >> ${dir}/keys; n=$(cat ${dir}/stage); echo $((n+1)) > ${dir}/stage ;;
  *" read "*) cat ${dir}/screen-$(cat ${dir}/stage) 2>/dev/null || cat ${dir}/screen-${screens.length - 1} ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    bin,
    keys: () =>
      NodeFS.existsSync(NodePath.join(dir, "keys"))
        ? NodeFS.readFileSync(NodePath.join(dir, "keys"), "utf8").trim().split("\n")
        : [],
  };
};

const answerWith = async (screens, answer) => {
  const pane = fakePane(screens);
  process.env.BATON_HERDR_BIN = pane.bin;
  process.env.BATON_LIVE_PROMPT_CLEAR_TRIES = "6";
  const mod = await import(`./baton-live-acp.mjs?${Math.random()}`);
  const told = await mod.answerPrompt("s1", "fab-x~p1", answer);
  return { told, keys: pane.keys() };
};

const WORKING = "\n  ✻ Working…\n\n  ❯ \n";

NodeTest.test(
  "the last answer of a form also submits the review screen, then says so",
  async () => {
    const { told, keys } = await answerWith(
      [fixture("pane-question.txt"), fixture("pane-review.txt"), WORKING],
      cardAnswer(fixture("pane-question.txt"), "Red"),
    );
    NodeAssert.equal(keys.length, 2, `keys sent: ${JSON.stringify(keys)}`);
    NodeAssert.equal(
      keys.at(-1),
      "enter",
      "Submit answers is highlighted, so one Enter confirms it",
    );
    NodeAssert.match(told, /Answered in the terminal: Red/);
    NodeAssert.match(told, /submitted/i);
    NodeAssert.doesNotMatch(told, /asking again/);
  },
);

NodeTest.test(
  "a new question after an answer is not submitted and is reported as a new question",
  async () => {
    const { told, keys } = await answerWith(
      [fixture("pane-question.txt"), fixture("pane-form-tabs.txt")],
      cardAnswer(fixture("pane-question.txt"), "Red"),
    );
    NodeAssert.equal(keys.length, 1);
    NodeAssert.match(told, /asking again|next question/i);
  },
);

NodeTest.test("a plain message is never taken as the answer to a pending form", async () => {
  const { told, keys } = await answerWith([fixture("pane-question.txt")], "Status?");
  NodeAssert.equal(told, null);
  NodeAssert.deepEqual(keys, [], "no key was pressed");
  const mod = await import(`./baton-live-acp.mjs?${Math.random()}`);
  NodeAssert.match(
    mod.questionWaitingNote("Which colour do you prefer?", 1),
    /A question is waiting \(Which colour/,
  );
});
