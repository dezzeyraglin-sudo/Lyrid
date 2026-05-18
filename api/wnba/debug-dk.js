// api/wnba/debug-dk.js
//
// DEBUG ENDPOINT — DraftKings reachability test
// (May 18, 2026)
//
// Tests whether Vercel can reach DraftKings' internal sportsbook API from
// production. We have NO public docs to rely on — DK's API is undocumented
// but well-known in the analytics community.
//
// WHAT THIS TESTS:
//   1. The "event group" endpoint (lists all WNBA games + markets)
//   2. Response time (slow = potential rate limiting)
//   3. Response shape (so we know what to parse later)
//   4. Whether player props markets show up in the response
//
// KNOWN ENDPOINTS:
//   /sites/US-SB/api/v5/eventgroups/{groupId}        — events + main markets
//   /sites/US-SB/api/v5/eventgroups/{groupId}/categories/{categoryId}/subcategories/{subId}
//                                                     — player props detail
//
// WNBA event group ID is typically 94682 (verified against multiple public
// trackers as of 2025-2026 season; subject to change).
//
// PLAYER PROP CATEGORY IDs (when they appear):
//   1215 — points
//   1216 — rebounds
//   1217 — assists
//
// We'll return enough raw response data to understand the shape without
// being huge (~10KB cap).

const DK_BASE = "https://sportsbook-nash.draftkings.com";

// Headers — DK's API doesn't require auth but some browsers/networks need
// these to avoid being blocked. We mimic a standard browser request.
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://sportsbook.draftkings.com/",
  "Origin": "https://sportsbook.draftkings.com"
};

const WNBA_EVENT_GROUP_ID = 94682;

async function fetchDk(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    const status = res.status;
    const text = await res.text();
    const duration = Date.now() - start;
    let parsed = null, parseErr = null;
    try { parsed = JSON.parse(text); } catch (e) { parseErr = e.message; }
    return {
      status,
      statusText: res.statusText,
      duration,
      size: text.length,
      parsed,
      parseErr,
      // First 3KB of raw response for inspection
      rawPreview: text.slice(0, 3000)
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      error: err.message,
      errorName: err.name,
      duration: Date.now() - start
    };
  }
}

export default async function handler(req, res) {
  try {
    const startedAt = Date.now();

    // PRIMARY TEST: WNBA event group
    const url = `${DK_BASE}/sites/US-SB/api/v5/eventgroups/${WNBA_EVENT_GROUP_ID}?format=json`;
    const result = await fetchDk(url);

    // If primary failed, no point digging deeper
    if (result.error || result.status !== 200) {
      return res.status(200).json({
        ok: false,
        stage: 'event_group_fetch',
        url,
        result,
        durationMs: Date.now() - startedAt
      });
    }

    // ANALYZE: what's in the response
    const parsed = result.parsed;
    let summary = {
      topLevelKeys: parsed ? Object.keys(parsed) : null
    };

    if (parsed?.eventGroup) {
      summary.eventGroupKeys = Object.keys(parsed.eventGroup);
      summary.eventGroupName = parsed.eventGroup.name;
      summary.eventCount = parsed.eventGroup.events?.length ?? 0;

      // Sample one event so we know how to parse them
      if (parsed.eventGroup.events?.length > 0) {
        const sampleEvent = parsed.eventGroup.events[0];
        summary.sampleEvent = {
          eventId: sampleEvent.eventId,
          name: sampleEvent.name,
          startDate: sampleEvent.startDate,
          teamShortName1: sampleEvent.teamShortName1,
          teamShortName2: sampleEvent.teamShortName2,
          eventStatus: sampleEvent.eventStatus,
          // Other fields we might need
          allEventKeys: Object.keys(sampleEvent)
        };
      }

      // Offer categories — these tell us which markets are available
      // (game lines vs player props vs alternate lines etc.)
      if (Array.isArray(parsed.eventGroup.offerCategories)) {
        summary.offerCategories = parsed.eventGroup.offerCategories.map(c => ({
          categoryId: c.offerCategoryId,
          name: c.name,
          // First-level subcategory names so we can identify points/rebounds/assists
          subcategoryNames: (c.offerSubcategoryDescriptors || []).map(s => ({
            id: s.subcategoryId,
            name: s.name
          }))
        }));
      }
    }

    return res.status(200).json({
      ok: true,
      url,
      result: {
        status: result.status,
        duration: result.duration,
        size: result.size
      },
      summary,
      // Include raw preview ONLY if user asks (it's large)
      rawPreview: req.url?.includes('raw=1') ? result.rawPreview : null,
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      stage: 'handler',
      error: err.message,
      stack: err.stack?.slice(0, 1000)
    });
  }
}
