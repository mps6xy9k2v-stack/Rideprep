/* global window, React, ReactDOM, L */
// Tour planner: form + Leaflet map with OpenRouteService routing.
(() => {
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ---------- Saved-tour persistence ----------
//
// Storage schema:
//   ridePrep:tours          — lightweight index (array of TourMeta)
//   ridePrep:tour:<id>      — full state per tour (stops, dailyKm, startDate,
//                             tour, geometry). Restored on app load and
//                             when the user clicks a row in Saved Tours.
//
// TourMeta = { id, name, from, to, totalKm, totalAscent, stageCount,
//              startDate, savedAt }
//
// ID is derived from (from, to, startDate) so re-planning the same trip
// updates the same record instead of creating duplicates.
const TOURS_INDEX_KEY = "ridePrep:tours";
const TOUR_BLOB_PREFIX = "ridePrep:tour:";
const LEGACY_TOUR_STATE_KEY = "ridePrep:tourState"; // pre-multi-tour singleton

function slugify(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 32) || "x";
}

function tourIdFor(from, to, startDate) {
  return `${slugify(from)}_${slugify(to)}_${startDate || "nodate"}`;
}

function readToursIndex() {
  try {
    const raw = window.localStorage.getItem(TOURS_INDEX_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writeToursIndex(list) {
  try { window.localStorage.setItem(TOURS_INDEX_KEY, JSON.stringify(list)); } catch {}
}

function readTourBlob(id) {
  try {
    const raw = window.localStorage.getItem(TOUR_BLOB_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeTourBlob(id, blob) {
  try { window.localStorage.setItem(TOUR_BLOB_PREFIX + id, JSON.stringify(blob)); } catch {}
}

function deleteTourBlob(id) {
  try { window.localStorage.removeItem(TOUR_BLOB_PREFIX + id); } catch {}
}

function fmtDe(isoOrNull) {
  if (!isoOrNull) return null;
  const m = String(isoOrNull).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function cityShortLabel(label) {
  return String(label || "").split(",")[0].trim() || "?";
}

function buildTourName(from, to, startDate) {
  const fromS = cityShortLabel(from), toS = cityShortLabel(to);
  const ds = fmtDe(startDate);
  return ds ? `${fromS} → ${toS} (${ds})` : `${fromS} → ${toS}`;
}

// Auto-save: writes both the index entry (or updates an existing one with
// the same ID) and the per-tour blob. Returns the entry ID. Silent — no
// user feedback by design.
function saveTour({ tour, geometry, stops, dailyKm, startDate }) {
  if (!tour || !tour.from || !tour.to) return null;
  const id = tourIdFor(tour.from, tour.to, startDate);
  const stageCount = Array.isArray(tour.stages) ? tour.stages.length : 0;
  const meta = {
    id,
    name: buildTourName(tour.from, tour.to, startDate),
    from: tour.from,
    to: tour.to,
    totalKm: tour.totalKm || 0,
    totalAscent: tour.totalAscent || 0,
    stageCount,
    startDate: startDate || null,
    savedAt: Date.now(),
  };
  const list = readToursIndex();
  const existingIdx = list.findIndex((t) => t.id === id);
  if (existingIdx >= 0) list[existingIdx] = meta;
  else list.push(meta);
  writeToursIndex(list);
  writeTourBlob(id, { tour, geometry, stops, dailyKm, startDate });
  return id;
}

function deleteTour(id) {
  const list = readToursIndex().filter((t) => t.id !== id);
  writeToursIndex(list);
  deleteTourBlob(id);
}

// One-shot migration: a pre-multi-tour install only had the singleton
// "ridePrep:tourState". On first load, lift it into the new per-tour
// schema and remove the legacy key so it doesn't linger.
function migrateLegacyTourState() {
  try {
    const raw = window.localStorage.getItem(LEGACY_TOUR_STATE_KEY);
    if (!raw) return;
    const legacy = JSON.parse(raw);
    if (legacy && legacy.tour && legacy.tour.from && legacy.tour.to) {
      saveTour({
        tour: legacy.tour,
        geometry: legacy.geometry || null,
        stops: legacy.stops || [legacy.tour.from, legacy.tour.to],
        dailyKm: legacy.dailyKm || 120,
        startDate: legacy.startDate || null,
      });
    }
    window.localStorage.removeItem(LEGACY_TOUR_STATE_KEY);
  } catch {}
}

// Returns the full blob of the most recently saved tour, or null when
// there isn't one. Used to seed Tour state on mount.
function loadMostRecentTour() {
  migrateLegacyTourState();
  const list = readToursIndex();
  if (list.length === 0) return null;
  const latest = list.slice().sort((a, b) => b.savedAt - a.savedAt)[0];
  return readTourBlob(latest.id);
}

// ---------- ORS API helpers ----------
const ORS_BASE = "https://api.openrouteservice.org";
// Rideprep currently routes only inside Germany. ORS supports the
// boundary.country filter (ISO 3166-1 alpha-3), so we constrain both
// forward and reverse geocoding and double-check the returned country
// code defensively.
const COUNTRY_CODE_ALPHA3 = "DEU";
const GERMANY_ONLY_MSG = "Rideprep currently supports only addresses in Germany. Please enter a German location.";

async function orsGeocode(query, key) {
  const url = `${ORS_BASE}/geocode/search?api_key=${encodeURIComponent(key)}&text=${encodeURIComponent(query)}&size=1&boundary.country=${COUNTRY_CODE_ALPHA3}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Geocoding failed: ${r.status}`);
  const j = await r.json();
  const f = j.features && j.features[0];
  if (!f) throw new Error(GERMANY_ONLY_MSG);
  // Belt-and-braces: ORS may occasionally fuzz the filter; reject any
  // result whose country code isn't DE / Germany.
  const props = f.properties || {};
  const cc = String(props.country_a || props.country_code || "").toUpperCase();
  const cn = String(props.country || "").toLowerCase();
  if (cc && cc !== "DEU" && cc !== "DE") throw new Error(GERMANY_ONLY_MSG);
  if (!cc && cn && cn !== "germany" && cn !== "deutschland") throw new Error(GERMANY_ONLY_MSG);
  const [lng, lat] = f.geometry.coordinates;
  return { lng, lat, label: props.label };
}

async function orsReverse(lat, lng, key) {
  const url = `${ORS_BASE}/geocode/reverse?api_key=${encodeURIComponent(key)}&point.lon=${lng}&point.lat=${lat}&size=1&layers=locality,localadmin,county&boundary.country=${COUNTRY_CODE_ALPHA3}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const f = j.features && j.features[0];
  if (!f) return null;
  return f.properties.locality || f.properties.name || f.properties.label;
}

async function orsDirections(waypoints, key) {
  const url = `${ORS_BASE}/v2/directions/cycling-regular/geojson`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": key,
      "Content-Type": "application/json",
      "Accept": "application/json, application/geo+json",
    },
    body: JSON.stringify({
      coordinates: waypoints.map((w) => [w.lng, w.lat]),
      elevation: true,
      instructions: false,
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Directions failed: ${r.status} ${text.slice(0, 120)}`);
  }
  return r.json();
}

// Haversine (meters)
function distMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Walk the GeoJSON LineString and split into stages of approx `dailyKm` km.
// Ascent/descent are NOT computed inline — that happens in the second pass
// below via the shared RP_Elevation pipeline so the card, the modal, and
// the summary bar all see the same numbers.
async function splitIntoStages(coords, dailyKm, fromLabel, toLabel, key) {
  const dailyM = dailyKm * 1000;
  const stages = [];
  let stageStart = 0;
  let stageCum = 0;
  let totalDist = 0;

  for (let i = 1; i < coords.length; i++) {
    const seg = distMeters(coords[i - 1], coords[i]);
    stageCum += seg;
    totalDist += seg;
    if (stageCum >= dailyM && i < coords.length - 1) {
      stages.push({ startIdx: stageStart, endIdx: i, km: stageCum / 1000 });
      stageStart = i;
      stageCum = 0;
    }
  }
  stages.push({ startIdx: stageStart, endIdx: coords.length - 1, km: stageCum / 1000 });

  // Reverse geocode each split point to get a city name (best effort, parallel).
  const labels = await Promise.all(
    stages.map((s, i) => {
      if (i === stages.length - 1) return Promise.resolve(toLabel);
      const c = coords[s.endIdx];
      return orsReverse(c[1], c[0], key).catch(() => null).then((n) => n || `Waypoint ${i + 1}`);
    })
  );

  // Second pass: compute elevation via the shared pipeline (resample +
  // smooth + outlier clamp + delta threshold). Stage gets ascent/descent
  // and the chart-ready samples bundled under elevationProfile.
  let prevLabel = fromLabel;
  let totalAscent = 0;
  const built = stages.map((s, i) => {
    const slice = coords.slice(s.startIdx, s.endIdx + 1);
    const profile = window.RP_Elevation
      ? window.RP_Elevation.computeProfile(slice)
      : { totalAscent: 0, totalDescent: 0, max: 0, min: 0, samples: [], hasElevation: false };
    totalAscent += profile.totalAscent;
    const stage = {
      from: prevLabel,
      to: labels[i],
      km: Math.round(s.km),
      ascent: profile.totalAscent,
      descent: profile.totalDescent,
      hours: estHours(s.km, profile.totalAscent),
      startIdx: s.startIdx,
      endIdx: s.endIdx,
      elevationProfile: profile,
    };
    prevLabel = labels[i];
    return stage;
  });

  return { stages: built, totalKm: Math.round(totalDist / 1000), totalAscent };
}

// Split a multi-waypoint route into daily stages, leg by leg.
// `wayPointIdx` is the array of coord indices that ORS returns under
// `properties.way_points` — one entry per requested waypoint.
async function buildItinerary(coords, wayPointIdx, dailyKm, stopLabels, key) {
  const allStages = [];
  let totalKm = 0;
  let totalAscent = 0;

  for (let leg = 0; leg < wayPointIdx.length - 1; leg++) {
    const start = wayPointIdx[leg];
    const end = wayPointIdx[leg + 1];
    const segCoords = coords.slice(start, end + 1);
    if (segCoords.length < 2) continue;

    const split = await splitIntoStages(
      segCoords, dailyKm, stopLabels[leg], stopLabels[leg + 1], key
    );

    // Re-base stage indices to be relative to the full coords array.
    split.stages.forEach((s) => {
      s.startIdx += start;
      s.endIdx += start;
    });

    allStages.push(...split.stages);
    totalKm += split.totalKm;
    totalAscent += split.totalAscent;
  }
  return { stages: allStages, totalKm, totalAscent };
}

function estHours(km, ascent) {
  // ~18 km/h on flat, plus 30s per meter of climbing.
  const h = km / 18 + ascent / 3600 * 0.5;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh}:${String(mm).padStart(2, "0")}`;
}

// ---------- Map subcomponent ----------
function makeTileLayer(style) {
  switch (style) {
    case "cyclosm":
      return L.tileLayer("https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.cyclosm.org">CyclOSM</a> &middot; OSM',
        subdomains: "abc",
      });
    case "light":
      return L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://carto.com/">Carto</a> &middot; OSM',
        subdomains: "abcd",
      });
    case "dark":
      return L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://carto.com/">Carto</a> &middot; OSM',
        subdomains: "abcd",
      });
    case "voyager":
      return L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://carto.com/">Carto</a> &middot; OSM',
        subdomains: "abcd",
      });
    case "osm":
    default:
      return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      });
  }
}

function TourMap({ tour, geometry, mapStyle, activeStage, onPickStage }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const tileRef = useRef(null);
  const layersRef = useRef({ route: null, markers: [] });

  // Init the map once.
  useEffect(() => {
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: true });
    L.control.zoom({ position: "topright" }).addTo(map);
    map.setView([47.6, 11.5], 8);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 60);
    return () => { map.remove(); mapRef.current = null; tileRef.current = null; };
  }, []);

  // Swap the tile layer when the style changes — keep the route + markers intact.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) map.removeLayer(tileRef.current);
    const tile = makeTileLayer(mapStyle);
    tile.addTo(map);
    tileRef.current = tile;
  }, [mapStyle]);

  // Redraw the route + markers when tour/geometry changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear previous
    if (layersRef.current.route) {
      map.removeLayer(layersRef.current.route);
      layersRef.current.route = null;
    }
    layersRef.current.markers.forEach((m) => map.removeLayer(m));
    layersRef.current.markers = [];

    const latlngs = (geometry || []).map((c) => [c[1], c[0]]);
    if (latlngs.length > 1) {
      const line = L.polyline(latlngs, {
        color: "#4cc9f0",
        weight: 5,
        opacity: 0.9,
        lineJoin: "round",
        lineCap: "round",
      }).addTo(map);
      layersRef.current.route = line;
      map.fitBounds(line.getBounds(), { padding: [40, 40] });
    }

    // Stage end markers
    (tour.stages || []).forEach((s, i) => {
      const idx = s.endIdx ?? null;
      const c = idx != null && geometry ? geometry[idx] : null;
      const ll = c ? [c[1], c[0]] : null;
      if (!ll) return;

      const isLast = i === tour.stages.length - 1;
      const html = `<div style="
        width:14px;height:14px;border-radius:50%;
        background:${isLast ? "#f4b860" : "#4cc9f0"};
        border:3px solid #0d1b2a;
        box-shadow:0 0 0 2px ${isLast ? "#f4b860" : "#4cc9f0"}66;
      "></div>`;
      const icon = L.divIcon({ className: "rp-marker", html, iconSize: [20, 20], iconAnchor: [10, 10] });
      const m = L.marker(ll, { icon }).addTo(map);
      m.bindPopup(`<strong>${s.to}</strong><br/>Stage ${i + 1} · ${s.km} km · ${s.ascent} m ascent`);
      m.on("click", () => onPickStage && onPickStage(i));
      layersRef.current.markers.push(m);
    });

    // Start marker
    if (latlngs.length) {
      const start = latlngs[0];
      const html = `<div style="
        width:14px;height:14px;border-radius:50%;
        background:#9bd1a4;border:3px solid #0d1b2a;
        box-shadow:0 0 0 2px #9bd1a466;
      "></div>`;
      const icon = L.divIcon({ className: "rp-marker", html, iconSize: [20, 20], iconAnchor: [10, 10] });
      const m = L.marker(start, { icon }).addTo(map);
      m.bindPopup(`<strong>${tour.from || "Start"}</strong>`);
      layersRef.current.markers.push(m);
    }
  }, [tour, geometry, activeStage, onPickStage]);

  // Highlight active stage
  useEffect(() => {
    const map = mapRef.current;
    if (!map || activeStage == null || !geometry) return;
    const s = tour.stages[activeStage];
    if (!s || s.startIdx == null || s.endIdx == null) return;
    const slice = geometry.slice(s.startIdx, s.endIdx + 1).map((c) => [c[1], c[0]]);
    if (slice.length > 1) {
      const tmp = L.polyline(slice, { color: "#f4b860", weight: 6, opacity: 1 }).addTo(map);
      const t = setTimeout(() => map.removeLayer(tmp), 1600);
      return () => { clearTimeout(t); map.removeLayer(tmp); };
    }
  }, [activeStage, geometry, tour]);

  return (
    <div className="card map-card">
      <div ref={elRef} style={{ width: "100%", height: "100%" }} />
      <div className="map-overlay">
        <span className="dot" />
        <span>{tour.from || "—"} → {tour.to || "—"}</span>
      </div>
      <div className="map-legend">
        <span className="city">Stage end</span>
        <span className="hotel">Destination</span>
      </div>
    </div>
  );
}

