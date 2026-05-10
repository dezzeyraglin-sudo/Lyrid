// api/_data/parkFactors.js
// Park factors based on Baseball Savant 3-year rolling PF (2023-2025)
// PF > 100 = hitter-friendly, PF < 100 = pitcher-friendly
// 100 = league average for that metric
// Source: baseballsavant.mlb.com/leaderboard/statcast-park-factors

// Primary lookup: keyed by team abbreviation (reliable + matches our schedule data)
export const PARK_FACTORS_BY_TEAM = {
  // AL East
  NYY: { name: "Yankee Stadium",     runs: 103, hr: 113, hits: 100, so: 99,  bb: 101, lhbHr: 117, rhbHr: 110 },
  BOS: { name: "Fenway Park",        runs: 108, hr: 99,  hits: 106, so: 96,  bb: 100, lhbHr: 97,  rhbHr: 100 },
  TOR: { name: "Rogers Centre",      runs: 102, hr: 105, hits: 100, so: 98,  bb: 100, lhbHr: 103, rhbHr: 107 },
  BAL: { name: "Oriole Park",        runs: 101, hr: 98,  hits: 100, so: 100, bb: 100, lhbHr: 99,  rhbHr: 98  },
  TB:  { name: "Tropicana Field",    runs: 95,  hr: 91,  hits: 97,  so: 103, bb: 99,  lhbHr: 90,  rhbHr: 92  },

  // AL Central
  CLE: { name: "Progressive Field",  runs: 97,  hr: 95,  hits: 98,  so: 101, bb: 100, lhbHr: 94,  rhbHr: 96  },
  DET: { name: "Comerica Park",      runs: 96,  hr: 92,  hits: 99,  so: 101, bb: 100, lhbHr: 91,  rhbHr: 93  },
  KC:  { name: "Kauffman Stadium",   runs: 100, hr: 91,  hits: 102, so: 99,  bb: 99,  lhbHr: 89,  rhbHr: 93  },
  MIN: { name: "Target Field",       runs: 99,  hr: 98,  hits: 100, so: 99,  bb: 99,  lhbHr: 96,  rhbHr: 100 },
  CWS: { name: "Rate Field",         runs: 103, hr: 111, hits: 101, so: 98,  bb: 101, lhbHr: 113, rhbHr: 109 },
  CHW: { name: "Rate Field",         runs: 103, hr: 111, hits: 101, so: 98,  bb: 101, lhbHr: 113, rhbHr: 109 },

  // AL West
  HOU: { name: "Daikin Park",        runs: 100, hr: 105, hits: 99,  so: 100, bb: 100, lhbHr: 110, rhbHr: 101 },
  SEA: { name: "T-Mobile Park",      runs: 94,  hr: 93,  hits: 96,  so: 103, bb: 100, lhbHr: 90,  rhbHr: 95  },
  TEX: { name: "Globe Life Field",   runs: 100, hr: 100, hits: 100, so: 100, bb: 100, lhbHr: 100, rhbHr: 100 },
  LAA: { name: "Angel Stadium",      runs: 98,  hr: 97,  hits: 99,  so: 100, bb: 99,  lhbHr: 95,  rhbHr: 99  },
  ATH: { name: "Sutter Health Park", runs: 102, hr: 106, hits: 101, so: 98,  bb: 100, lhbHr: 104, rhbHr: 107 },
  OAK: { name: "Sutter Health Park", runs: 102, hr: 106, hits: 101, so: 98,  bb: 100, lhbHr: 104, rhbHr: 107 },

  // NL East
  NYM: { name: "Citi Field",         runs: 97,  hr: 95,  hits: 98,  so: 101, bb: 100, lhbHr: 93,  rhbHr: 97  },
  PHI: { name: "Citizens Bank Park", runs: 102, hr: 107, hits: 100, so: 98,  bb: 100, lhbHr: 109, rhbHr: 104 },
  ATL: { name: "Truist Park",        runs: 100, hr: 100, hits: 100, so: 100, bb: 100, lhbHr: 99,  rhbHr: 100 },
  MIA: { name: "loanDepot park",     runs: 95,  hr: 90,  hits: 97,  so: 101, bb: 99,  lhbHr: 88,  rhbHr: 91  },
  WSH: { name: "Nationals Park",     runs: 100, hr: 101, hits: 100, so: 99,  bb: 100, lhbHr: 100, rhbHr: 102 },
  WAS: { name: "Nationals Park",     runs: 100, hr: 101, hits: 100, so: 99,  bb: 100, lhbHr: 100, rhbHr: 102 },

  // NL Central
  CHC: { name: "Wrigley Field",      runs: 101, hr: 102, hits: 100, so: 99,  bb: 100, lhbHr: 101, rhbHr: 103 },
  MIL: { name: "American Family",    runs: 101, hr: 104, hits: 100, so: 99,  bb: 100, lhbHr: 104, rhbHr: 103 },
  CIN: { name: "Great American",     runs: 108, hr: 117, hits: 102, so: 96,  bb: 101, lhbHr: 120, rhbHr: 115 },
  PIT: { name: "PNC Park",           runs: 96,  hr: 93,  hits: 98,  so: 101, bb: 100, lhbHr: 90,  rhbHr: 95  },
  STL: { name: "Busch Stadium",      runs: 97,  hr: 93,  hits: 98,  so: 101, bb: 100, lhbHr: 92,  rhbHr: 94  },

  // NL West
  LAD: { name: "Dodger Stadium",     runs: 100, hr: 104, hits: 99,  so: 100, bb: 100, lhbHr: 103, rhbHr: 105 },
  SF:  { name: "Oracle Park",        runs: 92,  hr: 85,  hits: 95,  so: 102, bb: 99,  lhbHr: 83,  rhbHr: 87  },
  SD:  { name: "Petco Park",         runs: 95,  hr: 92,  hits: 97,  so: 101, bb: 100, lhbHr: 89,  rhbHr: 94  },
  COL: { name: "Coors Field",        runs: 115, hr: 112, hits: 108, so: 92,  bb: 103, lhbHr: 110, rhbHr: 114 },
  ARI: { name: "Chase Field",        runs: 101, hr: 102, hits: 101, so: 99,  bb: 100, lhbHr: 101, rhbHr: 104 }
};

