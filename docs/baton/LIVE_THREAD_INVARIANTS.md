# Live thread invariants

A live thread mirrors one running terminal session (`baton-live4:<session id>`). These hold at all times:

1. One session answers it. A turn, an explicit provider switch or a model pick that names another provider instance is
   refused and logged as `live-thread-new-session-blocked`; a model or effort change goes into the session itself
   (`/model`, `/effort`), resuming the same session id first if it is stopped. The live selection is pinned, so a stale
   composer selection cannot cause a live-to-live handoff.
2. The binding is checked every 30 s per followed session. A thread on another provider instance, or on the live
   instance without its session, is bound again to the running session with the same id, and a `rebound` line is
   written to `baton-mirror.ndjson`. A session is never chosen by guessing: a message to a thread with no binding is
   kept in the server's message queue (the `fabric_weaves` table, `unbound` rows) and shown back, even when exactly one
   session runs in the folder (Reattach, 5).
3. A handoff twin is retired with `baton.sessions.retirehandoff` (explicit confirm token and `caughtUp`).
4. `baton-mirror.ndjson` names every mirror decision: the live session set, follow or skip per session, failures, and
   which question the pane shows.

5. The thread header and the Sessions row show the real binding (Herdr pane, T3-hosted handoff session, stopped). Reattach
   (`baton.sessions.reattach`, service `reattach`) binds again by session id; with no id match and exactly one running
   session in the folder it only offers "Reattach to <pane>?" and acts on that pane's confirmation.
6. A kept unbound message is shown in its thread with a Retry button and is sent again through the thread once it is
   bound to its running session. Its row is claimed before the resend and released if it fails, so a message is
   neither dropped nor sent twice.
7. One queue for text waiting to be typed into a live session: `fabric_weaves`. The bridge appends what it cannot type
   now to `inbound.ndjson` in the live-queue folder; the server imports each line once (by id, from a saved offset) and
   types it on its own 3 s clock into the pane `herdr agent list` shows for the session id, never while a question is
   up, and drops (and says) a send Herdr did not confirm rather than typing it twice. Each row has one owner: the
   server's drainer, the thread (unbound rows), or the sessions list (`catalog` rows, sent on a send or Resume). A
   `<session id>.server` file marks a session the server owns; the bridge's drainer never types for it. One server owns
   a live-queue folder at a time (`.server.lock`); a server on another base dir (a dev worktree) uses its own folder.
8. One writer per conversation across Tessaya and a terminal. Move into Tessaya ends the terminal process before the
   thread's provider thread is pointed at the same session id on claudeAgent; a live thread whose active native id is
   its own session id is then ordinary (`movedIntoTessaya`), while a twin (another session id) is still refused. Open
   in terminal detaches the thread's provider sessions and waits until no process holds the session (any descriptor,
   SDK ones included) before `tessaya --resume`; `tessaya resume <thread>` refuses a session Tessaya's SDK process holds
   unless `--force`. The mirror links a Tessaya thread's session wherever it runs (`SessionHomes`, by session id from
   `tessaya-sessions.json` in the state dir) and hands it back to its own instance when the terminal closes.