// Local-time "today" as YYYY-MM-DD — used as the min for the date picker
// so past dates are non-selectable regardless of the user's timezone.
function todayLocalIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Map a "YYYY-MM-DD" start date + zero-based stage index to a calendar
// Date at local midnight (no UTC parsing — avoids off-by-one near DST/0).
function stageDate(startIso, stageIdx) {
  if (!startIso) return null;
  const m = String(startIso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + stageIdx);
  return d;
}

const STAGE_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric",
});

// ---------- Tour form ----------
function StopMarker({ kind }) {
  // kind: "start" | "mid" | "end"
  const base = {
    width: 12, height: 12, borderRadius: "50%",
    flexShrink: 0,
  };
  if (kind === "start") {
    return <div style={{ ...base, background: "var(--accent)", boxShadow: "0 0 0 3px color-mix(in oklch, var(--accent) 22%, transparent)" }} />;
  }
  if (kind === "end") {
    return <div style={{ ...base, background: "transparent", border: "2px solid var(--accent)" }} />;
  }
  return <div style={{ ...base, background: "var(--bg-1)", border: "2px solid var(--accent)" }} />;
}

// Per-input Germany validator. Debounces calls to orsGeocode and caches
// results by query string in a module-scope Map so the user can type
// fluidly without hammering the API. Returns:
//   stopErrors[i]  -> null when valid/empty, error string otherwise
//   stopChecking[i] -> true while a debounced check is in flight
//   anyInvalid     -> at least one stop has an error (planning disabled)
//   anyChecking    -> at least one stop is mid-flight (planning disabled)
const GEOCODE_VALIDATION_CACHE = new Map();
function useStopValidation(stops) {
  const [stopErrors, setStopErrors] = useState({});
  const [stopChecking, setStopChecking] = useState({});

  useEffect(() => {
    const key = window.__ORS_API_KEY__;
    // Without an API key the app uses the demo route, which doesn't go
    // through ORS — skip validation to avoid a confusing always-invalid UI.
    if (!key) {
      setStopErrors({});
      setStopChecking({});
      return;
    }
    const handles = [];
    const cancellers = [];
    const nextChecking = {};
    stops.forEach((stop, i) => {
      const q = String(stop || "").trim();
      if (!q) {
        setStopErrors((prev) => ({ ...prev, [i]: null }));
        return;
      }
      if (GEOCODE_VALIDATION_CACHE.has(q)) {
        const cached = GEOCODE_VALIDATION_CACHE.get(q);
        setStopErrors((prev) => ({ ...prev, [i]: cached.error }));
        return;
      }
      nextChecking[i] = true;
      let cancelled = false;
      cancellers.push(() => { cancelled = true; });
      const handle = setTimeout(async () => {
        try {
          await orsGeocode(q, key);
          GEOCODE_VALIDATION_CACHE.set(q, { error: null });
          if (!cancelled) {
            setStopErrors((prev) => ({ ...prev, [i]: null }));
            setStopChecking((prev) => { const n = { ...prev }; delete n[i]; return n; });
          }
        } catch (e) {
          const msg = String(e && e.message ? e.message : e);
          GEOCODE_VALIDATION_CACHE.set(q, { error: msg });
          if (!cancelled) {
            setStopErrors((prev) => ({ ...prev, [i]: msg }));
            setStopChecking((prev) => { const n = { ...prev }; delete n[i]; return n; });
          }
        }
      }, 600);
      handles.push(handle);
    });
    setStopChecking(nextChecking);
    return () => {
      handles.forEach(clearTimeout);
      cancellers.forEach((c) => c());
    };
  }, [stops.join("|")]);   // eslint-disable-line react-hooks/exhaustive-deps

  const anyInvalid = stops.some((s, i) => s.trim() && stopErrors[i]);
  const anyChecking = Object.values(stopChecking).some(Boolean);
  return { stopErrors, stopChecking, anyInvalid, anyChecking };
}

