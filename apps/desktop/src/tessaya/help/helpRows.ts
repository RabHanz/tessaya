/**
 * The Help page: what to say, the keys, and what to do when a check fails. The spoken list is built
 * from the assistant's real tool table, so a tool without an example here fails a test instead of
 * going unmentioned.
 */
import type { HomeControl } from "../home/tessayaHome.ts";
import { DEVICE } from "@t3tools/tessaya-shared/productNames";

/** Tool name -> what he might say and what it gets him. */
export const SAY: Readonly<Record<string, readonly [string, string]>> = {
  screen_capture: ["Look at my screen", "Takes a screenshot (asks first unless you allowed it)."],
  point_at: ["Show me where the save button is", "Draws a pointer on your screen."],
  teach_start: ["Teach me how to export a PDF", "A step-by-step lesson with a pointer."],
  rule_create: [
    "When the shop session finishes, have Codex review it and tell me",
    "Sets a standing rule; it reads the rule back for your yes first.",
  ],
  plan_show: [
    "Do this for me: turn on word wrap in Notepad",
    "Shows the steps first; once you say go ahead it does them while you watch.",
  ],
  click_element: ["Click the Send button", "Clicks a named control."],
  type_text: ["Type hello into this box", "Types for you."],
  sessions_list: ["What sessions do I have?", "Lists your coding sessions on every machine."],
  sessions_find: [
    "Find my 3D printer session",
    "Searches every machine's sessions, stopped ones too.",
  ],
  session_resume: [
    "Resume that session",
    "Brings a stopped session back in its folder, on its machine.",
  ],
  session_new: [
    "Start a new session in the shop folder",
    "Starts Claude in a folder (asks first).",
  ],
  session_show: ["How is the build session going?", "Shows what a session did and is doing."],
  session_send: ["Tell the build session to rerun the tests", "Sends a message to a session."],
  fleet_status: ["What is everyone working on?", "A summary across machines."],
  dictation_stop: ["Stop dictating", "Ends dictation."],
  dictation_start: ["Start dictating", "Your words are typed into the app you are in."],
  job_create: [
    "Every morning at 8, check CI and tell me what broke",
    "Sets up a standing job of your own; you see it and say yes first.",
  ],
  job_update: ["Switch off my morning CI job", "Changes or pauses one of your own jobs."],
  job_delete: ["Remove my morning CI job", "Removes one of your own jobs."],
  assistant_model: [
    "Use Opus for this conversation",
    "Picks the model and effort that answer you, until you say back to normal.",
  ],
  memory_search: [
    "What do you remember about the site?",
    "Searches your notes and past conversations.",
  ],
  conversation_search: [
    "What did Freya tell me about the venue?",
    "Searches what you and one persona said to each other.",
  ],
  team_board: ["What is Alfred working on?", "Each persona's jobs and its last conversation."],
  memory_remember: ["Remember that I prefer tabs", "Keeps a note you can edit in Memory."],
  memory_forget: ["Forget that note about tabs", "Removes a memory."],
  history_search: ["What did we decide about pricing?", "Searches past work across your projects."],
  vault_list: ["What is in my vault?", "Names only, never values."],
  vault_use: ["Log in to GitHub with the vault", "Uses a secret without showing it; asks first."],
  jobs_list: ["What jobs are running?", "Lists your jobs."],
  job_start: ["Start a job to fix the flaky test", "Makes a plan; nothing runs until you agree."],
  job_agree: ["Yes, go ahead with the plan", "Lets an agreed job start."],
  job_stop: ["Stop that job", "Stops a running job."],
  job_retry: ["Try that job again", "Retries a failed worker inside its budget."],
  job_refine: ["Change the plan: leave the logo alone", "Adds your words to the job."],
  job_split: ["Split that job between workers", "One worker per part."],
  job_schedule: ["Run that job every day", "Schedules an agreed job."],
  job_grant: ["Let that job retry by itself", "A standing permission for one job."],
  job_revoke: ["Take that permission back", "Removes a standing permission."],
  job_handoff: ["Hand that job to Codex", "Moves it to another worker."],
  thread_move_into_tessaya: [
    "Move that terminal session into Tessaya",
    "Ends it in the terminal; the same conversation continues here. Asks first.",
  ],
  thread_open_in_terminal: [
    "Open that thread in a terminal",
    "Its session moves to a Herdr pane until the pane closes. Asks first.",
  ],
  skill_draft: ["Turn that job into a skill", "Writes a draft you review."],
  watch_report: ["What is stuck?", "Sessions that failed, stalled or wait for you."],
  approvals_list: ["What is waiting for my yes?", "Everything that needs an answer."],
  needs_me: ["What needs me?", "The ranked list across sessions, jobs, CI and deadlines."],
  morning_brief: ["Give me the brief", "The last day in a few sentences."],
  commit_add: ["Remind me to check the deploy at 3", "Keeps a commitment."],
  commit_done: ["The deploy check is done", "Closes a commitment."],
  commit_list: ["What are you keeping track of?", "Your open commitments."],
  notices_stop: ["Stop telling me about the nightly build", "Silences one kind of offer."],
  notices_resume: ["Tell me about the nightly build again", "Brings it back."],
  text_transform: ["Polish this", "Rewrites the selected text."],
  text_undo: ["Undo that", "Restores the text before the rewrite."],
  text_command: ["Make this more concise", "Edits the text in the focused app."],
  note_add: ["Note that the invoice is due Friday", "Adds to your Scratchpad."],
  note_search: ["Find my note about the invoice", "Searches the Scratchpad."],
  weave_send: [
    "Tell the research session to summarise",
    "Messages another session by name; asks the first time.",
  ],
  weave_list: [
    "What came back from the research session?",
    "Messages between sessions and their replies.",
  ],
  cloud_dispatch: [
    "Run this in the cloud on the margin branch",
    "Makes a request; you pick the assistant and account on a card.",
  ],
  cloud_status: ["How is cloud request 3 getting on?", "Shows its state, link and result."],
  cloud_list: ["What cloud tasks have I asked for?", "Your cloud requests."],
  cloud_cancel: ["Withdraw cloud request 3", "Only while it is still waiting."],
  cloud_usage: ["How much of each cloud account is left?", "Weekly use and when it resets."],
  cloud_approve: ["Approve cloud request 3 on work", "Reads the card back; you press Approve."],
  trust_show: ["Show me what you can access", "Your permissions in plain words."],
  activity_today: ["What did you do today?", "What it did on your behalf."],
  what_happened: ["What happened overnight?", "Crashes, jobs and messages, newest first."],
  permission_off: ["Turn off Chrome", "Takes a permission back."],
  home_find: [
    "Which lights are in the study?",
    "Finds devices in your house by name, room or kind.",
  ],
  home_state: ["Is the study fan on?", "One device now, or what it did since a time."],
  home_do: [
    "Turn off the study fan",
    "Does it now, with an undo; locks, doors and heaters wait for your yes.",
  ],
  home_undo: ["Undo that", "Puts back her last change, within a day."],
  home_automations: ["What automations have you made?", "Hers, or every one in the house."],
  home_automation_save: [
    "Turn off the study fan in 30 minutes",
    "Anything later or repeating becomes a Home Assistant automation.",
  ],
  home_automation_set: ["Pause the night lights automation", "Pauses, resumes or deletes one."],
  device_list: [`Is the ${DEVICE} online?`, "Your devices: online, battery, signal, firmware."],
  device_act: [`Make the ${DEVICE} look happy`, "Its eyes, light, a buzz or a line said aloud."],
  device_owner: [
    `Take a picture with the ${DEVICE}`,
    "Camera or restart; always waits for your yes.",
  ],
  device_tag: [
    `Make this tag mute the ${DEVICE}`,
    `Sets what an NFC tag does when tapped on the ${DEVICE}.`,
  ],
};

