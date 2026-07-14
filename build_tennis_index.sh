#!/usr/bin/env bash
# build_tennis_index.sh — place in the Lyrid repo root, then run:  bash build_tennis_index.sh
# Downloads Sackmann ATP+WTA (2015-2025), builds tennis/tennis_serve_index.json, commits it.
# Self-reports every step so if anything fails, the output tells us why.
set -uo pipefail
cd "$(dirname "$0")"

mkdir -p data/tennis
rm -f data/tennis/*.csv

download_repo () {
  repo="$1"; pfx="$2"; br=""
  for cand in master main; do
    code=$(curl -s -o /dev/null -w "%{http_code}" \
      "https://raw.githubusercontent.com/JeffSackmann/$repo/$cand/${pfx}_matches_2023.csv")
    echo "  $repo @ $cand -> HTTP $code"
    if [ "$code" = "200" ]; then br="$cand"; break; fi
  done
  if [ -z "$br" ]; then echo "  !! $repo unreachable on master/main"; return 1; fi
  ok=0
  for y in $(seq 2015 2025); do
    if curl -sf -o "data/tennis/${pfx}_matches_$y.csv" \
        "https://raw.githubusercontent.com/JeffSackmann/$repo/$br/${pfx}_matches_$y.csv"; then
      ok=$((ok+1))
    else
      echo "  miss ${pfx}_matches_$y.csv"
    fi
  done
  echo "  $repo: $ok/11 years downloaded from $br"
}

echo "== ATP =="; download_repo tennis_atp atp || true
echo "== WTA =="; download_repo tennis_wta wta || true

N=$(ls data/tennis/*.csv 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "downloaded $N CSV files total"
echo "header check: $(head -1 data/tennis/atp_matches_2023.csv 2>/dev/null | cut -c1-50)"
echo ""

if [ "$N" -ge 8 ]; then
  echo "building index..."
  if node tennis/tennisFeatureBuilder.js ./data/tennis ./tennis/tennis_serve_index.json; then
    ls -la tennis/tennis_serve_index.json
    git add tennis/tennis_serve_index.json
    git commit -m "Add tennis serve index"
    git push
    echo ""
    echo "DONE — index built and pushed. Vercel will redeploy."
  else
    echo "BUILD FAILED — node error above."
  fi
else
  echo "DOWNLOADS FAILED (N=$N). Check the HTTP codes above:"
  echo "  - all 404 -> raw URL/branch wrong, tell me the codes"
  echo "  - all 000 -> no network / curl blocked"
fi
