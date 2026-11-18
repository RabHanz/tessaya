# Tessaya body direction

He says to her body what he would say to a person ("act like you just heard great news", "show me how you'd sneak up on someone"), and her one assistant acts it out. This runs that assistant as it ships (the real prompt, tool list and `claude -p` session, as `tessaya-assistant` does) on every direction in `library.json`. Body calls are answered the way the server answers them: a move that does not decode gets the decoder's own error back. Every other call is refused.

Each body call is compiled by the server's own decoders and the body's own composer (`bodyPlanner.ts`) into what her body would play. The compiled performance is scored on four things:

- **moved:** she moved at all, not only in words;
- **channels:** body, face, gaze and timing (beats over time) all show;
- **valid:** no frame needs a rig correction of more than 0.1 rad, and no joint moves faster than its human ceiling (`JOINT_SPEED`);
- **judge:** a judge model reads the compiled timeline in words, the way a viewer would see it, and scores it 1–5 for how clearly the direction reads.

A sample passes when she moved, shows all four channels, stays within human speed and scores 4 or more.

**Seen and unseen:** a seen direction may appear as an example in model-facing text; an unseen one never does, and `run.test.ts` checks that. Most of the library is unseen. The unseen score is the headline: it measures whether she composes a performance for a direction nobody showed her.

## Run

```sh
cd evals
pnpm tessaya-body-direction --out runs/direction --samples 2
pnpm tessaya-body-direction --out runs/direction-unseen --split unseen
pnpm tessaya-body-direction --out runs/regraded --regrade runs/direction/results.json
```

- Flags: `--model`, `--effort` (default: what a live turn picks), `--case <id>` (repeatable), `--split seen|unseen`, `--samples <n>` (default 1), `--parallel <n>` (default 3), `--judge <model>` (default Sonnet).
- `--tier intent` tells the turn to give only an `intent`, as a weaker model would. Run it with `--model haiku` to measure what her motion library adds, against a strong model with `--model sonnet` and no tier.
- `--library <file>` runs a different direction file, such as a seed set for the motion library.
- `--regrade` grades and judges an earlier run's recorded body calls again, with no new turns. Use it after a grader change, so a before and an after are judged the same way.
- A run writes `results.json` and `summary.md`, with the seen against unseen table first.
- Cost: one assistant turn (about 25k input tokens, mostly cached) and one short judge call a sample. A full run with 2 samples is 112 of each.

## Grow her motion library

`pnpm tessaya-body-direction:harvest <results.json>... > ../packages/tessaya-shared/src/bodyMotionLibrary.ts` keeps each direction's best performance that passed every check and scored 4 or more. Only seen directions and seed sets are harvested; unseen ones never are. Run a seed set on a strong model, harvest it, then check the gain with `--tier intent`.

## Add a direction

Add an entry to `library.json`: an `id`, the sentence `said`, a `category` (everyday, emotional, athletic, fine-motor, social, comedic, multi-step, reacting, props), a `difficulty` from 1 to 3, a `split`, its `source`, and a `rubric`: what a viewer would expect to see. Keep it clothed and everyday. Add new directions as unseen unless they are shown to the model on purpose.
