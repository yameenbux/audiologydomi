"use strict";
// Drive times between patients' homes.
//
// Road routes: full postcodes are geocoded with postcodes.io (free, Ordnance Survey/ONS data), and a routing
// table gives road driving times and distances between every pair of stops. Two routers are supported:
//  - "ors": openrouteservice (HeiGIT, Heidelberg), free Standard plan, commercial use allowed, results
//    CC-BY-SA 4.0 (credited on the map). Needs ORS_API_KEY. Kept inside its daily limits (see ORS_DAILY).
//  - "osrm": an OSRM server (OSRM_URL), e.g. our own; the public demo server is for testing only.
// Only postcode centre points are ever sent, never names or house numbers. Results are cached, requests time out
// after a few seconds, and after a failure the router is left alone for a minute. Whenever a road time isn't
// available, an estimate from straight-line distance is used instead, so booking never waits on a third party.
//
// The rest of the app stays synchronous: callers `await prepare([...postcodes])` before a calculation, and
// `driveMinutes()` then reads the cache.
const { district } = require("./domain");
const { ALL_CENTRES } = require("./regions");

// Approximate district centres, used for district-only postcodes and when a full postcode can't be looked up.
const CENTRES = {
  LS6: [53.825, -1.578], LS7: [53.823, -1.535], LS8: [53.824, -1.505], LS9: [53.801, -1.513],
  LS10: [53.770, -1.535], LS11: [53.776, -1.565], LS12: [53.795, -1.600], LS13: [53.808, -1.640],
  LS14: [53.825, -1.455], LS15: [53.805, -1.450], LS16: [53.860, -1.605], LS17: [53.858, -1.540],
  LS18: [53.840, -1.640], LS26: [53.748, -1.475], LS27: [53.745, -1.600], LS28: [53.795, -1.665],
  ...ALL_CENTRES, // every other region a practice can cover (server/regions.js)
};
// Coordinates of the demo's own postcodes (from postcodes.io), so the sample diary needs no lookups.
const KNOWN = {
  "LS6 4DH": [53.825453, -1.577409], "LS6 4FH": [53.825582, -1.578243], "LS6 4AA": [53.824359, -1.578013],
  "LS16 7SN": [53.859507, -1.606274], "LS16 8DF": [53.854921, -1.586873], "LS16 8DG": [53.855766, -1.586865],
  "LS16 8DE": [53.855552, -1.587232], "LS16 8DU": [53.85459, -1.581982],
  "LS17 7LH": [53.856621, -1.540062], "LS17 7LQ": [53.856575, -1.539682], "LS17 7LG": [53.856589, -1.53877],
  "LS17 7QN": [53.861977, -1.551711], "LS17 7PW": [53.862223, -1.55256],
  "LS8 2RS": [53.822976, -1.505262], "LS8 4AR": [53.82509, -1.508017], "LS8 2JA": [53.825364, -1.504687],
  "LS9 7QL": [53.800409, -1.512481],
  "LS15 8ES": [53.804723, -1.449933], "LS15 8BX": [53.804888, -1.450523], "LS15 7UD": [53.799598, -1.46752], "LS15 7RX": [53.798349, -1.469539],
  "LS12 3TL": [53.794811, -1.600366], "LS12 2AX": [53.80021, -1.588897],
  "LS11 8QU": [53.775384, -1.565651], "LS11 7BQ": [53.771611, -1.556375],
  "LS27 8DW": [53.744891, -1.600536], "LS27 0EW": [53.739824, -1.598553],
};

const SAME_DISTRICT_MIN = 6; // two addresses in one district, exact location unknown
const ROAD_FACTOR = 1.3;     // roads are longer than straight lines
const MIN_PER_KM = 2;        // about 30 km/h across the city
const LONG_KM = 20;          // beyond this a trip is mostly A-roads and motorway...
const LONG_MIN_PER_KM = 1;   // ...at about 60 km/h
const PARK_MIN = 4;          // finding somewhere to park, walking to the door
const TRAFFIC = 1.3;         // OSRM times are free-flowing; daytime Leeds traffic is slower
const TIMEOUT_MS = 3000;
const BACKOFF_MS = 60_000;
const MAX_POINTS = 100;      // OSRM's public server limit for one table request
const ORS_MAX_POINTS = 50;   // openrouteservice: 3,500 pairs a request, so 50 x 50
// openrouteservice Standard plan: matrix 500 a day and 40 a minute, directions 2,000 a day. Domi stops short of
// the daily limits and uses estimates for the rest of the day, so the account is never cut off.
const ORS_DAILY = { matrix: 450, directions: 1800 };

