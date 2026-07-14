#!/usr/bin/env bash
# build_tennis_index.sh — rebuild tennis/tennis_serve_index.json from working data mirrors.
# Run from repo root:  bash build_tennis_index.sh
# NOTE: JeffSackmann/tennis_atp was removed from GitHub; these are community mirrors that carry the
# identical Sackmann schema. Mirrors can disappear — if downloads 404, we hunt for a new one.
set -uo pipefail
cd "$(dirname "$0")"
ATP="AlexandraMoldovan03/ATP-Tennis-Match-Outcome-Prediction-Using-PySpark-and-Machine-Learning"
WTA="EdwardM1276/Tennis-Performance-Indicator"
mkdir -p data/tennis; rm -f data/tennis/*.csv
for y in $(seq 2015 2025); do
  curl -sf -o "data/tennis/atp_matches_$y.csv" "https://raw.githubusercontent.com/$ATP/main/atp_matches_$y.csv" && echo "atp $y" || echo "miss atp $y"
done
for y in $(seq 2015 2025); do
  curl -sf -o "data/tennis/wta_matches_$y.csv" "https://raw.githubusercontent.com/$WTA/main/wta_matches_$y.csv" 2>/dev/null && echo "wta $y" || rm -f "data/tennis/wta_matches_$y.csv"
done
N=$(ls data/tennis/*.csv 2>/dev/null | wc -l | tr -d ' '); echo "downloaded $N CSVs"
if [ "$N" -ge 5 ]; then
  node tennis/tennisFeatureBuilder.js ./data/tennis ./tennis/tennis_serve_index.json && \
  git add tennis/tennis_serve_index.json && git commit -m "Update tennis serve index" && git push && echo "DONE"
else echo "DOWNLOADS FAILED — mirror likely moved."; fi
