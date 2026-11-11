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

## A satellite of Tessaya, not a second stack

The loop holds no brain, memory or settings of its own. What it reuses:

| Piece                             | Where it comes from                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Recognition                       | `tessaya-recognizer` (native/tessaya-recognizer), the same service and model the desktop's dictation streams to  |
| The reply, memory, home and trust | Tessaya's R1 turn on her server (`apps/server/src/home/R1Device.ts`), with her memories, Home Assistant and gate |
| His names                         | the server's turn runs dictation's `biasTranscript` over the shared dictionary (`speechProjectCustomWords`)      |
| Which Claude answers              | Settings → Home → Room brain, reading the Anthropic key in Settings → APIs or the subscription                   |
| Voice ID                          | `speaker.ts` policy and CAM++ model id, `speakerStore.ts` (all in `@t3tools/baton-voice`)                        |
| Cut-in check                      | `echoGuard.ts`, the desktop's own                                                                                |

What stays R1-specific, and why:

- **Its own owner profile** (`state/voice/speakers.json`). The R1's mics are not his laptop's. Two profiles of one voice in one list nearly tie and read as a guest, and merging them lowers his scores (the Voice ID lane's measurement).
- **A Pocket process on the voice host.** Tessaya has no server-side voice yet: the desktop runs Pocket locally. These are the same pinned model files. The voice (`R1_VOICE`, "anna", her default) is set here until her voice setting lives on the server.
- **Smart Turn and SenseVoice.** They are new, and they are in the shared package, so the desktop can adopt them.
- **The MQTT transport and paced downlink.** These are the R1's own wire.

"Standalone mode" (an R1 without Tessaya) is not built: the loop always asks her.
