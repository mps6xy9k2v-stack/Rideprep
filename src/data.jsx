/* global window */
// Static data: zones, sample week, demo waypoints.
(() => {
const ZONES = [
  { id: "Z1", name: "Recovery",    range: "<55% FTP",   color: "#9bd1a4" },
  { id: "Z2", name: "Endurance",   range: "55-75% FTP", color: "#4cc9f0" },
  { id: "Z3", name: "Tempo",       range: "76-90% FTP", color: "#80a4ed" },
  { id: "Z4", name: "Threshold",   range: "91-105% FTP",color: "#f4b860" },
  { id: "Z5", name: "VO₂ Max",     range: "106-120% FTP", color: "#e07a5f" },
  { id: "Z6", name: "Anaerobic",   range: ">120% FTP",  color: "#c45a8a" },
];

const SAMPLE_WEEK = [
  { dow: "MON", date: "May 4", type: "Rest",          rest: true },
  { dow: "TUE", date: "May 5", type: "Threshold",     km: 48,  tss: 78,  zones: [1,2,4,4,2,1] },
  { dow: "WED", date: "May 6", type: "Endurance",     km: 65,  tss: 62,  zones: [2,2,2,3,2,2] },
  { dow: "THU", date: "May 7", type: "VO₂ Intervals", km: 42,  tss: 92,  zones: [1,2,5,5,2,1], selected: true },
  { dow: "FRI", date: "May 8", type: "Rest",          rest: true },
  { dow: "SAT", date: "May 9", type: "Long Endurance",km: 110, tss: 145, zones: [2,2,3,2,2,2] },
  { dow: "SUN", date: "May 10",type: "Recovery Spin", km: 35,  tss: 28,  zones: [1,2,1,2,1,1] },
];

// Selected workout (Thursday VO₂)
const SAMPLE_WORKOUT = {
  title: "VO₂ Max Intervals",
  duration: "1h 30m",
  tss: 92,
  ifv: "0.91",
  intervals: [
    { zone: "Z1", label: "Warm-up",       detail: "Easy spin",         duration: "15:00", color: "#9bd1a4" },
    { zone: "Z2", label: "Steady build",  detail: "Smooth cadence",    duration: "10:00", color: "#4cc9f0" },
    { zone: "Z5", label: "Interval 1",    detail: "5×3min @ VO₂",      duration: "3:00",  color: "#e07a5f" },
    { zone: "Z2", label: "Recovery",      detail: "Spin easy",         duration: "3:00",  color: "#4cc9f0" },
    { zone: "Z5", label: "Interval 2",    detail: "@ VO₂",             duration: "3:00",  color: "#e07a5f" },
    { zone: "Z2", label: "Recovery",      detail: "Spin easy",         duration: "3:00",  color: "#4cc9f0" },
    { zone: "Z5", label: "Interval 3",    detail: "@ VO₂",             duration: "3:00",  color: "#e07a5f" },
    { zone: "Z2", label: "Recovery",      detail: "Spin easy",         duration: "3:00",  color: "#4cc9f0" },
    { zone: "Z5", label: "Interval 4",    detail: "@ VO₂",             duration: "3:00",  color: "#e07a5f" },
    { zone: "Z2", label: "Recovery",      detail: "Spin easy",         duration: "3:00",  color: "#4cc9f0" },
    { zone: "Z5", label: "Interval 5",    detail: "@ VO₂",             duration: "3:00",  color: "#e07a5f" },
    { zone: "Z1", label: "Cool-down",     detail: "Easy spin",         duration: "15:00", color: "#9bd1a4" },
  ],
};

// 6-week plan volume (km/week)
const PLAN_VOLUME = [180, 220, 260, 200, 290, 230];

// Demo route waypoints, used as fallback when no API key.
// 5 stages, 120 km / 800 m each — total ~600 km / 4000 m.
const DEMO_TOUR = {
  from: "Berlin, DE",
  to:   "München, DE",
  waypoints: [
    { name: "Berlin",            lat: 52.5200, lng: 13.4050 },
    { name: "Bitterfeld-Wolfen", lat: 51.6233, lng: 12.3033 },
    { name: "Erfurt",            lat: 50.9848, lng: 11.0299 },
    { name: "Coburg",            lat: 50.2601, lng: 10.9637 },
    { name: "Nürnberg",          lat: 49.4521, lng: 11.0767 },
    { name: "München",           lat: 48.1351, lng: 11.5820 },
  ],
  stages: [
    { from: "Berlin",            to: "Bitterfeld-Wolfen", km: 120, ascent: 800, hours: "6:50", hotel: "Hotel Stadtpark",  price: "€95",  rating: "4.3★" },
    { from: "Bitterfeld-Wolfen", to: "Erfurt",            km: 120, ascent: 800, hours: "6:50", hotel: "Hotel Zumnorde",   price: "€110", rating: "4.5★" },
    { from: "Erfurt",            to: "Coburg",            km: 120, ascent: 800, hours: "6:50", hotel: "Hotel Coburg",     price: "€105", rating: "4.4★" },
    { from: "Coburg",            to: "Nürnberg",          km: 120, ascent: 800, hours: "6:50", hotel: "Hotel Elch",       price: "€130", rating: "4.6★" },
    { from: "Nürnberg",          to: "München",           km: 120, ascent: 800, hours: "6:50", hotel: "Hotel Laimer Hof", price: "€155", rating: "4.7★" },
  ],
};

window.RP_DATA = { ZONES, SAMPLE_WEEK, SAMPLE_WORKOUT, PLAN_VOLUME, DEMO_TOUR };
})();
