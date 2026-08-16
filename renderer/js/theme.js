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

// ---------------------------------------------------------------------------
// Board size — how big the pit wall draws itself
// ---------------------------------------------------------------------------
// The wall is read from across the garage, so what matters is not how many
// pixels the TV has but how large the words come out on it. The card layout
// was drawn for a ~1500×900 window; a 4K panel does not make it more readable,
// it just draws the same design in smaller millimetres. So the whole board is
// scaled as one block (zoom carries padding, borders and icons with it, which
// keeps the hierarchy the card was designed with) and the crew picks the
// factor that reads from where they stand. AUTO takes the board up to the
// window's own size — the design at 1500×900 blown up to fill the panel.
// Saved per screen like the theme: the TV in the box and a laptop showing the
// same wall want different numbers.

const WALL_KEY = 'wallZoom';
const WALL_DESIGN_W = 1500;
const WALL_DESIGN_H = 900;
export const WALL_ZOOM_MIN = 1;
// Absolute ceiling, and the least a card may be left with. Below roughly this
// many CSS pixels a card cannot hold a live stop whatever it gives back, and a
// board that quietly drops the bottom of the work order is worse than a small
// one — so the slider stops before that, wherever this screen's limit falls.
export const WALL_ZOOM_MAX = 2.5;
const MIN_CARD_PX = 660;

// Stored value: 'auto', or a factor as a string. Anything else reads as auto.
export function getWallZoom() {
  const raw = localStorage.getItem(WALL_KEY);
  if (raw === 'auto' || raw == null) return 'auto';
  const z = parseFloat(raw);
  return isFinite(z) ? String(round20(z)) : 'auto';
}
export function setWallZoom(z) {
  localStorage.setItem(WALL_KEY, z === 'auto' ? 'auto' : String(round20(parseFloat(z))));
}

const round20 = z => Math.round(z * 20) / 20;
const clampZoom = z => Math.min(maxWallZoom(), Math.max(WALL_ZOOM_MIN, round20(z)));

// The most this screen can be scaled and still show four whole cards.
export function maxWallZoom() {
  const wall = document.getElementById('wall');
  // Screen pixels, not board pixels: the rectangle is unaffected by the zoom
  // it is being used to choose.
  const h = wall ? wall.getBoundingClientRect().height : window.innerHeight - 120;
  return Math.min(WALL_ZOOM_MAX, Math.max(WALL_ZOOM_MIN, round20(h / MIN_CARD_PX)));
}

// The factor AUTO settles on for this window: the design size blown up to fill
// it, never below 1 (a small window keeps the design as drawn).
export function autoWallZoom(w = window.innerWidth, h = window.innerHeight) {
  return clampZoom(Math.min(w / WALL_DESIGN_W, h / WALL_DESIGN_H));
}

export function wallZoomFactor() {
  const z = getWallZoom();
  return z === 'auto' ? autoWallZoom() : clampZoom(parseFloat(z));
}

export function applyWallZoom() {
  document.documentElement.style.setProperty('--wallzoom', String(wallZoomFactor()));
  gradeBoard();
}

// Whether the board still fits. Scaled up for a TV a card is left with fewer
// CSS pixels than the design assumes, and a live stop — verdict, work order,
// crew note and both buttons — is the tallest thing it ever carries. Rather
// than clip the bottom of the work order, where the crew would simply never
// see that brake set, the card gives back its padding first (.board-tight)
// and then the detail lines under each instruction (.board-min): at that size
// the board is read from a distance where "PADS F PF2" is the whole message
// and "rig +40 L · 28 s" was never going to be read anyway. The engineer's
// station keeps every figure.
//
// Measured rather than derived from the zoom factor, because what a card
// actually gets also depends on the window, on which strips are out and on
// how much this particular stop has to say. Decided from scratch each time —
// the classes come off before measuring — so the board cannot oscillate
// between two levels.
const SLACK_PX = 2;

