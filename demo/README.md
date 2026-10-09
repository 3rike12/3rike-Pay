# Demo film

A 1:29.50 film about 3rike Pay. 1920×1080, 30fps, narrated, subtitled.

Everything the film shows of the product is a real capture of the live site at
`https://3rike-pay.vercel.app` — including the WhatsApp transcripts, which the
documentation renders from the bot's own message templates in
`src/config/messages.json`. Captures are revealed and cropped, never redrawn.
See [BRIEF.md](BRIEF.md) for the full claim→source table and
[script.md](script.md) for the line-by-line cue sheet.

The score is original and generated from the cue times, so nothing here carries
a third party's licence. It is a light kalimba groove mixed well under the
voice: audible between lines, almost absent beneath one.

## Rebuilding

Needs Python 3 with `kokoro-onnx soundfile numpy` (in `.venv`), ffmpeg, Node,
and Google Chrome for the captures.

```bash
python -m venv .venv && ./.venv/bin/pip install kokoro-onnx soundfile numpy

./.venv/bin/python -I tools/vo.py   "$PWD"          # narration, one WAV per line
./.venv/bin/python -I tools/place.py "$PWD" 89.5    # solve pauses to hit 89.5s
bash tools/transcribe_all.sh "$PWD"                 # Parakeet word timings
./.venv/bin/python -I tools/cues.py  "$PWD"         # build/cues.js
./.venv/bin/python -I tools/score.py "$PWD"         # original score + events
./.venv/bin/python -I tools/mix.py   "$PWD"         # duck score under voice
bash tools/loudness.sh "$PWD"                       # compress, gain, brickwall
./.venv/bin/python -I tools/script_md.py "$PWD"     # regenerate script.md
node tools/capture.mjs "$PWD"                       # screenshots from the live site
bash tools/stage.sh                                 # copy assets into film/
cd film && npm run check && npm run render
```

Every stage is a script, including the loudness one. That stage used to live in
shell history, which is how `film-audio.wav` once went stale under a finished
render without anything complaining.

`tools/place.py` takes the target runtime as an argument and solves the pause
lengths to land on it, so changing the length is one number, not a re-time.

## Layout

| Path | What |
|---|---|
| `lines.json` | the script: spoken text, subtitle chunks, scenes, pronunciation overrides |
| `tools/` | the pipeline above |
| `tools/shoot.mjs` | ad-hoc Playwright screenshotter, used for design options sheets |
| `tools/phoneme_probe.py` | prints what the voice will actually say for a word, to decide pronunciation overrides |
| `assets/shots/` | captures of the live site, with per-bubble geometry in `shots.json` |
| `assets/fonts/` | Hepta Slab + Poppins, local woff2 |
| `film/` | the HyperFrames composition |
| `build/` | generated (gitignored) |

## Known issue

The site's Fees page and the documentation give two different processor rates
for the same kind of transaction. Both are presented as real. This needs
reconciling — see the end of [BRIEF.md](BRIEF.md).
