/* global window */
// Pure plan generation logic. No DOM, no React.
//
// The project loads source files via plain <script> tags (see index.html), so
// this module exposes its API on window.RP_PlanGenerator instead of using ESM
// `export`. Two functions are published:
//
//   window.RP_PlanGenerator.generatePlan(planInputs) -> plan
//   window.RP_PlanGenerator.describePlan(plan)       -> string
//
// The shapes are documented at the bottom of this file.

(() => {

// ============================================================================
// Lookup tables and constants
// ============================================================================

// Default pathway (>= 8 hrs/wk): [Prep, Base, Build, Peak, Taper]
const PHASE_TABLE_DEFAULT = {
  4:  [0, 0, 2, 1, 1],
  6:  [0, 3, 2, 0, 1],
  8:  [1, 3, 2, 1, 1],
  12: [2, 4, 3, 2, 1],
  16: [2, 6, 4, 2, 2],
  20: [3, 8, 5, 2, 2],
};
const DEFAULT_PHASE_NAMES = ["Prep", "Base", "Build", "Peak", "Taper"];

// Time-crunched pathway (3-7 hrs/wk): [Adapt, Build, Peak, Taper]
const PHASE_TABLE_TC = {
  4:  [0, 3, 0, 1],
  6:  [0, 4, 1, 1],
  8:  [0, 6, 1, 1],
  12: [1, 8, 2, 1],
  16: [1, 11, 3, 1],
  20: [2, 14, 3, 1],
};
const TC_PHASE_NAMES = ["Adapt", "Build", "Peak", "Taper"];

// Phase → Training Intensity Distribution label.
const PHASE_TO_TID = {
  Prep:  "pyramidal",
  Base:  "pyramidal",
  Build: "hybrid",
  Peak:  "polarized",
  Taper: "polarized",
  Adapt: "hybrid",
};

// FTP estimation (W/kg) when fitnessMode === "Fitness Level".
const FTP_COEFFICIENTS = {
  "Beginner":      1.5,
  "Recreational":  2.5,
  "Trained":       3.3,
  "Well-Trained":  4.0,
  "Competitive":   5.0,
};

// Coggan zones — IF is the approximate intensity factor used for TSS calc
// (TSS = duration_h * IF^2 * 100). Zone bounds are documented in the spec.
const ZONES = {
  Z1: { name: "Active Recovery", if: 0.50 },
  Z2: { name: "Endurance",       if: 0.65 },
  Z3: { name: "Tempo",           if: 0.83 },
  Z4: { name: "Threshold",       if: 0.97 },
  Z5: { name: "VO2max",          if: 1.13 },
  Z6: { name: "Anaerobic",       if: 1.35 },
};

// Average rolling speed per zone (km/h) used to derive distance from time.
const ZONE_KMH = { Z1: 22, Z2: 26, Z3: 29, Z4: 31, Z5: 31, Z6: 30 };

// ============================================================================
// Validation
// ============================================================================

function validateInputs(p) {
  if (!p || typeof p !== "object") throw new Error("planInputs is required");
  if (!p.eventSource) throw new Error("eventSource is required");

  // Tour Planner integration is deferred — only External Event is supported.
  if (p.eventSource !== "External Event") {
    throw new Error("Plan generation currently requires eventSource = 'External Event'");
  }

  const e = p.externalEvent || {};
  if (!e.type)              throw new Error("externalEvent.type is required");
  if (!e.distance)          throw new Error("externalEvent.distance is required");
  if (e.elevation == null)  throw new Error("externalEvent.elevation is required");
  if (!e.date)              throw new Error("externalEvent.date is required");

  const a = p.athlete || {};
  if (!a.height || !a.weight) throw new Error("athlete.height and athlete.weight are required");
  if (!a.gender)              throw new Error("athlete.gender is required");
  if (!a.fitnessMode)         throw new Error("athlete.fitnessMode is required");
  if (a.fitnessMode === "FTP" && !a.ftp)
    throw new Error("athlete.ftp is required when fitnessMode is 'FTP'");
  if (a.fitnessMode === "Fitness Level" && !a.fitnessLevel)
    throw new Error("athlete.fitnessLevel is required when fitnessMode is 'Fitness Level'");

  const o = p.planOptions || {};
  if (o.timeCrunched) {
    const h = o.weeklyHours;
    if (!h || h < 3 || h > 7)
      throw new Error("planOptions.weeklyHours must be between 3 and 7 when timeCrunched is true");
  }
}

// ============================================================================
// Phase distribution
// ============================================================================

// Pick the table row by rounding `weeks` DOWN to the nearest entry.
// `extra` carries the remainder (added to Base / Build by the caller).
function pickTableEntry(weeks, table) {
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  if (weeks <= keys[0]) return { counts: table[keys[0]].slice(), extra: 0 };
  // Cap at largest tabulated entry; any beyond becomes `extra`.
  let chosen = keys[0];
  for (const k of keys) if (k <= weeks) chosen = k;
  return { counts: table[chosen].slice(), extra: weeks - chosen };
}

function buildPhases(weeks, pathway) {
  if (pathway === "timeCrunched") {
    const { counts, extra } = pickTableEntry(weeks, PHASE_TABLE_TC);
    // No "Base" in TC; Build is the closest analogue, so extras go there.
    counts[1] += extra;
    return phasesFromCounts(counts, TC_PHASE_NAMES);
  }
  const { counts, extra } = pickTableEntry(weeks, PHASE_TABLE_DEFAULT);
  counts[1] += extra; // add to Base (index 1)
  return phasesFromCounts(counts, DEFAULT_PHASE_NAMES);
}

function phasesFromCounts(counts, names) {
  const out = [];
  let week = 1;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] === 0) continue;
    const start = week;
    const end = week + counts[i] - 1;
    out.push({
      name: names[i],
      startWeek: start,
      endWeek: end,
      tid: PHASE_TO_TID[names[i]],
    });
    week = end + 1;
  }
  return out;
}

