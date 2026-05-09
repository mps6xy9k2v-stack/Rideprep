/* global window */
// Static data: zones, sample week, demo waypoints.

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
const DEMO_TOUR = {
  from: "Munich, DE",
  to:   "Innsbruck, AT",
  waypoints: [
    { name: "Munich",       lat: 48.1351, lng: 11.5820 },
    { name: "Bad Tölz",     lat: 47.7610, lng: 11.5612 },
    { name: "Mittenwald",   lat: 47.4439, lng: 11.2667 },
    { name: "Seefeld",      lat: 47.3293, lng: 11.1880 },
    { name: "Innsbruck",    lat: 47.2692, lng: 11.4041 },
  ],
  stages: [
    { from: "Munich",     to: "Bad Tölz",   km: 58,  ascent: 410, hours: "3:10", hotel: "Posthotel Kolberbräu", price: "€118", rating: "4.4★" },
    { from: "Bad Tölz",   to: "Mittenwald", km: 64,  ascent: 920, hours: "4:05", hotel: "Hotel Alpenrose",      price: "€145", rating: "4.6★" },
    { from: "Mittenwald", to: "Seefeld",    km: 38,  ascent: 680, hours: "2:45", hotel: "Astoria Resort",        price: "€189", rating: "4.7★" },
    { from: "Seefeld",    to: "Innsbruck",  km: 32,  ascent: 220, hours: "1:50", hotel: "Hotel Innsbruck",       price: "€164", rating: "4.5★" },
  ],
};

window.RP_DATA = { ZONES, SAMPLE_WEEK, SAMPLE_WORKOUT, PLAN_VOLUME, DEMO_TOUR };
