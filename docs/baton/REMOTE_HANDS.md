# Remote hands

A remote session (the Harbour manager, a phone) can drive this computer's apps through Tessaya itself: no ssh, no copied scripts,
no console windows. Today's manager path costs 5 to 10 s a step because every step is a new ssh login plus a new PowerShell.

## Shape

```
remote session --HTTPS bearer (baton:hands)--> hub server /tessaya/hands/call
hub server --long poll (baton:hands-host)--> desktop app --> gate --> hands tool --> answer back the same way
```

- The **server only brokers** (`packages/tessaya-shared/src/remoteHands.ts`, `apps/server/src/tessaya/TessayaHandsApi.ts`): it allows a fixed list
  of tools, holds a call until the desktop takes it (a long poll, so a call arrives at once), and writes an audit line
  (`baton-hands-audit.ndjson` beside the database; typed text is logged as its length, never its content).
- **The same channel serves the one brain** (`apps/server/src/tessaya/VesselHands.ts`, SPINE-UNIFY): the desktop publishes the tools it offers
  a brain turn with its `take`, and a turn's call reaches only those, carrying the turn's origin (which vessel heard it, whose voice) for the
  gate. A remote session still reaches only the fixed list; it can neither set an origin nor reach a published tool.
- The **desktop owns the gate and the mouse guard**. Every call goes through the same `judgeToolCall` and `createAgentGate` as the assistant's
  own tools; an "ask" goes to the Director as a normal question, and with the **Director-away flag** on it is a refusal, because nobody can answer.
- **Scope `baton:hands`** is never in the standard scopes. The Director issues it to one session's token on his own computer
  (`auth token --scopes baton:hands`); revoking that session ends it. `baton:hands-host` belongs to the desktop's own session only.
- **No windows, no focus theft.** Picture of a named window by `PrintWindow` (works occluded and in the background); controls acted on by their UI
  Automation patterns first; a pointer click only when a control has no pattern, and then the previous window gets the keyboard back (the
  answer says when Windows refused that). `type_text` with a `window` adds the text to that window's box by its UI Automation value (no
  keyboard, clipboard or focus); keys go out only when the named window already has the keyboard, and are refused otherwise.
- **He can see it and take it back.** While a remote call runs the pill says "Remote session"; Trust lists remote hands, and "turn off
  remote hands" turns them off. While he is present, a window picture or `ui_tree` follows his screen setting (it may ask); "I'm away" is
  his standing yes (D153).
- **Ops tools**: `app_version`, `log_tail` (named logs only, last N lines), `process_list` / `process_stop` (only an id `process_list` returned),
  `app_update` (the app's own updater, to a given version, replacing scp and scheduled tasks), `open_page` (a page in the Home window).

## Built

Broker, scopes, HTTP routes and audit; the desktop's long-poll loop (`remoteHandsLoop.ts`) behind the same `judgeToolCall` gate and mouse guard
as the assistant (its own gate instance: a question is refused while the Director-away toggle is on, and a call does not inherit what an earlier
call read); the remote tool table (`remoteHandsTools.ts`); the sidecar's `capture_window` (PrintWindow), window targeting, pattern actions and
`focus_window`; the ops tools, with `app_update` going through the existing desktop updater (`check`, `download`, then the tray's install at a
quiet moment). Two toggles under "Working for you": remote hands (off by default; nothing is polled while off) and "I'm away".
Measured on the CI Windows desktop (the bench and the end-to-end run in `baton-hands-bakeoff.yml`): UI action about 80 ms, window picture about
47 ms, tree read about 70 ms; a full remote call over loopback HTTP through the hub, the loop and the gate 40 to 90 ms, plus the network.

Not built: a way to start a process from a remote session, so `process_list` is empty and `process_stop` has nothing to stop; Home pages other
than the window itself (`open_page` opens Home).

## Granting it and calling it

1. On the Director's computer, once per remote session, issue a token for that session only (it expires, and revoking it ends the session):
   `auth session issue --scope baton:hands --ttl 8h --label harbour-manager --token-only` (the app's bundled server CLI).
2. In Tessaya, Working for you: turn on "Let a remote session drive this computer". Turn on "I'm away" when he is not there.
3. From the remote box, with the hub's tailnet URL and that token:

```
curl -s -X POST "$HUB/tessaya/hands/call" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"tool":"ui_tree","args":{"window":"Notepad"}}'
```

The answer is `{ok, text, images?, error?}`; `images` holds a PNG (base64) for `window_capture`. `GET /tessaya/hands/audit` lists the recent calls.
