/**
 * What the job tools say to a model, in one place: the R1's tools on the server and the desktop assistant's tools use
 * these words, and both are judged by `judgeToolCall` (operator.ts). Evals: evals/tessaya-room (the job cases).
 */
export const JOB_TOOL_TEXT = {
  job_start:
    "Hand long work to a worker thread that PLANS FIRST and does nothing until he agrees. Put his words in goal exactly as he said them. Name the project. Say plainly which folders and tools it may use. worker only when he names who does it (codex, claude); otherwise the routing table picks.",
  job_retry:
    "Try a failed job's worker again, with the reason it failed so it does not repeat the same step. Only an agreed job that failed or hit a limit, and only within its retry budget (two unless the job says otherwise). Raise a hit limit first with job_refine (widens true).",
  job_refine:
    "Pass his correction or answer to a job's worker, word for word. The plan is made again; the work does not start. Set widens when it adds a folder, tool or a longer leash.",
  job_agree:
    "Start a job's work, only after he has said go ahead or yes to its plan in this conversation. Never on your own.",
  job_split:
    "Hand an agreed job's parts to separate workers (up to eight). Each part has a title, a goal in his words, and optionally a role (a specialist named in your frame) and routine: true for mechanical, repeatable work, which runs on the cheaper model. after lists the earlier parts (numbered from 1) that must be done first; a part whose earlier part fails is never started. Only for a job whose plan he has agreed; each worker has no more permission than the job. When all parts are in, one summary goes to the job's thread.",
  job_stop: "Stop a job's worker now. Its thread and plan stay. Use it when he says stop that job.",
  job_schedule:
    "Run an agreed job again on a schedule, in its own thread (every_minutes between 1 and 10080), or take the schedule off (every_minutes 0). He is asked first.",
  cloud_dispatch:
    "Ask for a coding task to run in the cloud (Claude, Codex or another assistant). It only creates a request that waits for his answer on a card in Approvals; nothing runs until he picks an assistant and an account there. The branch must already be pushed. Set expected_points to your estimate of how much of the account's week the task will use, in percentage points (a small fix is 1, a large feature 5 or more); a task over his cap is refused, so split it. Set from_web_or_file to true when the brief was built from web or file content, so the card says it is data.",
  project_add:
    "Add a project he asked for: folder for one already on this computer, repository (owner/name or a clone URL) to clone it beside his other projects, or only a title for a new empty one with its own git repository. His phone asks him first. Then job_start can name it.",
  schedules_list:
    "His scheduled tasks on this computer: each one's id, title, whether it is on, when it runs next (his house's clock) and how the last run went.",
  schedule_run_now:
    "Run one scheduled task now, by its id from schedules_list. It starts its run and does not wait for it to finish.",
  schedule_delete:
    "Delete one scheduled task by its id from schedules_list; it stops for good. His phone asks him first. A job's own schedule comes off with job_schedule instead.",
} as const;