const FULL = /^([A-Z]{1,2}\d[A-Z\d]?) ?(\d[A-Z]{2})$/;
/** "ls64dh" -> "LS6 4DH"; a district stays a district. */
function normalise(pc) {
  const s = String(pc || "").toUpperCase().replace(/\s+/g, "");
  const m = s.match(FULL);
  return m ? `${m[1]} ${m[2]}` : s;
}
const isFull = (pc) => FULL.test(normalise(pc));

const cfg = { provider: "estimate", osrmUrl: "https://router.project-osrm.org", orsUrl: "https://api.openrouteservice.org", orsKey: null, geoUrl: "https://api.postcodes.io", fetch: (...a) => fetch(...a) };
const geo = new Map(Object.entries(KNOWN)); // postcode -> [lat, lon]
const placed = new Map();                   // coordinates given by the app itself (the invented demo addresses)
const invalid = new Set();                  // full postcodes postcodes.io says don't exist
const road = new Map();                     // "A|B" -> minutes by road
const dist = new Map();                     // "A|B" -> km by road, where the router gave it
const status = { roadPairs: 0, lookups: 0, lastOk: null, lastError: null, pausedUntil: 0, used: { day: null, matrix: 0, directions: 0 } };
const routed = () => cfg.provider === "osrm" || (cfg.provider === "ors" && !!cfg.orsKey);
/** Count an openrouteservice request against today's allowance; false when today's is used up. */
function spend(kind) {
  const today = new Date().toISOString().slice(0, 10);
  if (status.used.day !== today) status.used = { day: today, matrix: 0, directions: 0 };
  if (status.used[kind] >= ORS_DAILY[kind]) return false;
  status.used[kind]++;
  return true;
}
const orsInit = (body) => ({ method: "POST", headers: { Authorization: cfg.orsKey, "Content-Type": "application/json", Accept: "application/json, application/geo+json" }, body: JSON.stringify(body) });

const toMinutes = (sec) => Math.round((sec / 60) * TRAFFIC) + PARK_MIN;
// Road times between the demo's own postcodes, fetched from OSRM once and saved (routes-seed.json), so the
// sample diary uses real routes even when the router can't be reached. New postcodes are routed live.
function loadSnapshot() {
  const snap = require("./routes-seed.json");
  snap.durations.forEach((row, i) => row.forEach((sec, j) => { if (i !== j) road.set(snap.postcodes[i] + "|" + snap.postcodes[j], toMinutes(sec)); }));
}
loadSnapshot();
const KNOWN_PAIRS = road.size;

function configure(o = {}) {
  Object.assign(cfg, Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)));
  return cfg;
}
configure({ provider: process.env.ROUTING_PROVIDER, osrmUrl: process.env.OSRM_URL, orsKey: process.env.ORS_API_KEY });

/** Where we think a postcode is: its own coordinates if known, else its district's centre. */
function point(pc) {
  const n = normalise(pc);
  return geo.get(n) || CENTRES[district(n)] || null;
}
const exact = (pc) => geo.has(normalise(pc));

function km([lat1, lon1], [lat2, lon2]) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function estimate(from, to) {
  const a = point(from), b = point(to);
  if (!a || !b) return null;
  if (!(exact(from) && exact(to)) && district(normalise(from)) === district(normalise(to))) return SAME_DISTRICT_MIN;
  const road = km(a, b) * ROAD_FACTOR;
  return Math.round(PARK_MIN + Math.min(road, LONG_KM) * MIN_PER_KM + Math.max(0, road - LONG_KM) * LONG_MIN_PER_KM);
}

