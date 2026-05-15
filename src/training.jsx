/* global window, React */
// Training view: plan generator inputs (left) + dynamic plan output (right).
(() => {
const { useState, useMemo, useEffect, useRef } = React;
const Tooltip = window.RP_SHARED.Tooltip;

// ── Plain-language tooltip + glossary copy ──────────────────────────────────

const TIP = {
  totalVolume: "Total training time across all weeks of the plan.",
  totalDistance: "Estimated total kilometres across the entire plan. Calculated from your power-to-weight ratio and body size.",
  peakWeek:    "Your highest-volume week, usually 2-3 weeks before the event. After this, training tapers off so you arrive fresh.",
  climbing:    "How hilly your event is, in metres of elevation gain per kilometre. Higher means hillier.",
  tss:         "Training Stress Score. A measure of how demanding this workout is overall.",
  if:          "Intensity Factor. How hard the average effort is, as a fraction of your threshold. 1.0 means right at threshold.",
};

const PHASE_TIPS = {
  Prep:  "Easing back into structured training. Lower volume, mostly easy riding.",
  Base:  "Building aerobic endurance with steady, mostly easy rides and some moderate efforts.",
  Build: "Adding event-specific intensity. Threshold and tempo work alongside endurance volume.",
  Peak:  "Highest training load. Race-specific intensity to sharpen you for the event.",
  Taper: "Reducing volume while keeping intensity to arrive at the event fresh.",
  Adapt: "Time-crunched plan's foundation phase. Builds capacity quickly with focused sessions.",
};

const ZONE_TIPS = {
  Z1: "Very easy, used between hard efforts and on rest days.",
  Z2: "Easy steady riding. The foundation of cycling fitness.",
  Z3: "Moderate. Useful for sustained efforts and climbing rhythm.",
  Z4: "Hard sustained effort. Builds the power you can hold for an hour.",
  Z5: "Very hard. Builds maximum aerobic capacity.",
  Z6: "All-out, short efforts. Builds sprint power.",
};

const WORKOUT_PLAIN = {
  endurance:  "A steady, comfortable ride at a pace where you can hold a conversation. Builds your aerobic engine.",
  long:       "Your long weekly ride. Mostly easy, conversational pace. Builds endurance and trains your body to use fat as fuel.",
  tempo:      "Sustained moderate effort. Harder than easy, easier than threshold. Trains your muscles to clear fatigue.",
  sweetSpot:  "Just below your threshold. A productive intensity for building fitness without too much fatigue.",
  threshold:  "Hard sustained efforts at your one-hour limit. The classic session for raising your sustainable power.",
  vo2max:     "Short, hard intervals near your maximum. Builds your aerobic ceiling so everything below feels easier.",
  recovery:   "Very easy spinning to promote blood flow and recovery without adding fatigue.",
  openers:    "Short, sharp efforts to wake up the legs without taxing them.",
};

function workoutPlainDesc(workout) {
  let s = WORKOUT_PLAIN[workout.type] || "";
  if (s && workout.hasClimbingFocus) {
    s += " Find a hilly route or simulate by riding in a higher gear at low cadence.";
  }
  return s;
}

const GLOSSARY = [
  {
    title: "Power and Effort",
    terms: [
      ["FTP (Functional Threshold Power)", "The power you can sustain for about an hour. Most workout intensities are calculated as a percentage of this."],
      ["TSS (Training Stress Score)",      "A score that combines workout duration and intensity into one number. Higher means more demanding."],
      ["IF (Intensity Factor)",            "How hard the average effort is, as a fraction of FTP. 1.0 means right at threshold."],
      ["W/kg",                              "Power-to-weight ratio. Cycling performance often comes down to this number, especially when climbing."],
    ],
  },
  {
    title: "Training Zones",
    terms: [
      ["Z1 Recovery",   "Very easy, below 55% FTP. Used between hard efforts."],
      ["Z2 Endurance",  "Easy steady, 55-75% FTP. The foundation of fitness."],
      ["Z3 Tempo",      "Moderate, 76-90% FTP. Useful for sustained efforts."],
      ["Z4 Threshold",  "Hard, 91-105% FTP. Builds your one-hour power."],
      ["Z5 VO2max",     "Very hard, 106-120% FTP. Builds aerobic ceiling."],
      ["Z6 Anaerobic",  "All-out, above 120% FTP. Short, intense efforts."],
    ],
  },
  {
    title: "Workout Types",
    terms: [
      ["Endurance",   "Steady, easy-pace rides that build your aerobic engine."],
      ["Long Ride",   "Your weekly long ride, mostly easy, builds endurance."],
      ["Sweet Spot",  "Just below threshold, productive without too much fatigue."],
      ["Threshold",   "Hard sustained efforts at your one-hour pace."],
      ["VO2max",      "Short, hard intervals near your maximum capacity."],
      ["Tempo",       "Moderate steady efforts between easy and hard."],
    ],
  },
  {
    title: "Plan Structure",
    terms: [
      ["Base",          "Aerobic foundation phase. Mostly easy with some moderate."],
      ["Build",         "Intensity-focused phase. Adds threshold and harder work."],
      ["Peak",          "Highest-load phase before the event. Race-specific work."],
      ["Taper",         "Final phase. Volume drops, intensity stays, you arrive fresh."],
      ["Recovery Week", "Every fourth week, volume drops 30% to allow adaptation."],
    ],
  },
  {
    title: "Other",
    terms: [
      ["RPE (Rate of Perceived Exertion)", "How hard the effort feels on a scale of 1 to 10. Useful when you don't have a power meter."],
      ["Cadence",                          "How fast you spin the pedals, in revolutions per minute. Most efficient riders sit between 80 and 100 rpm."],
    ],
  },
];

const INPUTS_KEY = "ridePrep:planInputs";
const PLAN_KEY   = "ridePrep:generatedPlan";

const DEFAULT_INPUTS = {
  eventSource: null,
  externalEvent: { type: null, distance: null, elevation: null, date: null },
  // tourEvent is used when eventSource === "From Tour Planner". The selected
  // tour is referenced by id; the date is required because saved tours don't
  // carry a fixed event date.
  tourEvent: { tourId: null, date: null },
  athlete: { height: null, weight: null, gender: null, fitnessMode: null, ftp: null, fitnessLevel: null },
  planOptions: { timeCrunched: false, weeklyHours: null },
};

// ── Tour Planner state location (per Step 0 audit) ──────────────────────────
//
// Tours are local React state in src/tour.jsx (a single object, not an array;
// no name; no event date; no per-stage dates). They are not persisted by
// default. The Tour Planner auto-saves into the shared RP_TourStorage
// module, which Training subscribes to via useSavedTours() below.
//
//   { id, name, from, to, totalKm, totalAscent, stageCount, savedAt }
//
// Single source of truth for the saved-tour list. Everything goes through
// window.RP_TourStorage (provided by src/tourStorage.js), which owns the
// versioned localStorage keys (rideprep:savedTours:v1 etc.) and survives
// schema migrations transparently. Falls back to [] when the storage
// module isn't loaded yet (initial render before babel-standalone has
// evaluated the sibling script — rare but possible).
function loadSavedTours() {
  if (window.RP_TourStorage && typeof window.RP_TourStorage.loadSavedTours === "function") {
    return window.RP_TourStorage.loadSavedTours();
  }
  return [];
}

// React hook: subscribes to the storage layer's notifications so the
// Training tour selector updates live when a tour is saved or deleted
// on the Tour Planner tab — no reload required.
//
//   storage event       — fires on cross-tab/window changes.
//   rideprep:tour-saved — fires in the same tab when saveTour / deleteTour
//                         / clearAllTours mutates the index.
function useSavedTours() {
  const [tours, setTours] = useState(loadSavedTours);
  useEffect(() => {
    const refresh = () => setTours(loadSavedTours());
    window.addEventListener("storage", refresh);
    window.addEventListener("rideprep:tour-saved", refresh);
    // Pick up the case where RP_TourStorage finished loading after
    // useState's initial snapshot (initial value was an empty []).
    if (tours.length === 0) refresh();
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("rideprep:tour-saved", refresh);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return tours;
}

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

function EventSetupCard({ inputs, setInputs, savedTours }) {
  const { eventSource, externalEvent, tourEvent } = inputs;
  const setSource = (v) => setInputs({ ...inputs, eventSource: v });
  const setEvent = (patch) =>
    setInputs({ ...inputs, externalEvent: { ...externalEvent, ...patch } });
  const setTour = (patch) =>
    setInputs({ ...inputs, tourEvent: { ...tourEvent, ...patch } });

  const today = new Date().toISOString().split("T")[0];

  const selectedTour = tourEvent && tourEvent.tourId
    ? savedTours.find((t) => t.id === tourEvent.tourId)
    : null;
  const tourDataIncomplete = selectedTour && (!selectedTour.totalKm || !selectedTour.totalAscent);

  function goToTourPlanner() {
    window.dispatchEvent(new CustomEvent("rideprep:switch-tab", { detail: "tour" }));
  }

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

        {eventSource === "From Tour Planner" && savedTours.length === 0 && (
          <div className="goal-row">
            <p className="plan-placeholder">
              No tours planned yet. Create a tour in the Tour Planner to use it here.
            </p>
            <button className="btn btn-ghost" onClick={goToTourPlanner}>
              Open Tour Planner →
            </button>
          </div>
        )}

        {eventSource === "From Tour Planner" && savedTours.length > 0 && (
          <>
            <div className="goal-row">
              <label>Tour</label>
              <select
                className="plan-select"
                value={tourEvent.tourId || ""}
                onChange={(e) => {
                  const newId = e.target.value || null;
                  // Pre-fill the training-target date from the tour's
                  // Event Start Date so the user doesn't have to type
                  // it again. Falls back to the existing value (or
                  // null) when the tour has no date or "" is picked.
                  const picked = newId ? savedTours.find((t) => t.id === newId) : null;
                  const nextDate = picked && picked.startDate
                    ? picked.startDate
                    : tourEvent.date || null;
                  setTour({ tourId: newId, date: nextDate });
                }}
              >
                <option value="">Select a tour…</option>
                {savedTours.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>

            {selectedTour && (
              <div className="tour-summary-card">
                <div className="tour-summary-name">{selectedTour.name}</div>
                <div className="tour-summary-stats">
                  <span>{selectedTour.totalKm} km</span>
                  <span>↑ {selectedTour.totalAscent} m</span>
                  {selectedTour.stageCount > 1 && (
                    <span>{selectedTour.stageCount} stages</span>
                  )}
                </div>
              </div>
            )}

            {tourDataIncomplete && (
              <div className="gen-error">
                Selected tour has incomplete data, please update it in the Tour Planner.
              </div>
            )}

            {selectedTour && !tourDataIncomplete && (
              <div className="goal-row">
                <label>Event Date</label>
                <div className="num-input date-input">
                  <input
                    type="date"
                    min={today}
                    value={tourEvent.date ?? ""}
                    onChange={(e) => setTour({ date: e.target.value || null })}
                  />
                </div>
              </div>
            )}
          </>
        )}

        {eventSource === "From Tour Planner" && savedTours.length > 0 && tourEvent.tourId && !selectedTour && (
          // Selected tour was deleted from storage — surface and offer recovery.
          <div className="gen-error">
            The previously selected tour is no longer available. Pick another tour above.
          </div>
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
            <EstimatedFtpLine athlete={athlete} />
          </div>
        )}
      </div>
    </div>
  );
}

// Live "Estimated FTP" readout shown only in Fitness Level mode. Uses the same
// estimator the plan generator does, so the UI and the plan stay consistent.
function EstimatedFtpLine({ athlete }) {
  if (!athlete.fitnessLevel || !athlete.weight || !athlete.gender) return null;
  const gen = window.RP_PlanGenerator && window.RP_PlanGenerator.estimateFTP;
  if (!gen) return null;
  const ftp = gen({
    fitnessMode: "Fitness Level",
    fitnessLevel: athlete.fitnessLevel,
    weight: athlete.weight,
    gender: athlete.gender,
  });
  if (!ftp || !isFinite(ftp)) return null;
  return (
    <p className="est-ftp">
      <Tooltip content="Calculated from your fitness level, weight, and gender.">
        <span className="tip-trigger">Estimated FTP</span>
      </Tooltip>
      : {ftp} W
    </p>
  );
}

// Collapsed-by-default note explaining how each input shapes the plan.
function InputInfo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="card input-info">
      <button
        type="button"
        className="input-info-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="input-info-icon" aria-hidden="true">i</span>
        <span>How do these inputs affect my plan?</span>
        <span className="input-info-chevron" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="input-info-body">
          <p>
            <strong>Fitness level or FTP</strong> sets your training intensities
            and has the biggest effect on the whole plan.
          </p>
          <p>
            <strong>Weeks until your event</strong> and your <strong>weekly
            hours</strong> decide the plan length, the phase structure, and your
            weekly training load.
          </p>
          <p>
            <strong>Event type and elevation</strong> shape the workout mix.
            Hillier events add climbing focus to your rides.
          </p>
          <p>
            <strong>Height and weight</strong> affect your estimated riding
            speed, which sets the distance of each session. The effect is
            intentionally small, since in reality body size only modestly
            changes cycling speed.
          </p>
          <p>
            <strong>Training stress (TSS)</strong> is measured relative to your
            own threshold, so it stays consistent no matter your fitness level.
            That is by design.
          </p>
        </div>
      )}
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
          <>
            <p className="tc-note">Time-crunched plan active — workouts optimised for ≤8 hrs/wk.</p>
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
          </>
        )}
      </div>
    </div>
  );
}

