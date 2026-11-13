# Tessaya brain

Measures what each brain costs a spoken turn: how fast she starts talking and what she sends. It uses the device's real prompt (`ROOM_SYSTEM`, `roomData`) and the room's real tool specs (`R1Tools.ts` plus `room_look`), with canned tool results. The design it measures is tessaya-ops `research/BRAIN-DESIGN.md`.

- `run.ts` is the API route, raw HTTP and streamed as `DictationCleanupApi.converse` sends it. Arms: `haiku-off` (today's device brain), `sonnet-bt-low` (`between_tools`, effort low), `sonnet-bt-medium`, and `sonnet-bt-low-web` (Anthropic's web search tool, for comparison).
- `subscription.ts` is the subscription route: one warm `claude -p` session per arm, kept up between turns (stream-json in and out), the next one started ahead and swapped in every `--recycle` turns. The room's tools are served over MCP. Arms: `cli-haiku`, `cli-sonnet-low`, `cli-sonnet-low-deferred` (`ENABLE_TOOL_SEARCH=true`), and `cli-sonnet-low-web` (Claude Code's own WebSearch and WebFetch).
- `tokens.ts` counts each tool set with `count_tokens`, both eager and deferred behind tool search.

Each turn runs the room's tool loop. "First text" is the room's `brainFirstMs`: the first word in any round, with the time for tool rounds included. Arms alternate sentence by sentence.

## Run

```sh
cd evals
pnpm tessaya-brain --out runs/api --reps 4
pnpm tessaya-brain:tokens
pnpm tessaya-brain:subscription --out runs/sub --reps 2
```

- `run.ts` and `tokens.ts` need `ANTHROPIC_API_KEY` (the brain's key) in the root `.env`. `subscription.ts` uses your `claude` login and strips any metered key from its environment.
- Flags: `--arm <id>` (repeatable), `--reps <n>`, `--limit <n>` (first n sentences), `--sentence "<words>"` (repeatable, replaces the list), and `--recycle <n>` (subscription only).
- A run writes `turns.ndjson` (one row per turn) and `summary.json` (p50/p95 per arm; tokens and dollars per turn on the API route).
- Cost on the API route: about $0.0004 a turn on Haiku and $0.006 a turn on Sonnet, plus $0.01 a search on the web arm. A full 4-rep run of three arms is about $3. `count_tokens` is free. The subscription route counts against the plan.

## Add a sentence

Add it to `LIVE` or `EVERYDAY` in `sentences.ts`. The room suite's sentences (`../tessaya-room/cases.ts`) are included automatically.
