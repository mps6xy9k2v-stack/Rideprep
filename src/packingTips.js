/* global window */
// AI-generated packing tips via the Google Gemini API (gemini-2.5-flash).
//
// SECURITY NOTE: This calls generativelanguage.googleapis.com directly
// from the browser using window.__GEMINI_API_KEY__. Anyone who can open
// the page can read the key from the bundle / devtools. The app already
// follows the same "personal-use, client-side key" pattern for
// window.__ORS_API_KEY__, so this is consistent — but if you ever ship
// publicly, move this call behind a server-side proxy and restrict the
// Gemini key by HTTP referrer in Google Cloud Console.
//
// Behaviour:
//   - If no API key is configured, fetchPackingTips throws and the
//     caller falls back to its local rule-based tips. No error UI is
//     shown — the feature is silently opt-in.
//   - Cache keyed by stage lat/lng/date + a hash of the weather inputs,
//     so tips are invalidated when the forecast moves.
(() => {

const STORAGE_PREFIX = "rideprep:packingtips:";
const MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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

function buildPrompt(ctx) {
  const { tour, stage, weather, month, training } = ctx;
  const lines = [];
  lines.push("You are a cycling tour preparation expert. Generate exactly 5 to 7 practical packing tips for a cyclist based on the following data.");
  lines.push("");
  if (tour) {
    lines.push(`Tour: ${tour.from || "?"} to ${tour.to || "?"}`);
    lines.push(`Total tour: ${tour.totalKm} km over ${tour.stageCount || "?"} days, ${tour.totalAscent || 0} m elevation gain`);
  }
  if (stage) {
    lines.push(`This stage (Stage ${stage.index + 1}): ${stage.from || "?"} to ${stage.to || "?"}, ${stage.km} km, ${stage.ascent || 0} m ascent${stage.descent ? `, ${stage.descent} m descent` : ""}`);
  }
  if (weather && weather.kind === "forecast") {
    lines.push(
      `Weather: ${Math.round(weather.tempMin)}°C to ${Math.round(weather.tempMax)}°C, ` +
      `${Math.round(weather.precipProb || 0)}% rain chance ` +
      `(${(weather.precipMm || 0).toFixed(1)} mm), ` +
      `wind ${Math.round(weather.windKmh || 0)} km/h`
    );
  } else if (weather && weather.kind === "climate") {
    lines.push(
      `Climate average (forecast not yet available): ` +
      `${Math.round(weather.tempMin)}°C to ${Math.round(weather.tempMax)}°C, ` +
      `${Math.round(weather.monthRainMm || 0)} mm monthly rainfall ` +
      `(${Math.round((weather.rainDayFrac || 0) * 100)}% of days have rain), ` +
      `mean wind ${Math.round(weather.windKmh || 0)} km/h`
    );
  }
  lines.push(`Month: ${month}`);
  lines.push(`Fitness level: ${(training && training.fitnessLevel) || "recreational"}`);
  lines.push("");
  lines.push("Rules:");
  lines.push("- Be specific to cycling, not generic travel tips");
  lines.push("- Tailor tips to the weather (rain gear if over 30% precipitation, sun protection if over 25°C, warm layers if under 10°C)");
  lines.push("- Consider tour length and elevation");
  lines.push("- Each tip is one concise sentence (~12 words or fewer)");
  lines.push("- Do not include food, hydration, or nutrition tips");
  lines.push("- Respond with a JSON array of strings only, no markdown, no explanation");
  return lines.join("\n");
}

async function fetchPackingTips(ctx) {
  const proxyUrl = window.__PACKING_TIPS_PROXY_URL__;
  const apiKey = window.__GEMINI_API_KEY__;
  if (!proxyUrl && !apiKey) throw new Error("No proxy URL or Gemini API key configured");

  const body = {
    contents: [{ parts: [{ text: buildPrompt(ctx) }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 500,
      // gemini-2.5-flash respects this and returns pure JSON — no
      // ```json fences, no "Here's your list:" preamble, no thinking
      // blocks. Older Gemini variants ignore it, which is fine: the
      // parser below still tolerates fences and prose.
      responseMimeType: "application/json",
    },
  };

  // Prefer the proxy when set — keeps the key server-side. Direct mode
  // is the local-dev / private-repo escape hatch.
  const url = proxyUrl
    ? proxyUrl
    : `${ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  // TODO: remove once Gemini path is confirmed working end-to-end.
  // eslint-disable-next-line no-console
  console.log("[packingTips] POST", url.replace(/key=[^&]+/, "key=***"), "promptLen", body.contents[0].parts[0].text.length);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line no-console
  console.log("[packingTips] response", res.status, res.statusText);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.text()).slice(0, 240); } catch {}
    // eslint-disable-next-line no-console
    console.warn("[packingTips] non-OK body:", detail);
    throw new Error(`Gemini ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const text =
    (data && data.candidates && data.candidates[0] &&
     data.candidates[0].content && data.candidates[0].content.parts &&
     data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || "";

  // eslint-disable-next-line no-console
  console.log("[packingTips] raw response text:", text);
  // eslint-disable-next-line no-console
  console.log("[packingTips] raw response type:", typeof text);
  // eslint-disable-next-line no-console
  console.log("[packingTips] raw response length:", text && text.length);

  const tips = parseGeminiResponse(text);
  if (!tips.length) throw new Error("Response was not a JSON array of strings");
  return tips.slice(0, 7);
}

// Robust parser for the model's text payload. Handles:
//   - pure JSON (when responseMimeType: application/json is honoured),
//   - ```json … ``` / ``` … ``` fences,
//   - leading <thinking>…</thinking> blocks emitted by reasoning models,
//   - prose wrapping by extracting the first '[' to the last ']'.
// Returns an array of non-empty trimmed strings, or [] on any failure.
function parseGeminiResponse(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  let cleaned = rawText.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
  cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  // Try the whole string first; if it doesn't parse, slice the
  // outermost bracketed range.
  let parsed = null;
  try { parsed = JSON.parse(cleaned); }
  catch {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return [];
    try { parsed = JSON.parse(cleaned.slice(start, end + 1)); }
    catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((s) => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

window.RP_PackingTips = {
  STORAGE_PREFIX,
  cacheKey, readCache, writeCache, clearCache, weatherHash,
  fetchPackingTips,
  buildPrompt, MODEL,
};

// One-shot startup line so we can confirm at a glance whether the
// proxy URL / direct key actually reached the page.
// eslint-disable-next-line no-console
console.log("[packingTips] config", {
  proxy: window.__PACKING_TIPS_PROXY_URL__ || "(none)",
  hasKey: !!window.__GEMINI_API_KEY__,
  model: MODEL,
});

// One-shot probe: list the models this API key can actually use, so
// "model not found" failures become obvious. Uses the proxy (the
// worker exposes the models list on GET) when configured; otherwise
// hits Google directly with the raw key. Skipped if neither is set.
(function listModels() {
  const proxyUrl = window.__PACKING_TIPS_PROXY_URL__;
  const apiKey = window.__GEMINI_API_KEY__;
  if (!proxyUrl && !apiKey) return;
  const url = proxyUrl
    ? proxyUrl
    : `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  fetch(url, { method: "GET" })
    .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then((data) => {
      const names = (data && data.models || []).map((m) => m.name);
      // eslint-disable-next-line no-console
      console.log("[packingTips] available models:", names);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[packingTips] could not list models:", e && e.message ? e.message : e);
    });
})();

})();