// ---------- Saved Tours panel ----------
//
// Lists every auto-saved tour. Clicking a row loads it back into the
// planner without re-routing. The trash icon opens a confirmation modal
// (the same one used everywhere else in the app) before removing the
// index entry AND the per-tour blob. Empty state shown when no tours.
function SavedToursPanel({ savedTours, onLoad, onDelete }) {
  const [confirm, setConfirm] = useState(null); // { id, name } | null
  if (!savedTours || savedTours.length === 0) {
    return (
      <div className="card stack" style={{ gap: 8 }}>
        <div className="card-title">
          <h2>Saved tours</h2>
          <span className="sub">0</span>
        </div>
        <p className="saved-empty">No saved tours yet. Plan your first route below!</p>
      </div>
    );
  }
  // Show most-recently-saved first.
  const sorted = savedTours.slice().sort((a, b) => b.savedAt - a.savedAt);
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="card-title">
        <h2>Saved tours</h2>
        <span className="sub">{savedTours.length}</span>
      </div>
      <ul className="saved-list">
        {sorted.map((t) => (
          <li key={t.id} className="saved-row">
            <button className="saved-load" onClick={() => onLoad(t.id)} title="Load this tour">
              <div className="saved-name">{t.name}</div>
              <div className="saved-stats">
                <span>{Math.round(t.totalKm)} km</span>
                <span>·</span>
                <span>{t.stageCount} {t.stageCount === 1 ? "day" : "days"}</span>
                <span>·</span>
                <span>↑ {Math.round(t.totalAscent)} m</span>
              </div>
            </button>
            <button
              className="saved-trash"
              onClick={() => setConfirm({ id: t.id, name: t.name })}
              aria-label={`Delete ${t.name}`}
              title="Delete this tour"
            >🗑</button>
          </li>
        ))}
      </ul>
      {confirm && (
        <Modal
          title="Delete tour?"
          subtitle={`This cannot be undone.`}
          onClose={() => setConfirm(null)}
          ariaLabel="Confirm tour delete"
        >
          <p style={{ margin: 0, fontSize: 14, color: "var(--fg)" }}>
            Delete <strong>{confirm.name}</strong>?
          </p>
          <div className="plan-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={() => { onDelete(confirm.id); setConfirm(null); }}
            >Delete</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TourForm({ stops, setStop, addStop, removeStop, swapEnds, dailyKm, setDailyKm, startDate, setStartDate, onPlan, loading, error }) {
  const todayIso = todayLocalIso();
  const { stopErrors, stopChecking, anyInvalid, anyChecking } = useStopValidation(stops);
  const planDisabled = loading || anyInvalid || anyChecking;
  return (
    <div className="card stack" style={{ gap: 14 }}>
      <div className="card-title">
        <h2>Plan your tour</h2>
        <span className="sub">Cycling route</span>
      </div>

      <div style={{ display: "grid", gap: 4, position: "relative" }}>
        {stops.map((stop, i) => {
          const isFirst = i === 0;
          const isLast = i === stops.length - 1;
          const kind = isFirst ? "start" : isLast ? "end" : "mid";
          const label = isFirst ? "From" : isLast ? "To" : `Stop ${i}`;
          return (
            <React.Fragment key={i}>
              <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
                <div style={{ width: 16, display: "grid", placeItems: "center" }}>
                  <StopMarker kind={kind} />
                </div>
                <div className="input-field" style={{ flex: 1 }}>
                  <label>{label}</label>
                  <input
                    value={stop}
                    onChange={(e) => setStop(i, e.target.value)}
                    placeholder="German city or address"
                    aria-invalid={stopErrors[i] ? "true" : "false"}
                    aria-describedby={stopErrors[i] ? `stop-err-${i}` : undefined}
                  />
                  {stopErrors[i] && (
                    <div id={`stop-err-${i}`} className="input-error">
                      {stopErrors[i]}
                    </div>
                  )}
                  {!stopErrors[i] && stopChecking[i] && (
                    <div className="input-hint">Checking…</div>
                  )}
                </div>
                {!isFirst && !isLast && (
                  <button
                    onClick={() => removeStop(i)}
                    aria-label={`Remove ${label}`}
                    style={{
                      width: 30, height: 30, alignSelf: "center",
                      borderRadius: "50%", border: "1px solid var(--line)",
                      color: "var(--fg-dim)", fontSize: 16, lineHeight: 1,
                    }}
                  >×</button>
                )}
                {isFirst && stops.length === 2 && (
                  <button
                    className="swap-btn"
                    onClick={swapEnds}
                    aria-label="Swap from/to"
                    style={{ alignSelf: "center", margin: 0 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 10l5-5 5 5M7 14l5 5 5-5"/></svg>
                  </button>
                )}
              </div>

              {i < stops.length - 1 && (
                <div style={{ display: "flex", paddingLeft: 4, height: 14 }}>
                  <button
                    onClick={() => addStop(i)}
                    aria-label="Add a stop here"
                    title="Add a stop here"
                    style={{
                      width: 18, height: 18,
                      borderRadius: "50%",
                      border: "1px dashed var(--line-strong)",
                      color: "var(--fg-dim)",
                      fontSize: 12, lineHeight: 1,
                      display: "grid", placeItems: "center",
                      padding: 0,
                    }}
                  >+</button>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <div className="input-field">
        <label htmlFor="tour-start-date">Event Start Date</label>
        <input
          id="tour-start-date"
          type="date"
          min={todayIso}
          value={startDate || ""}
          onChange={(e) => setStartDate(e.target.value || null)}
        />
      </div>

      <div className="range-row">
        <div className="range-label">
          <span className="tag">Daily distance</span>
          <span className="val">{dailyKm}<em>km/day</em></span>
        </div>
        <input
          type="range"
          min="30" max="160" step="5"
          value={dailyKm}
          onChange={(e) => setDailyKm(+e.target.value)}
        />
      </div>

      <div className="btn-row">
        <button
          className="btn btn-primary"
          onClick={onPlan}
          disabled={planDisabled}
          style={{ flex: 1, opacity: planDisabled ? 0.7 : 1 }}
          title={anyInvalid ? "Fix the highlighted addresses to enable planning" : ""}
        >
          {loading ? "Planning…" : anyChecking ? "Checking addresses…" : "Plan route"}
        </button>
      </div>

      {error && (
        <div style={{
          padding: "10px 12px", borderRadius: 12,
          background: "color-mix(in oklch, var(--danger) 12%, transparent)",
          border: "1px solid color-mix(in oklch, var(--danger) 50%, transparent)",
          fontSize: 12, color: "var(--fg)"
        }}>{error}</div>
      )}

      {!window.__ORS_API_KEY__ && (
        <div className="mono faint" style={{ fontSize: 10, lineHeight: 1.5 }}>
          No ORS API key set — showing demo route.<br/>
          Add your key via <code>window.__ORS_API_KEY__</code> in index.html for real cycling routing.
        </div>
      )}
    </div>
  );
}

// Shared modal shell. Three responsibilities:
//   1) Portal into document.body so position:fixed isn't trapped by an
//      ancestor's transform/filter/perspective (e.g. .fade-in's keyframes).
//   2) Body scroll-lock + Esc-to-close + autofocus close button.
//   3) Standard head/body grid so children only render their content.
function Modal({ title, subtitle, onClose, ariaLabel, children }) {
  const closeBtnRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current && closeBtnRef.current.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return ReactDOM.createPortal(
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={ariaLabel || title}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="modal-sub">{subtitle}</p>}
          </div>
          <button ref={closeBtnRef} className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Destination detail modal ----------
//
// Lazy-loads hotels and restaurants within `radiusM` of (lat, lng) via
// the Overpass API on mount. Reuses the existing .modal-overlay / .modal
// CSS so it matches the glossary modal visually. The fetch result is
// cached in sessionStorage by window.RP_DestInfo so reopening the same
// destination doesn't hit the API again.
function DestinationModal({ cityLabel, lat, lng, onClose }) {
  const [radiusM, setRadiusM] = useState(5000);
  const [retryNonce, setRetryNonce] = useState(0);
  const [state, setState] = useState({ status: "loading", data: null, error: null });

  useEffect(() => {
    if (!window.RP_DestInfo) {
      setState({ status: "error", data: null, error: "Destination service unavailable." });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", data: null, error: null });
    window.RP_DestInfo
      .fetchDestinationInfo(lat, lng, radiusM)
      .then((data) => { if (!cancelled) setState({ status: "ready", data, error: null }); })
      .catch((e) => {
        if (cancelled) return;
        const msg = e && e.name === "AbortError"
          ? "The destination service took too long to respond. Please try again."
          : "Couldn't load destination info right now — please try again in a moment.";
        setState({ status: "error", data: null, error: msg });
      });
    return () => { cancelled = true; };
  }, [lat, lng, radiusM, retryNonce]);

  const cityShort = String(cityLabel || "").split(",")[0].trim() || "destination";
  const radiusKm = Math.round(radiusM / 1000);

  const subtitle = (
    <>Hotels and restaurants within {radiusKm} km · data © <a
      href="https://www.openstreetmap.org/copyright"
      target="_blank" rel="noopener noreferrer"
    >OpenStreetMap contributors</a></>
  );

  return (
    <Modal title={cityShort} subtitle={subtitle} onClose={onClose} ariaLabel="Destination info">
      {state.status === "loading" && <DestSkeleton />}
      {state.status === "error" && (
        <div className="dest-error">
          <p>{state.error}</p>
          <button className="btn btn-ghost" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button>
        </div>
      )}
      {state.status === "ready" && (
        <>
          <DestSection
            title="Hotels"
            items={state.data.hotels}
            emptyLabel={`No hotels with website info found within ${radiusKm} km of ${cityShort}. Try checking local tourism resources.`}
            radiusM={radiusM}
            onExpand={() => setRadiusM(10000)}
          />
          <DestSection
            title="Restaurants"
            items={state.data.restaurants}
            emptyLabel={`No restaurants with website info found within ${radiusKm} km of ${cityShort}. Try checking local tourism resources.`}
            radiusM={radiusM}
            onExpand={() => setRadiusM(10000)}
          />
        </>
      )}
    </Modal>
  );
}

function DestSkeleton() {
  return (
    <div className="dest-skeleton" aria-busy="true">
      <div className="dest-skel-row" />
      <div className="dest-skel-row" />
      <div className="dest-skel-row" />
    </div>
  );
}

function DestSection({ title, items, emptyLabel, radiusM, onExpand }) {
  // Final defense: even if upstream slipped, the rendered list never contains
  // a row without a resolvable website. The count badge reflects the
  // *rendered* count, not the raw count, so it can never mismatch.
  const wv = window.RP_DestInfo && window.RP_DestInfo.websiteValue;
  const visible = wv ? items.filter((it) => wv(it.tags) != null) : items;
  if (visible.length !== items.length) {
    try { console.log("[destInfo] DestSection", title, "trimmed", items.length - visible.length, "rows missing a website"); } catch {}
  }
  return (
    <section className="dest-section">
      <h3>{title} <span className="dest-count">{visible.length}</span></h3>
      {visible.length === 0 ? (
        <div className="dest-empty">
          <p>{emptyLabel}</p>
          {radiusM < 10000 && (
            <button className="btn btn-ghost" onClick={onExpand}>Search wider (10 km)</button>
          )}
        </div>
      ) : (
        <ul className="dest-list">
          {visible.map((it) => <DestRow key={it.id} item={it} />)}
        </ul>
      )}
    </section>
  );
}

// Renders only fields that OSM actually provided. We never invent values.
// The destInfo filter guarantees a website tag is present — phone/email are
// intentionally not displayed even when OSM has them.
function DestRow({ item }) {
  const t = item.tags || {};
  const meta = [];
  const kind = t.tourism || t.amenity;
  if (kind) meta.push(prettyKind(kind));
  if (t.cuisine)         meta.push(t.cuisine.replace(/_/g, " ").replace(/;/g, ", "));
  if (t.stars)           meta.push(`${t.stars}★`);
  if (t["addr:city"] || t["addr:street"]) meta.push(formatAddress(t));

  // Use the same lookup destInfo uses for filtering, so a row that passed
  // the filter always renders a link. Defensive guard: if no link comes
  // back (shouldn't happen post-filter), don't render the row at all.
  const website = window.RP_DestInfo && window.RP_DestInfo.websiteValue
    ? window.RP_DestInfo.websiteValue(t)
    : (t.website || t["contact:website"] || t.url || t["contact:url"]);
  if (!website) return null;

  return (
    <li className="dest-row">
      <div className="dest-main">
        <div className="dest-name">{item.name}</div>
        {meta.length > 0 && <div className="dest-meta">{meta.join(" · ")}</div>}
      </div>
      <div className="dest-links">
        <a href={absUrl(website)} target="_blank" rel="noopener noreferrer">Website</a>
      </div>
    </li>
  );
}

function prettyKind(k) {
  return ({
    hotel: "Hotel", guest_house: "Guest house", hostel: "Hostel",
    motel: "Motel", bed_and_breakfast: "B&B", chalet: "Chalet",
    apartment: "Apartment",
    restaurant: "Restaurant", cafe: "Café", pub: "Pub", bar: "Bar",
    bistro: "Bistro", fast_food: "Fast food",
  }[k]) || k;
}

function formatAddress(t) {
  const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
  const city = [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ");
  return [street, city].filter(Boolean).join(", ");
}

function absUrl(u) {
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u}`;
}

// ---------- Tour day detail (elevation profile) ----------
//
// Elevation math lives in src/elevation.js (window.RP_Elevation) so the
// stage card, the tour-day modal subtitle, and the elevation chart all
// consume the exact same numbers. See that file for the resample +
// smooth + clamp + threshold pipeline.

// Open-Meteo elevation fallback. Only used when the route geometry lacks
// the third (elevation) component — current ORS responses include it,
// so this is defensive. Samples coords to ~150 lat/lon pairs and makes
// one batched GET. No API key required.
async function fetchOpenMeteoElevation(coords, samples = 150) {
  const step = Math.max(1, Math.floor(coords.length / samples));
  const picked = [];
  for (let i = 0; i < coords.length; i += step) picked.push(coords[i]);
  if (picked[picked.length - 1] !== coords[coords.length - 1]) picked.push(coords[coords.length - 1]);
  const lats = picked.map((c) => c[1]).join(",");
  const lngs = picked.map((c) => c[0]).join(",");
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Elevation API ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.elevation) || j.elevation.length !== picked.length) {
    throw new Error("Elevation API returned unexpected shape");
  }
  // Splice the elevations back as a [lng, lat, ele] series spread across
  // the same total distance as the input.
  return picked.map((c, i) => [c[0], c[1], j.elevation[i]]);
}

// In-memory cache for per-stage profiles. Keyed by stage indices so
// reopening the same day's modal is instant.
const ELEV_CACHE = new Map();
function elevCacheKey(stage) {
  return `${stage && stage.startIdx}-${stage && stage.endIdx}-${stage && stage.km}`;
}

function Section({ title, children }) {
  return (
    <section className="dest-section tour-day-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function ElevationChart({ samples, height = 220 }) {
  const wrapRef = useRef(null);
  const [tip, setTip] = useState(null);   // {x, km, ele}
  const [w, setW] = useState(560);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0].contentRect.width;
      if (cw > 0) setW(cw);
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  if (!samples || samples.length < 2) {
    return <div className="elev-empty">Elevation data unavailable for this stage.</div>;
  }

  const pad = { top: 14, right: 14, bottom: 26, left: 40 };
  const innerW = Math.max(80, w - pad.left - pad.right);
  const innerH = Math.max(80, height - pad.top - pad.bottom);

  const xs = samples.map((s) => s.km);
  const ys = samples.map((s) => s.ele);
  const xMin = xs[0], xMax = xs[xs.length - 1];
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  // Pad vertical range so flat profiles aren't a hairline.
  if (yMax - yMin < 50) { yMax += 25; yMin -= 25; }

  const sx = (km) => pad.left + ((km - xMin) / (xMax - xMin)) * innerW;
  const sy = (ele) => pad.top + (1 - (ele - yMin) / (yMax - yMin)) * innerH;

  // Build SVG path: line for the curve, separate filled area to bottom.
  const linePath = samples.map((s, i) => `${i === 0 ? "M" : "L"}${sx(s.km).toFixed(2)},${sy(s.ele).toFixed(2)}`).join("");
  const areaPath = linePath
    + `L${sx(xMax).toFixed(2)},${(pad.top + innerH).toFixed(2)}`
    + `L${sx(xMin).toFixed(2)},${(pad.top + innerH).toFixed(2)}Z`;

  // Y gridlines: 4 even ticks, rounded to a nice 10m/50m/100m increment.
  const niceStep = (range) => {
    const raw = range / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / pow;
    const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
    return step * pow;
  };
  const step = niceStep(yMax - yMin);
  const yTicks = [];
  for (let t = Math.ceil(yMin / step) * step; t <= yMax; t += step) yTicks.push(t);

  const dense = w >= 400;
  const xTickCount = dense ? 5 : 3;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => xMin + ((xMax - xMin) * i) / (xTickCount - 1));

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPx = ((e.clientX - rect.left) / rect.width) * w;
    if (xPx < pad.left || xPx > pad.left + innerW) { setTip(null); return; }
    const km = xMin + ((xPx - pad.left) / innerW) * (xMax - xMin);
    // Find nearest sample
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; (samples[m].km < km ? lo = m : hi = m); }
    const pick = Math.abs(samples[lo].km - km) < Math.abs(samples[hi].km - km) ? samples[lo] : samples[hi];
    setTip({ x: sx(pick.km), y: sy(pick.ele), km: pick.km, ele: pick.ele });
  };
  const onLeave = () => setTip(null);

  return (
    <div className="elev-chart-wrap" ref={wrapRef}>
      <svg
        className="elev-chart"
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        width="100%" height={height}
        onPointerMove={onMove} onPointerLeave={onLeave}
        role="img" aria-label="Elevation profile"
      >
        {/* y gridlines + labels */}
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={pad.left} x2={pad.left + innerW} y1={sy(t)} y2={sy(t)} className="elev-grid" />
            <text x={pad.left - 6} y={sy(t)} dy="0.32em" className="elev-axis" textAnchor="end">{Math.round(t)} m</text>
          </g>
        ))}
        {/* area + line */}
        <path d={areaPath} className="elev-area" />
        <path d={linePath} className="elev-line" />
        {/* x ticks */}
        {xTicks.map((t, i) => (
          <text key={`x${i}`} x={sx(t)} y={height - 8} className="elev-axis" textAnchor="middle">
            {t.toFixed(t > 100 ? 0 : 1)} km
          </text>
        ))}
        {/* hover guide */}
        {tip && (
          <>
            <line x1={tip.x} x2={tip.x} y1={pad.top} y2={pad.top + innerH} className="elev-guide" />
            <circle cx={tip.x} cy={tip.y} r="4" className="elev-dot" />
          </>
        )}
      </svg>
      {tip && (
        <div className="elev-tip" style={{ left: `${(tip.x / w) * 100}%` }}>
          {tip.km.toFixed(1)} km · {Math.round(tip.ele)} m
        </div>
      )}
    </div>
  );
}

function TourDayModal({ stage, stageIdx, coordsSlice, onClose }) {
  const [state, setState] = useState({ status: "loading", profile: null, error: null });
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", profile: null, error: null });

    // Prefer the profile already computed at route-build time so the
    // numbers shown here are byte-identical to the tour card.
    if (stage && stage.elevationProfile && stage.elevationProfile.hasElevation) {
      setState({ status: "ready", profile: stage.elevationProfile, error: null });
      return;
    }

    // Cache hit (older tour state restored from localStorage)?
    const key = elevCacheKey(stage);
    if (ELEV_CACHE.has(key)) {
      setState({ status: "ready", profile: ELEV_CACHE.get(key), error: null });
      return;
    }

    const compute = (coords) => window.RP_Elevation.computeProfile(coords);

    const run = async () => {
      try {
        let profile = compute(coordsSlice);
        if (!profile.hasElevation && Array.isArray(coordsSlice) && coordsSlice.length >= 2) {
          // Defensive fallback if a future route source omits elevation.
          const enriched = await fetchOpenMeteoElevation(coordsSlice);
          profile = compute(enriched);
        }
        if (cancelled) return;
        ELEV_CACHE.set(key, profile);
        setState({ status: "ready", profile, error: null });
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error", profile: null,
          error: "Couldn't load elevation profile — please try again.",
        });
      }
    };
    run();
    return () => { cancelled = true; };
  }, [stage, coordsSlice, retryNonce]);

  const dayLabel = `Day ${stageIdx + 1} — ${cityShort(stage.from)} → ${cityShort(stage.to)}`;
  const subtitle = state.profile
    ? `${stage.km} km · ↑ ${state.profile.totalAscent} m · ↓ ${state.profile.totalDescent} m`
    : `${stage.km} km · ↑ ${stage.ascent || 0} m`;

  return (
    <Modal title={dayLabel} subtitle={subtitle} onClose={onClose} ariaLabel="Tour day details">
      <Section title="Elevation Profile">
        {state.status === "loading" && <div className="elev-skeleton" aria-busy="true" />}
        {state.status === "error" && (
          <div className="dest-error">
            <p>{state.error}</p>
            <button className="btn btn-ghost" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button>
          </div>
        )}
        {state.status === "ready" && (
          <>
            <ElevationChart samples={state.profile.samples} />
            <div className="elev-stats">
              <div><span className="lbl">Ascent</span><span className="big">{state.profile.totalAscent} m</span></div>
              <div><span className="lbl">Descent</span><span className="big">{state.profile.totalDescent} m</span></div>
              <div><span className="lbl">Highest</span><span className="big">{state.profile.max} m</span></div>
              <div><span className="lbl">Lowest</span><span className="big">{state.profile.min} m</span></div>
            </div>
          </>
        )}
      </Section>
      {/* Future sections (weather, POIs along route, road surface) can
          slot in here as additional <Section> blocks. */}
    </Modal>
  );
}

function cityShort(label) {
  return String(label || "").split(",")[0].trim() || "?";
}

// ---------- Itinerary list ----------
function Itinerary({ tour, activeStage, setActiveStage, units, startDate, geometry, onOpenDest, onOpenDay }) {
  const { fmtKm, fmtElev } = window.RP_SHARED;
  return (
    <div className="itinerary">
      {(tour.stages || []).map((s, i) => {
        const d = stageDate(startDate, i);
        const dateLabel = d ? STAGE_DATE_FMT.format(d) : null;
        const coord = (geometry && s.endIdx != null) ? geometry[s.endIdx] : null;
        const hasCoord = Array.isArray(coord) && coord.length >= 2
          && Number.isFinite(coord[0]) && Number.isFinite(coord[1]);
        const hasStageGeometry = geometry && s.startIdx != null && s.endIdx != null
          && s.endIdx > s.startIdx;
        return (
          <div
            key={i}
            className={"stage" + (activeStage === i ? " active" : "")}
            onClick={() => setActiveStage(i)}
          >
            <div className="stage-num">{i + 1}</div>
            <div className="stage-body">
              <div className="stage-route">
                <span>{s.from}</span>
                <span className="arrow">→</span>
                <span>{s.to}</span>
                {dateLabel && <span className="stage-date">{dateLabel}</span>}
              </div>
              <div className="stage-stats">
                <span><strong>{fmtKm(s.km, units)}</strong></span>
                <span><strong>↑ {fmtElev(s.ascent, units)}</strong></span>
                <span><strong>{s.hours}</strong> hrs</span>
              </div>
              <div className="stage-actions">
                <button
                  type="button"
                  className="btn btn-ghost stage-day-btn"
                  disabled={!hasStageGeometry}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!hasStageGeometry) return;
                    onOpenDay({ stageIdx: i });
                  }}
                  title={hasStageGeometry ? "" : "Route geometry not available for this stage"}
                >
                  Find out more about your tour day
                </button>
                <button
                  type="button"
                  className="btn btn-ghost stage-dest-btn"
                  disabled={!hasCoord}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!hasCoord) return;
                    onOpenDest({
                      cityLabel: s.to,
                      lat: coord[1],
                      lng: coord[0],
                    });
                  }}
                  title={hasCoord ? "" : "Coordinates not available for this stage"}
                >
                  Find out more about your destination
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Summary bar ----------
function SummaryBar({ tour, units }) {
  const { fmtKm, fmtElev } = window.RP_SHARED;
  const totalKm = tour.totalKm ?? (tour.stages || []).reduce((a, b) => a + b.km, 0);
  const totalAsc = tour.totalAscent ?? (tour.stages || []).reduce((a, b) => a + b.ascent, 0);
  const days = (tour.stages || []).length;

  return (
    <div className="summary-bar">
      <div className="summary-cell">
        <span className="lbl">Total</span>
        <span className="big">{fmtKm(totalKm, units)}</span>
      </div>
      <div className="summary-cell">
        <span className="lbl">Days</span>
        <span className="big">{days}</span>
      </div>
      <div className="summary-cell">
        <span className="lbl">Ascent</span>
        <span className="big">{fmtElev(totalAsc, units)}</span>
      </div>
    </div>
  );
}

// The lightweight saveTourToStorage that pre-existed here has been
// replaced by saveTour() at the top of this file, which writes both the
// index entry and the full per-tour blob (so Saved Tours can restore a
// trip without re-routing). Auto-save is wired in planRoute below.

// ---------- Top-level Tour view ----------
function Tour({ tweaks }) {
  // Load the most recently saved tour on mount. saveTour() writes both
  // the lightweight index and a full per-tour blob, so a returning user
  // lands on their last planned trip with route, stages, and chart all
  // intact (no re-routing required). Legacy ridePrep:tourState payloads
  // are migrated into the new schema on first read.
  const saved = useMemo(() => loadMostRecentTour(), []);
  const { DEMO_TOUR: _DT } = window.RP_DATA;
  const defaultStops = [_DT.from, _DT.to];

  const [stops, setStops] = useState(() =>
    (saved && Array.isArray(saved.stops) && saved.stops.length >= 2) ? saved.stops : defaultStops
  );
  const [dailyKm, setDailyKm] = useState(() => (saved && saved.dailyKm) || 120);
  const [startDate, setStartDate] = useState(() => {
    const persisted = saved && saved.startDate;
    if (!persisted) return null;
    return persisted < todayLocalIso() ? null : persisted;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeStage, setActiveStage] = useState(0);
  const [destView, setDestView] = useState(null);   // { cityLabel, lat, lng } | null
  const [dayView, setDayView] = useState(null);     // { stageIdx } | null

  const setStop = useCallback((i, value) => {
    setStops((prev) => prev.map((s, idx) => (idx === i ? value : s)));
  }, []);
  const addStop = useCallback((afterIdx) => {
    setStops((prev) => {
      const next = [...prev];
      next.splice(afterIdx + 1, 0, "");
      return next;
    });
  }, []);
  const removeStop = useCallback((i) => {
    setStops((prev) => (prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev));
  }, []);
  const swapEnds = useCallback(() => {
    setStops((prev) => {
      const next = [...prev];
      [next[0], next[next.length - 1]] = [next[next.length - 1], next[0]];
      return next;
    });
  }, []);

  // Demo geometry (just connect the demo waypoints) when no API key
  const { DEMO_TOUR } = window.RP_DATA;
  const initialDemo = useCallback(() => {
    const wps = DEMO_TOUR.waypoints;
    const geom = wps.map((w) => [w.lng, w.lat, 0]);
    const stages = DEMO_TOUR.stages.map((s, i) => {
      const end = wps[i + 1] || wps[wps.length - 1];
      return {
        ...s,
        startIdx: i,
        endIdx: i + 1,
        lat: end ? end.lat : null,
        lng: end ? end.lng : null,
      };
    });
    return {
      from: DEMO_TOUR.from,
      to: DEMO_TOUR.to,
      stages,
      totalKm: stages.reduce((a, b) => a + b.km, 0),
      totalAscent: stages.reduce((a, b) => a + b.ascent, 0),
      _geom: geom,
    };
  }, [DEMO_TOUR]);

  const [tour, setTour] = useState(() => (saved && saved.tour) || initialDemo());
  const [geometry, setGeometry] = useState(() => (saved && saved.geometry) || initialDemo()._geom);
  // Index of saved tours mirrored in component state so the Saved Tours
  // panel re-renders when an auto-save lands or a delete happens.
  const [savedTours, setSavedTours] = useState(() => readToursIndex());

  // Cross-tab live updates: another tab / window deleting a tour or
  // saving one should reflect here without a manual reload.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === TOURS_INDEX_KEY) setSavedTours(readToursIndex());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const canDownloadIcs = !!startDate && !!tour && Array.isArray(tour.stages) && tour.stages.length > 0;

  const handleDownloadIcs = useCallback(() => {
    if (!canDownloadIcs || !window.RP_IcsExport) return;
    const fromS = (tour.from || "tour").split(",")[0].trim().replace(/\s+/g, "-");
    const toS = (tour.to || "end").split(",")[0].trim().replace(/\s+/g, "-");
    const filename = `RidePrep-Tour-${fromS}-to-${toS}-${startDate}.ics`;
    window.RP_IcsExport.downloadTourIcs(tour, startDate, filename);
  }, [canDownloadIcs, tour, startDate]);

  // Saved Tours actions exposed to the panel built in commit 3 below.
  const handleLoadTour = useCallback((id) => {
    const blob = readTourBlob(id);
    if (!blob || !blob.tour) return;
    if (Array.isArray(blob.stops) && blob.stops.length >= 2) setStops(blob.stops);
    if (typeof blob.dailyKm === "number") setDailyKm(blob.dailyKm);
    setStartDate(blob.startDate || null);
    setTour(blob.tour);
    setGeometry(blob.geometry || []);
    setActiveStage(0);
  }, []);
  const handleDeleteTour = useCallback((id) => {
    deleteTour(id);
    setSavedTours(readToursIndex());
  }, []);

  const planRoute = useCallback(async () => {
    const key = window.__ORS_API_KEY__;
    setError(null);
    setLoading(true);
    try {
      const cleanStops = stops.map((s) => s.trim()).filter(Boolean);
      if (cleanStops.length < 2) {
        throw new Error("Need at least a From and To.");
      }

      if (!key) {
        const t = initialDemo();
        setTour({ ...t, from: cleanStops[0], to: cleanStops[cleanStops.length - 1] });
        setGeometry(t._geom);
        setError("No API key set — using demo route. Set window.__ORS_API_KEY__ to use real routing.");
        return;
      }

      const geo = await Promise.all(cleanStops.map((s) => orsGeocode(s, key)));
      const labels = geo.map((g, i) => g.label || cleanStops[i]);
      const fc = await orsDirections(geo, key);
      const feature = fc.features && fc.features[0];
      if (!feature) throw new Error("No route returned");
      const coords = feature.geometry.coordinates;
      const summary = feature.properties && feature.properties.summary;
      let wayPointIdx = feature.properties && feature.properties.way_points;
      if (!wayPointIdx || wayPointIdx.length !== geo.length) {
        wayPointIdx = [0, coords.length - 1];
      }

      const itin = await buildItinerary(coords, wayPointIdx, dailyKm, labels, key);
      itin.stages = itin.stages.map((s) => {
        const c = coords[s.endIdx];
        return {
          ...s,
          lat: c ? c[1] : null,
          lng: c ? c[0] : null,
        };
      });

      const nextTour = {
        from: labels[0],
        to: labels[labels.length - 1],
        stops: labels,
        stages: itin.stages,
        totalKm: itin.totalKm,
        totalAscent: itin.totalAscent,
        meters: summary && summary.distance,
        seconds: summary && summary.duration,
      };
      setTour(nextTour);
      setGeometry(coords);
      setActiveStage(0);
      // Auto-save: silent, no toast. The Saved Tours panel re-renders
      // because we mirror the index in component state below.
      saveTour({
        tour: nextTour,
        geometry: coords,
        stops: labels,
        dailyKm,
        startDate,
      });
      setSavedTours(readToursIndex());
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [stops, dailyKm, startDate, initialDemo]);

  return (
    <div className="fade-in">
      <SummaryBar tour={tour} units={tweaks.units} />
      <div className="tour-layout">
        <div className="stack" style={{ gap: 16 }}>
          <SavedToursPanel
            savedTours={savedTours}
            onLoad={handleLoadTour}
            onDelete={handleDeleteTour}
          />
          <TourForm
            stops={stops} setStop={setStop} addStop={addStop} removeStop={removeStop} swapEnds={swapEnds}
            dailyKm={dailyKm} setDailyKm={setDailyKm}
            startDate={startDate} setStartDate={setStartDate}
            onPlan={planRoute}
            loading={loading}
            error={error}
          />
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <TourMap
            tour={tour}
            geometry={geometry}
            mapStyle={tweaks.mapStyle}
            activeStage={activeStage}
            onPickStage={setActiveStage}
          />
          <Itinerary
            tour={tour}
            activeStage={activeStage}
            setActiveStage={setActiveStage}
            units={tweaks.units}
            startDate={startDate}
            geometry={geometry}
            onOpenDest={setDestView}
            onOpenDay={setDayView}
          />
          <div className="plan-actions">
            <button
              className="btn btn-ghost download-ics-btn"
              onClick={handleDownloadIcs}
              disabled={!canDownloadIcs}
              title={
                !startDate ? "Pick an Event Start Date to enable calendar export"
                : !tour || !tour.stages || tour.stages.length === 0 ? "Plan a route first"
                : "Import into Apple Calendar, Google Calendar, Outlook, etc."
              }
            >
              <span aria-hidden="true">⬇</span> Add Tour to Calendar (.ics)
            </button>
          </div>
        </div>
      </div>
      {destView && (
        <DestinationModal
          cityLabel={destView.cityLabel}
          lat={destView.lat}
          lng={destView.lng}
          onClose={() => setDestView(null)}
        />
      )}
      {dayView && tour && tour.stages && tour.stages[dayView.stageIdx] && (
        <TourDayModal
          stage={tour.stages[dayView.stageIdx]}
          stageIdx={dayView.stageIdx}
          coordsSlice={geometry && tour.stages[dayView.stageIdx].endIdx != null
            ? geometry.slice(
                tour.stages[dayView.stageIdx].startIdx,
                tour.stages[dayView.stageIdx].endIdx + 1
              )
            : []}
          onClose={() => setDayView(null)}
        />
      )}
    </div>
  );
}

window.RP_Tour = Tour;
// Expose the saved-tour storage helpers so other tabs (Weather) can
// resolve a saved-tour id to its full blob (stages with lat/lng,
// startDate, geometry) without reaching into localStorage directly.
window.RP_TourStorage = {
  readToursIndex,
  readTourBlob,
  saveTour,
  deleteTour,
  TOURS_INDEX_KEY,
  TOUR_BLOB_PREFIX,
};
})();
