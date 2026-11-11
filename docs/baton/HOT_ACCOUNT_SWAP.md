# Hot account swap

Changing a thread's Claude account never waits for background agents or commands. A running process keeps running
and its next API request, from the main agent or any sub-agent, goes out on the new account.

## Why a file, not the environment

Each Claude account is a provider instance whose login is a setup token (`CLAUDE_CODE_OAUTH_TOKEN` in the instance's
environment). Claude Code reads that variable once, at spawn. It re-reads `$CLAUDE_CONFIG_DIR/.credentials.json`
whenever the file's mtime changes, before its next request (measured on Claude Code 2.1.322: a running process
swapped to a bad token fails its next turn with 401 and recovers on the next good one; the same swap under the
environment variable changes nothing). cswap relies on the same behaviour.

So a token instance's process never gets the token in its environment. It runs with its own config dir,
`<state>/claude-session-logins/<provider session>/`, made by `apps/server/src/provider/Drivers/ClaudeSessionLogin.ts`:

- every entry of the instance's home is a link to it (projects, tasks, settings, `.claude.json`), so transcripts and
  everything T3 reads stay where they were;
- `.credentials.json` is a real file: the home's own content (MCP OAuth) plus `claudeAiOauth` holding the token;
- the dir stays after the session closes and is pruned after a week unused: a dying process still writes, and with
  its links gone its last transcript lines would land in a dir nobody reads.

A login with a refresh token (the default `~/.claude` login) is not copied, because Claude rotates it in place and a
copy would strand the original. Sessions on it keep the old behaviour.

## The switch

`ProviderAdapterV2.accountLogin` is an instance's movable login; `SessionRuntime.switchAccount` writes it under a live
process (atomic rename, so the mtime changes). The orchestrator decides, the effect worker writes
(`provider-session.switch-account`), so a refused command never moves a process.

An account change keeps the session only when it runs background work, or a turn when the change is
`thread.model-selection.set` (the header chip, MCP, rotation at a limit mid-turn), and both instances share the
native conversation (`restart_and_resume`). The thread records the new account at once; the turn runs on the kept session,
so its run carries the old instance id, and MCP calls from that process are accepted for the run they serve. Rate-limit reports from that process go to the new account. Once the work
ends, the next turn does the ordinary switch: the old process is released and the new instance resumes the
conversation. Without background work nothing changes from before.

Entry points all reach this path: the composer picker and a send (`message.dispatch`, immediate or queued), the
header chip, the phone, `tessaya_desktop_settings`, MCP tools and automatic rotation (`ThreadAccountMoves`, which issues
`thread.model-selection.set`). `ThreadAccountMoves` moves a thread with a running turn at once when both logins
are tokens in one shared conversation, and writes an `account_switch` row to the Record; otherwise it waits for the
turn to end, as before.

## Provider and setting changes

- **Another provider** (a hand-off): the busy session is not refused or detached. The new provider runs the turn in
  its own session; the old one ends through the ordinary idle release once its background work finishes. Its running
  sub-agents and commands stay in the thread's background list (turn items), with their Stop.
- **A model or setting the live process cannot take** (thinking, a cleared effort): while background work runs, the
  turn runs on the live process with its current setting, and the change applies when the process is next replaced.
  A different tool or permission policy still refuses, so a turn never runs with looser permissions than chosen.
- **A fresh session** still refuses while background work runs: one session holds one process.
