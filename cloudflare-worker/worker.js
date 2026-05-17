// Cloudflare Worker — Google Gemini proxy for RidePrep packing tips.
//
// What this does:
//   The browser POSTs a normal Gemini generateContent request body to
//   this Worker. The Worker attaches the secret GEMINI_API_KEY (set in
//   the Worker dashboard, not in code) and forwards to Gemini. The
//   response is returned to the browser with CORS headers.
//
// Why:
//   The Gemini API key never reaches the browser, so it can't be
//   scraped from the public GitHub Pages site. The repo + frontend can
//   stay public; the key lives on Cloudflare.
//
// Setup (one-time, on your side):
//   1. Sign up at cloudflare.com (free).
//   2. Workers & Pages → Create application → Create Worker.
//   3. Name it (e.g. "rideprep-gemini-proxy"). Paste this whole file
//      into the editor, replacing the default code. Click Deploy.
//   4. After deploy, open the Worker's Settings → Variables and Secrets:
//      Add a new variable named exactly  GEMINI_API_KEY  with type
//      "Secret" and your AIza… key as the value. Save.
//   5. Cloudflare shows your Worker URL near the top, like
//      https://rideprep-gemini-proxy.your-name.workers.dev
//      Put that URL into index.html as window.__PACKING_TIPS_PROXY_URL__.
//   6. Update ALLOWED_ORIGINS below to include the exact origin of
//      your deployed site (everything before the path — e.g.
//      "https://mps6xy9k2v-stack.github.io", no trailing slash). Add
//      "http://localhost:8080" / "http://127.0.0.1:8080" if you ever
//      run locally. Re-deploy the Worker after edits.
//
// Limits we enforce on every request (so abuse can't drain free-tier
// quota):
//   - Only POST is accepted; other methods get 405.
//   - The Origin header must match an entry in ALLOWED_ORIGINS.
//   - maxOutputTokens is capped at 1000 server-side regardless of what
//     the client asked for.
//   - Model is hardcoded to gemini-2.0-flash-001 — clients cannot upgrade
//     to a paid model via this proxy.
//   - The body must be valid JSON with a `contents` field.

const ALLOWED_ORIGINS = [
  // ⬇ Replace this with your real deployed origin before deploying.
  "https://mps6xy9k2v-stack.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

const MODEL = "gemini-2.0-flash-001";
const UPSTREAM = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!ALLOWED_ORIGINS.includes(origin)) {
      return jsonResponse(403, { error: "Forbidden origin", origin }, origin);
    }

    if (!env.GEMINI_API_KEY) {
      return jsonResponse(500, {
        error: "Server not configured: GEMINI_API_KEY secret is missing",
      }, origin);
    }

    // GET = diagnostic "list available models for this key" probe.
    // Lets the browser introspect what model names are actually usable
    // through this proxy without ever exposing the API key.
    if (request.method === "GET") {
      const listRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(env.GEMINI_API_KEY)}`
      );
      const text = await listRes.text();
      return new Response(text, {
        status: listRes.status,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": listRes.headers.get("Content-Type") || "application/json",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders(origin),
      });
    }

    let parsed;
    try { parsed = JSON.parse(await request.text()); }
    catch { return jsonResponse(400, { error: "Invalid JSON body" }, origin); }

    if (!Array.isArray(parsed.contents)) {
      return jsonResponse(400, { error: "Missing contents array" }, origin);
    }

    // Bound maxOutputTokens so a malicious client can't run up the
    // bill on huge completions. 1000 is well over what packing tips
    // ever needs.
    parsed.generationConfig = parsed.generationConfig || {};
    const requested = Number(parsed.generationConfig.maxOutputTokens) || 500;
    parsed.generationConfig.maxOutputTokens = Math.min(requested, 1000);

    const upstream = await fetch(`${UPSTREAM}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      },
    });
  },
};