function overflowing() {
  for (const card of document.querySelectorAll('.wallcard')) {
    if (card.scrollHeight - card.clientHeight > SLACK_PX) return true;
    const grab = card.querySelector('.grab');
    if (grab && grab.scrollHeight - grab.clientHeight > SLACK_PX) return true;
  }
  return false;
}

export function gradeBoard() {
  if (!document.querySelector('.wallcard')) return;
  const cl = document.body.classList;
  cl.remove('board-tight', 'board-min');
  if (!overflowing()) return;
  cl.add('board-tight');
  if (overflowing()) cl.add('board-min');
}

// Pit wall only: the board scales, the top bar and settings do not.
export function initWallZoom() {
  applyWallZoom();
  window.addEventListener('resize', applyWallZoom);
  // The cards arrive after the first state, and the strips above them come
  // and go with the flag — both change what a card is left with, and the
  // strips also change the height the ceiling is worked out from. Re-applying
  // settles at once: the factor is read from the board's size on screen,
  // which the zoom it sets does not move.
  const wall = document.getElementById('wall');
  if (wall && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => applyWallZoom()).observe(wall);
  }
}

// Wires SETTINGS → DISPLAY → board size: AUTO, or the slider the crew drags
// until the far side of the garage can read it. The board resizes under the
// hand, so the setting is judged the only way it can be — by looking at it.
// Pages without the row do nothing.
export function mountWallSizeSettings() {
  const auto = document.getElementById('wallsize-auto');
  const range = document.getElementById('wallsize-range');
  const val = document.getElementById('wallsize-val');
  const hint = document.getElementById('wallsize-hint');
  if (!auto || !range || !val || !hint) return;

  range.min = String(Math.round(WALL_ZOOM_MIN * 100));
  range.step = '5';

  const refresh = () => {
    const isAuto = getWallZoom() === 'auto';
    const f = wallZoomFactor();
    const max = maxWallZoom();
    // The slider stops where four whole cards stop fitting, so it cannot be
    // dragged into a board that hides the bottom of a work order.
    range.max = String(Math.round(max * 100));
    auto.classList.toggle('on', isAuto);
    if (document.activeElement !== range) range.value = String(Math.round(f * 100));
    val.textContent = `${Math.round(f * 100)}%`;
    hint.textContent = (isAuto
      ? `AUTO — ${Math.round(f * 100)}% fills this ${window.innerWidth}×${window.innerHeight} screen.`
      : `Held at ${Math.round(f * 100)}% (AUTO would use ${Math.round(autoWallZoom() * 100)}%).`) +
      ` This screen carries four cards up to ${Math.round(max * 100)}%.`;
  };

  auto.addEventListener('click', () => { setWallZoom('auto'); applyWallZoom(); refresh(); });
  range.addEventListener('input', () => {
    setWallZoom(parseInt(range.value, 10) / 100);
    applyWallZoom();
    refresh();
  });
  window.addEventListener('resize', refresh);
  refresh();
}

// ---------------------------------------------------------------------------
// Page size — how large a station draws itself
// ---------------------------------------------------------------------------
// A station has the wall's problem from the other side. The wall is read from
// across the garage and had to be made bigger; a station is read by one
// engineer sitting in front of it, so its trouble is not distance but density.
// The strategy view carries every figure for the car at once, and the page was
// shrunk until all of it fitted the window, whatever that did to the type: 77%
// on a 1920×1080 screen, so the 15 px base came out at 11.6 px, and 62% on a
// 1600×900 laptop, which is under 9 px. Nobody reads that at 03:00, and a
// number nobody reads is not on the screen in any sense that matters.
//
// So the shrink now stops at a floor and what is left over scrolls, and the
// crew can set the size outright instead. AUTO fills the window in both
// directions — it also grows the page, which the old ceiling of 100% refused
// to do, so a 4K panel was being handed the design at 1:1 and drawing it in
// the same small millimetres the wall was. Saved per screen, like the theme.

