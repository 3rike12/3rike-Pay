"""Mix voice over score with ducking, then hand off to ffmpeg for loudness."""
import sys, pathlib, numpy as np, soundfile as sf
ROOT = pathlib.Path(sys.argv[1]); SR = 48000
v, _ = sf.read(ROOT / "build/voice.wav", dtype="float64")
m, _ = sf.read(ROOT / "build/score.wav", dtype="float64")
n = max(len(v), len(m))
v = np.pad(v, (0, n - len(v))); m = np.pad(m, (0, n - len(m)))

# Voice envelope: rectify, then a 40ms attack / 420ms release follower. The
# release is long so the bed does not pump between words inside a sentence.
rect = np.abs(v)
atk = 1 - np.exp(-1 / (0.040 * SR))
rel = 1 - np.exp(-1 / (0.420 * SR))
envp = np.zeros(n); acc = 0.0
for i in range(n):
    x = rect[i]
    acc += (atk if x > acc else rel) * (x - acc)
    envp[i] = acc
# 20 dB of duck at full voice, reached early (the threshold is low), and a
# 150ms look-ahead so the bed is already out of the way before a line starts.
# The groove is meant to be heard in the gaps between lines and almost not at
# all underneath one.
duck = 1.0 - 0.905 * np.clip(envp / 0.16, 0, 1)
duck = np.concatenate([duck[int(0.15 * SR):], np.full(int(0.15 * SR), duck[-1])])
mix = v * 1.0 + m * duck * 0.72   # the duck depth tracks this gain, so raising
                                 # the bed in the gaps leaves it where it was
                                 # underneath a line
pk = float(np.max(np.abs(mix)))
print(f"pre-norm peak {pk:.3f}  duck range {duck.min():.2f}..{duck.max():.2f}")
if pk > 0.99: mix = mix / pk * 0.99
sf.write(ROOT / "build/mix_raw.wav", mix.astype(np.float32), SR)
