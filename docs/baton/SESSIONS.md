# Sessions on every machine

`baton.sessions.*` (contracts in `sessionCatalog.ts`, logic in `apps/server/src/baton/SessionCatalog.ts`) lists every
Claude session on an environment, running or stopped, and brings one back. The client asks each connected
environment (the same connection the hub uses; nothing tmux, no new transport) and adds its name.

- **list**: running sessions (live descriptors), transcripts on the machine (newest 600, any account's config
  folder, title from the conversation's summary or first message), and, when words are given, the history index
  (`BATON_HISTORY_SEARCH`). A history-only row cannot be resumed (its transcript is gone) and says so.
- **resume**: `baton --resume <id> <folder>` in the folder the transcript names, then wait up to 45 s for the
  session to be in a Herdr pane and not mid-turn. Idempotent; a second tap while it works returns `resuming`.
- **send**: a running Herdr session gets the text typed in; a stopped one keeps the message, resumes, waits until
  ready, then delivers in order. A failure keeps the message and says why. A plain-terminal session is never
  claimed to be reachable.
- **create**: `baton <folder> claude`, then wait for the new session to report in.
- **folders**: recent folders (live and from transcripts) that still exist, for the New session picker.

State is in memory on the server (resuming, waiting messages); a restart forgets a resume in flight, and the next
tap starts it again.

## Tessaya and terminal sessions

- **Where new sessions run** (Settings → Accounts & providers, default In Tessaya): a new session from the sessions
  list starts as a Tessaya thread on Claude; In a terminal keeps the Herdr pane. No Herdr always means a thread.
- **Move into Tessaya** (⋯ on a Terminal thread): the terminal exits and the same conversation continues in Tessaya on
  the session's own login. Refused while it works.
- **Open in terminal** (⋯ on a Claude thread), or `tessaya resume <thread>` from any shell, even with Tessaya down: the
  session opens in a Herdr pane on the thread's login and the thread follows it there; closing the pane hands it back.
- **Make this the main session** (⋯): that thread is pinned once and never archived when its session ends. Restarted
  under a new session id in the same Herdr pane, the session stays on that thread. Unpinning it stops it being main.
  New threads from the sessions list start on the Account for new threads default when it is a Claude account.
