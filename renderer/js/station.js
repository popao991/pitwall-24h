// Car strategy station (PCs 1-4). Connects to the pit wall server, shows the
// live strategy picture for one car and lets the engineer plan the next stop.

import {
  PORT, CONDITIONS, BRAKE_COMPONENTS, DRIVER_COLORS,
  carCalcs, raceClock, projectStints, emptyStop, defaultDriver,
  stopServiceTime, fcyCalc, fuelStrategy, pitLaneCalc, pitEta, generatePlan,
  normalizeCurve, burnAtLapTime, emptyCurvePoint, LAP_AVG_WINDOW,
  currentTyreSet, stopTyreSet, replanFromNow, planVsActual, stintStats, learnedOf,
  tyreSetMileage, tyreLifeLapsOf, tyreKmLeft,
  brakeSetsOf, usableBrakeSets, brakeSetHours,
  recommendedStops, resolveStop,
  fmtClock, fmtMinSec, fmtLap, fmtH,
  TIMING_FLAGS, fmtLapUs, fmtGapUs, timingNrOf, ourTimingNrs, createFeedSeen, carPickLabel,
  driverAbbrev, matchTimingDriver
} from '../../shared/model.js';
import { connect } from './net.js';
import { renderConditionBar, initConditionControls, renderConditionControls } from './condition.js';
import { icon, applyIcons } from './icons.js';
import { initTheme, mountThemeSettings } from './theme.js';
import { initHelpToggles } from './help.js';
import { createTracker } from './trackmap.js';
import { createRcPanel } from './rcmsg.js';

applyIcons();
initTheme();
mountThemeSettings();
initHelpToggles();

const esc = s => String(s).replace(/</g, '&lt;');

const carId = localStorage.getItem('carId') || '1';
const serverIp = localStorage.getItem('serverIp') || '127.0.0.1';
const serverPort = localStorage.getItem('serverPort') || PORT; // override used by tests

const $ = id => document.getElementById(id);
let state = null;
let timing = null;
let timingRxMs = 0; // when the last timing snapshot arrived (for E.T.A. ticking)
const feedSeen = createFeedSeen(); // timing nrs the feed has posted this session

// The pit-lane machines only show the newest three messages; the full log
// stays one HISTORY tap away.
const rcPanel = createRcPanel({ limit: 3 });

const net = connect({
  url: `ws://${serverIp}:${serverPort}`,
  onState: s => { state = s; tracker.setData(s, null); render(); },
  onTiming: t => {
    timing = t;
    timingRxMs = Date.now();
    feedSeen.update(t);
    tracker.setData(null, t, timingRxMs);
    renderTiming();
    renderScoreboard();
    rcPanel.update(t);
  },
  onStatus: ok => {
    // Announce which car this station runs on every (re)connect, so the wall
    // can tell a live car from one whose laptop dropped.
    if (ok) net.send({ type: 'hello', role: 'station', carId });
    const el = $('conn');
    el.textContent = ok ? `connected ${serverIp}` : `reconnecting ${serverIp}…`;
    el.className = 'conn ' + (ok ? 'ok' : 'bad');
    const st = $('conn-status');
    st.textContent = `${ok ? 'CONNECTED' : 'RECONNECTING…'} — ws://${serverIp}:${serverPort}`;
    st.className = 'v ' + (ok ? 'good' : 'warn');
  }
});

// ---- pit wall connection (settings → CONNECTION tab) ----
// The target address is chosen on the start screen and remembered per PC; this
// tab makes it visible and changeable without leaving the running station.

$('conn-ip').value = serverIp;
$('conn-port').value = serverPort;
$('conn-car').value = carId;
$('conn-status').textContent = `connecting — ws://${serverIp}:${serverPort}`;
$('btn-conn-apply').addEventListener('click', () => {
  const ip = $('conn-ip').value.trim();
  if (!ip) return alert('Enter the pit wall IP first (shown on the pit wall screen).');
  const port = parseInt($('conn-port').value, 10);
  const nextCar = $('conn-car').value;
  if (ip === serverIp && String(port || PORT) === String(serverPort) && nextCar === carId) {
    return alert('Nothing changed — the station already uses this address.');
  }
  const carLabel = $('conn-car').selectedOptions[0]?.textContent || `Car ${nextCar}`;
  if (!confirm(`Reconnect this station to ws://${ip}:${port || PORT} as ${carLabel}?`)) return;
  localStorage.setItem('serverIp', ip);
  localStorage.setItem('serverPort', String(port > 0 ? port : PORT));
  localStorage.setItem('carId', nextCar);
  location.reload();
});

// Car names in the picker follow the shared state (they can be renamed on the
// pit wall or any station mid-race), and the last labels seen are cached for
// the start screen's picker, which has no server connection of its own.
let carLabelsCached = '';
function renderCarPicker() {
  const labels = {};
  for (const opt of $('conn-car').options) {
    const c = state.cars[opt.value];
    if (!c) continue;
    labels[opt.value] = carPickLabel(opt.value, c);
    if (opt.textContent !== labels[opt.value]) opt.textContent = labels[opt.value];
  }
  const json = JSON.stringify(labels);
  if (json !== carLabelsCached) {
    carLabelsCached = json;
    try { localStorage.setItem('carLabels', json); } catch { /* cosmetic only */ }
  }
}

const send = msg => net.send({ carId, ...msg });
const patchCar = patch => send({ type: 'update', patch });
const patchStop = patch => patchCar({ nextStop: patch });

$('btn-back').addEventListener('click', () => (location.href = 'index.html'));

// ---- view tabs (strategy / scoreboard) ----

const stationEl = document.querySelector('.station');
const sbView = $('sbview');
const tracker = createTracker($('trkview'));
const viewTabs = $('view-tabs');
viewTabs.addEventListener('click', e => {
  const btn = e.target.closest('button[data-view]');
  if (btn) showView(btn.dataset.view);
});
function showView(v) {
  for (const b of viewTabs.children) b.classList.toggle('on', b.dataset.view === v);
  stationEl.classList.toggle('hidden', v !== 'strategy');
  sbView.classList.toggle('hidden', v !== 'scoreboard');
  $('trkview').classList.toggle('hidden', v !== 'tracker');
  if (v === 'tracker') tracker.show();
  else tracker.hide();
  if (v === 'scoreboard') {
    renderScoreboard();
    sbView.querySelector('tr.own')?.scrollIntoView({ block: 'center' });
  } else if (v === 'strategy') {
    autofit();
  }
}

// ---- lap logging ----

$('btn-lap').addEventListener('click', () => {
  const t = parseFloat($('lap-time').value);
  send({ type: 'lap', lapSec: isNaN(t) ? null : t });
  $('lap-time').value = '';
});
$('btn-undo').addEventListener('click', () => send({ type: 'undoLap' }));

// ---- live timing (decoded on the pit wall PC, rebroadcast to stations) ----

$('lt-autolap').addEventListener('click', () => {
  if (!state) return;
  const on = state.timing?.autoLap?.[carId] === false;
  if (!on && !confirm('Turn off auto lap? The feed stops counting this car\'s laps and manual lap logging returns.')) return;
  net.send({ type: 'timingAutoLap', carId, on });
});

function renderTiming() {
  if (!state) return;
  const car = state.cars[carId];
  if (!car) return;

  const nr = timingNrOf(state.timing || {}, car);
  $('lt-nr').textContent = nr ? `#${nr}` : '';

  const auto = state.timing?.autoLap?.[carId] !== false; // default ON
  const autoBtn = $('lt-autolap');
  autoBtn.textContent = auto ? 'ON' : 'OFF';
  autoBtn.className = 'flag' + (auto ? ' on' : '');

  // While the feed is live and driving this car's counters (auto lap, the
  // default), the manual lap-logging block is dead weight — hide it and say
  // in one line who is counting. It comes back if the feed drops or auto lap
  // is switched off.
  // The feed is showing a different session than this race: the pit wall has
  // to say which it is, and until then nothing from the feed counts — so lap
  // logging comes back to the crew.
  const held = !!state.timing?.sessionAlert;
  const connected = timing?.conn === 'connected';
  const feedDriving = auto && connected && !held;
  $('lap-panel').hidden = feedDriving;
  $('lap-auto-note').hidden = !(connected && !auto);
  $('lap-feed-mode').textContent = feedDriving
    ? `feed · ${car.state.totalLaps} laps`
    : `manual · ${car.state.totalLaps} laps`;

  const stateEl = $('lt-state');
  if (held) {
    const a = state.timing.sessionAlert;
    stateEl.textContent = `NEW SESSION ON THE FEED — "${a.to}" · answer on the pit wall (feed held)`;
    stateEl.className = 'v warn';
  } else if (!timing || !timing.conn || timing.conn === 'off') {
    stateEl.textContent = 'off — connect on the pit wall';
    stateEl.className = 'v';
  } else if (timing.conn === 'connected' || timing.conn === 'replay') {
    const flag = TIMING_FLAGS[timing.session?.flag];
    const rem = timing.session?.remainUs != null ? ' · ' + fmtClock(timing.session.remainUs / 1000) : '';
    const pre = timing.conn === 'replay' ? 'REPLAY · ' : '';
    stateEl.textContent = pre + (timing.session?.name || 'live') + (flag ? ` · ${flag.label}` : '') + rem;
    stateEl.className = 'v lt-' + (flag?.cls || 'none');
  } else {
    stateEl.textContent = timing.conn + (timing.lastError ? ' — ' + timing.lastError : '');
    stateEl.className = 'v warn';
  }

  // NOW strip: position + gap come straight from the own timing entry
  // (replays feed it too — that is what makes a session re-simulation useful)
  const hasFeed = connected || timing?.conn === 'replay';
  const e = hasFeed ? timing.entries?.find(x => String(x.nr).trim() === nr) || null : null;
  // Feed live and listing the field, but this car's number isn't in it —
  // say so on the feed line instead of quietly showing nothing. A number
  // never posted this session is normal early on (the row can wait for the
  // car's first crossing); one the board knew and dropped is the real alarm.
  if (hasFeed && timing.entries?.length > 0 && !e) {
    if (feedSeen.has(nr)) {
      stateEl.textContent += ` · no car #${nr} in the feed — check the timing number (pit wall settings)`;
      stateEl.className = 'v warn';
    } else {
      stateEl.textContent += ` · waiting on car #${nr} — not in the feed yet`;
    }
  }
  $('now-pos-wrap').hidden = !e || e.pos == null;
  if (e && e.pos != null) {
    $('now-pos').textContent = 'P' + e.pos;
    $('now-gap').textContent = [
      e.gap != null ? fmtGapUs(e.gap) : '',
      e.pic != null && e.cls ? `${e.cls} ${e.pic}` : '',
      e.inPit ? 'IN PIT' : ''
    ].filter(Boolean).join(' · ');
  }

  // Driver recognition: does the feed's driver text agree with the strategy
  // state about who is in the car? A silent driver swap (done on track radio,
  // never logged) is exactly what this catches.
  const feedTag = $('now-driver-feed');
  const rec = e?.driver ? matchTimingDriver(car, e.driver) : null;
  if (rec && rec.id !== car.currentDriverId) {
    feedTag.hidden = false;
    feedTag.className = 'sub drvfeed warn';
    feedTag.innerHTML = `${icon('warn')} feed: ${esc(rec.name)}`;
    feedTag.title = `Live timing shows "${e.driver}" in the car. If the change is real, log it in the stop planner (or the starting-driver setting).`;
  } else if (rec) {
    feedTag.hidden = false;
    feedTag.className = 'sub drvfeed ok';
    feedTag.innerHTML = `${icon('check')} feed`;
    feedTag.title = `Live timing agrees: ${rec.name} ("${e.driver}") is in the car.`;
  } else {
    feedTag.hidden = true;
  }

  renderAround(e);
}

// CONTEXT: the five rows of the field around this car — enough for the
// "are we gaining?" glance without switching to the full scoreboard tab.
function renderAround(own) {
  const body = $('around-body');
  const empty = $('around-empty');
  const entries = timing?.conn === 'connected' || timing?.conn === 'replay'
    ? timing.entries || [] : [];
  if (!entries.length) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.textContent = timing?.conn && !['off', 'connected', 'replay'].includes(timing.conn)
      ? 'Feed ' + timing.conn + '…'
      : 'Live timing is off — connect the feed on the pit wall.';
    return;
  }
  empty.hidden = true;
  const teamNrs = ourTimingNrs(state);
  const i = own ? entries.indexOf(own) : 0;
  const from = Math.max(0, Math.min(i - 2, entries.length - 5));
  body.innerHTML = entries.slice(from, from + 5).map(e => {
    const teamCar = teamNrs.get(String(e.nr).trim());
    const rec = teamCar && e.driver ? matchTimingDriver(teamCar, e.driver) : null;
    return `
    <tr class="${e === own ? 'own' : ''}${teamCar ? ' ours' : ''}${e.inPit ? ' inpit' : ''}">
      <td class="num">${e.pos != null ? 'P' + e.pos : '—'}</td>
      <td class="num">#${esc(e.nr)}</td>
      <td class="drv">${esc(e.driver || e.team || '—')}${rec ? ` <span class="drvtag">${esc(driverAbbrev(rec))}</span>` : ''}</td>
      <td class="num">${fmtGapUs(e.gap)}</td>
      <td class="num">${fmtLapUs(e.lastUs)}</td>
    </tr>`;
  }).join('');
}

// ---- scoreboard tab (full standings, own car highlighted) ----

function renderScoreboard() {
  if (sbView.classList.contains('hidden') || !state) return;
  const car = state.cars[carId];
  if (!car) return;

  const connected = timing?.conn === 'connected' || timing?.conn === 'replay';
  const entries = connected ? timing.entries || [] : [];

  const sess = $('sb-session');
  if (connected) {
    const flag = TIMING_FLAGS[timing.session?.flag];
    sess.textContent = [timing.conn === 'replay' ? 'REPLAY' : null,
      timing.session?.name, flag?.label, entries.length + ' cars',
      timing.session?.rc ? 'RC: ' + timing.session.rc : null]
      .filter(Boolean).join(' · ');
    sess.className = 'ltnr lt-' + (flag?.cls || 'none');
  } else {
    sess.textContent = timing?.conn && timing.conn !== 'off' ? timing.conn : 'feed off';
    sess.className = 'ltnr';
  }

  const empty = $('sb-empty');
  empty.hidden = entries.length > 0;
  if (!empty.hidden) {
    empty.textContent = connected
      ? 'Feed connected — waiting for standings…'
      : 'Live timing is off — connect the feed on the pit wall.';
  }

  // Upstream wall clock, extrapolated from the snapshot's sample so the
  // E.T.A. column keeps counting down between broadcasts.
  const serverNowUs = timing?.serverNowUs != null
    ? timing.serverNowUs + (Date.now() - timingRxMs) * 1000
    : Date.now() * 1000;

  const ownNr = timingNrOf(state.timing || {}, car);
  // Every filled-in car number, not just this station's: the whole team must
  // be findable on the board (the trackmap marks the same set of cars).
  const teamNrs = ourTimingNrs(state);

  // Fastest lap overall and per class: the reference every "is that quick?"
  // read needs, and the only way a lap time column carries meaning at a glance.
  let sessionBest = null;
  const classBest = new Map();
  for (const e of entries) {
    if (!e.bestUs) continue;
    if (sessionBest == null || e.bestUs < sessionBest) sessionBest = e.bestUs;
    const cls = e.cls || '';
    const cur = classBest.get(cls);
    if (cur == null || e.bestUs < cur) classBest.set(cls, e.bestUs);
  }

  // Colour cars by class so the eye can pick out one group in a mixed field.
  const classes = [...new Set(entries.map(e => e.cls || ''))];
  const classIdx = new Map(classes.map((c, i) => [c, i % SB_CLASS_COLORS]));

  let prevCls = null;
  $('sb-body').innerHTML = entries.map(e => {
    const own = String(e.nr).trim() === ownNr;
    const teamCar = teamNrs.get(String(e.nr).trim());
    const ours = !!teamCar;
    // Recognised roster driver for a team car — the abbrev tag on the row is
    // how the wall reads "who is in which of OUR cars" off the standings.
    const rec = teamCar && e.driver ? matchTimingDriver(teamCar, e.driver) : null;
    const cls = e.cls || '';
    const ci = classIdx.get(cls) ?? 0;
    // A rule between class blocks, but only when the feed is class-ordered —
    // in an overall-order field it would fire on nearly every row.
    const classBreak = prevCls != null && cls !== prevCls;
    prevCls = cls;

    const lastCls = lapClass(e.lastUs, e.bestUs, sessionBest, classBest.get(cls));
    const bestCls = lapClass(e.bestUs, null, sessionBest, classBest.get(cls));

    return `<tr class="c${ci}${own ? ' own' : ''}${ours ? ' ours' : ''}${e.inPit ? ' inpit' : ''}${classBreak ? ' clsbreak' : ''}">
      <td class="num pos">${e.pos != null ? e.pos : '—'}</td>
      <td class="num nr">${esc(e.nr)}</td>
      ${sbEtaCell(e, serverNowUs)}
      <td class="team">${esc(e.team || '')}</td>
      <td class="car">${esc(e.car || '')}</td>
      <td class="drv">${own ? icon('play') + ' ' : ''}${esc(e.driver || '—')}${rec ? ` <span class="drvtag">${esc(driverAbbrev(rec))}</span>` : ''}${e.inPit ? ' ' + icon('parking') : ''}</td>
      <td class="cls"><span class="clstag">${esc(cls)}</span></td>
      <td class="num pic">${e.pic != null ? esc(e.pic) : '—'}</td>
      <td class="num gap grp">${fmtGapUs(e.gap)}</td>
      <td class="num int">${fmtGapUs(e.diff)}</td>
      <td class="num lap grp${lastCls}">${fmtLapUs(e.lastUs)}</td>
      <td class="num lap${bestCls}">${fmtLapUs(e.bestUs)}</td>
      <td class="num inlap">${e.bestLap != null ? e.bestLap : '—'}</td>
      <td class="num lap"${e.best2Lap != null ? ` title="set on lap ${e.best2Lap}"` : ''}>${fmtLapUs(e.best2Us)}</td>
      <td class="num sect grp">${fmtSectUs(e.s1)}</td>
      <td class="num sect">${fmtSectUs(e.s2)}</td>
      <td class="num sect">${fmtSectUs(e.s3)}</td>
      <td class="num smk">${e.smarker != null ? esc(e.smarker) : '—'}</td>
      <td class="num laps grp">${e.laps != null ? e.laps : '—'}</td>
      <td class="num pits">${e.pits != null ? e.pits : '—'}</td>
      <td class="num lpit${e.inPit ? ' warn' : ''}">${fmtDurCell(e.lpit, serverNowUs)}</td>
      <td class="num stint${e.inPit ? ' warn' : ''}">${e.inPit ? 'P:' : ''}${fmtDurCell(e.stint, serverNowUs)}</td>
    </tr>`;
  }).join('');
}

