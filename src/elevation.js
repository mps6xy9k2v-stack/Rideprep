/* global window */
// Single source of truth for elevation math.
//
// All views (per-stage card, total ascent in the summary bar, tour-day
// modal subtitle, elevation chart) consume the result of computeProfile().
// Computing once per stage at route-build time and caching it on the stage
// guarantees that the card and the modal can never disagree.
//
// Pipeline (Komoot/Strava-style):
//   1. Resample the [lng, lat, elev] series to one point every RESAMPLE_DISTANCE_M
//   2. Smooth elevations with a moving average (SMOOTHING_WINDOW points)
//   3. Clamp any single-sample delta > OUTLIER_CLAMP_METERS as a DEM artifact
//      (bridges/tunnels measure ground level under the road)
//   4. Threshold-sum ascent/descent: deltas < MIN_DELTA_METERS don't count,
//      so tiny DEM noise can't accumulate
//   5. Downsample to ~200 points for the chart
//
// Tune these constants if the calibration shifts.

(() => {

const SMOOTHING_WINDOW = 5;        // points (≈150 m at 30 m resample)
const MIN_DELTA_METERS = 3;        // smaller deltas treated as noise
const RESAMPLE_DISTANCE_M = 30;    // meters between resampled points
const DESPIKE_THRESHOLD_M = 25;    // isolated single-sample spikes above this
                                   // are treated as DEM artifacts (bridges,
                                   // tunnels) and replaced with neighbor avg
const CHART_POINTS = 200;          // downsampled count for the area chart

function distMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Walk the polyline and emit a new vertex every `stepM` meters along the
// route. Linearly interpolates lng/lat/elev between adjacent input points.
function resampleByDistance(coords, stepM) {
  if (coords.length < 2) return coords.slice();
  const out = [coords[0]];
  let cum = 0;
  let target = stepM;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const seg = distMeters(a, b);
    if (seg === 0) continue;
    while (cum + seg >= target) {
      const t = (target - cum) / seg;
      out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]);
      target += stepM;
    }
    cum += seg;
  }
  // Always include the final vertex so the route doesn't get truncated.
  const last = coords[coords.length - 1];
  const tail = out[out.length - 1];
  if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

// Replace any vertex that's an isolated local extremum more than
// threshold meters away from BOTH neighbors with the neighbor average.
// Catches bridge/tunnel DEM spikes before they enter the smoothing pass.
function despike(values, threshold) {
  const out = values.slice();
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const dPrev = b - a, dNext = b - c;
    if (Math.abs(dPrev) > threshold && Math.abs(dNext) > threshold
        && Math.sign(dPrev) === Math.sign(dNext)) {
      out[i] = (a + c) / 2;
    }
  }
  return out;
}

function movingAverage(values, windowSize) {
  const half = Math.floor(windowSize / 2);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, n = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    for (let k = lo; k <= hi; k++) { sum += values[k]; n++; }
    out[i] = sum / n;
  }
  return out;
}

function computeProfile(coords) {
  const empty = {
    totalAscent: 0, totalDescent: 0, max: 0, min: 0, totalKm: 0,
    samples: [], hasElevation: false,
  };
  if (!Array.isArray(coords) || coords.length < 2) return empty;
  const hasElevation = coords.every((c) => Array.isArray(c) && Number.isFinite(c[2]));
  if (!hasElevation) return empty;

  // 1. Resample to one point every RESAMPLE_DISTANCE_M.
  const resampled = resampleByDistance(coords, RESAMPLE_DISTANCE_M);
  if (resampled.length < 2) return empty;

  // 2. Despike isolated DEM artifacts, then smooth.
  const raw = resampled.map((c) => c[2]);
  const cleaned = despike(raw, DESPIKE_THRESHOLD_M);
  const smoothed = movingAverage(cleaned, SMOOTHING_WINDOW);

  // 3. Segment-based hysteresis (Komoot/Strava style). Track the current
  // climb or descent as a segment: the moment we drop MIN_DELTA_METERS
  // below a climb's running peak (or rise that much above a descent's
  // running trough) the prior swing is committed and direction flips.
  // This counts the full magnitude of even very gentle sustained climbs
  // while sub-threshold wobble can never trigger a direction change.
  let totalAscent = 0, totalDescent = 0;
  let maxEle = smoothed[0], minEle = smoothed[0];
  let segStart = smoothed[0];
  let segPeak = smoothed[0];
  let segTrough = smoothed[0];
  let dir = 0; // 1=climbing, -1=descending, 0=undetermined
  for (let i = 1; i < smoothed.length; i++) {
    const e = smoothed[i];
    if (e > maxEle) maxEle = e;
    if (e < minEle) minEle = e;
    if (dir === 1) {
      if (e > segPeak) segPeak = e;
      if (segPeak - e >= MIN_DELTA_METERS) {
        totalAscent += segPeak - segStart;
        segStart = segPeak;
        segTrough = e;
        dir = -1;
      }
    } else if (dir === -1) {
      if (e < segTrough) segTrough = e;
      if (e - segTrough >= MIN_DELTA_METERS) {
        totalDescent += segStart - segTrough;
        segStart = segTrough;
        segPeak = e;
        dir = 1;
      }
    } else {
      if (e - segStart >= MIN_DELTA_METERS) { dir = 1; segPeak = e; }
      else if (segStart - e >= MIN_DELTA_METERS) { dir = -1; segTrough = e; }
    }
  }
  // Commit the final, unfinished segment.
  if (dir === 1 && segPeak > segStart) totalAscent += segPeak - segStart;
  if (dir === -1 && segStart > segTrough) totalDescent += segStart - segTrough;

  // Cumulative distance along the resampled series.
  const cum = new Float64Array(resampled.length);
  for (let i = 1; i < resampled.length; i++) {
    cum[i] = cum[i - 1] + distMeters(resampled[i - 1], resampled[i]);
  }
  const totalM = cum[cum.length - 1];

  // 5. Downsample to ~CHART_POINTS for the area chart.
  const N = Math.max(2, Math.min(CHART_POINTS, smoothed.length));
  const samples = new Array(N);
  let raw_i = 0;
  for (let i = 0; i < N; i++) {
    const targetD = (totalM * i) / (N - 1);
    while (raw_i < cum.length - 1 && cum[raw_i + 1] < targetD) raw_i++;
    let ele;
    if (raw_i >= cum.length - 1) {
      ele = smoothed[cum.length - 1];
    } else {
      const span = cum[raw_i + 1] - cum[raw_i];
      const t = span > 0 ? (targetD - cum[raw_i]) / span : 0;
      ele = lerp(smoothed[raw_i], smoothed[raw_i + 1], t);
    }
    samples[i] = { km: targetD / 1000, ele };
  }

  return {
    totalAscent: Math.round(totalAscent),
    totalDescent: Math.round(totalDescent),
    max: Math.round(maxEle),
    min: Math.round(minEle),
    totalKm: Math.round((totalM / 1000) * 10) / 10,
    samples,
    hasElevation: true,
  };
}

window.RP_Elevation = {
  computeProfile,
  PARAMS: { SMOOTHING_WINDOW, MIN_DELTA_METERS, RESAMPLE_DISTANCE_M, DESPIKE_THRESHOLD_M, CHART_POINTS },
};

})();
