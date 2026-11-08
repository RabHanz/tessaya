// node --test scripts/tessaya/live/baton-live-acp.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { LIVE_EFFORT_CHOICES } from "../../../packages/baton-shared/src/liveModel.ts";
import {
  effortConfigOption,
  LIVE_MODELS,
  LIVE_EFFORTS,
  isAdoptRequest,
  isAnswerInTerminal,
  notSentNote,
  isAppContinuation,
  lowerOomScore,
  paneFromAgentList,
  sessionOfLiveThread,
  BRIDGE_OOM_SCORE_ADJ,
  promptText,
  splitAttachments,
  safeInboxName,
  readableInboxName,
  answerKeys,
  answerFrom,
  enqueue,
  readQueue,
  drainSession,
  holdQueue,
  isResumeRequest,
  releaseQueue,
  resumeFailedNote,
  resumeSession,
  resumingNote,
  sendToStopped,
  appendInbound,
  serverWaiting,
  deliveredNote,
  lostNote,
  queuedNote,
  keptEntry,
  liveQueueDir,
  takeDrainLock,
  UNSURE_NOTE,
  maybeNote,
  run,
  sendFailure,
} from "./baton-live-acp.mjs";
import { parsePanePrompt, parseReviewScreen, screenTail } from "./pane-prompt.mjs";

const AGENT = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "baton-live-acp.mjs",
);

const fixture = (name) =>
  NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "__fixtures__", name),
    "utf8",
  );

NodeTest.test("a permission dialog on the screen is read with its options (D88)", () => {
  const prompt = parsePanePrompt(fixture("pane-permission.txt"));
  NodeAssert.equal(prompt.question, "Do you want to proceed?");
  NodeAssert.match(prompt.context, /echo PERM-TEST/);
  NodeAssert.deepEqual(
    prompt.options.map((o) => o.label),
    ["Yes", "No"],
  );
  NodeAssert.deepEqual(answerKeys(prompt, "No"), { keys: ["down", "enter"], text: null });
  NodeAssert.deepEqual(answerKeys(prompt, "1"), { keys: ["enter"], text: null });
  NodeAssert.equal(answerKeys(prompt, "maybe"), null, "no free text where none is offered");
});

NodeTest.test("an AskUserQuestion is read with its header, descriptions and free-text slot", () => {
  const prompt = parsePanePrompt(fixture("pane-question.txt"));
  NodeAssert.equal(prompt.header, "Colour");
  NodeAssert.equal(prompt.question, "Which colour do you prefer?");
  NodeAssert.deepEqual(
    prompt.options.map((o) => [o.label, o.description]),
    [
      ["Red", "The colour red"],
      ["Green", "The colour green"],
      ["Blue", "The colour blue"],
    ],
  );
  NodeAssert.equal(prompt.customIndex, 3);
  NodeAssert.deepEqual(answerKeys(prompt, "green"), { keys: ["down", "enter"], text: null });
  NodeAssert.deepEqual(answerKeys(prompt, "Purple"), {
    keys: ["down", "down", "down"],
    text: "Purple",
  });
  NodeAssert.equal(answerFrom("Colour. Which colour do you prefer?\nBlue", prompt), "Blue");
  NodeAssert.equal(answerFrom("Blue", prompt), "Blue");
});

NodeTest.test("a dialog whose question sits in a dashed box is read with its options", () => {
  const prompt = parsePanePrompt(fixture("pane-boxed.txt"));
  NodeAssert.equal(
    prompt.question,
    '"Campaign notes" was made by someone else. Let Claude read it?',
  );
  NodeAssert.match(prompt.context, /created outside your organization/);
  NodeAssert.match(
    prompt.context,
    /artifact\/AAAAAAAAAAABBBBBBBBBBB /,
    "the wrapped link is whole",
  );
  NodeAssert.deepEqual(
    prompt.options.map((o) => o.label),
    ["Yes", "No"],
  );
  NodeAssert.deepEqual(answerKeys(prompt, "No"), { keys: ["down", "enter"], text: null });
});

NodeTest.test(
  "a held message with no footer and a wrapped option is read with both options",
  () => {
    const prompt = parsePanePrompt(fixture("pane-held-message.txt"));
    NodeAssert.equal(prompt.question, "Held message from another session");
    NodeAssert.match(prompt.context, /permission mode class/);
    NodeAssert.deepEqual(
      prompt.options.map((o) => o.label),
      ["Deny — drop it and tell the sender it was declined", "Deliver this message to Claude"],
    );
    NodeAssert.deepEqual(answerKeys(prompt, "Deliver this message to Claude"), {
      keys: ["down", "enter"],
      text: null,
    });
  },
);

NodeTest.test("unnumbered options are read too, and a plain screen has no prompt", () => {
  const trust = parsePanePrompt(fixture("pane-trust.txt"));
  NodeAssert.deepEqual(
    trust.options.map((o) => o.label),
    ["No, exit", "Yes, I trust this folder"],
  );
  NodeAssert.deepEqual(answerKeys(trust, "Yes, I trust this folder"), {
    keys: ["down", "enter"],
    text: null,
  });
  NodeAssert.equal(parsePanePrompt("❯ hello\n───────\n  ⏵⏵ bypass permissions on"), null);
});

