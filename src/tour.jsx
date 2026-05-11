/* global window, React, L */
// Tour planner: form + Leaflet map with OpenRouteService routing.
(() => {
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ---------- Full-state persistence ----------
//
// Auto-persist the full Tour Planner state (stops, route, settings, geometry)
// to localStorage on every change, so switching tabs or reloading the page
// returns the user to their last route. The lightweight "ridePrep:tours"
// record is kept in sync as a side effect so Training sees current data
// without requiring an explicit Save click.
const TOUR_STATE_KEY = "ridePrep:tourState";

function loadFullTourState() {
  try {
    const raw = window.localStorage.getItem(TOUR_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ---------- ORS API helpers ----------
const ORS_BASE = "https://api.openrouteservice.org";

async function orsGeocode(query, key) {
  const url = `${ORS_BASE}/geocode/search?api_key=${encodeURIComponent(key)}&text=${encodeURIComponent(query)}&size=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Geocoding failed: ${r.status}`);
  const j = await r.json();
  const f = j.features && j.features[0];
  if (!f) throw new Error(`No results for "${query}"`);
  const [lng, lat] = f.geometry.coordinates;
  return { lng, lat, label: f.properties.label };
}

async function orsReverse(lat, lng, key) {
  const url = `${ORS_BASE}/geocode/reverse?api_key=${encodeURIComponent(key)}&point.lon=${lng}&point.lat=${lat}&size=1&layers=locality,localadmin,county`;
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

// Walk the GeoJSON LineString, split into stages of approx `dailyKm` km.
// Coords from ORS may be [lng, lat, elev] when elevation=true.
async function splitIntoStages(coords, dailyKm, fromLabel, toLabel, key) {
  const dailyM = dailyKm * 1000;
  const stages = [];
  let stageStart = 0;
  let cum = 0;
  let stageCum = 0;
  let stageAscent = 0;
  let lastElev = coords[0][2] ?? 0;
  let totalAscent = 0;
  let totalDist = 0;

  for (let i = 1; i < coords.length; i++) {
    const seg = distMeters(coords[i - 1], coords[i]);
    cum += seg;
    stageCum += seg;
    totalDist += seg;
    const e = coords[i][2] ?? lastElev;
    const climb = Math.max(0, e - lastElev);
    stageAscent += climb;
    totalAscent += climb;
    lastElev = e;

    if (stageCum >= dailyM && i < coords.length - 1) {
      stages.push({ startIdx: stageStart, endIdx: i, km: stageCum / 1000, ascent: stageAscent });
      stageStart = i;
      stageCum = 0;
      stageAscent = 0;
    }
  }
  // Final stage to the very end
  stages.push({
    startIdx: stageStart,
    endIdx: coords.length - 1,
    km: stageCum / 1000,
    ascent: stageAscent,
  });

  // Reverse geocode each split point to get a city name (best effort, parallel).
  const labels = await Promise.all(
    stages.map((s, i) => {
      if (i === stages.length - 1) return Promise.resolve(toLabel);
      const c = coords[s.endIdx];
      return orsReverse(c[1], c[0], key).catch(() => null).then((n) => n || `Waypoint ${i + 1}`);
    })
  );

  let prevLabel = fromLabel;
  const built = stages.map((s, i) => {
    const stage = {
      from: prevLabel,
      to: labels[i],
      km: Math.round(s.km),
      ascent: Math.round(s.ascent),
      hours: estHours(s.km, s.ascent),
      startIdx: s.startIdx,
      endIdx: s.endIdx,
    };
    prevLabel = labels[i];
    return stage;
  });

  return { stages: built, totalKm: Math.round(totalDist / 1000), totalAscent: Math.round(totalAscent) };
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

function makeFakeHotel(cityName, budget) {
  const tier = budget === "low" ? { p: 65, name: "Pension", rate: "4.1★" }
            : budget === "hi"  ? { p: 220, name: "Grand Hotel", rate: "4.7★" }
            :                     { p: 130, name: "Hotel", rate: "4.5★" };
  return { hotel: `${tier.name} ${cityName.split(",")[0]}`, price: `€${tier.p}`, rating: tier.rate };
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
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: true });
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

function TourForm({ stops, setStop, addStop, removeStop, swapEnds, dailyKm, setDailyKm, budget, setBudget, onPlan, onSave, saveFeedback, loading, error }) {
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
                    placeholder="City, country"
                  />
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

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span className="mono faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".1em" }}>Budget</span>
          <span className="mono dim" style={{ fontSize: 12 }}>{budget === "low" ? "€" : budget === "mid" ? "€€" : "€€€"}</span>
        </div>
        <div className="seg">
          {[["low", "Low"], ["mid", "Mid"], ["hi", "High"]].map(([k, v]) => (
            <button key={k} aria-pressed={budget === k} onClick={() => setBudget(k)}>{v}</button>
          ))}
        </div>
        <div className="budget-visual">
          {[0, 1, 2].map((i) => {
            const lvl = { low: 0, mid: 1, hi: 2 }[budget];
            const tier = budget === "low" ? "low" : budget === "mid" ? "mid" : "hi";
            return <div key={i} className={"budget-seg " + (i <= lvl ? "on " + tier : "")} />;
          })}
        </div>
      </div>

      <div className="btn-row">
        <button className="btn btn-primary" onClick={onPlan} disabled={loading} style={{ flex: 1, opacity: loading ? 0.7 : 1 }}>
          {loading ? "Planning…" : "Plan route"}
        </button>
        <button className="btn btn-ghost" onClick={onSave}>Save</button>
      </div>

      {saveFeedback && (
        <div className="save-feedback">{saveFeedback}</div>
      )}

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

// ---------- Itinerary list ----------
function Itinerary({ tour, activeStage, setActiveStage, budget, units }) {
  const { fmtKm, fmtElev } = window.RP_SHARED;
  return (
    <div className="itinerary">
      {(tour.stages || []).map((s, i) => {
        const fake = s.hotel ? null : makeFakeHotel(s.to, budget);
        const hotel = s.hotel ? { hotel: s.hotel, price: s.price, rating: s.rating } : fake;
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
              </div>
              <div className="stage-stats">
                <span><strong>{fmtKm(s.km, units)}</strong></span>
                <span><strong>↑ {fmtElev(s.ascent, units)}</strong></span>
                <span><strong>{s.hours}</strong> hrs</span>
              </div>
              {hotel && (
                <div className="hotel-chip">
                  <div className="hotel-thumb" />
                  <div className="hotel-body">
                    <div className="hotel-name">{hotel.hotel}</div>
                    <div className="hotel-meta">
                      <span>{hotel.rating}</span>
                      <span>{s.to.split(",")[0]}</span>
                    </div>
                  </div>
                  <div className="hotel-price">
                    {hotel.price}
                    <em>/ night</em>
                  </div>
                </div>
              )}
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
  const cost = (tour.stages || []).reduce((sum, s) => {
    const p = s.price ? +String(s.price).replace(/[^\d]/g, "") : 0;
    return sum + p;
  }, 0);

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
      <div className="summary-cell">
        <span className="lbl">Lodging</span>
        <span className="big">€{cost}</span>
      </div>
    </div>
  );
}

// ---------- localStorage persistence ----------
//
// Tour Planner state is local to this component and not shared. The "Save"
// button writes a lightweight record (no geometry) to ridePrep:tours so the
// Training page can read available tours without depending on component state.
//
// Saved record shape:
//   { id, name, from, to, totalKm, totalAscent, stageCount, savedAt }
//
// Tours are identified by from+to — saving the same route overwrites the
// previous entry with the same stable id, keeping Training's tourId reference
// valid across re-saves.
function saveTourToStorage(tour) {
  try {
    const raw = window.localStorage.getItem("ridePrep:tours");
    const list = raw ? JSON.parse(raw) : [];
    const existingIdx = list.findIndex((t) => t.from === tour.from && t.to === tour.to);
    const entry = {
      id: existingIdx >= 0 ? list[existingIdx].id : `tour_${Date.now()}`,
      name: `${tour.from} → ${tour.to}`,
      from: tour.from,
      to: tour.to,
      totalKm: tour.totalKm || 0,
      totalAscent: tour.totalAscent || 0,
      stageCount: (tour.stages || []).length,
      savedAt: Date.now(),
    };
    if (existingIdx >= 0) list[existingIdx] = entry;
    else list.push(entry);
    window.localStorage.setItem("ridePrep:tours", JSON.stringify(list));
    return entry.id;
  } catch { return null; }
}

// ---------- Top-level Tour view ----------
function Tour({ tweaks }) {
  // Load any previously-persisted state once on mount. Subsequent renders
  // reuse the same object via useMemo so the lazy useState initialisers
  // below all see the same snapshot.
  const saved = useMemo(() => loadFullTourState(), []);
  const { DEMO_TOUR: _DT } = window.RP_DATA;
  const defaultStops = [_DT.from, _DT.to];

  const [stops, setStops] = useState(() =>
    (saved && Array.isArray(saved.stops) && saved.stops.length >= 2) ? saved.stops : defaultStops
  );
  const [dailyKm, setDailyKm] = useState(() => (saved && saved.dailyKm) || 120);
  const [budget, setBudget] = useState(() => (saved && saved.budget) || "mid");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeStage, setActiveStage] = useState(0);

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
    const stages = DEMO_TOUR.stages.map((s, i) => ({
      ...s,
      startIdx: i,
      endIdx: i + 1,
    }));
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
  const [saveFeedback, setSaveFeedback] = useState(null);

  // Auto-persist the full state on any change so tab switches and reloads
  // restore the user's tour. Also write the lightweight ridePrep:tours record
  // so Training picks up edits without an explicit Save click.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        TOUR_STATE_KEY,
        JSON.stringify({ tour, geometry, stops, dailyKm, budget })
      );
    } catch {}
    if (tour && tour.from && tour.to && tour.stages && tour.stages.length) {
      saveTourToStorage(tour);
    }
  }, [tour, geometry, stops, dailyKm, budget]);

  const handleSave = useCallback(() => {
    const id = saveTourToStorage(tour);
    setSaveFeedback(id ? "Tour saved!" : "Save failed");
    setTimeout(() => setSaveFeedback(null), 2500);
  }, [tour]);

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
      itin.stages = itin.stages.map((s) => ({
        ...s,
        ...makeFakeHotel(s.to, budget),
      }));

      setTour({
        from: labels[0],
        to: labels[labels.length - 1],
        stops: labels,
        stages: itin.stages,
        totalKm: itin.totalKm,
        totalAscent: itin.totalAscent,
        meters: summary && summary.distance,
        seconds: summary && summary.duration,
      });
      setGeometry(coords);
      setActiveStage(0);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [stops, dailyKm, budget, initialDemo]);

  return (
    <div className="fade-in">
      <SummaryBar tour={tour} units={tweaks.units} />
      <div className="tour-layout">
        <div className="stack" style={{ gap: 16 }}>
          <TourForm
            stops={stops} setStop={setStop} addStop={addStop} removeStop={removeStop} swapEnds={swapEnds}
            dailyKm={dailyKm} setDailyKm={setDailyKm}
            budget={budget} setBudget={setBudget}
            onPlan={planRoute}
            onSave={handleSave}
            saveFeedback={saveFeedback}
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
            budget={budget}
            units={tweaks.units}
          />
        </div>
      </div>
    </div>
  );
}

window.RP_Tour = Tour;
})();
