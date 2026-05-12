/* global window, React, ReactDOM, L */
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

function TourForm({ stops, setStop, addStop, removeStop, swapEnds, dailyKm, setDailyKm, startDate, setStartDate, onPlan, onSave, saveFeedback, loading, error }) {
  const todayIso = todayLocalIso();
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
// computeElevationProfile walks a [lng, lat, elev] slice for one stage,
// accumulates Haversine distance, downsamples to ~targetPoints for a
// smooth chart, and reports ascent/descent with a small smoothing window
// to suppress GPS noise. Returns { samples, ascent, descent, max, min,
// totalKm, hasElevation }.
function computeElevationProfile(coords, targetPoints = 200) {
  if (!Array.isArray(coords) || coords.length < 2) {
    return { samples: [], ascent: 0, descent: 0, max: 0, min: 0, totalKm: 0, hasElevation: false };
  }
  const hasElevation = coords.every((c) => Number.isFinite(c && c[2]));
  if (!hasElevation) {
    return { samples: [], ascent: 0, descent: 0, max: 0, min: 0, totalKm: 0, hasElevation: false };
  }
  // Cumulative distance at every raw coord index.
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + distMeters(coords[i - 1], coords[i]);
  }
  const totalM = cum[cum.length - 1];

  // Light smoothing on elevation (5-point moving average) to dampen
  // GPS jitter without erasing real terrain features.
  const elev = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i++) {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(coords.length - 1, i + 2); k++) {
      sum += coords[k][2]; n++;
    }
    elev[i] = sum / n;
  }

  // Downsample to ~targetPoints by walking by equal distance steps.
  const N = Math.max(2, Math.min(targetPoints, coords.length));
  const samples = new Array(N);
  let raw = 0;
  for (let i = 0; i < N; i++) {
    const targetM = (totalM * i) / (N - 1);
    while (raw < cum.length - 1 && cum[raw + 1] < targetM) raw++;
    // Linear interpolate elevation at targetM between raw and raw+1.
    let ele;
    if (raw >= cum.length - 1) {
      ele = elev[cum.length - 1];
    } else {
      const span = cum[raw + 1] - cum[raw];
      const t = span > 0 ? (targetM - cum[raw]) / span : 0;
      ele = elev[raw] + (elev[raw + 1] - elev[raw]) * t;
    }
    samples[i] = { km: targetM / 1000, ele };
  }

  // Ascent / descent on smoothed elevation, raw cadence (more accurate
  // than the downsampled series).
  let ascent = 0, descent = 0, max = -Infinity, min = Infinity;
  for (let i = 0; i < elev.length; i++) {
    if (elev[i] > max) max = elev[i];
    if (elev[i] < min) min = elev[i];
    if (i > 0) {
      const d = elev[i] - elev[i - 1];
      if (d > 0) ascent += d; else descent += -d;
    }
  }

  return {
    samples,
    ascent: Math.round(ascent),
    descent: Math.round(descent),
    max: Math.round(max),
    min: Math.round(min),
    totalKm: Math.round((totalM / 1000) * 10) / 10,
    hasElevation: true,
  };
}

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

    // Cache hit?
    const key = elevCacheKey(stage);
    if (ELEV_CACHE.has(key)) {
      setState({ status: "ready", profile: ELEV_CACHE.get(key), error: null });
      return;
    }

    const run = async () => {
      try {
        let profile = computeElevationProfile(coordsSlice);
        if (!profile.hasElevation && Array.isArray(coordsSlice) && coordsSlice.length >= 2) {
          // Defensive fallback if a future route source omits elevation.
          const enriched = await fetchOpenMeteoElevation(coordsSlice);
          profile = computeElevationProfile(enriched);
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
    ? `${stage.km} km · ↑ ${state.profile.ascent} m · ↓ ${state.profile.descent} m`
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
              <div><span className="lbl">Ascent</span><span className="big">{state.profile.ascent} m</span></div>
              <div><span className="lbl">Descent</span><span className="big">{state.profile.descent} m</span></div>
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
        JSON.stringify({ tour, geometry, stops, dailyKm, startDate })
      );
    } catch {}
    if (tour && tour.from && tour.to && tour.stages && tour.stages.length) {
      saveTourToStorage(tour);
    }
  }, [tour, geometry, stops, dailyKm, startDate]);

  const canDownloadIcs = !!startDate && !!tour && Array.isArray(tour.stages) && tour.stages.length > 0;

  const handleDownloadIcs = useCallback(() => {
    if (!canDownloadIcs || !window.RP_IcsExport) return;
    const fromS = (tour.from || "tour").split(",")[0].trim().replace(/\s+/g, "-");
    const toS = (tour.to || "end").split(",")[0].trim().replace(/\s+/g, "-");
    const filename = `RidePrep-Tour-${fromS}-to-${toS}-${startDate}.ics`;
    window.RP_IcsExport.downloadTourIcs(tour, startDate, filename);
  }, [canDownloadIcs, tour, startDate]);

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
  }, [stops, dailyKm, initialDemo]);

  return (
    <div className="fade-in">
      <SummaryBar tour={tour} units={tweaks.units} />
      <div className="tour-layout">
        <div className="stack" style={{ gap: 16 }}>
          <TourForm
            stops={stops} setStop={setStop} addStop={addStop} removeStop={removeStop} swapEnds={swapEnds}
            dailyKm={dailyKm} setDailyKm={setDailyKm}
            startDate={startDate} setStartDate={setStartDate}
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
})();