NodeTest.test("only the user's words reach Claude, never T3's instruction wrappers", () => {
  const first =
    "<t3_code_instructions>\nbe nice\n</t3_code_instructions>\n\n<user_request>\nsay ALPHA\n</user_request>";
  NodeAssert.equal(
    promptText([
      { type: "text", text: first },
      { type: "text", text: "<runtime_info>T3</runtime_info>" },
    ]),
    "say ALPHA",
  );
  NodeAssert.equal(
    promptText([
      { type: "text", text: "plain" },
      { type: "image", data: "x" },
    ]),
    "plain",
  );
});

NodeTest.test("a context handoff T3 prepends never reaches the live session", () => {
  const text =
    "Context handoff (manual_context):\nProvider context handoff. Thread: baton-live:x.\n\nUser message:\nsay ALPHA";
  NodeAssert.equal(promptText([{ type: "text", text }]), "say ALPHA");
  const wrapped = `<t3_code_instructions>\nx\n</t3_code_instructions>\n\n<user_request>\n${text}\n</user_request>`;
  NodeAssert.equal(promptText([{ type: "text", text: wrapped }]), "say ALPHA");
  NodeAssert.equal(isAppContinuation(" Continue where you left off. "), true);
  NodeAssert.equal(isAppContinuation("continue the refactor"), false);
});

NodeTest.test("a plain-terminal session is only moved into Herdr when asked", () => {
  NodeAssert.equal(isAdoptRequest("bring into Herdr"), true);
  NodeAssert.equal(isAdoptRequest(" Bring it into herdr. "), true);
  NodeAssert.equal(isAdoptRequest("please fix the build"), false);
  NodeAssert.equal(isAdoptRequest("It waits in its terminal.\nBring it into Herdr"), true);
  NodeAssert.equal(
    isAnswerInTerminal("Waiting in its terminal:\nProceed?\nI'll answer it in the terminal"),
    true,
  );
  NodeAssert.equal(isAnswerInTerminal("yes"), false);
  NodeAssert.equal(screenTail("a\n\n  \nb  \nc", 2), "b\nc");
  const note = notSentNote({ remoteControl: true, status: "idle" });
  NodeAssert.match(note, /^Not sent\./);
  NodeAssert.match(note, /Remote Control/);
  NodeAssert.match(note, /bring into Herdr/);
});

NodeTest.test("attachment notes become paths", () => {
  const out = splitAttachments(
    'look\n\n[Attached image "a b.png" is saved at: /t3/attachments/x.png]\n\n[Attached file "n.pdf" is saved at: /t3/n.pdf (text extracted to: /t3/n.txt)]',
  );
  NodeAssert.deepEqual(out, { text: "look", paths: ["/t3/attachments/x.png", "/t3/n.pdf"] });
  NodeAssert.equal(safeInboxName("../../etc/pa ss", "S"), "S-pa-ss");
});

