# Underdog CS2 line logger

Snapshots Underdog's CS2 player-prop lines (Kills/Headshots on Maps 1+2) and appends
them to `underdog_lines.jsonl` with a timestamp, so you build real closing-line
history. There is no historical backfill for these lines anywhere — value starts the
day you start logging — so run it on every active slate.

## One-time setup

1. On Underdog's CS2 board, open DevTools → Network → Fetch/XHR, find the
   `lobbies/content/lines` request.
2. Right-click it → **Copy as cURL** → paste into `underdog.curl` in this folder.
3. (Optional, for whole-slate auto-discovery) do the same for the
   `lobbies/scaffolds/matches` request → `underdog_scaffolds.curl`.
4. Gitignore the secrets (the cURL files hold your session token):

   ```bash
   printf 'underdog.curl\nunderdog_scaffolds.curl\nunderdog_lines.jsonl\n' >> ../../.gitignore
   ```

## Run

```bash
node underdogLogger.mjs
# or only your two markets:
node underdogLogger.mjs --stats kills_on_maps_1_2,headshots_on_maps_1_2
```

Each run appends one JSON object per line to `underdog_lines.jsonl`:

```json
{"ts":"2026-06-14T...","book":"underdog","match_id":188233,"game":"AUR vs 9Z",
 "player":"XANTARES","norm":"xantares","team":"AUR","stat":"kills_on_maps_1_2",
 "display":"Kills on Maps 1+2","value":32.5,"higher_price":"-112","lower_price":"-112",
 "higher_payout":"1.0","lower_payout":"1.0","has_alternates":true,"line_id":"..."}
```

Run it again near lock for each slate — the repeated snapshots give you opening→closing
movement, and the latest pre-lock snapshot is your closing line for grading + CLV.

## Maintenance

Underdog's token + geo headers expire. When the logger starts returning `HTTP 401`,
just recapture a fresh **Copy as cURL** into `underdog.curl`. That's the whole loop.
Keep pulls infrequent and polite — this is your own session replayed, under Underdog's
ToS.

## Next

Once you've got a few days of `underdog_lines.jsonl`, the grader joins it to your BDL
projections on `norm` (normalized nickname) + `stat`, and you finally measure real
edge vs the posted price instead of the placeholder line.
