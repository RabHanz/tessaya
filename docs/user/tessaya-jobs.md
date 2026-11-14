# Jobs and approvals

Give Tessaya a task and let a coding agent do it in the background.

## Start

Say or type what you want done as a job ("fix the failing build in the shop project"). A worker makes a plan first. The plan appears under **Approvals** with the exact thing your yes would allow and the permissions it would use. Agree and it starts; decline and it stops.

## Good to know

- **Approvals** is the one list of everything waiting for your yes: job plans, questions a session asked you, held memory suggestions, the vault asking to use a secret.
- A job has limits (time, turns, optionally money). It stops at them and tells you; raise a limit to let it go on.
- Only Tessaya, the lead, starts and splits jobs. Once you agree a plan, say "split it" and she hands each part to one of your personas by name (Onyx, Alfred, Sebastian, Freya): each part runs in its own thread with that persona's brief, model and `tools` from its pack file, and its outcome goes to what happened under its name. Ask Freya to start a job and she will tell you to ask Tessaya.
- **Templates** say how a kind of job is done well and who usually does it: plan a trip goes to Alfred with Freya, ship a fix to Onyx with Sebastian writing the release note, write as me to Sebastian, and so on. They are files in the `templates` folder of your operating-system pack (Settings, the Operating-system pack section, lists each one to edit). Your file wins over the default with the same name, and a new file adds a template. A template with `kind: persona` is a face to hire: copy it into a role file and give it a name.
- Each persona's background turns are counted per day. The guide is 40 a persona and 120 for the team: passing it is noted once that day in what happened and in the next morning brief, and nothing is stopped. Talking with Tessaya is never counted.
- **Standing jobs** (Trust page) are the work that runs by itself: the morning brief, a look at a failed build, a reminder about a session waiting on you, a summary when a job finishes, every rule you set up ("when the build finishes, have Codex review it") and every job on a schedule. Each shows which persona runs it and how many times it has run. One runs unattended only where that persona may do it without asking (reading and reporting); anything else is held and logged. They run with T3's window closed, and each run is in what happened.
- **Stop** ends a running turn; the job and its notes stay. **Retry** is offered only for a job that failed and has retries left, and says why not otherwise.
- A job that a restart interrupted shows a Continue button.
- **Sessions** are T3's own thread list: every Claude Code session running in a terminal shows there as a thread marked **Live**, with its state (working, waiting on you) and its computer. The Sessions tab here shows the counts; **Show live sessions** opens T3 with **Live only** on (the same switch is in T3's sidebar). Other computers appear once they are added under **Settings → Environments**. Voice and the assistant still act on sessions with T3's window closed, on this computer only; a computer linked read-only never takes typing.
- **Messages to sessions** (weave) reach every computer T3 is connected to. A name is looked for on all of them, and one that fits sessions on two computers is refused until you name the computer, as `office:build`. With T3's window closed they reach only this computer. To stop them reaching a computer, remove it in **Settings → Environments**.
- **What needs me** (the Now page) ranks what to look at first: failures, questions, stalled work.

## Run on

Say where a job runs: "start it on the studio computer" (any computer connected to your Tessaya, by the name shown in the sidebar), or leave it out to run it on this computer. The project has to exist on that computer. Later calls about the job (agree, stop, refine) go to the computer it runs on, and the jobs list shows all of them with where each runs.
