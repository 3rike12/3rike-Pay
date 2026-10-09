"""Place VO lines on the timeline, solving gap lengths to hit an exact target."""
import sys, json, pathlib
import numpy as np, soundfile as sf
ROOT = pathlib.Path(sys.argv[1]); TARGET = float(sys.argv[2]); SR = 48000

spec = json.loads((ROOT / "lines.json").read_text())
ids = [l["id"] for l in spec["lines"]]
SCENES = spec["scenes"]
first_of_scene = {v[0] for v in SCENES.values()}

LEAD, TAIL = 0.85, 2.70
# Relative weights, scaled to whatever time is left. A picture change is worth
# more than a breath inside a scene; the title is worth most of all, because
# the music has to arrive under it.
W_IN, W_SCENE = 1.0, 2.6
W_SPECIAL = {"l04": 4.6, "l05": 2.4}

wav = {}
for lid in ids:
    w, sr = sf.read(ROOT / f"assets/vo/{lid}.wav")
    if w.ndim > 1: w = w.mean(axis=1)
    if sr != SR:
        n = int(round(len(w) * SR / sr))
        w = np.interp(np.linspace(0, len(w)-1, n), np.arange(len(w)), w)
    wav[lid] = w
speech = sum(len(w) for w in wav.values()) / SR

weights = []
for i, lid in enumerate(ids):
    if i == 0: continue
    weights.append(W_SPECIAL.get(lid, W_SCENE if lid in first_of_scene else W_IN))
budget = TARGET - LEAD - TAIL - speech
if budget <= 0: raise SystemExit(f"over budget: speech {speech:.1f}s alone exceeds {TARGET}s")
unit = budget / sum(weights)

placed, t, wi = {}, LEAD, 0
for i, lid in enumerate(ids):
    if i: t += weights[wi] * unit; wi += 1
    placed[lid] = (round(t, 4), round(t + len(wav[lid])/SR, 4))
    t += len(wav[lid]) / SR
total = t + TAIL

buf = np.zeros(int(total * SR) + SR, dtype=np.float32)
for lid, (a, _) in placed.items():
    i = int(a * SR); buf[i:i+len(wav[lid])] += wav[lid].astype(np.float32)
buf = buf[:int(total * SR)]
peak = float(np.max(np.abs(buf)))
if peak > 0: buf = buf / peak * 0.89
sf.write(ROOT / "build/voice.wav", buf, SR)

out = {"total": round(total, 3), "lead": LEAD, "tail": TAIL,
       "unit": round(unit, 4),
       "lines": {k: list(v) for k, v in placed.items()},
       "scenes": {s: [placed[v[0]][0], placed[v[-1]][1]] for s, v in SCENES.items()}}
(ROOT / "build/placement.json").write_text(json.dumps(out, indent=2))
print(f"TOTAL {total:.2f}s  ({int(total//60)}:{total%60:05.2f})   speech {speech:.1f}s   gap unit {unit:.3f}s")
print(f"  within-scene gap {unit*W_IN:.2f}s   scene change {unit*W_SCENE:.2f}s   title {unit*4.6:.2f}s")
for s, (a, b) in out["scenes"].items(): print(f"  {s:10} {a:6.2f} -> {b:6.2f}  ({b-a:5.2f}s)")
