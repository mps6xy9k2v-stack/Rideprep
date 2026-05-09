/* global window, React, ReactDOM */
// Root component: header tabs + active view + floating tweaks panel.

const { useState } = React;

function App() {
  const [tab, setTab] = useState("tour"); // start on tour to show the map
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

  const { Brand, Pill } = window.RP_SHARED;
  const Training = window.RP_Training;
  const Tour = window.RP_Tour;
  const Tweaks = window.RP_Tweaks;

  return (
    <div className="app">
      <header className="header">
        <Brand />
        <div className="tabs" role="tablist">
          <button
            role="tab"
            className="tab"
            aria-selected={tab === "training"}
            onClick={() => setTab("training")}
          >
            <span className="tab-dot" />
            Training
          </button>
          <button
            role="tab"
            className="tab"
            aria-selected={tab === "tour"}
            onClick={() => setTab("tour")}
          >
            <span className="tab-dot" />
            Tour Planner
          </button>
        </div>
        <div className="header-meta">
          <Pill>2026 · W19</Pill>
          <Pill>FTP {goal.ftp}w</Pill>
        </div>
      </header>

      <main className="view">
        {tab === "training"
          ? <Training goal={goal} setGoal={setGoal} />
          : <Tour tweaks={tweaks} />}
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