const SB_CLASS_COLORS = 5;

// Lap-time emphasis, strongest first: session best (purple, the universal
// motorsport convention), class best (green), then the car's own best (cyan).
function lapClass(us, ownBestUs, sessionBest, clsBest) {
  if (!us) return '';
  if (sessionBest != null && us <= sessionBest) return ' best-session';
  if (clsBest != null && us <= clsBest) return ' best-class';
  if (ownBestUs != null && us <= ownBestUs) return ' best-own';
  return '';
}

// E.T.A. = expected arrival at the line: the "E<epoch µs>" running state gives
// the current lap's start, plus the best lap, minus the server clock. Overdue
// (negative) usually means the car is slow, stopped or heading for the pits.
function sbEtaCell(e, serverNowUs) {
  if (e.inPit) return '<td class="eta warn">In Pit</td>';
  const st = e.state;
  if (typeof st === 'string' && st[0] === 'S') {
    return `<td class="eta dim">${esc(st.slice(1).trim() || '—')}</td>`;
  }
  if (typeof st === 'string' && st[0] === 'E') {
    const lapStartUs = parseInt(st.slice(1), 10);
    const refUs = e.bestUs ?? e.lastUs;
    if (lapStartUs > 0 && refUs) {
      const etaUs = lapStartUs + refUs - serverNowUs;
      const cls = etaUs < 0 ? ' crit' : etaUs < 10e6 ? ' warn' : '';
      return `<td class="eta num${cls}">${fmtEta(etaUs)}</td>`;
    }
  }
  return '<td class="eta">—</td>';
}

function fmtEta(us) {
  const s = Math.round(us / 1e6);
  const a = Math.abs(s);
  return `${s < 0 ? '-' : ''}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function fmtSectUs(us) {
  if (us == null) return '—';
  const sec = us / 1e6;
  return sec >= 60 ? fmtLapUs(us) : sec.toFixed(3);
}

// Last-pit / stint cells use the getraceresults letter-prefix convention:
// "L<µs>" is a frozen duration, "S<µs>"/"E<µs>" a start timestamp on the
// feed's server clock — the duration is still running, so it counts up
// against the extrapolated server time. Plain numbers and preformatted
// "m:ss" strings pass through the magnitude heuristics.
function fmtDurCell(v, serverNowUs) {
  if (v == null || v === '') return '—';
  const s = String(v).trim();
  const m = s.match(/^([A-Za-z])(\d+)$/);
  let us;
  if (m) {
    const n = parseInt(m[2], 10);
    // Anything beyond ~11 days is a server-clock timestamp, not a duration.
    us = m[1] !== 'L' && n > 1e12 ? Math.max(0, serverNowUs - n) : n;
  } else {
    const n = Number(s);
    if (isNaN(n)) return esc(s);
    if (n < 0) return '—';
    us = n < 1000 ? n * 1e6 : n < 1e6 ? n * 1000 : n;
  }
  return fmtMinSec(us / 1000);
}

$('btn-fuel-correct').addEventListener('click', () => {
  const v = parseFloat($('fuel-correct').value);
  if (!isNaN(v)) patchCar({ state: { fuelLiters: v } });
  $('fuel-correct').value = '';
});

// ---- condition selector ----

const condRow = $('cond-row');
for (const c of CONDITIONS) {
  const b = document.createElement('button');
  b.textContent = c.label;
  b.dataset.cond = c.id;
  b.addEventListener('click', () => patchCar({ condition: c.id }));
  condRow.appendChild(b);
}

initConditionControls($('cond-controls'), mode => {
  if (!state) return;
  net.send({ type: 'fcy', mode });
});

// ---- stop planner ----
// The panel is the app's own plan for three situations — green, code 60 and
// safety car — and every line of it either follows the app or is pinned by the
// engineer. Pinning one line never freezes the others: they keep tracking the
// race. Nothing here is a form to fill in; it is an answer to accept or change.

let pickSetOpen = false;  // tyre stock list open under the TYRES line
let pickBrakeOpen = false; // rack list open under the BRAKES line
let fuelSetL = 0;         // last hand-typed fuel figure

const pinStop = (field, value) => send({ type: 'pinStop', field, value });

$('plan-tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-plan]');
  if (!b || !state) return;
  pickSetOpen = false;
  pickBrakeOpen = false;
  send({ type: 'stopPlan', plan: b.dataset.plan });
});

$('plan-lines').addEventListener('click', e => {
  if (!state) return;
  const car = state.cars[carId];

  // a row in the tyre stock list
  const row = e.target.closest('[data-set]');
  if (row) {
    pickSetOpen = false;
    pinStop('tyres', row.dataset.set);
    return render();
  }

  // a row in the brake rack — one component group's numbered set. The list
  // stays open: a stop often changes more than one group.
  const brow = e.target.closest('[data-bset]');
  if (brow) {
    const [comp, setId] = brow.dataset.bset.split(':');
    const pin = { ...(car.nextStop.pinned?.brakeSets || {}) };
    // Tapping the set already chosen hands the pick back to the app.
    if (pin[comp] === setId) delete pin[comp];
    else pin[comp] = setId;
    pinStop('brakeSets', Object.keys(pin).length ? pin : null);
    return render();
  }

  const opt = e.target.closest('[data-pin]');
  if (!opt) return;
  const field = opt.dataset.pin;
  const val = opt.dataset.val;

  if (field === 'fuel') {
    pickSetOpen = pickBrakeOpen = false;
    if (val === 'auto') pinStop('fuel', null);
    else if (val === 'set') {
      fuelSetL = fuelSetL || Math.round(car.config.tankLiters || 0);
      pinStop('fuel', { mode: 'set', liters: fuelSetL });
    } else pinStop('fuel', { mode: val });
  } else if (field === 'tyres') {
    if (val === 'pick') {
      pickSetOpen = !pickSetOpen;
      pickBrakeOpen = false;
      return render();
    }
    pickSetOpen = false;
    pinStop('tyres', val === 'auto' ? null : val);
  } else if (field === 'driver') {
    pickSetOpen = pickBrakeOpen = false;
    pinStop('driver', val === 'auto' ? null : val);
  } else if (field === 'brakes') {
    if (val === 'pick') {
      pickBrakeOpen = !pickBrakeOpen;
      pickSetOpen = false;
      return render();
    }
    pickSetOpen = false;
    // Handing a line back to the app hands its part numbers back too.
    if (val === 'auto') { pinStop('brakeSets', null); return pinStop('brakes', null); }
    if (val === 'none') { pinStop('brakeSets', null); return pinStop('brakes', []); }
    // toggle one component, starting from whatever is currently planned
    const cur = car.nextStop.pinned?.brakes || plannedBrakes(car);
    const next = cur.includes(val) ? cur.filter(x => x !== val) : [...cur, val];
    // A component no longer being changed has no set to pick.
    const pin = { ...(car.nextStop.pinned?.brakeSets || {}) };
    if (!next.includes(val) && pin[val]) {
      delete pin[val];
      pinStop('brakeSets', Object.keys(pin).length ? pin : null);
    }
    pinStop('brakes', next);
  }
  render();
});

// the hand-typed fuel figure
$('plan-lines').addEventListener('change', e => {
  const inp = e.target.closest('input[data-fuelset]');
  if (!inp || !state) return;
  const tank = state.cars[carId].config.tankLiters || 0;
  fuelSetL = Math.max(0, Math.min(tank, Math.round(parseFloat(inp.value) || 0)));
  pinStop('fuel', { mode: 'set', liters: fuelSetL });
});

$('stop-notes').addEventListener('change', () => patchStop({ notes: $('stop-notes').value }));

// What the feed decided about the last pit-lane visit: take it back, or tell
// the app it was a stop after all.
$('pit-visit').addEventListener('click', e => {
  // brake toggles inside the correction form flip in place
  const bk = e.target.closest('[data-fixbrake]');
  if (bk) return bk.classList.toggle('on');

  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'undo') send({ type: 'undoStop' });
  else if (act === 'apply') send({ type: 'applyStop' });
  else if (act === 'confirm') send({ type: 'confirmStop' });
  else if (act === 'dispute') send({ type: 'disputeStop' });
  else if (act === 'cancel') { pitVisitKey = ''; send({ type: 'undisputeStop' }); }
  else if (act === 'save') {
    const el = $('pit-visit');
    const val = k => el.querySelector(`[data-fix="${k}"]`)?.value ?? '';
    const setId = val('tyres');
    const service = {
      fuelLiters: Math.max(0, parseFloat(val('fuel')) || 0),
      tyres: !!setId,
      tyreSetId: setId || null,
      driverChange: val('driver') || null
    };
    service.brakeSetIds = {};
    for (const bb of el.querySelectorAll('[data-fixbrake]')) {
      const comp = bb.dataset.fixbrake;
      service[comp] = bb.classList.contains('on');
      // Only a group that really was changed carries a part number.
      const sel = el.querySelector(`[data-fixbset="${comp}"]`);
      service.brakeSetIds[comp] = service[comp] ? (sel?.value || null) : null;
    }
    send({ type: 'correctStop', service });
  }
  else send({ type: 'dismissPitVisit' });
});

// The approval tick: "I have read this and it is the plan." It is the only
// thing that turns the wall card from the app talking into something the crew
// lays parts out for, and it clears itself if the plan moves afterwards.
$('plan-approve').addEventListener('click', e => {
  const b = e.target.closest('button[data-approve]');
  if (!b) return;
  send({ type: b.dataset.approve === 'yes' ? 'approveStop' : 'unapproveStop' });
});

// Lifecycle. The engineer owns SEND and BOX BOX; after that the timing feed
// stages the stop (pit entry / pit exit), and these buttons are the fallback
// for a dead feed.
$('stop-actions').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b || !state) return;
  const car = state.cars[carId];
  switch (b.dataset.act) {
    case 'send': patchStop({ status: 'sent' }); break;
    case 'box': patchStop({ status: 'box' }); break;
    case 'unsend': patchStop({ status: 'draft' }); break;
    case 'clear': patchCar({ nextStop: emptyStop() }); break;
    case 'inpit': send({ type: 'inPit', inPit: true }); break;
    case 'ontrack':
      if (confirm('Mark the car back on track WITHOUT a stop? No service is applied and the fuel level is not reset (drive-through).')) {
        send({ type: 'inPit', inPit: false });
      }
      break;
    case 'done': {
      if (car.nextStop.status === 'draft') return;
      const fuelTo = Number(car.nextStop.fuelLiters) || 0;
      const detail = fuelTo > 0 ? `Fuel is reset to ${fuelTo} L on board.` : 'No refuelling — fuel level stays as is.';
      if (confirm(`Confirm the stop is complete and the car released? ${detail}`)) send({ type: 'applyStop' });
      break;
    }
  }
});

// ---- settings modal ----

const overlay = $('settings-overlay');
$('btn-settings').addEventListener('click', () => overlay.classList.remove('hidden'));
$('btn-settings-close').addEventListener('click', () => overlay.classList.add('hidden'));
overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });

// settings tabs
const tabbar = $('settings-tabs');
function showTab(tab) {
  for (const b of tabbar.children) b.classList.toggle('on', b.dataset.tab === tab);
  for (const sec of overlay.querySelectorAll('[data-pane]')) sec.hidden = sec.dataset.pane !== tab;
}
tabbar.addEventListener('click', e => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) showTab(btn.dataset.tab);
});
showTab('car');

// Every input/select with data-path patches that field on the car when changed.
for (const inp of overlay.querySelectorAll('input[data-path], select[data-path]')) {
  inp.addEventListener('change', () => {
    const val = inp.type === 'number' ? parseFloat(inp.value) : inp.value;
    if (inp.type === 'number' && isNaN(val)) return;
    const parts = inp.dataset.path.split('.');
    const patch = {};
    let node = patch;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] = {};
    node[parts[parts.length - 1]] = val;
    patchCar(patch);
  });
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function patchDriver(idx, field, value) {
  const drivers = state.cars[carId].drivers.map(d => ({ ...d }));
  drivers[idx][field] = value;
  patchCar({ drivers });
}

// ---- race start (starting fuel / starting driver) ----

// Empty or 0 means "full tank"; the model resolves that, so an empty box is
// stored as 0 rather than as the current tank size (which would silently stop
// tracking the tank setting).
$('start-fuel').addEventListener('change', () => {
  if (!state) return;
  const raw = $('start-fuel').value.trim();
  const v = raw === '' ? 0 : parseFloat(raw);
  if (isNaN(v) || v < 0) return;
  const tank = state.cars[carId].config.tankLiters;
  patchCar({ config: { startFuelL: Math.min(v, tank) } });
});

$('start-driver').addEventListener('change', () => {
  if (!state) return;
  const car = state.cars[carId];
  const id = $('start-driver').value;
  if (!id || id === car.currentDriverId) return;
  // Mid-race this is not a "starting" driver any more: the seat time of the
  // running stint would be credited to whoever is selected here. A driver
  // change during the race belongs in the stop planner.
  if (raceClock(state.race, Date.now()).running) {
    const ok = confirm(
      'The race has already started. Changing the driver here credits the whole current stint to the new driver and does not log a pit stop.\n\n' +
      'For a normal driver change use DRIVER in the stop planner. Continue anyway?'
    );
    if (!ok) return renderStartDriver(car);
  }
  patchCar({ currentDriverId: id });
});

let startDriverKey = '';
function renderStartDriver(car) {
  const sel = $('start-driver');
  const key = car.drivers.map(d => `${d.id}:${d.name}`).join('|');
  if (key !== startDriverKey) {
    startDriverKey = key;
    sel.innerHTML = car.drivers
      .map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`)
      .join('');
  }
  sel.value = car.currentDriverId;

  const running = state && raceClock(state.race, Date.now()).running;
  const note = $('start-driver-note');
  note.textContent = running
    ? 'Race running — use DRIVER in the stop planner for a normal driver change.'
    : '';
  note.classList.toggle('warn', !!running);
}

