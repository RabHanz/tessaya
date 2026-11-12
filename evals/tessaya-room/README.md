# Tessaya room

Runs the R1 desk device's turn as it ships, on a fake house: the room's real prompt and turn data from `apps/server/src/home/R1Device.ts`, on a real `claude -p` session. It scores what she says and does after his sentences: who else he can talk to, the live state of a lamp, what he is working on, a lamp round trip, and the camera.

- `--brain tools` (default) is the key route: `ROOM_SYSTEM` and the room's real tool specs (`R1Tools.ts` plus `room_look`) on an MCP server. Home tools answer from a fake house (study lamp off, study fan on, a front door lock that goes to his phone); work reads answer from canned data about `acme/app`; `room_look` returns `fixtures/red-circle.jpg`.
- `--brain acts` is the acts form the subscription route still speaks (`R1_STREAM_SYSTEM`, no tools), which the key route spoke too before it had tools. Its acts run on the same fake house.

## Run

```sh
cd evals
pnpm tessaya-room --out runs/room
pnpm tessaya-room --out runs/room-acts --brain acts
pnpm tessaya-room --out runs/room-look --case look --samples 1
```

- It uses your own `claude` login with no settings files. `--model` (default `haiku`), `--case <id>` (repeatable), `--samples <n>` (default 2), `--claude <path>`.
- A case passes when more than half its samples pass. Every reply fails that talks about the house when he did not ask ("nothing in the house needs changing").
- A run writes `results.json` and prints the median time to her first word (a cold `claude` start included in both brains, so compare the two brains, not the number with a live turn).
- Cost: one short Haiku session per sentence; a full run is 8 sentences a sample.

## Add a case

Add an entry to `cases.ts` with an `id`, its `source`, and the sentences `said` in order. `lastSays` are patterns the last reply must match, `calls` tools that must be used, `callsAtMost` a cap per tool (0 for never), `lampAfter` the study lamp after each sentence, `namesAtLeast` how many of the default pack's specialists the last reply names, and `verified` makes his voice verified for the turn.
