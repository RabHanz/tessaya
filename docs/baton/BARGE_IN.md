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
| On the R1                                             | keyword (stop phrase or her name) by default; open talk-over per R1       | Bluetooth output: not yet covered (the latency below is the onboard speaker's) |

On a cut-in the voice **ducks to 25% at 40 ms** of his speech and **stops at 120 ms**, well inside 300 ms, and the core listens from the
moment he started (the words since the onset are kept, as for a late wake). If it was only a blip the voice comes back up. Settings, on the
Settings, Voice and wake words: "Headphones or speakers" (on Windows, Automatic reads the playback device's form factor: headphones and headsets are headphones, anything else, a Bluetooth speaker too, is speakers; `outputDevice.ts`) and "Cut in by talking over her (speakers, experimental)".

## On the R1: open talk-over (`packages/baton-voice/src/talkOver.ts`)

The R1 cancels its own echo (firmware 0.3.93: about 40 dB, her residual near -77 dBFS against a -81 floor), so the server
does not subtract anything. It only has to tell his voice from what is left of hers. Firmware 0.3.92's uplink header
(`cmd/voice/upformat {"v":1}`: seq, rx, q, flags) says which of her samples was under the speaker as each mic frame was
heard: `rx - q - L`, with L = 1972 samples (123 ms) on the onboard speaker. The loop keeps her downlink by sample, lines it
up with every frame, learns her level per band and the room's decay (kept per R1 across sessions), and flags a voice that
rises 6 dB over the predicted echo for 128 of 256 ms. A cut also needs Silero to hear speech, the voice to clear the
room's loud moments of the last 3 s by 10 dB (a TV or music already on is not him) and -55 dBFS, or his own level less 18 dB once known, and
her to have sounded for 400 ms (the device's echo cancelling lets a burst through as she starts). Then she stops (flush),
and his turn goes through the usual echo-by-sound and addressing checks and is answered, not held to a stop phrase.

Open mode is per R1: retained `cmd/voice/talkover {"mode":"open"}` (`"keyword"` or empty goes back), or `R1_TALK_OVER=open`
for the loop. Without the header (older firmware) the R1 stays on keyword barge-in.

Measured (`scripts/tessaya/talkover-eval.ts`; his recorded voice, high-passed, mixed in at the R1 mic level):

|                                                    | Detected at -41 dBFS (his usual level)  | Detection p50 / p90 | False stops |
| -------------------------------------------------- | --------------------------------------- | ------------------- | ----------- |
| Real R1 captures, AEC delay 384 (2 x 80 trials)    | 100% / 98.8% (tuning half / check half) | 120-180 / 180 ms    | 0 (4 s)     |
| Simulated R1 chain, 31 min of her, 4 rooms (quiet) | 98.9% (94.7% at -60)                    | 128 / 160 ms        | 0 per hour  |

Through the whole gate (Silero and the room's level), simulated, 12 min of her in a quiet room: 0 false stops, him at -41
and -50 dBFS always heard (p90 180-200 ms), coughs at -30 dBFS never and at -40 two in fifteen. A TV already on through
her reply stops her 15 times an hour at -55 dBFS and 20 at -50, where he is still heard 100% and 88% of the time; music
or a TV that starts while she talks stops her once.

**The real busy room is where it fails.** The 14 Nov 10:40 bench (5:04 of her on the R1 at volume 10, firmware 0.3.93; the
room measured -47 dBFS median and -27 at its 95th percentile, louder than he speaks to her) gave 59.5 false stops an hour
through the whole gate, and him at -41 heard only 30% of the time. So keyword barge-in stays the default: open mode is for
a quiet room until a check of his own voice (his enrolled profile against whoever else is talking) is in the gate.

## How the echo guard hears him (`packages/baton-voice/src/echoGuard.ts`)

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

The CI step in `baton-ci` prints the numbers when the voice core or the guard changes; it does not gate. The R1's level
detector behind the same interface (`bargein-eval.ts --talkover`, 60 s per room) gives 0 false barge-ins but recall 0.19 at
0 dB and 0.57 at +12 dB: without echo cancelling in front of it, a level model is too blunt, so the desktop keeps the echo guard.

## Not done

Real acoustic recordings (speech over TTS playback); a render-loopback reference from the operating system (WASAPI) as an alternative to
the player's own chunks (it would also cover the OS voice, which bypasses the player); WebRTC AEC3 in the sidecar; remembering the learned room
per output device across launches.
