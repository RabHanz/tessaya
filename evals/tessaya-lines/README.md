# Tessaya lines

Checks the spoken lines Tessaya writes ahead for each moment: acknowledgements, fillers, confirmations, notices, the step-up and enrolment lines, and the lines she says when someone moves her R1. It uses the server's real prompt, `linesPrompt` in `packages/tessaya-shared/src/expression.ts`, and grades with the same gate the server applies, `lineProblem`. A wording that fails the gate is never said.

For each persona and moment it reports:

- **Kept rate:** the share of wordings that pass the gate.
- **Fact-slot failures:** wordings that lose, repeat or invent a `{slot}`. Slots are how names, titles and numbers reach a line exactly.
- **Required-word failures:** wordings that leave out words a safety or approval line must keep, such as "false alarm" or "phone".
- **Distinct:** distinct wordings over all written.
- **Same opening:** the largest share of kept wordings that start with the same two words.
- **Plain echoes:** kept wordings that just repeat today's fixed line.

The bars are set in `grade.ts` (`BARS`). The baseline is today's fixed lines, which have exactly one wording per moment.

## Run

```sh
cd evals
pnpm tessaya-lines --out runs/lines --persona executive
pnpm tessaya-lines --out runs/pool --persona executive --persona engineering --samples 4 --write-pool
```

- It uses your `claude` login, on the subscription, and strips any metered key. Her words are persona speech, so the model is Sonnet (`--model`), never the cleanup model.
- Flags:
  - `--persona <id>` (repeatable; default `executive` and `engineering`);
  - `--event <id>` (repeatable; default every moment);
  - `--per <n>` (wordings per moment per call, default 12);
  - `--samples <n>`;
  - `--write-pool`, which folds the kept wordings into the shipped offline pool, up to `--pool-size` (default 40) per moment.
- A run writes `moments.ndjson` and `summary.json`.
- Cost: one call per 8 moments per sample, about 4 calls per persona per sample, counted against the plan.

## Add a moment

Add it to `LINE_EVENTS` in `expression.ts`, run this eval with `--event <id>`, then run it with `--write-pool` so the offline pool covers the new moment.
