"""Thresholds and the report table from speaker-calib.py's score files (no audio, no embeddings).
  python3 speaker-calib-report.py out/<model>-scores.npz [...]
"""
import json, sys

import numpy as np


def frr_far(t, i, th):
    return float((t < th).mean()), float((i >= th).mean())


def thr_far(i, target):
    # smallest threshold whose FAR is at or under target
    s = np.sort(i)
    k = int(np.floor(target * len(s)))
    return float(s[len(s) - k - 1]) + 1e-6 if k < len(s) else float(s[0])


def thr_frr(t, target):
    s = np.sort(t)
    return float(s[int(np.floor(target * len(s)))])


def eer(t, i):
    th = np.unique(np.concatenate([t, i]))
    fr = np.searchsorted(np.sort(t), th) / len(t)
    fa = 1 - np.searchsorted(np.sort(i), th) / len(i)
    j = np.argmin(abs(fr - fa))
    return float((fr[j] + fa[j]) / 2)


def main():
    out = {}
    for path in sys.argv[1:]:
        z = np.load(path, allow_pickle=True)
        m = {}
        for key in z.files:
            if key.endswith("|t") and key[:-2] + "|i" in z.files:
                t, i = z[key], z[key[:-2] + "|i"]
                base = key[:-2]
                row = {"n_t": len(t), "n_i": len(i), "eer": round(eer(t, i), 4)}
                for f in (0.001,):
                    th = thr_far(i, f)
                    row["thr_far0.1"] = round(th, 4)
                    row["frr_at_far0.1"] = round(frr_far(t, i, th)[0], 4)
                for r in (0.02, 0.01):
                    th = thr_frr(t, r)
                    row[f"thr_frr{int(r*100)}"] = round(th, 4)
                    row[f"far_at_frr{int(r*100)}"] = round(frr_far(t, i, th)[1], 5)
                if "raw" in base:
                    row["at_current"] = {f"{c}": [round(x, 4) for x in frr_far(t, i, c)] for c in (0.10, 0.22, 0.28, 0.36, 0.40)}
                # per mic for his modes
                mode = base.split("|")[0]
                if not base.startswith("general") and f"{mode}|tgroup" in z.files and mode != "avg3":
                    g = z[f"{mode}|tgroup"]
                    for mic in sorted(set(g)):
                        row[f"mic:{mic}"] = {"n": int((g == mic).sum()), "frr_at_thr_far0.1": round(frr_far(t[g == mic], i, row["thr_far0.1"])[0], 4),
                                             "frr_at_thr_frr2": round(frr_far(t[g == mic], i, row["thr_frr2"])[0], 4)}
                m[base] = row
        out[path] = m
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