function phaseForWeek(phases, weekNum) {
  return phases.find(p => weekNum >= p.startWeek && weekNum <= p.endWeek);
}

// ============================================================================
// Weekly volume curve
// ============================================================================

// Peak weekly hours derived from the user's "weeklyHoursTarget" and event type.
function peakWeeklyHoursFromTarget(target, eventType) {
  switch (eventType) {
    case "Long Tour": return target * 1.10;
    case "Sportive":  return target * 1.00;
    case "Race":
    default:          return target * 0.90;
  }
}

function computeWeeklyHours(weekNum, peakHours, pathway, phase, phases) {
  // Volume ramps linearly from `startFrac * peak` in week 1 up to `peak` at
  // the end of the Peak phase (or end of Build if there is no Peak). Taper
  // weeks drop to ~55% of peak. Every 4th week is a recovery week.
  const peakPhase  = phases.find(p => p.name === "Peak");
  const taperPhase = phases.find(p => p.name === "Taper");
  const rampEnd = peakPhase
    ? peakPhase.endWeek
    : (taperPhase ? taperPhase.startWeek - 1 : phases[phases.length - 1].endWeek);

  const startFrac = pathway === "timeCrunched" ? 0.80 : 0.60;
  const phaseName = phase.name;

  let hours;
  if (phaseName === "Taper") {
    hours = peakHours * 0.55;
  } else {
    const span = Math.max(1, rampEnd - 1);
    const t = Math.min(1, (weekNum - 1) / span);
    hours = peakHours * (startFrac + (1 - startFrac) * t);
  }

  // Recovery: every 4th week, but not in Peak/Taper, and never the week
  // immediately before Peak begins (we want to enter Peak fresh but loaded).
  let isRecovery = (weekNum % 4 === 0) && phaseName !== "Peak" && phaseName !== "Taper";
  if (isRecovery && peakPhase && weekNum + 1 === peakPhase.startWeek) isRecovery = false;
  if (isRecovery) hours *= 0.70;

  return { hours: Math.round(hours * 10) / 10, isRecovery };
}

// ============================================================================
// Workout builders
// ============================================================================
//
// Each builder returns a fully-formed workout object: name, type,
// primaryZone, description, durationMin, distanceKm, tss, intervals[].

function makeWorkout(spec) {
  const intervals = spec.intervals.map(iv => ({ ...iv }));
  const durationMin = intervals.reduce((s, iv) => s + iv.durationMin, 0);
  return {
    name: spec.name,
    type: spec.type,
    primaryZone: spec.primaryZone,
    description: spec.description,
    durationMin,
    distanceKm: distanceForIntervals(intervals),
    tss: tssForIntervals(intervals),
    intervals,
  };
}

function tssForIntervals(intervals) {
  let tss = 0;
  for (const iv of intervals) {
    const f = ZONES[iv.zone].if;
    tss += (iv.durationMin / 60) * f * f * 100;
  }
  return Math.round(tss);
}

