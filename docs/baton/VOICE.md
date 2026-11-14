# Tessaya Voice Service (`packages/tessaya-voice`)

The §12.2 pipeline: **audio → wake → VAD → STT → mode machine → router → the
existing intent path → destination → spoken reply**. The desktop owns the
microphone, tray and HUD (`apps/desktop/src/tessaya/voice`, D65/D66); this
package is the core it plugs in through `makeCore`.

## Pieces

| File                  | What it is                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `types.ts`            | `AudioInputProvider`, `WakeProvider`, `VadProvider`, `SttProvider`, `TtsProvider`, and the desktop's `VoiceCore` seam (same shapes as `voiceTypes.ts`) |
| `modeMachine.ts`      | §12.3 as a pure reducer: sleeping → command window → conversation → base; direct-session; dictation; spoken confirmations                              |
| `router.ts`           | Effects → `fabric.intent.resolve` / `fabric.intent.run` with high-risk checks before and after, §14 destinations, dictation kept local                 |
| `core.ts`             | Frames → wake/VAD segmentation → STT → machine → router → TTS; implements `VoiceCore` plus snapshot and an event stream                                |
| `providers/onnx.ts`   | openWakeWord (any number of words at once) and Silero VAD on onnxruntime-node                                                                          |
| `providers/speech.ts` | whisper.cpp (`whisper-cli`), OS TTS, WAV encode/decode                                                                                                 |

Versions, licences and hashes: `docs/baton/research/voice-stack-2026-10-26.md`.

## Modes (§12.3)

- **sleeping**: only the wake detector runs. Speech without a wake is ignored.
- **command_window** (8 s): opened by a wake word or the tray/hotkey `wake`. The wake
  phrase and the command can be said together.
- **conversation** (30 s, extended by every command): follow-ups need no wake and
  inherit the target the last command touched. "That's all", "thanks" or the timeout
  ends it. The window does not run out while Tessaya is talking (D124).
- **direct_session**: the resting mode when the toggle is on. Plain speech is a user
  message to the **focused** session (only a focused one; "most recent" is not enough).
  A wake still opens a command window.