$('btn-drv-add').addEventListener('click', () => {
  if (!state) return;
  const car = state.cars[carId];
  let n = car.drivers.length + 1;
  while (car.drivers.some(d => d.id === 'd' + n)) n++;
  const drivers = [...car.drivers, defaultDriver(n)];
  const patch = { drivers };
  // First driver added to an empty list becomes the driver in the car.
  if (!car.drivers.some(d => d.id === car.currentDriverId)) {
    patch.currentDriverId = drivers[0].id;
  }
  patchCar(patch);
});

function removeDriver(i) {
  const car = state.cars[carId];
  const d = car.drivers[i];
  if (d.id === car.currentDriverId) {
    return alert(`${d.name} is in the car — switch drivers before removing them.`);
  }
  if (!confirm(`Remove ${d.name}? Their logged seat time is lost.`)) return;
  const patch = { drivers: car.drivers.filter((_, j) => j !== i) };
  if (car.nextStop.driverChange === d.id) patch.nextStop = { driverChange: null };
  patchCar(patch);
}

let builtDriverCount = -1;
function buildDriverTable(car) {
  const body = $('drv-table-body');
  body.innerHTML = '';
  car.drivers.forEach((d, i) => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.dataset.drvName = i;
    nameInp.addEventListener('change', () =>
      patchDriver(i, 'name', nameInp.value.trim() || `Driver ${i + 1}`));
    nameTd.appendChild(nameInp);
    tr.appendChild(nameTd);

    const abbrTd = document.createElement('td');
    const abbrInp = document.createElement('input');
    abbrInp.type = 'text';
    abbrInp.className = 'abbr';
    abbrInp.maxLength = 4;
    abbrInp.dataset.drvAbbr = i;
    abbrInp.addEventListener('change', () =>
      patchDriver(i, 'abbrev', abbrInp.value.trim().toUpperCase()));
    abbrTd.appendChild(abbrInp);
    tr.appendChild(abbrTd);

    const tnTd = document.createElement('td');
    const tnInp = document.createElement('input');
    tnInp.type = 'text';
    tnInp.className = 'tname';
    tnInp.placeholder = '= name';
    tnInp.title = 'The driver name exactly as the timing feed prints it (a surname is enough)';
    tnInp.dataset.drvTname = i;
    tnInp.addEventListener('change', () =>
      patchDriver(i, 'timingName', tnInp.value.trim()));
    tnTd.appendChild(tnInp);
    tr.appendChild(tnTd);

    for (const field of ['doubleStint', 'night', 'rain']) {
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'flag';
      btn.dataset.drvFlag = `${i}.${field}`;
      btn.addEventListener('click', () =>
        patchDriver(i, field, !state.cars[carId].drivers[i][field]));
      td.appendChild(btn);
      tr.appendChild(td);
    }

    for (const field of ['fuelDry', 'fuelWet']) {
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = 'any';
      inp.min = '0';
      inp.placeholder = 'default';
      inp.dataset.drvFuel = `${i}.${field}`;
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        patchDriver(i, field, isNaN(v) || v < 0 ? 0 : v);
      });
      td.appendChild(inp);
      tr.appendChild(td);
    }

    const rmTd = document.createElement('td');
    const rmBtn = document.createElement('button');
    rmBtn.className = 'flag';
    rmBtn.innerHTML = icon('x');
    rmBtn.title = 'remove driver';
    rmBtn.addEventListener('click', () => removeDriver(i));
    rmTd.appendChild(rmBtn);
    tr.appendChild(rmTd);

    body.appendChild(tr);
  });
  builtDriverCount = car.drivers.length;
}

// ---- fuel vs lap time curves ----

// Lap time entry accepts both "1:52.4" and plain seconds, since engineers read
// lap times in mm:ss off the timing screen but think in seconds when tuning.
function parseLapInput(str) {
  const s = String(str).trim().replace(',', '.');
  if (!s) return 0;
  const m = s.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  const v = parseFloat(s);
  return isNaN(v) || v < 0 ? 0 : v;
}

function patchCurve(idx, points) {
  patchDriver(idx, 'fuelCurve', normalizeCurve(points));
}

function curvePointsOf(car, i) {
  return Array.isArray(car.drivers[i]?.fuelCurve) ? car.drivers[i].fuelCurve : [];
}

function addCurvePoint(i) {
  const pts = [...curvePointsOf(state.cars[carId], i)];
  const car = state.cars[carId];
  // Seed a new row from the car's dry figures so the engineer edits a
  // plausible point instead of two zeroes.
  const last = pts[pts.length - 1];
  const p = emptyCurvePoint();
  p.lapSec = last ? +(last.lapSec + 2).toFixed(3) : (car.config.avgLapSec?.dry || 100);
  p.fuelL = last ? last.fuelL : (car.config.burnPerLap?.dry || 0);
  patchCurve(i, [...pts, p]);
}

function removeCurvePoint(i, j) {
  patchCurve(i, curvePointsOf(state.cars[carId], i).filter((_, k) => k !== j));
}

// Rebuilt whenever the driver names or the number of points change; the
// wrapper is cheap and this keeps input focus stable during a race.
let curveKey = '';
function renderFuelCurves(car, c) {
  const wrap = $('fuel-curve-editors');
  if (!wrap) return;
  const key = car.drivers
    .map(d => `${d.id}:${d.name}:${(d.fuelCurve || []).length}`)
    .join('|') + '|' + car.config.fuelModel;
  const rebuild = key !== curveKey;
  if (rebuild) {
    curveKey = key;
    wrap.innerHTML = '';
    car.drivers.forEach((d, i) => {
      const box = document.createElement('div');
      box.className = 'curve-box';
      box.dataset.curveBox = i;

      const head = document.createElement('div');
      head.className = 'curve-head';
      head.innerHTML =
        `<span class="nm">${esc(d.name)}</span><span class="meta" data-curve-meta="${i}"></span>`;
      box.appendChild(head);

      const pts = normalizeCurve(d.fuelCurve);
      if (pts.length) {
        const table = document.createElement('table');
        table.className = 'curve-table';
        table.innerHTML =
          '<thead><tr><th>Lap time</th><th>Fuel (L/lap)</th><th></th></tr></thead>';
        const tb = document.createElement('tbody');
        pts.forEach((p, j) => {
          const tr = document.createElement('tr');

          const lapTd = document.createElement('td');
          const lapInp = document.createElement('input');
          lapInp.type = 'text';
          lapInp.value = fmtLap(p.lapSec);
          lapInp.title = 'mm:ss.s or seconds';
          lapInp.addEventListener('change', () => {
            const next = [...curvePointsOf(state.cars[carId], i)];
            if (!next[j]) return;
            next[j] = { ...next[j], lapSec: parseLapInput(lapInp.value) };
            patchCurve(i, next);
          });
          lapTd.appendChild(lapInp);
          tr.appendChild(lapTd);

          const fuelTd = document.createElement('td');
          const fuelInp = document.createElement('input');
          fuelInp.type = 'number';
          fuelInp.step = 'any';
          fuelInp.min = '0';
          fuelInp.value = p.fuelL;
          fuelInp.addEventListener('change', () => {
            const next = [...curvePointsOf(state.cars[carId], i)];
            if (!next[j]) return;
            const v = parseFloat(String(fuelInp.value).replace(',', '.'));
            next[j] = { ...next[j], fuelL: isNaN(v) || v < 0 ? 0 : v };
            patchCurve(i, next);
          });
          fuelTd.appendChild(fuelInp);
          tr.appendChild(fuelTd);

          const rmTd = document.createElement('td');
          const rm = document.createElement('button');
          rm.className = 'flag';
          rm.innerHTML = icon('x');
          rm.title = 'remove point';
          rm.addEventListener('click', () => removeCurvePoint(i, j));
          rmTd.appendChild(rm);
          tr.appendChild(rmTd);

          tb.appendChild(tr);
        });
        table.appendChild(tb);
        box.appendChild(table);
      } else {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = 'No points — this driver falls back to their average consumption.';
        box.appendChild(p);
      }

      const add = document.createElement('button');
      add.className = 'primary curve-add';
      add.innerHTML = icon('plus') + ' ADD POINT';
      add.addEventListener('click', () => addCurvePoint(i));
      box.appendChild(add);

      wrap.appendChild(box);
    });
  }

  // Live readout per driver: what the curve says at the current reference lap.
  const ref = c?.refLapSec;
  car.drivers.forEach((d, i) => {
    const meta = wrap.querySelector(`[data-curve-meta="${i}"]`);
    if (!meta) return;
    const pts = normalizeCurve(d.fuelCurve);
    if (!pts.length) { meta.textContent = ''; meta.className = 'meta'; return; }
    const range = `${fmtLap(pts[0].lapSec)} – ${fmtLap(pts[pts.length - 1].lapSec)}`;
    if (d.id === car.currentDriverId && ref > 0) {
      const at = burnAtLapTime(pts, ref);
      const outside = ref < pts[0].lapSec || ref > pts[pts.length - 1].lapSec;
      meta.textContent =
        `IN CAR · ${range} · at ${fmtLap(ref)} → ${at.toFixed(2)} L/lap${outside ? ' (held flat)' : ''}`;
      meta.className = 'meta' + (outside ? ' warn' : ' good');
    } else {
      meta.textContent = range;
      meta.className = 'meta';
    }
  });
}

// What the fuel model is actually doing right now — which rate is in use, from
// where, and at what lap time. Makes a silent fallback (driver has no curve
// points) visible instead of leaving the engineer to wonder.
function renderFuelModelStatus(car, c) {
  const el = $('fuel-model-live');
  if (!el) return;
  if (!c?.burnInfo) { el.innerHTML = ''; return; }
  const info = c.burnInfo;
  const drv = car.drivers.find(d => d.id === car.currentDriverId);
  const laptimeModel = car.config.fuelModel === 'driver-laptime';

  const srcLabel = {
    fcy: 'car FCY / Code 60 rate',
    sc: 'car Safety Car rate',
    stopped: 'field stopped — no burn',
    curve: `${drv ? esc(drv.name) : 'driver'} lap-time curve`,
    driver: `${drv ? esc(drv.name) : 'driver'} average`,
    car: 'car default'
  }[info.source] || info.source;

  // Lives in the fuel panel, directly under the burn row that shows the rate
  // itself — so only the source and its caveats are repeated here.
  const rows = [
    `<div class="kv"><span class="k">Model</span><span class="v">${srcLabel}</span></div>`
  ];
  if (info.source === 'curve') {
    rows.push(
      `<div class="kv"><span class="k">Read at lap time</span><span class="v">${fmtLap(info.lapSec)}${
        car.state.avgLapSecLive > 0 ? ` (avg of last ${LAP_AVG_WINDOW})` : ' (configured average)'
      }</span></div>`);
    if (info.clamped) {
      rows.push(
        `<div class="kv"><span class="k">Outside the table</span><span class="v warn">held flat at the nearest point — add a row near this lap time</span></div>`);
    }
  } else if (laptimeModel && !['fcy', 'sc', 'stopped'].includes(info.source)) {
    rows.push(
      `<div class="kv"><span class="k">Lap-time model idle</span><span class="v warn">${
        drv ? esc(drv.name) : 'this driver'
      } has no curve points — using the fallback above</span></div>`);
  }
  el.innerHTML = rows.join('');
}

function renderSettings(car, c) {
  for (const inp of overlay.querySelectorAll('input[data-path], select[data-path]')) {
    setInput(inp, getPath(car, inp.dataset.path) ?? '');
  }
  if (builtDriverCount !== car.drivers.length) buildDriverTable(car);
  // Tyre life is entered in km; say what that is in laps here so the setting
  // can be sanity-checked against a stint without doing the division.
  const lifeEl = $('tyrelife-laps');
  if (lifeEl) {
    const km = car.config.tyreLifeKm || 0;
    lifeEl.textContent = km > 0 && car.config.trackKm > 0
      ? `${km} km = ${tyreLifeLapsOf(car)} laps at ${car.config.trackKm} km`
      : `no km set — falling back to ${tyreLifeLapsOf(car)} laps`;
  }
  setInput($('start-fuel'), car.config.startFuelL > 0 ? car.config.startFuelL : '');
  renderStartDriver(car);
  car.drivers.forEach((d, i) => {
    const nameInp = overlay.querySelector(`input[data-drv-name="${i}"]`);
    if (nameInp) setInput(nameInp, d.name);
    const abbrInp = overlay.querySelector(`input[data-drv-abbr="${i}"]`);
    if (abbrInp) {
      setInput(abbrInp, d.abbrev || '');
      abbrInp.placeholder = driverAbbrev(d);
    }
    const tnInp = overlay.querySelector(`input[data-drv-tname="${i}"]`);
    if (tnInp) setInput(tnInp, d.timingName || '');
    for (const field of ['doubleStint', 'night', 'rain']) {
      const btn = overlay.querySelector(`button[data-drv-flag="${i}.${field}"]`);
      if (btn) {
        const on = !!d[field];
        btn.textContent = on ? 'YES' : 'NO';
        btn.className = 'flag' + (on ? ' on' : '');
      }
    }
    for (const field of ['fuelDry', 'fuelWet']) {
      const inp = overlay.querySelector(`input[data-drv-fuel="${i}.${field}"]`);
      if (inp) setInput(inp, d[field] > 0 ? d[field] : '');
    }
  });

  renderFuelCurves(car, c);
  renderFuelModelStatus(car, c);
  renderTyreSets(car);
  renderBrakeSets(car);
  renderLearned(car);

  // Event settings readout (edited on the pit wall, same for every car)
  const ev = state.event || car.config;
  const pl = pitLaneCalc(car);
  const regFmt = min => (min > 0 ? fmtH(min / 60) : 'not enforced');
  $('event-info').innerHTML = `
    <div class="kv"><span class="k">Track length</span><span class="v">${ev.trackKm ?? '—'} km</span></div>
    <div class="kv"><span class="k">FCY / Code-60 speed</span><span class="v">${ev.fcySpeedKmh ?? '—'} km/h</span></div>
    <div class="kv"><span class="k">Pit lane speed limit</span><span class="v">${ev.pitSpeedKmh ?? '—'} km/h</span></div>
    <div class="kv"><span class="k">Pit lane length</span><span class="v">${ev.pitLaneKm ?? '—'} km</span></div>
    ${pl ? `<div class="kv"><span class="k">Pit lane transit at the limit</span><span class="v">${pl.transitSec.toFixed(1)} s</span></div>` : ''}
    <div class="kv"><span class="k">Pit lane loss</span><span class="v">${ev.pitLossSec ?? '—'} s</span></div>
    <div class="kv"><span class="k">Refuel pump speed</span><span class="v">${ev.refuelLps ?? '—'} L/s</span></div>
    <div class="kv"><span class="k">Max stint</span><span class="v">${ev.maxStintMin ?? '—'} min</span></div>
    <div class="kv"><span class="k">Max drive per rolling 6 h</span><span class="v">${regFmt(ev.reg6hMin)}</span></div>
    <div class="kv"><span class="k">Max drive whole race</span><span class="v">${regFmt(ev.regTotalMin)}</span></div>
    <div class="kv"><span class="k">Min rest between stints</span><span class="v">${ev.regRestMin > 0 ? ev.regRestMin + ' min' : 'not enforced'}</span></div>`;

  renderPresets();
}

// ---- setup presets ----

$('btn-preset-save').addEventListener('click', () => {
  const name = $('preset-name').value.trim();
  if (!name) return alert('Give the preset a name first.');
  if (state?.presets?.[name] && !confirm(`Preset "${name}" exists — overwrite it?`)) return;
  send({ type: 'savePreset', name });
  $('preset-name').value = '';
});