function distanceForIntervals(intervals) {
  let km = 0;
  for (const iv of intervals) km += (iv.durationMin / 60) * ZONE_KMH[iv.zone];
  return Math.round(km);
}

// ── Concrete workouts ───────────────────────────────────────────────────────

function endurance(min) {
  const main = Math.max(20, min - 20);
  return makeWorkout({
    name: "Endurance",
    type: "endurance",
    primaryZone: "Z2",
    description: "Steady Z2, smooth cadence 85-95",
    intervals: [
      { zone: "Z1", durationMin: 10, label: "Warm-up" },
      { zone: "Z2", durationMin: main, label: "Main set" },
      { zone: "Z1", durationMin: 10, label: "Cool-down" },
    ],
  });
}

function recoverySpin(min = 40) {
  return makeWorkout({
    name: "Recovery Spin",
    type: "recovery",
    primaryZone: "Z1",
    description: "Easy spin, high cadence, very low load",
    intervals: [{ zone: "Z1", durationMin: min, label: "Easy spin" }],
  });
}

function tempoZ3(min = 60) {
  const tail = Math.max(5, min - 55);
  return makeWorkout({
    name: "Tempo",
    type: "tempo",
    primaryZone: "Z3",
    description: "2x20 min Z3 @ 80-88% FTP",
    intervals: [
      { zone: "Z1", durationMin: 10, label: "Warm-up" },
      { zone: "Z3", durationMin: 20, label: "Tempo 1" },
      { zone: "Z2", durationMin: 5,  label: "Recovery" },
      { zone: "Z3", durationMin: 20, label: "Tempo 2" },
      { zone: "Z1", durationMin: tail, label: "Cool-down" },
    ],
  });
}

function sweetSpot(min = 70, climbing = false) {
  // Two sustained sets at 88-92% FTP. Length scales with target duration.
  const setMin = min >= 80 ? 20 : 15;
  return makeWorkout({
    name: climbing ? "Sweet Spot Climbing" : "Sweet Spot",
    type: "sweetSpot",
    primaryZone: "Z3",
    description: `2x${setMin} min @ 88-92% FTP${climbing ? " on a sustained climb" : ""}`,
    intervals: [
      { zone: "Z1", durationMin: 10, label: "Warm-up" },
      { zone: "Z3", durationMin: setMin, label: climbing ? "Climb 1" : "SS 1" },
      { zone: "Z2", durationMin: 5,      label: "Recovery" },
      { zone: "Z3", durationMin: setMin, label: climbing ? "Climb 2" : "SS 2" },
      { zone: "Z1", durationMin: 10, label: "Cool-down" },
    ],
  });
}

function threshold(min = 65, climbing = false) {
  // Default 3x10 min Threshold. Climbing variant is 4x6 min on a climb.
  const sets   = climbing ? 4 : 3;
  const setMin = climbing ? 6 : 10;
  const recMin = climbing ? 4 : 5;
  const intervals = [{ zone: "Z1", durationMin: 10, label: "Warm-up" }];
  for (let i = 0; i < sets; i++) {
    intervals.push({ zone: "Z4", durationMin: setMin,
      label: (climbing ? "Climb " : "Threshold ") + (i + 1) });
    if (i < sets - 1) intervals.push({ zone: "Z2", durationMin: recMin, label: "Recovery" });
  }
  intervals.push({ zone: "Z1", durationMin: 10, label: "Cool-down" });
  return makeWorkout({
    name: climbing ? "Threshold Climbing" : "Threshold",
    type: "threshold",
    primaryZone: "Z4",
    description: `${sets}x${setMin} min @ 95-100% FTP${climbing ? " on a sustained climb" : ""}`,
    intervals,
  });
}

function vo2max(min = 60, micro = false) {
  // 5x3 min @ 110-115% FTP, equal recovery. Micro variant: 3x2 min for taper.
  const sets   = micro ? 3 : 5;
  const setMin = micro ? 2 : 3;
  const recMin = setMin;
  const intervals = [{ zone: "Z1", durationMin: 10, label: "Warm-up" }];
  for (let i = 0; i < sets; i++) {
    intervals.push({ zone: "Z5", durationMin: setMin, label: "VO2 " + (i + 1) });
    if (i < sets - 1) intervals.push({ zone: "Z1", durationMin: recMin, label: "Recovery" });
  }
  intervals.push({ zone: "Z1", durationMin: 10, label: "Cool-down" });
  return makeWorkout({
    name: micro ? "VO2max Micro" : "VO2max Intervals",
    type: "vo2max",
    primaryZone: "Z5",
    description: `${sets}x${setMin} min @ 110-115% FTP, equal recovery`,
    intervals,
  });
}