/** Tools that exist for the assistant's own steps and are not something to say. */
export const INTERNAL = new Set([
  "ui_tree",
  "window_focus",
  "click",
  "wait_for",
  "scroll",
  "drag",
  "press_keys",
  "browser_route",
  "browser_accessibility_on",
  "vault_save_pending",
  "memory_pin",
  "memory_used",
  "memory_history",
  "remember_target",
  "wait",
]);

/** Names with neither an example nor a place on the internal list. */
export const undocumented = (tools: ReadonlyArray<string>): ReadonlyArray<string> =>
  tools.filter((t) => SAY[t] === undefined && !INTERNAL.has(t));

/** What to try for each check the Checks page can raise. */
export const TROUBLE: Readonly<Record<string, string>> = {
  mic: "Plug the microphone in, then pick it under Voice, Microphone. Windows: Settings, Privacy, Microphone must allow desktop apps.",
  level:
    "Press Test microphone on the Checks page and speak. If the bar stays flat, pick another microphone or raise its level in Windows sound settings.",
  wake: "Turn on at least one wake word under Voice. A word with no model shipped stays off; say 'ask Tessaya' with Ctrl+K, Ask instead.",
  speech:
    "The speech model downloads once (about 740 MB). Keep the computer online, then run the checks again.",
  signin:
    "Sign in to the assistant you chose: run 'claude auth login' or 'codex login' in a terminal, then Check again on the Assistant page.",
  claude: "Run 'claude auth login' in a terminal, then run the checks again.",
  codex: "Run 'codex login' in a terminal, then run the checks again.",
  screen:
    "Tessaya asks before it looks at your screen. Allow it under Screen, or answer the card when it appears.",
  disk: "Free some space, or turn off 'Keep my voice recordings' under History.",
};

