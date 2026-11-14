# Voice stack snapshot, 2026-10-26

What `packages/tessaya-voice` runs on, checked against each project's GitHub on
2026-10-26. Hashes are the files the e2e test ran against.

| Component                                | Version pinned                                                                                                               | Released   | Licence (code / weights)                                     | Files                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| openWakeWord (dscripka/openWakeWord)     | models from release **v0.5.1**; feature pipeline ported from **v0.6.0** `openwakeword/utils.py` (latest release, 2024-02-11) | 2024-02-11 | Apache-2.0 / **CC BY-NC-SA 4.0** for every pre-trained model | see SHA256 below                                                                    |
| Silero VAD (snakers4/silero-vad)         | **v6.2.3**, `src/silero_vad/data/silero_vad.onnx`                                                                            | 2026-09-23 | MIT / MIT                                                    | see below                                                                           |
| whisper.cpp (ggml-org/whisper.cpp)       | **v1.9.5**, `whisper-cli`, built with CMake, CPU, static                                                                     | 2026-10-06 | MIT / MIT (OpenAI Whisper weights)                           | see below                                                                           |
| onnxruntime-node (microsoft/onnxruntime) | **1.30.0** (npm)                                                                                                             | 2026-09-14 | MIT                                                          | ships linux/win32/darwin binaries in the package (~300 MB unpacked)                 |
| espeak-ng                                | distro package (Ubuntu)                                                                                                      | —          | GPL-3.0                                                      | spawned as a separate process for Linux TTS and fixture generation only; not linked |

## SHA256

```
70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f  embedding_model.onnx
94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb  hey_jarvis_v0.1.onnx
ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f  melspectrogram.onnx
1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3  silero_vad.onnx
a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002  ggml-base.en.bin
```

## Notes that change decisions

- **The openWakeWord models are non-commercial (CC BY-NC-SA 4.0).** Fine for the
  Director's own desktop. If Baton ships to customers, "hey jarvis" has to be
  retrained on our own data (openWakeWord's training notebook does this from
  synthetic speech) or swapped for a commercially licensed engine behind the same
  `WakeProvider`.
- openWakeWord streaming details used: 1280-sample (80 ms) chunks; melspectrogram
  over the chunk plus 480 samples of history, transformed `x/10 + 2`; embedding
  over the last 76 mel frames, input `[1,76,32,1]` → 96 floats; wake model over
  the last 16 embeddings `[1,16,96]`; threshold 0.5.
- Silero v6 ONNX: 512-sample windows at 16 kHz with 64 samples of context
  prepended (`input [1,576]`), recurrent `state [2,1,128]`, `sr` int64 scalar.
- whisper.cpp `--prompt` biases recognition toward names. Without it the e2e
  fixture "what is VantageOS doing" came back as "with what his mentor are
  doing"; with project names in the prompt it came back exact.

## Windows (the Director's laptop)

- onnxruntime-node 1.30.0 includes `win32/x64` binaries; nothing to build.
- whisper.cpp: use the release's prebuilt `whisper-bin-x64.zip` (`whisper-cli.exe`)
  or build with CMake + MSVC; point `createWhisperCppStt({ binary })` at it.
- TTS: `System.Speech` through PowerShell, which every Windows 10/11 has.
- Models: same five files; put them under the app's userData, not in the repo.
