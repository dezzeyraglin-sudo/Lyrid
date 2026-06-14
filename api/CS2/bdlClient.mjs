// lib/cs2/bdlClient.mjs
// BALLDONTLIE CS2 client. Same Authorization header + cursor pagination you
// already use for WNBA. Endpoints used here are GOAT-gated (matches, match_maps,
// player_match_map_stats) — during the 48h trial they all work but you're capped
// at 5 req/min, so the rate limiter below defaults to that. When you convert to
// paid GOAT, set BDL_REQ_PER_MIN=600 and nothing else changes.
//
// SECURITY: the key is read from process.env.BDL_API_KEY only. Never hard-code it,
// never commit it, keep .env in .gitignore. (Rotate immediately if it ever leaks.)

const BASE = "https://api.balldontlie.io";

export class RateLimiter {
  // Simple min-interval throttle with a little jitter. Requests are awaited
  // serially through here so we never burst past the per-minute cap.
  constructor(reqPerMin) {
    this.minIntervalMs = Math.ceil(60000 / reqPerMin);
    this.last = 0;
  }
  async wait() {
    const now = Date.now();
    const earliest = this.last + this.minIntervalMs;
    if (now < earliest) {
      const jitter = Math.floor(Math.random() * 250);
      await sleep(earliest - now + jitter);
    }
    this.last = Date.now();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BdlCs2Client {
  constructor({
    apiKey = process.env.BDL_API_KEY,
    reqPerMin = Number(process.env.BDL_REQ_PER_MIN || 5),
    maxRetries = 5,
    onLog = () => {},
  } = {}) {
    if (!apiKey) {
      throw new Error(
        "BDL_API_KEY missing. Put it in .env (and .gitignore that file)."
      );
    }
    this.apiKey = apiKey;
    this.limiter = new RateLimiter(reqPerMin);
    this.maxRetries = maxRetries;
    this.log = onLog;
    this.reqCount = 0;
  }

  async request(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        // BDL array params use the key[]=a&key[]=b convention.
        const key = k.endsWith("[]") ? k : `${k}[]`;
        for (const item of v) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }

    let attempt = 0;
    for (;;) {
      await this.limiter.wait();
      this.reqCount++;
      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: this.apiKey },
        });
      } catch (err) {
        // network hiccup — treat like a retryable error
        if (attempt++ >= this.maxRetries) throw err;
        const backoff = 1000 * 2 ** attempt;
        this.log(`net error, retry in ${backoff}ms: ${err.message}`);
        await sleep(backoff);
        continue;
      }

      if (res.ok) return res.json();

      // 429 (rate limit) and 5xx are retryable; honor Retry-After if present.
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        attempt++;
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** attempt;
        this.log(`HTTP ${res.status}, retry ${attempt}/${this.maxRetries} in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      const body = await res.text().catch(() => "");
      throw new Error(`BDL ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
  }

  /** Async generator over a cursor-paginated endpoint, yielding each row. */
  async *paginate(path, params = {}, perPage = 100) {
    let cursor = undefined;
    for (;;) {
      const page = await this.request(path, { ...params, per_page: perPage, cursor });
      for (const row of page.data ?? []) yield row;
      const next = page.meta?.next_cursor;
      if (next == null) break;
      cursor = next;
    }
  }

  // ---- endpoint helpers ----

  /** Matches on the given dates (YYYY-MM-DD[]). GOAT-gated. */
  async *matchesOnDates(dates, { tournamentIds, teamIds } = {}) {
    yield* this.paginate("/cs/v1/matches", {
      dates,
      tournament_ids: tournamentIds,
      team_ids: teamIds,
    });
  }

  /** Maps for a set of match ids. GOAT-gated. Not paginated in practice. */
  async matchMaps(matchIds) {
    const out = [];
    // chunk to keep the URL sane
    for (const chunk of chunked(matchIds, 40)) {
      const page = await this.request("/cs/v1/match_maps", { match_ids: chunk });
      out.push(...(page.data ?? []));
    }
    return out;
  }

  /** Per-player stats for one map. GOAT-gated. One call per match_map_id. */
  async playerMatchMapStats(matchMapId) {
    const page = await this.request("/cs/v1/player_match_map_stats", {
      match_map_id: matchMapId,
    });
    return page.data ?? [];
  }

  /** Valve world rankings. ALL-STAR gated (works during GOAT trial). */
  async rankings() {
    const page = await this.request("/cs/v1/rankings");
    return page.data ?? [];
  }

  async tournaments() {
    const out = [];
    for await (const t of this.paginate("/cs/v1/tournaments")) out.push(t);
    return out;
  }
}

export function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Inclusive list of YYYY-MM-DD strings between from and to. */
export function dateRange(from, to) {
  const out = [];
  const d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
