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

## Live suite

`live.ts` drives every room tool on a running server as a pretend R1 (`replay-suite`): the server's real brain, tools and Home Assistant. Reads are live; the house's writes and asks to his phone are dry runs on the server (checked and judged as for real, then not sent), and a replay never moves his R1. The reply's `tessaya.trace` chunk carries the tool calls, so a case checks the tool, its arguments, its result and whether her words match the result.

```sh
scripts/tessaya/room-suite.sh <t3 binary of the build> [userdata dir] [--laptop]
```

- The script starts the build on a scratch copy of what the room needs (the house's address and token, the R1's key without its MQTT login, the brain's key), runs the suite and removes the copy. It exits non-zero on any failure, so a deploy can gate on it.
- Sentences name devices by slot (`{fan}`, `{fan.flip}` for the opposite of its state), filled from the server's own house through home_find, so it runs on any install. A slot the house has no device for is reported as not applicable.
- `--laptop` adds the case that asks your real laptop what is on its screen (read-only).
- Every room tool needs a case in `liveCases.ts` (`proves`): `run.test.ts` fails otherwise.
- `--vessel desktop` runs the same cases through his desktop's Tessaya as it ships (its prompt and tool table, a real `claude -p` on your own login; `--model` to pin one), with the server's shared tools run there as the desktop's caller and always a rehearsal. A case only the R1's tools could pass is not applicable. It costs model turns, so it runs nightly or on demand, never as the deploy gate:

```sh
cd evals
node tessaya-room/live.ts --vessel desktop --server <server> --key-file <the R1 device key> --out runs/desktop
```

- A phone adapter follows the phone app (#809): the phone has no turn of its own on the server yet.
