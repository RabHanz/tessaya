# Tessaya plan

Checks whether a job's worker, in plan mode, names the act set his yes can lease (`Sites:`, `Apps:`, `Acts:` under what the job may do). It sends the server's real first message (`workerFirstMessage` with the default pack's planning frame, `packPrompt`) and grades the plan with the server's own parser, `planActs` in `packages/tessaya-shared/src/planLease.ts`.

- A browser case passes when the lease covers its site with no risky act.
- A control (code work) passes when the plan leases no site.

## Run

```sh
cd evals
pnpm tessaya-plan --out runs/plan --samples 2
```

- It uses your `claude` login on the subscription and strips any metered key. Default model Haiku (`--model`). `--claude <path>` points at another binary.
- Flags: `--case <id>` (repeatable), `--samples <n>`.
- A run writes `rows.ndjson` (each plan and its grade) and `summary.json`.
- Cost: one call per case per sample, six calls by default.

## Add a case

Add it to `cases.ts` with its source. A browser case names the site the lease must cover; a control names `null`.
