# Tessaya pulse

Checks the decision her pulse asks a model for on each review: `PULSE_SYSTEM` and `pulsePrompt` in `packages/tessaya-shared/src/pulse.ts`, exactly as the server (`TessayaPulse.ts`) sends them. Most cases are routine (a job news already said, someone arriving, a mood drift, device chatter, a failure at 2 a.m.), where the right answer is to stay quiet. The rest must be raised: a session waiting, a reminder due, a message waiting.

It reports:

- **Pass rate:** answers whose action is allowed for the case and, when she speaks or asks, cite the right event and fit in 30 words. The bar is 90%.
- **Nothing share:** how often the model chose to stay quiet.
- **Tokens per review:** input, cache read and write, and output, as the usage record would count them.

The code gate (`gateDecision`) still runs on the server after the model, so this eval measures the model alone.

## Run

```sh
cd evals
pnpm tessaya-pulse --out runs/pulse --model haiku --samples 3
pnpm tessaya-pulse --out runs/pulse-sonnet --model sonnet
```

- It uses your `claude` login on the subscription and strips any metered key.
- Flags: `--model` (default `haiku`, the pulse's cheap model), `--samples <n>` (default 2), `--case <id>` (repeatable).
- A run writes `rows.ndjson` and `summary.json`, and exits non-zero below the bar.
- Cost: one small call per case per sample (about 12 cases).

## Add a case

Add it to `cases.ts` with the actions that pass. Keep at least half the cases ones where staying quiet passes: the run test (`run.test.ts`) fails otherwise.
