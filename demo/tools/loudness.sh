#!/bin/bash
# Bring build/mix_raw.wav to delivery level. Writes build/mix_c.wav (the
# compressed intermediate) and build/film-audio.wav (the master).
#   bash tools/loudness.sh <demo-dir>
#
# Two-pass loudnorm is the usual recipe, but this mix has a ~20 dB crest
# factor (bell transients and plosives over quiet speech), so the gain needed
# to reach -14 LUFS always pushes the true peak past -1.5 dBTP and loudnorm
# silently abandons linear mode for dynamic, landing a dB low. So the gain is
# measured and applied flat, and the few transients that would then clip are
# caught by a look-ahead limiter. Deterministic, and it hits the number.
set -e
cd "$1" || exit 1
I=-14.0; CEIL=0.767   # -2.3 dBFS sample, which measures about -1.5 dBTP after
                      # the 4x-oversampled intersample peaks are counted

# Light compression: tames plosives without squashing the dynamics that make
# the quiet opening feel quiet.
ffmpeg -v error -y -i build/mix_raw.wav \
  -af "acompressor=threshold=0.10:ratio=3:attack=12:release=260:makeup=1" \
  build/mix_c.wav

# Measure, then apply the gain flat and brickwall the transients.
MI=$(ffmpeg -hide_banner -nostats -i build/mix_c.wav \
       -af "loudnorm=I=$I:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 \
     | awk '/^\{/,/^\}/' | grep '"input_i"' | sed 's/.*: *"\(.*\)".*/\1/')
G=$(python3 -c "print(f'{$I - ($MI):.2f}')")
echo "measured I=$MI LUFS -> applying ${G} dB"

norm() {   # <gain-dB> <out>
  ffmpeg -v error -y -i build/mix_c.wav \
    -af "volume=${1}dB,alimiter=limit=$CEIL:attack=5:release=60:level=disabled" \
    -ar 48000 "$2"
}
measure() { ffmpeg -hide_banner -nostats -i "$1" \
    -af "loudnorm=I=$I:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 \
  | awk '/^\{/,/^\}/' | grep '"input_i"' | sed 's/.*: *"\(.*\)".*/\1/'; }

# The limiter itself costs a few tenths of a dB, so measure what came out and
# correct once. Converges well inside 0.2 LU.
norm "$G" build/film-audio.wav
R=$(measure build/film-audio.wav)
G=$(python3 -c "print(f'{$G + $I - ($R):.2f}')")
echo "after limiting I=$R LUFS -> correcting to ${G} dB"
norm "$G" build/film-audio.wav

ffmpeg -hide_banner -nostats -i build/film-audio.wav -af ebur128=peak=true -f null - 2>&1 \
  | grep -A9 Summary | sed 's/^ */  /'