function longRide(min, phaseName, eventType) {
  // Mostly Z2; Build/Peak insert a Z3 block (or race-pace surges in Peak).
  const wuCd = 10;
  const main = Math.max(30, min - 2 * wuCd);
  const intervals = [{ zone: "Z1", durationMin: wuCd, label: "Warm-up" }];

  if ((phaseName === "Build" || phaseName === "Peak") && main > 60) {
    const z3 = phaseName === "Peak" ? 15 : 20;
    const z2a = Math.round((main - z3) / 2);
    const z2b = main - z3 - z2a;
    intervals.push({ zone: "Z2", durationMin: z2a, label: "Endurance" });
    intervals.push({ zone: "Z3", durationMin: z3,
      label: phaseName === "Peak" ? "Race-pace surge" : "Tempo block" });
    intervals.push({ zone: "Z2", durationMin: z2b, label: "Endurance" });
  } else {
    intervals.push({ zone: "Z2", durationMin: main, label: "Endurance" });
  }
  intervals.push({ zone: "Z1", durationMin: wuCd, label: "Cool-down" });

  const desc = (phaseName === "Build" || phaseName === "Peak") && main > 60
    ? "Long ride: mostly Z2 with Z3 inserts"
    : eventType === "Long Tour" ? "Long ride: maximize Z2 volume" : "Long ride: steady Z2";

  return makeWorkout({
    name: "Long Ride",
    type: "long",
    primaryZone: "Z2",
    description: desc,
    intervals,
  });
}

function shortOpener() {
  return makeWorkout({
    name: "Openers",
    type: "openers",
    primaryZone: "Z2",
    description: "45 min Z2 + 3x1 min @ 110% FTP",
    intervals: [
      { zone: "Z1", durationMin: 10, label: "Warm-up" },
      { zone: "Z2", durationMin: 20, label: "Z2" },
      { zone: "Z5", durationMin: 1,  label: "Opener 1" },
      { zone: "Z1", durationMin: 2,  label: "Recovery" },
      { zone: "Z5", durationMin: 1,  label: "Opener 2" },
      { zone: "Z1", durationMin: 2,  label: "Recovery" },
      { zone: "Z5", durationMin: 1,  label: "Opener 3" },
      { zone: "Z1", durationMin: 8,  label: "Cool-down" },
    ],
  });
}

// ============================================================================
// Per-week composer
// ============================================================================

// Returns an array of intensity workout BUILDERS appropriate for the phase.
// The builders are zero-arg; the composer just calls them in order, cycling
// the array if it needs more intensity slots than the array has entries.
function intensityBuildersForPhase(phase, climbing, pathway, eventType) {
  const p = phase.name;

  if (pathway === "timeCrunched") {
    if (p === "Adapt") return [() => sweetSpot(60, climbing), () => sweetSpot(60, false)];
    if (p === "Build") return [() => threshold(60, climbing), () => sweetSpot(60, climbing)];
    if (p === "Peak")  return [() => vo2max(60),              () => threshold(60, climbing)];
    if (p === "Taper") return [() => vo2max(45, true),        () => shortOpener()];
    return [() => sweetSpot(60, false)];
  }

  // Default pathway. Race events get a slight intensity bias in Build/Peak.
  if (p === "Prep" || p === "Base") {
    return [() => sweetSpot(70, climbing), () => tempoZ3(60)];
  }
  if (p === "Build") {
    const a = [() => threshold(70, climbing), () => sweetSpot(80, climbing)];
    if (eventType === "Race") a.push(() => vo2max(60));
    return a;
  }
  if (p === "Peak") {
    return [() => vo2max(60), () => threshold(65, climbing)];
  }
  if (p === "Taper") {
    return [() => vo2max(45, true), () => shortOpener()];
  }
  return [() => endurance(60)];
}

