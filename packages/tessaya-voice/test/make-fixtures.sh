#!/usr/bin/env bash
# Regenerate the WAV fixtures with espeak-ng: 16 kHz mono s16, 0.6 s silence
# before, 1.2 s after (so the VAD sees the utterance end).
set -euo pipefail
cd "$(dirname "$0")/fixtures"
make_one() {
  espeak-ng -s 150 -w raw.wav "$2"
  ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 0.6 sil.wav
  ffmpeg -loglevel error -y -i raw.wav -ar 16000 -ac 1 -sample_fmt s16 body.wav
  ffmpeg -loglevel error -y -i sil.wav -i body.wav -i sil.wav -i sil.wav \
    -filter_complex "[0][1][2][3]concat=n=4:v=0:a=1" -ar 16000 -ac 1 -sample_fmt s16 "$1.wav"
}
make_one wake-status "Hey Jarvis, what is VantageOS doing?"
make_one followup "Tell it to run the other test too."
make_one dictate "Hey Jarvis, dictate. Thanks, I will send the revised version tomorrow."
make_one stop-dictating "Stop dictating."
make_one no-wake "What is VantageOS doing?"
rm -f raw.wav sil.wav body.wav