// Empty venueId lookup kept for compatibility with park-factor.js
// (primary lookup is team abbreviation via PARK_FACTORS_BY_TEAM)
export const PARK_FACTORS = {};

// Classify a park factor value into a tier for display
export function classifyPF(value, metric) {
  if (!value || value === 100) return 'neutral';
  const delta = value - 100;
  const threshold = metric === 'hr' ? 8 : 4;
  if (delta >= threshold) return 'hitter-friendly';
  if (delta <= -threshold) return 'pitcher-friendly';
  return 'neutral';
}

// Stadium geography: coordinates, orientation bearing (home plate → CF, compass degrees),
// roof type, and wind exposure factor.
// Bearings measured from satellite imagery; roof type from current league info;
// exposure calibrated from historical wind-HR correlation data (Wrigley is the extreme at 1.5x).
export const PARK_GEO = {
  // AL East
  NYY: { lat: 40.8296, lng: -73.9261, bearing: 73,  roofType: 'open',        exposure: 1.0 },
  BOS: { lat: 42.3467, lng: -71.0972, bearing: 45,  roofType: 'open',        exposure: 1.1 },
  TOR: { lat: 43.6414, lng: -79.3894, bearing: 0,   roofType: 'retractable', exposure: 0.8 },
  BAL: { lat: 39.2838, lng: -76.6215, bearing: 63,  roofType: 'open',        exposure: 1.0 },
  TB:  { lat: 27.7683, lng: -82.6533, bearing: 38,  roofType: 'fixed-dome',  exposure: 0.0 },

  // AL Central
  CLE: { lat: 41.4962, lng: -81.6852, bearing: 0,   roofType: 'open',        exposure: 1.1 },
  DET: { lat: 42.3390, lng: -83.0485, bearing: 150, roofType: 'open',        exposure: 1.0 },
  KC:  { lat: 39.0517, lng: -94.4803, bearing: 45,  roofType: 'open',        exposure: 1.0 },
  MIN: { lat: 44.9817, lng: -93.2776, bearing: 90,  roofType: 'open',        exposure: 1.1 },
  CWS: { lat: 41.8300, lng: -87.6339, bearing: 135, roofType: 'open',        exposure: 1.2 },
  CHW: { lat: 41.8300, lng: -87.6339, bearing: 135, roofType: 'open',        exposure: 1.2 },

  // AL West
  HOU: { lat: 29.7573, lng: -95.3555, bearing: 340, roofType: 'retractable', exposure: 0.8 },
  SEA: { lat: 47.5914, lng: -122.3324, bearing: 45, roofType: 'retractable', exposure: 0.9 },
  TEX: { lat: 32.7473, lng: -97.0847, bearing: 0,   roofType: 'retractable', exposure: 0.7 },
  LAA: { lat: 33.8003, lng: -117.8827, bearing: 45, roofType: 'open',        exposure: 1.0 },
  ATH: { lat: 38.5804, lng: -121.5137, bearing: 90, roofType: 'open',        exposure: 1.1 },  // Sutter Health Park (Sacramento)
  OAK: { lat: 38.5804, lng: -121.5137, bearing: 90, roofType: 'open',        exposure: 1.1 },

  // NL East
  ATL: { lat: 33.8907, lng: -84.4678, bearing: 67,  roofType: 'open',        exposure: 1.0 },
  MIA: { lat: 25.7781, lng: -80.2197, bearing: 62,  roofType: 'retractable', exposure: 0.7 },
  NYM: { lat: 40.7571, lng: -73.8458, bearing: 26,  roofType: 'open',        exposure: 1.1 },
  PHI: { lat: 39.9061, lng: -75.1665, bearing: 25,  roofType: 'open',        exposure: 1.1 },
  WSH: { lat: 38.8730, lng: -77.0074, bearing: 22,  roofType: 'open',        exposure: 1.0 },

  // NL Central
  CHC: { lat: 41.9484, lng: -87.6553, bearing: 37,  roofType: 'open',        exposure: 1.5 },  // Wrigley — massive wind exposure
  CIN: { lat: 39.0974, lng: -84.5069, bearing: 0,   roofType: 'open',        exposure: 1.1 },
  MIL: { lat: 43.0280, lng: -87.9712, bearing: 105, roofType: 'retractable', exposure: 0.9 },
  PIT: { lat: 40.4469, lng: -80.0060, bearing: 0,   roofType: 'open',        exposure: 1.2 },
  STL: { lat: 38.6226, lng: -90.1928, bearing: 67,  roofType: 'open',        exposure: 1.1 },

  // NL West
  ARI: { lat: 33.4453, lng: -112.0667, bearing: 0,  roofType: 'retractable', exposure: 0.7 },
  COL: { lat: 39.7559, lng: -104.9942, bearing: 0,  roofType: 'open',        exposure: 1.3 },  // altitude + open
  LAD: { lat: 34.0736, lng: -118.2400, bearing: 22, roofType: 'open',        exposure: 1.0 },
  SD:  { lat: 32.7076, lng: -117.1569, bearing: 0,  roofType: 'open',        exposure: 1.0 },
  SF:  { lat: 37.7785, lng: -122.3893, bearing: 90, roofType: 'open',        exposure: 1.3 }   // Bay winds
};

export function getParkGeo(teamAbbr) {
  return PARK_GEO[teamAbbr] || null;
}