NodeTest.test(
  "a prompt is typed into a busy session's pane and the turn ends once it is delivered",
  async () => {
    const dir = NodeFS.mkdtempSync(
      NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "baton-live-acp-"),
    );
    const sessions = NodePath.join(dir, "sessions");
    const cwd = NodePath.join(dir, "work");
    NodeFS.mkdirSync(sessions);
    NodeFS.mkdirSync(cwd);
    const log = NodePath.join(dir, "herdr.log");
    const herdr = NodePath.join(dir, "herdr");
    NodeFS.writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n`, { mode: 0o755 });
    const sid = "11111111-2222-4333-8444-555555555555";
    const descriptor = (status) =>
      NodeFS.writeFileSync(
        NodePath.join(sessions, `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, sessionId: sid, cwd, kind: "interactive", status }),
      );
    descriptor("idle");
    const attachment = NodePath.join(dir, "shot.png");
    NodeFS.writeFileSync(attachment, "png-bytes");

    const child = NodeChildProcess.spawn(process.execPath, [AGENT], {
      env: {
        ...process.env,
        BATON_CLAUDE_SESSIONS_DIR: sessions,
        BATON_HERDR_BIN: herdr,
        BATON_TEST_HERDR_PANE: "fab-x~p1",
        T3CODE_THREAD_ID: "",
        BATON_LIVE_ATTACHMENT_ENTER_MS: "10",
        BATON_LIVE_POLL_MS: "50",
        BATON_LIVE_QUEUE_DIR: NodePath.join(dir, "queue"),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const replies = new Map();
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined) replies.get(message.id)?.(message);
    });
    const call = (id, method, params) =>
      new Promise((resolve) => {
        replies.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    try {
      const init = await call(1, "initialize", { protocolVersion: 2 });
      NodeAssert.equal(init.result.protocolVersion, 1);
      NodeAssert.deepEqual(init.result.agentCapabilities.sessionCapabilities, { resume: {} });
      const opened = (await call(2, "session/new", { cwd, mcpServers: [] })).result;
      NodeAssert.match(opened.sessionId, /^baton-unbound/);
      // T3's composer shows these words as they are: what is in the terminal, never the slug "live" or a sentence.
      NodeAssert.deepEqual(
        opened.models.availableModels.map((m) => [m.modelId, m.name]),
        [["live", "Claude Code"]],
      );
      for (const option of opened.configOptions[0].options)
        NodeAssert.ok(option.name.length <= 8, option.name);
      NodeAssert.deepEqual(
        (await call(3, "session/resume", { sessionId: sid, cwd, mcpServers: [] })).result,
        { models: LIVE_MODELS, configOptions: [effortConfigOption()] },
      );

      // Busy the whole time: the send must not wait for idle, or T3 queues the next message.
      descriptor("busy");
      const turn = await call(4, "session/prompt", {
        sessionId: sid,
        prompt: [
          {
            type: "text",
            text: `say ALPHA\n\n[Attached image "shot.png" is saved at: ${attachment}]`,
          },
        ],
      });
      NodeAssert.equal(turn.result.stopReason, "end_turn");
      // Stop still reaches the pane after the send has ended.
      NodeAssert.equal((await call(6, "session/cancel", { sessionId: sid })).result ?? null, null);

      const calls = NodeFS.readFileSync(log, "utf8");
      NodeAssert.match(
        calls,
        /^--session fab-x agent prompt p1 say ALPHA\nHe attached image shot-[0-9a-f]{4}\.png:\n@.*\/work\/\.baton\/inbox\/\d{4}-\d\d-\d\d\/shot-[0-9a-f]{4}\.png\n--session fab-x agent send-keys p1 enter\n--session fab-x agent send-keys p1 esc\n$/s,
      );
      const day = NodeFS.readdirSync(NodePath.join(cwd, ".baton", "inbox"))[0];
      const inbox = NodeFS.readdirSync(NodePath.join(cwd, ".baton", "inbox", day));
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(cwd, ".baton", "inbox", day, inbox[0]), "utf8"),
        "png-bytes",
      );
      // The inbox never shows as a changed file in the project.
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(cwd, ".baton", ".gitignore"), "utf8"),
        "*\n",
      );

      const unbound = await call(5, "session/prompt", { sessionId: "baton-unbound-1", prompt: [] });
      NodeAssert.equal(unbound.result.stopReason, "end_turn");
      // An image-only message to an unbound thread is kept with its picture, not as empty text.
      const other = NodePath.join(dir, "other");
      NodeFS.mkdirSync(other);
      const lone = (await call(7, "session/new", { cwd: other, mcpServers: [] })).result.sessionId;
      await call(8, "session/prompt", {
        sessionId: lone,
        prompt: [
          { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") },
        ],
      });
      const kept = NodeFS.readFileSync(NodePath.join(dir, "queue", "inbound.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((entry) => entry.sessionId === lone);
      NodeAssert.equal(kept.unbound, true);
      NodeAssert.match(kept.text, /^He attached image image-.*\n@.*\/other\/\.baton\/inbox\//);
      // A lost binding with exactly one running session in the folder is held and offers Reattach, never sent there.
      const near = (await call(9, "session/new", { cwd, mcpServers: [] })).result.sessionId;
      await call(10, "session/prompt", {
        sessionId: near,
        prompt: [{ type: "text", text: "say BETA" }],
      });
      NodeAssert.doesNotMatch(NodeFS.readFileSync(log, "utf8"), /BETA/);
      NodeAssert.match(
        NodeFS.readFileSync(NodePath.join(dir, "queue", "inbound.ndjson"), "utf8"),
        new RegExp(`"sessionId":"${near}".*"text":"say BETA"`),
      );

      // An effort picked on another client: typed into an idle session with nothing waiting, once per value.
      const effort = async (id, value, sessionId = sid) =>
        (await call(id, "session/set_config_option", { sessionId, configId: "effort", value }))
          .result;
      const typedEffort = () => NodeFS.readFileSync(log, "utf8").match(/\/effort \w+/g) ?? [];
      const queuedEffort = () =>
        NodeFS.readFileSync(NodePath.join(dir, "queue", "inbound.ndjson"), "utf8").match(
          /\/effort \w+/g,
        ) ?? [];
      descriptor("idle");
      NodeAssert.deepEqual(await effort(20, "high"), {
        configOptions: [effortConfigOption("high")],
      });
      NodeAssert.deepEqual(typedEffort(), ["/effort high"]);
      // T3 re-applies a saved option on every activation: the same value is not typed again.
      await effort(21, "high");
      NodeAssert.deepEqual(typedEffort(), ["/effort high"]);
      // A question on screen would take it as its answer, and a working session as a message: it queues in order.
      descriptor("waiting");
      NodeAssert.deepEqual(await effort(22, "max"), { configOptions: [effortConfigOption("max")] });
      descriptor("busy");
      await effort(23, "low");
      NodeAssert.deepEqual(typedEffort(), ["/effort high"]);
      NodeAssert.deepEqual(queuedEffort(), ["/effort max", "/effort low"]);
      // Not running in Herdr here, or anything but a known level: nothing is typed or queued.
      NodeAssert.deepEqual(await effort(24, "high", "no-such-session"), {
        configOptions: [effortConfigOption()],
      });
      await effort(25, "; rm");
      NodeAssert.deepEqual(typedEffort(), ["/effort high"]);
      NodeAssert.deepEqual(queuedEffort(), ["/effort max", "/effort low"]);
    } finally {
      child.kill();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  },
);

const queueDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-queue-"));
const msg = (text) => ({ text, shown: text, at: "2026-11-01T20:34:35.000Z" });
const harness = (state) => {
  const said = [];
  const typed = [];
  return {
    said,
    typed,
    deps: {
      findLive: () => state.live,
      typeInto: async (_pane, text) => {
        await state.during?.();
        if (state.failure !== null) return state.failure;
        typed.push(text);
        return null;
      },
      say: (_id, text) => said.push(text),
    },
  };
};

NodeTest.test(
  "a message sent while the session waits on a question is kept, then sent in order once it clears",
  async () => {
    const dir = queueDir();
    const state = { live: { pane: "p", status: "waiting" }, failure: null };
    const { deps, said, typed } = harness(state);
    NodeAssert.equal(enqueue(dir, "s1", msg("first thing")), 1);
    NodeAssert.equal(enqueue(dir, "s1", msg("second thing")), 2);
    NodeAssert.match(
      queuedNote("the session is waiting on a question.", 2),
      /Not delivered yet: .*question\. 2 messages queued; they send when you answer it\./,
    );
    await drainSession(dir, "s1", deps);
    NodeAssert.deepEqual(typed, [], "nothing is typed over a question");
    NodeAssert.equal(readQueue(dir, "s1").length, 2);
    state.live = { pane: "p", status: "idle" };
    await drainSession(dir, "s1", deps);
    NodeAssert.deepEqual(typed, ["first thing", "second thing"]);
    NodeAssert.deepEqual(said, [deliveredNote("first thing"), deliveredNote("second thing")]);
    NodeAssert.equal(readQueue(dir, "s1").length, 0);
  },
);

NodeTest.test(
  "a message added while one is being typed is kept, and a second drainer never types the same one",
  async () => {
    const dir = queueDir();
    const state = { live: { pane: "p", status: "idle" }, failure: null };
    const { deps, typed } = harness(state);
    enqueue(dir, "s10", msg("first"));
    let second = Promise.resolve();
    state.during = async () => {
      state.during = undefined;
      enqueue(dir, "s10", msg("added meanwhile"));
      // Another live-session process drains the same folder at the same moment.
      second = drainSession(dir, "s10", deps);
    };
    await drainSession(dir, "s10", deps);
    await second;
    NodeAssert.deepEqual(typed, ["first", "added meanwhile"]);
    NodeAssert.equal(readQueue(dir, "s10").length, 0);
    NodeAssert.notEqual(takeDrainLock(dir), null, "the lock is released after a pass");
  },
);

NodeTest.test(
  "a send Herdr never answered may have been typed, so it is handed back, never typed again",
  async () => {
    const dir = queueDir();
    const state = { live: { pane: "p", status: "idle" }, failure: UNSURE_NOTE };
    const { deps, said } = harness(state);
    enqueue(dir, "s12", msg("only once"));
    await drainSession(dir, "s12", deps);
    NodeAssert.equal(readQueue(dir, "s12").length, 0);
    NodeAssert.deepEqual(said, [maybeNote("only once")]);
    // A killed herdr (timeout) maps to unsure; a refusal does not.
    const killed = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], 50);
    NodeAssert.equal(killed.timedOut, true);
    NodeAssert.equal(sendFailure(killed), UNSURE_NOTE);
    NodeAssert.notEqual(
      sendFailure({ ok: false, timedOut: false, out: "agent_blocked" }),
      UNSURE_NOTE,
    );
  },
);

