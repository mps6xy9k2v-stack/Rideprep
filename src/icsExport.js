/* global window, document, Blob, URL */
// iCalendar (RFC 5545) export for a generated training plan.
//
// Exposes window.RP_IcsExport.{ generateIcs, downloadIcs } to match the
// global-attachment pattern used by the rest of the project (no bundler;
// files are loaded via plain <script> tags from index.html).
//
//   generateIcs(plan, planStart) -> string   (the .ics file body)
//   downloadIcs(plan, planStart, filename?)  (Blob -> <a download> click)
//
// `plan` is the object returned by RP_PlanGenerator.generatePlan().
// `planStart` is a Date for the Monday of week 1 (training.jsx already
// computes this as `planStartDate()` — we accept it as an argument so the
// dates in the .ics match what the UI shows).

(() => {

// ── Rest-day filter ─────────────────────────────────────────────────────────
// In the generated plan, a rest day is encoded as `{ day: "Mon", workout: null }`.
// There is no string flag like "Rest"/"Ruhetag" in the data model — the PDF
// view renders the word "Rest" purely from the `!workout` check. We mirror
// that and additionally skip any workout whose name/type starts with "rest"
// (case-insensitive) to defend against future schema additions.
function isRestDay(day) {
  if (!day || !day.workout) return true;
  const w = day.workout;
  const tag = String(w.name || w.type || "").trim().toLowerCase();
  if (!tag) return true;
  if (/^rest\b/.test(tag)) return true;       // "rest", "rest day"
  if (/^ruhetag/.test(tag)) return true;      // German equivalent
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

// Fold a single content line to ≤75 octets per RFC 5545 §3.1. Continuation
// lines start with a single space. We use char length as a stand-in for
// octet length — fine for ASCII-only content; for non-ASCII the line may
// be slightly shorter than the spec allows, which is still valid.
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let i = 0;
  parts.push(line.slice(0, 75));
  i = 75;
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

// Build the human-readable SUMMARY and DESCRIPTION from a workout.
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

// Stable UID: same (event, calendar date) always produces the same UID so
// re-importing the .ics updates events rather than duplicating them.
function uidFor(plan, date) {
  const eventType = String(plan.meta.eventType || "plan").replace(/[^a-z0-9]+/gi, "-");
  const eventDate = String(plan.meta.eventDate || "nodate").replace(/[^0-9]/g, "");
  return `rideprep-${eventType}-${eventDate}-${fmtDateBasic(date)}@rideprep.app`;
}

function addDays(d, n) {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

function generateIcs(plan, planStart) {
  if (!plan || !plan.weeks || !planStart) throw new Error("generateIcs: plan and planStart required");

  const dtstamp = fmtDateTimeUtc(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RidePrep//Training Plan//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText("RidePrep Training Plan")}`,
  ];

  for (const week of plan.weeks) {
    for (let i = 0; i < week.days.length; i++) {
      const day = week.days[i];
      if (isRestDay(day)) continue;          // skip rest days entirely

      const date = addDays(planStart, (week.number - 1) * 7 + i);
      const next = addDays(date, 1);

      const summary = escapeText(summaryFor(day.workout));
      const description = escapeText(descriptionFor(day.workout));

      lines.push("BEGIN:VEVENT");
      lines.push(foldLine(`UID:${uidFor(plan, date)}`));
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;VALUE=DATE:${fmtDateBasic(date)}`);
      lines.push(`DTEND;VALUE=DATE:${fmtDateBasic(next)}`);
      lines.push(foldLine(`SUMMARY:${summary}`));
      lines.push(foldLine(`DESCRIPTION:${description}`));
      lines.push("TRANSP:TRANSPARENT");
      lines.push("END:VEVENT");
    }
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function downloadIcs(plan, planStart, filename) {
  const ics = generateIcs(plan, planStart);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "rideprep-training-plan.ics";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.RP_IcsExport = { generateIcs, downloadIcs, isRestDay };

})();
