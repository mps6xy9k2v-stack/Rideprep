/* global window, React */
// Weather tab — stage-by-stage forecasts for a saved tour.
// Layout: narrow tour-picker column on the left; on the right a schematic
// route map, a horizontal stages strip, and a detail panel for the
// selected stage. Within 16 days uses Open-Meteo Forecast; beyond that
// falls back to a 10-year monthly climatology from the Archive API.
(() => {

const { useState, useEffect, useMemo } = React;
const FORECAST_HORIZON_DAYS = 16;
const CACHE_TTL_MS = 15 * 60 * 1000;
const TOURS_KEY = "ridePrep:tours";
const CACHE_KEY = "weather:cache:v2";
const CLIMATE_YEARS = 10;
const MIDPOINT_KM_THRESHOLD = 50;

// ---------- Helpers ----------
function ymd(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function readTours() {
  try {
    const arr = JSON.parse(localStorage.getItem(TOURS_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function readNumber(key, fallback) {
  const v = localStorage.getItem(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function daysBetween(a, b) {
  return Math.round((new Date(ymd(b)) - new Date(ymd(a))) / 86400000);
}
function fmtDow(date) {
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(date).getDay()];
}
function fmtLongDate(date) {
  const d = new Date(date);
  return `${fmtDow(d)} ${d.getDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]}`;
}
function fmtFullDate(date) {
  const d = new Date(date);
  return `${fmtDow(d).toUpperCase()} ${d.getDate()} ${["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()]} ${d.getFullYear()}`;
}
function fmtClock(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function monthName(m) {
  return ["January","February","March","April","May","June","July","August","September","October","November","December"][m];
}

// Great-circle distance in km between two (lat, lng) points.
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const c = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(c));
}

// Initial bearing in degrees from a → b (0 = N, 90 = E, 180 = S, 270 = W).
function bearingDeg(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function midpoint(a, b) {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

// ---------- Open-Meteo ----------
async function fetchForecast(lat, lng) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", lat);
  u.searchParams.set("longitude", lng);
  u.searchParams.set("daily", "weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset");
  u.searchParams.set("hourly", "temperature_2m,weathercode,precipitation_probability,precipitation,wind_speed_10m,wind_direction_10m");
  u.searchParams.set("forecast_days", String(FORECAST_HORIZON_DAYS));
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("wind_speed_unit", "kmh");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Forecast ${r.status}`);
  return r.json();
}

async function fetchArchiveMonth(lat, lng, year, month) {
  const start = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const end = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const u = new URL("https://archive-api.open-meteo.com/v1/archive");
  u.searchParams.set("latitude", lat);
  u.searchParams.set("longitude", lng);
  u.searchParams.set("start_date", start);
  u.searchParams.set("end_date", end);
  u.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max");
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("wind_speed_unit", "kmh");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Archive ${r.status}`);
  return r.json();
}

// Multi-year monthly climatology. Pulls the same calendar month for the
// last CLIMATE_YEARS completed years in parallel, then averages.
async function fetchClimateMonthly(lat, lng, year, month) {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear - CLIMATE_YEARS; y < currentYear; y++) years.push(y);
  const results = await Promise.all(
    years.map((yr) => fetchArchiveMonth(lat, lng, yr, month).catch(() => null))
  );
  const valid = results.filter(Boolean);
  if (!valid.length) throw new Error("Archive returned no data");
  const mean = (arr) => {
    const xs = arr.filter((v) => v != null && !Number.isNaN(v));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const sum = (arr) => arr.filter((v) => v != null).reduce((a, b) => a + b, 0);
  const yearStats = valid.map((j) => {
    const d = j.daily || {};
    return {
      meanHigh: mean(d.temperature_2m_max || []),
      meanLow: mean(d.temperature_2m_min || []),
      monthRainMm: sum(d.precipitation_sum || []),
      rainDayFrac: (d.precipitation_sum || []).length
        ? (d.precipitation_sum || []).filter((v) => v >= 1).length / d.precipitation_sum.length
        : null,
      windKmh: mean(d.wind_speed_10m_max || []),
    };
  });
  return {
    meanHigh: mean(yearStats.map((y) => y.meanHigh)),
    meanLow: mean(yearStats.map((y) => y.meanLow)),
    monthRainMm: mean(yearStats.map((y) => y.monthRainMm)),
    rainDayFrac: mean(yearStats.map((y) => y.rainDayFrac)),
    windKmh: mean(yearStats.map((y) => y.windKmh)),
    yearsCovered: valid.length,
    yearsStart: years[0],
    yearsEnd: years[years.length - 1],
  };
}

// ---------- Cache ----------
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); }
  catch { return {}; }
}
function writeCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
}
function cacheKey(stopIdx, dateStr, tourId) { return `${tourId}:${stopIdx}:${dateStr}`; }

// ---------- Germany silhouette ----------
// Hand-tuned ~60-vertex outline of Germany, clockwise from the
// Danish-border tip on the North Sea. Detail level matches a schematic
// map — recognisable shape, no internal features.
const DE_OUTLINE = [
  [54.83, 8.32], [54.83, 9.43], [54.42, 10.10], [54.07, 10.78],
  [54.10, 11.45], [54.18, 12.10], [54.43, 12.71], [54.31, 13.10],
  [54.55, 13.43], [54.40, 13.79], [54.07, 13.97], [53.88, 14.29],
  [53.65, 14.27], [53.16, 14.41], [52.84, 14.13], [52.40, 14.55],
  [51.96, 14.74], [51.50, 15.05], [51.16, 14.99], [50.88, 14.83],
  [50.94, 14.31], [50.61, 13.55], [50.36, 12.50], [50.18, 12.21],
  [49.66, 12.42], [49.13, 13.40], [48.77, 13.84], [48.58, 13.45],
  [48.40, 12.80], [47.69, 12.74], [47.55, 12.13], [47.40, 10.97],
  [47.50, 10.18], [47.55, 9.74], [47.66, 9.04], [47.71, 8.62],
  [47.66, 7.84], [47.55, 7.59], [48.96, 8.22], [49.15, 7.06],
  [49.30, 6.74], [49.45, 6.36], [49.97, 6.11], [50.32, 6.13],
  [50.50, 6.02], [50.85, 5.99], [51.27, 6.08], [51.59, 6.10],
  [51.84, 6.13], [51.86, 6.69], [52.21, 6.96], [52.45, 7.07],
  [52.65, 6.71], [52.95, 7.06], [53.32, 7.06], [53.42, 7.20],
  [53.55, 7.51], [53.71, 7.86], [53.87, 8.13], [54.00, 8.85],
  [54.21, 8.86], [54.50, 8.74], [54.71, 8.59],
];

// Equirectangular projection at a given centre latitude (preserves
// aspect well enough for a country-scale schematic). Returns SVG-space
// coordinates where x grows east and y grows south.
function makeProjector(midLat) {
  const k = Math.cos((midLat * Math.PI) / 180);
  const SCALE = 100;
  return (lat, lng) => ({ x: lng * k * SCALE, y: -lat * SCALE });
}

// ---------- Wind classification ----------
// Open-Meteo's wind direction is the direction the wind is COMING FROM,
// so the direction the wind blows toward is +180°. We compare that to
// the travel bearing in the rider's frame (rider always facing "up").
function classifyWind(travelBearing, windFromDeg, speedKmh) {
  const windTo = (windFromDeg + 180) % 360;
  let rel = windTo - travelBearing;
  // Normalize to [-180, 180].
  while (rel > 180) rel -= 360;
  while (rel <= -180) rel += 360;
  const absRel = Math.abs(rel);
  let kind;
  if (absRel <= 45) kind = "tail";
  else if (absRel >= 135) kind = "head";
  else kind = "cross";
  let tier;
  if (speedKmh < 10) tier = 0;
  else if (speedKmh < 20) tier = 1;
  else if (speedKmh < 30) tier = 2;
  else tier = 3;
  return { kind, tier, rel, speed: speedKmh };
}

function windColor(kind, tier) {
  // gray at tier 0 regardless of direction; tailwind shades green;
  // headwind and crosswind shade through yellow → orange → red.
  if (tier === 0) return "var(--fg-faint)";
  if (kind === "tail") {
    if (tier === 1) return "color-mix(in oklch, var(--ok) 55%, var(--bg))";
    if (tier === 2) return "var(--ok)";
    return "color-mix(in oklch, var(--ok) 70%, #1c5b35)";
  }
  if (tier === 1) return "color-mix(in oklch, var(--warm) 60%, var(--bg))";
  if (tier === 2) return "color-mix(in oklch, var(--warm) 65%, var(--danger))";
  return "var(--danger)";
}

function windLabel(kind, tier) {
  const strength = tier === 0 ? "Calm" : tier === 1 ? "Light" : tier === 2 ? "Moderate" : "Strong";
  if (tier === 0) return "Calm winds";
  const dir = kind === "tail" ? "tailwind" : kind === "head" ? "headwind" : "crosswind";
  return `${strength} ${dir}`;
}

// ---------- Headline generation ----------
function makeHeadline(daily, hourly) {
  const code = daily.weathercode;
  const { conditionForCode } = window;
  const wet = hourly.filter((h) => (h.precip ?? 0) >= 0.3 || (h.prob ?? 0) >= 60);
  const totalMm = daily.precipitation_sum || 0;
  if (!wet.length) {
    if (code === 0) return "Clear skies, dry all day";
    if (code <= 2) return "Mostly sunny, no rain expected";
    if (code === 3) return "Overcast but dry";
    if (code === 45 || code === 48) return "Foggy and damp, no rain in the forecast";
    return `${conditionForCode(code)} and dry`;
  }
  const hours = wet.map((h) => h.hour).sort((a, b) => a - b);
  const first = hours[0], last = hours[hours.length - 1];
  const span = wet.length;
  const intensity = totalMm > 10 ? "heavy rain" : totalMm > 3 ? "steady rain" : "light rain";
  if (first <= 6 && last >= 18) return `${cap(intensity)} much of the day`;
  if (first <= 8 && last <= 12) return `${cap(intensity)} in the morning, drier later`;
  if (first >= 14) return `Dry until afternoon, then ${span}h of ${intensity}`;
  if (first >= 11 && last <= 17) return `${cap(intensity)} through the afternoon`;
  return `${span}h of ${intensity} between ${pad2(first)}:00 and ${pad2(last + 1)}:00`;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function pad2(n) { return String(n).padStart(2, "0"); }

// ---------- Stages-strip summary line ----------
function shortSummary(daily, hourly) {
  const totalMm = daily.precipitation_sum || 0;
  if (totalMm < 0.5) return "Dry";
  const wet = hourly.filter((h) => (h.precip ?? 0) >= 0.3 || (h.prob ?? 0) >= 60);
  if (!wet.length) return totalMm < 1 ? "Trace of rain" : `${Math.round(totalMm)} mm`;
  const hours = wet.map((h) => h.hour).sort((a, b) => a - b);
  const first = hours[0], last = hours[hours.length - 1];
  if (last - first + 1 >= 9) return `Rain most of the day · ${Math.round(totalMm)} mm`;
  return `Rain ${pad2(first)}–${pad2(last + 1)}h · ${Math.round(totalMm)} mm`;
}

// ---------- Pieces ----------
function WindArrow({ deg = 0, color = "var(--fg)", size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${deg}deg)`, color }} aria-hidden>
      <path d="M12 3l5 7h-3v11h-4V10H7z" fill="currentColor" />
    </svg>
  );
}

function RouteMap({ stops, cache, activeIdx, onPick, tour }) {
  const { iconForCode, IconCloud } = window;
  const located = stops.filter((s) => s.lat != null && s.lng != null);
  if (located.length < 1) {
    return (
      <div className="wx2-map empty">
        <span>No stage coordinates yet — re-plan the route in the Tour Planner.</span>
      </div>
    );
  }

  const midLat = located.reduce((s, p) => s + p.lat, 0) / located.length;
  const project = makeProjector(midLat);
  const proj = located.map((s) => project(s.lat, s.lng));

  // Mid-stage anchors (where straight-line stage > 50 km).
  const mids = [];
  for (let i = 1; i < located.length; i++) {
    const a = located[i - 1], b = located[i];
    if (haversineKm(a, b) > MIDPOINT_KM_THRESHOLD) {
      const m = midpoint(a, b);
      mids.push({ stageIdx: i, p: project(m.lat, m.lng), code: cache[cacheKey(stops.indexOf(b), b.date, tour.id)] });
    }
  }

  // viewBox bounds with 10% padding.
  const all = [...proj, ...mids.map((m) => m.p)];
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  let minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxX - minX < 5) { minX -= 5; maxX += 5; }
  if (maxY - minY < 5) { minY -= 5; maxY += 5; }
  const padX = (maxX - minX) * 0.1 + 4;
  const padY = (maxY - minY) * 0.15 + 4;
  minX -= padX; maxX += padX; minY -= padY; maxY += padY;
  const viewBox = `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
  const span = Math.max(maxX - minX, maxY - minY);
  const pinR = span * 0.025;
  const midR = span * 0.013;
  const iconPx = Math.max(10, span * 0.022);
  const fontMain = span * 0.018;
  const fontSub = span * 0.014;

  const countryPath = (() => {
    const pts = DE_OUTLINE.map(([lat, lng]) => project(lat, lng));
    return pts.map((p, i) => (i === 0 ? `M${p.x.toFixed(2)} ${p.y.toFixed(2)}` : `L${p.x.toFixed(2)} ${p.y.toFixed(2)}`)).join(" ") + " Z";
  })();
  const routePath = proj.map((p, i) => (i === 0 ? `M${p.x.toFixed(2)} ${p.y.toFixed(2)}` : `L${p.x.toFixed(2)} ${p.y.toFixed(2)}`)).join(" ");

  return (
    <div className="wx2-map">
      <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
        <path className="wx2-country" d={countryPath} />
        <path className="wx2-route" d={routePath} strokeWidth={span * 0.0045} />
        {mids.map((m, i) => {
          const s = stops[m.stageIdx];
          const entry = m.code;
          const code = entry && entry.daily ? entry.daily.weathercode : null;
          const isClimate = s.kind === "climate";
          const Icon = code != null ? iconForCode(code) : null;
          const icSize = midR * 1.5;
          return (
            <g key={`mid-${i}`} className={"wx2-mid" + (isClimate ? " climate" : "")} transform={`translate(${m.p.x}, ${m.p.y})`}>
              <circle r={midR} className="wx2-mid-circle" />
              {Icon && (
                <g transform={`translate(${-icSize / 2}, ${-icSize / 2})`} style={{ color: code >= 50 ? "var(--accent)" : "var(--warm)" }}>
                  <Icon size={icSize} />
                </g>
              )}
            </g>
          );
        })}
        {located
          .map((s, i) => ({ s, i, stopIdx: stops.indexOf(s) }))
          .sort((a, b) => (a.stopIdx === activeIdx ? 1 : 0) - (b.stopIdx === activeIdx ? 1 : 0))
          .map(({ s, i, stopIdx }) => {
            const entry = cache[cacheKey(stopIdx, s.date, tour.id)];
            const daily = entry && entry.daily;
            const climate = entry && entry.climate;
            const code = daily ? daily.weathercode : (climate ? 3 : null);
            const Icon = code != null ? iconForCode(code) : IconCloud;
            const isActive = stopIdx === activeIdx;
            const isClimate = s.kind === "climate";
            const tempLabel = daily ? `${Math.round(daily.temperature_2m_max)}°/${Math.round(daily.temperature_2m_min)}°` : null;
            const p = proj[i];
            return (
              <g key={`pin-${stopIdx}`}
                 className={"wx2-pin" + (isActive ? " active" : "") + (isClimate ? " climate" : "")}
                 transform={`translate(${p.x}, ${p.y})`}
                 onClick={() => onPick(stopIdx)}
                 style={{ cursor: "pointer" }}>
                <circle r={pinR * 1.18} className="wx2-pin-ring" />
                <circle r={pinR} className="wx2-pin-circle" />
                <g transform={`translate(${-iconPx / 2}, ${-iconPx / 2})`} style={{ color: code != null && code >= 50 ? "var(--accent)" : "var(--warm)" }}>
                  <Icon size={iconPx} />
                </g>
                <text className="wx2-pin-name" y={-pinR - fontSub * 0.5} fontSize={fontSub}>{s.to}</text>
                {!isClimate && tempLabel && (
                  <text className="wx2-pin-temp" y={pinR + fontMain * 1.0} fontSize={fontMain}>{tempLabel}</text>
                )}
              </g>
            );
          })}
      </svg>
    </div>
  );
}

function StagesStrip({ stops, cache, activeIdx, onPick, tour }) {
  const { iconForCode, IconCloud } = window;
  const few = stops.length <= 7;
  return (
    <div className={"wx2-stages" + (few ? " few" : "")}>
      {stops.map((s, i) => {
        const k = cacheKey(i, s.date, tour.id);
        const entry = cache[k];
        const daily = entry && entry.daily;
        const climate = entry && entry.climate;
        const code = daily ? daily.weathercode : (climate ? 3 : null);
        const Icon = code != null ? iconForCode(code) : IconCloud;
        const cool = code != null && code >= 50;
        const summary = daily ? shortSummary(daily, entry.hourly || []) : (climate ? `${Math.round(climate.monthRainMm)} mm typical` : "Loading…");
        const cls = "wx2-stage"
          + (i === activeIdx ? " active" : "")
          + (s.kind === "climate" ? " climate" : "");
        return (
          <div key={i} className={cls} onClick={() => onPick(i)}>
            <span className="num">Stage {i + 1}</span>
            <span className="day">{fmtLongDate(s.date)}</span>
            <span className="place" title={s.to}>{s.to}</span>
            <div className="meta">
              <span className={"ic" + (cool ? " cool" : "")}><Icon size={18} /></span>
              <span className="temp">
                {daily ? `${Math.round(daily.temperature_2m_max)}° / ${Math.round(daily.temperature_2m_min)}°`
                  : climate ? `${Math.round(climate.meanHigh)}° / ${Math.round(climate.meanLow)}°`
                  : "—"}
              </span>
            </div>
            <span className="summary">{summary}</span>
          </div>
        );
      })}
    </div>
  );
}

function WindCard({ daily, startCoord, endCoord }) {
  if (!startCoord || !endCoord || daily.wind_direction_10m_dominant == null) {
    return null;
  }
  const travel = bearingDeg(startCoord, endCoord);
  const speed = daily.wind_speed_10m_max || 0;
  const { kind, tier, rel } = classifyWind(travel, daily.wind_direction_10m_dominant, speed);
  const color = windColor(kind, tier);
  return (
    <div className="wx2-wind">
      <div className="arrow" style={{ borderColor: color }}>
        <WindArrow deg={rel} color={color} size={32} />
      </div>
      <div className="data">
        <div className="speed">{Math.round(speed)} km/h</div>
        <div className="label" style={{ color }}>{windLabel(kind, tier)}</div>
      </div>
    </div>
  );
}

function RainTimeline({ daily, hourly }) {
  const sunrise = daily.sunrise ? new Date(daily.sunrise).getHours() : 6;
  const sunset = daily.sunset ? new Date(daily.sunset).getHours() : 20;
  const startHr = sunrise;
  const endHr = Math.min(23, sunset + 1);
  const cells = hourly.filter((h) => h.hour >= startHr && h.hour <= endHr);
  const maxMm = Math.max(0.3, ...cells.map((c) => c.precip || 0));
  const totalRain = cells.reduce((s, c) => s + (c.precip || 0), 0);
  if (totalRain < 0.2) {
    return (
      <div className="wx2-rain">
        <div className="cap">Rain timeline · Sunrise to sunset</div>
        <div className="empty">No rain expected during riding hours.</div>
      </div>
    );
  }
  const W = 100, H = 100;
  const colW = W / cells.length;
  // Friendly Y tick: round maxMm up to a nice number.
  const niceTop = maxMm <= 1 ? 1 : maxMm <= 2 ? 2 : maxMm <= 5 ? 5 : maxMm <= 10 ? 10 : Math.ceil(maxMm / 5) * 5;
  return (
    <div className="wx2-rain">
      <div className="cap">Rain timeline · Sunrise to sunset · <span style={{ color: "var(--fg-faint)" }}>peak {niceTop} mm</span></div>
      <svg className="wx2-rain-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {[0.5, 1].map((f, i) => (
          <line key={i} className="wx2-rain-grid" x1="0" x2={W} y1={H - H * f} y2={H - H * f} />
        ))}
        {cells.map((c, i) => {
          const mm = c.precip || 0;
          const h = (mm / niceTop) * H;
          const op = Math.max(0.15, Math.min(1, (c.prob || 0) / 100));
          return (
            <rect
              key={i}
              className="wx2-rain-col"
              x={i * colW + colW * 0.15}
              y={H - h}
              width={colW * 0.7}
              height={Math.max(0.5, h)}
              opacity={op}
            />
          );
        })}
      </svg>
      <div className="wx2-rain-axis">
        <span>{pad2(startHr)}h</span>
        <span>{pad2(endHr + 1)}h</span>
      </div>
    </div>
  );
}

function HourlyStrip({ daily, hourly }) {
  const { iconForCode } = window;
  const sunrise = daily.sunrise ? new Date(daily.sunrise).getHours() : 6;
  const sunset = daily.sunset ? new Date(daily.sunset).getHours() : 20;
  const cells = hourly.filter((h) => h.hour >= sunrise && h.hour <= sunset + 1);
  return (
    <div className="wx2-hourly">
      {cells.map((h, i) => {
        const Icon = iconForCode(h.code);
        const cool = h.code >= 50;
        return (
          <div key={i} className="wx2-hourly-cell">
            <span className="hr">{pad2(h.hour)}h</span>
            <span className={"ic" + (cool ? " cool" : "")}><Icon size={18} /></span>
            <span className="t">{Math.round(h.t)}°</span>
            <span className="p">{h.prob > 0 ? `${h.prob}%` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

function StageDetailForecast({ stop, idx, entry, startCoord, endCoord }) {
  if (!entry || !entry.daily) {
    return (
      <div className="wx2-detail">
        <div className="header">
          <span className="label">Stage {idx + 1} · {fmtFullDate(stop.date).toUpperCase()} · {stop.from} → {stop.to}</span>
          <h2 style={{ opacity: 0.5 }}>Loading forecast…</h2>
        </div>
      </div>
    );
  }
  const { daily, hourly = [] } = entry;
  const headline = makeHeadline(daily, hourly);
  return (
    <div className="wx2-detail">
      <div className="header">
        <span className="label">Stage {idx + 1} · {fmtFullDate(stop.date)} · {stop.from.toUpperCase()} → {stop.to.toUpperCase()}</span>
        <h2>{headline}.</h2>
      </div>

      <div className="wx2-stats">
        <div>
          <span className="l">High / Low</span>
          <span className="v">{Math.round(daily.temperature_2m_max)}° / {Math.round(daily.temperature_2m_min)}°</span>
        </div>
        <div>
          <span className="l">Total rain</span>
          <span className="v">{(daily.precipitation_sum || 0).toFixed(1)} mm</span>
        </div>
        <div>
          <span className="l">Sunrise / Sunset</span>
          <span className="v">{fmtClock(daily.sunrise)} / {fmtClock(daily.sunset)}</span>
        </div>
      </div>

      <WindCard daily={daily} startCoord={startCoord} endCoord={endCoord} />
      <RainTimeline daily={daily} hourly={hourly} />
      <HourlyStrip daily={daily} hourly={hourly} />
    </div>
  );
}

function StageDetailClimate({ stop, idx, entry }) {
  const climate = entry && entry.climate;
  const month = monthName(new Date(stop.date).getMonth());
  return (
    <div className="wx2-climate">
      <div className="head">
        <span className="label">Stage {idx + 1} · {fmtFullDate(stop.date)} · {stop.from.toUpperCase()} → {stop.to.toUpperCase()}</span>
        <h2>Typical {month} weather for this area</h2>
        <div className="src">
          {climate
            ? `Based on ${climate.yearsStart}–${climate.yearsEnd} averages · Open-Meteo archive`
            : "Loading 10-year averages…"}
        </div>
      </div>
      <div className="grid">
        <div>
          <span className="l">High</span>
          <span className="v">{climate ? `${Math.round(climate.meanHigh)}°` : "—"}</span>
        </div>
        <div>
          <span className="l">Low</span>
          <span className="v">{climate ? `${Math.round(climate.meanLow)}°` : "—"}</span>
        </div>
        <div>
          <span className="l">Rain days</span>
          <span className="v">{climate && climate.rainDayFrac != null ? `${Math.round(climate.rainDayFrac * 100)}%` : "—"}</span>
        </div>
        <div>
          <span className="l">Avg rainfall</span>
          <span className="v">{climate ? `${Math.round(climate.monthRainMm)} mm/mo` : "—"}</span>
        </div>
      </div>
      <p className="note">Detailed forecast available 16 days before the event.</p>
    </div>
  );
}

function EmptyState({ reason, tourName }) {
  const { IconCloud } = window;
  let title, body;
  switch (reason) {
    case "no-date":
      title = "Set an Event Start Date";
      body = `“${tourName}” doesn't have an Event Start Date yet. Open the Tour Planner, enter a date, and plan the route again — the Weather forecast follows that date.`;
      break;
    case "no-stages":
      title = "Tour has no stages yet";
      body = `“${tourName}” doesn't have stage data on file. Re-plan the route on the Tour Planner.`;
      break;
    case "no-tours":
      title = "No saved tours yet";
      body = "Open the Tour Planner, enter an Event Start Date, and plan a route. It auto-saves and shows up here.";
      break;
    case "no-selection":
    default:
      title = "Pick a tour to see the forecast";
      body = "Weather follows whichever tour you select. Within 16 days you'll see daily forecasts; further out, monthly climate averages.";
      break;
  }
  return (
    <div className="fade-in">
      <div className="empty-wx">
        <IconCloud size={48} />
        <h3>{title}</h3>
        <p>{body}</p>
        <span className="picker">
          <span style={{ color: "var(--fg-dim)" }}>Need a tour?</span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              try { window.dispatchEvent(new CustomEvent("rideprep:switch-tab", { detail: "tour" })); } catch {}
            }}
            style={{ color: "var(--accent)" }}
          >Open the Tour Planner ▾</a>
        </span>
      </div>
    </div>
  );
}

// ---------- Main ----------
function WeatherTab() {
  const indexOf = () => (window.RP_TourStorage ? window.RP_TourStorage.readToursIndex() : readTours());
  const [tours, setTours] = useState(indexOf);
  const [selectedTourId, setSelectedTourId] = useState(() => {
    const list = indexOf();
    if (list.length === 0) return "";
    return list.slice().sort((a, b) => b.savedAt - a.savedAt)[0].id;
  });
  const [activeStop, setActiveStop] = useState(() => readNumber("weather:selectedStopIndex", 0));

  useEffect(() => {
    const refresh = () => {
      const list = indexOf();
      setTours(list);
      if (list.length && !list.find((t) => t.id === selectedTourId)) {
        setSelectedTourId(list.slice().sort((a, b) => b.savedAt - a.savedAt)[0].id);
      }
    };
    window.addEventListener("rideprep:tour-saved", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("rideprep:tour-saved", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [selectedTourId]);

  useEffect(() => { localStorage.setItem("weather:selectedStopIndex", String(activeStop)); }, [activeStop]);

  const tour = useMemo(
    () => tours.find((t) => t.id === selectedTourId) || null,
    [tours, selectedTourId]
  );

  const blob = useMemo(() => {
    if (!selectedTourId || !window.RP_TourStorage) return null;
    return window.RP_TourStorage.readTourBlob(selectedTourId);
  }, [selectedTourId, tours]);

  const startDate = blob && blob.startDate ? blob.startDate : null;
  const usableStages = (blob && blob.tour && Array.isArray(blob.tour.stages) && blob.tour.stages.length)
    ? blob.tour.stages : null;

  // Stages enriched with per-stop date and a guaranteed lat/lng (falling
  // back to the route geometry endpoint for older saved tours).
  const stops = useMemo(() => {
    if (!usableStages || !startDate) return [];
    return usableStages.map((s, i) => {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      let lat = s.lat, lng = s.lng;
      if ((lat == null || lng == null) && blob && Array.isArray(blob.geometry) && s.endIdx != null) {
        const c = blob.geometry[s.endIdx];
        if (c) { lng = c[0]; lat = c[1]; }
      }
      return { ...s, lat, lng, date: ymd(d) };
    });
  }, [usableStages, startDate, blob]);

  // Forecast vs climate per stage, based on days-out from today.
  const stopBuckets = useMemo(() => {
    const today = new Date();
    return stops.map((s) => {
      const out = daysBetween(today, s.date);
      return { ...s, daysOut: out, kind: out <= FORECAST_HORIZON_DAYS && out >= 0 ? "forecast" : "climate" };
    });
  }, [stops]);

  // Stage-start coordinates: stage[0] starts at geometry[0]; stage[i]
  // starts where stage[i-1] ended. Used for bearing → wind classification.
  const stageStartCoords = useMemo(() => {
    if (!stopBuckets.length) return [];
    const out = [];
    const firstStart = blob && Array.isArray(blob.geometry) && blob.geometry[0]
      ? { lat: blob.geometry[0][1], lng: blob.geometry[0][0] }
      : { lat: stopBuckets[0].lat, lng: stopBuckets[0].lng };
    out.push(firstStart);
    for (let i = 1; i < stopBuckets.length; i++) {
      out.push({ lat: stopBuckets[i - 1].lat, lng: stopBuckets[i - 1].lng });
    }
    return out;
  }, [stopBuckets, blob]);

  const [cache, setCache] = useState(readCache);
  const [error, setError] = useState({});

  useEffect(() => {
    if (!stopBuckets.length || !tour) return;
    let cancelled = false;
    (async () => {
      const next = { ...cache };
      let touched = false;
      for (let i = 0; i < stopBuckets.length; i++) {
        const s = stopBuckets[i];
        if (s.lat == null || s.lng == null) continue;
        const k = cacheKey(i, s.date, tour.id);
        const existing = next[k];
        if (existing && Date.now() - existing.fetchedAt < CACHE_TTL_MS) continue;
        try {
          if (s.kind === "forecast") {
            const j = await fetchForecast(s.lat, s.lng);
            if (cancelled) return;
            const di = (j.daily.time || []).indexOf(s.date);
            const daily = di >= 0 ? {
              weathercode: j.daily.weathercode[di],
              temperature_2m_max: j.daily.temperature_2m_max[di],
              temperature_2m_min: j.daily.temperature_2m_min[di],
              precipitation_sum: j.daily.precipitation_sum[di],
              precipitation_probability_max: j.daily.precipitation_probability_max[di],
              wind_speed_10m_max: j.daily.wind_speed_10m_max[di],
              wind_direction_10m_dominant: j.daily.wind_direction_10m_dominant[di],
              sunrise: j.daily.sunrise[di],
              sunset: j.daily.sunset[di],
            } : null;
            const hourly = [];
            const hours = (j.hourly && j.hourly.time) || [];
            for (let hi = 0; hi < hours.length; hi++) {
              if (!hours[hi].startsWith(s.date)) continue;
              const hour = Number(hours[hi].slice(11, 13));
              hourly.push({
                hour,
                t: j.hourly.temperature_2m[hi],
                prob: j.hourly.precipitation_probability[hi] ?? 0,
                precip: j.hourly.precipitation[hi] ?? 0,
                code: j.hourly.weathercode[hi],
                wsp: j.hourly.wind_speed_10m[hi],
                wdir: j.hourly.wind_direction_10m[hi],
              });
            }
            next[k] = { fetchedAt: Date.now(), daily, hourly };
            touched = true;
          } else {
            const d = new Date(s.date);
            const climate = await fetchClimateMonthly(s.lat, s.lng, d.getFullYear(), d.getMonth());
            if (cancelled) return;
            next[k] = { fetchedAt: Date.now(), climate };
            touched = true;
          }
        } catch (e) {
          if (cancelled) return;
          setError((er) => ({ ...er, [i]: String(e.message || e) }));
        }
      }
      if (touched && !cancelled) {
        setCache(next);
        writeCache(next);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour && tour.id, stopBuckets.map((s) => `${s.lat},${s.lng},${s.date},${s.kind}`).join("|")]);

  if (tours.length === 0) return <EmptyState reason="no-tours" />;
  if (!tour) return <EmptyState reason="no-selection" />;
  if (!startDate) return <EmptyState reason="no-date" tourName={tour.name} />;
  if (!usableStages) return <EmptyState reason="no-stages" tourName={tour.name} />;

  const safeIdx = Math.min(Math.max(0, activeStop), stopBuckets.length - 1);
  const active = stopBuckets[safeIdx];
  const activeKey = active && tour ? cacheKey(safeIdx, active.date, tour.id) : null;
  const activeEntry = activeKey ? cache[activeKey] : null;
  const startCoord = stageStartCoords[safeIdx];
  const endCoord = active ? { lat: active.lat, lng: active.lng } : null;

  return (
    <div className="fade-in">
      <div className="weather-layout">
        <div className="wx2-left">
          <div className="card">
            <div className="section-title"><h2 style={{ fontSize: 16 }}>Tour</h2><span className="sub">imported</span></div>
            <select className="plan-select" value={tour.id} onChange={(e) => setSelectedTourId(e.target.value)}>
              {tours.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <div className="tour-summary-card" style={{ marginTop: 10 }}>
              <div className="tsc-name">{tour.name}</div>
              <div className="tsc-stats">
                <span>{tour.totalKm} km</span>
                <span>{tour.stageCount || (usableStages ? usableStages.length : 0)} days</span>
                <span>↑ {tour.totalAscent} m</span>
              </div>
              <div className="tsc-event-date" style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>
                Event start · {fmtLongDate(startDate)}
              </div>
            </div>
          </div>
        </div>

        <div className="wx2-right">
          <RouteMap stops={stopBuckets} cache={cache} activeIdx={safeIdx} onPick={setActiveStop} tour={tour} />
          <StagesStrip stops={stopBuckets} cache={cache} activeIdx={safeIdx} onPick={setActiveStop} tour={tour} />

          {active && active.kind === "forecast"
            ? <StageDetailForecast stop={active} idx={safeIdx} entry={activeEntry} startCoord={startCoord} endCoord={endCoord} />
            : <StageDetailClimate stop={active} idx={safeIdx} entry={activeEntry} />
          }

          {error[safeIdx] && (
            <div style={{
              padding: "10px 12px", borderRadius: 12,
              background: "color-mix(in oklch, var(--danger) 12%, transparent)",
              border: "1px solid color-mix(in oklch, var(--danger) 50%, transparent)",
              fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)"
            }}>
              <em style={{ fontStyle: "italic", fontFamily: "var(--serif)", color: "var(--fg)", marginRight: 8 }}>
                Couldn't reach Open-Meteo.
              </em>
              {error[safeIdx]}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

window.RP_Weather = WeatherTab;

})();
