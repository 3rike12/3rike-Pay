"""Synthesize one WAV per narration line, with phoneme-level pronunciation fixes."""
import os, sys, json, pathlib
ROOT = pathlib.Path(sys.argv[1])
os.environ.setdefault("ESPEAK_DATA_PATH", str(ROOT / "build/espeak"))
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
import espeakng_loader
from phonemizer.backend.espeak.wrapper import EspeakWrapper
EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())

spec = json.loads((ROOT / "lines.json").read_text())
cache = pathlib.Path.home() / ".cache/hyperframes/tts"
k = Kokoro(str(cache / "models/kokoro-v1.0.onnx"), str(cache / "voices/voices-v1.0.bin"))
out = ROOT / "assets/vo"; out.mkdir(parents=True, exist_ok=True)

overrides = spec["phoneme_overrides"]
total_s = total_w = 0
report = []
for line in spec["lines"]:
    ph = k.tokenizer.phonemize(line["say"], "en-us")
    hits = []
    for wrong, right in overrides.items():
        if wrong in ph:
            ph = ph.replace(wrong, right); hits.append(wrong)
    samples, sr = k.create(ph, voice=spec["voice"], speed=spec["speed"], lang="en-us", is_phonemes=True)
    sf.write(out / f"{line['id']}.wav", samples, sr)
    dur = len(samples) / sr
    words = len(line["say"].split())
    total_s += dur; total_w += words
    report.append({"id": line["id"], "dur": round(dur, 3), "words": words,
                   "wpm": round(words / dur * 60), "fixed": hits, "phonemes": ph})
    print(f"{line['id']}  {dur:5.2f}s  {words:3d}w  {words/dur*60:5.1f}wpm  {'FIX:'+','.join(hits) if hits else ''}")

(ROOT / "build/vo_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
print(f"\nTOTAL speech {total_s:.1f}s ({total_s/60:.2f} min), {total_w} words, {total_w/total_s*60:.1f} wpm overall")
