# Third-party notices

Code in Tessaya adapted from other projects, with their licences. Each entry names the files that
carry the adapted code.

## farzaa/clicky (MIT)

Commit `a80fa80721a8`. Adapted: the companion prompt and the `[POINT:x,y:label:screenN]` tag, its
parser, the screenshot-pixel to display coordinate maths, the 1280 px capture size, and the
pointer's triangle and quadratic-bezier flight. In `packages/baton-shared/src/screenCompanion.ts` and
`apps/desktop/src/baton/screen/pointerOverlay.ts`.

```text
MIT License

Copyright (c) 2026 Farza

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bitshank-2338/clicky-windows (MIT)

Commit `6c6216b7f80a`. Adapted: Drive's plan shape, `validate_plan`, the stop-on-mouse-movement
and stale-screen rules, and the "next"/"stop" phrases. In
`packages/baton-shared/src/screenCompanion.ts`. Its PyQt6 interface (GPL-3.0) is not used.

```text
MIT License

Copyright (c) 2026 Shashank Singh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## cjpais/Handy and handy-computer crates (MIT)

Handy commit `7bfb2e2c934b`. Adapted: the Windows reliable paste (`src-tauri/src/paste_tx/`) in
`native/baton-dictation/src/paste_windows.rs`, the paste chords in `keys.rs`, and the pinned Parakeet
revision and hash in `apps/desktop/src/baton/voice/voiceModels.ts`. Used as dependencies:
`transcribe-cpp` 0.4.1, `handy-recorder` 0.1.0, `handy-keys` 0.3.4 (each MIT; transcribe.cpp vendors
ggml, Silero VAD and miniz, all MIT). The Handy name and brand assets are not used.

