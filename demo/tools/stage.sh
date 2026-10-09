#!/bin/bash
# Stage the generated assets into the HyperFrames project.
# demo/assets is the source of truth; demo/film/assets is a build artefact.
set -e
D="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$D/film/assets"
cp -R "$D/assets/fonts"  "$D/film/assets/"
cp -R "$D/assets/shots"  "$D/film/assets/"
cp    "$D/assets/fonts.css" "$D/film/fonts.css"
cp    "$D/build/cues.js"    "$D/film/cues.js"
cp    "$D/build/film-audio.wav" "$D/film/assets/film-audio.wav"
echo "staged into film/"
