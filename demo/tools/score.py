"""Original score and SFX for the 3rike Pay film.

Written rather than licensed: every sample is generated from the cue times, so
the arrival lands exactly on the spoken name and nothing in the repository
carries someone else's rights. Deterministic — no RNG seeded from the clock,
no network.

The bed is a light kalimba groove with a soft shaker and a short bass note:
something with a pulse that can sit a long way under a voice. Nothing here is
loud; the mix ducks it further still.

Usage:  python -I tools/score.py <demo-dir>
Writes: build/score.wav, build/events.json
"""
import sys, json, re, pathlib
import numpy as np

ROOT = pathlib.Path(sys.argv[1])
SR = 48000
PLACE = json.loads((ROOT / "build/placement.json").read_text())
TOTAL = PLACE["total"]
buf = np.zeros(int(TOTAL * SR) + SR, dtype=np.float64)
rng = np.random.default_rng(20261009)   # fixed seed: the same film every run

L = PLACE["lines"]
def a(lid): return L[lid][0]
def b(lid): return L[lid][1]


def win(t0, t1):
    """Sample indices and a local time axis for [t0, t1)."""
    i0, i1 = int(t0 * SR), int(min(t1, TOTAL + 0.9) * SR)
    if i1 <= i0 or i0 < 0: return None, None
    return (i0, i1), np.arange(i1 - i0) / SR


def env(n, attack, release, sr=SR):
    """Raised-cosine attack and release, flat between."""
    e = np.ones(n)
    na, nr = min(int(attack * sr), n // 2), min(int(release * sr), n // 2)
    if na: e[:na] = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, na))
    if nr: e[n - nr:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nr))
    return e


def pad(freq, t0, t1, amp, attack=1.6, release=2.2, detune=0.4, harm=(1.0, 0.5, 0.22)):
    """A slow tone that only glues the groove together."""
    sl, t = win(t0, t1)
    if sl is None: return
    e = env(len(t), attack, release) * amp
    sig = np.zeros(len(t))
    for k, h in enumerate(harm):
        f = freq * (k + 1)
        sig += h * (np.sin(2 * np.pi * f * t) + np.sin(2 * np.pi * (f + detune) * t)) * 0.5
    sig *= 1.0 + 0.06 * np.sin(2 * np.pi * 0.11 * t)
    buf[sl[0]:sl[1]] += sig * e / sum(harm)


def kalimba(freq, t0, amp, decay=0.95):
    """A plucked tine: strong fundamental with two inharmonic partials that
    die much faster. Bright and short, so it never masks a consonant."""
    sl, t = win(t0, t0 + decay * 1.9)
    if sl is None: return
    sig = (np.sin(2 * np.pi * freq * t) * np.exp(-t / decay)
           + 0.30 * np.sin(2 * np.pi * freq * 2.76 * t) * np.exp(-t / (decay * 0.30))
           + 0.11 * np.sin(2 * np.pi * freq * 5.40 * t) * np.exp(-t / (decay * 0.15)))
    buf[sl[0]:sl[1]] += sig * env(len(t), 0.003, 0.0) * amp * 0.55


def bassnote(freq, t0, amp, decay=0.5):
    """Short round low note on the downbeat."""
    sl, t = win(t0, t0 + decay * 2.2)
    if sl is None: return
    sig = (np.sin(2 * np.pi * freq * t) * np.exp(-t / decay)
           + 0.22 * np.sin(2 * np.pi * freq * 2 * t) * np.exp(-t / (decay * 0.4)))
    buf[sl[0]:sl[1]] += sig * env(len(t), 0.007, 0.0) * amp


def shaker(t0, amp, dur=0.075):
    """High-passed noise blip. The groove's only percussion."""
    sl, t = win(t0, t0 + dur)
    if sl is None: return
    n = len(t)
    noise = rng.standard_normal(n)
    acc, lo = 0.0, np.zeros(n)
    for i in range(n):
        acc += 0.25 * (noise[i] - acc); lo[i] = acc
    buf[sl[0]:sl[1]] += (noise - lo) * np.exp(-t * 48) * amp


def bell(freq, t0, amp, decay=2.4, harm=(1.0, 0.42, 0.18, 0.09)):
    """A struck tone — the arrival, and the marks along the way."""
    sl, t = win(t0, t0 + decay * 1.6)
    if sl is None: return
    sig = np.zeros(len(t))
    for k, h in enumerate(harm):
        f = freq * (1, 2.01, 3.03, 4.08)[k]
        sig += h * np.sin(2 * np.pi * f * t) * np.exp(-t / (decay / (k * 0.55 + 1)))
    buf[sl[0]:sl[1]] += sig * env(len(t), 0.004, 0.0) * amp / sum(harm)


