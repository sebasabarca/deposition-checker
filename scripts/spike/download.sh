#!/usr/bin/env bash
# Downloads the public deposition files used by the parser spike into data/raw/.
# The files are not committed; run this script to reproduce them.
#
# Sources (U.S. Department of Justice, Antitrust Division):
#   Ellison P3171, HTML transcript:
#     https://www.justice.gov/atr/p3171-cid-022793-lawrence-joseph-ellison-oracle-videotaped-deposition-transcript
#   Ellison P3171, PDF (linked from the HTML page):
#     https://www.justice.gov/atr/cases/f204400/204418.pdf
#   Ellison P3173, HTML transcript:
#     https://www.justice.gov/atr/p3173-cid-lawrence-joseph-ellison-oracle-videotaped-deposition-transcript
#   Ellison P3173, PDF (linked from the HTML page):
#     https://www.justice.gov/atr/cases/f204400/204419.pdf
#   Gates, U.S. v. Microsoft, deposition excerpts as admitted in court (scanned, kept for later testing):
#     https://www.justice.gov/atr/cases/ms_gates2.htm
set -euo pipefail

cd "$(dirname "$0")/../.."
mkdir -p data/raw/ellison data/raw/gates

fetch() {
  local url="$1" out="$2"
  if [ -s "$out" ]; then
    echo "exists  $out"
  else
    echo "fetch   $url"
    curl -fsSL --retry 3 -o "$out" "$url"
  fi
}

fetch "https://www.justice.gov/atr/p3171-cid-022793-lawrence-joseph-ellison-oracle-videotaped-deposition-transcript" \
  data/raw/ellison/p3171.html
fetch "https://www.justice.gov/atr/cases/f204400/204418.pdf" data/raw/ellison/p3171.pdf
fetch "https://www.justice.gov/atr/p3173-cid-lawrence-joseph-ellison-oracle-videotaped-deposition-transcript" \
  data/raw/ellison/p3173.html
fetch "https://www.justice.gov/atr/cases/f204400/204419.pdf" data/raw/ellison/p3173.pdf

for f in gates8a gates8b gates8c gates8d gates8f; do
  fetch "https://www.justice.gov/atr/cases/f2000/$f.pdf" "data/raw/gates/$f.pdf"
done
fetch "https://www.justice.gov/atr/deposition-bill-gates-us-v-microsoft-corporation" data/raw/gates/sep2.html

echo
echo "SHA-256 (record these in docs/parser-spike.md):"
shasum -a 256 data/raw/ellison/* data/raw/gates/*
