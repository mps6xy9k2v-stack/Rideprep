/* global window, React */
// Training view: goal form, plan hero, week grid, workout detail.
(() => {
const { useState, useMemo } = React;

function GoalForm({ goal, setGoal }) {
  return (
    <div className="card">
      <div className="card-title">
        <h2>Goal</h2>
        <span className="sub">Plan input</span>
      </div>

      <div className="goal-group">
        <div className="goal-row">
          <label>Event distance</label>
          <div className="num-input">
            <input
              type="number"
              value={goal.distance}
              onChange={(e) => setGoal({ ...goal, distance: +e.target.value || 0 })}
            />
            <span className="suffix">{goal.units === "imperial" ? "mi" : "km"}</span>
          </div>
        </div>

        <div className="goal-row">
          <label>FTP</label>
          <div className="num-input">
            <input
              type="number"
              value={goal.ftp}
              onChange={(e) => setGoal({ ...goal, ftp: +e.target.value || 0 })}
            />
            <span className="suffix">watts</span>
          </div>
        </div>

        <div className="goal-row">
          <label>Time until event</label>
          <div className="date-chips">
            {["4 wk", "6 wk", "8 wk", "12 wk", "16 wk", "20 wk"].map((w) => (
              <button
                key={w}
                className="date-chip"
                aria-pressed={goal.weeks === w}
                onClick={() => setGoal({ ...goal, weeks: w })}
              >
                {w}
              </button>
            ))}
          </div>
        </div>

        <div className="goal-row">
          <label>Focus</label>
          <div className="seg" role="tablist">
            {["Endurance", "Climbing", "Sprint"].map((f) => (
              <button
                key={f}
                aria-pressed={goal.focus === f}
                onClick={() => setGoal({ ...goal, focus: f })}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanHero({ goal }) {
  const { PLAN_VOLUME } = window.RP_DATA;
  const max = Math.max(...PLAN_VOLUME);
  const totalKm = PLAN_VOLUME.reduce((a, b) => a + b, 0);

  return (
    <div className="plan-hero">
      <div className="plan-meta">
        <div>
          <span className="label">Plan</span>
          <span className="big">6 weeks</span>
        </div>
        <div>
          <span className="label">Focus</span>
          <span className="val">{goal.focus}</span>
        </div>
        <div>
          <span className="label">Total volume</span>
          <span className="val">{totalKm} km</span>
        </div>
        <div>
          <span className="label">Peak week</span>
          <span className="val">Wk 5 · {max} km</span>
        </div>
      </div>

      <div className="volume-graph-wrap">
        <div className="volume-graph" style={{ "--cols": PLAN_VOLUME.length }}>
          {PLAN_VOLUME.map((v, i) => (
            <div
              key={i}
              className="vol-bar"
              style={{ height: `${(v / max) * 100}%` }}
            >
              <span className="vol-bar-label">Wk {i + 1}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WeekGrid({ days, selected, onSelect }) {
  return (
    <div className="card">
      <div className="card-title">
        <h2>This week</h2>
        <span className="sub">May 4 – May 10</span>
      </div>

      <div className="week-grid">
        {days.map((d, i) => {
          if (d.rest) {
            return (
              <div key={i} className="day-card day-rest">
                <div className="day-head">
                  <span className="day-dow">{d.dow}</span>
                  <span className="day-date">{d.date}</span>
                </div>
                <div className="day-type">Rest</div>
              </div>
            );
          }
          return (
            <div
              key={i}
              className={"day-card" + (i === selected ? " selected" : "")}
              onClick={() => onSelect(i)}
            >
              <div className="day-head">
                <span className="day-dow">{d.dow}</span>
                <span className="day-date">{d.date}</span>
              </div>
              <div className="day-type">{d.type}</div>
              <div className="day-metric">{d.km} km · TSS {d.tss}</div>
              <div className="zone-strip">
                {d.zones.map((z, zi) => (
                  <div
                    key={zi}
                    className="zone-seg"
                    style={{
                      flex: 1,
                      "--z-color": window.RP_DATA.ZONES[z - 1].color,
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkoutDetail({ workout }) {
  // Build a viz with ~60 blocks proportional to interval durations.
  const viz = useMemo(() => {
    const toSec = (s) => {
      const [m, sec] = s.split(":").map(Number);
      return m * 60 + sec;
    };
    const total = workout.intervals.reduce((a, b) => a + toSec(b.duration), 0);
    const N = 80;
    const blocks = [];
    workout.intervals.forEach((iv) => {
      const w = Math.max(1, Math.round((toSec(iv.duration) / total) * N));
      for (let k = 0; k < w; k++) {
        const h = ({ Z1: 25, Z2: 45, Z3: 60, Z4: 75, Z5: 92, Z6: 100 })[iv.zone] || 50;
        blocks.push({ color: iv.color, h });
      }
    });
    return blocks;
  }, [workout]);

  return (
    <div className="card workout-detail">
      <div className="workout-header">
        <div className="workout-title">
          <h3>{workout.title}</h3>
          <div className="workout-meta">
            <span>{workout.duration}</span>
            <span>TSS {workout.tss}</span>
            <span>IF {workout.ifv}</span>
          </div>
        </div>
        <button className="btn btn-primary">Start</button>
      </div>

      <div className="interval-viz">
        {viz.map((b, i) => (
          <div
            key={i}
            className="viz-block"
            style={{ "--z-color": b.color, height: `${b.h}%` }}
          />
        ))}
      </div>

      <div className="intervals">
        {workout.intervals.map((iv, i) => (
          <div key={i} className="interval-row">
            <span
              className="interval-zone"
              style={{ background: iv.color }}
            >
              {iv.zone}
            </span>
            <div>
              <div className="interval-label">{iv.label}</div>
              <div className="interval-detail">{iv.detail}</div>
            </div>
            <span className="interval-duration">{iv.duration}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ZonesCard() {
  return (
    <div className="card">
      <div className="card-title">
        <h2>Zones</h2>
        <span className="sub">Power-based</span>
      </div>
      <div className="zones">
        {window.RP_DATA.ZONES.map((z) => (
          <div key={z.id} className="zone-row">
            <span
              className="zone-swatch"
              style={{ background: z.color }}
            />
            <span>{z.id} · {z.name}</span>
            <span className="zone-range">{z.range}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Training({ goal, setGoal }) {
  const { SAMPLE_WEEK, SAMPLE_WORKOUT } = window.RP_DATA;
  const defaultSelected = SAMPLE_WEEK.findIndex((d) => d.selected);
  const [selected, setSelected] = useState(defaultSelected >= 0 ? defaultSelected : 1);

  return (
    <div className="training-layout fade-in">
      <div className="stack">
        <GoalForm goal={goal} setGoal={setGoal} />
        <ZonesCard />
      </div>

      <div className="stack" style={{ gap: 20 }}>
        <PlanHero goal={goal} />
        <WeekGrid days={SAMPLE_WEEK} selected={selected} onSelect={setSelected} />
        <WorkoutDetail workout={SAMPLE_WORKOUT} />
      </div>
    </div>
  );
}

window.RP_Training = Training;
})();
