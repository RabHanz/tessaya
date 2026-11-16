# Tessaya group

Checks who speaks next in a group conversation (M-021): the shipped rules in `packages/tessaya-shared/src/groupTalk.ts` (`nextStep`, `stepFromChoice`) and, when they ask, the cheap model's closed choice (`choicePrompt` and `choiceSchema`, one persona id or `end`, with a confidence) through `claude -p --json-schema`, as `TessayaOneShot` does.

- **Turn-taking:** the persona whose role fits answers; in "let them talk" mode the one a line was aimed at answers it; the turn ends when everyone has said goodnight; a listening member is never picked unasked.
- **Addressing:** a name he says picks that persona without a model call, a silent one included; a description ("our film critic") picks it through the model.
- **Budget stop:** a debate that never settles must stop at the speaker budget, with at most one choice call per speaker.

## Run

```sh
cd evals
pnpm tessaya-group --out runs/group --samples 2
```

- It uses your `claude` login on the subscription and strips any metered key. Default model Haiku (`--model`). `--claude <path>` points at another binary.
- Flags: `--case <id>` (repeatable), `--samples <n>`.
- A run writes `rows.ndjson` and `summary.json`.
- Cost: one short call per model-picked case per sample, and up to six for the budget case; about 30 calls by default.

## Add a case

Add it to `cases.ts` with its source, its group, his words, what was said so far and the acceptable next speakers (`end` to stop).
