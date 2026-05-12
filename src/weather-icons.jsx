/* global window, React */
// Weather icons — small flat-line SVGs matching the Ride Prep aesthetic.
// All icons share a 24x24 viewBox and inherit color via currentColor.
(() => {

function IconSun({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function IconPartlyCloudy({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M4.2 4.2l1 1M11.8 4.2l-1 1" />
      <path d="M9 18a4 4 0 0 1 .7-7.9 5 5 0 0 1 9.6 1.4A3.5 3.5 0 0 1 19 18H9z" fill="currentColor" fillOpacity="0.12" />
    </svg>
  );
}

function IconCloud({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 18a4 4 0 0 1 .7-7.9 5 5 0 0 1 9.6 1.4A3.5 3.5 0 0 1 16 18H6z" fill="currentColor" fillOpacity="0.12" />
    </svg>
  );
}

function IconRain({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 14a4 4 0 0 1 .7-7.9 5 5 0 0 1 9.6 1.4A3.5 3.5 0 0 1 16 14H6z" fill="currentColor" fillOpacity="0.12" />
      <path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3" />
    </svg>
  );
}

function IconStorm({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 14a4 4 0 0 1 .7-7.9 5 5 0 0 1 9.6 1.4A3.5 3.5 0 0 1 16 14H6z" fill="currentColor" fillOpacity="0.12" />
      <path d="M12 14l-2 4h3l-2 4" />
    </svg>
  );
}

function IconSnow({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9L4.9 19.1" />
    </svg>
  );
}

function IconWind({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h11a3 3 0 1 0-3-3M3 14h15a3 3 0 1 1-3 3M3 11h17" />
    </svg>
  );
}

function iconForCode(code) {
  if (code === 0) return IconSun;
  if (code <= 2) return IconPartlyCloudy;
  if (code <= 48) return IconCloud;
  if (code <= 67 || (code >= 80 && code <= 82)) return IconRain;
  if (code <= 77 || (code >= 85 && code <= 86)) return IconSnow;
  if (code >= 95) return IconStorm;
  return IconCloud;
}

function conditionForCode(code) {
  if (code === 0) return "Sunny";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Mixed";
}

Object.assign(window, {
  IconSun, IconPartlyCloudy, IconCloud, IconRain, IconStorm, IconSnow, IconWind,
  iconForCode, conditionForCode,
});

})();
