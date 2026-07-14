#!/usr/bin/env bash
# build_tennis_index.sh — rebuild tennis/tennis_serve_index.json. Run from repo root:
#   bash build_tennis_index.sh
# FUTURE-PROOF: tries multiple data mirrors in order (Sackmann's own repo was removed from GitHub,
# which is what broke earlier). If one mirror dies, it falls through to the next automatically.
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p data/tennis; rm -f data/tennis/*.csv

# ATP mirrors, tried in order until one yields enough files. Add more as you find them.
ATP_MIRRORS=(
  "AlexandraMoldovan03/ATP-Tennis-Match-Outcome-Prediction-Using-PySpark-and-Machine-Learning/main"
  "michaelbruen/ATP_Tennis_Project/main"
)
WTA_MIRRORS=(
  "EdwardM1276/Tennis-Performance-Indicator/main"
)

pull () {  # $1=mirror path(owner/repo/branch)  $2=prefix(atp|wta)
  local m="$1" pfx="$2" got=0
  for y in $(seq 2015 2025); do
    if curl -sf -o "data/tennis/${pfx}_matches_$y.csv" "https://raw.githubusercontent.com/$m/${pfx}_matches_$y.csv"; then
      got=$((got+1)); else rm -f "data/tennis/${pfx}_matches_$y.csv"; fi
  done
  echo "$got"
}

echo "== ATP =="
for m in "${ATP_MIRRORS[@]}"; do
  n=$(pull "$m" atp); echo "  $m -> $n files"
  [ "$n" -ge 3 ] && { echo "  using $m"; break; }
done
echo "== WTA =="
for m in "${WTA_MIRRORS[@]}"; do
  n=$(pull "$m" wta); echo "  $m -> $n files"
  [ "$n" -ge 1 ] && break
done

N=$(ls data/tennis/*.csv 2>/dev/null | wc -l | tr -d ' ')
echo "total CSVs: $N"
if [ "$N" -ge 5 ]; then
  node tennis/tennisFeatureBuilder.js ./data/tennis ./tennis/tennis_serve_index.json && \
  git add tennis/tennis_serve_index.json && git commit -m "Update tennis serve index" && git push && echo "DONE - pushed, Vercel will redeploy"
else
  echo "ALL MIRRORS FAILED (N=$N). Find a new tennis_atp fork on GitHub, add it to ATP_MIRRORS, rerun."
fi
