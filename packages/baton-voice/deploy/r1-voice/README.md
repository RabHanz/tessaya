# R1 room voice

The R1's in-house voice loop (`src/room`), run on the voice host next to the R1. Design and trade-offs:
`tessaya-ops/research/R1-OFF-AGORA.md`.

- **Layout** under `~/r1-voice`: `node/` (Node 24), `app/` (the esbuild bundle of `src/room/main.ts` and `replay.ts`
  plus `onnxruntime-node`), `models/`, `secrets/` (0700), `state/` (Voice ID profile, `metrics.ndjson`), `env`.
- **Models:**
  - `silero_vad.onnx` (native/baton-dictation/models).
  - `smart-turn-v3.2-cpu.onnx` (pipecat-ai/smart-turn-v3, BSD-2).
  - `sensevoice.int8.onnx` and `sensevoice.tokens.txt` (csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17;
    FunASR model licence, personal use only).
  - `campplus.onnx` (the desktop's Voice ID model, sha256 357a834f…).
  - `pocket/` (the pocket-tts 3.3.0 Linux binary, and `english/` with Tessaya's voice, as the desktop fetches it).
- **Install:** `systemctl --user enable --now r1-voice` with `r1-voice.service` in `~/.config/systemd/user/`.
- **Gate before an R1 is switched to it:** `node app/replay.mjs <his wavs>` with the same env. It plays his recordings
  as a pretend R1 (`replay-1`) and prints the end-of-voice to first-sound time per clip, then p50 and p90.
- **Switch an R1** (no firmware change): publish `{"mode":"inhouse"}` to `freya/r1/<id>/cmd/voice/mode`. To go back,
  publish `{"mode":"agora"}`.
- **Voice ID enrolment through the R1:** publish anything to `freya/r1/<id>/voice/enrol` while he is by it. She asks him
  to talk for about 20 s, then saves the owner profile (vectors only) in `state/voice/speakers.json`.