const UI_KEY = 'uiZoom';
// The bottom of the slider is roughly what auto-fit used to do on its own, so
// a crew that wants the whole page on screen at any size can still have it.
export const UI_ZOOM_MIN = 0.6;
export const UI_ZOOM_MAX = 2.5;
// AUTO will not shrink past this. 90% is the point where the 11 px labels
// (POS, DRIVER, STINT) are still words rather than texture.
export const UI_AUTO_FLOOR = 0.9;
// ...and it is only scaled up while the design still has room across: the
// layout is a 1fr column beside a 370 px stop card, and below this it starts
// squeezing the left column instead of enlarging it.
const MIN_LAYOUT_W = 1180;

// Stored value: 'auto', or a factor as a string. Anything else reads as auto.
export function getUiZoom() {
  const raw = localStorage.getItem(UI_KEY);
  if (raw === 'auto' || raw == null) return 'auto';
  const z = parseFloat(raw);
  return isFinite(z) ? String(round20(z)) : 'auto';
}
export function setUiZoom(z) {
  localStorage.setItem(UI_KEY, z === 'auto' ? 'auto' : String(round20(parseFloat(z))));
}

// The most this screen can be scaled and still have room across.
export function maxUiZoom(w = window.innerWidth) {
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, round20(w / MIN_LAYOUT_W)));
}
export function clampUiZoom(z) {
  return Math.min(maxUiZoom(), Math.max(UI_ZOOM_MIN, round20(z)));
}

// station.js measures the page after every render and reports what it settled
// on. The settings row reads those numbers back, so the hint can say what AUTO
// is actually doing on this screen and what it would take to fit everything —
// the two things the crew needs to choose between size and scrolling.
let lastFit = null;
let refreshUiSize = null;
export function noteUiFit(fit) {
  lastFit = fit;
  if (refreshUiSize) refreshUiSize();
}

// Wires SETTINGS → DISPLAY → page size. `apply` is the page's own fit pass
// (station.js autofit), called so the page resizes under the hand — the same
// way the board size is judged. Pages without the row do nothing.
export function mountUiSizeSettings(apply = () => {}) {
  const auto = document.getElementById('uisize-auto');
  const range = document.getElementById('uisize-range');
  const val = document.getElementById('uisize-val');
  const hint = document.getElementById('uisize-hint');
  if (!auto || !range || !val || !hint) return;

  range.min = String(Math.round(UI_ZOOM_MIN * 100));
  range.step = '5';

  refreshUiSize = () => {
    const stored = getUiZoom();
    const isAuto = stored === 'auto';
    // What is on the screen right now, which under AUTO is the only place the
    // factor exists — the fit pass owns it, this row only reports it.
    const f = lastFit ? lastFit.applied : (isAuto ? 1 : clampUiZoom(parseFloat(stored)));
    const pct = Math.round(f * 100);
    range.max = String(Math.round(maxUiZoom() * 100));
    auto.classList.toggle('on', isAuto);
    if (document.activeElement !== range) range.value = String(pct);
    val.textContent = `${pct}%`;

    const over = lastFit ? lastFit.over : 0;
    hint.textContent = (isAuto
      ? `AUTO — ${pct}% on this ${window.innerWidth}×${window.innerHeight} screen` +
        (f <= UI_AUTO_FLOOR ? ', which is as small as AUTO goes' : '')
      : `Held at ${pct}%`) +
      (over > 2
        ? `. ${over} px of a column is below the fold and scrolls — it all fits on screen at ${lastFit.fitsAt}%.`
        : '. Everything is on screen.');
  };

  auto.addEventListener('click', () => { setUiZoom('auto'); apply(); refreshUiSize(); });
  range.addEventListener('input', () => {
    setUiZoom(parseInt(range.value, 10) / 100);
    apply();
    refreshUiSize();
  });
  window.addEventListener('resize', refreshUiSize);
  refreshUiSize();
}