// ── Validation ──────────────────────────────────────────────────────────────

function isValid(inputs, savedTours = []) {
  const { eventSource, externalEvent, tourEvent, athlete, planOptions } = inputs;
  if (!eventSource) return false;
  if (eventSource === "External Event") {
    if (!externalEvent.type || !externalEvent.distance || !externalEvent.elevation || !externalEvent.date)
      return false;
  }
  if (eventSource === "From Tour Planner") {
    if (!tourEvent || !tourEvent.tourId || !tourEvent.date) return false;
    const tour = savedTours.find((t) => t.id === tourEvent.tourId);
    if (!tour) return false;                         // tour was deleted
    if (!tour.totalKm || !tour.totalAscent) return false; // incomplete tour data
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

// Detect tour drift: same tourId selected, but its km/ascent changed since
// the plan was generated. Inputs-snapshot comparison alone misses this
// because tourId is unchanged.
function isTourStale(plan, planInputs, savedTours) {
  if (!plan || !plan.tourDataSnapshot) return false;
  if (planInputs.eventSource !== "From Tour Planner") return false;
  const tourId = planInputs.tourEvent && planInputs.tourEvent.tourId;
  if (!tourId) return false;
  const tour = savedTours.find((t) => t.id === tourId);
  if (!tour) return false;
  return (
    tour.totalKm !== plan.tourDataSnapshot.totalKm ||
    tour.totalAscent !== plan.tourDataSnapshot.totalAscent
  );
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

// Prefer the highest-TSS week within the Peak phase; fall back to overall max.
function pickPeakWeek(weeks) {
  const inPeakPhase = weeks.filter((w) => w.phase === "Peak");
  const pool = inPeakPhase.length > 0 ? inPeakPhase : weeks;
  return pool.reduce((b, w) => (!b || w.totalTSS > b.totalTSS ? w : b), null);
}

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

// Card-style duration: "55 min", "2h 30m", "3h".
function fmtDurationCard(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
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

// European D.M. format: 10.6. for June 10.
function fmtDate(d) {
  return `${d.getDate()}.${d.getMonth() + 1}.`;
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

function PlanHero({ plan, selectedWeek, onSelectWeek, onOpenGlossary }) {
  const { meta, phases, weeks } = plan;
  const totalHours = weeks.reduce((s, w) => s + w.totalHours, 0);
  const totalKm = weeks.reduce((s, w) => s + w.totalKm, 0);
  const peak = pickPeakWeek(weeks);
  const focus = EVENT_LABEL[meta.eventType] || meta.eventType;
  const maxTSS = Math.max(...weeks.map((w) => w.totalTSS), 1);
  const tssNote = "TSS measures the stress of a week's training. Higher means harder.";

  return (
    <div className="plan-hero">
      <button
        className="glossary-trigger"
        onClick={onOpenGlossary}
        aria-label="Open glossary"
        title="Glossary of cycling training terms"
      >?</button>

      <div className="plan-meta">
        <div className="plan-meta-cell">
          <span className="label">Plan</span>
          <span className="big">{meta.weeksUntilEvent} weeks</span>
        </div>
        <div className="plan-meta-cell">
          <span className="label">Focus</span>
          <span className="val">{focus}</span>
        </div>
        <div className="plan-meta-cell">
          <Tooltip content={TIP.totalVolume} side="bottom"><span className="label tip-trigger">Total volume</span></Tooltip>
          <span className="val">{Math.round(totalHours)} hrs</span>
        </div>
        <div className="plan-meta-cell">
          <Tooltip content={TIP.totalDistance} side="bottom"><span className="label tip-trigger">Total distance</span></Tooltip>
          <span className="val">{Math.round(totalKm).toLocaleString()} km</span>
        </div>
        <div className="plan-meta-cell">
          <Tooltip content={TIP.peakWeek} side="bottom"><span className="label tip-trigger">Peak week</span></Tooltip>
          <span className="val">Wk {peak.number} · {peak.totalHours} hrs</span>
        </div>
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
              title={PHASE_TIPS[p.name]
                ? `${p.name}: ${PHASE_TIPS[p.name]}`
                : `${p.name} · ${p.tid}`}
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
              title={w.isRecoveryWeek
                ? `Wk ${w.number} · Recovery week. Volume drops 30% to allow adaptation. ${tssNote}`
                : `Wk ${w.number} · ${w.totalTSS} TSS · ${w.totalHours} hrs. ${tssNote}`}
            >
              {w.isRecoveryWeek && (
                <span className="vol-bar-rest-icon" aria-hidden="true">↺</span>
              )}
              <span className="vol-bar-label">Wk {w.number}</span>
              {w.isRecoveryWeek && <span className="vol-bar-recovery">Recovery</span>}
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

// ── Day card helpers ────────────────────────────────────────────────────────

const WORKOUT_SUBTITLE = {
  recovery:  "Spin, very light",
  endurance: "Easy, conversational pace",
  long:      "Long, steady endurance",
  tempo:     "Steady, comfortably hard",
  sweetSpot: "Just below threshold",
  threshold: "Hard, sustained effort",
  vo2max:    "Short, very hard intervals",
  openers:   "Easy, conversational pace",
};

// Dot count + label keyed by workout type.
// Long rides are "Moderate" due to total duration stress, not intensity.
const WORKOUT_DIFFICULTY = {
  recovery:  { dots: 1, label: "Recovery" },
  endurance: { dots: 2, label: "Easy" },
  long:      { dots: 3, label: "Moderate" },
  tempo:     { dots: 3, label: "Moderate" },
  sweetSpot: { dots: 3, label: "Moderate" },
  threshold: { dots: 4, label: "Hard" },
  vo2max:    { dots: 5, label: "Very hard" },
  openers:   { dots: 2, label: "Easy" },
};

function DifficultyDots({ type }) {
  const { dots, label } = WORKOUT_DIFFICULTY[type] || { dots: 2, label: "Easy" };
  return (
    <span className="day-difficulty">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={"dot" + (n <= dots ? " dot-on" : "")} aria-hidden="true" />
      ))}
      <span className="difficulty-label">{label}</span>
    </span>
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
          {week.phase}{week.isRecoveryWeek ? " · Recovery" : ""} · {week.totalHours} hours · {Math.round(week.totalKm)} km · TSS {week.totalTSS}
        </span>
      </div>

      <div
        className="week-grid"
        style={{ "--week-cols": week.days.map(d => d.workout ? "1.3fr" : "1fr").join(" ") }}
      >
        {week.days.map((d, i) => {
          const date = dateForWeekDay(week.number, i);
          const dateLabel = fmtDate(date);

          if (!d.workout) {
            return (
              <div
                key={i}
                className={"day-card day-rest" + (i === selectedDay ? " selected" : "")}
                onClick={() => onSelectDay(i)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelectDay(i); }}
              >
                <div className="day-head">
                  <span className="day-dow">{d.day}</span>
                  <span className="day-date">{dateLabel}</span>
                </div>
                <div className="day-rest-body">
                  <div className="day-type">Rest</div>
                  <div className="day-subtitle">Off the bike, recover</div>
                </div>
              </div>
            );
          }

          const w = d.workout;
          return (
            <div
              key={i}
              className={"day-card" + (i === selectedDay ? " selected" : "")}
              onClick={() => onSelectDay(i)}
            >
              {/* 1. Header */}
              <div className="day-head">
                <span className="day-dow">{d.day}</span>
                <span className="day-date">{dateLabel}</span>
              </div>

              {/* 2. Name + subtitle */}
              <div className="day-type">{w.name}</div>
              <div className="day-subtitle">{WORKOUT_SUBTITLE[w.type] || ""}</div>

              {/* 3. Vertical stat rows: TIME / DISTANCE / CLIMBING */}
              <div className="day-stats">
                <div className="day-stat-row">
                  <span className="day-stat-label">TIME</span>
                  <span className="day-stat-val">{fmtDurationCard(w.durationMin)}</span>
                </div>
                <div className="day-stat-row">
                  <span className="day-stat-label">DISTANCE</span>
                  <span className="day-stat-val">{w.distanceKm} km</span>
                </div>
                <div className="day-stat-row">
                  <span className="day-stat-label">CLIMBING</span>
                  <span className="day-stat-val">
                    {w.hasClimbingFocus ? `↑ ${w.targetElevation} m` : "—"}
                  </span>
                </div>
              </div>

              {/* 4. Difficulty dots on its own row */}
              <div className="day-difficulty-row">
                <DifficultyDots type={w.type} />
              </div>

              {/* 5. TSS on its own row */}
              <div className="day-tss-row">TSS {w.tss}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Recovery content sources (code review reference only, not user-facing):
// - St. Pierre, P. et al. (2018). Active vs passive recovery and
//   subsequent exercise performance. J. Strength Cond. Res.
// - Mero, A. et al. (2015). Effects of post-exercise sauna bathing on
//   recovery of athletes. Springer Plus.
// - Laukkanen, J.A. et al. Sauna bathing is associated with reduced
//   cardiovascular mortality. JAMA Intern. Med. (2015).
// - Areta, J.L. et al. (2013). Timing and distribution of protein
//   ingestion during prolonged recovery from resistance exercise.
//   J. Physiol.
function RestDayDetail() {
  return (
    <div className="card">
      <div className="panel-head">
        <h2>Rest day</h2>
        <p className="panel-sub">Why this matters</p>
      </div>
      <div className="panel-body">
        <p className="panel-body-text">
          Rest days are when your body adapts to training. Adaptation happens
          during recovery, not during the workout itself. Skipping recovery does
          not make you faster, it accumulates fatigue and increases injury risk.
        </p>

        <div className="panel-section">
          <h4 className="panel-section-head">What to focus on</h4>
          <ul className="panel-list">
            <li><strong>Sleep 7 to 9 hours.</strong> The single most important recovery factor.</li>
            <li>Keep drinking water and electrolytes through the day.</li>
            <li>Move gently. Light activity beats complete stillness for circulation and muscle repair.</li>
            <li>Stretch or use a foam roller for 10 to 15 minutes if you feel stiff.</li>
          </ul>
        </div>

        <div className="panel-section">
          <h4 className="panel-section-head">Recommended activities</h4>
          <ul className="panel-list">
            <li>A walk of 30 to 60 minutes at a comfortable pace</li>
            <li>Easy swimming or light yoga</li>
            <li>Foam rolling, mobility work, gentle stretching</li>
            <li>A 15 to 20 minute sauna session can support circulation and reduce perceived soreness</li>
          </ul>
        </div>

        <div className="panel-section">
          <h4 className="panel-section-head">Avoid</h4>
          <ul className="panel-list">
            <li>High-intensity workouts of any kind</li>
            <li>Long or hard rides</li>
            <li>Sitting completely still all day, which slows circulation</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── Right-panel: workout detail for the selected day ────────────────────────

function WorkoutDetail({ week, dayIndex, fitnessMode }) {
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
    if (day) return <RestDayDetail />;
    return (
      <div className="card workout-detail">
        <div className="rest-placeholder">Select a day to see its workout</div>
      </div>
    );
  }

  // IF derived from TSS: TSS = h * IF^2 * 100 → IF = sqrt(TSS / (h * 100)).
  const hours = workout.durationMin / 60;
  const ifv = hours > 0 ? Math.sqrt(workout.tss / (hours * 100)) : 0;

  const plain = workoutPlainDesc(workout);

  return (
    <div className="card workout-detail">
      <div className="workout-header">
        <div className="workout-title">
          <h3>{workout.name}</h3>
          <div className="workout-meta">
            <span>{fmtDuration(workout.durationMin)}</span>
            <Tooltip content={TIP.tss}><span className="tip-trigger">TSS {workout.tss}</span></Tooltip>
            <Tooltip content={TIP.if}><span className="tip-trigger">IF {ifv.toFixed(2)}</span></Tooltip>
            <span>{workout.type}</span>
          </div>
        </div>
      </div>

      {plain && (
        <div className="workout-plain">
          <b>What this means</b>
          {plain}
        </div>
      )}

      {workout.hasClimbingFocus && (
        <div className="climbing-note">
          This ride has an elevation target. Seek hilly terrain or a sustained climb —
          or simulate by riding in a higher gear at steady effort.
        </div>
      )}

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
              <div className="interval-detail">{zoneDetail(iv.zone, fitnessMode)}</div>
            </div>
            <span className="interval-duration">{fmtDuration(iv.durationMin)}</span>
          </div>
        ))}
      </div>

      {workoutNutritionNote(workout) && (
        <div className="nutr-note">
          {workoutNutritionNote(workout)}
        </div>
      )}
    </div>
  );
}

const ZONES_LABEL_FTP = {
  Z1: "Active Recovery · <55% FTP",
  Z2: "Endurance · 55-75% FTP",
  Z3: "Tempo · 76-90% FTP",
  Z4: "Threshold · 91-105% FTP",
  Z5: "VO2max · 106-120% FTP",
  Z6: "Anaerobic · >120% FTP",
};

const ZONES_FEEL = {
  Z1: "Active Recovery · Very easy, fully relaxed",
  Z2: "Endurance · Easy, conversational pace",
  Z3: "Tempo · Moderate, breathing harder",
  Z4: "Threshold · Hard, short sentences only",
  Z5: "VO2max · Very hard, heavy breathing",
  Z6: "Anaerobic · All-out, unsustainable",
};

function zoneDetail(zoneId, fitnessMode) {
  return fitnessMode === "Fitness Level"
    ? (ZONES_FEEL[zoneId] || "")
    : (ZONES_LABEL_FTP[zoneId] || "");
}

// ── Nutrition tips data ─────────────────────────────────────────────────────
//
// Recovery nutrition sources (code review reference only, not user-facing):
// - Thomas, D.T. et al. (2016). Position of the Academy of Nutrition and
//   Dietetics: Nutrition and Athletic Performance. J. Acad. Nutr. Diet.
// - Ivy, J.L. & Portman, R. (2004). Nutrient Timing. Basic Health Pub.
// - Areta, J.L. et al. (2013). Timing and distribution of protein ingestion.
//   J. Physiol.
// - Halson, S.L. (2014). Sleep in elite athletes and nutritional interventions
//   to enhance sleep. Sports Med.

const _prepBaseTips = [
  "Carbohydrates are your main fuel on training days. Aim for 5-7 g per kg body weight.",
  "Protein supports adaptation. Aim for 1.4-1.7 g per kg body weight per day, spread across meals.",
  "Healthy fats matter for hormones. Avocado, nuts, oily fish.",
  "For rides over 90 minutes, practice eating on the bike.",
  "Match calorie intake to training load on bigger weeks.",
];

const NUTRITION_TIPS_DATA = {
  Prep:      _prepBaseTips,
  Base:      _prepBaseTips,
  Adapt:     _prepBaseTips,
  Build: [
    "Keep carb intake high. Whole grains, fruit, vegetables, potatoes.",
    "Time carb-rich meals around your harder sessions.",
    "Hold protein at 1.4-1.7 g per kg, 20-30 g per meal.",
    "Start practicing race-day fueling: 60-90 g carbs per hour on long rides.",
    "Don't try new foods on intensity days.",
  ],
  Peak: [
    "Maintain energy stores. This is not the time to restrict calories.",
    "Practice your planned race-day breakfast on weekend long rides.",
    "Hydrate consistently. Add electrolytes on longer or hot rides.",
    "Avoid new supplements or major dietary changes.",
  ],
  Taper: [
    "Slightly reduce calories as training volume drops, but keep carbs high.",
    "Stay well hydrated in the days before the event.",
    "Get plenty of sleep. It now matters more than any food choice.",
    "Stick to familiar foods. No experiments.",
  ],
  "Race Day": [
    "Eat your usual breakfast 3 hours before the start.",
    "Top up with 30-60 g carbs in the hour before.",
    "During the event, aim for 60-90 g carbs per hour and 500-750 ml fluid.",
    "Use familiar gels, bars, or drinks. Nothing new on race day.",
    "Within 30 minutes after: roughly 20 g protein and 60 g carbs.",
  ],
  General: [
    "Hydrate consistently. Light yellow urine is a good daily marker.",
    "Don't undereat. Training raises your calorie needs.",
    "Recovery happens when you rest. Sleep is part of fueling.",
    "Whole foods first. Supplements only fill specific gaps.",
  ],
  "Rest Day": [
    "Protein intake stays consistent. Aim for 1.4 to 1.7 g per kg body weight, spread across meals.",
    "Slightly reduce overall carbohydrate intake compared to training days, but do not cut carbs entirely. Around 3 to 5 g per kg body weight works for most riders.",
    "Hydration stays critical. Drink consistently through the day.",
    "Prioritise whole foods: lean protein, vegetables, fruit, whole grains, healthy fats.",
    "Limit alcohol. It impairs sleep quality and protein synthesis, both of which matter on recovery days.",
    "A small protein-rich snack before bed can support overnight muscle repair (20 to 30 g casein or similar slow protein).",
  ],
};

function workoutNutritionNote(workout) {
  if (!workout) return null;
  const { type, hasClimbingFocus } = workout;
  if (hasClimbingFocus) {
    return "Higher elevation means higher effort. Aim for the upper end of fueling ranges, around 80-90 g carbs per hour.";
  }
  if (type === "long") {
    return "Fuel before, during, and after. Aim for 60-90 g carbs per hour and 500-750 ml fluid per hour. Refuel within 30 minutes of finishing.";
  }
  if (type === "threshold" || type === "sweetSpot" || type === "vo2max" || type === "tempo") {
    return "A carb-rich snack 30-60 minutes before helps. No fueling needed during workouts under 90 minutes.";
  }
  if (type === "endurance") {
    return "Eat normally before. For rides over 90 minutes, take 30-60 g carbs per hour.";
  }
  if (type === "recovery") {
    return "Easy session. No special fueling needed. Listen to hunger.";
  }
  return null;
}

// ── Zones reference card ────────────────────────────────────────────────────

function ZonesCard({ fitnessMode }) {
  const isFeel = fitnessMode === "Fitness Level";
  return (
    <div className="card">
      <div className="card-title">
        <h2>Zones</h2>
        <span className="sub">{isFeel ? "Feel-based" : "Power-based"}</span>
      </div>
      <div className="zones">
        {window.RP_DATA.ZONES.map((z) => (
          <div key={z.id} className="zone-row">
            <span className="zone-swatch" style={{ background: z.color }} />
            <Tooltip content={ZONE_TIPS[z.id]}>
              <span className="tip-trigger">{z.id} · {z.name}</span>
            </Tooltip>
            <span className="zone-range">
              {isFeel ? ZONES_FEEL[z.id].split(" · ")[1] : z.range}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Glossary modal ──────────────────────────────────────────────────────────

function GlossaryModal({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // Lock background scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Portal onto document.body so position:fixed is never trapped by an
  // ancestor transform or animation stacking context (e.g. .fade-in).
  return ReactDOM.createPortal(
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Glossary</h2>
            <p className="modal-sub">Key terms used in your training plan</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close glossary">×</button>
        </div>
        <div className="modal-body">
          {GLOSSARY.map((section) => (
            <section key={section.title} className="gloss-section">
              <h3>{section.title}</h3>
              <dl>
                {section.terms.map(([name, def]) => (
                  <div key={name} className="gloss-row">
                    <dt>{name}</dt>
                    <dd>{def}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Nutrition tips card ──────────────────────────────────────────────────────

function NutritionTips({ plan, currentWeekPhase, isRestDay }) {
  const phaseTabs = plan.phases.map((p) => p.name);
  const allTabs = [...phaseTabs, "Race Day", "General"];
  const defaultTab = phaseTabs.includes(currentWeekPhase) ? currentWeekPhase : phaseTabs[0];
  const [activeTab, setActiveTab] = useState(defaultTab);

  // When a rest day is selected show rest-day nutrition; when switching
  // back to a training day the user-chosen phase tab takes over again.
  const displayTab = isRestDay ? "Rest Day" : activeTab;
  const tips = NUTRITION_TIPS_DATA[displayTab] || NUTRITION_TIPS_DATA["General"];

  return (
    <div className="card">
      <div className="panel-head">
        <h2>Nutrition tips</h2>
        <p className="panel-sub">Guidance, not a meal plan. Adjust to your body and preferences.</p>
      </div>
      {isRestDay ? (
        <p className="nutr-rest-note">Showing rest day nutrition. Select a training day to see phase tips.</p>
      ) : (
        <div className="nutr-tabs">
          {allTabs.map((tab) => (
            <button
              key={tab}
              className={"nutr-tab" + (tab === activeTab ? " active" : "")}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      )}
      <ul className="panel-list">
        {tips.map((tip, i) => (
          <li key={i}>{tip}</li>
        ))}
      </ul>
    </div>
  );
}

// ── Print / PDF export ───────────────────────────────────────────────────────

const PRINT_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatPrintDate(isoStr) {
  if (!isoStr) return "";
  const [y, m, d] = isoStr.split("-").map(Number);
  if (!y || !m || !d) return isoStr;
  return `${d} ${PRINT_MONTHS[m - 1]} ${y}`;
}

function buildPlanFilename(plan) {
  const distance = Math.round(plan.meta.eventDistance);
  const eventType = String(plan.meta.eventType || "plan").replace(/\s+/g, "-");
  const date = plan.meta.eventDate;
  return `RidePrep-Plan-${distance}km-${eventType}-${date}`;
}

function intervalSummaryLine(workout) {
  return workout.intervals
    .map((iv) => `${iv.label} ${iv.zone} ${iv.durationMin}m`)
    .join(" · ");
}

// PrintView renders into document.body via a portal so a single CSS rule —
// `body > *:not(.print-view) { display: none }` in @media print — can hide
// the rest of the app cleanly without caring where Training lives.
function PrintView({ plan, planInputs }) {
  if (!plan) return null;
  const { meta, phases, weeks } = plan;
  const eventLabel = EVENT_LABEL[meta.eventType] || meta.eventType;
  const tierLabel = { rolling: "Rolling", hilly: "Hilly", mountainous: "Mountainous" }[meta.climbingTier];
  const totalHours = weeks.reduce((s, w) => s + w.totalHours, 0);
  const totalKm = weeks.reduce((s, w) => s + w.totalKm, 0);
  const peak = pickPeakWeek(weeks);
  const generatedStr = formatPrintDate(new Date().toISOString().split("T")[0]);
  const phaseLine = phases
    .map((p) => p.startWeek === p.endWeek
      ? `${p.name}: Wk ${p.startWeek}`
      : `${p.name}: Wk ${p.startWeek}-${p.endWeek}`)
    .join(" · ");

  const athlete = (planInputs && planInputs.athlete) || {};

  // Dedupe nutrition sections by tips-array identity so aliased phases
  // (Prep/Base/Adapt all share one tip set) don't print three identical
  // blocks. Order: phases in plan, then Race Day, then General.
  const nutritionSections = [];
  const seenTips = new Set();
  for (const phaseName of [...phases.map((p) => p.name), "Race Day", "General"]) {
    const tips = NUTRITION_TIPS_DATA[phaseName];
    if (!tips || seenTips.has(tips)) continue;
    seenTips.add(tips);
    nutritionSections.push({ phaseName, tips });
  }

  const tree = (
    <div className="print-view">
      <section className="print-cover">
        <div className="print-logo">Ride Prep</div>
        <h1 className="print-title">Ride Prep Training Plan</h1>
        <p className="print-event-line">
          {eventLabel} · {meta.eventDistance} km · {meta.eventElevation} m · {formatPrintDate(meta.eventDate)}
        </p>
        <p className="print-generated">Generated {generatedStr}</p>
      </section>

      <section className="print-section">
        <h2>Athlete Profile</h2>
        <dl className="print-kv">
          {athlete.height != null && (<><dt>Height</dt><dd>{athlete.height} cm</dd></>)}
          {athlete.weight != null && (<><dt>Weight</dt><dd>{athlete.weight} kg</dd></>)}
          {athlete.gender && (<><dt>Gender</dt><dd>{athlete.gender}</dd></>)}
          {athlete.fitnessMode === "FTP" && athlete.ftp && (
            <><dt>FTP (entered)</dt><dd>{athlete.ftp} W</dd></>
          )}
          {athlete.fitnessMode === "Fitness Level" && athlete.fitnessLevel && (
            <><dt>Fitness Level</dt><dd>{athlete.fitnessLevel}</dd></>
          )}
          <dt>Estimated FTP</dt><dd>{meta.estimatedFTP} W</dd>
          <dt>Weekly hours target</dt><dd>{meta.weeklyHoursTarget} hrs</dd>
        </dl>
      </section>

      <section className="print-section">
        <h2>Plan Overview</h2>
        <dl className="print-kv">
          <dt>Total weeks</dt><dd>{meta.weeksUntilEvent}</dd>
          <dt>Total volume</dt><dd>{Math.round(totalHours)} hrs</dd>
          <dt>Total distance</dt><dd>{Math.round(totalKm).toLocaleString()} km</dd>
          <dt>Peak week</dt>
          <dd>Wk {peak.number} · {peak.totalHours} hrs · TSS {peak.totalTSS}</dd>
          {tierLabel && (<><dt>Climbing</dt><dd>{tierLabel} · {meta.climbingDensity} m/km</dd></>)}
          <dt>Phases</dt><dd>{phaseLine}</dd>
          {meta.pathway === "timeCrunched" && (
            <><dt>Note</dt><dd>Time-crunched plan, optimised for ≤8 hours per week.</dd></>
          )}
        </dl>
      </section>

      <section className="print-schedule">
        <h2>Weekly Schedule</h2>
        {weeks.map((w) => (
          <div key={w.number} className="print-week">
            <h3>
              Week {w.number} · {w.phase}
              {w.isRecoveryWeek && " · Recovery"}
              {" · "}{w.totalHours} hrs · {Math.round(w.totalKm)} km · TSS {w.totalTSS}
            </h3>
            <table className="print-day-table">
              <tbody>
                {w.days.map((d, i) => {
                  const date = dateForWeekDay(w.number, i);
                  const dateLabel = fmtDate(date);
                  if (!d.workout) {
                    return (
                      <tr key={i}>
                        <td className="print-day-name">{d.day} {dateLabel}</td>
                        <td className="print-day-rest" colSpan={2}>Rest</td>
                      </tr>
                    );
                  }
                  const wo = d.workout;
                  return (
                    <tr key={i}>
                      <td className="print-day-name">{d.day} {dateLabel}</td>
                      <td className="print-day-workout"><strong>{wo.name}</strong></td>
                      <td className="print-day-metrics">
                        {wo.durationMin} min · {wo.distanceKm} km · TSS {wo.tss}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {w.days.some((d) => d.workout) && (
              <ul className="print-intervals">
                {w.days.filter((d) => d.workout).map((d, i) => (
                  <li key={i}>
                    <strong>{d.workout.name}:</strong>{" "}
                    {intervalSummaryLine(d.workout)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>

      <section className="print-appendix">
        <h2>Nutrition Tips</h2>
        <p className="print-sub">Guidance, not a meal plan. Adjust to your body and preferences.</p>
        {nutritionSections.map(({ phaseName, tips }) => (
          <div key={phaseName} className="print-nutr">
            <h3>{phaseName}</h3>
            <ul>{tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </div>
        ))}
      </section>

      <section className="print-appendix">
        <h2>Glossary</h2>
        {GLOSSARY.map((section) => (
          <div key={section.title} className="print-gloss">
            <h3>{section.title}</h3>
            <dl>
              {section.terms.map(([name, def]) => (
                <React.Fragment key={name}>
                  <dt>{name}</dt>
                  <dd>{def}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        ))}
      </section>
    </div>
  );

  return ReactDOM.createPortal(tree, document.body);
}

// ── Root view ────────────────────────────────────────────────────────────────

function Training(/* goal/setGoal kept by app.jsx but no longer used here */) {
  const initialPlan = loadJSON(PLAN_KEY);

  const [planInputs, setPlanInputs] = useState(() => {
    const saved = loadJSON(INPUTS_KEY);
    return saved ? { ...DEFAULT_INPUTS, ...saved } : DEFAULT_INPUTS;
  });
  // Live-subscribed to RP_TourStorage so tours saved or deleted from the
  // Tour Planner tab appear here immediately — no reload needed.
  const savedTours = useSavedTours();
  const [generatedPlan, setGeneratedPlan] = useState(initialPlan);
  const [generationError, setGenerationError] = useState(null);
  // null | "created" | "updated" — drives the transient post-generate banner.
  const [confirmationState, setConfirmationState] = useState(null);
  const [showGlossary, setShowGlossary] = useState(false);
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [selectedDay, setSelectedDay] = useState(() =>
    initialPlan ? firstNonRestDay(initialPlan.weeks[0]) : null
  );

  // Persist inputs.
  useEffect(() => {
    try { window.localStorage.setItem(INPUTS_KEY, JSON.stringify(planInputs)); } catch {}
    window.dispatchEvent(new CustomEvent("rideprep:inputs-changed", { detail: planInputs }));
  }, [planInputs]);

  // Auto-dismiss the confirmation banner. A ref-managed timer ensures that
  // clicking Generate again before timeout resets the countdown even when
  // the new state value equals the previous one (React skips same-value
  // updates, so a useEffect on confirmationState alone wouldn't re-fire).
  const confirmTimerRef = useRef(null);
  function showConfirmation(kind) {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmationState(kind);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmationState(null);
      confirmTimerRef.current = null;
    }, 3500);
  }
  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }, []);

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

  const canGenerate = isValid(planInputs, savedTours);
  const isStale =
    generatedPlan && (
      JSON.stringify(planInputs) !== JSON.stringify(generatedPlan.inputsSnapshot)
      || isTourStale(generatedPlan, planInputs, savedTours)
    );

  function handleGenerate() {
    setGenerationError(null);
    if (!canGenerate) return;

    // Build the inputs the generator actually consumes. Tour-sourced events
    // are translated into a synthetic "External Event" with type=Long Tour
    // and tour totals, so the generator stays unaware of tours.
    let generatorInputs = planInputs;
    let tourSnapshot = null;
    if (planInputs.eventSource === "From Tour Planner") {
      const tour = savedTours.find((t) => t.id === planInputs.tourEvent.tourId);
      if (!tour) {
        setGenerationError("Selected tour is no longer available. Pick another tour.");
        return;
      }
      tourSnapshot = { totalKm: tour.totalKm, totalAscent: tour.totalAscent };
      generatorInputs = {
        ...planInputs,
        eventSource: "External Event",
        externalEvent: {
          type: "Long Tour",
          distance: tour.totalKm,
          elevation: tour.totalAscent,
          date: planInputs.tourEvent.date,
        },
      };
    }

    try {
      const plan = window.RP_PlanGenerator.generatePlan(generatorInputs);
      // Snapshot the *original* user inputs so the stale-banner reflects
      // what the user controls in the UI, not the synthesized form.
      plan.inputsSnapshot = JSON.parse(JSON.stringify(planInputs));
      if (tourSnapshot) plan.tourDataSnapshot = tourSnapshot;
      const isFirstPlan = !generatedPlan;
      setGeneratedPlan(plan);
      setSelectedWeek(1);
      setSelectedDay(firstNonRestDay(plan.weeks[0]));
      showConfirmation(isFirstPlan ? "created" : "updated");
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

  function handleDownloadPdf() {
    if (!generatedPlan) return;
    const original = document.title;
    document.title = buildPlanFilename(generatedPlan);
    const restore = () => {
      document.title = original;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }

  function handleDownloadIcs() {
    if (!generatedPlan || !window.RP_IcsExport) return;
    const filename = `${buildPlanFilename(generatedPlan)}.ics`;
    window.RP_IcsExport.downloadIcs(generatedPlan, planStartDate(), filename);
  }

  const currentWeek = generatedPlan ? generatedPlan.weeks[selectedWeek - 1] : null;

  return (
    <div className="training-layout fade-in">
      <div className="stack">
        <EventSetupCard inputs={planInputs} setInputs={setPlanInputs} savedTours={savedTours} />
        <AthleteProfileCard inputs={planInputs} setInputs={setPlanInputs} />
        <InputInfo />
        <PlanOptionsCard inputs={planInputs} setInputs={setPlanInputs} />

        {confirmationState && (
          <div className="confirm-banner">
            <span className="confirm-check" aria-hidden="true">✓</span>
            <span>
              {confirmationState === "created"
                ? "Plan created"
                : "Plan updated to match your inputs"}
            </span>
          </div>
        )}

        {isStale && !confirmationState && (
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

        <ZonesCard fitnessMode={planInputs.athlete.fitnessMode} />
      </div>

      {showGlossary && <GlossaryModal onClose={() => setShowGlossary(false)} />}

      <div className="stack" style={{ gap: 20 }}>
        {!generatedPlan ? (
          <EmptyPlanState />
        ) : (
          <>
            <PlanHero
              plan={generatedPlan}
              selectedWeek={selectedWeek}
              onSelectWeek={handleSelectWeek}
              onOpenGlossary={() => setShowGlossary(true)}
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
            <WorkoutDetail
              week={currentWeek}
              dayIndex={selectedDay}
              fitnessMode={planInputs.athlete.fitnessMode}
            />
            <NutritionTips
              plan={generatedPlan}
              currentWeekPhase={currentWeek && currentWeek.phase}
              isRestDay={currentWeek && selectedDay != null && !currentWeek.days[selectedDay]?.workout}
            />
            <div className="plan-actions">
              <button
                className="btn btn-ghost download-pdf-btn"
                onClick={handleDownloadPdf}
              >
                <span aria-hidden="true">⬇</span> Download as PDF
              </button>
              <button
                className="btn btn-ghost download-ics-btn"
                onClick={handleDownloadIcs}
                title="Import into Apple Calendar, Google Calendar, Outlook, etc."
              >
                <span aria-hidden="true">⬇</span> Add to Calendar (.ics)
              </button>
            </div>
            <PrintView plan={generatedPlan} planInputs={planInputs} />
          </>
        )}
      </div>
    </div>
  );
}

window.RP_Training = Training;
})();