function composeWeek(ctx) {
  const { weekNum, hours, isRecovery, phase, eventType, climbing, pathway } = ctx;

  // Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6.
  const days = [
    { day: "Mon", workout: null },
    { day: "Tue", workout: null },
    { day: "Wed", workout: null },
    { day: "Thu", workout: null },
    { day: "Fri", workout: null },
    { day: "Sat", workout: null },
    { day: "Sun", workout: null },
  ];

  // Number of active days scales with weekly volume.
  let activeDays;
  if (hours < 4)      activeDays = 3;
  else if (hours < 6) activeDays = 4;
  else if (hours < 9) activeDays = 5;
  else                activeDays = 6;

  const totalMin = Math.round(hours * 60);

  // Long-ride share: tour > sportive > race.
  const longShare = eventType === "Long Tour" ? 0.40
                  : eventType === "Sportive"  ? 0.35
                  : 0.30;

  // Long-ride duration cap by phase / pathway.
  let longCap;
  if (pathway === "timeCrunched")     longCap = 120;
  else if (phase.name === "Taper")    longCap = 90;
  else if (phase.name === "Peak")     longCap = 240;
  else if (eventType === "Long Tour") longCap = phase.name === "Build" ? 360 : 360;
  else if (eventType === "Sportive")  longCap = 300;
  else                                longCap = 240; // Race

  let longMin = Math.min(longCap, Math.round((totalMin * longShare) / 5) * 5);
  if (isRecovery) longMin = Math.round((longMin * 0.7) / 5) * 5;
  longMin = Math.max(60, longMin);

  days[5].workout = longRide(longMin, phase.name, eventType);
  let remainingMin = totalMin - longMin;

  // Intensity slots — Tue, then Thu, then Wed for high-volume Build/Peak weeks.
  const builders = intensityBuildersForPhase(phase, climbing, pathway, eventType);
  const slots = [];
  if (activeDays >= 4) slots.push(1);                       // Tue
  if (activeDays >= 5 && !isRecovery) slots.push(3);        // Thu
  if (!isRecovery && activeDays >= 6 && pathway !== "timeCrunched"
      && (phase.name === "Build" || phase.name === "Peak")) {
    slots.push(2);                                          // Wed
  }

  for (let i = 0; i < slots.length; i++) {
    const idx = slots[i];
    let w = builders[i % builders.length]();
    // During recovery weeks, swap intensity for endurance.
    if (isRecovery) w = endurance(60);
    days[idx].workout = w;
    remainingMin -= w.durationMin;
  }

  // Endurance / recovery fillers on remaining active days.
  const fillIdx = [];
  if (activeDays >= 5 && !days[2].workout) fillIdx.push(2); // Wed
  if (activeDays >= 6 && !days[4].workout) fillIdx.push(4); // Fri
  if (activeDays >= 4 && !days[6].workout) fillIdx.push(6); // Sun

  if (fillIdx.length > 0 && remainingMin > 0) {
    const each = Math.max(40, Math.floor((remainingMin / fillIdx.length) / 5) * 5);
    for (const idx of fillIdx) {
      const dayName = days[idx].day;
      if (dayName === "Fri") {
        days[idx].workout = recoverySpin(Math.min(45, each));
      } else {
        days[idx].workout = endurance(each);
      }
    }
  }

  // Aggregate week totals from actual workouts (not projected hours).
  const totalsMin = days.reduce((s, d) => s + (d.workout ? d.workout.durationMin : 0), 0);
  const totalsTSS = days.reduce((s, d) => s + (d.workout ? d.workout.tss        : 0), 0);
  const totalsKm  = days.reduce((s, d) => s + (d.workout ? d.workout.distanceKm : 0), 0);

  return {
    number: weekNum,
    phase: phase.name,
    isRecoveryWeek: isRecovery,
    totalHours: Math.round((totalsMin / 60) * 10) / 10,
    totalTSS: totalsTSS,
    totalKm: totalsKm,
    days,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function weeksUntilDate(eventDateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const event = new Date(eventDateStr + "T00:00:00");
  if (isNaN(event.getTime())) throw new Error("Invalid event date");
  const ms = event - today;
  if (ms <= 0) throw new Error("Event date must be in the future");
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.round(days / 7));
}

function estimateFTP(athlete) {
  if (athlete.fitnessMode === "FTP") return Math.round(athlete.ftp);
  const coef = FTP_COEFFICIENTS[athlete.fitnessLevel];
  return Math.round(athlete.weight * coef);
}

function eventTypeKey(t) {
  // "Long Tour" -> "longtour", "Race" -> "race", "Sportive" -> "sportive".
  return String(t).toLowerCase().replace(/\s+/g, "");
}

// ============================================================================
// Public API
// ============================================================================

function generatePlan(planInputs) {
  validateInputs(planInputs);

  const event   = planInputs.externalEvent;
  const athlete = planInputs.athlete;
  const opts    = planInputs.planOptions || {};

  const weeksUntilEvent = weeksUntilDate(event.date);
  const pathway = opts.timeCrunched ? "timeCrunched" : "default";
  const phases  = buildPhases(weeksUntilEvent, pathway);
  const ftp     = estimateFTP(athlete);

  // Time-crunched: peak == user-supplied hours directly. Default: 8 h target,
  // modulated by event type.
  const weeklyHoursTarget = pathway === "timeCrunched" ? opts.weeklyHours : 8;
  const peakHours = pathway === "timeCrunched"
    ? weeklyHoursTarget
    : peakWeeklyHoursFromTarget(weeklyHoursTarget, event.type);

  // Climbing event flag: > 1500 m per 100 km swaps some interval workouts
  // for climbing variants.
  const climbing = (event.elevation / event.distance) > 15;

  const weeks = [];
  for (let w = 1; w <= weeksUntilEvent; w++) {
    const phase = phaseForWeek(phases, w);
    if (!phase) continue;
    const { hours, isRecovery } = computeWeeklyHours(w, peakHours, pathway, phase, phases);
    weeks.push(composeWeek({
      weekNum: w,
      hours,
      isRecovery,
      phase,
      eventType: event.type,
      climbing,
      pathway,
      ftp,
    }));
  }

  return {
    meta: {
      weeksUntilEvent,
      eventDate: event.date,
      eventType: eventTypeKey(event.type),
      eventDistance: event.distance,
      eventElevation: event.elevation,
      pathway,
      estimatedFTP: ftp,
      weeklyHoursTarget,
    },
    phases,
    weeks,
  };
}

function describePlan(plan) {
  const { meta, phases, weeks } = plan;
  const labelMap = { race: "Race", sportive: "Sportive", longtour: "Long Tour" };
  const eventLabel = labelMap[meta.eventType] || meta.eventType;
  const phaseLine = phases.map(p => `${p.name} ${p.endWeek - p.startWeek + 1}`).join(" / ");
  const peak = weeks.reduce((best, w) => (!best || w.totalTSS > best.totalTSS ? w : best), null);
  const totalHours = Math.round(weeks.reduce((s, w) => s + w.totalHours, 0));
  return [
    `${meta.weeksUntilEvent}-week plan, ${eventLabel}, ${meta.eventDistance}km, ${meta.eventElevation}m`,
    `Phases: ${phaseLine}`,
    peak ? `Peak week: Wk ${peak.number}, ${peak.totalHours} hrs, ${peak.totalTSS} TSS` : "",
    `Total volume: ${totalHours} hrs`,
  ].filter(Boolean).join("\n");
}

window.RP_PlanGenerator = { generatePlan, describePlan };

})();

