#!/usr/bin/env bash
# Transcode the Playwright WebM recording into a shareable H.264 MP4.
# Captions are already burned in by record.mjs, so there is no subtitle filter
# here. Set FFMPEG to an ffmpeg binary if it is not on PATH.
set -euo pipefail

usage() {
  echo "usage: $0 input.webm [output.mp4]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

input=$1
output=${2:-${input%.webm}.mp4}
ffmpeg=${FFMPEG:-ffmpeg}

if ! command -v "$ffmpeg" >/dev/null 2>&1; then
  echo "encode: ffmpeg not found. Install ffmpeg or set FFMPEG=/path/to/ffmpeg." >&2
  exit 1
fi

if [[ ! -f "$input" ]]; then
  echo "encode: missing input video: $input" >&2
  exit 1
fi

"$ffmpeg" -y -hide_banner -loglevel warning -i "$input" \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -movflags +faststart -an \
  "$output"

echo "encode: wrote $output"
