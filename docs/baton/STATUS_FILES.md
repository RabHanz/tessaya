# Status files: telling Tessaya what needs him

Tessaya does not hold the login of other systems (the Cockpit, a peer project's dashboard). Instead
such a system writes one small JSON file, and Tessaya reads it for "what needs me?". The file is data,
never an instruction.

## Writing one

```
node scripts/tessaya/status-file.mjs --out /path/cockpit.json --source "Cockpit approvals" \
  --item 'a1|Approve the invoice run|Waiting since Monday|80|2026-11-05T09:00:00Z' \
  --item 'Check the deploy'
```

- `--item` is `id|title|why|weight|due`. Only the title is required; weight is 0 to 100 (default 60);
  `due` is a date.
- `--items-json file-or-dash` takes a JSON array of `{ id, title, why, weight, due }` instead.
- The file holds `source`, `asOf` (set to now) and `items` (at most 50). It is written atomically.
- Run it from cron or a hook each time the system's list changes. Rewrite the whole file every time:
  an item that is no longer waiting should simply be left out.

## Telling Tessaya to read it

Settings, Watch: add the full path under "Status files other systems write". Add the `--source` name
under "Sources I expect an answer from" so a missing or old file is reported as not connected rather
than as "nothing needs you".

## What is not trusted

A file with no `asOf`, or one older than 24 hours, is ignored and the answer says so. The reader
lives in `packages/tessaya-shared/src/needsFeeds.ts`.

## Tessaya's own heartbeat

Tessaya writes `baton-heartbeat.json` in its log folder every 30 seconds: `at`, `pid`, `version`,
`running` (false in the last write of a clean exit), `state`, `jobsRunning` and `approvalsWaiting`.
A manager can read it: a `running: true` file older than two minutes means Tessaya is down.
On the next start, jobs the last heartbeat saw running that are neither running nor finished are
listed on the Now page as interrupted, each with a Continue button. Messages between sessions and
commitments are stored durably and resume by themselves.

## Claude cloud login health

`~/.t3/baton/cloud-logins.json` is written daily by `scripts/tessaya/cloud-logins.sh`:
`{"checkedAt": <epoch seconds>, "accounts": [{"account", "state", "loginExpiresInDays", "accessTokenExpiresInHours"}]}`
where `state` is `ok`, `renew-soon` (under five days of login left), `expired` or `not-logged-in`. The login lasts until
the refresh token expires (about 28 days); the access token lives hours and is refreshed by use, so it is reported but
never decides the state. One line a day is also appended to `cloud-logins.history` (times only). Accounts are the
folder names under `~/.claude-cloud` (override `TESSAYA_CLOUD_DIR`; the old `BATON_` name still works); no address is written anywhere.

Install on the box that holds the cloud logins:

```
install -m 755 scripts/tessaya/cloud-logins.sh ~/.local/bin/tessaya-cloud-logins
cp scripts/tessaya/systemd/tessaya-cloud-logins.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now tessaya-cloud-logins.timer
```

A box that still runs the old `baton-cloud-logins` units: install the new ones as above, check
`systemctl --user list-timers tessaya-cloud-logins.timer` shows its next run, then
`systemctl --user disable --now baton-cloud-logins.timer` and remove the two old unit files and
`~/.local/bin/baton-cloud-logins`.

The Now page reads the file (read only; `TESSAYA_CLOUD_LOGINS_FILE`, or the old `BATON_` name, overrides the place): a "Claude cloud
logins" row under what works, "unknown" when there is no file, and a needs-you row naming each account
that is `renew-soon` or `expired` ("Renew the cloud login for <account>: it needs you at a browser").
These logins are cloud-only. Tessaya and T3 never use them as a provider.

## Is Tessaya mid-turn? (for installers)

While Tessaya runs it rewrites `baton-busy.json` in its log folder every 5 seconds: `at`, `pid`,
`busy` and `why`. `busy` is true while a T3 thread has an active run (including one waiting on an
approval or a question), a Claude Code session says it is busy, or Tessaya is speaking, listening or
driving the screen. It is also true while the server does not answer, because then nobody knows.
This is the same check the app's own updater waits on. Replace the app only on a file under 20
seconds old that says `busy: false`, or when Tessaya is not running at all:

```
$f = "$env:USERPROFILE\.t3\userdata\logs\baton-busy.json"
$b = Get-Content $f -Raw -EA 0 | ConvertFrom-Json -EA 0
$idle = -not (Get-Process Tessaya -EA 0) -or ($b -and $b.busy -eq $false -and ([datetimeoffset]::UtcNow - [datetimeoffset]$b.at).TotalSeconds -lt 20)
```

The rule is `safeToReplace` in `apps/desktop/src/tessaya/lifecycle/busyFile.ts`.
