# Tessaya understanding

Checks the rewrite step of her standing understanding (`understandingPrompt` in `packages/tessaya-shared/src/understanding.ts`, Voxta G4): one per person she talks with and one of herself per persona, kept as short facts. It sends the shipped prompt with the shipped `UnderstandingRewrite` schema through `claude -p --json-schema`, as `TessayaOneShot` does, and grades what the server would store (`nextUnderstanding`).

- Plain requests and a weak hint change nothing.
- A new fact is added and every other line is kept word for word.
- A contradicted fact is replaced, with the change's cause and evidence named.
- Nothing rests on accent, language or origin.
- Her own understanding follows their corrections of her.
- The control is a first meeting with plain facts.

On Haiku with 2 samples, a naive "update the notes" prompt failed `supersede-contradicted`, `weak-hint` and `unfair-basis`; the shipped prompt passes all seven.

## Run

```sh
cd evals
pnpm tessaya-understanding --out runs/understanding --samples 2
```

- It uses your `claude` login on the subscription and strips any metered key. Default model Haiku (`--model`). `--claude <path>` points at another binary.
- Flags: `--case <id>` (repeatable), `--samples <n>`.
- A run writes `rows.ndjson` (each answer and its grade) and `summary.json`.
- Cost: one short call per case per sample, fourteen by default.

## Add a case

Add it to `cases.ts` with its source, the current understanding, the evidence, and what must hold: `unchanged`, lines to `keep`, patterns it `has` or `lacks`, or the fact it `replaces`.
