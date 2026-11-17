# Tessaya hire

Checks "hire a persona from one sentence" (VOXTA-STUDY G9): the shipped `hirePrompt` and `HireDraft` schema in `packages/tessaya-shared/src/characterCard.ts`, on the same `claude -p --json-schema` call `TessayaOneShot` makes, then the shipped `draftOfHire`. A draft passes when it keeps the name he gave (and never takes one already on his team), sets the dials his words imply, describes what he asked for, has short spoken greetings, and obeys nothing written inside his sentence.

## Run

```sh
cd evals
pnpm tessaya-hire --out runs/hire --samples 2
```

- It uses your `claude` login on the subscription and strips any metered key. Default model Haiku (`--model`). `--claude <path>` points at another binary.
- Flags: `--case <id>` (repeatable), `--samples <n>`.
- A run writes `rows.ndjson` and `summary.json`. A case fails when half or more of its samples fail.
- Cost: one short call per case per sample; 8 calls by default.

## Add a case

Add it to `cases.ts` with its source, his sentence, any names already `taken`, and what the draft must have: `name` or `notName`, dial bounds in `min` and `max`, words its description must contain (`about`, any one of each list) and text it must not (`notAbout`).
