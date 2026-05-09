/* global window, React */
// Training view: plan generator inputs (left) + dynamic plan output (right).
(() => {
const { useState, useMemo, useEffect } = React;

const INPUTS_KEY = "ridePrep:planInputs";
const PLAN_KEY   = "ridePrep:generatedPlan";

const DEFAULT_INPUTS = {
  eventSource: null,
  externalEvent: { type: null, distance: null, elevation: null, date: null },
  athlete: { height: null, weight: null, gender: null, fitnessMode: null, ftp: null, fitnessLevel: null },
  planOptions: { timeCrunched: false, weeklyHours: null },
};

function loadJSON(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Shared input primitives ─────────────────────────────────────────────────

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

// ── Input cards ─────────────────────────────────────────────────────────────

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

// ── Validation ──────────────────────────────────────────────────────────────

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

// ── Plan helpers ────────────────────────────────────────────────────────────

const PHASE_COLOR_VAR = {
  Prep:  "var(--fg-faint)",
  Base:  "var(--accent)",
  Build: "var(--warm)",
  Peak:  "var(--danger)",
  Taper: "var(--ok)",
  Adapt: "var(--fg-faint)",
};

const EVENT_LABEL = { race: "Race", sportive: "Sportive", longtour: "Long Tour" };

function zoneColor(zoneId) {
  const z = window.RP_DATA.ZONES.find((x) => x.id === zoneId);
  return z ? z.color : "var(--accent)";
}

function firstNonRestDay(week) {
  if (!week) return null;
  const idx = week.days.findIndex((d) => d.workout);
  return idx >= 0 ? idx : null;
}

function fmtDuration(min) {
  if (!min) return "0m";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// Plan starts on the Monday of the user's current week, so day labels feel
// natural relative to today.
function planStartDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun … 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d;
}

function dateForWeekDay(weekNum, dayIdx) {
  const start = planStartDate();
  start.setDate(start.getDate() + (weekNum - 1) * 7 + dayIdx);
  return start;
}

function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Right-panel: empty state ────────────────────────────────────────────────

function EmptyPlanState() {
  return (
    <div className="card empty-plan">
      <div className="empty-plan-inner">
        <h2 className="empty-headline">Build your training plan</h2>
        <p className="empty-subtext">
          Fill in the event setup, athlete profile, and plan options on the left,
          then click Generate Plan to create your personalised plan.
        </p>
      </div>
    </div>
  );
}

// ── Right-panel: plan summary, phases, volume bars ──────────────────────────

function PlanHero({ plan, selectedWeek, onSelectWeek }) {
  const { meta, phases, weeks } = plan;
  const totalHours = weeks.reduce((s, w) => s + w.totalHours, 0);
  const peak = weeks.reduce((b, w) => (!b || w.totalTSS > b.totalTSS ? w : b), null);
  const focus = EVENT_LABEL[meta.eventType] || meta.eventType;
  const pathwayLabel = meta.pathway === "timeCrunched" ? "Time-crunched" : "Default";
  const maxTSS = Math.max(...weeks.map((w) => w.totalTSS), 1);

  return (
    <div className="plan-hero">
      <div className="plan-meta">
        <div>
          <span className="label">Plan</span>
          <span className="big">{meta.weeksUntilEvent} weeks</span>
        </div>
        <div>
          <span className="label">Focus</span>
          <span className="val">{focus}</span>
        </div>
        <div>
          <span className="label">Total volume</span>
          <span className="val">{Math.round(totalHours)} hrs</span>
        </div>
        <div>
          <span className="label">Peak week</span>
          <span className="val">Wk {peak.number} · {peak.totalHours} hrs</span>
        </div>
        <div className="pathway-badge">{pathwayLabel}</div>
      </div>

      <div className="phase-strip">
        {phases.map((p) => {
          const w = ((p.endWeek - p.startWeek + 1) / meta.weeksUntilEvent) * 100;
          const range = p.startWeek === p.endWeek
            ? `Wk ${p.startWeek}`
            : `Wk ${p.startWeek}-${p.endWeek}`;
          return (
            <div
              key={p.name + p.startWeek}
              className="phase-block"
              style={{
                width: `${w}%`,
                "--phase-color": PHASE_COLOR_VAR[p.name] || "var(--accent)",
              }}
              title={`${p.name} · ${p.tid}`}
            >
              <span className="phase-name">{p.name}</span>
              <span className="phase-range">{range}</span>
            </div>
          );
        })}
      </div>

      <div className="volume-graph-wrap">
        <div className="volume-graph" style={{ "--cols": weeks.length }}>
          {weeks.map((w) => (
            <button
              key={w.number}
              className={
                "vol-bar vol-bar-btn"
                + (w.isRecoveryWeek ? " rest" : "")
                + (w.number === selectedWeek ? " selected" : "")
              }
              style={{ height: `${(w.totalTSS / maxTSS) * 100}%` }}
              onClick={() => onSelectWeek(w.number)}
              aria-pressed={w.number === selectedWeek}
              title={`Wk ${w.number} · ${w.totalTSS} TSS · ${w.totalHours} hrs`}
            >
              <span className="vol-bar-label">Wk {w.number}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Right-panel: week tabs ──────────────────────────────────────────────────

function WeekTabs({ weeks, selected, onSelect }) {
  return (
    <div className="week-tabs">
      {weeks.map((w) => (
        <button
          key={w.number}
          className={"week-tab" + (w.isRecoveryWeek ? " is-recovery" : "")}
          aria-pressed={w.number === selected}
          onClick={() => onSelect(w.number)}
        >
          Wk {w.number}
        </button>
      ))}
    </div>
  );
}

// ── Right-panel: selected week's day cards ──────────────────────────────────

function WeekDays({ week, selectedDay, onSelectDay }) {
  if (!week) return null;
  return (
    <div className="card">
      <div className="card-title">
        <h2>Week {week.number}</h2>
        <span className="sub">
          {week.phase}{week.isRecoveryWeek ? " · Recovery" : ""} · {week.totalHours} hrs · TSS {week.totalTSS}
        </span>
      </div>

      <div className="week-grid">
        {week.days.map((d, i) => {
          const date = dateForWeekDay(week.number, i);
          const dateLabel = fmtDate(date);

          if (!d.workout) {
            return (
              <div key={i} className="day-card day-rest">
                <div className="day-head">
                  <span className="day-dow">{d.day}</span>
                  <span className="day-date">{dateLabel}</span>
                </div>
                <div className="day-type">Rest</div>
              </div>
            );
          }

          const w = d.workout;
          // Aggregate minutes per zone for the strip.
          const zoneMins = {};
          for (const iv of w.intervals) {
            zoneMins[iv.zone] = (zoneMins[iv.zone] || 0) + iv.durationMin;
          }
          const segs = Object.keys(zoneMins);

          return (
            <div
              key={i}
              className={"day-card" + (i === selectedDay ? " selected" : "")}
              onClick={() => onSelectDay(i)}
            >
              <div className="day-head">
                <span className="day-dow">{d.day}</span>
                <span className="day-date">{dateLabel}</span>
              </div>
              <div className="day-type">{w.name}</div>
              <div className="day-metric">{w.distanceKm} km · TSS {w.tss}</div>
              <div className="zone-strip">
                {segs.map((zone) => (
                  <div
                    key={zone}
                    className="zone-seg"
                    style={{
                      flex: zoneMins[zone],
                      "--z-color": zoneColor(zone),
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

// ── Right-panel: workout detail for the selected day ────────────────────────

function WorkoutDetail({ week, dayIndex }) {
  const day = week && dayIndex != null ? week.days[dayIndex] : null;
  const workout = day && day.workout ? day.workout : null;

  // Build the proportional interval visualisation. Recompute when workout changes.
  const viz = useMemo(() => {
    if (!workout) return [];
    const total = workout.intervals.reduce((s, iv) => s + iv.durationMin, 0);
    const N = 80;
    const blocks = [];
    workout.intervals.forEach((iv) => {
      const w = Math.max(1, Math.round((iv.durationMin / total) * N));
      const h = ({ Z1: 25, Z2: 45, Z3: 60, Z4: 75, Z5: 92, Z6: 100 })[iv.zone] || 50;
      for (let k = 0; k < w; k++) blocks.push({ color: zoneColor(iv.zone), h });
    });
    return blocks;
  }, [workout]);

  if (!workout) {
    return (
      <div className="card workout-detail">
        <div className="rest-placeholder">
          {day ? `${day.day} — rest day, no workout scheduled` : "Select a day to see its workout"}
        </div>
      </div>
    );
  }

  // IF derived from TSS: TSS = h * IF^2 * 100 → IF = sqrt(TSS / (h * 100)).
  const hours = workout.durationMin / 60;
  const ifv = hours > 0 ? Math.sqrt(workout.tss / (hours * 100)) : 0;

  return (
    <div className="card workout-detail">
      <div className="workout-header">
        <div className="workout-title">
          <h3>{workout.name}</h3>
          <div className="workout-meta">
            <span>{fmtDuration(workout.durationMin)}</span>
            <span>TSS {workout.tss}</span>
            <span>IF {ifv.toFixed(2)}</span>
            <span>{workout.type}</span>
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
            <span className="interval-zone" style={{ background: zoneColor(iv.zone) }}>
              {iv.zone}
            </span>
            <div>
              <div className="interval-label">{iv.label}</div>
              <div className="interval-detail">{ZONES_LABEL[iv.zone] || ""}</div>
            </div>
            <span className="interval-duration">{fmtDuration(iv.durationMin)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const ZONES_LABEL = {
  Z1: "Active Recovery · <55% FTP",
  Z2: "Endurance · 55-75% FTP",
  Z3: "Tempo · 76-90% FTP",
  Z4: "Threshold · 91-105% FTP",
  Z5: "VO2max · 106-120% FTP",
  Z6: "Anaerobic · >120% FTP",
};

// ── Zones reference card (unchanged) ────────────────────────────────────────

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

function Training(/* goal/setGoal kept by app.jsx but no longer used here */) {
  const initialPlan = loadJSON(PLAN_KEY);

  const [planInputs, setPlanInputs] = useState(() => {
    const saved = loadJSON(INPUTS_KEY);
    return saved ? { ...DEFAULT_INPUTS, ...saved } : DEFAULT_INPUTS;
  });
  const [generatedPlan, setGeneratedPlan] = useState(initialPlan);
  const [generationError, setGenerationError] = useState(null);
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [selectedDay, setSelectedDay] = useState(() =>
    initialPlan ? firstNonRestDay(initialPlan.weeks[0]) : null
  );

  // Persist inputs.
  useEffect(() => {
    try { window.localStorage.setItem(INPUTS_KEY, JSON.stringify(planInputs)); } catch {}
  }, [planInputs]);

  // Persist plan.
  useEffect(() => {
    try {
      if (generatedPlan) {
        window.localStorage.setItem(PLAN_KEY, JSON.stringify(generatedPlan));
      } else {
        window.localStorage.removeItem(PLAN_KEY);
      }
    } catch {}
  }, [generatedPlan]);

  const canGenerate = isValid(planInputs);
  const isStale =
    generatedPlan &&
    JSON.stringify(planInputs) !== JSON.stringify(generatedPlan.inputsSnapshot);

  function handleGenerate() {
    setGenerationError(null);
    if (!canGenerate) return;
    try {
      const plan = window.RP_PlanGenerator.generatePlan(planInputs);
      // Snapshot the inputs so we can detect drift later.
      plan.inputsSnapshot = JSON.parse(JSON.stringify(planInputs));
      setGeneratedPlan(plan);
      setSelectedWeek(1);
      setSelectedDay(firstNonRestDay(plan.weeks[0]));
    } catch (e) {
      setGenerationError(e && e.message ? e.message : "Plan generation failed");
    }
  }

  function handleSelectWeek(n) {
    setSelectedWeek(n);
    if (generatedPlan) {
      setSelectedDay(firstNonRestDay(generatedPlan.weeks[n - 1]));
    }
  }

  const currentWeek = generatedPlan ? generatedPlan.weeks[selectedWeek - 1] : null;

  return (
    <div className="training-layout fade-in">
      <div className="stack">
        <EventSetupCard inputs={planInputs} setInputs={setPlanInputs} />
        <AthleteProfileCard inputs={planInputs} setInputs={setPlanInputs} />
        <PlanOptionsCard inputs={planInputs} setInputs={setPlanInputs} />

        {isStale && (
          <div className="stale-banner">
            Inputs changed. Click Generate Plan to update.
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: "100%" }}
          disabled={!canGenerate}
          onClick={handleGenerate}
        >
          Generate Plan
        </button>

        {generationError && (
          <div className="gen-error">{generationError}</div>
        )}

        <ZonesCard />
      </div>

      <div className="stack" style={{ gap: 20 }}>
        {!generatedPlan ? (
          <EmptyPlanState />
        ) : (
          <>
            <PlanHero
              plan={generatedPlan}
              selectedWeek={selectedWeek}
              onSelectWeek={handleSelectWeek}
            />
            <WeekTabs
              weeks={generatedPlan.weeks}
              selected={selectedWeek}
              onSelect={handleSelectWeek}
            />
            <WeekDays
              week={currentWeek}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
            />
            <WorkoutDetail week={currentWeek} dayIndex={selectedDay} />
          </>
        )}
      </div>
    </div>
  );
}

window.RP_Training = Training;
})();
