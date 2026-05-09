/* global window, React */
// Training view: plan generator inputs (left) + plan output (right).
(() => {
const { useState, useMemo, useEffect } = React;

const STORAGE_KEY = "ridePrep:planInputs";

const DEFAULT_INPUTS = {
  eventSource: null,
  externalEvent: { type: null, distance: null, elevation: null, date: null },
  athlete: { height: null, weight: null, gender: null, fitnessMode: null, ftp: null, fitnessLevel: null },
  planOptions: { timeCrunched: false, weeklyHours: null },
};

function loadSaved() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_INPUTS, ...JSON.parse(raw) } : null;
  } catch { return null; }
}

// ── Shared primitives ────────────────────────────────────────────────────────

function Seg({ options, value, onChange, wrap }) {
  return (
    <div className={"seg" + (wrap ? " seg-wrap" : "")} role="tablist">
      {options.map((opt) => (
        <button
          key={opt}
          aria-pressed={value === opt}
          onClick={() => onChange(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function NumField({ value, onChange, suffix, min, max }) {
  return (
    <div className="num-input">
      <input
        type="number"
        min={min}
        max={max}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : +e.target.value)}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

// ── Section cards ────────────────────────────────────────────────────────────

function EventSetupCard({ inputs, setInputs }) {
  const { eventSource, externalEvent } = inputs;
  const setSource = (v) => setInputs({ ...inputs, eventSource: v });
  const setEvent = (patch) =>
    setInputs({ ...inputs, externalEvent: { ...externalEvent, ...patch } });

  const today = new Date().toISOString().split("T")[0];

  return (
    <div className="card">
      <div className="card-title">
        <h2>Event Setup</h2>
        <span className="sub">Step 1</span>
      </div>
      <div className="goal-group">
        <Seg
          options={["From Tour Planner", "External Event"]}
          value={eventSource}
          onChange={setSource}
        />

        {eventSource === "From Tour Planner" && (
          <p className="plan-placeholder">Tour Planner integration coming soon</p>
        )}

        {eventSource === "External Event" && (
          <>
            <div className="goal-row">
              <label>Event Type</label>
              <Seg
                options={["Race", "Sportive", "Long Tour"]}
                value={externalEvent.type}
                onChange={(v) => setEvent({ type: v })}
              />
            </div>
            <div className="goal-row">
              <label>Distance</label>
              <NumField
                value={externalEvent.distance}
                onChange={(v) => setEvent({ distance: v })}
                suffix="km"
              />
            </div>
            <div className="goal-row">
              <label>Elevation</label>
              <NumField
                value={externalEvent.elevation}
                onChange={(v) => setEvent({ elevation: v })}
                suffix="m"
              />
            </div>
            <div className="goal-row">
              <label>Event Date</label>
              <div className="num-input date-input">
                <input
                  type="date"
                  min={today}
                  value={externalEvent.date ?? ""}
                  onChange={(e) => setEvent({ date: e.target.value || null })}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AthleteProfileCard({ inputs, setInputs }) {
  const { athlete } = inputs;
  const setAthlete = (patch) =>
    setInputs({ ...inputs, athlete: { ...athlete, ...patch } });

  const FITNESS_LEVELS = ["Beginner", "Recreational", "Trained", "Well-Trained", "Competitive"];

  return (
    <div className="card">
      <div className="card-title">
        <h2>Athlete Profile</h2>
        <span className="sub">Step 2</span>
      </div>
      <div className="goal-group">
        <div className="goal-row">
          <label>Height</label>
          <NumField value={athlete.height} onChange={(v) => setAthlete({ height: v })} suffix="cm" />
        </div>
        <div className="goal-row">
          <label>Weight</label>
          <NumField value={athlete.weight} onChange={(v) => setAthlete({ weight: v })} suffix="kg" />
        </div>
        <div className="goal-row">
          <label>Gender</label>
          <Seg
            options={["Male", "Female", "Other"]}
            value={athlete.gender}
            onChange={(v) => setAthlete({ gender: v })}
          />
        </div>
        <div className="goal-row">
          <label>Fitness Input</label>
          <Seg
            options={["FTP", "Fitness Level"]}
            value={athlete.fitnessMode}
            onChange={(v) => setAthlete({ fitnessMode: v })}
          />
        </div>
        {athlete.fitnessMode === "FTP" && (
          <div className="goal-row">
            <label>FTP</label>
            <NumField value={athlete.ftp} onChange={(v) => setAthlete({ ftp: v })} suffix="watts" />
          </div>
        )}
        {athlete.fitnessMode === "Fitness Level" && (
          <div className="goal-row">
            <label>Fitness Level</label>
            <Seg
              options={FITNESS_LEVELS}
              value={athlete.fitnessLevel}
              onChange={(v) => setAthlete({ fitnessLevel: v })}
              wrap
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PlanOptionsCard({ inputs, setInputs }) {
  const { planOptions } = inputs;
  const setOpts = (patch) =>
    setInputs({ ...inputs, planOptions: { ...planOptions, ...patch } });

  return (
    <div className="card">
      <div className="card-title">
        <h2>Plan Options</h2>
        <span className="sub">Step 3</span>
      </div>
      <div className="goal-group">
        <label className="check-row">
          <input
            type="checkbox"
            checked={planOptions.timeCrunched}
            onChange={(e) =>
              setOpts({
                timeCrunched: e.target.checked,
                weeklyHours: e.target.checked ? planOptions.weeklyHours : null,
              })
            }
          />
          <span>I have less than 8 hours per week to train</span>
        </label>
        {planOptions.timeCrunched && (
          <div className="goal-row">
            <label>Weekly hours available</label>
            <NumField
              value={planOptions.weeklyHours}
              onChange={(v) => setOpts({ weeklyHours: v })}
              suffix="hrs / wk"
              min={3}
              max={7}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Validation ───────────────────────────────────────────────────────────────

function isValid(inputs) {
  const { eventSource, externalEvent, athlete, planOptions } = inputs;
  if (!eventSource) return false;
  if (eventSource === "External Event") {
    if (!externalEvent.type || !externalEvent.distance || !externalEvent.elevation || !externalEvent.date)
      return false;
  }
  if (!athlete.height || !athlete.weight || !athlete.gender || !athlete.fitnessMode) return false;
  if (athlete.fitnessMode === "FTP" && !athlete.ftp) return false;
  if (athlete.fitnessMode === "Fitness Level" && !athlete.fitnessLevel) return false;
  if (planOptions.timeCrunched) {
    const h = planOptions.weeklyHours;
    if (!h || h < 3 || h > 7) return false;
  }
  return true;
}

// ── Right-panel components (unchanged) ──────────────────────────────────────

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
            <span className="zone-swatch" style={{ background: z.color }} />
            <span>{z.id} · {z.name}</span>
            <span className="zone-range">{z.range}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Root view ────────────────────────────────────────────────────────────────

function Training({ goal, setGoal }) {
  const { SAMPLE_WEEK, SAMPLE_WORKOUT } = window.RP_DATA;
  const defaultSelected = SAMPLE_WEEK.findIndex((d) => d.selected);
  const [selected, setSelected] = useState(defaultSelected >= 0 ? defaultSelected : 1);

  const [planInputs, setPlanInputs] = useState(() => loadSaved() || DEFAULT_INPUTS);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(planInputs));
    } catch {}
  }, [planInputs]);

  const canGenerate = isValid(planInputs);

  function handleGenerate() {
    if (!canGenerate) return;
    console.log("Plan inputs:", planInputs);
  }

  return (
    <div className="training-layout fade-in">
      <div className="stack">
        <EventSetupCard inputs={planInputs} setInputs={setPlanInputs} />
        <AthleteProfileCard inputs={planInputs} setInputs={setPlanInputs} />
        <PlanOptionsCard inputs={planInputs} setInputs={setPlanInputs} />
        <button
          className="btn btn-primary"
          style={{ width: "100%" }}
          disabled={!canGenerate}
          onClick={handleGenerate}
        >
          Generate Plan
        </button>
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
