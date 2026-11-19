# Tessaya wish

Checks her rare wish of her own (M-087 step e): when nobody is talking to her and the rules in `packages/tessaya-shared/src/motives.ts` (`chooseWant`) give her nothing, a lively her asks the cheap model what she feels like doing, through the shipped `wishPrompt` and the closed `WishAnswer` schema (one of the wants, or `none`, with a short reason), as `TessayaBody.wishTick` does.

- **Fits her feeling:** tired late at night rests; hurt or lonely after hours sulks or goes to find him; bright plays or looks around.
- **Controls:** an ordinary neutral moment stays calm (no sulking, no seeking him), and a happy her never sulks.

## Run

```sh
cd evals
pnpm tessaya-wish --out runs/wish --samples 3
```

- It uses your `claude` login on the subscription and strips any metered key. Default model Haiku (`--model`). `--claude <path>` points at another binary.
- Flags: `--case <id>` (repeatable), `--samples <n>`.
- A run writes `rows.ndjson` and `summary.json`.
- Cost: one short call per case per sample, 18 by default.

## Add a case

Add it to `cases.ts` with its source, her state (`MotiveInput`), the hour, and the wishes a person in her place could fairly choose.