def riser(t0, t1, amp, f0=180.0, f1=760.0):
    """Filtered noise sweeping up — the lift into the name."""
    sl, t = win(t0, t1)
    if sl is None: return
    n = len(t)
    ph = np.cumsum(np.linspace(f0, f1, n)) * 2 * np.pi / SR
    tone = np.sin(ph) * 0.5 + np.sin(ph * 1.5) * 0.2
    noise = rng.standard_normal(n)
    cut = np.linspace(0.02, 0.35, n)
    filt = np.zeros(n); acc = 0.0
    for i in range(n):
        acc += cut[i] * (noise[i] - acc); filt[i] = acc
    buf[sl[0]:sl[1]] += (tone * 0.5 + filt * 1.3) * np.linspace(0, 1, n) ** 2.2 * amp


def whoosh(t0, amp, dur=0.7):
    """Air moving — used once, when the chat is shoved out of frame."""
    sl, t = win(t0, t0 + dur)
    if sl is None: return
    n = len(t)
    noise = rng.standard_normal(n)
    cut = 0.06 + 0.30 * np.sin(np.linspace(0, np.pi, n))
    filt = np.zeros(n); acc = 0.0
    for i in range(n):
        acc += cut[i] * (noise[i] - acc); filt[i] = acc
    buf[sl[0]:sl[1]] += filt * np.sin(np.linspace(0, np.pi, n)) ** 1.5 * amp


def tick(t0, amp, freq=2200.0):
    """A small click for a value landing."""
    sl, t = win(t0, t0 + 0.09)
    if sl is None: return
    buf[sl[0]:sl[1]] += np.sin(2 * np.pi * freq * t) * np.exp(-t * 70) * amp


# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------
D2, A2, G2, B2 = 73.42, 110.00, 98.00, 123.47
D3, F3, A3, B3, G3, E3 = 146.83, 174.61, 220.00, 123.47 * 2, 196.00, 164.81
D4, E4, Fs4, G4, A4, B4, Cs5, D5, Fs5 = 293.66, 329.63, 369.99, 392.00, 440.00, 493.88, 554.37, 587.33, 739.99

S = PLACE["scenes"]
S1B = S["s1_cold"][1]
S3A = S["s3_person"][0]
S4A = S["s4_biz"][0]
S5A = S["s5_close"][0]

EV = []
def ev(t, name, gain): EV.append({"t": round(float(t), 3), "name": name, "gain": gain})

TITLE = a("l04")        # 3rike Pay — everything is measured from here

def word(lid, needle):
    """Timeline time of a spoken word, or None if the line does not say it."""
    ws = json.loads((ROOT / f"build/tx/{lid}.json").read_text())["words"]
    hit = next((w for w in ws if re.sub(r"[^a-z0-9]", "", w["text"].lower()) == needle), None)
    return None if hit is None else a(lid) + hit["start"] - 0.3


# ---------------------------------------------------------------------------
# 1. The problem — almost nothing, and a clock
# ---------------------------------------------------------------------------
pad(D3, 0.0, S1B + 0.2, 0.055, attack=2.2, release=1.0)
pad(F3, 1.8, S1B + 0.2, 0.034, attack=2.6, release=1.0)
ev(0.0, "pad_dmin", 0.055)
t = a("l02") - 0.2
while t < S1B - 0.6:
    kalimba(A3, t, 0.030, decay=0.35); ev(t, "clock", 0.030); t += 1.2
whoosh(a("l02") - 0.5, 0.055); ev(a("l02") - 0.5, "whoosh_out", 0.055)

# ---------------------------------------------------------------------------
# 2. The name — the riser resolves onto the spoken word
# ---------------------------------------------------------------------------
riser(TITLE - 2.1, TITLE, 0.060, 150, 640); ev(TITLE - 2.1, "riser", 0.060)
for f, g in ((D3, 0.115), (D4, 0.085), (Fs4, 0.065), (A4, 0.055), (D5, 0.035)):
    bell(f, TITLE, g, decay=3.4)
ev(TITLE, "arrival_Dmaj", 0.115)

# ---------------------------------------------------------------------------
# 3 & 4. The body — a light kalimba groove, D major, I vi IV V
# ---------------------------------------------------------------------------
BPM = 96.0
BEAT = 60.0 / BPM            # 0.625s
BAR = BEAT * 4               # 2.5s
GROOVE_IN = TITLE + 0.5
GROOVE_OUT = S5A - 1.2