let presetListKey = '';
function renderPresets() {
  const presets = state?.presets || {};
  const key = Object.entries(presets).map(([n, p]) => n + p.savedMs).join('|');
  if (key === presetListKey) return;
  presetListKey = key;
  const wrap = $('preset-list');
  const names = Object.keys(presets).sort();
  wrap.innerHTML = names.length ? '' : '<p class="hint">No presets saved yet.</p>';
  for (const name of names) {
    const p = presets[name];
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.innerHTML = `
      <span class="nm">${name.replace(/</g, '&lt;')}</span>
      <span class="meta">${[p.make, p.model].filter(Boolean).join(' ') || ''} · saved ${new Date(p.savedMs).toLocaleString()}</span>
      <button data-act="load" class="primary">LOAD</button>
      <button data-act="del" class="danger">${icon('x')}</button>`;
    row.querySelector('[data-act="load"]').addEventListener('click', () => {
      if (confirm(`Load preset "${name}" into this car? Current settings are overwritten (driver seat time is kept).`)) {
        send({ type: 'loadPreset', name });
      }
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (confirm(`Delete preset "${name}"?`)) send({ type: 'deletePreset', name });
    });
    wrap.appendChild(row);
  }
}

// ---- tyre set manager ----

function patchTyreSets(sets) {
  patchCar({ tyreSets: sets, config: { tyreSets: sets.length } });
}

$('btn-tyreset-add').addEventListener('click', () => {
  if (!state) return;
  const sets = state.cars[carId].tyreSets || [];
  let n = sets.length + 1;
  while (sets.some(t => t.id === 't' + n)) n++;
  patchTyreSets([...sets.map(t => ({ ...t })), { id: 't' + n, name: 'S' + n, laps: 0, used: false }]);
});

// Why a set gets binned. Picking the reason IS the confirmation step — a
// single destructive button next to a laps field is too easy to hit at 03:00,
// and "why" is the thing worth having in the log afterwards.
const SCRAP_REASONS = ['worn out', 'flat spot', 'damage', 'wrong compound'];
let scrapAsk = null; // id of the set whose reason strip is open

let tyreSetKey = '';
function renderTyreSets(car) {
  const wrap = $('tyreset-list');
  if (!wrap) return;
  const sets = car.tyreSets || [];
  const curId = car.state.currentTyreSetId;
  const key = sets.map(t => `${t.id}:${t.name}:${t.laps}:${t.km}:${t.kmFcy}:${t.used}:${t.scrapped}:${t.scrapReason}`).join('|') +
    `|${curId}:${car.state.tyreLapsOnSet}|${scrapAsk}`;
  if (key === tyreSetKey) return;
  tyreSetKey = key;
  wrap.innerHTML = sets.length ? '' : '<p class="hint">No sets — press ADD SET.</p>';
  sets.forEach((t, i) => {
    const onCar = t.id === curId;
    const mil = tyreSetMileage(t);
    const row = document.createElement('div');
    row.className = 'preset-row' + (onCar ? ' oncar' : '') + (t.scrapped ? ' isscrapped' : '');
    const pill = t.scrapped ? ['scrapped', 'SCRAPPED']
      : onCar ? ['oncar', 'ON CAR']
      : t.used ? ['', 'USED'] : ['new', 'NEW'];
    const laps = onCar ? car.state.tyreLapsOnSet : t.laps;
    row.innerHTML = `
      <input data-set-name type="text" style="width:90px" />
      <span class="setpill ${pill[0]}">${pill[1]}</span>
      <span class="meta">laps <input data-set-laps type="number" min="0" step="1" style="width:60px" ${onCar ? 'disabled title="live — counted in the tyre panel"' : ''} /></span>
      <span class="km" title="Mileage banked on this set — the yellow part was driven under a neutralisation">${
        mil.km.toFixed(0)} km${mil.kmFcy > 0 ? ` <em>(${mil.kmFcy.toFixed(0)} yellow)</em>` : ''}</span>
      <span class="meta">${t.scrapped && t.scrapReason ? esc(t.scrapReason) : ''}</span>
      <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
        ${t.scrapped
          ? `<button data-act="restore">RESTORE</button>`
          : `<button data-act="scrap" ${onCar ? 'disabled title="the set on the car has to come off first"' : ''}>SCRAP…</button>`}
        <button data-act="del" class="danger" ${onCar || t.used ? 'disabled title="only never-used sets can be removed"' : ''}>${icon('x')}</button>
      </span>`;
    const nameInp = row.querySelector('[data-set-name]');
    nameInp.value = t.name;
    nameInp.addEventListener('change', () => {
      const next = sets.map(x => ({ ...x }));
      next[i].name = nameInp.value.trim() || t.name;
      patchTyreSets(next);
    });
    const lapsInp = row.querySelector('[data-set-laps]');
    lapsInp.value = laps;
    lapsInp.addEventListener('change', () => {
      const v = parseInt(lapsInp.value, 10);
      const next = sets.map(x => ({ ...x }));
      next[i].laps = isNaN(v) || v < 0 ? 0 : v;
      next[i].used = next[i].used || next[i].laps > 0;
      patchTyreSets(next);
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (onCar || t.used) return;
      patchTyreSets(sets.filter((_, j) => j !== i));
    });
    row.querySelector('[data-act="scrap"]')?.addEventListener('click', () => {
      scrapAsk = scrapAsk === t.id ? null : t.id;
      tyreSetKey = '';
      renderTyreSets(state.cars[carId]);
    });
    row.querySelector('[data-act="restore"]')?.addEventListener('click', () =>
      send({ type: 'tyreSetDecision', setId: t.id, scrapped: false }));
    wrap.appendChild(row);

    // Second step: the reason strip. Nothing is binned until one is picked.
    if (scrapAsk === t.id && !t.scrapped) {
      const ask = document.createElement('div');
      ask.className = 'preset-row';
      ask.innerHTML = `<span class="meta">Scrap ${esc(t.name)} — ${laps} laps · ${mil.km.toFixed(0)} km. Why?</span>` +
        `<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">` +
        SCRAP_REASONS.map(r => `<button data-why="${r}">${r.toUpperCase()}</button>`).join('') +
        `<button data-why="">CANCEL</button></span>`;
      for (const b of ask.querySelectorAll('[data-why]')) {
        b.addEventListener('click', () => {
          const why = b.dataset.why;
          scrapAsk = null;
          tyreSetKey = '';
          if (why) send({ type: 'tyreSetDecision', setId: t.id, scrapped: true, reason: why });
          else renderTyreSets(state.cars[carId]);
        });
      }
      wrap.appendChild(ask);
    }
  });
}

// ---- brake set manager ----
// One numbered pool per component group, laid out exactly like the tyre sets:
// front discs together, rear discs together, front pads, rear pads.

function patchBrakeSets(comp, sets) {
  patchCar({ brakeSets: { [comp]: sets }, config: { brakeSets: { [comp]: sets.length } } });
}

let brakeScrapAsk = null; // `${comp}:${setId}` of the set whose reason strip is open

let brakeSetKey = '';
function renderBrakeSets(car) {
  const wrap = $('brakeset-list');
  if (!wrap) return;
  const cur = car.state.currentBrakeSetId || {};
  const key = BRAKE_COMPONENTS.map(b => b.id + '=' + brakeSetsOf(car, b.id)
    .map(t => `${t.id}:${t.name}:${t.hours}:${t.used}:${t.scrapped}:${t.scrapReason}`).join('|') +
    `@${cur[b.id]}:${(car.state.brakeUsedH || {})[b.id]}`).join('/') + `|${brakeScrapAsk}`;
  if (key === brakeSetKey) return;
  brakeSetKey = key;
  wrap.innerHTML = '';

  for (const b of BRAKE_COMPONENTS) {
    const sets = brakeSetsOf(car, b.id);
    const head = document.createElement('div');
    head.className = 'axlehead';
    head.textContent = b.label;
    wrap.appendChild(head);

    sets.forEach((t, i) => {
      const onCar = t.id === cur[b.id];
      const hours = brakeSetHours(car, b.id, t);
      const row = document.createElement('div');
      row.className = 'preset-row' + (onCar ? ' oncar' : '') + (t.scrapped ? ' isscrapped' : '');
      const pill = t.scrapped ? ['scrapped', 'SCRAPPED']
        : onCar ? ['oncar', 'ON CAR']
        : t.used ? ['', 'USED'] : ['new', 'NEW'];
      row.innerHTML = `
        <input data-bset-name type="text" style="width:90px" title="the number written on the part" />
        <span class="setpill ${pill[0]}">${pill[1]}</span>
        <span class="meta">hours <input data-bset-hours type="number" min="0" step="0.1" style="width:60px" ${
          onCar ? 'disabled title="live — counted in the brake panel"' : ''} /></span>
        <span class="km">${fmtH(hours)}</span>
        <span class="meta">${t.scrapped && t.scrapReason ? esc(t.scrapReason) : ''}</span>
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
          ${t.scrapped
            ? `<button data-act="restore">RESTORE</button>`
            : `<button data-act="scrap" ${onCar ? 'disabled title="the part on the car has to come off first"' : ''}>SCRAP…</button>`}
          <button data-act="del" class="danger" ${onCar || t.used ? 'disabled title="only never-used sets can be removed"' : ''}>${icon('x')}</button>
        </span>`;
      const nameInp = row.querySelector('[data-bset-name]');
      nameInp.value = t.name;
      nameInp.addEventListener('change', () => {
        const next = sets.map(x => ({ ...x }));
        next[i].name = nameInp.value.trim() || t.name;
        patchBrakeSets(b.id, next);
      });
      const hInp = row.querySelector('[data-bset-hours]');
      hInp.value = +hours.toFixed(2);
      hInp.addEventListener('change', () => {
        const v = parseFloat(hInp.value);
        const next = sets.map(x => ({ ...x }));
        next[i].hours = isNaN(v) || v < 0 ? 0 : +v.toFixed(4);
        next[i].used = next[i].used || next[i].hours > 0;
        patchBrakeSets(b.id, next);
      });
      row.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (onCar || t.used) return;
        patchBrakeSets(b.id, sets.filter((_, j) => j !== i));
      });
      row.querySelector('[data-act="scrap"]')?.addEventListener('click', () => {
        const k = `${b.id}:${t.id}`;
        brakeScrapAsk = brakeScrapAsk === k ? null : k;
        brakeSetKey = '';
        renderBrakeSets(state.cars[carId]);
      });
      row.querySelector('[data-act="restore"]')?.addEventListener('click', () =>
        send({ type: 'brakeSetDecision', comp: b.id, setId: t.id, scrapped: false }));
      wrap.appendChild(row);

      // Second step: the reason strip. Nothing is binned until one is picked.
      if (brakeScrapAsk === `${b.id}:${t.id}` && !t.scrapped) {
        const ask = document.createElement('div');
        ask.className = 'preset-row';
        ask.innerHTML = `<span class="meta">Scrap ${esc(t.name)} — ${fmtH(hours)}. Why?</span>` +
          `<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">` +
          BRAKE_SCRAP_REASONS.map(r => `<button data-why="${r}">${r.toUpperCase()}</button>`).join('') +
          `<button data-why="">CANCEL</button></span>`;
        for (const btn of ask.querySelectorAll('[data-why]')) {
          btn.addEventListener('click', () => {
            const why = btn.dataset.why;
            brakeScrapAsk = null;
            brakeSetKey = '';
            if (why) send({ type: 'brakeSetDecision', comp: b.id, setId: t.id, scrapped: true, reason: why });
            else renderBrakeSets(state.cars[carId]);
          });
        }
        wrap.appendChild(ask);
      }
    });
  }
}

const BRAKE_SCRAP_REASONS = ['worn out', 'cracked', 'damage', 'glazed'];

