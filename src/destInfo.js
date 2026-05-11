/* global window, fetch, AbortController */
// OpenStreetMap destination info via the Overpass API.
//
// Public API on window.RP_DestInfo:
//   fetchDestinationInfo(lat, lng, radiusM=5000) -> Promise<{hotels, restaurants}>
//   clearCache()
//
// Each item in hotels/restaurants is a plain object with the OSM tags plus
// a `lat`/`lon` (resolved from `center` for ways/relations) and an `id`.
// Callers should render only fields that are actually present — OSM data
// is sparse and we never invent values.
//
// Notes
// - User-Agent: browsers forbid setting this header from fetch(), so we
//   include an identifying comment inside the Overpass QL query body.
// - CORS: overpass-api.de allows browser requests; kumi.systems mirror
//   is tried on failure.
// - Cache: results are kept in sessionStorage keyed by (lat3, lng3, radius)
//   so repeated opens of the same destination don't hit the API.
// - Lazy: callers must only invoke this when the user opens the destination
//   detail view, never preemptively for all stages.

(() => {

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const CACHE_KEY = "ridePrep:destCache:v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

const HOTEL_TAGS = "hotel|guest_house|hostel|motel|bed_and_breakfast|chalet|apartment";
const FOOD_TAGS  = "restaurant|cafe|pub|bar|bistro|fast_food";

function ql(lat, lng, radiusM) {
  // The leading comment identifies Rideprep in Overpass server logs since
  // browsers strip the User-Agent header.
  return `// Rideprep/1.0 (contact@rideprep.app) - destination POIs
[out:json][timeout:25];
(
  node["tourism"~"${HOTEL_TAGS}"](around:${radiusM},${lat},${lng});
  way["tourism"~"${HOTEL_TAGS}"](around:${radiusM},${lat},${lng});
  node["amenity"~"${FOOD_TAGS}"](around:${radiusM},${lat},${lng});
  way["amenity"~"${FOOD_TAGS}"](around:${radiusM},${lat},${lng});
);
out center tags;`;
}

function cacheKeyFor(lat, lng, radiusM) {
  return `${lat.toFixed(3)},${lng.toFixed(3)},${radiusM}`;
}

function readCache() {
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeCache(obj) {
  try { window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch {}
}

function getCached(key) {
  const all = readCache();
  const entry = all[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.data;
}

function setCached(key, data) {
  const all = readCache();
  all[key] = { ts: Date.now(), data };
  // Bound the cache so it can't grow unbounded across sessions.
  const keys = Object.keys(all);
  if (keys.length > 80) {
    // drop the oldest 20 by timestamp
    keys.sort((a, b) => all[a].ts - all[b].ts).slice(0, 20).forEach((k) => delete all[k]);
  }
  writeCache(all);
}

async function postOverpass(endpoint, query, signal) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: query,
    signal,
  });
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  return r.json();
}

function classify(el) {
  const t = el.tags || {};
  if (t.tourism && new RegExp(`^(${HOTEL_TAGS})$`).test(t.tourism)) return "hotel";
  if (t.amenity && new RegExp(`^(${FOOD_TAGS})$`).test(t.amenity)) return "food";
  return null;
}

function normalize(el) {
  const tags = el.tags || {};
  const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
  const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
  return {
    id: `${el.type}/${el.id}`,
    type: el.type,
    lat,
    lon,
    name: tags.name || null,
    tags,
  };
}

function hasWebsite(tags) {
  if (!tags) return false;
  return !!(tags.website || tags["contact:website"] || tags.url);
}

function splitResults(json) {
  const hotels = [];
  const restaurants = [];
  for (const el of json.elements || []) {
    const kind = classify(el);
    if (!kind) continue;
    const item = normalize(el);
    if (!item.name) continue;                 // hide unnamed entries
    if (!hasWebsite(item.tags)) continue;     // require a website tag
    (kind === "hotel" ? hotels : restaurants).push(item);
  }
  // De-dup by name+coord (some places appear as both node and way).
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((it) => {
      const k = `${it.name}|${Math.round((it.lat || 0) * 1000)}|${Math.round((it.lon || 0) * 1000)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return {
    hotels: dedupe(hotels).sort((a, b) => a.name.localeCompare(b.name)),
    restaurants: dedupe(restaurants).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function fetchDestinationInfo(lat, lng, radiusM = 5000) {
  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new Error("fetchDestinationInfo: lat/lng required as numbers");
  }
  const key = cacheKeyFor(lat, lng, radiusM);
  const cached = getCached(key);
  if (cached) return cached;

  const query = ql(lat, lng, radiusM);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);

  let lastErr = null;
  try {
    for (const endpoint of ENDPOINTS) {
      try {
        const json = await postOverpass(endpoint, query, ctrl.signal);
        const result = splitResults(json);
        setCached(key, result);
        return result;
      } catch (e) {
        lastErr = e;
        // Try next mirror unless we were aborted (then bail).
        if (e && e.name === "AbortError") throw e;
      }
    }
    throw lastErr || new Error("Overpass request failed");
  } finally {
    clearTimeout(timer);
  }
}

function clearCache() { writeCache({}); }

window.RP_DestInfo = { fetchDestinationInfo, clearCache };

})();
