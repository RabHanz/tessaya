"""False wakes per hour, measured on public audio with nobody trying to wake anything.

Replays speech that is not a wake attempt through the shipped wake models exactly as the app does
(80 ms chunks, each word's own threshold, one fire silences every word for 12 chunks) and reports false wakes
per hour per word, in four rooms:

  clean   LibriSpeech dev-clean and test-clean read speech (CC BY 4.0, openslr.org/12)
  tv      the same speech under other people talking (more LibriSpeech, 0 to 8 dB) and room noise, as a TV
          or a video playing in the room
  bleed   the same speech low-passed, attenuated and run through a room impulse response (MIT, davidscripka),
          as speaker bleed into a microphone
  near    near-miss sentences (scripts/tessaya/wake-train/near_misses.txt: Alfonso, Sabrina, Sebastopol, Tessa...)
          spoken by espeak-ng at two speeds, when --near is given; counted as fires, not per hour
  noise   DEMAND room noise alone (CC BY 4.0, zenodo.org/records/1227121): kitchen, living room, car, street

Everything is public and licence-clean: no recording of a person is used. Clips of every false fire are saved
as negative samples for the next training round. A word whose threshold gives more than the target
(default 1 per hour) gets a recommended threshold from the sweep.

  python false_wakes.py --models native/baton-dictation/models --data data --out out [--hours 2]
"""
import argparse
import json
import pathlib
import random

import numpy as np
import scipy.io.wavfile
import soundfile
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt

CHUNK = 1280  # 80 ms at 16 kHz, what the app feeds the scorer
COOLDOWN = 12  # chunks all words are silent after one fires (streamingScorer)
RATE = 16000
# The one wake table (packages/baton-shared/src/wakeWords.json); D98's measured threshold where it differs.
_TABLE = json.loads((pathlib.Path(__file__).resolve().parents[3] / "packages/baton-shared/src/wakeWords.json").read_text())
THRESHOLDS = {w["word"].lower(): w.get("measured", w["threshold"]) for w in _TABLE["words"]}
SWEEP = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.98, 0.99, 0.995]


def load(path):
    audio, rate = soundfile.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    return resample_poly(audio, RATE, rate) if rate != RATE else audio


def rms(x):
    return float(np.sqrt(np.mean(x**2)) + 1e-9)


def room(kind, speech, noise_files, rirs, rng, talkers):
    if kind == "clean":
        return speech
    if kind == "tv":
        def fit(x):
            return np.tile(x, int(np.ceil(len(speech) / max(len(x), 1))))[: len(speech)]

        talk = fit(load(rng.choice(talkers)))
        noise = fit(load(rng.choice(noise_files)))
        mixed = speech + talk * (rms(speech) / (10 ** (rng.uniform(0, 8) / 20) * rms(talk)))
        return mixed + noise * (rms(speech) / (10 ** (10 / 20) * rms(noise)))
    if kind == "bleed":
        sos = butter(4, 4000, btype="low", fs=RATE, output="sos")
        h = load(rng.choice(rirs))
        h = h / (np.abs(h).max() + 1e-9)
        wet = fftconvolve(sosfilt(sos, speech), h)[: len(speech)]
        wet = wet * 10 ** (-25 / 20) / rms(wet) * rms(speech)
        return wet + np.random.default_rng(1).normal(0, rms(wet) * 0.1, len(wet))
    raise ValueError(kind)


