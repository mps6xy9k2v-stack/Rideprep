// Cloudflare Worker — Claude proxy for RidePrep packing tips.
//
// What this does:
//   The browser POSTs a normal Anthropic Messages-API request body to
//   this Worker. The Worker attaches the secret ANTHROPIC_API_KEY (set
//   in the Worker dashboard, not in code) and forwards to Anthropic.
//   The response is streamed back to the browser with CORS headers.
//
// Why:
//   The Anthropic API key never reaches the browser, so it can't be
//   scraped from a public GitHub Pages site. The repo + frontend can
//   stay public; the key lives on Cloudflare.
//
// Setup (one-time, on your side):
//   1. Sign up at cloudflare.com (free).
//   2. Workers & Pages → Create application → Create Worker.
//   3. Name it (e.g. "rideprep-claude-proxy"). Paste this whole file
//      into the editor, replacing the default code. Click Deploy.
//   4. After deploy, open the Worker's Settings → Variables and Secrets:
//      Add a new variable named exactly  ANTHROPIC_API_KEY  with type
//      "Secret" and your sk-ant-… key as the value. Save.
//   5. Cloudflare shows your Worker URL near the top, like
//      https://rideprep-claude-proxy.your-name.workers.dev
//      Send that URL to Claude Code and it will wire it into index.html.
//   6. Update ALLOWED_ORIGINS below to include the exact origin of
//      your deployed site (everything before the path — e.g.
//      "https://mps6xy9k2v-stack.github.io", no trailing slash). Add
//      "http://localhost:8080" / "http://127.0.0.1:8080" if you ever
//      run locally. Re-deploy the Worker after edits.
//
// Limits we enforce on every request (so abuse can't drain the cap):
//   - Only POST is accepted; other methods get 405.
//   - The Origin header must match an entry in ALLOWED_ORIGINS.
//   - max_tokens is capped at 2000 server-side regardless of what the
//     client asked for.
//   - The body must be valid JSON with model + messages fields.

const ALLOWED_ORIGINS = [
  // ⬇ Replace this with your real deployed origin before deploying.
  "https://mps6xy9k2v-stack.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders(origin),
      });
    }

    if (!ALLOWED_ORIGINS.includes(origin)) {
      return jsonResponse(403, { error: "Forbidden origin", origin }, origin);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse(500, {
        error: "Server not configured: ANTHROPIC_API_KEY secret is missing",
      }, origin);
    }

    let parsed;
    try { parsed = JSON.parse(await request.text()); }
    catch { return jsonResponse(400, { error: "Invalid JSON body" }, origin); }

    if (!parsed.model || !Array.isArray(parsed.messages)) {
      return jsonResponse(400, { error: "Missing model or messages" }, origin);
    }

    // Bound max_tokens so a malicious client can't run up the bill on
    // huge completions. 2000 is well over what the packing-tips prompt
    // ever produces.
    if (typeof parsed.max_tokens !== "number" || parsed.max_tokens > 2000) {
      parsed.max_tokens = Math.min(Number(parsed.max_tokens) || 1000, 2000);
    }

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
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