NodeTest.test("a session in a plain terminal keeps its queue until it has a pane", async () => {
  const dir = queueDir();
  const { deps, said, typed } = harness({ live: { pane: null, status: "idle" }, failure: null });
  enqueue(dir, "s11", msg("wait for me"));
  for (let i = 0; i < 30; i += 1) await drainSession(dir, "s11", deps);
  NodeAssert.deepEqual(said, []);
  NodeAssert.deepEqual(typed, []);
  NodeAssert.equal(readQueue(dir, "s11").length, 1);
});

NodeTest.test(
  "the queue folder follows the server's rule: the new one unless only the old one exists",
  () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-home-"));
    const next = NodePath.join(home, ".t3", "tessaya", "live-queue");
    const legacy = NodePath.join(home, ".t3", "baton", "live-queue");
    NodeAssert.equal(liveQueueDir(home), next);
    NodeFS.mkdirSync(legacy, { recursive: true });
    NodeAssert.equal(liveQueueDir(home), legacy);
    NodeFS.mkdirSync(next, { recursive: true });
    NodeAssert.equal(liveQueueDir(home), next);
  },
);

NodeTest.test("the queue is on disk, so a restart finds what was waiting", () => {
  const dir = queueDir();
  enqueue(dir, "s2", msg("keep me"));
  NodeAssert.deepEqual(
    readQueue(dir, "s2").map((item) => item.text),
    ["keep me"],
  );
  NodeAssert.deepEqual(NodeFS.readdirSync(dir), ["s2.json"]);
});

