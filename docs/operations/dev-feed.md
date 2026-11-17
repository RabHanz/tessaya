# Problem reports and the developer feed

Tessaya sends problem reports back to the maintainers, and in developer mode keeps a live feed of every
vessel's conversation events. Both read the action log, so the Tessels, the desktop app, phones and web
chat all feed the same channel.

## The setting

**Settings → Health → Developer feedback loop** (`tessayaFeedback` in server settings, or say "turn on the
developer feedback loop"):

- **Off** (the default): nothing is collected or sent, even when asked.
- **Silent**: triage files a report when it finds a real fault, without a word. Asking her to "report
  this" still works.
- **Developer**: the owner's mode. Silent's reports, plus the live feed and its daily files, and she
  says one short line through the pulse when she sends a report on her own.

**Open a GitHub issue** (`tessayaFeedbackGithub`) also runs `gh issue create` on `RabHanz/tessaya`
with the `tessaya-report` label, so the server's `gh` must be signed in.

## What triage reports

Every two minutes while the setting is on, triage reads the last hour of the action log through the gap
detector (`findGaps`): repeating failures, retry storms, Voice ID holding the owner, and two turn verdicts
on one Tessel within 2.5 s (two room loops answering). It also reports a degraded health cause (a loop,
service or Tessel down, memory starvation, dropped brain turns) that holds two beats in a row. The same
cause is reported once a day, and her own reports are capped at 3 an hour and 10 a day.

A report carries the symptom, her guess, the health diagnosis and snapshot, and up to 40 log events
(the fault's cause chains, recent failures and turn metrics). Events keep numbers, flags and short
enums only; text fields and private events never enter a report or the feed.

## Reading reports

- MCP: `tessaya_reports` lists them (add `id` for one bundle); `tessaya_report_withdraw` withdraws or
  deletes one.
- File: `<T3 home>/userdata/tessaya-feedback/reports.jsonl`, one line per change.
- Settings → Health on web, desktop and mobile lists them with **Withdraw** and **Delete**.

Paired servers mirror each other's reports over the memory-sync credential, so any one of them lists
them all. A delete clears the bundle on every mirror.

## Tailing the feed

The feed is on only in developer mode. Three ways in:

- On the server's machine: `tail -F ~/.t3/userdata/tessaya-feedback/feed-$(date -u +%F).jsonl`.
  Files roll daily (UTC) and are kept for seven days.
- MCP, from a full-access agent credential: call `tessaya_dev_feed` with `waitSeconds: 30`, then again
  with `after` set to the last `next`. Pass `vessel` to follow one device.
- WebSocket RPC: `baton.reports.feed` with the same input, from a client that holds
  `environment:maintain`. Like the MCP tool it is a long poll: the server holds the last 2,000 events,
  and `next` is the cursor.
