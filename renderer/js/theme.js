// Light/dark theme with sun-based AUTO switching. AUTO (the default) runs
// dark from 30 min before sunset until 1 h after sunrise, computed for the
// track location. The choice is per screen (localStorage on this PC), not
// shared race state — the pit wall outside and a station in the box can
// disagree on purpose.

const MODE_KEY = 'themeMode'; // 'auto' | 'light' | 'dark'
const LAT_KEY = 'trackLat';
const LON_KEY = 'trackLon';

// Circuit Zolder — change in SETTINGS → DISPLAY when racing elsewhere.
export const DEFAULT_LAT = 50.99;
export const DEFAULT_LON = 5.257;

export const DARK_BEFORE_SUNSET_MS = 30 * 60e3;
export const LIGHT_AFTER_SUNRISE_MS = 60 * 60e3;

export function getMode() {
  const m = localStorage.getItem(MODE_KEY);
  return m === 'light' || m === 'dark' ? m : 'auto';
}
export function setMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
}

export function getLocation() {
  const lat = parseFloat(localStorage.getItem(LAT_KEY));
  const lon = parseFloat(localStorage.getItem(LON_KEY));
  return {
    lat: isFinite(lat) ? lat : DEFAULT_LAT,
    lon: isFinite(lon) ? lon : DEFAULT_LON
  };
}
export function setLocation(lat, lon) {
  if (isFinite(lat)) localStorage.setItem(LAT_KEY, String(lat));
  if (isFinite(lon)) localStorage.setItem(LON_KEY, String(lon));
}

// ---- sunrise/sunset (NOAA equations, SunCalc-style, ~1 min accuracy) ----

const RAD = Math.PI / 180;
const DAY_MS = 86400e3;
const J1970 = 2440588, J2000 = 2451545;
const E = RAD * 23.4397; // obliquity of the Earth

const toJulian = ms => ms / DAY_MS - 0.5 + J1970;
const fromJulian = j => (j + 0.5 - J1970) * DAY_MS;

function solarTransitJ(ds, M, L) {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}

// Sunrise/sunset around the solar noon nearest to `ms`. Returns null when the
// sun never crosses the horizon that day (polar summer/winter).
export function sunTimes(ms, lat, lon) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toJulian(ms) - J2000;
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const M = RAD * (357.5291 + 0.98560028 * ds);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(L) * Math.sin(E));
  const h0 = RAD * -0.833; // standard refraction-corrected horizon
  const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH < -1 || cosH > 1) return null;
  const w = Math.acos(cosH);
  const Jnoon = solarTransitJ(ds, M, L);
  const Jset = solarTransitJ(0.0009 + (w + lw) / (2 * Math.PI) + n, M, L);
  return { sunriseMs: fromJulian(Jnoon - (Jset - Jnoon)), sunsetMs: fromJulian(Jset) };
}

export function darkNow(now = Date.now()) {
  const mode = getMode();
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  const { lat, lon } = getLocation();
  const t = sunTimes(now, lat, lon);
  if (!t) {
    const h = new Date(now).getHours(); // polar fallback: fixed night hours
    return h >= 21 || h < 6;
  }
  return now >= t.sunsetMs - DARK_BEFORE_SUNSET_MS || now < t.sunriseMs + LIGHT_AFTER_SUNRISE_MS;
}

export function applyTheme(now = Date.now()) {
  document.body.classList.toggle('light', !darkNow(now));
}

export function initTheme() {
  applyTheme();
  setInterval(() => applyTheme(), 30e3);
}

// Wires the SETTINGS → DISPLAY pane (theme buttons, location, live hint).
// Pages without the pane can still call this — it just does nothing.
export function mountThemeSettings() {
  const row = document.getElementById('theme-row');
  const hint = document.getElementById('theme-hint');
  const latInp = document.getElementById('theme-lat');
  const lonInp = document.getElementById('theme-lon');
  if (!row || !hint || !latInp || !lonInp) return;

  const fmt = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const refresh = () => {
    const mode = getMode();
    for (const b of row.querySelectorAll('button[data-theme]')) {
      b.classList.toggle('on', b.dataset.theme === mode);
    }
    const { lat, lon } = getLocation();
    if (document.activeElement !== latInp) latInp.value = lat;
    if (document.activeElement !== lonInp) lonInp.value = lon;
    const now = Date.now();
    const t = sunTimes(now, lat, lon);
    hint.textContent = (t
      ? `Sunset ${fmt(t.sunsetMs)} · sunrise ${fmt(t.sunriseMs)} — AUTO runs dark from ` +
        `${fmt(t.sunsetMs - DARK_BEFORE_SUNSET_MS)} until ${fmt(t.sunriseMs + LIGHT_AFTER_SUNRISE_MS)}.`
      : 'No sunset/sunrise at this latitude today — AUTO falls back to dark 21:00–06:00.') +
      ` Currently ${darkNow(now) ? 'DARK' : 'LIGHT'}.`;
  };

  row.addEventListener('click', e => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    setMode(btn.dataset.theme);
    applyTheme();
    refresh();
  });
  for (const inp of [latInp, lonInp]) {
    inp.addEventListener('change', () => {
      setLocation(parseFloat(latInp.value), parseFloat(lonInp.value));
      applyTheme();
      refresh();
    });
  }
  refresh();
  setInterval(refresh, 30e3);
}
