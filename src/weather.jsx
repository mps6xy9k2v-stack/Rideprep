/* global window, React */
// Weather tab — imports a saved tour and shows Open-Meteo forecasts.
// Daily forecast within 14 days; climate-average fallback beyond.
(() => {

const { useState, useEffect, useMemo, useRef } = React;
const FORECAST_HORIZON_DAYS = 16;
const CACHE_TTL_MS = 15 * 60 * 1000;
const TOURS_KEY = "ridePrep:tours";

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
function fmtDateShort(date) {
  return String(new Date(date).getDate());
}
function fmtLongDate(date) {
  const d = new Date(date);
  return `${fmtDow(d)} ${d.getDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]}`;
}
function fmtClock(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function monthName(m) {
  return ["January","February","March","April","May","June","July","August","September","October","November","December"][m];
}

// ---------- Open-Meteo ----------
async function fetchForecast(lat, lng) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", lat);
  u.searchParams.set("longitude", lng);
  u.searchParams.set("daily", "weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset");
  u.searchParams.set("hourly", "temperature_2m,weathercode,precipitation_probability");
  u.searchParams.set("forecast_days", String(FORECAST_HORIZON_DAYS));
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("wind_speed_unit", "kmh");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Forecast ${r.status}`);
  return r.json();
}

async function fetchClimateMonth(lat, lng, year, month) {
  const start = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const end = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const u = new URL("https://archive-api.open-meteo.com/v1/archive");
  u.searchParams.set("latitude", lat);
  u.searchParams.set("longitude", lng);
  u.searchParams.set("start_date", start);
  u.searchParams.set("end_date", end);
  u.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunshine_duration");
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("wind_speed_unit", "kmh");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Climate ${r.status}`);
  const j = await r.json();
  const d = j.daily || {};
  const mean = (arr) => {
    const xs = (arr || []).filter((v) => v != null && !Number.isNaN(v));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const sum = (arr) => (arr || []).filter((v) => v != null).reduce((a, b) => a + b, 0);
  return {
    meanHigh: mean(d.temperature_2m_max),
    meanLow: mean(d.temperature_2m_min),
    precipMm: sum(d.precipitation_sum),
    rainDays: (d.precipitation_sum || []).filter((v) => v >= 1).length,
    windKmh: mean(d.wind_speed_10m_max),
    sunshineHrs: mean(d.sunshine_duration) ? mean(d.sunshine_duration) / 3600 : null,
  };
}

// ---------- Cache ----------
function readCache() {
  try { return JSON.parse(localStorage.getItem("weather:cache") || "{}"); }
  catch { return {}; }
}
function writeCache(c) {
  try { localStorage.setItem("weather:cache", JSON.stringify(c)); } catch {}
}
function cacheKey(stopIdx, dateStr, tourId) { return `${tourId}:${stopIdx}:${dateStr}`; }

// ---------- Pieces ----------
function Hero({ stop, idx, daily }) {
  const { conditionForCode } = window;
  if (!daily) {
    return (
      <div className="weather-hero">
        <span className="hero-label">Stage {idx + 1} · {stop ? fmtLongDate(stop.date) : ""}{stop ? ` · ${stop.from} → ${stop.to}` : ""}</span>
        <h2 className="hero-title" style={{ opacity: .5 }}>Loading forecast…</h2>
      </div>
    );
  }
  const code = daily.weathercode;
  const summary = conditionForCode(code) + (daily.precipitation_probability_max >= 50 ? " through midday" : "");
  return (
    <div className="weather-hero">
      <span className="hero-label">Stage {idx + 1} · {fmtLongDate(stop.date)} · {stop.from} → {stop.to}</span>
      <h2 className="hero-title">{summary}.</h2>
      <div className="hero-meta">
        <div><span className="l">High / Low</span><span className="v">{Math.round(daily.temperature_2m_max)}° / {Math.round(daily.temperature_2m_min)}°</span></div>
        <div><span className="l">Rain</span><span className="v">{daily.precipitation_probability_max ?? 0}% · {Math.round(daily.precipitation_sum)} mm</span></div>
        <div><span className="l">Wind</span><span className="v">{Math.round(daily.wind_speed_10m_max)} km/h</span></div>
        <div><span className="l">Sunrise / Sunset</span><span className="v">{fmtClock(daily.sunrise)} · {fmtClock(daily.sunset)}</span></div>
      </div>
    </div>
  );
}

function ForecastStrip({ forecast, refreshedAgo, stopName, eventDates }) {
  const { iconForCode } = window;
  if (!forecast) {
    return (
      <div>
        <div className="section-title">
          <h2 style={{ fontSize: 15 }}>14-day forecast · {stopName || "—"}</h2>
          <span className="sub">Loading…</span>
        </div>
        <div className="forecast-strip">
          {Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="fc-day" style={{ opacity: .4 }}>
              <span className="fc-dow">—</span>
              <span className="fc-date">—</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  const today = ymd(new Date());
  return (
    <div>
      <div className="section-title">
        <h2 style={{ fontSize: 15 }}>14-day forecast · {stopName}</h2>
        <span className="sub">Open-Meteo · refreshed {refreshedAgo}</span>
      </div>
      <div className="forecast-strip">
        {forecast.time.map((iso, i) => {
          const Icon = iconForCode(forecast.weathercode[i]);
          const isToday = iso === today;
          const eventStage = eventDates[iso];
          const cls = "fc-day" + (eventStage != null ? " event" : isToday ? " today" : "");
          const cool = forecast.weathercode[i] >= 50;
          return (
            <div key={iso} className={cls}>
              <span className="fc-dow">{fmtDow(iso)}</span>
              <span className="fc-date">{fmtDateShort(iso)}</span>
              <span className={"fc-icon" + (cool ? " cool" : "")}><Icon size={22} /></span>
              <span className="fc-temp">{Math.round(forecast.temperature_2m_max[i])}°<em> / {Math.round(forecast.temperature_2m_min[i])}°</em></span>
              {forecast.precipitation_probability_max[i] >= 20
                ? <span className="fc-precip">{forecast.precipitation_probability_max[i]}%</span>
                : <span className="fc-precip" style={{ opacity: 0 }}>·</span>}
              {eventStage != null && <span className="fc-tag">Stage {eventStage + 1}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StopDetailForecast({ stop, idx, daily, hourly }) {
  const { iconForCode, conditionForCode } = window;
  if (!daily) {
    return (
      <div className="wx-panel">
        <div className="section-title">
          <h3>{stop.to} · {fmtLongDate(stop.date)}</h3>
          <span className="sub">Loading…</span>
        </div>
      </div>
    );
  }
  const code = daily.weathercode;
  const Icon = iconForCode(code);
  const cool = code >= 50;
  return (
    <div className="wx-panel">
      <div className="section-title">
        <h3>{stop.to} · {fmtLongDate(stop.date)}</h3>
        <span className="sub">Stage {idx + 1}</span>
      </div>
      <div className="day-detail">
        <span className={"big-icon" + (cool ? " cool" : "")}><Icon size={64} /></span>
        <div className="day-detail-text">
          <div className="temp">{Math.round(daily.temperature_2m_max)}°<em>/ {Math.round(daily.temperature_2m_min)}°</em></div>
          <div className="cond">{conditionForCode(code)}</div>
        </div>
        <div className="day-detail-grid">
          <div><span>Rain</span><b>{daily.precipitation_probability_max ?? 0}% · {Math.round(daily.precipitation_sum)} mm</b></div>
          <div><span>Wind</span><b>{Math.round(daily.wind_speed_10m_max)} km/h</b></div>
          <div><span>Sunrise</span><b>{fmtClock(daily.sunrise)}</b></div>
          <div><span>Sunset</span><b>{fmtClock(daily.sunset)}</b></div>
        </div>
      </div>
      <p style={{ fontFamily: "var(--mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--fg-faint)", margin: "16px 0 6px" }}>Hourly</p>
      <div className="hourly-row">
        {hourly && hourly.length > 0 ? hourly.slice(0, 8).map((h, i) => {
          const HIcon = iconForCode(h.code);
          return (
            <div key={i} className="hourly-cell">
              <span className="hr">{h.hr}</span>
              <span style={{ color: h.p >= 50 ? "var(--accent)" : "var(--warm)" }}><HIcon size={18} /></span>
              <span className="t">{Math.round(h.t)}°</span>
              <span className="p">{h.p}%</span>
            </div>
          );
        }) : Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="hourly-cell" style={{ opacity: .35 }}>
            <span className="hr">—</span><span className="t">—</span><span className="p">—</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StopDetailClimate({ stop, idx, climate }) {
  const month = monthName(new Date(stop.date).getMonth());
  const { IconPartlyCloudy } = window;
  return (
    <div className="wx-panel">
      <div className="section-title">
        <h3>{stop.to} · {fmtLongDate(stop.date)}</h3>
        <span className="sub">Stage {idx + 1} · climate fallback</span>
      </div>
      <div className="climate-card">
        <div className="climate-head">
          <span className="label">{month} — monthly average</span>
          <span className="source">Open-Meteo archive · last year</span>
        </div>
        <div className="climate-body">
          <span className="icon"><IconPartlyCloudy size={56} /></span>
          <div>
            <div className="temp">
              {climate ? `${Math.round(climate.meanHigh)}°` : "—"}
              <em>/ {climate ? `${Math.round(climate.meanLow)}°` : "—"}</em>
            </div>
            <div className="cap">Beyond the 14-day forecast window</div>
          </div>
        </div>
        <div className="climate-stats">
          <div><span className="l">Mean high</span><span className="v">{climate ? `${Math.round(climate.meanHigh)} °C` : "—"}</span></div>
          <div><span className="l">Mean low</span><span className="v">{climate ? `${Math.round(climate.meanLow)} °C` : "—"}</span></div>
          <div><span className="l">Rainfall</span><span className="v">{climate ? `${Math.round(climate.precipMm)} mm` : "—"}</span></div>
          <div><span className="l">Rain days</span><span className="v">{climate ? climate.rainDays : "—"}</span></div>
          <div><span className="l">Wind</span><span className="v">{climate ? `${Math.round(climate.windKmh)} km/h` : "—"}</span></div>
          <div><span className="l">Sun hours</span><span className="v">{climate && climate.sunshineHrs ? `${climate.sunshineHrs.toFixed(1)} h / day` : "—"}</span></div>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--fg-dim)", lineHeight: 1.5, fontStyle: "italic", fontFamily: "var(--serif)" }}>
          Forecast resumes automatically when the event is within 14 days.
        </p>
      </div>
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
      body = "Weather follows whichever tour you select. Within 14 days you'll see daily forecasts; further out we'll show the monthly climate average for each stop.";
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
  // Read the lightweight index for the dropdown. The full per-tour blob
  // (stages with lat/lng, startDate, geometry) is fetched lazily for
  // whichever tour is selected — see `blob` below.
  const indexOf = () => (window.RP_TourStorage ? window.RP_TourStorage.readToursIndex() : readTours());
  const [tours, setTours] = useState(indexOf);
  const [selectedTourId, setSelectedTourId] = useState(() => {
    const list = indexOf();
    if (list.length === 0) return "";
    // Default to the most recently saved tour, not whichever is first.
    return list.slice().sort((a, b) => b.savedAt - a.savedAt)[0].id;
  });
  const [activeStop, setActiveStop] = useState(() => readNumber("weather:selectedStopIndex", 0));

  // Keep the dropdown in sync with auto-saves from the Tour Planner
  // (same-tab CustomEvent) and with deletes from other tabs (storage event).
  useEffect(() => {
    const refresh = () => {
      const list = indexOf();
      setTours(list);
      // If the previously-selected tour was deleted, fall back to newest.
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

  // The index entry — names, totals, id — for the dropdown.
  const tour = useMemo(
    () => tours.find((t) => t.id === selectedTourId) || null,
    [tours, selectedTourId]
  );

  // The full state of the selected tour. This is where stages (with lat/lng)
  // and the canonical event startDate live. Re-reads when selection changes
  // or when the index list signals an update (auto-save under the same id).
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
      // Stages from the new schema carry lat/lng (set in tour.jsx planRoute).
      // For older entries fall back to geometry[endIdx] if the blob has it.
      let lat = s.lat, lng = s.lng;
      if ((lat == null || lng == null) && Array.isArray(blob.geometry) && s.endIdx != null) {
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

  const [cache, setCache] = useState(readCache);
  const [loading, setLoading] = useState({});
  const [error, setError] = useState({});
  const [refreshedAgo, setRefreshedAgo] = useState("just now");

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
        setLoading((l) => ({ ...l, [i]: true }));
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
              sunrise: j.daily.sunrise[di],
              sunset: j.daily.sunset[di],
            } : null;
            const hourly = [];
            const hours = (j.hourly && j.hourly.time) || [];
            for (let hi = 0; hi < hours.length; hi++) {
              if (!hours[hi].startsWith(s.date)) continue;
              const hour = Number(hours[hi].slice(11, 13));
              if (hour % 2 !== 0 || hour < 6 || hour > 20) continue;
              hourly.push({
                hr: String(hour).padStart(2, "0"),
                t: j.hourly.temperature_2m[hi],
                p: j.hourly.precipitation_probability[hi] ?? 0,
                code: j.hourly.weathercode[hi],
              });
            }
            const stripDaily = {
              time: j.daily.time,
              weathercode: j.daily.weathercode,
              temperature_2m_max: j.daily.temperature_2m_max,
              temperature_2m_min: j.daily.temperature_2m_min,
              precipitation_probability_max: j.daily.precipitation_probability_max,
            };
            next[k] = { fetchedAt: Date.now(), daily, hourly, stripDaily };
            touched = true;
          } else {
            const d = new Date(s.date);
            const year = d.getFullYear() - 1;
            const climate = await fetchClimateMonth(s.lat, s.lng, year, d.getMonth());
            if (cancelled) return;
            next[k] = { fetchedAt: Date.now(), climate };
            touched = true;
          }
        } catch (e) {
          if (cancelled) return;
          setError((er) => ({ ...er, [i]: String(e.message || e) }));
        } finally {
          if (!cancelled) setLoading((l) => ({ ...l, [i]: false }));
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

  useEffect(() => {
    const tick = () => {
      const stamps = Object.values(cache).map((v) => v.fetchedAt).filter(Boolean);
      if (!stamps.length) { setRefreshedAgo("—"); return; }
      const newest = Math.max(...stamps);
      const min = Math.round((Date.now() - newest) / 60000);
      setRefreshedAgo(min < 1 ? "just now" : `${min} min ago`);
    };
    tick();
    const t = setInterval(tick, 30000);
    return () => clearInterval(t);
  }, [cache]);

  if (tours.length === 0) return <EmptyState reason="no-tours" />;
  if (!tour) return <EmptyState reason="no-selection" />;
  if (!startDate) return <EmptyState reason="no-date" tourName={tour.name} />;
  if (!usableStages) return <EmptyState reason="no-stages" tourName={tour.name} />;

  const safeIdx = Math.min(activeStop, stopBuckets.length - 1);
  const active = stopBuckets[safeIdx];
  const activeKey = active && tour ? cacheKey(safeIdx, active.date, tour.id) : null;
  const activeEntry = activeKey ? cache[activeKey] : null;

  const stripFromEntry = Object.values(cache).find((v) => v.stripDaily);
  const strip = stripFromEntry && stripFromEntry.stripDaily;

  const eventDates = {};
  stopBuckets.forEach((s, i) => { eventDates[s.date] = i; });

  return (
    <div className="fade-in">
      <div className="weather-layout">
        <div style={{ display: "grid", gap: 14 }}>
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

          <div className="card">
            <p className="stop-rail-title">Stops</p>
            <div className="stop-rail">
              {stopBuckets.map((s, i) => {
                const k = cacheKey(i, s.date, tour.id);
                const entry = cache[k];
                const Icon = entry && entry.daily ? window.iconForCode(entry.daily.weathercode) : window.IconCloud;
                const hi = entry && entry.daily ? Math.round(entry.daily.temperature_2m_max)
                          : entry && entry.climate ? Math.round(entry.climate.meanHigh)
                          : null;
                return (
                  <div
                    key={i}
                    className={"stop-pill" + (i === safeIdx ? " active" : "")}
                    onClick={() => setActiveStop(i)}
                  >
                    <span className="stop-num">{i + 1}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="stop-name">{s.to}</div>
                      <div className="stop-sub">{fmtLongDate(s.date)}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: entry && entry.daily && entry.daily.weathercode >= 50 ? "var(--accent)" : "var(--warm)" }}>
                        <Icon size={20} />
                      </span>
                      <span className="stop-mini-temp">{hi != null ? `${hi}°` : "—"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <Hero stop={active} idx={safeIdx} daily={activeEntry && activeEntry.daily} />

          {active && active.kind === "forecast"
            ? <StopDetailForecast stop={active} idx={safeIdx} daily={activeEntry && activeEntry.daily} hourly={activeEntry && activeEntry.hourly} />
            : <StopDetailClimate stop={active} idx={safeIdx} climate={activeEntry && activeEntry.climate} />
          }

          <ForecastStrip forecast={strip} refreshedAgo={refreshedAgo} stopName={active && active.to} eventDates={eventDates} />

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