NodeTest.test(
  "a message Herdr keeps refusing is handed back quoted, and the ones behind it still go",
  async () => {
    const dir = queueDir();
    const state = {
      live: { pane: "p", status: "idle" },
      failure: "Herdr did not take the message: no pane",
    };
    const { deps, said, typed } = harness(state);
    enqueue(dir, "s3", msg("my important words"));
    enqueue(dir, "s3", msg("and these"));
    for (let i = 0; i < 6; i += 1) await drainSession(dir, "s3", deps);
    NodeAssert.ok(
      said.some((line) => line.includes('Your message was: "my important words"')),
      said.join("|"),
    );
    state.failure = null;
    await drainSession(dir, "s3", deps);
    NodeAssert.deepEqual(typed, ["and these"]);
    NodeAssert.equal(readQueue(dir, "s3").length, 0);
  },
);

NodeTest.test("when the session is gone for good every queued message is quoted back", async () => {
  const dir = queueDir();
  const { deps, said } = harness({ live: null, failure: null });
  enqueue(dir, "s4", msg("one"));
  enqueue(dir, "s4", msg("two"));
  for (let i = 0; i < 10; i += 1) await drainSession(dir, "s4", deps);
  NodeAssert.deepEqual(said, [
    lostNote("the session is no longer running here.", "one"),
    lostNote("the session is no longer running here.", "two"),
  ]);
  NodeAssert.equal(readQueue(dir, "s4").length, 0);
});

NodeTest.test(
  "the review screen of a multi-question form is read, with its answers, Submit, Cancel and a way back",
  () => {
    const prompt = parsePanePrompt(fixture("pane-review.txt"));
    NodeAssert.equal(prompt.question, "Ready to submit your answers?");
    NodeAssert.equal(prompt.header, "Review your answers");
    NodeAssert.deepEqual(
      prompt.tabs?.map((t) => [t.label, t.answered]),
      [
        ["Browser", true],
        ["Connectors", true],
        ["Submit", true],
      ],
    );
    NodeAssert.match(
      prompt.context,
      /Which browser profile should that happen in\? → My main profile/,
    );
    NodeAssert.match(
      prompt.context,
      /should those connectors be removed\? → Remove after \(Recommended\)/,
    );
    NodeAssert.deepEqual(
      prompt.options.map((o) => o.label),
      ["Submit answers", "Cancel", "Go back"],
    );
    NodeAssert.equal(prompt.selected, 0);
    NodeAssert.deepEqual(answerKeys(prompt, "Submit answers"), { keys: ["enter"], text: null });
    NodeAssert.deepEqual(answerKeys(prompt, "cancel"), { keys: ["down", "enter"], text: null });
    NodeAssert.deepEqual(answerKeys(prompt, "Go back"), { keys: ["left"], text: null });
    NodeAssert.equal(answerKeys(prompt, "banana"), null, "no free text on the review screen");
  },
);

NodeTest.test(
  "a question in a real multi-question form has its tabs, and free text goes to the last option",
  () => {
    // Read from a throwaway Claude Code session asked for two questions in one AskUserQuestion call.
    const prompt = parsePanePrompt(fixture("pane-form-tabs.txt"));
    NodeAssert.equal(prompt.question, "Which colour do you prefer?");
    NodeAssert.deepEqual(
      prompt.tabs?.map((t) => [t.label, t.answered]),
      [
        ["Colour", false],
        ["Size", false],
        ["Submit", true],
      ],
    );
    NodeAssert.deepEqual(
      prompt.options.map((o) => o.label),
      ["Red", "Green"],
    );
    NodeAssert.equal(prompt.header, "Colour · Size");
    NodeAssert.equal(prompt.customIndex, 2);
    NodeAssert.deepEqual(answerKeys(prompt, "green"), { keys: ["down", "enter"], text: null });
    NodeAssert.deepEqual(answerKeys(prompt, "Extra large, please"), {
      keys: ["down", "down"],
      text: "Extra large, please",
    });
  },
);

NodeTest.test("a free-text option called Other is the custom slot too", () => {
  const screen = fixture("pane-form-tabs.txt").replace("3. Type something.", "3. Other");
  NodeAssert.equal(parsePanePrompt(screen).customIndex, 2);
});

NodeTest.test("the permission dialog and the single question still read as before", () => {
  NodeAssert.equal(
    parsePanePrompt(fixture("pane-permission.txt")).question,
    "Do you want to proceed?",
  );
  NodeAssert.equal(
    parsePanePrompt(fixture("pane-question.txt")).question,
    "Which colour do you prefer?",
  );
  NodeAssert.equal(parseReviewScreen(["nothing here"]), null);
});

