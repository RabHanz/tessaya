"""Voice ID calibration on the Director's Wispr export (private Kaggle run; outputs scores and rates, never audio or
embeddings of his voice).

  python speaker-calib.py MODEL [MODEL ...]   (a private Kaggle GPU kernel, with him/ beside it) writes $OUT/<model>.json (metrics) and $OUT/<model>-scores.npz

His data: him/*.flac + him/meta.jsonl (id, at, mic, seconds). Split by date: enrolment from before SPLIT, held out
from SPLIT on. The product enrolment is replicated: pickSeedClips (3-30 s, newest first, one per mic and day in turn,
60 clips), whole-clip embeddings, then enrol()'s median-MAD outlier drop.

Impostors: LibriSpeech test-clean/test-other/dev-other, VoxCeleb1 test, EdACC test (accents, L1 labels), Common Voice
17 en test (accents), and Edge TTS voices of South Asian and British English. Cohort for AS-norm: LibriSpeech
dev-clean and EdACC validation (disjoint from the impostors).
"""
import asyncio, io, json, os, pathlib, random, sys, tarfile, time

import numpy as np
import requests
import soundfile
from scipy.signal import resample_poly

RATE = 16000
OUT = pathlib.Path(os.environ.get("OUT", "out"))
DATA = pathlib.Path("/tmp/vdata")
DATA.mkdir(exist_ok=True)
SPLIT = "2026-11-01"
DRY = os.environ.get("DRY") == "1"
CAP = {"w2": 16000, "w4": 12000, "turn": 5000} if not DRY else {"w2": 300, "w4": 300, "turn": 300}
SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"
MODELS = {
    "campplus": (SHERPA + "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx", "povey"),
    "eres2net": (SHERPA + "3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx", "povey"),
    "wespeaker-campplus-LM": (SHERPA + "wespeaker_en_voxceleb_CAM++_LM.onnx", "hamming"),
    "resnet34-LM": (SHERPA + "wespeaker_en_voxceleb_resnet34_LM.onnx", "hamming"),
    "resnet152-LM": (SHERPA + "wespeaker_en_voxceleb_resnet152_LM.onnx", "hamming"),
    "wavlm-sv": ("microsoft/wavlm-base-plus-sv", None),
}
VOX = "https://huggingface.co/api/datasets/asahi417/voxceleb1-test-split/parquet/default/test/{}.parquet"
EDACC = "https://huggingface.co/api/datasets/edinburghcstr/edacc/parquet/default/{}/{}.parquet"
CV = "https://huggingface.co/datasets/fsicoli/common_voice_17_0/resolve/main/"
rng = random.Random(7)
T0 = time.time()


def stamp(what):
    print(f"[{time.time() - T0:.0f} s] {what}", flush=True)


def mono16(a, r):
    a = a.mean(axis=1) if a.ndim == 2 else a
    return (resample_poly(a, RATE, r) if r != RATE else a).astype(np.float32)


def load(src):
    try:
        a, r = soundfile.read(src if isinstance(src, (str, pathlib.Path)) else io.BytesIO(src), dtype="float32", always_2d=True)
        return mono16(a, r)
    except Exception:
        return decode_av(open(src, "rb").read() if isinstance(src, (str, pathlib.Path)) else src)


def decode_av(b):
    try:
        import av
    except ImportError:
        import subprocess
        pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", str(RATE), "pipe:1"],
                             input=b, capture_output=True, check=True).stdout
        return np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
    c = av.open(io.BytesIO(b))
    rs = av.AudioResampler(format="flt", layout="mono", rate=RATE)
    out = [f.to_ndarray().ravel() for fr in c.decode(audio=0) for f in rs.resample(fr)]
    return np.concatenate(out).astype(np.float32) if out else np.zeros(0, np.float32)


def load_any(b):
    return load(b)


def rms(x):
    return float(np.sqrt(np.mean(x ** 2)) + 1e-9)


QUIET = 330 / 32768  # the product's speech-window floor (about -40 dBFS)


def windows(a, L, cap=None):
    n = int(L * RATE)
    out = [a[s : s + n] for s in range(0, len(a) - n + 1, n) if rms(a[s : s + n]) >= QUIET]
    return out[:cap] if cap else out


def get(url, path):
    if not path.exists():
        with requests.get(url, stream=True, timeout=300) as r, open(path, "wb") as f:
            r.raise_for_status()
            for c in r.iter_content(1 << 22):
                f.write(c)
    return path


