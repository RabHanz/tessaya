# Barge-in: speaking over Tessaya (2026-11-03)

The Director: "when it is speaking, it's not listening to me at all so I cannot dismiss it." Before this the core muted its ears while she
spoke (`hearingItself`, a 500 ms echo tail) and only a wake word or a stop phrase could get through, unreliably, because over speakers her own
voice is in the microphone.

## What exists now

| Path                                                  | Over speakers                                                             | On headphones                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Wake word, stop phrase                                | as before                                                                 | as before                                                                      |
| Esc, the pill's stop, the hotkey (the pill builder's) | always                                                                    | always                                                                         |
| Talking over her                                      | the echo guard (setting "Cut in by talking over her", **off by default**) | on: the mic cannot hear her, so speech over her voice cuts in                  |
| On the Tessel                                         | keyword (stop phrase or her name) by default; open talk-over per Tessel   | Bluetooth output: not yet covered (the latency below is the onboard speaker's) |

On a cut-in the voice **ducks to 25% at 40 ms** of his speech and **stops at 120 ms**, well inside 300 ms, and the core listens from the
moment he started (the words since the onset are kept, as for a late wake). If it was only a blip the voice comes back up. Settings, on the
Settings, Voice and wake words: "Headphones or speakers" (on Windows, Automatic reads the playback device's form factor: headphones and headsets are headphones, anything else, a Bluetooth speaker too, is speakers; `outputDevice.ts`) and "Cut in by talking over her (speakers, experimental)".

## On the R1: open talk-over (`packages/tessaya-voice/src/talkOver.ts`)

The Tessel cancels its own echo (firmware 0.3.93: about 40 dB, her residual near -77 dBFS against a -81 floor), so the server
does not subtract anything. It only has to tell a voice from what is left of hers, and then whose voice it is.

1. **Hearing a voice over hers.** Firmware 0.3.92's uplink header (`cmd/voice/upformat {"v":1}`: seq, rx, q, flags) says
   which of her samples was under the speaker as each mic frame was heard: `rx - q - L`, with L = 1972 samples (123 ms) on
   the onboard speaker. The loop lines her downlink up with every frame, learns her level per band and the room's decay
   (kept per Tessel across sessions), and flags a voice that rises 6 dB over the predicted echo for 128 of 256 ms, with Silero
   hearing speech, at least -55 dBFS (or his own level less 18 dB once known), once she has sounded for 400 ms (the
   device's echo cancelling lets a burst through as she starts).
2. **A soft pause.** She goes quiet at once (the Tessel's queue is flushed), but her reply is not cancelled.
3. **Whose voice.** From 0.6 s of it, CAM++ compares it with every enrolled profile here (any household member, not only
   him; `memberByVoice` holds the short-clip cut-offs). A member stops her, and their words are answered, not held to a
   stop phrase. Anyone else: she goes on from where she paused (from her sentence's start if the pause ran past 2 s), and
   their words are not answered.

Level is no guide to whose voice it is: a rule that a voice must rise 10 dB over the room's own loud moments kept a TV out,
and kept him out of a busy room three times in four. Open mode is per Tessel (retained `cmd/voice/talkover {"mode":"open"}`,
`"keyword"` or empty goes back, or `TESSEL_TALK_OVER=open`), and it is keyword until someone has a voice profile here, or
without the header (older firmware).

Measured (`scripts/tessaya/talkover-eval.ts`, 14 Nov). His recorded voice is mixed in at the Tessel mic level, and a profile
from his desk-mic clips stands in for his Tessel enrolment. The time is from his first word to the pause (the flush's trip to
the Tessel is on top of it):

|                                                               | False stops | Pauses     | Him at -41 dBFS (two halves) | To the pause p50 / p90 |
| ------------------------------------------------------------- | ----------- | ---------- | ---------------------------- | ---------------------- |
| Real Tessel capture, quiet moment, AEC delay 384              | 0           | 0          | 96.3% / 93.8%                | 180 / 180 ms           |
| Real Tessel bench, busy room (median -47, p95 -27 dBFS), 5:04 | 0 per hour  | 95 an hour | 67.4% / 69.8%                | 240 / 660 ms           |

A pause for a voice that is not the household's lasts 780 ms at the median and 840 ms at p90, before she goes on. The short
clips were calibrated on 30 of his against 109 LibriTTS speakers: at 0.6 s his 2nd percentile scores 0.24 and the others'
95th 0.17. At 1 s his 10th percentile is 0.38 and no other speaker scores above 0.33. In the busy room his own voice is
louder than the room for only part of each clip, and the voice check is what misses him there.

## How the echo guard hears him (`packages/tessaya-voice/src/echoGuard.ts`)

The player hands over each chunk it is about to play and when it will sound. The guard works at 8 kHz: it finds the delay between what is
played and what the mic hears (envelope correlation, 0 to 600 ms), learns the room with a 96 ms adaptive filter (block NLMS), subtracts the
predicted echo, and calls it speech over her when the residual, relative to what is playing, jumps to six times its usual level. It is a
detector, not a cleaner: the recogniser listens after the voice has stopped, when the mic is clean. Until the room is learned (about a second
of her speech) it says nothing and the fallbacks are what is left.

## Measured (synthetic room, `scripts/tessaya/bargein-eval.ts`, 3 rooms x 120 s, deterministic)

Speech-like audio through a room (delay 60 to 200 ms, reverberant tail up to 400 ms), echo and his voice mixed at the mic, confirmation 120 ms.

|                                       | Result                                       | Target  |
| ------------------------------------- | -------------------------------------------- | ------- |
| False barge-ins on her own voice      | **16.7 per 10 minutes** of continuous speech | under 1 |
| Recall when he is 12 dB over the echo | 0.90                                         | 0.9     |
| Recall at +6 dB / 0 dB / -6 dB        | 0.88 / 0.69 / 0.44                           | 0.9     |

**It does not meet the target**, which is why the speaking-over-speakers path is off by default. Trade-offs seen in sweeps (60 s per room): a
stricter threshold cut false barge-ins to 3 per 10 minutes and recall at 0 dB to 0.33. The statistic (residual over reference energy) is not
sharp enough on its own. What would improve it, in order: a longer, frequency-domain filter (better cancellation in reverberant rooms),
coherence between mic and reference, a second check with the speech detector on the residual, and the real device's delay and gain. The
harness is synthetic: it proves the plumbing and gives a number to beat; the acoustic test waits for real speakers (the laptop's are broken).

The CI step in `baton-ci` prints the numbers when the voice core or the guard changes; it does not gate. The Tessel's level
detector behind the same interface (`bargein-eval.ts --talkover`, 60 s per room) gives 0 false barge-ins but recall 0.19 at
0 dB and 0.57 at +12 dB: without echo cancelling in front of it, a level model is too blunt, so the desktop keeps the echo guard.

## Not done

Real acoustic recordings (speech over TTS playback); a render-loopback reference from the operating system (WASAPI) as an alternative to
the player's own chunks (it would also cover the OS voice, which bypasses the player); WebRTC AEC3 in the sidecar; remembering the learned room
per output device across launches.
