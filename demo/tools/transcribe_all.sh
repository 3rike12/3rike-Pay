#!/bin/bash
cd "$1" || exit 1
mkdir -p build/tx
for f in build/pad/l*.wav; do
  id=$(basename "$f" .wav)
  [ -s "build/tx/$id.json" ] && continue
  npx --yes hyperframes@0.8.143 transcribe "$f" --json --language en --engine parakeet 2>&1 \
    | grep '"type":"words"' > "build/tx/$id.json"
  printf "%s " "$id"
done
echo "done"