- **dictation**: "dictate" or "I want to dictate" (optionally with text in the same breath)
  enters it, bound to the window that has the keyboard then. Everything said is text, the wake words and
  "Tessaya, stop" included, and it waits in a buffer (on disk too) rather than being typed as it comes. Only
  "stop dictation" (or "stop dictating"), the pill's ✓, ✕ or Esc ends it, back into the conversation with no
  wake word (D125). The stop phrase and ✓ paste the buffer in one go into that window, brought forward first;
  ✕ and Esc throw it away. The pill shows his words as they are recognised and, once the clean text is pasted,
  plays the clean-up over them: the cut words grey and are struck, then one motion carries the kept words into the
  clean paragraph (`pillIsland.ts`, Settings → Dictation → Show words as you speak). The paste never waits for it.
  With Pill style "In the text box when possible" (opt-in; the default is the pill) the words are drawn as ghost text at the field's caret instead
  (`pillGhost.ts`; the sidecar's `caret_at`, never for a password or secret field), the cleanup plays there and
  the paste lands as the ghost goes (3 s at most); any key or click pastes at once. No caret, and the pill shows them.
  If the window is gone, the text goes on the clipboard and the pill says so. Dictated text never reaches the
  environment. The hold key works the same way: release is ✓, Esc is ✕.

While Tessaya speaks, a short stop phrase (stop, quiet, enough, that's enough, cancel, shut up)
is heard with no wake word (D122). Nothing else said over its voice is acted on.

## Safety

- The §24.1 high-risk patterns (`highRiskSubject`) are checked on the transcript before
  anything leaves the client, and the resolution's `risk` is checked again on the way back.
  High risk is refused by voice, full stop.
- Medium risk (start/resume work, answering a gate) is read back and needs a **later,
  separate** "confirm" within 15 s. The wake phrase is stripped before that check, so a
  wake word can never be the yes. The command is re-resolved at run time, and each
  token works once.

## Building a core (in-process)

```ts
import {
  createVoiceCore,
  createVoiceRouter,
  createOpenWakeWordProvider,
  createSileroVad,
  createWhisperCppStt,
  createOsTts,
} from "@t3tools/tessaya-voice";

const core = createVoiceCore({
  wake: await createOpenWakeWordProvider({
    melspectrogram,
    embedding,
    wakes: [{ word: "Alfred", path: alfred, threshold: 0.9 }],
  }),
  vad: await createSileroVad(sileroPath),
  stt: createWhisperCppStt({
    binary: whisperCli,
    model: ggmlBaseEn,
    vocabulary: () => projectNames,
  }),
  tts: createOsTts(process.platform),
  router: createVoiceRouter(intentClient), // omit to route utterances yourself
});
```

The desktop builds its core in `apps/desktop/src/tessaya/voice/desktopVoiceCore.ts` and feeds it audio
itself; `core.setContext(bus)` pushes the context bus state (§14 ladder, dictation target).

`intentClient` (`VoiceIntentClient`) is four calls the desktop already has: `resolve`
and `run` (the `fabric.intent.*` RPCs, so grammar → learned → model reading and the
server's gates all apply), `sendToSession` (direct-session), and `insertText` (§18).

There is deliberately no loopback HTTP port: a web page can reach localhost, and the
desktop main process imports this package directly.

## On the desktop

`apps/desktop/src/tessaya/voice`. Windows first (D97, D106): macOS and Linux are queued, and there the
tray says so and no microphone opens. Everything audio goes through
`baton-dictation.exe` (`native/baton-dictation`, D97): `serve` over JSON lines for the keys, recording,
Parakeet and paste; `record` piped in as the wake path's microphone.

| Setting in `<state dir>/fabric-voice.json` | Default                                                                                                                        | Also in the tray        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `dictation`                                | `baton`; `wispr` holds no key                                                                                                  | Dictation               |
| `holdKey`, `toggleKey`                     | `Alt+Win`, `Ctrl+Alt+Shift+Space`                                                                                              |                         |
| `paste`                                    | `ctrl_v`; `shift_insert`, `ctrl_shift_v`                                                                                       |                         |
| `wakeWords`                                | Sebastian, Alfred, Freya on; Onyx off; each with a threshold                                                                   | Wake words              |
| `speechModel`                              | `v3`; `fast` is English only, 3.4x quicker                                                                                     | Dictation               |
| `dictationCleanup`                         | `local`; `claude`, `off`. Follows the one `dictationCleanup` server setting (below)                                            | Dictation, Clean-up     |
| `cleanupModel`, `claudeBinary`             | `haiku`, `claude`                                                                                                              |                         |
| `appModes`                                 | `{}`; his writing mode per app, by exe                                                                                         | Dictation, Writing mode |
| `micOrder`, `pinnedLabel`                  | AT2020, DJI, system (D99)                                                                                                      | Microphone              |
| `enabled`                                  | `false`: listening is opt-in                                                                                                   | Always listening        |
| `sounds`                                   | `true`                                                                                                                         | Sounds                  |
| `pillAtRest`                               | `false`                                                                                                                        | Pill                    |
| `pillEdge`                                 | `bottom`; `top`                                                                                                                | Pill                    |
| `pronounce`                                | `{}`; his own word → how to say it (`{"Kiro": "Keer-oh"}`), over the built-in respellings in `tessaya-shared/src/pronounce.ts` |                         |

Tray → Edit voice settings opens the file; saved edits apply within two seconds. Dictation works with
"Always listening" off. The wake, VAD and feature models ship with the app. Parakeet (740 MB,
hash-checked on disk) downloads into `<state dir>/voice/models` only when asked: Tray → Dictation →
Download speech model, a first press of Ctrl+Alt+Shift+F8, or ticking "Always listening". The hold and
toggle keys exist only after that. Ctrl+Alt+Shift+F8 toggles dictation for Airdeck.

Text pastes only into the window focused when recording began. If that changed, or nothing read the
clipboard, the pill says so and the text stays under Tray → Dictation → Copy last dictation. Esc
cancels a recording; an hour stops it and the text is kept, not pasted.

## Clean-up and writing modes (D105)

Text goes through `packages/tessaya-shared/src/dictationCleanup.ts`, hold key and wake-word dictation alike.
Modes: default, chat, email, formal document, code and terminal, notes, raw. Chosen from the foreground app,
then a browser's title, and his tray choice for that app outranks both. Default mode makes sentences make
sense and changes nothing else; dictated text is text, never instructions.
At the claude level every dictation of 8 words or more goes to the model, tidy or not: measured against Wispr's final
text on 8,266 of his own dictations, the model brought even well-punctuated text closer, and the local rules alone
cannot (DICT-FID). Shorter ones are pasted at once unless he corrected himself in them.

The level follows the one `dictationCleanup` server setting (`packages/contracts/src/dictationCleanup.ts`), which every
environment, browser and the phone share: `BatonDesktopSettings` on this machine's server hands the desktop the level
the setting asks for (`claude` is on; `local` and `off` are both off) and turns his own change on the desktop, or an
agent's through `tessaya_desktop_settings`, into the setting. With the saved Anthropic key the model is the setting's
when it is a Claude model; the `claude` CLI fallback still uses `cleanupModel`.

The dictionary is `<state dir>/voice/dictionary.json`, a list of `{phrase, replacement}` he can edit. If it is
missing, Wispr's table is read once, read-only.

## Measuring it

`scripts/tessaya/voice-lab`, all headless and nothing pasted: `whisper_lab.py` (quiet and whisper-like audio,
`make` then `score`), `replay_lab.py` (release to text at real-time pace through `BATON_FAKE_MIC`),
`cleanup-lab.ts` with `cleanup-cases.ts`, bundled by `bundle-cleanup.sh` (the rewrite on written cases and on
his clips, aggregates only; `names` runs the app's whole path on Parakeet text kept outside the repo, for the
per-name score against his Wispr finals). One CPU-heavy laptop job at a time: a speed figure taken beside other work is void.
Quiet-speech numbers are in D104.

`scripts/tessaya/voice-lab/voice-lab.ps1` on the laptop: `replay` and `dictation` use his stored Wispr
clips and need nothing from him; `samples` has him say each word 30 times; `ambient` counts false wakes
for hours and keeps no audio; `report` prints every word on every mic against the targets (under 0.5
false wakes an hour, under 5% misses). Results stay in `D:\\baton-voice-lab`.

## Tests

- `src/modeMachine.test.ts`, `src/router.test.ts`: unit tests, no models.
- `test/e2e.test.ts`: espeak-ng WAV fixtures (`test/make-fixtures.sh`) through the real
  openWakeWord → Silero → whisper.cpp → grammar. Skipped unless
  `BATON_VOICE_MODELS` and `BATON_WHISPER_CLI` are set; `BATON_VOICE_REPORT=<file>`
  writes the accuracy report.

Result on 2026-10-26 (Linux box, ggml-base.en, espeak-ng voice):

```
wake-status: wakes=1 heard="What is VantageOS doing?"
followup: wakes=0 heard="Tell it to run the other test too."
dictate: heard="Hey Jarvis, dictate. Thanks, I will send the revised version tomorrow." mode=dictation
stop-dictating: heard="Stop dictating." mode=sleeping
no-wake: wakes=0 transcripts=0
word accuracy: 1.00 1.00 1.00 1.00 mean=1.00
```

Wake: 1 of 1 true wake detected, 0 false wakes on the no-wake fixture. Four synthetic
clips from one synthetic voice is a smoke test. It says nothing yet about the DJI mic,
room noise or the Director's own voice.

## The pill and speech

The HUD is gone: at rest nothing is on screen. The pill (D112) shows the state, the wake word, the
routing target and what was heard. It stays while a window is open and says so when the wake word
is needed again (D124). With several screens it shows on the screen where the work is: the target window's
(the one he was in at the wake, or dictation's), else the cursor's, else the primary, picked as it appears and when
that target changes, never as the cursor moves (`pickScreen`). His moved place is one fraction of the work area, so
it lands in the same spot on whichever screen that is. Every turn is logged to `voice-turns.ndjson` in the app's log folder (D120).
Speech plays from a hidden page (`voicePlayer.ts`), one path for
every platform, and the pill follows the voice's real level.
