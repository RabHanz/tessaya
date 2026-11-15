# Tessaya dictation

Checks Tessaya's own dictation clean-up (`rewriteSystemPrompt`, `checkRewrite` and the one retry, as `cleanDictation` in `packages/tessaya-shared/src/dictationCleanup.ts` runs them) on made-up dictations shaped like the ones where it fell short of Wispr Flow: a phrase said again in other words, a correction with no marker across sentences, mis-heard words, spoken numbers, a capital the recogniser put on a plain word, and a dictionary entry in small letters.

A case passes when the model's text is pasted (not refused for the local tidy) and holds every word in `must` and none in `never`.

## Run

```sh
cd evals
pnpm tessaya-dictation --out runs/dictation --samples 3
```

- It uses your `claude` login on the subscription and strips any metered key. Default model Haiku, as the product uses (`--model`). `--claude <path>` points at another binary.
- Flags: `--case <id>` (repeatable), `--samples <n>`.
- A run writes `rows.ndjson` (each text and its grade) and `summary.json`.
- Cost: one call per case per sample, two when the check refuses the first answer.
- The retry goes inside one message here, as on the subscription path; the key path sends it as its own turns.

## Add a case

Add it to `cases.ts`. Keep it made up: never his own words.
