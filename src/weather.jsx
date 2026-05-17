/* global window, React, L */
// Weather tab — stage-by-stage forecasts for a saved tour.
// Layout: three stacked cards on the left (Tour picker, Tour outlook,
// Packing tips), a Leaflet mini-map plus stages strip and stage detail
// on the right. Within 16 days of the event uses the Open-Meteo
// Forecast API; beyond that falls back to a 10-year monthly
// climatology from the Archive API.
(() => {

const { useState, useEffect, useMemo, useRef } = React;
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
function fmtFriendlyDate(date) {
  const d = new Date(date);
  return `${d.getDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]} ${d.getFullYear()}`;
}
function fmtClock(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function monthName(m) {
  return ["January","February","March","April","May","June","July","August","September","October","November","December"][m];
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function pad2(n) { return String(n).padStart(2, "0"); }
function mean(arr) {
  const xs = arr.filter((v) => v != null && !Number.isNaN(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function sumArr(arr) {
  return arr.filter((v) => v != null).reduce((a, b) => a + b, 0);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Short city: take the part before the first comma. "Münster, NW, Deutschland" → "Münster".
function shortCity(s) {
  if (!s) return s;
  const i = String(s).indexOf(",");
  return (i >= 0 ? String(s).slice(0, i) : String(s)).trim();
}

// Geographic shape of the route, used to size the map. routeAspect is
// (east-west km) / (north-south km), so > 1 = horizontal, < 1 = vertical.
function routeMetrics(stops) {
  const pts = (stops || []).filter((s) => s && s.lat != null && s.lng != null);
  if (pts.length < 2) return { routeAspect: 1.6 };
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const meanLat = (minLat + maxLat) / 2;
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  const lngSpanCorrected = lngSpan * Math.cos(meanLat * Math.PI / 180);
  const routeAspect = Math.max(0.05, lngSpanCorrected / Math.max(0.01, latSpan));
  return { routeAspect, minLat, maxLat, minLng, maxLng };
}

// Short condition summary used in best/toughest cards in the Tour outlook.
function conditionShortForCode(code) {
  const { conditionForCode } = window;
  if (conditionForCode) return conditionForCode(code);
  return "";
}

// Pick an icon code for the headline that matches the headline's tone.
// When the headline says "dry" but the daily.weathercode is a rain code
// (because some hourly forecast shows light precip), fall back to the
// dominant non-rain hourly code (typically overcast or partly cloudy)
// so the icon doesn't contradict the headline.
function headlineIconCode(daily, hourly) {
  const code = daily.weathercode;
  const totalMm = daily.precipitation_sum || 0;
  if (totalMm >= 0.5) return code;
  const isRain = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 86) || (c >= 95);
  if (!isRain(code)) return code;
  if (!hourly || !hourly.length) return 3;
  const counts = {};
  hourly.forEach((h) => {
    if (h.code != null && !isRain(h.code)) {
      counts[h.code] = (counts[h.code] || 0) + 1;
    }
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length ? Number(sorted[0][0]) : 3;
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

async function fetchClimateMonthly(lat, lng, year, month) {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear - CLIMATE_YEARS; y < currentYear; y++) years.push(y);
  const results = await Promise.all(
    years.map((yr) => fetchArchiveMonth(lat, lng, yr, month).catch(() => null))
  );
  const valid = results.filter(Boolean);
  if (!valid.length) throw new Error("Archive returned no data");
  const yearStats = valid.map((j) => {
    const d = j.daily || {};
    return {
      meanHigh: mean(d.temperature_2m_max || []),
      meanLow: mean(d.temperature_2m_min || []),
      monthRainMm: sumArr(d.precipitation_sum || []),
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

// ---------- Weather icon HTML strings ----------
// Leaflet's divIcon takes an HTML string, so we can't pass React components.
// Same path data as src/weather-icons.jsx, mirrored here so map markers can
// render without ReactDOMServer.
const ICON_PATHS = {
  sun:    '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />',
  partly: '<circle cx="8" cy="8" r="3" /><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M4.2 4.2l1 1M11.8 4.2l-1 1" /><path d="M9 18a4 4 0 0 1 .7-7.9 5 5 0 0 1 9.6 1.4A3.5 3.5 0 0 1 19 18H9z" fill="currentColor" fill-opacity="0.12" />',
  cloud:  '<path d="M6 18a4 4 0 0 1 .7-7.9 5 5 0 0 1 9.6 1.4A3.5 3.5 0 0 1 16 18H6z" fill="currentColor" fill-opacity="0.12" />',
  rain:   '<path d="M6 14a4 4 0 0 1 .7-7.9 5 5 0 0 1 9.6 1.4A3.5 3.5 0 0 1 16 14H6z" fill="currentColor" fill-opacity="0.12" /><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3" />',
  storm:  '<path d="M6 14a4 4 0 0 1 .7-7.9 5 5 0 0 1 9.6 1.4A3.5 3.5 0 0 1 16 14H6z" fill="currentColor" fill-opacity="0.12" /><path d="M12 14l-2 4h3l-2 4" />',
  snow:   '<path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9L4.9 19.1" />',
};
function iconKeyFor(code) {
  if (code === 0) return "sun";
  if (code <= 2) return "partly";
  if (code <= 48) return "cloud";
  if (code <= 67 || (code >= 80 && code <= 82)) return "rain";
  if (code <= 77 || (code >= 85 && code <= 86)) return "snow";
  if (code >= 95) return "storm";
  return "cloud";
}
function iconSvgString(code, size = 18) {
  const key = iconKeyFor(code);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[key]}</svg>`;
}

// ---------- Wind classification ----------
function classifyWind(travelBearing, windFromDeg, speedKmh) {
  const windTo = (windFromDeg + 180) % 360;
  let rel = windTo - travelBearing;
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

// Saturated wind colors — fully green for tailwind, fully yellow/orange/red
// for head and crosswind, so labels read at a glance and don't look washed out.
function windColor(kind, tier) {
  if (tier === 0) return "var(--fg-faint)";
  if (kind === "tail") {
    if (tier === 1) return "#65a86b";
    if (tier === 2) return "#3e8c4a";
    return "#1f5b32";
  }
  // head + cross share the warm/danger ramp
  if (tier === 1) return "#e0a23c";
  if (tier === 2) return "#d77026";
  return "#c8392a";
}

function windLabel(kind, tier) {
  const strength = tier === 0 ? "Calm" : tier === 1 ? "Light" : tier === 2 ? "Moderate" : "Strong";
  if (tier === 0) return "Calm winds";
  const dir = kind === "tail" ? "tailwind" : kind === "head" ? "headwind" : "crosswind";
  return `${strength} ${dir}`;
}

// ---------- Headline generation ----------
// Drives the day's one-line summary AND its icon. Rule order is fixed so
// the language always matches the rain data — never "Drizzle and dry."
function makeHeadline(daily, hourly) {
  const totalMm = daily.precipitation_sum || 0;
  const probMax = daily.precipitation_probability_max || 0;
  const code = daily.weathercode;

  let body;
  if (totalMm === 0) {
    if (probMax < 20) {
      const cloudy = code >= 3; // overcast or worse (but no measurable rain)
      body = cloudy ? "Overcast but dry" : "Sunny and dry";
    } else if (probMax < 50) {
      body = "Mostly dry, slight chance of showers";
    } else {
      body = "Mostly dry, chance of showers";
    }
  } else if (totalMm < 0.5) {
    body = "Trace of rain possible";
  } else if (totalMm < 2) {
    const wetH = hourly.filter((h) => (h.precip || 0) >= 0.1).length;
    body = `Light rain expected, ${wetH}h of showers`;
  } else if (totalMm < 8) {
    body = "Wet day, plan for rain gear";
  } else {
    body = "Heavy rain expected throughout the day";
  }

  // Concentration qualifier: only meaningful when there's real rain AND
  // a clear 3-hour spike. Skip for trace amounts and broad-soak days.
  if (totalMm >= 0.5 && totalMm < 8 && hourly.length >= 3) {
    let bestSum = 0, bestStart = -1;
    for (let i = 0; i + 2 < hourly.length; i++) {
      const w = (hourly[i].precip || 0) + (hourly[i + 1].precip || 0) + (hourly[i + 2].precip || 0);
      if (w > bestSum) { bestSum = w; bestStart = i; }
    }
    if (bestStart >= 0 && bestSum > 0.7 * totalMm) {
      const h0 = hourly[bestStart].hour;
      body += `, concentrated around ${pad2(h0)}-${pad2((h0 + 3) % 24)}h`;
    }
  }
  return body;
}

// ---------- Tour outlook data ----------
// One italic-serif sentence that captures the character of the whole tour.
// Rules cascade in priority order; first match wins.
function tourCharacterLine(stops, cache, tour) {
  if (!stops || !tour) return null;
  const all = stops.map((s, i) => ({ s, i, entry: cache[cacheKey(i, s.date, tour.id)] }));
  const fc = all.filter((x) => x.s.kind === "forecast" && x.entry && x.entry.daily);
  if (!fc.length) {
    const cl = all.filter((x) => x.s.kind === "climate" && x.entry && x.entry.climate);
    if (!cl.length) return null;
    const month = monthName(new Date(stops[0].date).getMonth());
    const meanH = mean(cl.map((x) => x.entry.climate.meanHigh));
    const meanRain = mean(cl.map((x) => x.entry.climate.monthRainMm));
    const temp = meanH == null ? "mild" : meanH > 22 ? "warm" : meanH >= 15 ? "mild" : "cool";
    const rain = meanRain == null ? "mixed conditions" : meanRain > 80 ? "with significant rain" : meanRain > 40 ? "with some rain" : "mostly dry";
    return `Typical ${month} weather, ${temp} ${rain}.`;
  }
  const highs = fc.map((x) => x.entry.daily.temperature_2m_max);
  const avgHigh = mean(highs);
  const minHigh = Math.min(...highs);
  const maxHigh = Math.max(...highs);
  const totalRain = sumArr(fc.map((x) => x.entry.daily.precipitation_sum || 0));
  const wetStages = fc.filter((x) => (x.entry.daily.precipitation_sum || 0) > 0.5);
  const wetCount = wetStages.length;
  const total = fc.length;
  if (totalRain < 1 && avgHigh > 22) return "Warm and sunny throughout.";
  if (totalRain < 1 && avgHigh >= 15) return "Mild and dry the whole way.";
  if (totalRain < 1) return "Cool but dry across all stages.";
  if (wetCount > 0 && wetCount <= 2) {
    const days = wetStages.map((x) => fmtDow(x.s.date)).join(" and ");
    return `Mostly dry, with light rain on ${days}.`;
  }
  if (wetCount > total / 2) return "Wet tour, plan for rain on most days.";
  if ((maxHigh - minHigh) > 8) return "Mixed conditions, big temperature swings across the week.";
  return "Mixed conditions, plan for variable weather.";
}

// One tile per stage: stage number, dominant weather icon, daily high,
// rain-bar width relative to the tour's peak stage rain.
function tourTileData(stops, cache, tour) {
  if (!stops || !tour) return [];
  return stops.map((s, i) => {
    const entry = cache[cacheKey(i, s.date, tour.id)];
    const daily = entry && entry.daily;
    const climate = entry && entry.climate;
    const code = daily ? daily.weathercode : (climate ? 3 : null);
    const tHigh = daily ? daily.temperature_2m_max : (climate ? climate.meanHigh : null);
    // For climate stages we approximate per-stage rain as month / 30 — only
    // used for relative bar widths, never displayed numerically.
    const rainMm = daily ? (daily.precipitation_sum || 0)
      : (climate && climate.monthRainMm != null ? climate.monthRainMm / 30 : 0);
    return { i, s, code, tHigh, rainMm, isClimate: s.kind === "climate" };
  });
}

// "Heads up" flags. Up to 3 short alerts about notable conditions. Each
// flag combines stages into a single line ("Rain on Stages 1, 2").
function tourHeadsUpFlags(stops, cache, tour, stageStartCoords) {
  if (!stops || !tour) return [];
  const fc = stops.map((s, i) => ({ s, i, entry: cache[cacheKey(i, s.date, tour.id)] }))
    .filter((x) => x.s.kind === "forecast" && x.entry && x.entry.daily);
  if (!fc.length) return [];

  const collect = (predicate) => fc.filter(predicate).map((x) => x.i + 1);
  const fmtStageList = (nums) => `Stage${nums.length > 1 ? "s" : ""} ${nums.join(", ")}`;
  const out = [];

  const rain = collect((x) => (x.entry.daily.precipitation_sum || 0) > 2);
  if (rain.length) out.push({ icon: "🌧️", text: `Rain on ${fmtStageList(rain)}` });

  const head = [];
  fc.forEach((x) => {
    const d = x.entry.daily;
    const startC = stageStartCoords[x.i];
    if (!startC || x.s.lat == null || d.wind_direction_10m_dominant == null) return;
    const travel = bearingDeg(startC, { lat: x.s.lat, lng: x.s.lng });
    const cls = classifyWind(travel, d.wind_direction_10m_dominant, d.wind_speed_10m_max || 0);
    if (cls.kind === "head" && (d.wind_speed_10m_max || 0) > 20) head.push(x.i + 1);
  });
  if (head.length) out.push({ icon: "💨", text: `Headwind on ${fmtStageList(head)}` });

  const cold = collect((x) => (x.entry.daily.temperature_2m_min ?? 100) < 5);
  if (cold.length) out.push({ icon: "❄️", text: `Cold start on ${fmtStageList(cold)}` });

  const hot = collect((x) => (x.entry.daily.temperature_2m_max || 0) > 28);
  if (hot.length) out.push({ icon: "☀️", text: `Hot day on ${fmtStageList(hot)}` });

  const windy = collect((x) => (x.entry.daily.wind_speed_10m_max || 0) > 30);
  if (windy.length) out.push({ icon: "⚠️", text: `Strong wind on ${fmtStageList(windy)}` });

  return out.slice(0, 3);
}

// (Per-stage packing tips now generated via Google Gemini API; the
// per-stage rule-based fallback lives in localTipsForStage further down.
// The old tour-aggregate packingTips() helper has been removed.)

// ---------- Small visual pieces ----------
function WindArrow({ deg = 0, color = "var(--fg)", size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${deg}deg)`, color }} aria-hidden>
      <path d="M12 3l5 7h-3v11h-4V10H7z" fill="currentColor" />
    </svg>
  );
}

// Three day-period chips (AM / MIDDAY / EVE) replacing the rain sparkline
// in stage cards. Each chip carries the dominant weather icon and average
// temperature for its window; a rain-drop dot signals that the period's
// max probability of rain exceeded 50%. Below the row, the daily total in
// mm — or "Dry" when no measurable rain falls in riding hours.
function StagePeriodChips({ daily, hourly }) {
  const { iconForCode } = window;
  const sunrise = daily.sunrise ? new Date(daily.sunrise).getHours() : 6;
  const sunset = daily.sunset ? new Date(daily.sunset).getHours() : 20;
  const periods = [
    { key: "am",     label: "AM",     lo: sunrise, hi: 11 },
    { key: "midday", label: "MIDDAY", lo: 12,      hi: 16 },
    { key: "eve",    label: "EVE",    lo: 17,      hi: sunset },
  ];
  const totalMm = hourly
    .filter((h) => h.hour >= sunrise && h.hour <= sunset + 1)
    .reduce((s, h) => s + (h.precip || 0), 0);

  return (
    <div className="wx3-period-row">
      <div className="wx3-period-chips">
        {periods.map((p) => {
          const cells = hourly.filter((h) => h.hour >= p.lo && h.hour <= p.hi);
          if (!cells.length) {
            return (
              <div key={p.key} className="chip empty">
                <span className="period">{p.label}</span>
                <span className="dash">—</span>
              </div>
            );
          }
          const tAvg = mean(cells.map((c) => c.t));
          const counts = {};
          cells.forEach((c) => { if (c.code != null) counts[c.code] = (counts[c.code] || 0) + 1; });
          const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
          const codeMode = sorted.length ? Number(sorted[0][0]) : 3;
          const maxProb = Math.max(0, ...cells.map((c) => c.prob || 0));
          const Icon = iconForCode(codeMode);
          const cool = codeMode >= 50;
          const rainy = maxProb > 50;
          return (
            <div key={p.key} className="chip">
              <span className="period">{p.label}</span>
              <span className={"chip-ic" + (cool ? " cool" : "")}>
                <Icon size={16} />
                {rainy && <span className="drop" aria-hidden>●</span>}
              </span>
              <span className="temp">{tAvg != null ? `${Math.round(tAvg)}°` : "—"}</span>
            </div>
          );
        })}
      </div>
      <div className="wx3-period-total">
        {totalMm < 0.2 ? <span className="dry">Dry</span> : <span>{totalMm.toFixed(1)} mm total</span>}
      </div>
    </div>
  );
}

// ---------- Map (Leaflet) ----------
// Each stage marker has two visual parts inside one divIcon: a small
// circular weather badge centred exactly on the stage lat/lng (the
// "icon"), and a city/temp card placed 55 px perpendicular to the
// route, alternating left and right by stage index (the "info box").
// After fitBounds we project each stage to container pixels, compute a
// tangent from prev → next stage, rotate 90° to get the perpendicular,
// and push only the info box along it. The icon stays on the route.
const INFO_OFFSET_PX = 55;

function applyAlternatingOffsets(map, markers) {
  if (!map || !markers.length) return;
  const points = markers.map((m) => {
    try { return map.latLngToContainerPoint(m.getLatLng()); }
    catch { return null; }
  });

  markers.forEach((marker, i) => {
    const curr = points[i];
    if (!curr || !marker._icon) return;
    const box = marker._icon.querySelector(".stage-info-box");
    if (!box) return;

    const prev = points[Math.max(0, i - 1)] || curr;
    const next = points[Math.min(markers.length - 1, i + 1)] || curr;
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const px = -ty;
    const py = tx;
    const dir = (i % 2 === 0) ? 1 : -1;
    const ox = px * INFO_OFFSET_PX * dir;
    const oy = py * INFO_OFFSET_PX * dir;

    box.style.setProperty("--ox", `${ox}px`);
    box.style.setProperty("--oy", `${oy}px`);
  });
}

function RouteMap({ stops, cache, activeIdx, onPick, tour }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef({ route: null, markers: [], mids: [] });
  const [ready, setReady] = useState(false);

  // Init the map once. Locked (no pan / no zoom) — this is a presentation
  // map, not a navigation surface.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, {
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
      zoomControl: false,
      attributionControl: true,
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", {
      subdomains: "abcd",
      maxZoom: 19,
      attribution: '&copy; <a href="https://carto.com/">Carto</a> &middot; OSM',
    }).addTo(map);
    map.setView([51, 10], 5);
    mapRef.current = map;
    const t = setTimeout(() => { map.invalidateSize(); setReady(true); }, 60);
    return () => {
      clearTimeout(t);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Redraw route + markers on every relevant data change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const layers = layersRef.current;
    if (layers.route) { map.removeLayer(layers.route); layers.route = null; }
    layers.markers.forEach((m) => map.removeLayer(m));
    layers.markers = [];
    layers.mids.forEach((m) => map.removeLayer(m));
    layers.mids = [];

    const located = stops.filter((s) => s.lat != null && s.lng != null);
    if (!located.length) return;

    // Route polyline.
    const latlngs = located.map((s) => [s.lat, s.lng]);
    if (latlngs.length > 1) {
      layers.route = L.polyline(latlngs, {
        color: "#4cc9f0",
        weight: 3,
        opacity: 0.92,
        lineJoin: "round",
        lineCap: "round",
      }).addTo(map);
    }

    // Stage markers in route order so the markers array stays
    // index-parallel for the alternating-offset pass. "Active on top"
    // is handled by Leaflet's zIndexOffset, not by reordering.
    located.forEach((s) => {
      const stopIdx = stops.indexOf(s);
      const entry = cache[cacheKey(stopIdx, s.date, tour.id)];
      const daily = entry && entry.daily;
      const climate = entry && entry.climate;
      const code = daily ? daily.weathercode : (climate ? 3 : null);
      const isActive = stopIdx === activeIdx;
      const isClimate = s.kind === "climate";
      const cool = code != null && code >= 50;
      const tempLabel = daily
        ? `${Math.round(daily.temperature_2m_max)}° / ${Math.round(daily.temperature_2m_min)}°`
        : "";
      const iconPx = isActive ? 22 : 18;
      const iconHtml = code != null ? iconSvgString(code, iconPx) : "";
      const displayName = shortCity(s.to);
      const showTemp = !isClimate && tempLabel;
      // Outer divIcon size = the icon badge size; info box is positioned
      // absolutely and overflows the divIcon's bounding box — Leaflet
      // doesn't clip divIcon contents.
      const badgePx = isActive ? 36 : 28;
      const html = `
        <div class="stage-marker${isActive ? " active" : ""}${isClimate ? " climate" : ""}">
          <div class="stage-icon${cool ? " cool" : ""}" title="${escapeHtml(s.to || "")}">
            ${iconHtml}
          </div>
          <div class="stage-info-box">
            <div class="stage-city" title="${escapeHtml(s.to || "")}">${escapeHtml(displayName)}</div>
            ${showTemp ? `<div class="stage-temp">${tempLabel}</div>` : ""}
          </div>
        </div>
      `;
      const icon = L.divIcon({
        className: "wx3-pin-wrap",
        html,
        iconSize: [badgePx, badgePx],
        iconAnchor: [badgePx / 2, badgePx / 2],
      });
      const zOff = isActive ? 1000 : stopIdx;
      const m = L.marker([s.lat, s.lng], { icon, riseOnHover: true, zIndexOffset: zOff }).addTo(map);
      m.on("click", () => onPick(stopIdx));
      layers.markers.push(m);
    });

    // Mid-route markers when straight-line stage > 50 km.
    for (let i = 1; i < located.length; i++) {
      const a = located[i - 1], b = located[i];
      if (haversineKm(a, b) <= MIDPOINT_KM_THRESHOLD) continue;
      const mp = midpoint(a, b);
      const stopIdx = stops.indexOf(b);
      const entry = cache[cacheKey(stopIdx, b.date, tour.id)];
      const daily = entry && entry.daily;
      const code = daily ? daily.weathercode : null;
      if (code == null) continue;
      const cool = code >= 50;
      const html = `<div class="wx3-mid-mk ${cool ? "cool" : ""}">${iconSvgString(code, 14)}</div>`;
      const icon = L.divIcon({ className: "wx3-pin-mid", html, iconSize: [22, 22], iconAnchor: [11, 11] });
      const m = L.marker([mp.lat, mp.lng], { icon, interactive: false }).addTo(map);
      layers.mids.push(m);
    }

    // Fit bounds (including any midpoints) with padding so info boxes
    // at the edges of the route don't clip against the map border.
    const allPoints = latlngs.slice();
    layers.mids.forEach((m) => { const ll = m.getLatLng(); allPoints.push([ll.lat, ll.lng]); });
    if (allPoints.length === 1) {
      map.setView(allPoints[0], 10);
    } else {
      const bounds = L.latLngBounds(allPoints);
      map.fitBounds(bounds, { padding: [60, 80] });
    }
    // After Leaflet has positioned the markers, push each info box
    // perpendicular to the route. requestAnimationFrame waits until
    // the DOM has the icons placed.
    const raf = requestAnimationFrame(() => {
      applyAlternatingOffsets(map, layers.markers);
    });
    // Re-apply on map resize so offsets stay correct after viewport
    // changes (e.g. window resize, mobile orientation).
    const onResize = () => applyAlternatingOffsets(map, layers.markers);
    map.on("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      map.off("resize", onResize);
    };
  }, [stops, cache, activeIdx, tour, ready]);

  return (
    <div className="wx3-map">
      <div ref={elRef} className="wx3-map-canvas" />
    </div>
  );
}

// ---------- Stages strip ----------
function StagesStrip({ stops, cache, activeIdx, onPick, tour }) {
  const { iconForCode, IconCloud } = window;
  const few = stops.length <= 7;
  return (
    <div className={"wx3-stages" + (few ? " few" : "")}>
      {stops.map((s, i) => {
        const k = cacheKey(i, s.date, tour.id);
        const entry = cache[k];
        const daily = entry && entry.daily;
        const climate = entry && entry.climate;
        const code = daily ? daily.weathercode : (climate ? 3 : null);
        const Icon = code != null ? iconForCode(code) : IconCloud;
        const cool = code != null && code >= 50;
        const cls = "wx3-stage"
          + (i === activeIdx ? " active" : "")
          + (s.kind === "climate" ? " climate" : "");
        return (
          <div key={i} className={cls} onClick={() => onPick(i)}>
            <span className="num">Stage {i + 1}</span>
            <span className="day">{fmtLongDate(s.date)}</span>
            <span className="place" title={s.to}>{shortCity(s.to)}</span>
            <div className="meta">
              <span className={"ic" + (cool ? " cool" : "")}><Icon size={18} /></span>
              <span className="temp">
                {daily ? `${Math.round(daily.temperature_2m_max)}° / ${Math.round(daily.temperature_2m_min)}°`
                  : climate ? `${Math.round(climate.meanHigh)}° / ${Math.round(climate.meanLow)}°`
                  : "—"}
              </span>
            </div>
            {daily ? (
              <StagePeriodChips daily={daily} hourly={entry.hourly || []} />
            ) : (
              <span className="summary">
                {climate ? `${Math.round(climate.monthRainMm)} mm typical` : "Loading…"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Wind / Rain / Hourly ----------
function WindCard({ daily, startCoord, endCoord }) {
  if (!startCoord || !endCoord || daily.wind_direction_10m_dominant == null) return null;
  const travel = bearingDeg(startCoord, endCoord);
  const speed = daily.wind_speed_10m_max || 0;
  const { kind, tier, rel } = classifyWind(travel, daily.wind_direction_10m_dominant, speed);
  const color = windColor(kind, tier);
  return (
    <div className="wx3-wind">
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

function NoRainPanel() {
  const { IconSun } = window;
  return (
    <div className="wx3-norain">
      <span className="ic"><IconSun size={26} /></span>
      <span className="t">No rain expected during riding hours.</span>
    </div>
  );
}

function RainTimeline({ daily, hourly }) {
  const sunrise = daily.sunrise ? new Date(daily.sunrise).getHours() : 6;
  const sunset = daily.sunset ? new Date(daily.sunset).getHours() : 20;
  const startHr = sunrise;
  const endHr = Math.min(23, sunset + 1);
  const cells = hourly.filter((h) => h.hour >= startHr && h.hour <= endHr);
  const totalRain = cells.reduce((s, c) => s + (c.precip || 0), 0);
  if (totalRain < 0.2 || !cells.length) return <NoRainPanel />;

  const peakMm = Math.max(...cells.map((c) => c.precip || 0));
  // Sensible Y-axis cap: snap to 1, 2, 5, 10, then 5-multiples. Always at
  // least 2 mm so light-rain columns still have visual presence.
  const niceTop = peakMm <= 1 ? 2
    : peakMm <= 2 ? 2
    : peakMm <= 5 ? 5
    : peakMm <= 10 ? 10
    : Math.ceil(peakMm / 5) * 5;
  // Hour labels every 2h on short windows, every 3h when the day is longer.
  const span = cells.length;
  const labelStep = span > 10 ? 3 : 2;

  return (
    <div className="wx3-rain">
      <div className="wx3-rain-cap">
        Rain timeline · Sunrise to sunset · <span className="peak">Peak {niceTop} mm</span>
      </div>
      <div className="wx3-rain-chart-wrap">
        <div className="wx3-rain-yaxis">
          <span>{niceTop}</span>
          <span>{niceTop >= 4 ? Math.round(niceTop / 2) : (niceTop / 2).toFixed(1)}</span>
          <span>0</span>
        </div>
        <div className="wx3-rain-chart">
          <div className="wx3-rain-grid" style={{ top: "0%" }} />
          <div className="wx3-rain-grid" style={{ top: "50%" }} />
          <div className="wx3-rain-grid" style={{ top: "100%" }} />
          <div className="wx3-rain-cols">
            {cells.map((c, i) => {
              const mm = c.precip || 0;
              const h = (mm / niceTop) * 100;
              const op = Math.max(0.18, Math.min(1, (c.prob || 0) / 100));
              const showLabel = (c.hour - startHr) % labelStep === 0;
              return (
                <div
                  key={i}
                  className="wx3-rain-col-wrap"
                  title={`${pad2(c.hour)}:00 · ${mm.toFixed(1)} mm · ${c.prob || 0}% probability`}
                >
                  <span className="wx3-rain-col" style={{ height: `${Math.max(0, h)}%`, opacity: op }} />
                  {showLabel && <span className="wx3-rain-xlabel">{pad2(c.hour)}</span>}
                </div>
              );
            })}
          </div>
        </div>
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
    <div className="wx3-hourly">
      {cells.map((h, i) => {
        const Icon = iconForCode(h.code);
        const cool = h.code >= 50;
        return (
          <div key={i} className="wx3-hourly-cell">
            <span className="hr">{pad2(h.hour)}h</span>
            <span className={"ic" + (cool ? " cool" : "")}><Icon size={20} /></span>
            <span className="t">{Math.round(h.t)}°</span>
            <span className="p">{h.prob > 0 ? `${h.prob}%` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Stage detail (forecast / climate) ----------
function StageDetailForecast({ stop, idx, entry, startCoord, endCoord }) {
  const { iconForCode } = window;
  if (!entry || !entry.daily) {
    return (
      <div className="wx3-detail">
        <div className="header">
          <span className="label">Stage {idx + 1} · {fmtFullDate(stop.date)} · {shortCity(stop.from || "").toUpperCase()} → {shortCity(stop.to || "").toUpperCase()}</span>
          <h2 style={{ opacity: 0.5 }}>Loading forecast…</h2>
        </div>
      </div>
    );
  }
  const { daily, hourly = [] } = entry;
  const headline = makeHeadline(daily, hourly);
  const iconCode = headlineIconCode(daily, hourly);
  const Icon = iconForCode(iconCode);
  const cool = iconCode >= 50;
  return (
    <div className="wx3-detail">
      <div className="header">
        <span className="label">Stage {idx + 1} · {fmtFullDate(stop.date)} · {shortCity(stop.from || "").toUpperCase()} → {shortCity(stop.to || "").toUpperCase()}</span>
        <h2>
          <span className={"wx3-hl-ic" + (cool ? " cool" : "")}><Icon size={22} /></span>
          {headline}.
        </h2>
      </div>

      <div className="wx3-stats">
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
      <div className="wx3-divider" />
      <RainTimeline daily={daily} hourly={hourly} />
      <div className="wx3-divider" />
      <HourlyStrip daily={daily} hourly={hourly} />
    </div>
  );
}

function StageDetailClimate({ stop, idx, entry }) {
  const climate = entry && entry.climate;
  const month = monthName(new Date(stop.date).getMonth());
  return (
    <div className="wx3-climate">
      <div className="head">
        <span className="label">Stage {idx + 1} · {fmtFullDate(stop.date)} · {shortCity(stop.from || "").toUpperCase()} → {shortCity(stop.to || "").toUpperCase()}</span>
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

// ---------- Left column cards ----------
function TourOutlookCard({ stops, cache, tour, stageStartCoords, activeIdx, onPickStage }) {
  const { iconForCode } = window;
  const line = useMemo(
    () => tourCharacterLine(stops, cache, tour),
    [stops, cache, tour]
  );
  const tiles = useMemo(
    () => tourTileData(stops, cache, tour),
    [stops, cache, tour]
  );
  const flags = useMemo(
    () => tourHeadsUpFlags(stops, cache, tour, stageStartCoords),
    [stops, cache, tour, stageStartCoords]
  );
  const peakRain = useMemo(
    () => Math.max(0.5, ...tiles.map((t) => t.rainMm || 0)),
    [tiles]
  );

  if (!tiles.length) {
    return (
      <div className="card">
        <div className="section-title"><h2 style={{ fontSize: 16 }}>Tour outlook</h2></div>
        <div className="wx3-outlook-note">Loading forecast outlook…</div>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="section-title"><h2 style={{ fontSize: 16 }}>Tour outlook</h2></div>
      <div className="wx3-outlook2">
        {line && <p className="wx3-outlook-char">{line}</p>}
        <div className="wx3-tour-strip">
          {tiles.map((t) => {
            const Icon = t.code != null ? iconForCode(t.code) : null;
            const cool = t.code != null && t.code >= 50;
            const rainPct = Math.min(100, (t.rainMm / peakRain) * 100);
            const isActive = t.i === activeIdx;
            return (
              <button
                type="button"
                key={t.i}
                className={"tour-tile"
                  + (isActive ? " active" : "")
                  + (t.isClimate ? " climate" : "")}
                onClick={() => onPickStage && onPickStage(t.i)}
                title={`Stage ${t.i + 1} · ${shortCity(t.s.to)}`}
                aria-label={`Stage ${t.i + 1}`}
              >
                <span className="n">{t.i + 1}</span>
                <span className={"ic" + (cool ? " cool" : "")}>
                  {Icon ? <Icon size={22} /> : <span className="dash">—</span>}
                </span>
                <span className="t">{t.tHigh != null ? `${Math.round(t.tHigh)}°` : "—"}</span>
                <span className="bar" aria-hidden>
                  <span className="fill" style={{ width: `${rainPct}%` }} />
                </span>
              </button>
            );
          })}
        </div>
        {flags.length > 0 && (
          <div className="wx3-headsup">
            <div className="hdr">Heads up</div>
            {flags.map((f, k) => (
              <div className="flag" key={k}>
                <span className="emoji" aria-hidden>{f.icon}</span>
                <span className="t">{f.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Per-stage rule-based fallback. Used when no Gemini API key is
// configured or when the Gemini call fails — keeps the card useful in
// either case.
function localTipsForStage(stop, entry, startCoord) {
  if (!stop || !entry) return [];
  const tips = [];
  if (stop.kind === "forecast" && entry.daily) {
    const d = entry.daily;
    if ((d.precipitation_sum || 0) > 2) tips.push("Rain jacket recommended for this stage");
    if (d.temperature_2m_max > 25) tips.push("Sunscreen essential — high above 25°");
    if (d.temperature_2m_min < 8) tips.push("Cold morning — arm warmers recommended");
    if (startCoord && d.wind_direction_10m_dominant != null && stop.lat != null) {
      const cls = classifyWind(
        bearingDeg(startCoord, { lat: stop.lat, lng: stop.lng }),
        d.wind_direction_10m_dominant,
        d.wind_speed_10m_max || 0
      );
      if (cls.kind === "head" && (d.wind_speed_10m_max || 0) > 20) {
        tips.push("Strong headwind expected — pack an extra wind-blocking layer");
      }
    }
    if ((d.precipitation_probability_max ?? 0) > 50 && (d.precipitation_sum || 0) > 1) {
      tips.push("Pack waterproof bags — sustained rain likely");
    }
    if (!tips.length) {
      tips.push("Conditions look favourable for this stage — light layers should be enough");
    }
  } else if (stop.kind === "climate" && entry.climate) {
    const c = entry.climate;
    const m = new Date(stop.date).getMonth();
    if (c.meanHigh != null) tips.push(`${monthName(m)} typically averages ${Math.round(c.meanHigh)}° highs in this area`);
    if (c.meanHigh != null && c.meanHigh > 25) tips.push("Hot conditions likely — bring sun protection and extra water");
    if (c.meanLow != null && c.meanLow < 8) tips.push("Cool mornings likely — pack warm layers");
    if (c.monthRainMm != null && c.monthRainMm > 80) tips.push(`Wet season — about ${Math.round(c.monthRainMm)} mm typical rainfall`);
  }
  return tips.slice(0, 5);
}

function PackingTipsCard({ stop, stopIdx, entry, tour, training, startCoord }) {
  const [aiTips, setAiTips] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  // Build the request context. null until we have weather data for the
  // currently selected stage — we never call the API with empty inputs.
  const ctx = useMemo(() => {
    if (!stop || !entry || !tour) return null;
    let weather = null;
    if (stop.kind === "forecast" && entry.daily) {
      weather = {
        kind: "forecast",
        tempMin: entry.daily.temperature_2m_min,
        tempMax: entry.daily.temperature_2m_max,
        precipMm: entry.daily.precipitation_sum || 0,
        precipProb: entry.daily.precipitation_probability_max || 0,
        windKmh: entry.daily.wind_speed_10m_max || 0,
        weatherCode: entry.daily.weathercode,
      };
    } else if (stop.kind === "climate" && entry.climate) {
      weather = {
        kind: "climate",
        tempMin: entry.climate.meanLow,
        tempMax: entry.climate.meanHigh,
        monthRainMm: entry.climate.monthRainMm,
        rainDayFrac: entry.climate.rainDayFrac,
        windKmh: entry.climate.windKmh,
      };
    }
    if (!weather) return null;
    return {
      tour: {
        from: tour.from || (tour.name || "").split(" → ")[0],
        to: tour.to || (tour.name || "").split(" → ")[1],
        totalKm: tour.totalKm,
        totalAscent: tour.totalAscent,
        stageCount: tour.stageCount,
      },
      stage: {
        index: stopIdx,
        from: stop.from,
        to: stop.to,
        km: stop.km,
        ascent: stop.ascent,
        descent: stop.descent,
      },
      weather,
      month: monthName(new Date(stop.date).getMonth()),
      training,
    };
  }, [stop, stopIdx, entry, tour, training]);

  const fallbackTips = useMemo(
    () => localTipsForStage(stop, entry, startCoord),
    [stop, entry, startCoord]
  );

  const key = useMemo(() => {
    const RP = window.RP_PackingTips;
    if (!ctx || !RP || stop == null || stop.lat == null || stop.lng == null) return null;
    return RP.cacheKey({
      lat: stop.lat, lng: stop.lng, date: stop.date,
      weatherHash: RP.weatherHash(ctx),
    });
  }, [ctx, stop]);

  // Fetch on context change (different stage, or weather data updated).
  // Skips entirely if no API key — the local fallback is shown instead.
  useEffect(() => {
    const RP = window.RP_PackingTips;
    if (!ctx || !key || !RP) return;
    const cached = RP.readCache(key);
    if (cached && Array.isArray(cached.tips) && cached.tips.length) {
      setAiTips(cached.tips);
      setErrorMsg(null);
      return;
    }
    if (!(window.__PACKING_TIPS_PROXY_URL__ || window.__GEMINI_API_KEY__)) {
      setAiTips(null);
      setErrorMsg(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    RP.fetchPackingTips(ctx)
      .then((tips) => {
        if (cancelled) return;
        setAiTips(tips);
        RP.writeCache(key, { tips, ts: Date.now() });
      })
      .catch((e) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn("[packingTips] fetch failed:", e);
        setErrorMsg(String((e && e.message) || e));
        setAiTips(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ctx, key]);

  function regenerate() {
    const RP = window.RP_PackingTips;
    if (!RP || !ctx || !key) return;
    if (!(window.__PACKING_TIPS_PROXY_URL__ || window.__GEMINI_API_KEY__)) return;
    RP.clearCache(key);
    setLoading(true);
    setErrorMsg(null);
    RP.fetchPackingTips(ctx)
      .then((tips) => {
        setAiTips(tips);
        RP.writeCache(key, { tips, ts: Date.now() });
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[packingTips] regenerate failed:", e);
        setErrorMsg(String((e && e.message) || e));
        setAiTips(null);
      })
      .finally(() => setLoading(false));
  }

  const apiReady = !!(window.__PACKING_TIPS_PROXY_URL__ || window.__GEMINI_API_KEY__);
  const showSkeleton = loading && !aiTips;
  const tipsToShow = aiTips && aiTips.length ? aiTips : fallbackTips;
  const usingFallback = !aiTips && !loading && tipsToShow.length > 0;
  const climateMode = stop && stop.kind === "climate";

  return (
    <div className="card">
      <div className="section-title">
        <h2 style={{ fontSize: 16 }}>Packing tips</h2>
        {apiReady && (
          <button
            type="button"
            className="wx3-tips-regen"
            title={loading ? "Generating…" : "Regenerate from Gemini"}
            onClick={regenerate}
            disabled={loading || !ctx}
            aria-label="Regenerate packing tips"
          >
            <span className={loading ? "spin" : ""} aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L13.09 8.26L19 6L14.74 10.91L21 12L14.74 13.09L19 18L13.09 15.74L12 22L10.91 15.74L5 18L9.26 13.09L3 12L9.26 10.91L5 6L10.91 8.26L12 2Z"/>
              </svg>
            </span>
          </button>
        )}
      </div>
      {showSkeleton ? (
        <div className="wx3-tips-skel" aria-hidden>
          <div /><div /><div /><div /><div />
        </div>
      ) : tipsToShow.length ? (
        <ul className="wx3-tips">
          {tipsToShow.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      ) : (
        <div className="wx3-tips-empty">Waiting for weather data.</div>
      )}
      {tipsToShow.length > 0 && (
        <div
          className="wx3-tips-note"
          title={usingFallback && errorMsg ? errorMsg : undefined}
        >
          {aiTips && aiTips.length > 0
            ? "Generated by Gemini AI"
            : "Based on local climate data"}
        </div>
      )}
    </div>
  );
}

// ---------- Empty state ----------
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

// Informational banner shown above the map when the event is beyond the
// 16-day forecast horizon. Tells the user that what they're looking at is
// climate-based and when detailed forecasts will become available.
function ClimateBanner({ daysOut, eventDate }) {
  if (daysOut == null || daysOut <= FORECAST_HORIZON_DAYS) return null;
  const becomes = new Date(eventDate);
  becomes.setDate(becomes.getDate() - FORECAST_HORIZON_DAYS);
  return (
    <div className="wx3-climate-banner" role="status">
      <span className="ico" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01M11 12h1v4h1" />
        </svg>
      </span>
      <div className="txt">
        <div className="main">Showing typical weather for this time of year.</div>
        <div className="sub">
          Detailed hour-by-hour forecasts become available {FORECAST_HORIZON_DAYS} days before
          your event. Come back on {fmtFriendlyDate(becomes)} for precise predictions.
        </div>
      </div>
      <div className="cap">{daysOut} days to go</div>
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

  const stopBuckets = useMemo(() => {
    const today = new Date();
    return stops.map((s) => {
      const out = daysBetween(today, s.date);
      return { ...s, daysOut: out, kind: out <= FORECAST_HORIZON_DAYS && out >= 0 ? "forecast" : "climate" };
    });
  }, [stops]);

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

  // Training context for AI packing tips — read once from the Training tab's
  // saved inputs. Fitness level + weekly hours feed into the prompt.
  const training = useMemo(() => {
    try {
      const raw = localStorage.getItem("ridePrep:planInputs");
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return {
        fitnessLevel: obj.fitnessLevel || (obj.fitnessMode === "FTP" && obj.ftp ? `FTP ${obj.ftp} W` : null),
        weeklyHours: obj.weeklyHoursTarget || obj.weeklyHours || null,
        eventType: obj.eventType || null,
      };
    } catch { return null; }
  }, []);

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
        <div className="wx3-left">
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

          <TourOutlookCard
            stops={stopBuckets}
            cache={cache}
            tour={tour}
            stageStartCoords={stageStartCoords}
            activeIdx={safeIdx}
            onPickStage={setActiveStop}
          />
          <PackingTipsCard
            stop={active}
            stopIdx={safeIdx}
            entry={activeEntry}
            tour={tour}
            training={training}
            startCoord={startCoord}
          />
        </div>

        <div className="wx3-right">
          {(() => {
            const daysOut = daysBetween(new Date(), startDate);
            return daysOut > FORECAST_HORIZON_DAYS
              ? <ClimateBanner daysOut={daysOut} eventDate={startDate} />
              : null;
          })()}
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