// The correction: the same four lines as the plan, filled in with what was
// applied, for the engineer to change into what the crew actually did.
function correctForm(car) {
  const h = car.stintHistory[car.stintHistory.length - 1] || {};
  const svc = h.service || {};
  const sets = (car.tyreSets || []).filter(t => !t.scrapped);
  const fittedId = car.state.currentTyreSetId;
  const prevDrvId = h.driverId; // who was in the car before the stop
  return `<span class="correctform">
    <label>FUEL LEFT WITH <input data-fix="fuel" type="number" min="0" step="1"
      value="${Math.round(Number(svc.fuelLiters) || 0)}" title="0 = no fuel was taken"></label>
    <label>TYRES <select data-fix="tyres">
      <option value="">not changed</option>
      ${sets.map(t => `<option value="${t.id}" ${svc.tyres && t.id === fittedId ? 'selected' : ''}>fitted ${esc(t.name)}</option>`).join('')}
    </select></label>
    <label>DRIVER <select data-fix="driver">
      <option value="">no change${prevDrvId ? ' — ' + esc(car.drivers.find(d => d.id === prevDrvId)?.name || '') : ''}</option>
      ${car.drivers.map(d => `<option value="${d.id}" ${svc.driverChange === d.id ? 'selected' : ''}>${esc(d.name)} got in</option>`).join('')}
    </select></label>
    <span class="fixbrakes">${BRAKE_COMPONENTS.map(b => {
      const fitted = car.state.currentBrakeSetId?.[b.id];
      // The part that was on the car before the stop cannot be what "went on":
      // if the group really was changed, something else came off the rack.
      const wasOn = h.brakeSetIds?.[b.id];
      const pool = usableBrakeSets(car, b.id).filter(t => t.id !== wasOn);
      return `<span class="fixbrake">
        <button class="toggle ${svc[b.id] ? 'on' : ''}" data-fixbrake="${b.id}">${BRAKE_LABEL[b.id]}</button>
        <select data-fixbset="${b.id}" title="which numbered set actually went on">
          ${pool.map(t => `<option value="${t.id}" ${t.id === fitted ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select></span>`;
    }).join('')}</span>
  </span>`;
}

// What the last pit-lane visit was, and what the app did about it. Three
// things it can say: the stop applied itself (with an undo while it is still
// fresh), the car only drove through so nothing was touched, or it stayed long
// enough to have been serviced with nothing planned — the one case where the
// app asks instead of guessing.
let pitVisitKey = '';
function renderPitVisit(car) {
  const el = $('pit-visit');
  if (!el) return;
  const v = car.state.lastPitVisit;
  // An applied stop stays up until it is signed off — the engineer always says
  // what happened. The "nothing was applied" notes are only news for a while.
  const fresh = v && (v.applied || Date.now() - v.atMs < 5 * 60e3);
  if (!v || !fresh) {
    el.classList.add('hidden');
    pitVisitKey = '';
    return;
  }
  // Rebuilt only when the answer state changes — otherwise a half-typed
  // correction would be wiped by the next render tick.
  const key = `${v.atMs}:${v.kind}:${v.applied}:${!!v.disputed}`;
  if (key === pitVisitKey) return;
  pitVisitKey = key;
  el.classList.remove('hidden');
  const timing = v.pitSec != null
    ? `${v.pitSec} s in the lane · ${v.stationarySec} s stationary` +
      (v.transitSec ? ` <span style="opacity:.7">(drive-through ${v.transitSec} s)</span>` : '')
    : 'applied by hand';

  if (v.kind === 'service' && v.applied && v.disputed) {
    // Denied: the stop is on the sheet as planned, and now the engineer writes
    // down what really happened. Saving moves every figure to match.
    el.innerHTML = `<span class="lab" style="color:var(--amber)">WHAT ACTUALLY HAPPENED</span>
      ${correctForm(car)}
      <span class="acts">
        <button data-act="undo" class="scrap">NO STOP HAPPENED — UNDO IT</button>
        <button data-act="cancel">BACK</button>
        <button class="keep" data-act="save">${icon('check')} SAVE WHAT HAPPENED</button></span>`;
  } else if (v.kind === 'service' && v.applied) {
    // The stop is in the numbers, but nobody has vouched for it yet. It stays
    // on screen until the engineer answers — there is no timer on it, because
    // an unanswered stop is a stop nobody has checked.
    const est = car.stintHistory[car.stintHistory.length - 1]?.estStationarySec;
    el.innerHTML = `<span class="lab">STOP DONE${v.byHand ? ' · BY HAND' : ' · APPLIED BY THE FEED'}</span>
      <b>DID IT GO TO PLAN?</b>
      <span class="mil">${timing}${est ? ` · <span style="opacity:.7">planned ${Math.round(est)} s</span>` : ''}</span>
      <span class="acts">
        <button class="scrap" data-act="dispute">NO — SOMETHING CHANGED</button>
        <button class="keep" data-act="confirm">${icon('check')} WENT TO PLAN</button></span>`;
  } else if (v.kind === 'driveThrough') {
    el.innerHTML = `<span class="lab">PIT LANE PASS</span>
      <b style="color:var(--amber)">NOTHING APPLIED</b>
      <span class="mil">${timing} — under the ${v.minServiceSec} s a stop takes</span>
      <span class="acts">
        <button class="keep" data-act="apply">IT WAS A STOP — APPLY IT</button>
        <button data-act="dismiss">OK</button></span>`;
  } else {
    el.innerHTML = `<span class="lab">${v.kind === 'held' ? 'RACE STOPPED' : 'NO STOP PLANNED'}</span>
      <b style="color:var(--amber)">NOTHING APPLIED</b>
      <span class="mil">${timing}${v.kind === 'held' ? ' — the clock is not running' : ' — the car was serviced without a plan'}</span>
      <span class="acts">
        <button class="keep" data-act="apply">APPLY AS A STOP</button>
        <button data-act="dismiss">OK</button></span>`;
  }
}

// The set that just came off: keep it or bin it, with the mileage it banked.
// The app has an opinion (past its life, or damage reported) but never decides.
let setDecisionKey = '';
function renderSetDecision(car, c) {
  const el = $('set-decision');
  if (!el) return;
  const pend = car.state.pendingSetDecision;
  const set = pend ? (car.tyreSets || []).find(t => t.id === pend.setId) : null;
  if (!pend || !set) {
    el.classList.add('hidden');
    setDecisionKey = '';
    return;
  }
  const lifeKm = car.config.tyreLifeKm || 0;
  const kmGreen = Math.max(0, pend.km - pend.kmFcy);
  const spent = lifeKm > 0 ? pend.km / lifeKm : pend.laps / Math.max(1, c.tyreLifeLaps);
  const suggest = spent >= 0.9 ? 'scrap' : 'keep';
  const key = `${pend.setId}:${pend.km}:${scrapAsk}`;
  if (key === setDecisionKey) return;
  setDecisionKey = key;
  el.classList.remove('hidden');
  el.innerHTML = `
    <span class="lab">CAME OFF</span>
    <b>${esc(set.name)}</b>
    <span class="mil">${pend.laps} laps · ${pend.km.toFixed(0)} km` +
      (pend.kmFcy > 0 ? ` <em>(${kmGreen.toFixed(0)} green · ${pend.kmFcy.toFixed(0)} yellow)</em>` : '') +
      (lifeKm > 0 ? ` · ${Math.round(spent * 100)} % of ${lifeKm} km life` : '') + `</span>
    <span class="why">app says ${suggest}</span>
    <span class="acts">
      ${scrapAsk === set.id
        ? SCRAP_REASONS.map(r => `<button data-why="${r}">${r.toUpperCase()}</button>`).join('') +
          `<button data-why="">CANCEL</button>`
        : `<button class="scrap" data-act="scrap">SCRAP…</button>
           <button class="keep" data-act="keep">KEEP — BACK ON THE RACK</button>`}
    </span>`;
  el.querySelector('[data-act="keep"]')?.addEventListener('click', () =>
    send({ type: 'tyreSetDecision', setId: set.id, scrapped: false }));
  el.querySelector('[data-act="scrap"]')?.addEventListener('click', () => {
    scrapAsk = set.id;
    setDecisionKey = '';
    renderSetDecision(car, c);
  });
  for (const b of el.querySelectorAll('[data-why]')) {
    b.addEventListener('click', () => {
      const why = b.dataset.why;
      scrapAsk = null;
      setDecisionKey = '';
      if (why) send({ type: 'tyreSetDecision', setId: set.id, scrapped: true, reason: why });
      else renderSetDecision(car, c);
    });
  }
}

// ---- learned-from-live-data panel ----

function adoptLearned(driverIdx, cond, learned) {
  const car = state.cars[carId];
  const d = car.drivers[driverIdx];
  if (!d || learned.burnLPerLap == null) return;
  if (car.config.fuelModel === 'driver-laptime' && learned.avgSec > 0) {
    // Add (or overwrite) a measured curve point at the learned pace.
    const pts = normalizeCurve([
      ...(Array.isArray(d.fuelCurve) ? d.fuelCurve : []),
      { lapSec: learned.avgSec, fuelL: learned.burnLPerLap }
    ]);
    patchDriver(driverIdx, 'fuelCurve', pts);
  } else {
    patchDriver(driverIdx, cond === 'wet' ? 'fuelWet' : 'fuelDry', learned.burnLPerLap);
  }
}

let learnedKey = '';
function renderLearned(car) {
  const wrap = $('learned-out');
  if (!wrap) return;
  const key = JSON.stringify(car.learn?.byDriver || {}) + '|' + car.config.fuelModel +
    '|' + car.drivers.map(d => `${d.id}:${d.name}:${d.fuelDry}:${d.fuelWet}:${(d.fuelCurve || []).length}`).join('|');
  if (key === learnedKey) return;
  learnedKey = key;

  const rows = [];
  car.drivers.forEach((d, i) => {
    for (const cond of ['dry', 'wet']) {
      const L = learnedOf(car.learn, d.id, cond);
      if (!L.laps && !L.burnLaps) continue;
      const modelBurn = car.config.fuelModel === 'driver-laptime' && L.avgSec > 0
        ? burnAtLapTime(d.fuelCurve, L.avgSec)
        : (cond === 'dry' ? (d.fuelDry > 0 ? d.fuelDry : car.config.burnPerLap.dry)
          : (d.fuelWet > 0 ? d.fuelWet : car.config.burnPerLap.wet));
      const drift = L.burnLPerLap != null && modelBurn > 0
        ? ((L.burnLPerLap - modelBurn) / modelBurn) * 100 : null;
      const driftCls = drift == null ? '' : Math.abs(drift) > 5 ? ' warn' : ' good';
      rows.push(`<tr>
        <td>${esc(d.name)}</td>
        <td>${cond.toUpperCase()}</td>
        <td class="num">${L.laps}</td>
        <td class="num">${L.avgSec ? fmtLap(L.avgSec) : '—'}</td>
        <td class="num">${L.bestSec ? fmtLap(L.bestSec) : '—'}</td>
        <td class="num">${L.burnLPerLap != null ? L.burnLPerLap.toFixed(2) + ' L' : `— <small>(${L.burnLaps} laps sampled)</small>`}</td>
        <td class="num">${modelBurn != null ? (+modelBurn).toFixed(2) + ' L' : '—'}</td>
        <td class="num${driftCls}">${drift != null ? (drift > 0 ? '+' : '') + drift.toFixed(0) + ' %' : '—'}</td>
        <td>${L.burnLPerLap != null ? `<button class="flag" data-adopt="${i}.${cond}">ADOPT</button>` : ''}</td>
      </tr>`);
    }
  });

  if (!rows.length) {
    wrap.innerHTML = '<p class="hint">Nothing learned yet — data appears once green laps are timed ' +
      '(live timing or +LAP with a time) and real fuel readings are entered.</p>';
    return;
  }
  wrap.innerHTML = `<table class="drv-table learned-table">
    <thead><tr><th>Driver</th><th>Cond</th><th>Laps</th><th>Avg lap</th><th>Best</th>
    <th>Learned burn</th><th>Model burn</th><th>Drift</th><th></th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
  for (const btn of wrap.querySelectorAll('button[data-adopt]')) {
    btn.addEventListener('click', () => {
      const [i, cond] = btn.dataset.adopt.split('.');
      const d = state.cars[carId].drivers[+i];
      const L = learnedOf(state.cars[carId].learn, d.id, cond);
      const target = state.cars[carId].config.fuelModel === 'driver-laptime'
        ? `a curve point at ${fmtLap(L.avgSec)}` : `${d.name}'s ${cond} average`;
      if (confirm(`Adopt ${L.burnLPerLap} L/lap (${cond}) as ${target}? Projections update immediately.`)) {
        adoptLearned(+i, cond, L);
      }
    });
  }
}

// ---- stint plan ----

const planOverlay = $('plan-overlay');
$('btn-plan').addEventListener('click', () => {
  planOverlay.classList.remove('hidden');
  fillPlanTimeline();
  renderPlan(true);
});
$('btn-plan-close').addEventListener('click', () => planOverlay.classList.add('hidden'));
planOverlay.addEventListener('click', e => { if (e.target === planOverlay) planOverlay.classList.add('hidden'); });

