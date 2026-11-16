# Tessaya dictation

Checks Tessaya's own dictation clean-up (`rewriteSystemPrompt`, `checkRewrite` and the one retry, as `cleanDictation` in `packages/tessaya-shared/src/dictationCleanup.ts` runs them) on made-up dictations shaped like the ones where it fell short of Wispr Flow: a phrase said again in other words, a correction with no marker across sentences, mis-heard words, spoken numbers, a capital the recogniser put on a plain word, a dictionary entry in small letters, a phrase said again after a pause, a correction across two presses (his message so far cleaned with the next one), and a mis-hearing the chat reply he is answering settles.

A case passes when the model's text is pasted (not refused for the local tidy) and holds every word in `must` and none in `never`.

## Run

```sh
cd evals
pnpm tessaya-dictation --out runs/dictation --samples 3
```

- It uses your `claude` login on the subscription and strips any metered key. Default model Haiku, as the product uses (`--model`). `--claude <path>` points at another binary.
- Flags: `--case <id>` (repeatable), `--samples <n>`, `--one-prompt` (the server's path for web and mobile: the rules and the dictation in one prompt with a JSON answer, under Claude Code's own system prompt).
- A run writes `rows.ndjson` (each text and its grade) and `summary.json`.
- Cost: one call per case per sample, two when the check refuses the first answer.
- The retry goes inside one message here, as on the subscription path; the key path sends it as its own turns.

## Add a case

Add it to `cases.ts`. Keep it made up: never his own words.
