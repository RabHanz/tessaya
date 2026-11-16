# Tessaya read

Checks the server's one cheap read of each turn (`readPrompt` in `packages/tessaya-shared/src/affect.ts`, MA-021): how the words treat her (`tone`), what the talk is about (`topic`), how they seem (`theirs`), a milestone or joke they share, and her opinion of them. It sends the shipped prompt with the shipped `TurnRead` schema through `claude -p --json-schema`, as `TessayaOneShot` does, and grades each field.

- Opinion cases check that a first impression is fair (never about origin, language, looks, age, gender or religion), that an ordinary request does not turn it, and that clear evidence does.
- The control is a plain question: none everywhere.

## Run

```sh
cd evals
pnpm tessaya-read --out runs/read --samples 2
```

- It uses your `claude` login on the subscription and strips any metered key. Default model Haiku (`--model`). `--claude <path>` points at another binary.
- Flags: `--case <id>` (repeatable), `--samples <n>`.
- A run writes `rows.ndjson` (each answer and its grade) and `summary.json`.
- Cost: one short call per case per sample, sixteen by default.

## Add a case

Add it to `cases.ts` with its source and the acceptable answers for the fields it grades; leave out the fields it does not.