// The plan timeline is independent of the running session: prefilled from the
// session settings, but once edited it sticks — so a 24 h race plan can be
// built (and rebuilt) while a 30-minute session is live.
let planTimelineDirty = false;
for (const id of ['plan-duration', 'plan-start']) {
  $(id).addEventListener('input', () => { planTimelineDirty = true; });
}
function toLocalInput(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fillPlanTimeline(force = false) {
  if (!state || (planTimelineDirty && !force)) return;
  planTimelineDirty = false;
  $('plan-duration').value = state.race.durationH;
  $('plan-start').value = state.race.startMs ? toLocalInput(state.race.startMs) : '';
}
$('btn-plan-use-race').addEventListener('click', () => fillPlanTimeline(true));

// The race object handed to the generator: the timeline fields when they hold
// something usable, the live session otherwise.
function planRace() {
  const durationH = parseFloat($('plan-duration').value);
  const startRaw = $('plan-start').value;
  const startMs = startRaw ? new Date(startRaw).getTime() : null;
  return {
    durationH: durationH > 0 ? durationH : state.race.durationH,
    startMs: startMs && !isNaN(startMs) ? startMs : state.race.startMs
  };
}

$('btn-plan-generate').addEventListener('click', () => {
  if (!state) return;
  const race = planRace();
  const plan = generatePlan(state.cars[carId], race, Date.now());
  plan.durationH = race.durationH;
  patchCar({ plan });
});
$('btn-plan-replan').addEventListener('click', () => {
  if (!state) return;
  const clock = raceClock(state.race, Date.now());
  if (!clock.running) return alert('The race is not running — use GENERATE for a pre-race plan.');
  const plan = replanFromNow(state.cars[carId], state.race, Date.now());
  plan.durationH = state.race.durationH;
  patchCar({ plan });
});

// ---- saved plans (kept in the shared state on the pit wall PC) ----

$('btn-plan-save').addEventListener('click', () => {
  if (!state) return;
  const name = $('plan-name').value.trim();
  if (!name) return alert('Give the plan a name first.');
  if (!state.cars[carId].plan?.stints?.length) return alert('No plan to save — press GENERATE first.');
  if (state.cars[carId].savedPlans?.[name] && !confirm(`Plan "${name}" exists — overwrite it?`)) return;
  send({ type: 'savePlan', name });
  $('plan-name').value = '';
});

let savedPlanKey = '';
function renderSavedPlans(car) {
  const saved = car.savedPlans || {};
  const key = Object.entries(saved).map(([n, p]) => n + p.savedMs).join('|');
  if (key === savedPlanKey) return;
  savedPlanKey = key;
  const wrap = $('plan-saved-list');
  const names = Object.keys(saved).sort();
  wrap.innerHTML = names.length ? '' : '<p class="hint">No plans saved yet.</p>';
  for (const name of names) {
    const p = saved[name];
    const meta = [
      p.plan?.durationH ? p.plan.durationH + ' h' : null,
      p.plan?.stints?.length ? p.plan.stints.length + ' stints' : null,
      'saved ' + new Date(p.savedMs).toLocaleString()
    ].filter(Boolean).join(' · ');
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.innerHTML = `
      <span class="nm">${esc(name)}</span>
      <span class="meta">${meta}</span>
      <button data-act="load" class="primary">LOAD</button>
      <button data-act="del" class="danger">${icon('x')}</button>`;
    row.querySelector('[data-act="load"]').addEventListener('click', () => {
      if (confirm(`Load plan "${name}"? It replaces this car's active plan on every screen.`)) {
        send({ type: 'loadPlan', name });
      }
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (confirm(`Delete saved plan "${name}"?`)) send({ type: 'deletePlan', name });
    });
    wrap.appendChild(row);
  }
}

let planKey = '';
function renderPlan(force = false) {
  if (!state || planOverlay.classList.contains('hidden')) return;
  const car = state.cars[carId];
  renderSavedPlans(car);
  const plan = car.plan;
  const key = (plan ? String(plan.generatedMs) : 'none') +
    `|${car.stintHistory.length}|${car.state.lapsThisStint}`;
  if (!force && key === planKey) return;
  planKey = key;
  renderStintSheet(car);
  const out = $('plan-out');
  if (!plan || !plan.stints?.length) {
    out.innerHTML = '<p class="hint">No plan yet — press GENERATE.</p>';
    return;
  }
  const drvOf = id => car.drivers.find(d => d.id === id);
  const idxOf = id => car.drivers.findIndex(d => d.id === id);
  const wallTime = ms => new Date(plan.startMs + ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const pva = planVsActual(car, state.race, Date.now());

  const rows = plan.stints.map((s, i) => {
    const d = drvOf(s.driverId);
    const dot = `<span class="dot" style="background:${DRIVER_COLORS[idxOf(s.driverId) % DRIVER_COLORS.length]}"></span>`;
    const warn = s.noNightCover ? ` <span title="no night-capable driver — flag needs attention">${icon('warn')}</span>` : '';
    const r = pva?.rows[i];
    let actual = '<td></td><td></td>';
    let rowCls = s.night ? 'night' : '';
    if (r?.status === 'done') {
      const ad = drvOf(r.actualDriverId);
      const dn = r.driverMismatch ? `<span class="warn">${esc(ad ? ad.name : '?')}</span>` : icon('check');
      const delta = r.deltaEndMs;
      const dCls = Math.abs(delta) < 3 * 60e3 ? 'good' : Math.abs(delta) < 10 * 60e3 ? 'warn' : 'crit';
      actual = `<td class="drv">${dn} <small>${r.actualLaps} laps</small></td>
        <td class="num ${dCls}">${delta >= 0 ? '+' : '−'}${fmtMinSec(Math.abs(delta))}</td>`;
      rowCls += ' done';
    } else if (r?.status === 'current') {
      const ad = drvOf(r.actualDriverId);
      actual = `<td class="drv">${r.driverMismatch ? `<span class="warn">${esc(ad ? ad.name : '?')}</span>` : icon('play')} <small>in car · ${r.actualLaps} laps</small></td><td></td>`;
      rowCls += ' cur';
    }
    return `<tr class="${rowCls}">
      <td class="num">${i + 1}</td>
      <td class="num">${fmtClock(s.fromMs)} – ${fmtClock(s.toMs)}</td>
      <td class="num">${wallTime(s.fromMs)}</td>
      <td class="drv">${dot} ${d ? d.name.replace(/</g, '&lt;') : '?'}${s.night ? ' ' + icon('moon') : ''}${warn}</td>
      <td class="num">${fmtMinSec(s.toMs - s.fromMs)}</td>
      <td class="num">${s.laps}</td>
      <td class="num">${s.fuelL != null ? s.fuelL + ' L' : '—'}</td>
      ${actual}
    </tr>`;
  }).join('');

  const totals = car.drivers.map((d, i) => {
    const ms = plan.totals[d.id] || 0;
    const n = plan.stints.filter(s => s.driverId === d.id).length;
    return `<span class="tot"><span class="dot" style="background:${DRIVER_COLORS[i % DRIVER_COLORS.length]}"></span>
      ${d.name.replace(/</g, '&lt;')}: <b class="num">${fmtClock(ms)}</b> (${n} stints)</span>`;
  }).join('');

  // Headline drift: how far the car is running ahead of / behind the plan.
  let driftLine = '';
  if (pva && pva.completed > 0) {
    const dm = pva.driftMs;
    const cls = Math.abs(dm) < 3 * 60e3 ? 'good' : Math.abs(dm) < 10 * 60e3 ? 'warn' : 'crit';
    driftLine = `<p class="drift ${cls}">${icon('timer')} After ${pva.completed} stint${pva.completed > 1 ? 's' : ''}: ` +
      (Math.abs(dm) < 60e3 ? 'on plan'
        : `${fmtMinSec(Math.abs(dm))} ${dm > 0 ? 'behind' : 'ahead of'} plan`) +
      ` — REPLAN REST FROM NOW rebuilds the remainder.</p>`;
  }

  // A plan built for a different timeline than the running session (the whole
  // point of the custom timeline fields) — label it so nobody wonders why the
  // stints overshoot the session clock.
  const customTimeline = plan.durationH != null && plan.durationH !== state.race.durationH
    ? `<p class="hint">${icon('timer')} Planned for a <b>${plan.durationH} h</b> race starting ${new Date(plan.startMs).toLocaleString()} — the live session is ${state.race.durationH} h. Save the plan below to keep it for the real race.</p>`
    : '';

  out.innerHTML = `
    ${customTimeline}
    ${plan.assumedStart ? `<p class="hint">${icon('warn')} No race start time set — night hours assume the race starts now (${new Date(plan.startMs).toLocaleString()}). Set a start time on the pit wall for correct night stints.</p>` : ''}
    ${driftLine}
    <div class="plan-totals">${totals}</div>
    <table class="drv-table plan-table">
      <thead><tr><th>#</th><th>Race time</th><th>Clock</th><th>Driver</th><th>Length</th><th>Laps</th><th>Fuel</th><th>Actual</th><th>Δ end</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">${plan.replanned ? 'Replanned' : 'Generated'} ${new Date(plan.generatedMs).toLocaleString()} · ${plan.stints.length} stints. The plan is shared — every station and reconnect sees the same one. Rows: ✓/driver = as driven, Δ end = actual stop time vs plan.</p>`;
}

// ---- stint sheet (actual stints, from history + the running stint) ----

function renderStintSheet(car) {
  const out = $('sheet-out');
  if (!out) return;
  const now = Date.now();
  const clock = raceClock(state.race, now);
  const drvOf = id => car.drivers.find(d => d.id === id);
  const idxOf = id => car.drivers.findIndex(d => d.id === id);
  const setName = id => (car.tyreSets || []).find(t => t.id === id)?.name || '';

  const entries = car.stintHistory.map((h, i) => {
    const lPerLap = h.fuelUsedL != null && h.laps > 0 ? h.fuelUsedL / h.laps : null;
    return { i, driverId: h.driverId, fromMs: h.startMs, toMs: h.endMs, laps: h.laps,
      bestSec: h.bestSec, avgSec: h.avgSec, fuelUsedL: h.fuelUsedL, lPerLap,
      tyreSet: setName(h.tyreSetId), live: false };
  });
  if (clock.running && car.state.stintStartMs) {
    const st = stintStats(car.state.stintLapSec);
    const used = car.state.stintFuelStartL != null
      ? Math.max(0, car.state.stintFuelStartL - car.state.fuelLiters) : null;
    entries.push({
      i: entries.length, driverId: car.currentDriverId,
      fromMs: car.state.stintStartMs, toMs: now, laps: car.state.lapsThisStint,
      bestSec: st.bestSec, avgSec: st.avgSec,
      fuelUsedL: used != null ? +used.toFixed(1) : null,
      lPerLap: used != null && car.state.lapsThisStint > 0 ? used / car.state.lapsThisStint : null,
      tyreSet: setName(car.state.currentTyreSetId), live: true
    });
  }

  if (!entries.length) {
    out.innerHTML = '<p class="hint">No stints driven yet — the sheet fills in as the race runs.</p>';
    return;
  }

  const rows = entries.map(e => {
    const d = drvOf(e.driverId);
    const dot = `<span class="dot" style="background:${DRIVER_COLORS[idxOf(e.driverId) % DRIVER_COLORS.length]}"></span>`;
    return `<tr class="${e.live ? 'cur' : ''}">
      <td class="num">${e.i + 1}</td>
      <td class="drv">${dot} ${d ? esc(d.name) : '?'}${e.live ? ' ' + icon('play') : ''}</td>
      <td class="num">${new Date(e.fromMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
      <td class="num">${fmtMinSec(e.toMs - e.fromMs)}</td>
      <td class="num">${e.laps}</td>
      <td class="num">${e.bestSec ? fmtLap(e.bestSec) : '—'}</td>
      <td class="num">${e.avgSec ? fmtLap(e.avgSec) : '—'}</td>
      <td class="num">${e.fuelUsedL != null ? e.fuelUsedL + ' L' : '—'}</td>
      <td class="num">${e.lPerLap != null ? e.lPerLap.toFixed(2) : '—'}</td>
      <td class="num">${e.tyreSet || '—'}</td>
    </tr>`;
  }).join('');

  // Per-driver rollup across completed + running stints.
  const rollup = car.drivers.map((d, i) => {
    const own = entries.filter(e => e.driverId === d.id);
    if (!own.length) return '';
    const laps = own.reduce((a, e) => a + e.laps, 0);
    const best = own.map(e => e.bestSec).filter(Boolean);
    return `<span class="tot"><span class="dot" style="background:${DRIVER_COLORS[i % DRIVER_COLORS.length]}"></span>
      ${esc(d.name)}: <b class="num">${own.length}</b> stints · <b class="num">${laps}</b> laps` +
      (best.length ? ` · best <b class="num">${fmtLap(Math.min(...best))}</b>` : '') + '</span>';
  }).join('');

  out.innerHTML = `
    <div class="plan-totals">${rollup}</div>
    <table class="drv-table plan-table sheet-table">
      <thead><tr><th>#</th><th>Driver</th><th>Start</th><th>Length</th><th>Laps</th>
      <th>Best</th><th>Avg</th><th>Fuel</th><th>L/lap</th><th>Tyres</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">Best/avg use timed laps only (in/out and traffic laps are excluded from the
    average). Fuel figures come from the tank model between trusted readings.</p>`;
}

// ---- rendering ----

function setInput(el, value) {
  if (document.activeElement !== el) el.value = value;
}

function render() {
  if (!state) return;
  renderCarPicker();
  const car = state.cars[carId];
  if (!car) return;
  const now = Date.now();
  const c = carCalcs(car, state.race, now);
  const fs = fuelStrategy(car, state.race, now, c);

  document.title = `PitWall 24H — ${car.name}`;
  const defaultName = `Car #${car.number}`;
  const carMakeModel = [car.make, car.model].filter(Boolean).join(' ');
  const titleName = car.name === defaultName ? 'CAR' : car.name.toUpperCase();
  $('car-title').innerHTML = `${titleName} <span>#${car.number}</span>` +
    (carMakeModel ? ` <small style="color:var(--dim);font-size:15px;font-weight:400">${carMakeModel}</small>` : '');
  // One countdown: T– to a scheduled start, then time to go — straight from
  // the timing feed's session clock whenever the feed is live, but never while
  // the feed is on a session this race is not part of (pit wall to answer).
  const feedRemainUs = timing?.conn === 'connected' && !state.timing?.sessionAlert
    ? timing.session?.remainUs : null;
  $('clock-remaining').textContent = c.clock.scheduled
    ? 'T–' + fmtClock(c.clock.msToStart)
    : fmtClock(feedRemainUs != null ? feedRemainUs / 1000 : c.clock.remainingMs);

  // laps
  $('laps-stint').textContent = car.state.lapsThisStint;
  $('laps-total').textContent = car.state.totalLaps;
  $('last-lap').textContent = fmtLap(car.state.lastLapSec);

  // condition
  for (const b of condRow.children) {
    b.className = b.dataset.cond === car.condition ? 'on ' + b.dataset.cond : '';
  }

  // Race condition: the top bar is the primary signal, the banner carries the
  // detail (what the burn and lap time actually became for this car).
  const cond = renderConditionBar($('topbar'), $('cond-block'), state, now);
  renderConditionControls($('cond-controls'), state);
  const fcy = state.race.fcy || {};
  const fcyBanner = $('fcy-banner');
  const neutralised = cond.pace === 'sc' || cond.pace === 'fcy';
  fcyBanner.classList.toggle('hidden', cond.id === 'green');
  fcyBanner.classList.toggle('stopped', !neutralised && cond.id !== 'green');
  if (neutralised) {
    const dur = fcy.startMs ? fmtMinSec(now - fcy.startMs) : '';
    const src = cond.source === 'feed' ? 'from timing feed' : 'manual';
    // The fuel call, right where the decision is made: pitting under this
    // neutralisation vs at the perfect green moment — pit window included, so
    // a "free" stop that would add an extra stop later is never recommended.
    let boxHint = '';
    if (fs) {
      const net = fs.netPitNowSec;
      if (fs.noStopNeeded) {
        boxHint = ' · <b>STAY OUT — fuel reaches the flag</b>';
      } else if (net <= 0) {
        boxHint = ` · <b>BOX NOW${fs.windowOpen ? '' : ' (adds a stop, still worth it)'} — ${
          net <= -1 ? 'saves ' + Math.abs(net).toFixed(0) + ' s' : 'free stop'} · fill to ${fs.fillTargetL} L</b>`;
      } else if (fs.windowOpen) {
        boxHint = ` · box costs ${net.toFixed(0)} s net · fill to ${fs.fillTargetL} L`;
      } else {
        boxHint = ` · <b>STAY OUT — box now adds a stop (+${net.toFixed(0)} s net)</b>, window opens in ${fs.lapsToWindow} laps`;
      }
    } else {
      const fc = fcyCalc(car);
      if (fc) {
        boxHint = fc.netPitLossSec <= 0
          ? ` · <b>PIT NOW — FREE STOP (${fc.netPitLossSec.toFixed(0)} s net)</b>`
          : ` · pit now: net ${fc.netPitLossSec.toFixed(0)} s <small>(vs ${car.config.pitLossSec || 0} s green)</small>`;
      }
    }
    // Where the car actually is: time to the pit entry from the last timing
    // loop crossing (green pace to the flag, neutralised pace after) — the
    // number the crew needs the moment BOX is called.
    let etaHint = '';
    const nrNow = timingNrOf(state.timing || {}, car);
    const eNow = timing?.conn === 'connected' || timing?.conn === 'replay'
      ? timing.entries?.find(x => String(x.nr).trim() === nrNow) || null
      : null;
    const eta = eNow && !car.state.inPit ? pitEta(car, state.race, timing, eNow, timingRxMs, now) : null;
    if (eta) {
      etaHint = eta.stale
        ? ` · pit entry ~${fmtMinSec(eta.etaEntrySec * 1000)} <small>(no passing for ${fmtMinSec(eta.crossAgeSec * 1000)})</small>`
        : ` · pit entry in <b>~${fmtMinSec(eta.etaEntrySec * 1000)}</b>` +
          (eta.etaBoxSec != null ? ` <small>(at box ~${fmtMinSec(eta.etaBoxSec * 1000)})</small>` : '');
    }
    fcyBanner.innerHTML = `${icon(cond.id === 'sc' ? 'safetycar' : 'flag')} ${cond.label} ${dur} `
      + `— burn ${c.burn.toFixed(2)} L/lap · lap ${(c.lapMs / 1000).toFixed(0)} s${boxHint}${etaHint} <small>(${src})</small>`;
  } else if (cond.id !== 'green') {
    // Red flag / chequered: no fuel is being consumed, so say that rather than
    // leaving the last neutralisation figures on screen.
    fcyBanner.innerHTML = `${icon(cond.id === 'red' ? 'redflag' : 'chequered')} ${cond.label} — FUEL BURN PAUSED`;
  }

  // fuel
  const fuelPct = car.state.fuelLiters / car.config.tankLiters;
  $('fuel-now').textContent = car.state.fuelLiters.toFixed(1) + ' L';
  $('fuel-now').className = 'v big' +
    (car.state.fuelLiters <= c.safety || c.lapsToEmpty <= 3 ? ' crit' : c.lapsToEmpty <= 8 ? ' warn' : '');
  setMeter($('fuel-meter'), fuelPct);
  $('fuel-usable').textContent = c.usableFuel.toFixed(1) + ' L';
  $('fuel-usable').className = 'v' + (c.usableFuel <= 0 ? ' crit' : '');
  const burnPerMin = (c.burn * 60000) / c.lapMs;
  $('fuel-burn').textContent = car.state.inPit
    ? 'paused — in pit'
    : `${c.burn.toFixed(2)} L · ${burnPerMin.toFixed(2)} L`;
  $('fuel-laps').textContent = c.lapsToEmpty;
  $('fuel-time').textContent = fmtMinSec(c.msToEmpty);
  $('fuel-to-end').textContent = c.clock.running ? Math.ceil(c.fuelToEnd) + ' L' : '—';

  // Pit window: the point from which refuelling stops costing extra time.
  const stopsEl = $('fuel-stops');
  const winEl = $('fuel-window');
  if (!fs) {
    stopsEl.textContent = '—';
    stopsEl.className = 'v';
    winEl.textContent = '—';
    winEl.className = 'v';
  } else if (fs.noStopNeeded) {
    stopsEl.textContent = 'none — fuel to the flag';
    stopsEl.className = 'v good';
    winEl.textContent = 'no fuel stop needed';
    winEl.className = 'v good';
  } else {
    stopsEl.textContent = `${fs.stopsMin}` +
      (fs.stopsIfNow > fs.stopsMin ? ` (${fs.stopsIfNow} if boxed now)` : '') +
      ` · ≥ ${fmtMinSec(fs.remainingPitTimeSec * 1000)} pit time`;
    stopsEl.className = 'v';
    if (fs.windowOpen) {
      winEl.textContent = `OPEN — box within ${fs.windowLapsLeft} laps · fill to ${fs.fillTargetL} L`;
      winEl.className = 'v good';
    } else {
      winEl.textContent = `opens in ${fs.lapsToWindow} laps (~${fmtMinSec(fs.msToWindow)})`;
      winEl.className = 'v';
    }
  }

  // Low-fuel banner: flashes once the tank is down to the warning laps. Muted
  // while the car is already in the pit lane (the stop is happening) and when
  // the maths says the fuel reaches the flag anyway (end of race).
  const fwEl = $('fuel-warn');
  const fw = fs?.warn;
  if (fw && fw.level !== 'ok' && !fs.noStopNeeded && !car.state.inPit) {
    fwEl.classList.remove('hidden');
    fwEl.classList.toggle('crit', fw.level === 'crit');
    fwEl.innerHTML = `${icon('fuel')} LOW FUEL — ${fw.lapsLeft} LAP${fw.lapsLeft === 1 ? '' : 'S'} ` +
      `TO SAFETY LEVEL (${fmtMinSec(fw.msLeft)})` +
      (fs.windowOpen ? ` — BOX · FILL TO ${fs.fillTargetL} L` : '');
  } else {
    fwEl.classList.add('hidden');
  }

  // tyres
  const curSet = currentTyreSet(car);
  $('tyre-current').textContent = curSet ? curSet.name : '—';
  $('tyre-laps').textContent = car.state.tyreLapsOnSet;
  setMeter($('tyre-meter'), 1 - car.state.tyreLapsOnSet / Math.max(1, c.tyreLifeLaps));
  $('tyre-left').textContent = c.tyreLapsLeft;
  // Mileage on the rubber, and how much of it was driven under a yellow —
  // yellow kilometres cost the tyre far less than green ones.
  const mil = c.tyreMileage;
  $('tyre-km').textContent = mil.km > 0
    ? `${mil.km.toFixed(0)} km · ${mil.kmGreen.toFixed(0)} · ${mil.kmFcy.toFixed(0)}` +
      (c.tyreKmRemaining != null ? ` (${c.tyreKmRemaining.toFixed(0)} left)` : '')
    : '—';
  // Only never-used sets that are still in the pool count as "new".
  const freshSets = (car.tyreSets || []).filter(t => !t.used && !t.scrapped).length;
  const scrapped = (car.tyreSets || []).filter(t => t.scrapped).length;
  $('tyre-sets').textContent = `${car.state.tyreSetsUsed} / ${car.config.tyreSets} · ${freshSets} new` +
    (scrapped ? ` · ${scrapped} scrapped` : '');
  renderSetDecision(car, c);
  renderPitVisit(car);

  // brakes
  renderBrakes(c);

  // drivers + NOW strip (the timing-fed cells are set in renderTiming)
  renderDrivers(car, c);
  const drvNow = car.drivers.find(d => d.id === car.currentDriverId);
  $('now-driver').textContent = drvNow ? drvNow.name : '—';
  $('stint-time').textContent = fmtMinSec(c.stintElapsedMs);
  $('stint-time').className = 'num' + (c.msDriverLeft < 5 * 60e3 ? ' crit' : c.msDriverLeft < 10 * 60e3 ? ' warn' : '');
  $('stint-max').textContent = car.config.maxStintMin + ' min';
  $('now-fuel').textContent = c.clock.running ? fmtMinSec(c.msToEmpty) : '—';
  $('now-fuel').className = 'num' + (c.lapsToEmpty <= 3 ? ' crit' : c.lapsToEmpty <= 8 ? ' warn' : '');
  $('now-tyres').textContent = c.tyreLapsLeft + ' laps';
  $('now-tyres').className = 'num' + (c.tyreLapsLeft <= 3 ? ' crit' : c.tyreLapsLeft <= 8 ? ' warn' : '');
  // The alert chip carries exactly one message: the binding limit.
  const alertEl = $('now-alert');
  if (c.clock.running) {
    alertEl.textContent = `${c.limit.label} LIMIT NEXT — STOP IN ~${fmtMinSec(c.limit.ms)}`;
    alertEl.className = 'alertchip' + (c.limit.ms < 5 * 60e3 ? ' crit' : c.limit.ms < 15 * 60e3 ? ' warn' : '');
  } else if (c.clock.scheduled) {
    alertEl.textContent = 'RACE STARTS IN ' + fmtClock(c.clock.msToStart);
    alertEl.className = 'alertchip';
  } else {
    alertEl.textContent = 'RACE NOT STARTED';
    alertEl.className = 'alertchip';
  }

  renderPlanner(car, c, now);

  renderSettings(car, c);
  renderTiming();
  renderScoreboard();
  renderTimeline(car, now);
  renderPlan();
  autofit();
}

// ---- auto-fit: shrink the whole page so the station never needs scrolling ----

// ---- the stop panel -------------------------------------------------------

const PLAN_TABS = [['green', 'GREEN'], ['fcy', 'CODE 60'], ['sc', 'SAFETY CAR']];
const BRAKE_LABEL = { padsFront: 'PADS F', padsRear: 'PADS R', discsFront: 'DISCS F', discsRear: 'DISCS R' };
const VERDICT_CLS = {
  boxNow: 'crit', box: 'go', stay: 'hold', noStop: 'go', plan: 'calm', none: 'calm'
};

// Brake work the current plan calls for — the starting point when the engineer
// begins toggling components by hand.
function plannedBrakes(car) {
  return BRAKE_COMPONENTS.filter(b => car.nextStop[b.id]).map(b => b.id);
}

let planLinesKey = '';

function renderPlanner(car, c, now) {
  const stop = car.nextStop;
  const plans = recommendedStops(car, state.race, now, c);
  // Until the engineer picks one, the card follows whatever is actually flying.
  const tab = ['green', 'fcy', 'sc'].includes(stop.plan) ? stop.plan : plans.live;
  const plan = plans[tab];
  const pinned = stop.pinned || {};
  const inPit = car.state.inPit;
  const live = stop.status !== 'draft'; // the engineer has committed this stop

  // ---- the three situations, with when each one would happen
  for (const b of $('plan-tabs').children) {
    const id = b.dataset.plan;
    const p = plans[id];
    b.classList.toggle('on', id === tab);
    b.classList.toggle('live', plans.live === id);
    b.querySelector('[data-when]').textContent =
      plans.live === id ? 'NOW'
        : p.dueMs != null && p.dueMs > 0 ? fmtMinSec(p.dueMs)
        : id === 'green' ? '—' : 'if it drops';
  }

  // ---- the call
  const vb = $('plan-verdict');
  if (live || inPit) {
    // A committed stop speaks for itself: the band becomes the stop's own state.
    vb.className = 'verdictband ' + (inPit ? 'calm' : stop.status === 'box' ? 'crit' : 'hold');
    $('plan-head').innerHTML = inPit
      ? `${icon('parking')} IN PIT LANE`
      : stop.status === 'box' ? `${icon('boxin')} BOX BOX — CAR COMING IN`
      : `${icon('alert')} SENT TO THE CREW`;
    $('plan-sub').textContent = inPit
      ? 'Fuel burn and lap counting are paused. The stop applies when the car leaves the pit lane.'
      : stop.status === 'box' ? 'The crew is out. Nothing left to press until the car turns in.'
      : 'The crew has the work order. BOX BOX when you want the car in.';
  } else {
    vb.className = 'verdictband ' + (VERDICT_CLS[plan.verdict] || 'calm');
    $('plan-head').innerHTML = `${icon(planIcon(plan))} ${esc(plan.head)}`;
    $('plan-sub').textContent = plan.sub;
  }

  // ---- when
  const dueMs = live || inPit ? c.limit.ms : plan.dueMs;
  $('plan-due-k').textContent = live && !inPit ? 'STOP DUE' : inPit ? 'IN THE LANE' : plan.dueKey;
  $('plan-due-t').textContent = inPit
    ? (car.state.pitEnterMs ? fmtMinSec(now - car.state.pitEnterMs) : '0:00')
    : dueMs == null ? 'NOW' : fmtMinSec(Math.max(0, dueMs));
  $('plan-due-n').textContent = inPit ? 'fuel burn paused' : (plan.dueNote || '');

  // ---- the one question the app cannot answer for itself
  const ask = $('plan-ask');
  ask.classList.toggle('hidden', !plan.ask || live || inPit);
  if (plan.ask) ask.innerHTML = `${icon('warn')} ${esc(plan.ask)}`;

  // ---- the plan in a sentence
  const r = resolveStop(car, plan);
  $('plan-sentence').innerHTML = planSentence(car, plan, r);

  // ---- the four lines, every option on screen
  const lines = planLineData(car, c, plan, r, pinned);
  const key = JSON.stringify([lines.map(l => [l.v, l.n, l.pinned, l.sel]), tab, pickSetOpen, pickBrakeOpen, live]);
  if (key !== planLinesKey) {
    planLinesKey = key;
    $('plan-lines').innerHTML = lines.map(l => `
      <div class="pline ${l.pinned ? 'pinned' : ''} ${l.quiet ? 'quiet' : ''}">
        <div class="top">
          ${icon(l.icon)}
          <span class="kv2"><span class="k">${l.k}</span><span class="v">${l.v}</span>
            <span class="n">${l.n}</span></span>
          <span class="tag ${l.pinned ? 'pin' : ''}">${l.pinned ? 'pinned' : 'app'}</span>
        </div>
        <div class="opts">${l.opts.map(([val, lab]) =>
          `<button data-pin="${l.id}" data-val="${val}" class="${l.sel.includes(val) ? 'on' + (val === 'auto' ? ' app' : '') : ''}">${lab}</button>`).join('')}
          ${l.id === 'fuel' && l.sel.includes('set')
            ? `<input type="number" data-fuelset min="0" step="1" value="${fuelSetL || Math.round(car.config.tankLiters)}">` : ''}
        </div>
        ${l.id === 'tyres' && pickSetOpen ? tyrePicker(car, pinned.tyres) : ''}
        ${l.id === 'brakes' && pickBrakeOpen ? brakePicker(car, r) : ''}
      </div>`).join('');
  }

  setInput($('stop-notes'), stop.notes || '');

  // ---- what it costs
  const svc = stopServiceTime(car, { fuelLiters: r.fuelLiters, tyres: r.tyres });
  const anyService = svc.addLiters > 0 || r.tyres;
  $('stop-est').textContent = anyService
    ? `${svc.addLiters > 0 ? '+' + svc.addLiters.toFixed(0) + ' L · ' : ''}${Math.round(svc.totalSec)} s · ` +
      `${Math.round(svc.totalSec + (car.config.pitLossSec || 0))} s`
    : '—';

  // ---- the approval tick
  const ap = stop.approved;
  const bar = $('plan-approve');
  bar.className = 'approvebar' + (ap ? (ap.stale ? ' stale' : ' done') : '');
  bar.innerHTML = ap && !ap.stale
    ? `<span class="box">${icon('check')}</span>
       <span><b>APPROVED ${new Date(ap.atMs).toLocaleTimeString()}</b><br>the crew is preparing against this plan</span>
       <button data-approve="no">UNDO</button>`
    : ap && ap.stale
      ? `<span class="box">${icon('warn')}</span>
         <span><b>THE PLAN MOVED SINCE YOU APPROVED IT</b><br>the wall says so too</span>
         <button data-approve="yes">RE-APPROVE</button>`
      : `<span class="box"></span>
         <span>The crew sees this as the app's suggestion until you approve it</span>
         <button class="send" data-approve="yes">${icon('check')} APPROVE</button>`;

  // ---- lifecycle. The engineer owns SEND and BOX; the feed owns what follows.
  const acts = $('stop-actions');
  const feedDrives = timing?.conn === 'connected' && state.timing?.autoLap?.[carId] !== false;
  if (inPit) {
    acts.innerHTML = `<div class="feedstate">${icon('timer')}
        <span><b>Service running</b> — ${feedDrives ? 'the stop applies itself when the car leaves the pit lane' : 'release the car when the stop is done'}</span></div>
      <div class="actions" style="margin-top:6px">
        <button data-act="ontrack">BACK ON TRACK — NO SERVICE</button>
        <button class="done big" data-act="done">${icon('check')} STOP DONE — CAR RELEASED</button>
      </div>`;
  } else if (stop.status === 'box') {
    acts.innerHTML = `<div class="feedstate">${icon('feed')}
        <span>${feedDrives ? 'Watching for the pit-entry loop — nothing to press' : 'Live timing is off — mark the car in when it arrives'}</span>
        <button data-act="inpit">${feedDrives ? 'FEED IS DOWN — MARK IN PIT' : 'CAR IN PIT LANE'}</button></div>
      <div class="actions" style="margin-top:6px"><button data-act="unsend">CANCEL THE STOP</button></div>`;
  } else if (stop.status === 'sent') {
    acts.innerHTML = `<div class="actions">
        <button data-act="unsend">UNSEND</button>
        <button class="box big" data-act="box">BOX BOX</button></div>`;
  } else {
    acts.innerHTML = `<div class="actions">
        <button data-act="clear">CLEAR</button>
        <button class="send" data-act="send">SEND TO CREW</button></div>`;
  }

  // ---- status line + stepper
  const statusEl = $('stop-status');
  statusEl.innerHTML = inPit
    ? `— ${icon('parking')} IN PIT LANE ${car.state.pitEnterMs ? fmtMinSec(now - car.state.pitEnterMs) : ''} — FUEL BURN PAUSED —`
    : stop.status === 'sent' ? '— SENT TO THE CREW —'
    : stop.status === 'box' ? '— BOX BOX — CAR COMING IN —'
    : ap && !ap.stale ? '— PLANNED · APPROVED —' : '— PLANNED BY THE APP —';
  statusEl.className = 'status-line ' + (inPit ? 'inpit' : stop.status);

  const stages = ['draft', 'sent', 'box', 'inpit', 'done'];
  const stageIdx = stages.indexOf(inPit ? 'inpit' : stop.status);
  for (const s of $('stop-stepper').children) {
    const si = stages.indexOf(s.dataset.st);
    s.className = si < stageIdx ? 'done' : si === stageIdx ? 'cur' : '';
  }
}

function planIcon(plan) {
  switch (plan.verdict) {
    case 'boxNow': return 'boxin';
    case 'box': return 'fuel';
    case 'stay': return 'alert';
    case 'noStop': return 'check';
    default: return 'timer';
  }
}

// The plan as one sentence — what it is, before what it costs.
function planSentence(car, plan, r) {
  if (!raceClock(state.race, Date.now()).running) {
    return 'The plan starts working the moment the race clock does.';
  }
  const bits = [];
  if (r.fuelLiters > 0) {
    bits.push(r.fuelMode === 'full' ? '<b>fill it full</b>'
      : r.fuelMode === 'toEnd' ? `fuel <b>to the end</b> <span class="t">(${r.fuelLiters} L)</span>`
      : `fuel to <b class="t">${r.fuelLiters} L</b>`);
  } else bits.push('no fuel');
  const set = r.tyres ? (r.tyreSetId ? (car.tyreSets || []).find(t => t.id === r.tyreSetId) : plan.tyres.set) : null;
  bits.push(r.tyres ? `fit <b>${esc(set ? set.name : 'a fresh set')}</b>` : 'keep the tyres');
  const drv = car.drivers.find(d => d.id === r.driverChange);
  bits.push(drv ? `<b>${esc(drv.name)}</b> takes over` : 'same driver stays in');
  // Brake work names the part number — that is what gets laid out on the trolley.
  const brakes = BRAKE_COMPONENTS.filter(b => r[b.id]).map(b => {
    const set = brakeSetsOf(car, b.id).find(t => t.id === r.brakeSetIds?.[b.id]);
    return BRAKE_LABEL[b.id].toLowerCase() + (set ? ` ${esc(set.name)}` : '');
  });
  if (brakes.length) bits.push(`<b>${brakes.join(' + ')}</b>`);
  const when = plan.dueMs == null
    ? 'Box now'
    : plan.verdict === 'stay'
      ? `In <span class="t">${fmtMinSec(Math.max(0, plan.dueMs))}</span>`
      : `Box within <span class="t">${fmtMinSec(Math.max(0, plan.dueMs))}</span>`;
  return `${when} — ${bits.join(', ')}.`;
}

// One row per line: what the app says (or what you pinned), and every option.
function planLineData(car, c, plan, r, pinned) {
  const tank = car.config.tankLiters || 0;
  const fuelPin = pinned.fuel || null;
  const fuelSel = !fuelPin ? 'auto' : fuelPin.mode === 'toEnd' ? 'end' : fuelPin.mode;
  const addL = Math.max(0, Math.ceil(r.fuelLiters - car.state.fuelLiters));
  const rigSec = Math.round(addL / (car.config.refuelLps || 2.5));

  const set = r.tyres ? (r.tyreSetId ? (car.tyreSets || []).find(t => t.id === r.tyreSetId) : plan.tyres.set) : null;
  const tyrePin = pinned.tyres || null;
  // SELECT SET… lights while the stock list is open, and stays lit once a
  // specific set is pinned — the button is the state, not just a door.
  const tyreSel = !tyrePin ? (pickSetOpen ? 'pick' : 'auto')
    : (tyrePin === 'keep' || tyrePin === 'new') ? tyrePin : 'pick';

  const drv = car.drivers.find(d => d.id === r.driverChange);
  const drvPin = pinned.driver || null;
  // The app's pick and "stays in" cover the normal calls; everyone else who
  // could take the car gets their own button, so a swap is one tap. The driver
  // already in the car is not offered — that is what STAYS IN means.
  const drvOpts = [['auto', 'APP'], ['stay', 'STAYS IN'],
    ...car.drivers.filter(d => d.id !== car.currentDriverId)
      .map(d => [d.id, driverAbbrev(d).toUpperCase()])];

  const brakeIds = BRAKE_COMPONENTS.filter(b => r[b.id]).map(b => b.id);
  const brakePin = pinned.brakes || null;
  const brakeSetPin = pinned.brakeSets || null;
  // The part that would actually go on each component being changed — the
  // number the crew has to pull off the rack, not just "front pads".
  const brakeSetOf = comp => brakeSetsOf(car, comp).find(t => t.id === r.brakeSetIds?.[comp]) || null;
  // SELECT PARTS… lights while the rack is open and stays lit once a specific
  // set is pinned — the button is the state, not just a door. It sits alongside
  // the component buttons rather than replacing them: which components get
  // changed and which numbers go on them are two separate calls, and the app
  // can still own the first while the engineer owns the second. (Copied, never
  // the pinned array itself — this list gets pushed to.)
  const brakeSel = brakePin ? (brakePin.length ? [...brakePin] : ['none']) : ['auto'];
  if (brakeSetPin || pickBrakeOpen) brakeSel.push('pick');

  return [
    {
      id: 'fuel', k: 'FUEL — LEAVE WITH', icon: 'fuel', pinned: !!fuelPin,
      quiet: r.fuelLiters <= 0,
      v: r.fuelLiters <= 0 ? 'NO FUEL'
        : r.fuelMode === 'full' ? 'FULL'
        : r.fuelMode === 'toEnd' ? `TO THE END · ${r.fuelLiters} L`
        : `${r.fuelLiters} L`,
      n: r.fuelLiters > 0
        ? `+${addL} L · ${rigSec} s on the rig${r.fuelMode === 'toEnd' ? ' · freezes at pit entry' : ''}`
        : plan.fuel.why,
      sel: [fuelSel],
      opts: [['auto', 'APP'], ['full', 'FULL'], ['end', 'TO END'], ['set', 'SET']]
    },
    {
      id: 'tyres', k: 'TYRES', icon: 'tyre', pinned: !!tyrePin, quiet: !r.tyres,
      v: r.tyres ? (set ? `${esc(set.name)} · ${set.used ? tyreSetMileage(set).km.toFixed(0) + ' KM' : 'NEW'}` : 'NO SET FREE') : 'KEEP',
      n: r.tyres && set && set.used ? `${set.laps} laps on it · ${plan.tyres.why}` : plan.tyres.why,
      sel: [tyreSel],
      opts: [['auto', 'APP'], ['keep', 'KEEP'], ['new', 'NEW SET'], ['pick', 'SELECT SET…']]
    },
    {
      id: 'driver', k: 'DRIVER', icon: 'driver', pinned: !!drvPin, quiet: !drv,
      v: drv ? `→ ${esc(drv.name)}` : 'STAYS IN',
      n: plan.driver.why,
      sel: [!drvPin ? 'auto' : drvPin],
      opts: drvOpts
    },
    {
      id: 'brakes', k: 'BRAKES', icon: 'brake', pinned: !!(brakePin || brakeSetPin),
      quiet: !brakeIds.length,
      v: brakeIds.length
        ? brakeIds.map(id => {
          const set = brakeSetOf(id);
          return `${BRAKE_LABEL[id]} → ${set ? esc(set.name) : 'NO SET'}`;
        }).join(' + ')
        : 'NO WORK',
      n: brakeIds.length
        ? brakeIds.map(id => {
          const set = brakeSetOf(id);
          if (!set) return `${BRAKE_LABEL[id]}: nothing free in the rack`;
          const h = brakeSetHours(car, id, set);
          return `${esc(set.name)} ${set.used ? fmtH(h) + ' on it' : 'new'}`;
        }).join(' · ')
        : BRAKE_COMPONENTS.map(b => `${BRAKE_LABEL[b.id]} ${fmtH(c.brakes[b.id].leftH)}`).join(' · '),
      sel: brakeSel,
      opts: [['auto', 'APP'], ['none', 'NONE'],
        ...BRAKE_COMPONENTS.map(b => [b.id, BRAKE_LABEL[b.id]]),
        ['pick', 'SELECT PARTS…']]
    }
  ];
}

// The rack, opened from SELECT PARTS…: every component the stop is changing,
// with the numbered sets still in its pool. Scrapped parts are not in here.
function brakePicker(car, r) {
  const comps = BRAKE_COMPONENTS.filter(b => r[b.id]);
  if (!comps.length) {
    return `<div class="setpicker"><div class="srow mounted">
      <span class="meta">Nothing to change — pick a component above first.</span></div></div>`;
  }
  const body = comps.map(b => {
    const sets = usableBrakeSets(car, b.id);
    const onCar = car.state.currentBrakeSetId?.[b.id];
    const selId = r.brakeSetIds?.[b.id];
    const rows = sets.map(t => {
      const mounted = t.id === onCar;
      const h = brakeSetHours(car, b.id, t);
      return `<div class="srow ${mounted ? 'mounted' : ''} ${t.id === selId ? 'on' : ''}" ${
        mounted ? '' : `data-bset="${b.id}:${t.id}"`}>
        <span class="nm">${esc(t.name)}</span>
        <span>${mounted ? 'on the car' : t.used ? 'used' : 'new'}</span>
        <span class="meta">${t.used || mounted ? fmtH(h) : 'unused'}</span>
      </div>`;
    }).join('');
    const gone = brakeSetsOf(car, b.id).length - sets.length;
    return `<div class="srow mounted"><span class="nm">${b.label}</span>${
      gone ? `<span class="meta">${gone} scrapped not shown</span>` : ''}</div>${rows}`;
  }).join('');
  return `<div class="setpicker">${body}</div>`;
}

// The stock list, opened from SELECT SET…: everything still in the pool, with
// what each set has already done. Scrapped rubber is not in here at all.
function tyrePicker(car, selectedId) {
  const sets = (car.tyreSets || []).filter(t => !t.scrapped);
  const curId = car.state.currentTyreSetId;
  const rows = sets.map(t => {
    const mil = tyreSetMileage(t);
    const onCar = t.id === curId;
    const left = tyreKmLeft(car, t);
    // The set on the car banks its laps only when it comes off, so read the
    // live counter for it — otherwise it reads "0 laps · 120 km".
    const laps = onCar ? car.state.tyreLapsOnSet : t.laps;
    return `<div class="srow ${onCar ? 'mounted' : ''} ${t.id === selectedId ? 'on' : ''}" ${onCar ? '' : `data-set="${t.id}"`}>
      <span class="nm">${esc(t.name)}</span>
      <span>${onCar ? 'on the car' : t.used ? 'used' : 'new'}</span>
      <span class="meta">${t.used || onCar ? `${laps} laps · ${mil.km.toFixed(0)} km` : 'unused'}${
        !onCar && left != null && t.used ? ` · ${left.toFixed(0)} km left` : ''}</span>
    </div>`;
  }).join('');
  const scrapped = (car.tyreSets || []).length - sets.length;
  return `<div class="setpicker">${rows}${scrapped
    ? `<div class="srow mounted"><span class="meta">${scrapped} scrapped set${scrapped === 1 ? '' : 's'} not shown</span></div>`
    : ''}</div>`;
}

function autofit() {
  const station = document.querySelector('.station');
  if (!station || !station.children.length) return;
  // Hidden while the scoreboard tab is up — offsetHeights read 0 then, so a
  // fit pass would zoom the page to garbage. The last good zoom stays.
  if (station.classList.contains('hidden')) return;
  // scrollHeight/offsetHeight are layout px, unaffected by the current zoom,
  // while innerHeight is real viewport px — so the ratio is the zoom we need.
  // Sum each main-grid column's panels (not the column box itself, which
  // stretches to fill the grid) so the zoom can also grow back after a
  // shrink; the FCY banner and NOW strip stack on top of the tallest column.
  const gapOf = el => parseFloat(getComputedStyle(el).rowGap) || 12;
  const colNeed = col => [...col.children].reduce((s, p) => s + p.offsetHeight, 0)
    + Math.max(0, col.children.length - 1) * gapOf(col);
  const cols = [...station.querySelectorAll(':scope > .main > .col')];
  if (!cols.length) return;
  const aboveMain = [...station.children]
    .filter(el => !el.classList.contains('main') && el.offsetHeight > 0)
    .reduce((s, el) => s + el.offsetHeight + gapOf(station), 0);
  // Chrome outside .station also eats viewport height: the topbar, plus the
  // race-control strip whenever RC messages are showing (it carries a margin,
  // which offsetHeight excludes). Fixed-position elements (modal overlays)
  // don't take flow height.
  const chromeH = [...document.body.children]
    .filter(el => el !== station && el.offsetHeight > 0 &&
      getComputedStyle(el).position !== 'fixed')
    .reduce((s, el) => {
      const cs = getComputedStyle(el);
      return s + el.offsetHeight +
        (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    }, 0);
  const need = Math.max(...cols.map(colNeed)) + aboveMain + chromeH + 26; // grid padding + gap
  // Dead-band control, in real px: re-zoom only when the current zoom clips
  // the bottom or leaves >40px of slack. Content height jitters a little on
  // every render (race-control lines wrap and unwrap, values change width),
  // and reacting to each wiggle makes the whole app visibly resize once a
  // second — worse, a zoom change re-wraps text, feeding the next wiggle.
  // Re-zooming onto ~20px of slack keeps that jitter inside the band.
  const cur = Number(document.body.style.zoom) || 1;
  const innerH = window.innerHeight;
  const realH = need * cur; // need is layout px; × zoom gives real px
  if (realH - innerH > 2 || innerH - realH > 40) {
    const z = Math.max(0.55, Math.min(1, (innerH - 20) / need));
    if (z !== cur) document.body.style.zoom = z;
  }
}
window.addEventListener('resize', autofit);

// Meters read like a fuel gauge: the bar shows what is LEFT and drains as the
// resource is consumed. `left` is the remaining fraction (1 = full, 0 = empty).
function setMeter(el, left) {
  left = Math.max(0, Math.min(1, left));
  el.querySelector('i').style.width = (left * 100).toFixed(1) + '%';
  el.className = 'meter' + (left <= 0.15 ? ' crit' : left <= 0.25 ? ' warn' : '');
}

// Pads and discs share one gauge card, grouped by axle: FRONT shows its disc
// and pad estimates together, then REAR, so the crew reads one end at a glance.
function renderBrakes(c) {
  const wrap = $('brakes');
  if (wrap.children.length === 0) {
    for (const axle of ['Front', 'Rear']) {
      const head = document.createElement('div');
      head.className = 'axlehead';
      head.textContent = axle.toUpperCase();
      wrap.appendChild(head);
      for (const kind of ['discs', 'pads']) {
        const id = kind + axle;
        const div = document.createElement('div');
        div.innerHTML = `
          <div class="kv"><span class="k">${kind === 'discs' ? icon('brake') + ' Discs' : icon('pad') + ' Pads'}
            <b class="setno" data-set="${id}"></b></span><span class="v" data-val="${id}">—</span></div>
          <div class="meter" data-meter="${id}"><i></i></div>`;
        wrap.appendChild(div);
      }
    }
  }
  for (const b of BRAKE_COMPONENTS) {
    const info = c.brakes[b.id];
    const val = wrap.querySelector(`[data-val="${b.id}"]`);
    val.textContent = `${fmtH(info.leftH)} left`;
    val.title = `${fmtH(info.usedH)} used of ${fmtH(info.lifeH)}`;
    val.className = 'v' + (info.pct > 0.9 ? ' crit' : info.pct > 0.75 ? ' warn' : '');
    // The part number on the car — what the crew has to match when it comes off.
    const no = wrap.querySelector(`[data-set="${b.id}"]`);
    no.textContent = info.setName || '';
    no.title = info.setName ? `${b.label} on the car: ${info.setName}` : '';
    setMeter(wrap.querySelector(`[data-meter="${b.id}"]`), 1 - info.pct);
  }
}

function renderDrivers(car, c) {
  const wrap = $('drivers');
  wrap.innerHTML = '';
  const reg = c.reg;
  car.drivers.forEach((d, i) => {
    const cur = d.id === car.currentDriverId;
    const total = d.totalMs + (cur ? c.stintElapsedMs : 0);
    const row = document.createElement('div');
    row.className = 'drv-row' + (cur ? ' cur' : '');
    row.innerHTML = `
      <span class="dot" style="background:${DRIVER_COLORS[i % DRIVER_COLORS.length]}"></span>
      <span class="nm">${cur ? icon('play') + ' ' : ''}${esc(d.name)}</span>
      <span class="badge${d.doubleStint ? '' : ' off'}" title="double stints ${d.doubleStint ? 'yes' : 'no'}">${icon('ff')}</span>
      <span class="badge${d.night ? '' : ' off'}" title="night driving ${d.night ? 'yes' : 'no'}">${icon('moon')}</span>
      <span class="badge${d.rain ? '' : ' off'}" title="rain ${d.rain ? 'yes' : 'no'}">${icon('rain')}</span>
      <span class="tm num">${fmtClock(total)}</span>`;
    wrap.appendChild(row);

    // Drive-time regulation bookkeeping, one compact line per driver.
    const r = reg?.enabled ? reg.byDriver[d.id] : null;
    if (r) {
      const bits = [];
      if (reg.limits.max6hMs) bits.push(`6h ${fmtH(r.windowMs / 3600e3)} / ${fmtH(reg.limits.max6hMs / 3600e3)}`);
      if (reg.limits.maxTotalMs) bits.push(`total ${fmtH(r.totalMs / 3600e3)} / ${fmtH(reg.limits.maxTotalMs / 3600e3)}`);
      if (r.resting) bits.push(`rest ${fmtMinSec(r.restLeftMs)} more`);
      const over = r.over6h || r.overTotal;
      const nearMs = r.driveLeftMs;
      const cls = over ? ' crit' : r.resting || (nearMs != null && nearMs < 30 * 60e3) ? ' warn' : '';
      const line = document.createElement('div');
      line.className = 'regline' + cls;
      line.innerHTML = (over ? icon('warn') + ' OVER LIMIT · ' : '') + bits.join(' · ');
      wrap.appendChild(line);
    }
  });
}

function renderTimeline(car, now) {
  const svg = $('timeline');
  const race = state.race;
  const clock = raceClock(race, now);
  // Draw in real pixels (viewBox = client size): a fixed 1000-unit canvas
  // stretched to the panel width distorts everything, most visibly the text.
  // Fallback size covers the svg being display:none while another tab is up.
  const W = svg.clientWidth || 1000, H = svg.clientHeight || 150;
  const barY = 36, barH = H - 82; // 82 = tick labels above + NOW/legend below
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const x = ms => (ms / clock.totalMs) * W;
  let parts = [];

  // time grid — colors via style="…var(--x)" so the SVG follows the theme
  // (CSS variables don't work in bare fill/stroke presentation attributes).
  // The tick step adapts to the session length (feed sessions can be 30 min
  // as well as 24 h): smallest step that keeps the axis under ~14 ticks.
  const durH = clock.totalMs / 3600e3;
  const stepH = [1 / 12, 0.25, 0.5, 1, 2].find(s => durH / s <= 14) ?? Math.ceil(durH / 14);
  for (let i = 0; i * stepH <= durH + 1e-9; i++) {
    const h = i * stepH;
    const px = x(h * 3600e3);
    const label = stepH >= 1 ? `${h}h` : `${Math.round(h * 60)}m`;
    parts.push(`<line x1="${px}" y1="${barY - 8}" x2="${px}" y2="${barY + barH + 8}" style="stroke:var(--line)" stroke-width="1"/>`);
    parts.push(`<text x="${px + 3}" y="${barY - 12}" style="fill:var(--dim)" font-size="13">${label}</text>`);
  }
  parts.push(`<rect x="0" y="${barY}" width="${W}" height="${barH}" style="fill:var(--well)" rx="4"/>`);

  const driverIdx = {};
  car.drivers.forEach((d, i) => (driverIdx[d.id] = i));

  if (clock.running) {
    for (const b of projectStints(car, race, now)) {
      const from = Math.max(0, b.from);
      const to = Math.min(clock.totalMs, b.to);
      if (to <= from) continue;
      let fill = 'var(--tl-future)', opacity = 1;
      if (b.kind === 'past' || b.kind === 'current') {
        fill = DRIVER_COLORS[(driverIdx[b.driverId] ?? 0) % DRIVER_COLORS.length];
      } else if (b.kind === 'projected') {
        fill = DRIVER_COLORS[(driverIdx[b.driverId] ?? 0) % DRIVER_COLORS.length];
        opacity = 0.35;
      } else {
        opacity = 0.55;
      }
      parts.push(`<rect x="${x(from)}" y="${barY + 2}" width="${Math.max(1, x(to) - x(from) - 1)}" height="${barH - 4}" style="fill:${fill}" opacity="${opacity}" rx="2"/>`);
      if (b.kind === 'future' || b.kind === 'projected') {
        parts.push(`<line x1="${x(to)}" y1="${barY - 4}" x2="${x(to)}" y2="${barY + barH + 4}" style="stroke:var(--red)" stroke-width="2"/>`);
      }
    }
    // Plan overlay: amber markers where the shared stint plan expects each
    // stop, so plan-vs-projection divergence is visible at a glance.
    if (car.plan?.stints?.length) {
      for (const s of car.plan.stints) {
        if (!(s.toMs > 0) || s.toMs >= clock.totalMs) continue;
        const px = x(s.toMs);
        parts.push(`<path d="M ${px - 4} ${barY - 9} l 4 7 l 4 -7 z" style="fill:var(--amber)"/>`);
      }
    }
    // now marker
    const nowX = x(clock.elapsedMs);
    parts.push(`<line x1="${nowX}" y1="${barY - 10}" x2="${nowX}" y2="${barY + barH + 10}" style="stroke:var(--text)" stroke-width="2"/>`);
    parts.push(`<text x="${Math.min(nowX + 4, W - 44)}" y="${barY + barH + 24}" style="fill:var(--text)" font-size="13">NOW</text>`);
    parts.push(`<text x="0" y="${H - 4}" style="fill:var(--dim)" font-size="13">solid = driven · faded = projected · red ticks = pit stops${car.plan?.stints?.length ? ' · amber = plan' : ''}</text>`);
  } else if (clock.scheduled) {
    parts.push(`<text x="${W / 2}" y="${barY + barH / 2 + 4}" style="fill:var(--amber)" font-size="14" text-anchor="middle">Race starts in ${fmtClock(clock.msToStart)}</text>`);
  } else {
    parts.push(`<text x="${W / 2}" y="${barY + barH / 2 + 4}" style="fill:var(--dim)" font-size="14" text-anchor="middle">Race not started — waiting for pit wall</text>`);
  }
  svg.innerHTML = parts.join('');
}

// re-render every second so clocks/accruals tick between broadcasts
setInterval(render, 1000);
