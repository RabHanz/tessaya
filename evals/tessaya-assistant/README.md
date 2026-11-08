# Tessaya assistant

Runs Tessaya's one assistant as it ships: the real `AGENT_PROMPT` with the default pack's frame, the real tool list on the real MCP server, and a real `claude -p` session. It scores which tool the assistant reaches for first after one spoken sentence. Every tool call is recorded and refused, so nothing runs on your machine.

## Run

```sh
cd evals
pnpm tessaya-assistant --out runs/assistant
pnpm tessaya-assistant --out runs/assistant-haiku --model haiku --case needs-me --samples 1
```

- It uses your own `claude` login (subscription; metered API variables are stripped). `--claude <path>` picks the binary.
- Flags: `--model` and `--effort` (default: what a live turn picks, as `chooseTurnBrain` in `packages/baton-shared/src/turnTier.ts` does: Haiku for a simple turn, Sonnet for most, and the persona's own model from the default pack, at most, for planning; Haiku takes no effort), `--case <id>` (repeatable), `--samples <n>` (default 2). `--extra-notes <file>` adds the file's text to every turn the way a matched learned skill is added, to check a skill against the whole suite.
- A case passes when more than half its samples reach first for a tool in `first` and not one in `not`.
- A run writes `results.json` and `summary.md`, with the median time a sample took (a cold `claude` start included, so compare runs made one at a time).
- Cost: about 25k input tokens a sample, mostly cached; a full run is 40 samples.

## Add a case

Add an entry to `cases.ts` with an `id`, its `source`, the sentence `said`, and the acceptable `first` tools (`none` for a plain answer). Add `not` for a wrong first move the case guards against. A case with `wake` runs as that persona from the default roster; `says` lists words the reply must contain, and `notSays` text it must not (a path, an extension). `answers` lets named tools run with a fixed text, built from the shipped formatter, so a case can check what the reply says about it. `window` is the window he is using (Notepad when left out). `again` adds sentences he says next in the same session (`notSays` then holds for every reply), and `varies` fails a sample where a reply opens with the same four words as the one before. `now` sets his clock (an ISO time and a zone). A recorded turn adds `goal` and `maxCalls`: it passes only when it reaches the `goal` tool within that many calls (Learning v0 replays a slow turn this way). `goalArgs` lists words that goal call's arguments must contain, such as the persona a part goes to. `notGoalArgs` lists text they must not contain, such as a made-up argument's key. `model` is the model a run without `--model` must put the turn on, so a simple turn proves it is answered on the fast model and still reaches the right tool.
