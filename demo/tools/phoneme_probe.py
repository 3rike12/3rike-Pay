"""Print the phonemes Kokoro will actually say for a word.

Used to decide which lines in lines.json need a pronunciation override: run it,
read the IPA, and if it is wrong write the spelling that fixes it into the
`say` field. That is how "3rike" became THREE-rike and *naira* came to rhyme
with *fire*.

  ./.venv/bin/python -I tools/phoneme_probe.py <espeak-data> <model.onnx> <voices.bin> [word ...]
"""
import os, sys

os.environ.setdefault("ESPEAK_DATA_PATH", sys.argv[1])
from kokoro_onnx import Kokoro
import espeakng_loader
from phonemizer.backend.espeak.wrapper import EspeakWrapper

EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())

# The words this film actually had to get right: the brand, the currencies,
# the banks and the shorthand amounts.
DEFAULT = ["3rike Pay", "Three-rike Pay", "3rike", "Adaeze Okonkwo", "KTRN",
           "NIN or BVN", "naira", "milla", "Rwandan", "Airtel", "MTN",
           "GTBank", "G-T-Bank", "slash invoice", "five k", "one milla",
           "eighty nine and eight", "five point nine two"]

k = Kokoro(sys.argv[2], sys.argv[3])
for t in sys.argv[4:] or DEFAULT:
    try:
        print(f"{t!r:28} -> {k.tokenizer.phonemize(t, 'en-us')!r}")
    except Exception as e:
        print(f"{t!r:28} -> ERROR {e}")