/** Drive time and where it came from: { min, source: "road" | "estimate" }, or null if a postcode is unknown. */
function driveInfo(from, to) {
  const r = road.get(normalise(from) + "|" + normalise(to));
  if (r != null) return { min: r, source: "road" };
  const e = estimate(from, to);
  return e == null ? null : { min: e, source: "estimate" };
}
/** Minutes to drive between two postcodes. Null if either is unknown. */
const driveMinutes = (from, to) => { const d = driveInfo(from, to); return d ? d.min : null; };

/** True if we can work out travel for this postcode (a full postcode we've placed, or a known district). */
const known = (pc) => { const n = normalise(pc); return !invalid.has(n) && !!point(n); };

const paused = () => Date.now() < status.pausedUntil;
function failed(err) {
  status.lastError = { at: new Date().toISOString(), message: String(err && err.message || err) };
  status.pausedUntil = Date.now() + BACKOFF_MS;
}
async function getJson(url, init) {
  const res = await cfg.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

/** Look up full postcodes we haven't placed yet (postcodes.io bulk lookup). */
async function geocode(pcs) {
  const todo = [...new Set(pcs.map(normalise))].filter((p) => isFull(p) && !geo.has(p) && !invalid.has(p));
  if (!todo.length || paused()) return;
  try {
    for (let i = 0; i < todo.length; i += 100) {
      const body = await getJson(`${cfg.geoUrl}/postcodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postcodes: todo.slice(i, i + 100) }) });
      for (const { query, result } of body.result || []) {
        if (result) geo.set(normalise(query), [result.latitude, result.longitude]);
        else invalid.add(normalise(query));
      }
      status.lookups += todo.length;
    }
  } catch (err) { failed(err); }
}

/**
 * Make sure road times are cached between every pair of these postcodes. Never throws, and returns
 * quickly when routing is off or paused, so callers can always await it.
 */
async function prepare(pcs) {
  if (!routed()) return;
  const list = [...new Set(pcs.filter(Boolean).map(normalise))];
  await geocode(list);
  const pts = list.filter(exact).slice(0, cfg.provider === "ors" ? ORS_MAX_POINTS : MAX_POINTS);
  const missing = pts.some((a) => pts.some((b) => a !== b && !road.has(a + "|" + b)));
  if (!missing || paused()) return;
  if (cfg.provider === "ors") {
    if (!spend("matrix")) return;
    try {
      const body = await getJson(`${cfg.orsUrl}/v2/matrix/driving-car`, orsInit({ locations: pts.map((p) => { const [lat, lon] = geo.get(p); return [lon, lat]; }), metrics: ["duration", "distance"], units: "km" }));
      if (!Array.isArray(body.durations)) throw new Error("router gave no durations");
      body.durations.forEach((row, i) => row.forEach((sec, j) => {
        if (i === j || sec == null) return;
        road.set(pts[i] + "|" + pts[j], toMinutes(sec));
        const k = body.distances && body.distances[i] && body.distances[i][j];
        if (k != null) dist.set(pts[i] + "|" + pts[j], k);
      }));
      status.roadPairs = road.size;
      status.lastOk = new Date().toISOString();
    } catch (err) { failed(err); }
    return;
  }
  try {
    const coords = pts.map((p) => { const [lat, lon] = geo.get(p); return `${lon},${lat}`; }).join(";");
    const body = await getJson(`${cfg.osrmUrl}/table/v1/driving/${coords}?annotations=duration`);
    if (body.code !== "Ok" || !Array.isArray(body.durations)) throw new Error(`router said ${body.code || "no durations"}`);
    body.durations.forEach((row, i) => row.forEach((sec, j) => {
      if (i !== j && sec != null) road.set(pts[i] + "|" + pts[j], toMinutes(sec));
    }));
    status.roadPairs = road.size;
    status.lastOk = new Date().toISOString();
  } catch (err) { failed(err); }
}

/**
 * The road a car would take through these postcodes, in order, as [[lat, lon], ...], for drawing the route
 * on a map. From OSRM, cached; null when routing is off, paused or fails, and the map draws straight lines.
 */
const paths = new Map();
async function roadPath(pcs) {
  if (!routed() || pcs.length < 2) return null;
  await geocode(pcs);
  const pts = pcs.map(point);
  if (pts.some((p) => !p)) return null;
  const key = pts.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(";");
  if (paths.has(key)) return paths.get(key);
  if (paused()) return null;
  if (cfg.provider === "ors") {
    if (pts.length > ORS_MAX_POINTS || !spend("directions")) return null;
    try {
      const body = await getJson(`${cfg.orsUrl}/v2/directions/driving-car/geojson`, orsInit({ coordinates: pts.map(([lat, lon]) => [lon, lat]) }));
      const f = body.features && body.features[0];
      const line = f ? f.geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]) : null;
      if (line) { paths.set(key, line); if (paths.size > 500) paths.delete(paths.keys().next().value); }
      return line;
    } catch (err) { failed(err); return null; }
  }
  try {
    const body = await getJson(`${cfg.osrmUrl}/route/v1/driving/${pts.map(([lat, lon]) => `${lon},${lat}`).join(";")}?overview=full&geometries=geojson`);
    const line = body.routes && body.routes[0] ? body.routes[0].geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]) : null;
    if (line) { paths.set(key, line); if (paths.size > 500) paths.delete(paths.keys().next().value); }
    return line;
  } catch (err) { failed(err); return null; }
}

/** For the technical view: how drive times are being worked out right now. */
function routingStatus() {
  const ors = cfg.provider === "ors" && !!cfg.orsKey;
  return {
    provider: ors ? "Road routes (openrouteservice) with postcodes.io" : cfg.provider === "osrm" ? "Road routes (OSRM) with postcodes.io" : "Estimates from postcode coordinates",
    live: routed(),
    router: ors ? new URL(cfg.orsUrl).host : cfg.provider === "osrm" ? new URL(cfg.osrmUrl).host : null,
    usedToday: ors ? { ...status.used, limits: ORS_DAILY } : null,
    credit: ors ? "Routes © openrouteservice.org by HeiGIT · map data © OpenStreetMap contributors" : null,
    placedPostcodes: geo.size,
    roadPairs: road.size,
    snapshotPairs: KNOWN_PAIRS,
    lookups: status.lookups,
    lastOk: status.lastOk,
    lastError: status.lastError,
    paused: paused(),
  };
}

/** Testing hook: forget everything learned at runtime. */
function _reset() {
  geo.clear(); Object.entries(KNOWN).forEach(([k, v]) => geo.set(k, v)); placed.forEach((v, k) => geo.set(k, v));
  invalid.clear(); road.clear(); dist.clear(); loadSnapshot();
  Object.assign(status, { roadPairs: 0, lookups: 0, lastOk: null, lastError: null, pausedUntil: 0, used: { day: null, matrix: 0, directions: 0 } });
}

/**
 * Pin a postcode to coordinates without looking it up. The North West demo's patients are invented, with
 * invented postcodes, so they're given places near their district's centre rather than sent to postcodes.io.
 */
function place(pc, coords) { const n = normalise(pc); placed.set(n, coords); geo.set(n, coords); invalid.delete(n); }

/** Where a postcode is, for drawing: { lat, lon, exact } (exact = its own coordinates, not its district's centre). */
function locate(pc) { const p = point(pc); return p ? { lat: p[0], lon: p[1], exact: exact(pc) } : null; }

/** Road miles between two postcodes: the router's distance when it has one, else straight-line distance scaled for roads. */
function miles(from, to) {
  const a = point(from), b = point(to);
  if (!a || !b || normalise(from) === normalise(to)) return 0;
  const k = dist.get(normalise(from) + "|" + normalise(to));
  if (k != null) return Math.round((k / 1.609) * 10) / 10;
  return Math.round((km(a, b) * ROAD_FACTOR / 1.609) * 10) / 10;
}

module.exports = { roadPath, place, driveMinutes, driveInfo, known, normalise, isFull, prepare, geocode, configure, routingStatus, locate, miles, CENTRES, KNOWN, _reset };