```text
MIT License

Copyright (c) 2025 CJ Pais

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Speech and wake models

- Parakeet TDT 0.6B v3 (NVIDIA, CC BY 4.0), GGUF conversion `handy-computer/parakeet-tdt-0.6b-v3-gguf`,
  downloaded on first use.
- Pocket TTS (Kyutai, MIT) binary, and its weights and voice embeddings (CC-BY-4.0), downloaded on
  first use from `kyutai/pocket-tts-without-voice-cloning`. Attribution: "Pocket TTS by Kyutai, CC BY 4.0".
  The embeddings are made from recordings listed in `kyutai/tts-voices`: VCTK (CC BY 4.0: anna, azelma,
  charles, eponine, eve, fantine, george, jane, mary, michael, paul, vera), Voice-Zero/LibriVox and the
  Unmute voice donations (CC0: bill_boerst, caro_davy, peter_yearsley, stuart_bell, javert, marius),
  Common Voice (CC0: giovanni, lola), Kyutai's Unmute recordings (CC0: estelle). alba, juergen and rafael
  carry no licence line of their own there; check them as well before offering them. cosette
  (Expresso) and jean (EARS) come from CC BY-NC 4.0 recordings: check them before offering either in a
  commercial release. Only anna, vera, charles and paul are offered today; the voice lab can play all 27.
- `melspectrogram.onnx`, `embedding_model.onnx` from openWakeWord v0.5.1, `silero_vad.onnx` from
  Silero VAD v6.2.3 (MIT), shipped in `native/baton-dictation/models`. See
  `docs/baton/research/voice-stack-2026-10-26.md` for their licence notes.
- `sebastian.onnx`, `alfred.onnx`, `freya.onnx`, `onyx.onnx`, `tessaya.onnx`: trained here (D98) on Piper's LibriTTS
  and en_GB voices (VCTK, aru, semaine, alba, jenny_dioco, northern_english_male,
  southern_english_female) with openWakeWord's published negative features. Those sets carry their own
  terms, some non-commercial. Check them before any packaged or commercial release.
- Fonts bundled in the window and the pill (inline, `apps/desktop/src/baton/home/fonts.ts`, Latin subset),
  all SIL Open Font License 1.1, texts in `docs/baton/licences/`: Newsreader (roman and italic, variable
  weight; Copyright 2020 The Newsreader Project Authors), Schibsted Grotesk (variable weight;
  Copyright 2023 The Schibsted-Grotesk Project Authors) and Bricolage Grotesque (variable weight;
  Copyright 2022 The Bricolage Grotesque Project Authors).

## What ships, and under which licence (checked by CI)

`docs/baton/notices.json` lists every dependency, crate, model file and font that Tessaya's own code ships or downloads, and
`scripts/tessaya/check-notices.mjs` (run by the `verify` job) fails when one is missing here or has no licence text. Upstream T3
Code's own dependencies are covered by `third-party-licenses.config.json`. Licence texts are in `docs/baton/licences/`.

### Runtime

- **Electron** (MIT, Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.), `licences/MIT-electron.txt`.
  Electron's own bundled components (Chromium, Node.js, FFmpeg and others) carry their licences in the `LICENSES.chromium.html`
  file Electron places beside the executable, which the installer keeps.
- **ONNX Runtime**, as `onnxruntime-node` (MIT, Copyright (c) Microsoft Corporation), runs the wake and VAD models.
- **Rust crates** in `native/baton-dictation`: `transcribe-cpp`, `handy-recorder`, `handy-keys` (MIT, handy-computer);
  `enigo` (MIT); `hound` (Apache-2.0); `serde` and `serde_json` (MIT OR Apache-2.0); `tungstenite` (MIT OR Apache-2.0, Alexey Galakhov and Jason Housley), the WebSocket client to his own recogniser; `windows-rs`, the `windows` crate
  (MIT OR Apache-2.0, Microsoft). Texts: `licences/MIT.txt`, `licences/Apache-2.0.txt`.
- **whisper.cpp** (MIT, Copyright (c) Georgi Gerganov) is the fallback speech-to-text binary where it is used.
- **bge-small-en-v1.5** (MIT, Copyright (c) BAAI; int8 ONNX conversion by Xenova, revision `ea104da`) is the server's memory recall model. Text: `licences/MIT.txt`. Its `vocab.txt` (the same BERT uncased vocabulary) is in `apps/server/resources/memory-model`; the model is fetched at build time and checked against a pinned sha256 (`scripts/tessaya/fetch-memory-model.mjs`).

### Models

| File                                                                       | What it is                                                                                                   | Licence                                                                                 | Ships in the installer      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------- |
| `silero_vad.onnx`                                                          | Silero VAD v6.2.3, Silero Team                                                                               | MIT                                                                                     | yes                         |
| `melspectrogram.onnx`                                                      | openWakeWord v0.5.1 feature model                                                                            | CC BY-NC-SA 4.0 (the project's README groups it with its pre-trained models)            | yes                         |
| `embedding_model.onnx`                                                     | openWakeWord v0.5.1 embedding model (the README says it re-implements Google's speech embedding, Apache-2.0) | CC BY-NC-SA 4.0, as above                                                               | yes                         |
| `sebastian.onnx`, `alfred.onnx`, `freya.onnx`, `onyx.onnx`, `tessaya.onnx` | Tessaya's wake models, trained here with openWakeWord's trainer                                              | trained on sets that include non-commercial data (below), so treated as CC BY-NC-SA 4.0 | yes                         |
| Parakeet TDT 0.6B v3 (NVIDIA), GGUF conversion by handy-computer           | speech to text for dictation                                                                                 | CC BY 4.0                                                                               | no, downloaded on first use |
| Pocket TTS (Kyutai) binary and weights; VCTK-derived voices                | spoken replies                                                                                               | MIT (binary); CC BY 4.0 (weights and voices)                                            | no, downloaded on first use |

Texts: `licences/CC-BY-4.0.txt`, `licences/CC-BY-NC-SA-4.0.txt`, `licences/MIT.txt`. A clean-licence wake model for the word
Tessaya is trained on the sets marked "clean" below; the four older words are not.

### Training data for the wake models

CC BY terms require attribution; this is it. The licence of each set is as recorded when it was chosen and should be checked
against the set's own page before a release that relies on it.

| Data                                                                                                                          | Used for                                   | Licence                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| VCTK corpus (University of Edinburgh) voices through Piper                                                                    | positives, old and clean                   | CC BY 4.0                                                                                                          |
| ARU voice set through Piper                                                                                                   | positives, old and clean                   | CC BY 4.0                                                                                                          |
| Alba voice through Piper                                                                                                      | positives, old and clean                   | CC BY 4.0                                                                                                          |
| Cori voice through Piper                                                                                                      | positives, clean                           | public domain                                                                                                      |
| LibriTTS-R (Google) generator                                                                                                 | American top-up positives                  | CC BY 4.0                                                                                                          |
| LibriSpeech (Panayotov et al.), train-clean-100, dev and test-clean                                                           | negative features and validation, clean    | CC BY 4.0                                                                                                          |
| MUSAN (Snyder, Chen, Povey) noise and music                                                                                   | background audio and held-out noise, clean | CC BY 4.0                                                                                                          |
| MIT environmental impulse responses (McDermott lab)                                                                           | room impulses                              | as published by the lab (recorded here as MIT)                                                                     |
| Semaine, jenny_dioco, northern_english_male, southern_english_female voices; AudioSet clips; openWakeWord's ACAV100M features | old path only                              | include non-commercial or per-item terms; the reason the four older wake models are not cleared for commercial use |
| Piper TTS                                                                                                                     | generating the positives                   | MIT (the version used at training time is to be confirmed)                                                         |

### Fonts

Newsreader (roman and italic, variable weight; Copyright 2020 The Newsreader Project Authors), Schibsted Grotesk (variable
weight; Copyright 2023 The Schibsted-Grotesk Project Authors) and Bricolage Grotesque (variable weight; Copyright 2022 The
Bricolage Grotesque Project Authors) are bundled in the window and the pill, SIL Open Font License 1.1, texts in
`licences/OFL-newsreader.txt`, `licences/OFL-schibsted-grotesk.txt` and `licences/OFL-bricolage-grotesque.txt`. The fonts are not sold on their own and keep their names
and licence.
