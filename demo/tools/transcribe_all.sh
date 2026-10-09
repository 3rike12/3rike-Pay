#!/bin/bash
# Word timings for every narration line.
#   bash tools/transcribe_all.sh <demo-dir>
#
# Parakeet swallows the first phoneme of a file that opens on a word, so each
# line is transcribed with a known 300ms of silence in front; cues.py subtracts
# that same 300ms again. That padding used to be done by hand in the shell,
# which left build/pad/ holding the previous take of a line that had since been
# reworded -- the transcript stayed plausible and the cues silently pointed at
# the wrong words. Both the pad and the transcript are now rebuilt whenever the
# voice is newer than them.
set -e
cd "$1" || exit 1
mkdir -p build/pad build/tx
for f in assets/vo/l*.wav; do
  id=$(basename "$f" .wav)
  if [ -s "build/tx/$id.json" ] && [ "build/tx/$id.json" -nt "$f" ]; then continue; fi
  ffmpeg -v error -y -i "$f" -af "adelay=300:all=1" "build/pad/$id.wav"
  npx --yes hyperframes@0.8.143 transcribe "build/pad/$id.wav" --json --language en --engine parakeet 2>&1 \
    | grep '"type":"words"' > "build/tx/$id.json"
  printf "%s " "$id"
done
echo "done"
