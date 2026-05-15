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

// Hover/tap tooltip. `content` may be a string or React node. If `content`
// is falsy the children render unwrapped — handy for conditional tips.
// Auto-flips side when viewport space is tight.
function Tooltip({ children, content, side = "top" }) {
  const [open, setOpen] = useState(false);
  const [actualSide, setActualSide] = useState(side);
  const wrapRef = useRef(null);
  if (!content) return children;

  function handleOpen() {
    if (wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      if (side === "bottom" && window.innerHeight - rect.bottom < 120 && rect.top > 80) {
        setActualSide("top");
      } else if (side === "top" && rect.top < 80 && window.innerHeight - rect.bottom > 120) {
        setActualSide("bottom");
      } else {
        setActualSide(side);
      }
    }
    setOpen(true);
  }

  return (
    <span
      ref={wrapRef}
      className="tip-wrap"
      onMouseEnter={handleOpen}
      onMouseLeave={() => setOpen(false)}
      onFocus={handleOpen}
      onBlur={() => setOpen(false)}
      onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
    >
      {children}
      {open && (
        <span className={"tip tip-" + actualSide} role="tooltip">
          {content}
        </span>
      )}
    </span>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark"><BikeIcon /></span>
      <span className="brand-name">Ride Prep</span>
    </div>
  );
}

window.RP_SHARED = { clsx, fmtKm, fmtElev, BikeIcon, Pill, Tooltip, Brand };
})();