// =============================================================================
// Output shape reference
// =============================================================================
//
// {
//   meta: {
//     weeksUntilEvent: 12,
//     eventDate: "2026-08-01",
//     eventType: "race" | "sportive" | "longtour",
//     eventDistance: 160,
//     eventElevation: 1800,
//     pathway: "default" | "timeCrunched",
//     estimatedFTP: 245,
//     weeklyHoursTarget: 8,
//   },
//   phases: [
//     { name: "Base", startWeek: 1, endWeek: 4, tid: "pyramidal" },
//     ...
//   ],
//   weeks: [
//     {
//       number: 1,
//       phase: "Base",
//       isRecoveryWeek: false,
//       totalHours: 6.5,
//       totalTSS: 350,
//       totalKm: 140,
//       days: [
//         { day: "Mon", workout: null },
//         {
//           day: "Tue",
//           workout: {
//             name: "Endurance",
//             type: "endurance",
//             durationMin: 75,
//             distanceKm: 30,
//             tss: 60,
//             primaryZone: "Z2",
//             description: "Steady Z2, smooth cadence 85-95",
//             intervals: [
//               { zone: "Z1", durationMin: 10, label: "Warm-up" },
//               { zone: "Z2", durationMin: 55, label: "Main set" },
//               { zone: "Z1", durationMin: 10, label: "Cool-down" },
//             ],
//           },
//         },
//         ...
//       ],
//     },
//     ...
//   ],
// }