# ---- his data ----------------------------------------------------------------------------------------------------
def his():
    meta = [json.loads(l) for l in open("him/meta.jsonl")]
    for m in meta:
        m["day"] = m["at"][:10]
    return meta


def pick_seed(rows, limit=60):
    """pickSeedClips from speakerEnrolment.ts."""
    rows = sorted((r for r in rows if 3 <= r["seconds"] <= 30), key=lambda r: r["at"], reverse=True)
    buckets = {}
    for r in rows:
        buckets.setdefault(f"{r['mic']}|{r['day']}", []).append(r)
    lists, picked, rnd = list(buckets.values()), [], 0
    while len(picked) < limit and any(len(l) > rnd for l in lists):
        for l in lists:
            if rnd < len(l) and len(picked) < limit:
                picked.append(l[rnd])
        rnd += 1
    return picked


def enrol(vs, min_samples=3):
    """enrol() from speaker.ts: drop vectors below median - 3 * max(MAD, 0.02) of cosine to the first mean."""
    if len(vs) < min_samples:
        return None
    V = np.stack([v / np.linalg.norm(v) for v in vs])
    m = V.mean(0)
    m /= np.linalg.norm(m)
    s = V @ m
    med = np.sort(s)[len(s) // 2]
    mad = np.sort(np.abs(s - med))[len(s) // 2]
    keep = V[s >= med - 3 * max(mad, 0.02)]
    c = keep.mean(0)
    return c / np.linalg.norm(c), len(keep)


# ---- impostors ---------------------------------------------------------------------------------------------------
def libri(part):
    root = DATA / "libri"
    if not (root / "LibriSpeech" / part).exists():
        root.mkdir(exist_ok=True)
        r = requests.get(f"https://openslr.elda.org/resources/12/{part}.tar.gz", stream=True, timeout=300)
        with tarfile.open(fileobj=r.raw, mode="r|gz") as t:
            t.extractall(root, filter="data")
    for line in (root / "LibriSpeech" / "SPEAKERS.TXT").read_text().splitlines():
        if not line.startswith(";") and "|" in line:
            sid, sex = [x.strip() for x in line.split("|")[:2]]
            GENDER[f"libri-{part}-{sid}"] = {"M": "male", "F": "female"}.get(sex, "")
    by = {}
    for f in sorted((root / "LibriSpeech" / part).rglob("*.flac")):
        by.setdefault(f"libri-{part}-{f.parts[-3]}", []).append(f)
    return by


def parquet_rows(url, path, cols):
    import pyarrow.parquet as pq
    return pq.read_table(get(url, path), columns=cols).to_pylist()


VIDEO = {}
GENDER = {}


def voxceleb():
    out = {}
    for i in range(3):
        for x in parquet_rows(VOX.format(i), DATA / f"vox{i}.parquet", ["audio", "speaker_id", "id"]):
            out.setdefault(f"vox-{x['speaker_id']}", []).append(x["audio"]["bytes"])
            VIDEO.setdefault(f"vox-{x['speaker_id']}", []).append(x["id"].replace("+", "/").split("/")[1] if "/" in x["id"].replace("+", "/") else x["id"])
    return out


def edacc(split, n):
    out, tags = {}, {}
    for i in range(n):
        try:
            rows = parquet_rows(EDACC.format(split, i), DATA / f"edacc-{split}{i}.parquet", ["audio", "speaker", "l1", "accent", "gender"])
        except Exception as e:
            print("edacc", split, i, e, flush=True)
            continue
        for x in rows:
            k = f"edacc-{x['speaker']}"
            GENDER[k] = x.get("gender") or ""
            out.setdefault(k, []).append(x["audio"]["bytes"])
            tags[k] = f"{x['l1']}|{x['accent']}"
    return out, tags


def commonvoice():
    import csv
    tsv = get(CV + "transcript/en/test.tsv", DATA / "cv-test.tsv")
    acc = {}
    with open(tsv, newline="") as f:
        for r in csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            acc[r["path"]] = (r["client_id"], r.get("accents") or "")
    out, tags = {}, {}
    with tarfile.open(get(CV + "audio/en/test/en_test_0.tar", DATA / "cv0.tar")) as t:
        for m in t:
            name = m.name.split("/")[-1]
            if name in acc:
                cid, a = acc[name]
                k = f"cv-{cid[:16]}"
                if len(out.get(k, [])) < 6:
                    out.setdefault(k, []).append(t.extractfile(m).read())
                    tags[k] = a
    return out, tags


SENTENCES = [
    "Can you check whether the build finished, and tell me what failed?",
    "Please book the meeting for half past ten on Thursday, and remind me the day before.",
    "Open the last thread I was working on and summarise where we left it.",
    "I'm going to the shop now, so pause everything until I'm back.",
    "Send the invoice to the accountant and copy me in on the email.",
    "What did the Director say about the voice match this morning?",
    "Turn off the lights in the living room and lock the front door.",
    "Read me the three most important messages from today.",
    "Yes, go ahead with that, but keep a backup of the old version first.",
    "Tessaya, stop what you're doing and listen to me for a second.",
    "I think the problem is in the server, not the client, so start there.",
    "Remind me to call my brother this evening after dinner.",
]


async def _tts(voice, text, path):
    import edge_tts
    await edge_tts.Communicate(text, voice).save(str(path))


TAGS = {}


def tts_voices():
    try:
        import edge_tts
        vs = asyncio.run(edge_tts.list_voices())
    except Exception as e:
        print("tts list failed", e, flush=True)
        return {}, {}
    pick = [v["ShortName"] for v in vs if v["Locale"] in ("en-PK", "en-IN", "en-GB")]
    out, tags = {}, {}
    for v in pick:
        for i, s in enumerate(SENTENCES):
            p = DATA / f"tts-{v}-{i}.mp3"
            try:
                if not p.exists():
                    asyncio.run(_tts(v, s, p))
                out.setdefault(f"tts-{v}", []).append(p.read_bytes())
            except Exception as e:
                print("tts", v, e, flush=True)
                break
        tags[f"tts-{v}"] = v
    return out, tags


# ---- models ------------------------------------------------------------------------------------------------------
_MODEL = None


GPU = False


def init(name):
    global _MODEL, GPU
    import torch
    torch.set_num_threads(1)
    GPU = torch.cuda.is_available()
    dev = "cuda" if GPU else "cpu"
    url, window = MODELS[name]
    if window is None:
        from transformers import AutoFeatureExtractor, WavLMForXVector
        fe = AutoFeatureExtractor.from_pretrained(url)
        m = WavLMForXVector.from_pretrained(url).eval().to(dev)

        def emb(x):
            with torch.no_grad():
                i = fe(x, sampling_rate=RATE, return_tensors="pt")
                return m(**{k: v.to(dev) for k, v in i.items()}).embeddings[0].cpu().numpy()
        _MODEL = emb
        return
    import onnxruntime as ort
    import torchaudio.compliance.kaldi as kaldi
    if GPU and hasattr(ort, "preload_dlls"):
        ort.preload_dlls()
    so = ort.SessionOptions()
    so.intra_op_num_threads = so.inter_op_num_threads = 1
    prov = (["CUDAExecutionProvider"] if GPU else []) + ["CPUExecutionProvider"]
    sess = ort.InferenceSession(f"/tmp/{name}.onnx", so, providers=prov)
    print(name, "providers", sess.get_providers(), flush=True)

    def emb(x):
        f = kaldi.fbank(torch.from_numpy(x)[None].to(dev) * 32768, num_mel_bins=80, frame_length=25, frame_shift=10,
                        dither=0.0, sample_frequency=RATE, window_type=window)
        f = (f - f.mean(0)).cpu().numpy()[None]
        return sess.run(None, {sess.get_inputs()[0].name: f})[0][0].astype(np.float32)
    _MODEL = emb


def embed_one(x):
    e = _MODEL(np.ascontiguousarray(x[: 30 * RATE], dtype=np.float32))
    return e / (np.linalg.norm(e) + 1e-9)


def embed(pool, xs):
    if not xs:
        return np.zeros((0, 1), np.float32)
    return np.stack([embed_one(x) for x in xs] if pool is None else pool.map(embed_one, xs, chunksize=8))


# ---- metrics -----------------------------------------------------------------------------------------------------
def curve(tgt, non):
    tgt, non = np.sort(tgt), np.sort(non)
    th = np.unique(np.concatenate([tgt, non]))
    frr = np.searchsorted(tgt, th, side="left") / len(tgt)
    far = 1 - np.searchsorted(non, th, side="left") / len(non)
    return th, frr, far


def summary(tgt, non):
    th, frr, far = curve(tgt, non)
    i = np.argmin(np.abs(frr - far))
    out = {"n_target": int(len(tgt)), "n_impostor": int(len(non)), "eer": round(float((frr[i] + far[i]) / 2), 4),
           "thr_eer": round(float(th[i]), 4)}
    for f in (0.001, 0.0001):
        ok = far <= f
        j = np.argmin(np.where(ok, frr, 9))
        out[f"frr_at_far{f*100:g}%"] = round(float(frr[j]), 4) if ok.any() else None
        out[f"thr_far{f*100:g}%"] = round(float(th[j]), 4) if ok.any() else None
    for r in (0.01, 0.02, 0.05):
        ok = frr <= r
        j = np.argmin(np.where(ok, far, 9))
        out[f"far_at_frr{r*100:g}%"] = round(float(far[j]), 5) if ok.any() else None
        out[f"thr_frr{r*100:g}%"] = round(float(th[j]), 4) if ok.any() else None
    return out


def asnorm(raw, e_enrol, e_test, cohort, k=100):
    ce = np.sort(e_enrol @ cohort.T)[-k:]
    ct = np.sort(e_test @ cohort.T, axis=1)[:, -k:]
    return 0.5 * ((raw - ce.mean()) / ce.std() + (raw - ct.mean(1)) / ct.std(1))


# ---- general users ---------------------------------------------------------------------------------------------
ENROL_S = 60
GRNG = random.Random(5)


def general_items(srcs):
    """Other people enrolled the way he is: about 60 s of their own speech (VoxCeleb across videos), tested on the rest."""
    out = {"spk": [], "tag": [], "enrol": [], "test": {"w2": [], "w4": [], "turn": []}}
    for s in sorted(k for k in srcs if k.startswith(("vox-", "edacc-", "libri-test"))):
        utts = list(range(len(srcs[s])))
        if s in VIDEO:  # round-robin over videos, so enrolment and test are different sessions where possible
            utts = sorted(utts, key=lambda i: VIDEO[s][i])
        audio = [load_any(srcs[s][i]) if isinstance(srcs[s][i], bytes) else load(srcs[s][i]) for i in utts]
        total = sum(len(a) for a in audio) / RATE
        if total < ENROL_S + 40:
            continue
        enrol, got, k = [], 0.0, 0
        while got < ENROL_S and k < len(audio):
            enrol.append(audio[k][: 30 * RATE]); got += len(audio[k]) / RATE; k += 1
        rest = audio[k:]
        n = len(out["spk"])
        for a in rest[:12]:
            out["test"]["w2"] += [(n, w) for w in windows(a, 2, 3)]
            out["test"]["w4"] += [(n, w) for w in windows(a, 4, 2)]
            if len(a) >= 2 * RATE:
                out["test"]["turn"].append((n, a[: int(GRNG.uniform(2, 10) * RATE)]))
        out["spk"].append(s)
        out["tag"].append(f"{s.split('-')[0]}|{GENDER.get(s, '')}|{TAGS.get(s, '')}")
        out["enrol"].append(enrol)
    return out


def general_eval(pool, g, e_cohort, scores):
    cents = []
    for clips in g["enrol"]:
        made = enrol(list(embed(pool, clips)))
        cents.append(made[0] if made else np.zeros(e_cohort.shape[1], np.float32))
    C = np.stack(cents)
    valid = np.linalg.norm(C, axis=1) > 0
    cstat = np.sort(C @ e_cohort.T, axis=1)[:, -100:]
    res = {"speakers": int(valid.sum()), "groups": {}}
    tags = np.array(g["tag"])
    for mode, items in g["test"].items():
        if not items:
            continue
        items = [x for x in items if valid[x[0]]]
        own = np.array([n for n, _ in items])
        E = embed(pool, [a for _, a in items])
        S = E @ C.T
        tstat = np.sort(E @ e_cohort.T, axis=1)[:, -100:]
        N = 0.5 * ((S - cstat.mean(1)[None]) / cstat.std(1)[None] + (S - tstat.mean(1)[:, None]) / tstat.std(1)[:, None])
        mask = np.ones_like(S, bool) & valid[None]
        mask[np.arange(len(own)), own] = False
        for norm, M in (("raw", S), ("asnorm", N)):
            t = M[np.arange(len(own)), own]
            i = M[mask]
            scores[f"general|{mode}|{norm}|t"] = t.astype(np.float32)
            scores[f"general|{mode}|{norm}|i"] = i.astype(np.float32)
            res[f"{mode}|{norm}"] = {"all": summary(t, i)}
            for key in sorted({x.split("|")[0] for x in tags} | {x.split("|")[1] for x in tags if x.split("|")[1]}):
                sel = np.array([key in x.split("|")[:2] for x in tags])
                rows = sel[own]
                if rows.sum() < 20:
                    continue
                res[f"{mode}|{norm}"][key] = summary(t[rows], M[rows][mask[rows]])
        scores[f"general|{mode}|own"] = own
    scores["general|tags"] = tags
    return res


# ---- main --------------------------------------------------------------------------------------------------------
def main():
    names = sys.argv[1:]
    meta = his()
    before = [m for m in meta if m["day"] < SPLIT]
    after = [m for m in meta if m["day"] >= SPLIT]
    realtek = sorted((m for m in meta if m["mic"] == "realtek"), key=lambda m: m["at"])
    seed = pick_seed([m for m in before if m["mic"] == "scarlett"])
    realtek_enrol = realtek[:15]
    held = {"scarlett": [m for m in after if m["mic"] == "scarlett"],
            "realtek": [m for m in realtek if m not in realtek_enrol],
            "wireless": [m for m in after if m["mic"] == "wireless"],
            "other": [m for m in meta if m["mic"] == "other"]}
    notes = {"split": SPLIT, "seed": len(seed), "seed_days": len({m["day"] for m in seed}),
             "held": {k: len(v) for k, v in held.items()}, "realtek_enrol": len(realtek_enrol)}
    audio = {m["id"]: load(f"him/{m['id']}.flac") for m in meta}
    stamp(f"his data {json.dumps(notes)}")

    # Impostor utterances by source, each a list of (speaker, audio-or-bytes) with a tag for per-group rates.
    srcs, tags = {}, TAGS
    for part in ("test-clean", "test-other", "dev-other"):
        srcs.update(libri(part))
    stamp("librispeech")
    srcs.update(voxceleb())
    stamp("voxceleb")
    e, t = edacc("test", 2 if DRY else 10)
    srcs.update(e); tags.update(t)
    stamp("edacc")
    try:
        c, t = commonvoice()
        srcs.update(c); tags.update(t)
    except Exception as ex:
        print("commonvoice failed", ex, flush=True)
    stamp("commonvoice")
    tv, t = tts_voices()
    srcs.update(tv); tags.update(t)
    stamp(f"tts {len(tv)} voices")
    cohort_utts = [f for fs in libri("dev-clean").values() for f in fs[:8]]
    ce, _ = edacc("validation", 1 if DRY else 3)
    cohort_utts += [b for bs in ce.values() for b in bs[:8]]
    rng.shuffle(cohort_utts)
    cohort = []
    for u in cohort_utts:
        w = windows(load_any(u) if isinstance(u, bytes) else load(u), 3, 1)
        cohort += w
        if len(cohort) >= 600:
            break
    stamp(f"cohort {len(cohort)}; impostor speakers {len(srcs)}")

    def src_of(spk):
        return spk.split("-")[0]

    # Test items: (group, recording-or-speaker, audio) per mode.
    def items(mode):
        L = {"w2": 2, "w4": 4}.get(mode)
        turn_rng = random.Random(99)
        tgt = []
        for mic, ms in held.items():
            for m in ms:
                a = audio[m["id"]]
                if mode == "turn":
                    # A turn is 2-10 s, cropped the same way as the impostors' so length does not favour either side.
                    if len(a) >= 2 * RATE:
                        tgt.append((mic, m["id"], a[: int(turn_rng.uniform(2, 10) * RATE)]))
                else:
                    tgt += [(mic, m["id"], w) for w in windows(a, L, 6)]
        imp = []
        rng2 = random.Random(len(mode))
        # Shuffled, so the cap does not fill from the first source alone (the 2026-11-11 run's 2 s and turn sets were
        # all Common Voice for that reason; its 4 s set had every source).
        spk = sorted(srcs)
        rng2.shuffle(spk)
        per = max(1, CAP[mode] // max(1, len(spk)) + 1)
        for s in spk:
            utts = list(srcs[s])
            rng2.shuffle(utts)
            got = 0
            for u in utts:
                a = load_any(u) if isinstance(u, bytes) else load(u)
                if mode == "turn":
                    if len(a) >= 2 * RATE:
                        n = int(rng2.uniform(2, 10) * RATE)
                        imp.append((s, s, a[:n])); got += 1
                else:
                    for w in windows(a, L, 3):
                        imp.append((s, s, w)); got += 1
                if got >= per:
                    break
        return tgt, imp[: CAP[mode]]

    modes = {m: items(m) for m in ("w2", "w4", "turn")}
    general = general_items(srcs)
    stamp("general " + json.dumps({k: len(v) for k, v in general.items() if isinstance(v, list)}))
    stamp("items " + json.dumps({m: [len(a), len(b)] for m, (a, b) in modes.items()}))

    from multiprocessing import Pool
    for name in names:
        tm = time.time()
        url, window = MODELS[name]
        if window is not None:
            p = pathlib.Path(f"/tmp/{name}.onnx")
            if not p.exists():
                p.write_bytes(requests.get(url, timeout=600).content)
        init(name)
        res = {"model": name, **notes}
        scores = {}
        import contextlib
        with (contextlib.nullcontext(None) if GPU else Pool(os.cpu_count(), initializer=init, initargs=(name,))) as pool:
            res["gpu"] = GPU
            probe = [w for _, _, w in modes["w2"][1][:30]]
            c0 = time.process_time()
            for x in probe:
                embed_one(x)
            res["cpu_ms_per_s"] = round(1000 * (time.process_time() - c0) / (2 * len(probe)), 1)
            e_cohort = embed(pool, cohort)
            e_seed = embed(pool, [audio[m["id"]] for m in seed])
            c_seed, kept = enrol(list(e_seed))
            res["seed_kept"] = int(kept)
            e_rt = embed(pool, [audio[m["id"]] for m in realtek_enrol])
            c_rt, _ = enrol(list(e_rt))
            e_all = embed(pool, [audio[m["id"]] for m in before if m["mic"] == "scarlett" and 3 <= m["seconds"] <= 30])
            c_all = e_all.mean(0); c_all /= np.linalg.norm(c_all)
            enrols = {"seed60": [c_seed], "seed60+realtek": [c_seed, c_rt], "all-before": [c_all]}
            stamp(f"{name} enrolled, {res['cpu_ms_per_s']} ms/s")
            for mode, (tgt, imp) in modes.items():
                et = embed(pool, [a for _, _, a in tgt])
                ei = embed(pool, [a for _, _, a in imp])
                tg = np.array([g for g, _, _ in tgt]); tr = [r for _, r, _ in tgt]
                ig = [g for g, _, _ in imp]
                for en, cs in enrols.items():
                    raw_t = np.max(np.stack([et @ c for c in cs]), 0)
                    raw_i = np.max(np.stack([ei @ c for c in cs]), 0)
                    norm_t = np.max(np.stack([asnorm(et @ c, c, et, e_cohort) for c in cs]), 0)
                    norm_i = np.max(np.stack([asnorm(ei @ c, c, ei, e_cohort) for c in cs]), 0)
                    for norm, st, si in (("raw", raw_t, raw_i), ("asnorm", norm_t, norm_i)):
                        key = f"{mode}|{en}|{norm}"
                        scores[key + "|t"] = st.astype(np.float32)
                        scores[key + "|i"] = si.astype(np.float32)
                        res[key] = {"all": summary(st, si), **{f"mic:{mic}": summary(st[tg == mic], si) for mic in held if (tg == mic).sum() > 0}}
                        if mode == "w2":
                            # Accumulated over a turn: mean of 3 consecutive 2 s windows of one recording / speaker.
                            def acc(s, groups):
                                out, cur, key0 = [], [], None
                                for x, g in zip(s, groups):
                                    if g != key0:
                                        cur, key0 = [], g
                                    cur.append(x)
                                    if len(cur) == 3:
                                        out.append(np.mean(cur)); cur = []
                                return np.array(out)
                            at, ai = acc(st, tr), acc(si, ig)
                            scores[f"avg3|{en}|{norm}|t"] = at.astype(np.float32)
                            scores[f"avg3|{en}|{norm}|i"] = ai.astype(np.float32)
                            res[f"avg3|{en}|{norm}"] = {"all": summary(at, ai)}
                scores[f"{mode}|tgroup"] = tg
                scores[f"{mode}|igroup"] = np.array([src_of(g) + "|" + tags.get(g, "") for g in ig])
                stamp(f"{name} {mode} done")
            res["general"] = general_eval(pool, general, e_cohort, scores)
            stamp(f"{name} general done")
        res["minutes"] = round((time.time() - tm) / 60, 1)
        (OUT / f"{name}.json").write_text(json.dumps(res, indent=1))
        np.savez_compressed(OUT / f"{name}-scores.npz", **scores)
        stamp(f"{name} written")


if __name__ == "__main__":
    main()
