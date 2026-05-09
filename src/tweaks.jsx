/* global window, React */
// Floating settings panel: theme, units, density, accent, map style.
(() => {
const { useState, useEffect } = React;

const ACCENTS = ["#4cc9f0", "#9bd1a4", "#f4b860", "#e07a5f", "#c45a8a"];

function Tweaks({ tweaks, setTweaks }) {
  const [open, setOpen] = useState(false);

  // Apply theme + density + accent to <html>.
  useEffect(() => {
    const root = document.documentElement;
    if (tweaks.theme === "dawn") root.setAttribute("data-theme", "dawn");
    else root.removeAttribute("data-theme");

    if (tweaks.density === "dense") root.setAttribute("data-density", "dense");
    else root.removeAttribute("data-density");

    if (tweaks.accent) root.style.setProperty("--accent", tweaks.accent);
  }, [tweaks]);

  if (!open) {
    return (
      <button className="tweaks-fab" onClick={() => setOpen(true)} aria-label="Open settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.06-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    );
  }

  return (
    <div className="tweaks-panel">
      <header>
        <h3>Tweaks</h3>
        <button className="close" onClick={() => setOpen(false)} aria-label="Close">×</button>
      </header>

      <div className="tweak-row">
        <label>Theme</label>
        <div className="seg">
          {["midnight", "dawn"].map((t) => (
            <button
              key={t}
              aria-pressed={tweaks.theme === t}
              onClick={() => setTweaks({ ...tweaks, theme: t })}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label>Units</label>
        <div className="seg">
          {["metric", "imperial"].map((u) => (
            <button
              key={u}
              aria-pressed={tweaks.units === u}
              onClick={() => setTweaks({ ...tweaks, units: u })}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label>Density</label>
        <div className="seg">
          {["normal", "dense"].map((d) => (
            <button
              key={d}
              aria-pressed={tweaks.density === d}
              onClick={() => setTweaks({ ...tweaks, density: d })}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label>Accent</label>
        <div className="swatches">
          {ACCENTS.map((c) => (
            <button
              key={c}
              className="swatch-btn"
              aria-pressed={tweaks.accent === c}
              style={{ "--s": c }}
              onClick={() => setTweaks({ ...tweaks, accent: c })}
              aria-label={`Accent ${c}`}
            />
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label>Map style</label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {[
            ["light",   "Light",    "Minimal grey"],
            ["dark",    "Dark",     "Minimal black"],
            ["voyager", "Voyager",  "Soft colour"],
            ["cyclosm", "CyclOSM",  "Cycle paths"],
            ["osm",     "OSM",      "Standard"],
          ].map(([k, v, hint]) => (
            <button
              key={k}
              aria-pressed={tweaks.mapStyle === k}
              onClick={() => setTweaks({ ...tweaks, mapStyle: k })}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid var(--line)",
                background: tweaks.mapStyle === k ? "var(--bg-2)" : "transparent",
                textAlign: "left",
                fontSize: 12,
                color: "var(--fg)",
                lineHeight: 1.3,
              }}
            >
              <div style={{ fontWeight: 500 }}>{v}</div>
              <div className="mono faint" style={{ fontSize: 9, marginTop: 2 }}>{hint}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

window.RP_Tweaks = Tweaks;
})();