CHORDS = [
    (D2, [D4, Fs4, A4, D5]),     # D
    (B2, [B3, D4, Fs4, B4]),     # Bm
    (G2, [G3, B3, D4, G4]),      # G
    (A2, [A3, Cs5, E4, A4]),     # A
]
# A bouncy six-note figure inside each bar: 1, 1&, 2&, 3, 4, 4&.
FIG = [(0.0, 0), (0.5, 2), (1.5, 1), (2.0, 3), (3.0, 2), (3.5, 1)]

bar, t = 0, GROOVE_IN
while t < GROOVE_OUT:
    root, tones = CHORDS[bar % len(CHORDS)]
    body = t > S3A - 0.6                       # quiet intro bar under the name
    lvl = 0.042 if body else 0.026
    bassnote(root, t, 0.030 if body else 0.018)
    for off, idx in FIG:
        nt = t + off * BEAT
        if nt >= GROOVE_OUT: break
        kalimba(tones[idx], nt, lvl * (1.0 if off % 1 == 0 else 0.72))
    if body:
        for k in range(1, 8, 2):               # shaker on every offbeat
            shaker(t + k * BEAT * 0.5, 0.011)
    bar += 1; t += BAR
ev(GROOVE_IN, "groove_in", 0.042)

# A sustained note under each half so the groove is not bare.
pad(D3, S3A - 0.4, S4A, 0.030, attack=1.4, release=1.4)
pad(A3, S3A + 1.0, S4A, 0.018, attack=2.0, release=1.4)
pad(D3, S4A - 0.2, GROOVE_OUT, 0.030, attack=1.2, release=1.6)
pad(Fs4, S4A + 1.4, GROOVE_OUT, 0.016, attack=2.4, release=1.6)   # the business lift

# Marks on the beats the narration points at.
for lid, w, g in (("l06", "number", 0.050), ("l07", "send", 0.042),
                  ("l10", "receipt", 0.058), ("l11", "shop", 0.050),
                  ("l12", "invoice", 0.042), ("l13", "approves", 0.054)):
    tt = word(lid, w)
    if tt is not None:
        bell(D5 if g > 0.048 else A4, tt, g, decay=1.4); ev(tt, "mark_" + w, g)

# The three ways of saying one amount, and the amount resolving.
for lid, w, f in (("l08", "five", D4), ("l08", "one", Fs4), ("l08", "four", A4)):
    tt = word(lid, w)
    if tt is not None:
        tick(tt, 0.034); kalimba(f, tt, 0.060); ev(tt, "chip", 0.060)
bell(D5, b("l08") - 0.5, 0.068, decay=2.0); ev(b("l08") - 0.5, "amount_resolve", 0.068)

# The receipt, itemised, then the figure the merchant keeps.
for w in ("hundred", "francs"):
    tt = word("l15", w)
    if tt is not None: tick(tt, 0.032); ev(tt, "ledger_row", 0.032)
KEEP = word("l15", "keep")
if KEEP is not None:
    bell(D4, KEEP, 0.065, decay=2.6); ev(KEEP, "you_keep", 0.065)

# ---------------------------------------------------------------------------
# 5. The close — the groove stops, one held major, one last strike
# ---------------------------------------------------------------------------
pad(D3, GROOVE_OUT, TOTAL - 0.3, 0.058, attack=1.0, release=3.6)
pad(Fs4, GROOVE_OUT + 1.7, TOTAL - 0.3, 0.028, attack=2.2, release=3.6)
pad(A4, GROOVE_OUT + 4.1, TOTAL - 0.3, 0.018, attack=2.6, release=3.6)
ev(GROOVE_OUT, "close_pad", 0.058)
for f, g in ((D3, 0.110), (D4, 0.080), (Fs4, 0.060), (A4, 0.050), (D5, 0.034)):
    bell(f, a("l16"), g, decay=5.0)
ev(a("l16"), "final_Dmaj", 0.110)

# ---------------------------------------------------------------------------
buf = buf[:int(TOTAL * SR)]
nf = int(0.3 * SR); buf[:nf] *= np.linspace(0, 1, nf)
nt = int(1.6 * SR); buf[-nt:] *= np.linspace(1, 0, nt)

peak = float(np.max(np.abs(buf)))
print(f"score peak {peak:.3f}  rms {float(np.sqrt(np.mean(buf**2))):.4f}  {TOTAL:.2f}s  {len(EV)} events")
if peak > 0.98: buf = buf / peak * 0.98

import soundfile as sf
sf.write(ROOT / "build/score.wav", buf.astype(np.float32), SR)
(ROOT / "build/events.json").write_text(json.dumps(
    {"total": TOTAL, "bpm": BPM, "events": sorted(EV, key=lambda e: e["t"])}, indent=1))
print("wrote build/score.wav, build/events.json")