NodeTest.test("a note from weaving is shown in the thread at once, even with no pane", async () => {
  const dir = queueDir();
  const { deps, said, typed } = harness({ live: null, failure: null });
  enqueue(dir, "s5", { text: "Sent to build: hi", shown: "Sent to build: hi", kind: "note" });
  await drainSession(dir, "s5", deps);
  NodeAssert.deepEqual(said, ["Sent to build: hi"]);
  NodeAssert.deepEqual(typed, []);
  NodeAssert.equal(readQueue(dir, "s5").length, 0);
});

NodeTest.test("inbox names a person can read", () => {
  const now = new Date("2026-11-02T11:13:47Z");
  NodeAssert.equal(readableInboxName("IMG_9489.png", now, "a3f9"), "IMG_9489-a3f9.png");
  NodeAssert.equal(
    readableInboxName(
      "baton-live4-5ab4ae0c-3cf4-4d50-aae3-94117d982204-6c567ac6-f2d7-4b0c-9541-41a0a052d316.png",
      now,
      "a3f9",
    ),
    "image-11-13-a3f9.png",
  );
});

/** A machine where the session is stopped; `baton --resume` brings it up in a pane after a moment. */
const stoppedMachine = (over = {}) => {
  const said = [];
  const typed = [];
  const batonCalls = [];
  let clock = 0;
  let upAt = Infinity;
  const deps = {
    cwdOf: () => "/work/shop",
    dirExists: (d) => d === "/work/shop",
    baton: async (args) => {
      batonCalls.push(args);
      upAt = clock + 2_000;
      return { ok: true, out: "baton: claude running in fab-shop pane p1" };
    },
    findLive: () => (clock >= upAt ? { pane: "fab-shop~p1", status: "idle" } : null),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    typeInto: async (pane, text) => (typed.push([pane, text]), null),
    say: (_id, text) => said.push(text),
    ...over,
  };
  return { deps, said, typed, batonCalls };
};

