/* global window */
// AI-generated packing tips via the Anthropic API.
//
// SECURITY NOTE: This calls api.anthropic.com directly from the browser
// using window.__ANTHROPIC_API_KEY__. Anyone who can open the page can
// read the key from the bundle / devtools. The app already follows the
// same "personal-use, client-side key" pattern for window.__ORS_API_KEY__,
// so this is consistent — but if you ever ship publicly, move this call
// behind a server-side proxy.
//
// Behaviour:
//   - If no API key is configured, fetchPackingTips throws and the
//     caller falls back to its local rule-based tips. No error UI is
//     shown — the feature is silently opt-in.
//   - Cache keyed by stage lat/lng/date + a hash of the weather inputs,
//     so tips are invalidated when the forecast moves.
(() => {

const STORAGE_PREFIX = "rideprep:packingtips:";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

function cacheKey({ lat, lng, date, weatherHash }) {
  const llat = (Math.round(lat * 1000) / 1000).toFixed(3);
  const llng = (Math.round(lng * 1000) / 1000).toFixed(3);
  return `${STORAGE_PREFIX}${llat},${llng}:${date}:${weatherHash}`;
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeCache(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function clearCache(key) {
  try { localStorage.removeItem(key); } catch {}
}

// A short, stable signature of the weather inputs. Two stages with
// identical weather data hit the same cache; small forecast updates
// (e.g. a 2°C shift) invalidate it cleanly.
function weatherHash(ctx) {
  const w = ctx && ctx.weather;
  if (!w) return "none";
  if (w.kind === "forecast") {
    const round = (v) => v == null ? "-" : String(Math.round(Number(v)));
    return [
      "fc",
      round(w.tempMin), round(w.tempMax),
      round((w.precipMm || 0) * 10),
      round(w.precipProb),
      round(w.windKmh),
      round(w.weatherCode),
    ].join("|");
  }
  if (w.kind === "climate") {
    const round = (v) => v == null ? "-" : String(Math.round(Number(v)));
    return [
      "cl",
      round(w.tempMin), round(w.tempMax),
      round(w.monthRainMm),
      round((w.rainDayFrac || 0) * 100),
      round(w.windKmh),
    ].join("|");
  }
  return "none";
}

function buildUserMessage(ctx) {
  const { tour, stage, weather, month, training } = ctx;
  const lines = [];
  if (tour) {
    lines.push(`Tour: ${tour.from || "?"} → ${tour.to || "?"}, ${tour.totalKm} km over ${tour.stageCount || "?"} days, ${tour.totalAscent || 0} m total ascent.`);
  }
  if (stage) {
    lines.push(`This stage (Stage ${stage.index + 1}): ${stage.from || "?"} → ${stage.to || "?"}, ${stage.km} km, ${stage.ascent || 0} m ascent${stage.descent ? `, ${stage.descent} m descent` : ""}.`);
  }
  if (weather && weather.kind === "forecast") {
    lines.push(
      `Forecast (${month}): ${Math.round(weather.tempMin)}°C – ${Math.round(weather.tempMax)}°C, ` +
      `total rain ${(weather.precipMm || 0).toFixed(1)} mm at peak ${Math.round(weather.precipProb || 0)}% probability, ` +
      `max wind ${Math.round(weather.windKmh || 0)} km/h, weather code ${weather.weatherCode}.`
    );
  } else if (weather && weather.kind === "climate") {
    lines.push(
      `Climate average for ${month} at this location: ` +
      `${Math.round(weather.tempMin)}°C – ${Math.round(weather.tempMax)}°C, ` +
      `${Math.round(weather.monthRainMm || 0)} mm total monthly rainfall ` +
      `(${Math.round((weather.rainDayFrac || 0) * 100)}% of days have rain), ` +
      `mean wind ${Math.round(weather.windKmh || 0)} km/h. ` +
      `Detailed forecast is not yet available — event is beyond the 16-day window.`
    );
  }
  if (training && training.fitnessLevel) {
    const wh = training.weeklyHours ? `, training about ${training.weeklyHours} hours per week` : "";
    lines.push(`Rider: ${training.fitnessLevel} level${wh}.`);
  }
  return `Generate packing tips for this cycling stage.\n\n${lines.join("\n")}`;
}

const SYSTEM_PROMPT = `You are a cycling tour preparation expert. Generate practical, specific packing tips for a cyclist based on their tour, stage, and weather data.

Rules:
- Give exactly 5 to 7 packing tips
- Be specific and practical, not generic
- Tailor every tip to the actual weather conditions, stage distance, elevation, and season provided
- Focus on what to pack (gear, clothing, accessories), not what to do or how to ride
- Keep each tip to a single concise sentence, ~12 words or fewer
- Do not include tips about food, hydration, or nutrition — those are handled elsewhere in the app
- Weather-aware: rain gear when precipitation probability is above ~30%, sun protection when high is above 25°C, insulating layers when low is below 10°C
- Distance-aware: longer tours need more durable/packable gear, spares, and laundry-friendly fabrics
- Elevation-aware: significant climbs mean colder, windier descents and exposed ridges
- Climate-mode (when detailed forecast is unavailable): give tips appropriate to the monthly averages, and lean slightly more conservative
- Respond with a JSON array of strings only — no markdown, no preamble, no trailing text`;

async function fetchPackingTips(ctx) {
  const proxyUrl = window.__PACKING_TIPS_PROXY_URL__;
  const directKey = window.__ANTHROPIC_API_KEY__;
  if (!proxyUrl && !directKey) throw new Error("No proxy URL or Anthropic API key configured");

  const body = {
    model: MODEL,
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(ctx) }],
  };

  // Prefer the proxy when set — keeps the key server-side. Direct mode
  // is kept as a legacy escape hatch for local dev (file://) or private
  // repos where exposing the key in the page is acceptable.
  const endpoint = proxyUrl || "https://api.anthropic.com/v1/messages";
  const headers = { "Content-Type": "application/json" };
  if (!proxyUrl) {
    headers["x-api-key"] = directKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.text()).slice(0, 240); } catch {}
    throw new Error(`Anthropic ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const text = (data && data.content && data.content[0] && data.content[0].text) || "";

  let tips;
  try { tips = JSON.parse(text); }
  catch {
    // Be lenient if the model accidentally wraps in code fences or prose.
    const m = text.match(/\[[\s\S]*?\]/);
    if (m) { try { tips = JSON.parse(m[0]); } catch {} }
  }
  if (!Array.isArray(tips) || !tips.length || !tips.every((t) => typeof t === "string")) {
    throw new Error("Response was not a JSON array of strings");
  }
  return tips.map((t) => t.trim()).filter(Boolean).slice(0, 7);
}

window.RP_PackingTips = {
  STORAGE_PREFIX,
  cacheKey, readCache, writeCache, clearCache, weatherHash,
  fetchPackingTips,
  buildUserMessage, SYSTEM_PROMPT, MODEL, // exported for testing/debug
};

})();
