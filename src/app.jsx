/* global window, React, ReactDOM */
// Root component: header tabs + active view + floating tweaks panel.
(() => {
const { useState, useEffect } = React;

function readFitnessLabel() {
  try {
    const p = JSON.parse(window.localStorage.getItem("ridePrep:planInputs") || "null");
    const a = p && p.athlete;
    if (a && a.fitnessMode === "FTP" && a.ftp) return `FTP ${a.ftp}W`;
    if (a && a.fitnessMode === "Fitness Level" && a.fitnessLevel) return a.fitnessLevel;
    return null;
  } catch { return null; }
}

function App() {
  const [tab, setTab] = useState("tour"); // start on tour to show the map
  const [fitnessLabel, setFitnessLabel] = useState(readFitnessLabel);

  // Allow descendants (e.g. Training) to switch tabs via a custom event,
  // without threading setTab through the prop tree.
  useEffect(() => {
    const handler = (e) => {
      if (e.detail === "training" || e.detail === "tour" || e.detail === "weather") setTab(e.detail);
    };
    window.addEventListener("rideprep:switch-tab", handler);
    return () => window.removeEventListener("rideprep:switch-tab", handler);
  }, []);

  // Re-read fitness label whenever the user returns from Training tab.
  useEffect(() => { setFitnessLabel(readFitnessLabel()); }, [tab]);

  // Live updates: Training dispatches "rideprep:inputs-changed" on every
  // planInputs edit, so the pill stays in sync without a tab switch.
  useEffect(() => {
    const handler = () => setFitnessLabel(readFitnessLabel());
    window.addEventListener("rideprep:inputs-changed", handler);
    return () => window.removeEventListener("rideprep:inputs-changed", handler);
  }, []);
  const [tweaks, setTweaks] = useState(window.__TWEAKS__ || {
    theme: "midnight",
    units: "metric",
    density: "normal",
    accent: "#4cc9f0",
    mapStyle: "cyclosm",
  });

  const [goal, setGoal] = useState({
    distance: 160,
    ftp: 245,
    weeks: "6 wk",
    focus: "Climbing",
    units: tweaks.units,
  });

  const { Brand, Pill, Tooltip } = window.RP_SHARED;
  const fitnessTip = !fitnessLabel
    ? null
    : fitnessLabel.startsWith("FTP ")
      ? "Functional Threshold Power. The power you can sustain for about an hour. Used to set workout intensities."
      : "Your self-rated fitness level. Used to estimate workout intensities since you didn't enter an FTP.";
  const Training = window.RP_Training;
  const Tour = window.RP_Tour;
  const Weather = window.RP_Weather;
  const Tweaks = window.RP_Tweaks;

  return (
    <div className="app">
      <header className="header">
        <Brand />
        <div className="tabs" role="tablist">
          <button
            role="tab"
            className="tab"
            data-text="Training"
            aria-selected={tab === "training"}
            onClick={() => setTab("training")}
          >
            Training
          </button>
          <button
            role="tab"
            className="tab"
            data-text="Tour Planner"
            aria-selected={tab === "tour"}
            onClick={() => setTab("tour")}
          >
            Tour Planner
          </button>
          <button
            role="tab"
            className="tab"
            data-text="Weather"
            aria-selected={tab === "weather"}
            onClick={() => setTab("weather")}
          >
            Weather
          </button>
        </div>
        <div className="header-meta">
          {tab === "weather"
            ? <Pill>16-day window</Pill>
            : <>
                <Pill>2026 · W19</Pill>
                {fitnessLabel && (
                  <Tooltip content={fitnessTip} side="bottom">
                    <Pill>{fitnessLabel}</Pill>
                  </Tooltip>
                )}
              </>}
        </div>
      </header>

      <main className="view">
        {tab === "training" && <Training goal={goal} setGoal={setGoal} />}
        {tab === "tour" && <Tour tweaks={tweaks} />}
        {tab === "weather" && Weather && <Weather />}
      </main>

      <Tweaks tweaks={tweaks} setTweaks={setTweaks} />
    </div>
  );
}

// Mount once all sibling babel scripts are evaluated. Babel-standalone
// runs scripts sequentially, so by the time app.jsx executes everything
// else has registered onto window.
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
})();
