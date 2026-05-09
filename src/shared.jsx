/* global window */
// Shared helpers + small components.
(() => {
const { useState, useEffect, useRef, useCallback, useMemo } = React;

function clsx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function fmtKm(km, units) {
  if (units === "imperial") return `${Math.round(km * 0.621371)} mi`;
  return `${Math.round(km)} km`;
}

function fmtElev(m, units) {
  if (units === "imperial") return `${Math.round(m * 3.281)} ft`;
  return `${Math.round(m)} m`;
}

// Tiny SVG bike icon used in the brand mark.
function BikeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="17" r="3.5" />
      <circle cx="18" cy="17" r="3.5" />
      <path d="M6 17 L11 8 L15 17 M11 8 L13 5 L16 5 M11 8 L9 5 L7 5" />
    </svg>
  );
}

function Pill({ children }) {
  return <span className="pill">{children}</span>;
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark"><BikeIcon /></span>
      <span className="brand-name">Ride Prep</span>
    </div>
  );
}

window.RP_SHARED = { clsx, fmtKm, fmtElev, BikeIcon, Pill, Brand };
})();
