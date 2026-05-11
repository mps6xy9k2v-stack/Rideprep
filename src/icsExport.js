/* global window, document, Blob, URL */
// iCalendar (RFC 5545) export shared by the Training plan and the Tour planner.
//
// Exposes on window.RP_IcsExport:
//   buildVCalendar(events, opts)    -> ICS string from a generic event list
//   downloadIcsString(ics, filename) -> Blob + <a download> trigger
//   generateIcs(plan, planStart)    -> training-plan ICS string (1 VEVENT/workout)
//   downloadIcs(plan, planStart, filename?) -> training download convenience
//   generateTourIcs(tour, startDate) -> tour ICS string (1 VEVENT/stage day)
//   downloadTourIcs(tour, startDate, filename?) -> tour download convenience
//   isRestDay(day) -> bool (exported for testing)
//
// Generic event shape consumed by buildVCalendar:
//   {
//     uid:         "...@rideprep.app",  // required, stable
//     date:        Date,                // local-time date; rendered as VALUE=DATE
//     summary:     "...",               // pre-escape-free; we escape here
//     description: "...",               // may contain newlines
//     categories?: ["RidePrep", ...],
//     color?:      "darkorange",        // RFC 7986 CSS3 color name
//   }

(() => {

// ── Rest-day filter (training plans) ────────────────────────────────────────
// In the training plan, a rest day is `{ day: "Mon", workout: null }`. We
// mirror that and also skip any workout whose name/type matches rest/
// Ruhetag/recovery(off), case-insensitive, defensively.
function isRestDay(day) {
  if (!day || !day.workout) return true;
  const w = day.workout;
  const tag = String(w.name || w.type || "").trim().toLowerCase();
  if (!tag) return true;
  if (/^rest\b/.test(tag)) return true;
  if (/^ruhetag/.test(tag)) return true;
  if (/^recovery\s*\(off\)/.test(tag)) return true;
  return false;
}

// ── Field escaping (RFC 5545 §3.3.11) ───────────────────────────────────────
function escapeText(s) {
  if (s == null) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

// Fold a content line to ≤75 octets per RFC 5545 §3.1. Continuation lines
// start with a single space. Char length stands in for octet length — fine
// for ASCII, slightly conservative for multibyte UTF-8 (still valid).
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let i = 75;
  while (i < line.length) {
    parts.push(" " + line.slice(i, i + 74));
    i += 74;
  }
  return parts.join("\r\n");
}

function fmtDateBasic(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function fmtDateTimeUtc(d) {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${da}T${h}${mi}${s}Z`;
}

function addDays(d, n) {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

// ── Generic VCALENDAR builder ──────────────────────────────────────────────
function buildVCalendar(events, opts = {}) {
  const calName = opts.calName || "RidePrep";
  const prodId = opts.prodId || "-//RidePrep//Calendar//EN";
  const dtstamp = fmtDateTimeUtc(new Date());

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calName)}`,
  ];

  for (const ev of events) {
    if (!ev || !ev.uid || !ev.date) continue;
    const next = addDays(ev.date, 1);
    lines.push("BEGIN:VEVENT");
    lines.push(foldLine(`UID:${ev.uid}`));
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${fmtDateBasic(ev.date)}`);
    lines.push(`DTEND;VALUE=DATE:${fmtDateBasic(next)}`);
    lines.push(foldLine(`SUMMARY:${escapeText(ev.summary)}`));
    if (ev.description != null) {
      lines.push(foldLine(`DESCRIPTION:${escapeText(ev.description)}`));
    }
    if (ev.categories && ev.categories.length) {
      lines.push(foldLine(`CATEGORIES:${ev.categories.map(escapeText).join(",")}`));
    }
    if (ev.color) lines.push(`COLOR:${ev.color}`);
    lines.push("STATUS:CONFIRMED");
    lines.push("TRANSP:TRANSPARENT");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function downloadIcsString(ics, filename) {
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "rideprep.ics";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Training plan: workout → event ──────────────────────────────────────────
const PHASE_COLOR = {
  Prep:  "lightsteelblue",
  Base:  "steelblue",
  Build: "darkorange",
  Peak:  "crimson",
  Taper: "seagreen",
  Adapt: "slategray",
};

function summaryFor(workout) {
  const parts = [workout.name];
  if (workout.durationMin) parts.push(`${workout.durationMin} min`);
  if (workout.primaryZone) parts.push(workout.primaryZone);
  return parts.join(" – ");
}

function descriptionFor(workout) {
  const lines = [];
  if (workout.description) lines.push(workout.description);
  const metrics = [];
  if (workout.durationMin) metrics.push(`${workout.durationMin} min`);
  if (workout.distanceKm)  metrics.push(`${workout.distanceKm} km`);
  if (workout.tss != null) metrics.push(`TSS ${workout.tss}`);
  if (metrics.length)      lines.push(metrics.join(" · "));
  if (workout.targetElevation) lines.push(`Target elevation: ~${workout.targetElevation} m`);
  if (Array.isArray(workout.intervals) && workout.intervals.length) {
    lines.push("");
    lines.push("Intervals:");
    for (const iv of workout.intervals) {
      lines.push(`• ${iv.label} — ${iv.zone}, ${iv.durationMin} min`);
    }
  }
  return lines.join("\n");
}

function planUidFor(plan, date) {
  const eventType = String(plan.meta.eventType || "plan").replace(/[^a-z0-9]+/gi, "-");
  const eventDate = String(plan.meta.eventDate || "nodate").replace(/[^0-9]/g, "");
  return `rideprep-${eventType}-${eventDate}-${fmtDateBasic(date)}@rideprep.app`;
}

function planToEvents(plan, planStart) {
  const events = [];
  for (const week of plan.weeks) {
    for (let i = 0; i < week.days.length; i++) {
      const day = week.days[i];
      if (isRestDay(day)) continue;
      const date = addDays(planStart, (week.number - 1) * 7 + i);
      const phase = week.phase || "";
      const categories = ["RidePrep"];
      if (phase) categories.push(phase);
      if (week.isRecoveryWeek) categories.push("Recovery");
      events.push({
        uid: planUidFor(plan, date),
        date,
        summary: summaryFor(day.workout),
        description: descriptionFor(day.workout),
        categories,
        color: PHASE_COLOR[phase],
      });
    }
  }
  return events;
}

function generateIcs(plan, planStart) {
  if (!plan || !plan.weeks || !planStart) throw new Error("generateIcs: plan and planStart required");
  return buildVCalendar(planToEvents(plan, planStart), {
    calName: "RidePrep Training Plan",
    prodId: "-//RidePrep//Training Plan//EN",
  });
}

function downloadIcs(plan, planStart, filename) {
  downloadIcsString(generateIcs(plan, planStart), filename || "rideprep-training-plan.ics");
}

// ── Tour planner: stage → event ────────────────────────────────────────────

// Parse a "YYYY-MM-DD" string into a Date at local midnight, avoiding the
// UTC-parsing trap of `new Date("YYYY-MM-DD")` which would shift the day
// in negative-offset timezones.
function parseLocalDate(input) {
  if (input instanceof Date) return new Date(input.getTime());
  const s = String(input);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Invalid start date: ${s}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function slug(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "x";
}

// Trim a city label like "Nürnberg, Bavaria, Germany" down to the leading
// locality so titles stay readable in calendar grids.
function cityShort(label) {
  if (!label) return "";
  return String(label).split(",")[0].trim();
}

function tourStageDescription(stage, dayNum) {
  const lines = [];
  lines.push(`Day ${dayNum}: ${stage.from} → ${stage.to}`);
  const metrics = [];
  if (stage.km != null)      metrics.push(`${stage.km} km`);
  if (stage.ascent != null)  metrics.push(`↑ ${stage.ascent} m`);
  if (stage.hours)           metrics.push(`~${stage.hours} hrs`);
  if (metrics.length) lines.push(metrics.join(" · "));
  if (stage.hotel)   lines.push(`Lodging: ${stage.hotel}${stage.price ? ` (${stage.price})` : ""}${stage.rating ? ` · ${stage.rating}` : ""}`);
  if (stage.notes)   lines.push(stage.notes);
  return lines.join("\n");
}

function tourUidFor(tour, startDateISO, dayNum) {
  const fromS = slug(tour.from);
  const toS = slug(tour.to);
  const ds = String(startDateISO || "nodate").replace(/[^0-9]/g, "");
  return `rideprep-tour-${fromS}-${toS}-${ds}-day${dayNum}@rideprep.app`;
}

function tourToEvents(tour, startDateISO) {
  if (!tour || !Array.isArray(tour.stages) || tour.stages.length === 0) return [];
  const start = parseLocalDate(startDateISO);
  return tour.stages.map((stage, i) => {
    const dayNum = i + 1;
    const date = addDays(start, i);
    const summary = `Day ${dayNum}: ${cityShort(stage.from)} → ${cityShort(stage.to)}`;
    return {
      uid: tourUidFor(tour, startDateISO, dayNum),
      date,
      summary,
      description: tourStageDescription(stage, dayNum),
      categories: ["RidePrep", "Tour"],
      color: "steelblue",
    };
  });
}

function generateTourIcs(tour, startDateISO) {
  if (!startDateISO) throw new Error("generateTourIcs: startDate required");
  if (!tour || !tour.stages || tour.stages.length === 0) throw new Error("generateTourIcs: tour has no stages");
  return buildVCalendar(tourToEvents(tour, startDateISO), {
    calName: `RidePrep Tour: ${tour.from || "Tour"} → ${tour.to || ""}`.trim(),
    prodId: "-//RidePrep//Tour Planner//EN",
  });
}

function downloadTourIcs(tour, startDateISO, filename) {
  downloadIcsString(generateTourIcs(tour, startDateISO), filename || "rideprep-tour.ics");
}

window.RP_IcsExport = {
  // Generic
  buildVCalendar,
  downloadIcsString,
  // Training
  generateIcs,
  downloadIcs,
  isRestDay,
  // Tour
  generateTourIcs,
  downloadTourIcs,
};

})();