const inboundOf = (dir) =>
  NodeFS.readFileSync(NodePath.join(dir, "inbound.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

NodeTest.test(
  "a send to a stopped session goes to the server's queue and is shown, and the session is resumed in its folder",
  async () => {
    const dir = queueDir();
    const { deps, said, typed, batonCalls } = stoppedMachine();
    const result = await sendToStopped(dir, "s6", msg("carry on with the tests"), deps);
    NodeAssert.equal(result.state, "resumed");
    NodeAssert.deepEqual(batonCalls, [["--resume", "s6", "/work/shop"]]);
    NodeAssert.equal(said[0], resumingNote("carry on with the tests"));
    // The server types it once the session is in a pane; the bridge never does.
    NodeAssert.deepEqual(typed, []);
    NodeAssert.deepEqual(
      inboundOf(dir).map((line) => [line.sessionId, line.text]),
      [["s6", "carry on with the tests"]],
    );
    NodeAssert.equal(serverWaiting(dir, "s6"), 1);
    NodeAssert.ok(!said.some((line) => line.startsWith("Not delivered")), said.join("|"));
  },
);

NodeTest.test(
  "a resume that fails keeps the message in the server's queue, and says why",
  async () => {
    const dir = queueDir();
    const { deps, said, typed } = stoppedMachine({
      baton: async () => ({ ok: false, out: "herdr: no server" }),
    });
    const result = await sendToStopped(dir, "s7", msg("hello"), deps);
    NodeAssert.equal(result.state, "failed");
    NodeAssert.match(said.at(-1), /Could not resume: Herdr would not start it: herdr: no server\./);
    NodeAssert.match(said.at(-1), /Your message is kept/);
    NodeAssert.deepEqual(typed, []);
    NodeAssert.deepEqual(
      inboundOf(dir).map((line) => line.text),
      ["hello"],
    );
  },
);

NodeTest.test(
  "a held message is never handed back as lost, however long the session stays gone",
  async () => {
    const dir = queueDir();
    const { deps, said } = harness({ live: null, failure: null });
    enqueue(dir, "s8", msg("keep me"));
    holdQueue(dir, "s8", "resuming");
    for (let i = 0; i < 30; i += 1) await drainSession(dir, "s8", deps);
    NodeAssert.deepEqual(said, []);
    NodeAssert.equal(readQueue(dir, "s8").length, 1);
    releaseQueue(dir, "s8");
    NodeAssert.equal(readQueue(dir, "s8")[0].held, undefined);
  },
);

NodeTest.test(
  "a queue held by a failed resume is delivered once the session is back in a pane",
  async () => {
    const dir = queueDir();
    const back = harness({ live: { pane: "w1:p1", status: "idle" }, failure: null });
    enqueue(dir, "s12", msg("first"));
    holdQueue(dir, "s12", "Herdr would not start it: no answer.");
    enqueue(dir, "s12", msg("second"));
    await drainSession(dir, "s12", back.deps);
    NodeAssert.deepEqual(back.typed, ["first", "second"]);
    NodeAssert.equal(readQueue(dir, "s12").length, 0);
    // A resume still under way keeps its hold even if the pane shows up first.
    const during = harness({ live: { pane: "w1:p1", status: "idle" }, failure: null });
    enqueue(dir, "s13", msg("wait"));
    holdQueue(dir, "s13", "resuming");
    await drainSession(dir, "s13", during.deps);
    NodeAssert.deepEqual(during.typed, []);
  },
);

NodeTest.test(
  "resuming says plainly when the folder is unknown or gone, and times out readably",
  async () => {
    const none = stoppedMachine({ cwdOf: () => null });
    NodeAssert.match((await resumeSession("s9", none.deps)).error, /do not know which folder/);
    const gone = stoppedMachine({ dirExists: () => false });
    NodeAssert.equal(
      (await resumeSession("s9", gone.deps)).error,
      "The folder /work/shop is not on this machine.",
    );
    const slow = stoppedMachine({ findLive: () => null });
    NodeAssert.match(
      (await resumeSession("s9", slow.deps)).error,
      /did not become ready within 45 seconds/,
    );
    NodeAssert.equal(slow.batonCalls.length, 1);
  },
);

NodeTest.test(
  "a session waiting on Claude's folder-trust question is named, not just 'not ready'",
  async () => {
    const { deps } = stoppedMachine({
      findLive: () => null,
      screenOf: async () =>
        "Quick safety check: Is this a project you created or one you trust?\n Yes, I trust this folder",
    });
    const out = await resumeSession("s10", deps);
    NodeAssert.match(out.error, /asking whether to trust this folder.*herdr --session fab-shop/);
  },
);

NodeTest.test("'resume' on its own is a request to bring it back, not a message to send", () => {
  for (const ok of ["resume", "Resume it", "resume this session.", " RESUME "])
    NodeAssert.equal(isResumeRequest(ok), true, ok);
  for (const no of ["resume the work on tests", "please resume", "bring into herdr"])
    NodeAssert.equal(isResumeRequest(no), false, no);
  NodeAssert.match(resumeFailedNote("The folder is gone.", "hi"), /Your message is kept: "hi"\./);
});

NodeTest.test(
  "a tabbed multi-question form (CI account / Merge 4416 / Submit) is read as a card with its tabs",
  () => {
    const screen = [
      "────────────────────────────────────────",
      "←  ☐ CI account  ☐ Merge 4416  ✔ Submit  →",
      "",
      "Which account should CI run under?",
      "",
      "❯ 1. sablebox",
      "     Run the CI with the sablebox account",
      "  2. Don't run it",
      "     Skip CI for now",
      "  3. Type something.",
      "────────────────────────────────────────",
      "  4. Chat about this",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ].join("\n");
    const prompt = parsePanePrompt(screen);
    NodeAssert.equal(prompt?.question, "Which account should CI run under?");
    NodeAssert.deepEqual(
      prompt?.tabs?.map((t) => t.label),
      ["CI account", "Merge 4416", "Submit"],
    );
    NodeAssert.deepEqual(
      prompt?.options.map((o) => o.label),
      ["sablebox", "Don't run it"],
    );
    NodeAssert.equal(prompt?.customIndex, 2);
  },
);

NodeTest.test(
  "a question wrapped over several lines keeps all of it, and each option keeps its wrapped description",
  () => {
    const screen = [
      "────────────────────────────────────────",
      "←  ☐ CI account  ☐ Merge 4416  ✔ Submit  →",
      "",
      "│ #4416 (clip posting path) needs another cloud CI run after my one-line test fix. Which Claude",
      "│ cloud account should run it? Only sablebox is logged in for cloud right now.",
      "",
      "❯ 1. sablebox",
      "     The only cloud login that works today. Its weekly limit",
      "     resets Monday 12:00 PKT.",
      "  2. Don't run it",
      "     Skip the rerun and decide #4416 on the current evidence.",
      "  3. Type something.",
      "────────────────────────────────────────",
      "  4. Chat about this",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ].join("\n");
    const prompt = parsePanePrompt(screen);
    NodeAssert.equal(
      prompt?.question,
      "#4416 (clip posting path) needs another cloud CI run after my one-line test fix. Which Claude cloud account should run it? Only sablebox is logged in for cloud right now.",
    );
    NodeAssert.equal(
      prompt?.options[0].description,
      "The only cloud login that works today. Its weekly limit resets Monday 12:00 PKT.",
    );
  },
);

NodeTest.test(
  "a kept unbound message records its id, the thread's native session and the words",
  () => {
    const a = keptEntry({ sessionId: "baton-unbound-1-2" }, "/work", "hello");
    const b = keptEntry(
      { sessionId: "baton-unbound-1-2", _meta: { threadId: "t1" } },
      null,
      "hello",
    );
    NodeAssert.equal(a.sessionId, "baton-unbound-1-2");
    NodeAssert.equal(a.unbound, true);
    NodeAssert.equal(a.cwd, "/work");
    NodeAssert.equal(a.text, "hello");
    NodeAssert.equal(b.threadId, "t1");
    // Each line the server imports carries its own id, so it is never imported twice.
    const dir = queueDir();
    appendInbound(dir, a);
    appendInbound(dir, b);
    const [first, second] = inboundOf(dir);
    NodeAssert.notEqual(first.id, second.id);
  },
);

NodeTest.test(
  "the bridge lowers its own OOM score on Linux, and only warns when it may not",
  () => {
    const written = [];
    const warned = [];
    const write = (value) => written.push(value);
    const warn = (line) => warned.push(line);
    NodeAssert.equal(lowerOomScore({ platform: "linux", write, warn }), true);
    NodeAssert.deepEqual(written, [String(BRIDGE_OOM_SCORE_ADJ)]);
    NodeAssert.equal(BRIDGE_OOM_SCORE_ADJ, 100);
    const refused = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    NodeAssert.equal(lowerOomScore({ platform: "linux", write: refused, warn }), false);
    NodeAssert.match(warned.join("\n"), /could not lower oom_score_adj to 100: EACCES/);
    NodeAssert.equal(lowerOomScore({ platform: "darwin", write: refused, warn }), false);
    NodeAssert.equal(warned.length, 1);
  },
);

NodeTest.test(
  "a live thread's id names its session, and Herdr's agent list names its pane now",
  () => {
    const sid = "5ab4ae0c-3cf4-4d50-aae3-94117d982204";
    NodeAssert.equal(sessionOfLiveThread(`baton-live4:${sid}`), sid);
    for (const other of [undefined, "", "thread-1", `baton-live4:${sid}/../x`, "baton-live4:abc"])
      NodeAssert.equal(sessionOfLiveThread(other), null);
    const listed = JSON.stringify({
      result: {
        agents: [
          { agent_session: { value: "other" }, pane_id: "w1:p2" },
          { agent_session: { value: sid }, pane_id: "w2:p1" },
        ],
      },
    });
    NodeAssert.equal(paneFromAgentList(listed, sid), "w2:p1");
    NodeAssert.equal(paneFromAgentList(listed, "missing"), null);
    NodeAssert.equal(paneFromAgentList("not json", sid), null);
  },
);

NodeTest.test(
  "a bridge killed mid-thread comes back bound to the same session, typing into the pane Herdr names now",
  async () => {
    const dir = NodeFS.mkdtempSync(
      NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "baton-live-acp-"),
    );
    const sessions = NodePath.join(dir, "sessions");
    NodeFS.mkdirSync(sessions);
    const sid = "11111111-2222-4333-8444-555555555555";
    NodeFS.writeFileSync(
      NodePath.join(sessions, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: sid,
        cwd: dir,
        kind: "interactive",
        status: "idle",
      }),
    );
    // After a Herdr restart the session sits in a pane its process environment never heard of.
    const log = NodePath.join(dir, "herdr.log");
    const herdr = NodePath.join(dir, "herdr");
    const listed = JSON.stringify({
      result: { agents: [{ agent_session: { value: sid }, pane_id: "w9:p7" }] },
    });
    NodeFS.writeFileSync(
      herdr,
      `#!/bin/sh\ncase "$*" in *"agent list"*) printf '%s\\n' '${listed}' ;; *) printf '%s\\n' "$*" >> ${log} ;; esac\n`,
      { mode: 0o755 },
    );
    const start = () => {
      const child = NodeChildProcess.spawn(process.execPath, [AGENT], {
        env: {
          ...process.env,
          BATON_CLAUDE_SESSIONS_DIR: sessions,
          BATON_HERDR_BIN: herdr,
          BATON_LIVE_POLL_MS: "50",
          BATON_LIVE_QUEUE_DIR: NodePath.join(dir, "queue"),
          T3CODE_THREAD_ID: `baton-live4:${sid}`,
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      const replies = new Map();
      NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id !== undefined) replies.get(message.id)?.(message);
      });
      const call = (id, method, params) =>
        new Promise((resolve) => {
          replies.set(id, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
      return { child, call };
    };
    const first = start();
    let second;
    try {
      await first.call(1, "initialize", { protocolVersion: 1 });
      NodeAssert.equal(
        (await first.call(2, "session/new", { cwd: dir, mcpServers: [] })).result.sessionId,
        sid,
      );
      await first.call(3, "session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: "one" }],
      });
      first.child.kill("SIGKILL");
      // T3 starts a new bridge and opens it with session/new, never session/resume.
      second = start();
      await second.call(1, "initialize", { protocolVersion: 1 });
      NodeAssert.equal(
        (await second.call(2, "session/new", { cwd: dir, mcpServers: [] })).result.sessionId,
        sid,
      );
      await second.call(3, "session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: "two" }],
      });
      const calls = NodeFS.readFileSync(log, "utf8");
      NodeAssert.match(calls, /agent prompt w9:p7 one\n/);
      NodeAssert.match(calls, /agent prompt w9:p7 two\n/);
      NodeAssert.equal(
        NodeFS.existsSync(NodePath.join(dir, "queue", "unbound-messages.ndjson")),
        false,
      );
    } finally {
      first.child.kill();
      second?.child.kill();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  },
);

NodeTest.test("the live effort list is the one the server types", () => {
  NodeAssert.deepEqual(LIVE_EFFORTS, [...LIVE_EFFORT_CHOICES]);
});
