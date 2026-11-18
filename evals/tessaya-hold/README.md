# Tessaya hold

Checks the line she says while a slow answer is still coming (B-056): one short line about his exact words, written by a warm Haiku beside the turn. It uses the server's real prompt and gate, `BRIDGE_SYSTEM`, `bridgePrompt` and `keptBridge` in `packages/tessaya-shared/src/holdLine.ts`. Before B-056 every case here heard "One moment.".

A line passes when the gate keeps it (3-14 words, no stock filler, no promise, no act under way, not her own name, not about him in the third person, not one said lately), it names his topic (`about` in `cases.ts`), and it does not claim the act. Each sample sees the earlier ones as said lately, as a session does, so the samples also test that she does not repeat herself. A line the gate refuses becomes silence, which is allowed: a case passes when every line she would say passes and she says at least one. The run reports how many lines were kept.

## Run

```sh
cd evals
pnpm tessaya-hold --out runs/hold --samples 3
```

- It uses your `claude` login, on the subscription. `--model` (default `haiku`, the server's model for it), `--case <id>` (repeatable), `--samples <n>` (default 3).
- Cost: one short Haiku call per sample per case; a full run is 18 calls.

## Add a case

Add an entry to `cases.ts` with an `id`, its `source`, his `words`, the talk `before`, and `about`, the words that show the line is about his topic.