def events(model, audio, words, thresholds, keep):
    """Fires as the app counts them: [(word, chunk index, score)]."""
    model.reset()
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    out, cooldown = [], 0
    for i in range(len(pcm) // CHUNK):
        scores = model.predict(pcm[i * CHUNK : (i + 1) * CHUNK])
        if cooldown > 0:
            cooldown -= 1
            continue
        fired = [(w, scores[w]) for w in words if scores[w] >= keep.get(w, thresholds[w])]
        if fired:
            w, s = max(fired, key=lambda p: p[1] / thresholds[p[0]])
            out.append((w, i, float(s)))
            cooldown = COOLDOWN
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--near", help="a text file of near-miss sentences, one per line (needs espeak-ng)")
    ap.add_argument("--hours", type=float, default=2.0, help="of audio per room")
    ap.add_argument("--target", type=float, default=1.0, help="false wakes per hour allowed")
    args = ap.parse_args()
    rng = random.Random(7)
    out = pathlib.Path(args.out)
    (out / "negatives").mkdir(parents=True, exist_ok=True)
    models = pathlib.Path(args.models)
    words = [w for w in THRESHOLDS if (models / f"{w}.onnx").exists()]
    words += sorted(p.stem for p in models.glob("*.onnx") if p.stem not in THRESHOLDS and p.stem not in
                    ("embedding_model", "melspectrogram", "silero_vad"))
    thresholds = {**{w: 0.9 for w in words}, **THRESHOLDS}

    from openwakeword.model import Model

    model = Model(
        wakeword_models=[str(models / f"{w}.onnx") for w in words],
        inference_framework="onnx",
        melspec_model_path=str(models / "melspectrogram.onnx"),
        embedding_model_path=str(models / "embedding_model.onnx"),
    )
    data = pathlib.Path(args.data)
    speech = sorted((data / "librispeech").rglob("*.flac"))
    noise = sorted((data / "demand").rglob("*.wav"))
    rirs = sorted((data / "mit_rirs").rglob("*.wav"))
    rng.shuffle(speech)
    rng.shuffle(noise)
    rooms = {}
    near_dir = None
    if args.near:
        import subprocess
        near_dir = out / "near-audio"
        near_dir.mkdir(exist_ok=True)
        for i, line in enumerate(pathlib.Path(args.near).read_text().splitlines()):
            for speed in (140, 175):
                subprocess.run(["espeak-ng", "-v", "en-gb", "-s", str(speed), "-w", str(near_dir / f"{i:02d}-{speed}.wav"), line], check=True)
    for kind in ("clean", "tv", "bleed", "near", "noise"):
        if kind == "near" and near_dir is None:
            continue
        budget, seconds, found = (1e9 if kind == "near" else args.hours * 3600), 0.0, []
        pool = noise if kind == "noise" else sorted(near_dir.glob("*.wav")) if kind == "near" else speech
        for path in pool:
            if seconds >= budget:
                break
            audio = load(path)
            if kind not in ("noise", "near"):
                audio = room(kind, audio, noise, rirs, rng, speech)
            # every score is kept at the lowest threshold of the sweep, then counted at each
            low = {w: SWEEP[0] for w in words}
            for word, chunk, score in events(model, audio, words, thresholds, low):
                found.append((word, score, path.name, chunk))
                if score >= thresholds[word]:
                    start = max(0, chunk * CHUNK - 2 * RATE)
                    clip = (np.clip(audio[start : start + 3 * RATE], -1, 1) * 32767).astype(np.int16)
                    d = out / "negatives" / word
                    d.mkdir(exist_ok=True)
                    scipy.io.wavfile.write(d / f"{kind}-{path.stem}-{chunk}.wav", RATE, clip)
            seconds += len(audio) / RATE
        rooms[kind] = {"hours": seconds / 3600, "fires": found}
        print(kind, f"{seconds / 3600:.2f} h", len(found), "candidate fires", flush=True)

    total_h = sum(r["hours"] for k, r in rooms.items() if k != "near")
    report = {"hours": total_h, "target_per_hour": args.target, "words": {}}
    for w in words:
        rows = {}
        for kind, r in rooms.items():
            fires = [f for f in r["fires"] if f[0] == w]
            rows[kind] = {
                "hours": r["hours"],
                "now": sum(f[1] >= thresholds[w] for f in fires) / r["hours"],
                "sweep": {str(t): sum(f[1] >= t for f in fires) / r["hours"] for t in SWEEP},
            }
        every = [f for k, r in rooms.items() if k != "near" for f in r["fires"] if f[0] == w]
        per_hour = lambda t: sum(f[1] >= t for f in every) / total_h
        ok = [t for t in SWEEP + [0.999] if per_hour(t) <= args.target]
        report["words"][w] = {
            "threshold": thresholds[w],
            "false_wakes_per_hour_now": per_hour(thresholds[w]),
            "recommended_threshold": min(ok) if ok else None,
            "rooms": rows,
        }
    (out / "report.json").write_text(json.dumps(report, indent=2))
    lines = [f"False wakes per hour over {total_h:.1f} h of public audio (target at most {args.target}):", "",
             "| word | threshold | " + " | ".join(k + (" (fires)" if k == "near" else "/h") for k in rooms) + " | all /h | recommended |",
             "|---" * (len(rooms) + 4) + "|"]
    for w, d in report["words"].items():
        r = d["rooms"]
        lines.append(
            f"| {w} | {d['threshold']} | " + " | ".join(
                str(round(r[k]["now"] * r[k]["hours"])) if k == "near" else f"{r[k]['now']:.2f}" for k in rooms
            )
            + f" | {d['false_wakes_per_hour_now']:.2f} | {d['recommended_threshold']} |"
        )
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
