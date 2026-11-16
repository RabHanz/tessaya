# Tessaya group

Checks who speaks next in a group conversation (M-021): the shipped rules in `packages/tessaya-shared/src/groupTalk.ts` (`nextStep`, `stepFromChoice`) and, when they ask, the cheap model's closed choice (`choicePrompt` and `choiceSchema`, one persona id or `end`, with a confidence) through `claude -p --json-schema`, as `TessayaOneShot` does.

- **Turn-taking:** the persona whose role fits answers; in "let them talk" mode the one a line was aimed at answers it; the turn ends when everyone has said goodnight; a listening member is never picked unasked.
- **Addressing:** a name he says picks that persona without a model call, a silent one included; a description ("our film critic") picks it through the model.
- **Budget stop:** a debate that never settles must stop at the speaker budget, with at most one choice call per speaker.
- **Reply (room mood, MA-021):** a speaker answers on the shipped `groupLine` with the others' visible moods and its jealousy dial, and a judge call checks the case's rubric: a gentle word to a member who seems low, a playful touch of jealousy only when the dial is up.

## Run

```sh
cd evals
pnpm tessaya-group --out runs/group --samples 2
```

- It uses your `claude` login on the subscription and strips any metered key. Default model Haiku (`--model`). `--claude <path>` points at another binary.
- Flags: `--case <id>` (repeatable), `--samples <n>`.
- A run writes `rows.ndjson` and `summary.json`.
- Cost: one short call per model-picked case per sample, up to six for the budget case, and two (reply and judge) per reply case; about 40 calls by default.

## Add a case

Add it to `cases.ts` with its source, its group, his words, what was said so far and the acceptable next speakers (`end` to stop). A reply case names its `speaker`, any `moods` and `jealousy`, and a `rubric` for the judge.