const SAYING = "What you can say";
const KEYS = "Keys";
const TROUBLES = "When something is wrong";

export interface HelpInput {
  readonly tools: ReadonlyArray<string>;
  readonly bindings: ReadonlyArray<{ readonly label: string; readonly keys: string }>;
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly detail: string;
  }>;
}

export const helpControls = (i: HelpInput): ReadonlyArray<HomeControl> => [
  ...i.tools.flatMap((t): ReadonlyArray<HomeControl> => {
    const say = SAY[t];
    return say === undefined
      ? []
      : [
          {
            id: `help.say:${t}`,
            section: SAYING,
            label: `"${say[0]}"`,
            kind: "check",
            status: "ok",
            detail: say[1],
          },
        ];
  }),
  {
    id: "help.say:ctrlk",
    section: SAYING,
    label: "Ctrl+K in this window",
    kind: "check",
    status: "ok",
    detail: "Search every page, setting and command, then press Enter.",
  },
  ...i.bindings.map((b, n): HomeControl => ({
    id: `help.key:${n}`,
    section: KEYS,
    label: b.label,
    kind: "check",
    status: "ok",
    detail: b.keys === "" ? "Not set" : b.keys,
  })),
  ...(i.checks.filter((c) => c.status !== "ok").length === 0
    ? [
        {
          id: "help.trouble:none",
          section: TROUBLES,
          label: "Nothing is wrong right now",
          kind: "check" as const,
          status: "ok" as const,
          detail: "Run the checks on the Checks page to be sure.",
        },
      ]
    : i.checks
        .filter((c) => c.status !== "ok")
        .map((c): HomeControl => ({
          id: `help.trouble:${c.id}`,
          section: TROUBLES,
          label: c.title,
          kind: "check",
          status: c.status === "bad" ? "bad" : "warn",
          detail: `${c.detail} ${TROUBLE[c.id] ?? "Run the checks again; if it stays, export diagnostics on the Checks page."}`,
        }))),
];
