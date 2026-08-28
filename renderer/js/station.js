// Car strategy station (PCs 1-4). Connects to the pit wall server, shows the
// live strategy picture for one car and lets the engineer plan the next stop.

import {
  PORT, CONDITIONS, BRAKE_COMPONENTS, BRAKE_AXLES, DRIVER_COLORS,
  carCalcs, raceClock, projectStints, defaultDriver, stintStartOf, flagPeriods, drivenMs,
  stopServiceTime, fcyCalc, fuelStrategy, pitLaneCalc, pitEta, generatePlan,
  normalizeCurve, burnAtLapTime, emptyCurvePoint, LAP_AVG_WINDOW,
  paceWindowStats, paceWindowLaps, PACE_WINDOW_MIN, PACE_WINDOW_MAX,
  currentTyreSet, stopTyreSet, replanFromNow, planVsActual, stintStats, learnedOf,
  plannedNextStintIndex, planDriverIssues, planBlockers, PLAN_STINT_CAP,
  tyreSetMileage, tyreLifeLapsOf, tyreKmLeft,
  warmableTyreSets, TYRE_WARMER_MAX,
  newTyreSet, tyreCompoundOf, generateTyreSets, TYRE_SET_PATTERN, TYRE_SET_GEN_MAX,
  generateBrakeSets, nextSetNumber, BRAKE_SET_PATTERN,
  brakeSetsOf, usableBrakeSets, brakeSetHours,
  brakeAxle, brakeKitsOf, kitOfDiscSet, freePadSets, currentBrakeSet,
  stopBrakeAxle, brakeAxleWork, brakeWorkComps,
  recommendedStops, resolveStop, PLAN_KEYS, PLAN_LABEL, activePlanKey, stopPins, wallShowsPlan, cautionCall, tyreBudget,
  cautionSweep, CAUTION_DECISIVE_SEC, flagRuleCall,
  fmtClock, fmtMinSec, fmtLap, fmtH,
  TIMING_FLAGS, fmtLapUs, fmtGapUs, timingNrOf, ourTimingNrs, createFeedSeen, carPickLabel,
  driverAbbrev, matchTimingDriver, fuelBreakEven, pitCostSec, refuelTimeSec, isNightAt,
  defaultCar, defaultCarNumber, deepMerge, reconcileTyreSets, reconcileBrakeSets,
  buildCarFile, readCarFile, applyCarFile, carFileName
} from '../../shared/model.js';
import { connect } from './net.js';
import { renderConditionBar, initConditionControls, renderConditionControls } from './condition.js';
import { icon, applyIcons } from './icons.js';
import {
  initTheme, mountThemeSettings, mountUiSizeSettings,
  getUiZoom, clampUiZoom, maxUiZoom, noteUiFit, UI_AUTO_FLOOR
} from './theme.js';
import { initHelpToggles } from './help.js';
import { createTracker } from './trackmap.js';
import { createRcPanel } from './rcmsg.js';
import { initFaces, initExpand, facesAfterRender, closeFocus } from './faces.js';

applyIcons();
initTheme();
mountThemeSettings();
mountUiSizeSettings(() => autofit());
initHelpToggles();

const esc = s => String(s).replace(/</g, '&lt;');

const carId = localStorage.getItem('carId') || '1';
const serverIp = localStorage.getItem('serverIp') || '127.0.0.1';
const serverPort = localStorage.getItem('serverPort') || PORT; // override used by tests

const $ = id => document.getElementById(id);

// Cards that carry more than one reading, and the ⤢ that throws one up at
// garage-reading size. Both are this screen's own choice — scoped to the car
// so a PC that has run two stations remembers each separately — and neither
// touches the shared state: what a screen is looking at is not race truth.
initFaces(document, { scope: carId, onChange: () => render() });
initExpand(document);

let state = null;
let timing = null;
let timingRxMs = 0; // when the last timing snapshot arrived (for E.T.A. ticking)
let stateRxMs = 0; // when the last state snapshot arrived — fuel countdowns tick against it between broadcasts
let feedDriverId = null; // roster driver the timing feed currently reads in the car
const feedSeen = createFeedSeen(); // timing nrs the feed has posted this session

// The pit-lane machines only show the newest three messages; the full log
// stays one HISTORY tap away.
const rcPanel = createRcPanel({ limit: 3 });

const net = connect({
  url: `ws://${serverIp}:${serverPort}`,
  onState: s => { state = s; stateRxMs = Date.now(); tracker.setData(s, null); render(); },
  onTiming: t => {
    timing = t;
    timingRxMs = Date.now();
    feedSeen.update(t);
    tracker.setData(null, t, timingRxMs);
    renderTiming();
    renderScoreboard();
    rcPanel.update(t);
  },
  onMessage: m => {
    if (m.type !== 'carFileResult') return;
    if (!m.ok) return carFileStatus('The pit wall refused the file: ' + (m.error || 'unknown error'), 'warn');
    carFileStatus(`Loaded onto ${m.name} — ${(m.applied || []).join(', ')}.` +
      ((m.warnings || []).length ? ' ' + m.warnings.join(' ') : ''),
      (m.warnings || []).length ? 'warn' : 'good');
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

// Car names in the picker follow the shared state — they can be renamed on the
// pit wall or any station mid-race. The start screen does not share this: it
// has no state to follow, so it names the four entries outright.
function renderCarPicker() {
  for (const opt of $('conn-car').options) {
    const c = state.cars[opt.value];
    if (!c) continue;
    const label = carPickLabel(opt.value, c);
    if (opt.textContent !== label) opt.textContent = label;
  }
}

const send = msg => net.send({ carId, ...msg });
const patchCar = patch => send({ type: 'update', patch });
const patchStop = patch => patchCar({ nextStop: patch });

// ---- the car the SETTINGS pages act on --------------------------------------
// Everything on those pages is car-specific work that is done BEFORE the event:
// the driver line-up, the consumption figures, the tyre allocation, the brake
// rack. None of it could be typed without a live link, because the pages are a
// view of the car on the pit wall and there is no car until a station connects
// — which is exactly backwards for the week before a 24h, when the pit wall is
// in a flight case.
//
// So a station that has never reached a pit wall edits a DRAFT car instead:
// this PC's own copy, kept in the browser store, saved out as a car file and
// loaded onto the real car when the box is built. The moment a real state
// arrives the pages point at the real car and the draft is left alone.
const DRAFT_KEY = 'carDraft:' + carId;

function loadDraft() {
  const base = defaultCar(carId, defaultCarNumber(carId));
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      deepMerge(base, JSON.parse(raw));
      reconcileTyreSets(base);
      reconcileBrakeSets(base);
    }
  } catch { /* a half-written draft is not worth a dead settings page */ }
  return base;
}

let draft = loadDraft();

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch { /* private mode / full store: the page still works, the draft just does not survive */ }
}

// The car the settings pages read, and whether they are on the draft.
const settingsCar = () => (state ? state.cars[carId] : draft);
const onDraft = () => !state;

// A settings edit goes wherever those pages are pointed. Live, that is the
// wall (which echoes it back); on the draft it is applied here and nothing is
// sent — a draft is a file being written, not a car being run.
function patchSettings(patch) {
  if (state) return patchCar(patch);
  deepMerge(draft, patch);
  if (patch.config?.tyreSets != null || patch.tyreSets) reconcileTyreSets(draft);
  if (patch.config?.brakeSets || patch.brakeSets) reconcileBrakeSets(draft);
  saveDraft();
  renderDraftSettings();
}

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
  // An expanded card belongs to the strategy grid — leaving it up would float
  // it over the scoreboard, and its placeholder would hold a gap behind.
  closeFocus();
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

// The lap count set to what the car has actually run. Always available —
// with the feed live it corrects a miscount, with the feed dead it is how a
// stint that nobody logged through gets its laps back. It is not a display
// figure: the stint, the tyre on the car and its mileage all move with it.
$('btn-lap-correct').addEventListener('click', () => {
  const v = parseInt($('lap-correct').value, 10);
  const now = state?.cars?.[carId]?.state.totalLaps ?? 0;
  if (Number.isFinite(v) && v >= 0 && v !== now &&
      confirm(`Set total laps to ${v} (from ${now})? Tyre wear and the stint move with it.`)) {
    send({ type: 'setLaps', laps: v });
  }
  $('lap-correct').value = '';
});

$('lap-catchup').addEventListener('click', e => {
  if (e.target.dataset.lapnote) send({ type: 'clearLapNote' });
});

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
  // The feed is showing a different session than this race: until that is
  // settled nothing from the feed counts — so lap logging comes back to the
  // crew. A session that is starting now settles itself in a second (the app
  // saves this race and rolls onto it); anything else the pit wall answers.
  const held = !!state.timing?.sessionAlert;
  const connected = timing?.conn === 'connected';
  const feedDriving = auto && connected && !held;
  $('lap-panel').hidden = feedDriving;
  $('lap-auto-note').hidden = !(connected && !auto);
  $('lap-feed-mode').textContent = feedDriving
    ? `feed · ${car.state.totalLaps} laps`
    : `manual · ${car.state.totalLaps} laps`;

  // A lap count that jumps has to say why it jumped: either the laps run
  // during a feed outage have just been put back, or the feed and the sheet
  // are too far apart for that to have been done blind and the crew has to
  // settle it. Stays up until it has been read.
  const cu = car.state.lapCatchUp;
  const note = $('lap-catchup');
  note.hidden = !cu;
  if (cu) {
    const dismiss = '<button data-lapnote="ok" style="padding:2px 8px;margin-left:8px">OK</button>';
    note.innerHTML = cu.laps > 0
      ? `${cu.laps} lap${cu.laps === 1 ? '' : 's'} put back — run while the timing feed was down.${dismiss}`
      : `The feed counts ${cu.gap} laps more than this sheet — too far apart to put back by itself. ` +
        `Check what the car has really run and correct it below.${dismiss}`;
  }

  const stateEl = $('lt-state');
  // A race that reset itself under the crew has to say why: the session it was
  // running on ended and this one started. Said for the first minutes of the
  // new session — long enough to be read at the stations, not so long that it
  // sits over the flag and the clock for the rest of the race.
  const rolled = state.timing?.sessionRolled;
  const rolledFresh = !held && rolled && Date.now() - rolled.ms < 300e3;
  if (held) {
    const a = state.timing.sessionAlert;
    stateEl.textContent = a.pending
      ? `NEW SESSION ON THE FEED — "${a.to}" · reading what it is (feed held)`
      : `NEW SESSION ON THE FEED — "${a.to}" · answer on the pit wall (feed held)`;
    stateEl.className = 'v warn';
  } else if (rolledFresh) {
    stateEl.textContent = `NEW SESSION "${rolled.to}" — fresh race started, the old one was saved`;
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
  feedDriverId = rec ? rec.id : null;
  if (rec && rec.id !== car.currentDriverId) {
    feedTag.hidden = false;
    feedTag.className = 'sub drvfeed warn';
    // The disagreement is worth nothing on its own — a tag that only reports
    // it leaves the sheet wrong for the rest of the race. The name the feed
    // reads is one tap from being the name in the car.
    feedTag.innerHTML = `${icon('warn')} feed: ${esc(rec.name)} ` +
      `<button class="seatbtn" data-act="seat" data-drv="${esc(rec.id)}">SEAT THEM</button>`;
    feedTag.title = `Live timing shows "${e.driver}" in the car. SEAT THEM moves the seat without logging a stop; a change made AT a stop belongs in the stop planner.`;
  } else if (rec) {
    feedTag.hidden = false;
    feedTag.className = 'sub drvfeed ok';
    feedTag.innerHTML = `${icon('check')} feed`;
    feedTag.title = `Live timing agrees: ${rec.name} ("${e.driver}") is in the car.`;
  } else {
    feedTag.hidden = true;
  }

  renderAround(e);
  trackSectors(e);
  renderSectors(e);
}

// ---- sectors --------------------------------------------------------------
// A lap time says the car is three tenths off. The sectors say whether that is
// one corner, a tyre letting go at the end of the lap, or a driver who has not
// found the second half yet — and against the class best, whether the deficit
// is the driver or the car.
//
// The wire only ever carries a car's CURRENT sector times, so the session best
// has to be accumulated here. It is a reading OF the feed, not race state, so
// it stays on this screen and resets with the session rather than being pushed
// to the wall.
const sectorBest = { session: '', own: [null, null, null, null], cls: [null, null, null, null] };

function trackSectors(own) {
  const sess = (timing?.session?.name || '') + '|' + (timing?.conn || '');
  if (sess !== sectorBest.session) {
    sectorBest.session = sess;
    sectorBest.own = [null, null, null, null];
    sectorBest.cls = [null, null, null, null];
  }
  if (!own) return;
  // Class best, not overall: an LMP2 sector is no reference for a GT3, and the
  // number the crew is judged against is the one their own class is running.
  // With no class on the feed the whole field is the comparison.
  const ownCls = own.cls || null;
  for (const e of timing?.entries || []) {
    const mine = e === own;
    const sameClass = !ownCls || e.cls === ownCls;
    if (!mine && !sameClass) continue;
    const s = [e.s1, e.s2, e.s3, e.s4];
    for (let i = 0; i < 4; i++) {
      if (!(s[i] > 0)) continue;
      if (mine && (sectorBest.own[i] == null || s[i] < sectorBest.own[i])) sectorBest.own[i] = s[i];
      if (sameClass && (sectorBest.cls[i] == null || s[i] < sectorBest.cls[i])) sectorBest.cls[i] = s[i];
    }
  }
}

// A sector is under a minute on any circuit worth the name, so the "0:" that
// fmtLapUs prints for a lap is just noise here.
function fmtSectUs(us) {
  const n = parseInt(us, 10);
  if (isNaN(n) || n <= 0 || n > 9e18) return '—';
  return n < 60e6 ? (n / 1e6).toFixed(3) : fmtLapUs(n);
}

// Signed difference in seconds. `good` at or below zero — for the last lap
// that means it just set our best, for the class column that we hold it.
function sectDelta(us, refUs) {
  if (!(us > 0) || !(refUs > 0)) return '<td class="num"></td>';
  const d = (us - refUs) / 1e6;
  const cls = d <= 0.001 ? 'good' : d < 0.3 ? '' : d < 1 ? 'warn' : 'crit';
  return `<td class="num ${cls}">${d <= 0.001 ? '—' : '+' + d.toFixed(2)}</td>`;
}

function renderSectors(own) {
  const body = $('sect-body');
  const empty = $('sect-empty');
  const hasFeed = timing?.conn === 'connected' || timing?.conn === 'replay';
  const last = own ? [own.s1, own.s2, own.s3, own.s4] : [null, null, null, null];
  // However many sectors this circuit and this feed actually report.
  const used = [0, 1, 2, 3].filter(i =>
    last[i] > 0 || sectorBest.own[i] != null || sectorBest.cls[i] != null);

  if (!hasFeed || !used.length) {
    body.innerHTML = '';
    $('sect-theo').textContent = '--:--.-';
    $('sect-hand').textContent = '—';
    empty.hidden = false;
    empty.textContent = !hasFeed
      ? 'Live timing is off — connect the feed on the pit wall.'
      : own ? 'This feed carries no sector times.'
        : 'Waiting for this car on the feed.';
    return;
  }
  empty.hidden = true;

  body.innerHTML = used.map(i => `
    <tr>
      <td class="lab">S${i + 1}</td>
      <td class="num">${fmtSectUs(last[i])}</td>
      <td class="num">${fmtSectUs(sectorBest.own[i])}</td>
      ${sectDelta(last[i], sectorBest.own[i])}
      <td class="num">${fmtSectUs(sectorBest.cls[i])}</td>
      ${sectDelta(sectorBest.own[i], sectorBest.cls[i])}
    </tr>`).join('');

  // Our best sectors added up: the lap this car has already shown it can do.
  // Only worth printing once every sector has a best — a partial sum reads as
  // an impossibly quick lap.
  const complete = used.every(i => sectorBest.own[i] != null);
  const theo = complete ? used.reduce((s, i) => s + sectorBest.own[i], 0) : null;
  $('sect-theo').textContent = theo ? fmtLapUs(theo) : '--:--.-';
  const bestLap = own?.bestUs;
  $('sect-hand').textContent = theo && bestLap > 0
    ? `${fmtLapUs(bestLap)} · ${((bestLap - theo) / 1e6).toFixed(2)} s in hand`
    : bestLap > 0 ? fmtLapUs(bestLap) : '—';
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

// Same shape as the fuel correction: type the truth, press SET, done. The
// server moves the set's banked mileage with the laps so they never disagree.
$('btn-tyre-laps-correct').addEventListener('click', () => {
  const v = parseInt($('tyre-laps-correct').value, 10);
  if (Number.isFinite(v) && v >= 0) send({ type: 'setTyreLaps', laps: v });
  $('tyre-laps-correct').value = '';
});

// The pace window lives in the car's config, so every screen on this car reads
// the same average — the engineer sets it once, on the card itself.
$('pace-laps').addEventListener('change', () => {
  const el = $('pace-laps');
  const v = Math.round(parseFloat(el.value));
  if (isNaN(v)) return render();
  patchCar({ config: { paceAvgLaps: Math.max(PACE_WINDOW_MIN, Math.min(PACE_WINDOW_MAX, v)) } });
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
// THREE PLANS, NOT ONE. Green, code 60 and safety car each keep their own
// pinned lines and their own approval, because they are different work orders:
// under a code 60 the stop is nearly free, so it takes everything — full tank,
// tyres, driver — while the green plan next to it may be a splash and go. The
// tabs switch which of the three you are writing; they do not re-dress a single
// plan. Every line of the one on screen either follows the app or is pinned by
// the engineer, and pinning one line never freezes the others: they keep
// tracking the race. Nothing here is a form to fill in; it is an answer to
// accept or change.

let pickSetOpen = false;  // tyre stock list open under the TYRES line
let pickBrakeOpen = false; // rack list open under the BRAKES line
let fuelSetL = 0;         // last hand-typed fuel figure
// Which of the three is on screen. Kept here so every pin names the plan it
// belongs to: a yellow dropping between the tap and the message must not drop
// a pin into a different plan than the one being read.
let planTab = 'green';

const pinStop = (field, value) => send({ type: 'pinStop', plan: planTab, field, value });

$('plan-tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-plan]');
  if (!b || !state) return;
  pickSetOpen = false;
  pickBrakeOpen = false;
  // Tapping the tab that is already held hands the card back to the race:
  // it follows whatever is flying again. Same tap in, same tap out.
  const held = state.cars[carId].nextStop.plan;
  send({ type: 'stopPlan', plan: held === b.dataset.plan ? null : b.dataset.plan });
});

// Take the situation on screen off the wall's grab list, or put it back. The
// plan is untouched either way — this is only about whether the crew carries a
// column for a flag that is not flying.
$('plan-wall').addEventListener('click', e => {
  const b = e.target.closest('button[data-wall]');
  if (!b || !state) return;
  send({ type: 'wallPlan', plan: planTab, show: b.dataset.wall === 'show' });
});

// "Follow the race again" — the way out of a held tab that does not require
// knowing the tab is a toggle.
$('plan-hold').addEventListener('click', e => {
  if (e.target.closest('[data-follow]')) send({ type: 'stopPlan', plan: null });
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

  // a kit in the brake rack — both numbers are pinned in one tap, because a
  // kit is one part as far as the crew is concerned.
  const krow = e.target.closest('[data-bkit]');
  if (krow) {
    const [axleId, discId] = krow.dataset.bkit.split(':');
    const a = brakeAxle(axleId);
    const kit = a && kitOfDiscSet(car, axleId, discId);
    if (!kit) return;
    const pin = { ...(stopPins(car, planTab).brakeSets || {}) };
    // Tapping the kit already chosen hands the pick back to the app.
    if (pin[a.discs] === kit.disc.id) { delete pin[a.discs]; delete pin[a.pads]; }
    else { pin[a.discs] = kit.disc.id; pin[a.pads] = kit.pad.id; }
    pinStop('brakeSets', Object.keys(pin).length ? pin : null);
    return render();
  }

  // a row in the brake rack — one component group's numbered set. The list
  // stays open: a stop often changes more than one group.
  const brow = e.target.closest('[data-bset]');
  if (brow) {
    const [comp, setId] = brow.dataset.bset.split(':');
    const pin = { ...(stopPins(car, planTab).brakeSets || {}) };
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
    // One axle at a time: PADS onto the discs on the car, or the whole KIT.
    // Tapping what is already called for takes that axle back out of the stop.
    const [axleId, mode] = val.split(':');
    const a = brakeAxle(axleId);
    if (!a) return;
    const work = brakeAxleWork(stopPins(car, planTab).brakes || plannedBrakes(car));
    work[axleId] = work[axleId] === mode ? 'none' : mode;
    const next = brakeWorkComps(work);
    // A part no longer being changed has no number to pick.
    const pin = { ...(stopPins(car, planTab).brakeSets || {}) };
    let dropped = false;
    for (const comp of [a.pads, a.discs]) {
      if (!next.includes(comp) && pin[comp]) { delete pin[comp]; dropped = true; }
    }
    if (dropped) pinStop('brakeSets', Object.keys(pin).length ? pin : null);
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
  // the axle's NO / PADS / KIT inside the correction form flips in place
  const bw = e.target.closest('[data-fixwork]');
  if (bw) {
    const box = bw.closest('[data-fixaxle]');
    box.dataset.work = bw.dataset.fixwork.split(':')[1];
    for (const b2 of box.querySelectorAll('[data-fixwork]')) b2.classList.toggle('on', b2 === bw);
    return;
  }

  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'undo') send({ type: 'undoStop' });
  else if (act === 'apply') send({ type: 'applyStop' });
  else if (act === 'confirm') send({ type: 'confirmStop' });
  else if (act === 'dispute') send({ type: 'disputeStop' });
  else if (act === 'dismisspit') { pitVisitKey = ''; send({ type: 'clearPitNote' }); }
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
    for (const box of el.querySelectorAll('[data-fixaxle]')) {
      const a = brakeAxle(box.dataset.fixaxle);
      if (!a) continue;
      const work = box.dataset.work;
      for (const comp of [a.pads, a.discs]) {
        service[comp] = work === 'kit' || (work === 'pads' && comp === a.pads);
        // Only a part that really was changed carries a number.
        const sel = box.querySelector(`[data-fixbset="${comp}"]`);
        service.brakeSetIds[comp] = service[comp] ? (sel?.value || null) : null;
      }
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
  // The tick is for the plan on screen — the other two keep their own.
  send({ type: b.dataset.approve === 'yes' ? 'approveStop' : 'unapproveStop', plan: planTab });
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
    // Clears the situation on screen only — the other two plans stand.
    case 'clear': send({ type: 'clearStop', plan: planTab }); break;
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
$('btn-settings').addEventListener('click', () => {
  overlay.classList.remove('hidden');
  renderDraftSettings(); // with no pit wall, nothing else draws this page
  // With one, the pane is filled by render() — draw it now rather than at the
  // next state push, so opening SETTINGS never shows an empty rack for a tick.
  render();
});
$('btn-settings-close').addEventListener('click', () => overlay.classList.add('hidden'));
// No click-outside close. Settings is a form the crew works through a field at
// a time — half a tyre pool typed in, the cursor in a number — and a stray
// click on the backdrop that throws the page away is not a shortcut anyone
// asked for. CLOSE is the way out.

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

// A setting is only really set once the pit wall echoes it back: the state on
// screen is the wall's, and every render writes it back over these fields. So
// an edit is held here until the echo arrives — that way a render mid-edit
// cannot undo it, and an edit that never lands (a station whose link died) is
// marked instead of quietly snapping back to the old number, which reads as
// "this PC won't let me type".
const SETTING_ACK_MS = 6000;
const pendingSettings = new Map(); // data-path -> { value, sentMs }

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
    inp.classList.remove('unsent');
    if (!onDraft()) pendingSettings.set(inp.dataset.path, { value: val, sentMs: Date.now() });
    patchSettings(patch);
  });
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// ---- the neutralisation call, edited on the card itself -------------------
// These three live on the card rather than in SETTINGS because they are read
// and argued about while a flag is out, not configured once before the race.
const cautionPanel = $('caution-cfg');
const cautionCog = $('btn-caution-cfg');

cautionCog.addEventListener('click', () => {
  const open = cautionPanel.hasAttribute('hidden');
  cautionPanel.toggleAttribute('hidden', !open);
  cautionCog.classList.toggle('on', open);
  cautionCog.closest('.panel').classList.toggle('cfg-open', open);
  if (open) {
    fillCautionInputs();
    // Answer straight away rather than waiting for the next state push — the
    // panel is opened to read it, and a blank card looks broken.
    const car = state?.cars[carId];
    if (car) { renderCautionOut(car); renderCautionGraph(car); renderFlagRule(car); }
  }
});

for (const inp of cautionPanel.querySelectorAll('input[data-cpath]')) {
  inp.addEventListener('change', () => {
    const val = parseFloat(inp.value);
    if (isNaN(val)) return;
    // Paths may be nested (avgLapSec.dry), so build the patch down to the leaf.
    const parts = inp.dataset.cpath.split('.');
    const cfgPatch = {};
    let node = cfgPatch;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] = {};
    node[parts[parts.length - 1]] = val;
    patchSettings({ config: cfgPatch });
  });
}

$('flagrule-on').addEventListener('change', () => {
  patchSettings({ config: { flagRule: { on: $('flagrule-on').checked } } });
});

function fillCautionInputs() {
  const cfg = settingsCar()?.config;
  if (!cfg) return;
  for (const inp of cautionPanel.querySelectorAll('input[data-cpath]')) {
    // Never fight the field being typed into.
    if (document.activeElement !== inp) inp.value = getPath(cfg, inp.dataset.cpath) ?? 0;
  }
  $('flagrule-on').checked = !!cfg.flagRule?.on;
}

// What the crew's own points are doing right now: which of them is reached,
// what the card would say under a flag, and — when the switch is on over an
// empty form — that nothing has actually been overruled.
function renderFlagRule(car) {
  const out = $('flagrule-out');
  if (!out || cautionPanel.hasAttribute('hidden')) return;
  const r = car.config.flagRule;
  const wrap = out.closest('.ownpoints');
  wrap?.classList.toggle('on', !!r?.on);
  if (!r?.on) {
    out.innerHTML = '<span class="hint">Off — the ranking above is making the call.</span>';
    return;
  }
  const c = carCalcs(car, state.race, Date.now());
  const call = flagRuleCall(car, c);
  if (!call || call.empty) {
    out.innerHTML = `<span class="warn">${icon('alert')} Nothing is set — write a fuel level or a stint ` +
      'time, or the ranking above keeps the call.</span>';
    return;
  }
  const fuelNow = car.state.fuelLiters;
  const stintNow = Math.floor(c.stintElapsedMs / 60e3);
  const now = `<span class="hint">Now: ${fuelNow.toFixed(0)} L on board, ${stintNow} min into the stint.</span>`;
  out.innerHTML = call.box
    ? `<span class="good">${icon('check')} A flag now would be <b>BOX` +
      `${call.tyres ? ' · FUEL + TYRES' : ''}</b> — ${esc(call.why)}.</span><br>${now}`
    : `<span>${icon('pause')} A flag now would be <b>STAY OUT</b>` +
      (call.msToPoint != null ? ` — your first point comes up in ${fmtMinSec(call.msToPoint)}` : '') +
      `.</span><br>${now}`;
  applyIcons(out);
}

// Both flags, side by side: they differ a lot, and the standing call for the
// next one is what the crew actually wants off this panel.
function renderCautionOut(car) {
  const out = $('caution-out');
  if (!out || cautionPanel.hasAttribute('hidden')) return;
  if (!(car.config.tyreDegSecPerKm > 0)) {
    out.innerHTML = '<p class="hint">Set a tyre wear figure to get an answer — ' +
      'without it the call cannot see what old rubber costs.</p>';
    return;
  }
  const rate = car.config.cautionsPerHour || 0;
  out.innerHTML = ['fcy', 'sc'].map(pace => {
    let r = null;
    try { r = cautionCall(car, state.race, Date.now(), pace); } catch { r = null; }
    const label = pace === 'fcy' ? 'CODE 60' : 'SAFETY CAR';
    if (!r) return `<div class="row"><span class="k">${label}</span><span class="v">—</span></div>`;
    const be = r.breakEven == null ? '> 5.00' : r.breakEven.toFixed(2);
    const take = rate > 0 ? r.takeIt : true;
    // A margin this small is inside the noise of the inputs it was built from.
    // Calling it either way would read as a decision the maths has not earned,
    // so it is shown as what it is and the crew decides on everything else.
    const lineBall = r.marginSec < 2;
    const head = lineBall
      ? `${label} — LINE BALL${take ? ` · ${esc(r.winner.label.toLowerCase())} if you box` : ''}`
      : `${label} — ${take ? `TAKE IT · ${esc(r.winner.label.toLowerCase())}` : 'STAY OUT'}`;
    // When each kind of stop starts to pay, measured on the stint clock the
    // crew is already reading. A call that says stay out is only half an
    // answer without it — the other half is how long they are waiting.
    let sw = null;
    try { sw = cautionSweep(car, state.race, Date.now(), pace); } catch { sw = null; }
    const whenRow = (key, label) => {
      const at = sw?.first?.[key];
      const txt = at == null ? 'not this stint'
        : at <= sw.nowMin ? `paying now (from min ${Math.round(at)})`
        : `from min ${Math.round(at)}`;
      return `<div class="row"><span class="k">${label}</span><span class="v">${txt}</span></div>`;
    };
    return `<div class="verdict ${lineBall ? 'even' : take ? 'take' : 'hold'}">${head}</div>
      <div class="row"><span class="k">break-even rate</span><span class="v">${be} /h</span></div>
      <div class="row"><span class="k">beats next best by</span><span class="v">${
        lineBall ? 'under 2 s — too close to call' : r.marginSec.toFixed(1) + ' s'}</span></div>` +
      (sw ? whenRow('fuel', 'fuel only pays') + whenRow('both', 'fuel + tyres pays') +
        `<div class="row"><span class="k">stint clock</span><span class="v">min ${Math.round(sw.nowMin)}</span></div>` : '');
  }).join('<div style="height:8px"></div>') +
    `<div class="row"><span class="k">your rate</span><span class="v">${
      rate > 0 ? rate.toFixed(2) + ' /h' : 'not set'}</span></div>` +
    tyreBudgetRow(car);
}

// ---- the calculation, drawn ------------------------------------------------
// The verdict above is one point on a curve. This is the whole curve: what
// each option is worth against staying out at every minute of the stint, so
// the crew can see WHY the answer is what it is — and, when it says stay out,
// how long they are waiting for that to change.

// Which flag the graph is drawn for. Follows the live one until the engineer
// picks, then stays where it was put.
let cautionGraphPace = null;
let cautionGraphTable = false;

const CC_SERIES = [
  { key: 'fuel', label: 'Fuel only', css: '--cc-fuel' },
  { key: 'tyres', label: 'Tyres only', css: '--cc-tyres' },
  { key: 'both', label: 'Fuel + tyres', css: '--cc-both' }
];

function renderCautionGraph(car) {
  const box = $('caution-graph');
  if (!box || cautionPanel.hasAttribute('hidden')) return;
  // Follows the situation the card is already on, until the engineer picks.
  const pace = cautionGraphPace || (planTab === 'sc' ? 'sc' : 'fcy');

  let sw = null;
  try { sw = cautionSweep(car, state.race, Date.now(), pace); } catch { sw = null; }

  const tabs = `<div class="plantabs ccpace">${['fcy', 'sc'].map(p =>
    `<button data-ccpace="${p}"${p === pace ? ' class="on"' : ''}><b>${
      p === 'fcy' ? 'CODE 60' : 'SAFETY CAR'}</b></button>`).join('')}</div>`;

  if (!sw || sw.points.length < 2) {
    box.innerHTML = `<h4>When it starts to pay</h4>${tabs}` +
      '<p class="cchint">Not enough of the car is set up to draw it — the tank, ' +
      'the lap and the burn all have to be known before the stint can be rolled forward.</p>';
    wireCautionGraph(car);
    return;
  }

  // ---- scales
  const W = 340, H = 178;
  // Bottom margin holds two rows: the minute ticks, then the axis title under
  // them. One row and they sit on top of each other at the left-hand end.
  const L = 34, R = 66, T = 12, B = 32;
  const xs = sw.points.map(p => p.min);
  const ys = sw.points.flatMap(p => [p.fuel, p.tyres, p.both]);
  const xMin = 0, xMax = Math.max(1, Math.max(...xs));
  // Zero is always on the chart: it is the line the whole reading turns on.
  const yLo = Math.min(0, ...ys), yHi = Math.max(CAUTION_DECISIVE_SEC, ...ys);
  const pad = Math.max(4, (yHi - yLo) * 0.08);
  const y0 = yLo - pad, y1 = yHi + pad;
  const X = v => L + ((v - xMin) / (xMax - xMin)) * (W - L - R);
  const Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

  const path = key => sw.points
    .map((p, i) => `${i ? 'L' : 'M'}${X(p.min).toFixed(1)} ${Y(p[key]).toFixed(1)}`).join(' ');

  // ---- ticks: a handful, on round numbers, never a label on every point
  const yStep = niceStep((y1 - y0) / 4);
  const yTicks = [];
  for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1; v += yStep) yTicks.push(v);
  const xStep = niceStep(xMax / 4);
  const xTicks = [];
  for (let v = 0; v <= xMax + 1e-9; v += xStep) xTicks.push(v);

  const last = sw.points[sw.points.length - 1];
  // Direct labels, nudged apart so two lines finishing together stay legible.
  const ends = CC_SERIES
    .map(s => ({ ...s, v: last[s.key], y: Y(last[s.key]) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].y - ends[i - 1].y < 11) ends[i].y = ends[i - 1].y + 11;
  }

  const nowX = sw.nowMin > 0 && sw.nowMin <= xMax ? X(sw.nowMin) : null;
  const atNow = valuesAt(sw, sw.nowMin);

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Seconds gained over staying out, by minute of the stint, for each option.">
    <rect class="ccband" x="${L}" y="${Y(CAUTION_DECISIVE_SEC).toFixed(1)}"
          width="${W - L - R}" height="${(Y(0) - Y(CAUTION_DECISIVE_SEC)).toFixed(1)}"></rect>
    ${yTicks.map(v => `<line class="ccgrid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"></line>
      <text class="cctick" x="${L - 5}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${v > 0 ? '+' : ''}${Math.round(v)}</text>`).join('')}
    ${xTicks.map(v => `<text class="cctick" x="${X(v).toFixed(1)}" y="${H - B + 12}" text-anchor="middle">${Math.round(v)}</text>`).join('')}
    <line class="cczero" x1="${L}" x2="${W - R}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"></line>
    ${nowX != null ? `<line class="ccnow" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${T}" y2="${H - B}"></line>
      <text class="ccaxis" x="${nowX.toFixed(1)}" y="${T - 2}" text-anchor="middle">now</text>` : ''}
    ${CC_SERIES.map(s => `<path class="ccline" d="${path(s.key)}" stroke="var(${s.css})"></path>`).join('')}
    ${nowX != null ? CC_SERIES.map(s => `<circle class="ccdot" cx="${nowX.toFixed(1)}" cy="${Y(atNow[s.key]).toFixed(1)}" r="4" fill="var(${s.css})"></circle>`).join('') : ''}
    ${ends.map(s => `<text class="cclab" x="${W - R + 6}" y="${(s.y + 3).toFixed(1)}">${esc(s.label)}</text>`).join('')}
    <text class="ccaxis" x="${((L + W - R) / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle">minute of the stint</text>
    <rect class="cchit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"></rect>
    <g class="cctip" hidden></g>
  </svg>`;

  const key = `<div class="cckey">${CC_SERIES.map(s => {
    const at = sw.first[s.key];
    const when = at == null ? 'never this stint'
      : at <= sw.nowMin ? 'paying now'
      : `from min ${Math.round(at)}`;
    return `<span><i style="background:var(${s.css})"></i>${esc(s.label)} — <b>${when}</b></span>`;
  }).join('')}</div>`;

  const table = cautionGraphTable ? `<table class="cctable">
    <thead><tr><th>min</th><th>tank</th><th>fuel</th><th>tyres</th><th>both</th></tr></thead>
    <tbody>${sw.points.filter((_, i) => i % Math.ceil(sw.points.length / 12) === 0).map(p =>
      `<tr><td>${Math.round(p.min)}</td><td>${p.fuelL.toFixed(0)} L</td><td>${fmtGain(p.fuel)}</td><td>${fmtGain(p.tyres)}</td><td>${fmtGain(p.both)}</td></tr>`).join('')}
    </tbody></table>` : '';

  box.innerHTML = `<h4>When it starts to pay</h4>${tabs}
    <p class="cchint">Seconds gained against staying out, at every minute of this
      stint. Above the dashed line the stop is ahead; inside the shaded band it is
      ahead by less than ${CAUTION_DECISIVE_SEC} s, which is too close to call.</p>
    ${svg}${key}
    <button class="ccmore" data-cctable>${cautionGraphTable ? 'hide the numbers' : 'show the numbers'}</button>
    ${table}`;
  wireCautionGraph(car, sw, { X, Y, L, R, T, H, B, W, xMin, xMax });
}

function fmtGain(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

// A tick step that lands on 1, 2, 5 × a power of ten, so the axis reads in
// round numbers whatever the range turns out to be.
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

// The three values at a given minute, interpolated between samples.
function valuesAt(sw, min) {
  const pts = sw.points;
  if (min <= pts[0].min) return pts[0];
  const lastPt = pts[pts.length - 1];
  if (min >= lastPt.min) return lastPt;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].min >= min) {
      const a = pts[i - 1], b = pts[i];
      const f = (min - a.min) / (b.min - a.min);
      const mix = k => a[k] + f * (b[k] - a[k]);
      return { min, fuelL: mix('fuelL'), tyreKm: mix('tyreKm'), fuel: mix('fuel'), tyres: mix('tyres'), both: mix('both') };
    }
  }
  return lastPt;
}

function wireCautionGraph(car, sw, geo) {
  const box = $('caution-graph');
  if (!box) return;
  for (const b of box.querySelectorAll('button[data-ccpace]')) {
    b.addEventListener('click', () => {
      cautionGraphPace = b.dataset.ccpace;
      renderCautionGraph(car);
    });
  }
  const more = box.querySelector('button[data-cctable]');
  if (more) {
    more.addEventListener('click', () => {
      cautionGraphTable = !cautionGraphTable;
      renderCautionGraph(car);
    });
  }
  if (!sw || !geo) return;

  // Crosshair and read-out. A chart drawn in the browser is interactive by
  // default: the crew should be able to ask it about any minute, not only the
  // one the car happens to be on.
  const svg = box.querySelector('svg');
  const hit = box.querySelector('.cchit');
  const tip = box.querySelector('.cctip');
  if (!svg || !hit || !tip) return;
  const { X, Y, L, R, T, H, B, W, xMax } = geo;

  const hide = () => tip.setAttribute('hidden', '');
  const show = ev => {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const px = ((ev.clientX - r.left) / r.width) * W;
    const min = Math.max(0, Math.min(xMax, ((px - L) / (W - L - R)) * xMax));
    const v = valuesAt(sw, min);
    const x = X(min);
    const rows = CC_SERIES.map(s => ({ ...s, v: v[s.key] }));
    const bw = 92, bh = 14 + rows.length * 12;
    // Flip the box to the other side of the crosshair near the right edge.
    const bx = x + bw + 8 > W - R ? x - bw - 8 : x + 8;
    const by = Math.max(T, Math.min(H - B - bh, Y(rows[0].v) - bh / 2));
    tip.innerHTML = `<line class="ccnow" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${T}" y2="${H - B}"></line>
      ${rows.map(s => `<circle class="ccdot" cx="${x.toFixed(1)}" cy="${Y(s.v).toFixed(1)}" r="3.5" fill="var(${s.css})"></circle>`).join('')}
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw}" height="${bh}"></rect>
      <text x="${(bx + 6).toFixed(1)}" y="${(by + 11).toFixed(1)}" class="ccdim">min ${Math.round(min)} · ${v.fuelL.toFixed(0)} L</text>
      ${rows.map((s, i) => `<text x="${(bx + 6).toFixed(1)}" y="${(by + 23 + i * 12).toFixed(1)}">${esc(s.label)} ${fmtGain(s.v)}s</text>`).join('')}`;
    tip.removeAttribute('hidden');
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
}

// The stock, not the set on the car: on a fixed allocation a set binned early
// is distance that cannot be bought back, and that is what makes a "free" stop
// under yellow expensive. Shown whenever the sums are tight.
function tyreBudgetRow(car) {
  let b = null;
  try { b = tyreBudget(car, state.race, Date.now()); } catch { b = null; }
  if (!b) return '';
  // Same ledger as the Stock-to-flag row in the tyre panel, so the two can
  // never tell the crew different stories.
  const base = `<div class="row${b.setsMargin <= 1 ? ' tight' : ''}"><span class="k">tyre stock${
    b.setsMargin < 0 ? ' — SHORT' : ''}</span><span class="v">${
    b.setsFresh} fresh · needs ~${b.setsNeededMin} · margin ${b.setsMargin >= 0 ? '+' : ''}${b.setsMargin}</span></div>`;
  if (b.affordEarlyChange) return base;
  return base + `<div class="row"><span class="k">early change spends</span><span class="v">a set the flag still needs — ${
    Math.round(b.fittedKmLeft)} km binned</span></div>`;
}

function patchDriver(idx, field, value) {
  const drivers = settingsCar().drivers.map(d => ({ ...d }));
  drivers[idx][field] = value;
  patchSettings({ drivers });
}

// ---- race start (starting fuel / starting driver) ----

// Empty or 0 means "full tank"; the model resolves that, so an empty box is
// stored as 0 rather than as the current tank size (which would silently stop
// tracking the tank setting).
$('start-fuel').addEventListener('change', () => {
  const raw = $('start-fuel').value.trim();
  const v = raw === '' ? 0 : parseFloat(raw);
  if (isNaN(v) || v < 0) return;
  const tank = settingsCar().config.tankLiters;
  patchSettings({ config: { startFuelL: Math.min(v, tank) } });
});

$('start-driver').addEventListener('change', () => {
  const car = settingsCar();
  const id = $('start-driver').value;
  if (!id || id === car.currentDriverId) return;
  // Mid-race this is not a "starting" driver any more: the seat time of the
  // running stint would be credited to whoever is selected here. A driver
  // change during the race belongs in the stop planner.
  if (state && raceClock(state.race, Date.now()).running) {
    const ok = confirm(
      'The race has already started. Changing the driver here credits the whole current stint to the new driver and does not log a pit stop.\n\n' +
      'For a normal driver change use DRIVER in the stop planner. Continue anyway?'
    );
    if (!ok) return renderStartDriver(car);
  }
  patchSettings({ currentDriverId: id });
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
  const car = settingsCar();
  let n = car.drivers.length + 1;
  while (car.drivers.some(d => d.id === 'd' + n)) n++;
  const drivers = [...car.drivers, defaultDriver(n)];
  const patch = { drivers };
  // First driver added to an empty list becomes the driver in the car.
  if (!car.drivers.some(d => d.id === car.currentDriverId)) {
    patch.currentDriverId = drivers[0].id;
  }
  patchSettings(patch);
});

function removeDriver(i) {
  const car = settingsCar();
  const d = car.drivers[i];
  if (d.id === car.currentDriverId) {
    return alert(`${d.name} is in the car — switch drivers before removing them.`);
  }
  if (!confirm(`Remove ${d.name}? Their logged seat time is lost.`)) return;
  const patch = { drivers: car.drivers.filter((_, j) => j !== i) };
  if (car.nextStop.driverChange === d.id) patch.nextStop = { driverChange: null };
  patchSettings(patch);
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
    abbrInp.title = 'Short code shown in compact readouts. Empty = the proposed one: first letter of the first name + first two of the last (Roman Rusinov → RRU)';
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
        patchDriver(i, field, !settingsCar().drivers[i][field]));
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
  const car = settingsCar();
  const pts = [...curvePointsOf(car, i)];
  // Seed a new row from the car's dry figures so the engineer edits a
  // plausible point instead of two zeroes.
  const last = pts[pts.length - 1];
  const p = emptyCurvePoint();
  p.lapSec = last ? +(last.lapSec + 2).toFixed(3) : (car.config.avgLapSec?.dry || 100);
  p.fuelL = last ? last.fuelL : (car.config.burnPerLap?.dry || 0);
  patchCurve(i, [...pts, p]);
}

function removeCurvePoint(i, j) {
  patchCurve(i, curvePointsOf(settingsCar(), i).filter((_, k) => k !== j));
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
            const next = [...curvePointsOf(settingsCar(), i)];
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
            const next = [...curvePointsOf(settingsCar(), i)];
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
    const live = getPath(car, inp.dataset.path) ?? '';
    const sent = pendingSettings.get(inp.dataset.path);
    if (sent) {
      if (String(live) === String(sent.value)) {
        pendingSettings.delete(inp.dataset.path);   // the wall has it
        inp.classList.remove('pending');
      } else if (Date.now() - sent.sentMs < SETTING_ACK_MS) {
        inp.classList.add('pending');
        continue;                                    // still in flight: hands off
      } else {
        pendingSettings.delete(inp.dataset.path);
        inp.classList.remove('pending');
        inp.classList.add('unsent');                 // never arrived — say so
      }
    }
    setInput(inp, live);
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
  // These pages work with or without a pit wall: connected they edit the car,
  // and with no link they edit this PC's draft — which is how a car file gets
  // written the week before the event. The banner says which one is on screen,
  // because the one thing that must never happen is typing a full setup into a
  // draft while believing it is going to the car.
  const banner = $('settings-offline');
  banner.hidden = !onDraft();
  for (const b of ['btn-tyreset-add', 'btn-tyreset-gen', 'btn-brakeset-gen']) {
    $(b).disabled = false;
    $(b).removeAttribute('title');
  }

  renderTyreSets(car);
  renderTyreGen();
  renderBrakeSets(car);
  renderBrakeGen();
  renderLearned(car);

  // Event settings readout (edited on the pit wall, same for every car)
  const ev = state?.event || car.config;
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

  renderCarFileSummary(car);
  // Emptying the draft is only ever offered for the draft: there is no such
  // button for a car the race is being run on.
  $('btn-carfile-reset').hidden = !onDraft();
  renderPresets();
}

// ---- car files ----
// The two buttons the CAR FILE tab exists for: write what these pages are
// showing out to a file, or read one back in. Which car that is follows the
// pages themselves — the live car when the station is connected, this PC's
// draft when it is not — so the same pair does the preparation at home in
// October and the loading in the box on race morning.

let appVersion = '';
window.pitwallApi?.getVersion?.().then(v => { appVersion = v?.version || ''; }).catch(() => {});

function carFileStatus(text, cls = '') {
  const el = $('carfile-status');
  if (!el) return;
  el.className = 'hint' + (cls ? ' ' + cls : '');
  el.textContent = text;
  el.hidden = !text;
}

// What the file about to be written would contain, in the shape a person can
// check before saving: the four things that are easy to get wrong.
function renderCarFileSummary(car) {
  const wrap = $('carfile-summary');
  if (!wrap) return;
  const drivers = (car.drivers || []).map(d => d.name).join(', ') || 'none';
  const curves = (car.drivers || []).filter(d => normalizeCurve(d.fuelCurve).length).length;
  const tyres = (car.tyreSets || []).length;
  const wets = (car.tyreSets || []).filter(t => tyreCompoundOf(t) === 'wet').length;
  const brakes = BRAKE_COMPONENTS.map(b => `${b.short} ${brakeSetsOf(car, b.id).length}`).join(' · ');
  wrap.innerHTML = `
    <div class="kv"><span class="k">These buttons act on</span><span class="v">${onDraft()
      ? "this PC's draft — no pit wall" : 'the car on the pit wall'}</span></div>
    <div class="kv"><span class="k">Saved as</span><span class="v">${esc(carFileName(car))}</span></div>
    <div class="kv"><span class="k">Car</span><span class="v">${esc(car.name)} · #${esc(car.number)}${
      [car.make, car.model].filter(Boolean).length ? ' · ' + esc([car.make, car.model].filter(Boolean).join(' ')) : ''}</span></div>
    <div class="kv"><span class="k">Drivers</span><span class="v">${esc(drivers)}${
      curves ? ` (${curves} with a fuel curve)` : ''}</span></div>
    <div class="kv"><span class="k">Fuel</span><span class="v">${car.config.tankLiters} L tank · ${
      car.config.burnPerLap?.dry} L/lap dry · ${car.config.avgLapSec?.dry} s lap</span></div>
    <div class="kv"><span class="k">Racks</span><span class="v">${tyres} tyre set${tyres === 1 ? '' : 's'}${
      wets ? ` (${wets} wet)` : ''} · ${brakes}</span></div>`;
}

$('btn-carfile-save').addEventListener('click', async () => {
  const api = window.pitwallApi;
  if (!api?.saveCarFile) return carFileStatus('This build cannot reach the file system.', 'warn');
  const car = settingsCar();
  const res = await api.saveCarFile(carFileName(car), buildCarFile(car, { app: appVersion }));
  if (res?.canceled) return;
  if (!res?.ok) return carFileStatus('Could not save: ' + (res?.error || 'unknown error'), 'warn');
  carFileStatus('Saved to ' + res.path, 'good');
});

$('btn-carfile-load').addEventListener('click', async () => {
  const api = window.pitwallApi;
  if (!api?.openCarFile) return carFileStatus('This build cannot reach the file system.', 'warn');
  const res = await api.openCarFile();
  if (res?.canceled) return;
  if (!res?.ok) return carFileStatus('Could not open: ' + (res?.error || 'unknown error'), 'warn');
  const read = readCarFile(res.text);
  if (!read.ok) return carFileStatus(read.error, 'warn');
  const f = read.file;
  const who = [f.car?.number ? '#' + f.car.number : '', f.car?.name || ''].filter(Boolean).join(' ') || 'a car';
  if (state) {
    // The live car: the pit wall applies it, so every screen lands on the same
    // setup at the same moment.
    const car = state.cars[carId];
    const ok = confirm(
      `Load "${res.name}" (${who}) onto ${car.name}?\n\n` +
      'It sets the car information, fuel and pace figures, wear limits, the driver table ' +
      'and the tyre/brake racks.\n\n' +
      'Laps, mileage, banked hours, seat time and every set that has already run are kept, ' +
      'and event settings are not touched.');
    if (!ok) return;
    send({ type: 'loadCarFile', file: f });
    carFileStatus('Sent to the pit wall…');
  } else {
    if (!confirm(`Load "${res.name}" (${who}) into this PC's draft? What is in the draft now is replaced.`)) return;
    const r = applyCarFile(draft, f);
    if (!r.ok) return carFileStatus(r.error, 'warn');
    saveDraft();
    renderDraftSettings();
    carFileStatus(`Loaded ${res.name} into the draft — ${r.applied.join(', ')}.` +
      (r.warnings.length ? ' ' + r.warnings.join(' ') : ''), r.warnings.length ? 'warn' : 'good');
  }
});

$('btn-carfile-reset').addEventListener('click', () => {
  if (!confirm('Empty the draft and start from the app defaults? The car files already saved to disk are not touched.')) return;
  draft = defaultCar(carId, defaultCarNumber(carId));
  saveDraft();
  renderDraftSettings();
  carFileStatus('Draft emptied — every setting is back to the app default.');
});

// The settings pages with no pit wall behind them: the same forms, this PC's
// draft car. Called at boot, when the page is opened and after every draft
// edit; once a real state arrives render() owns the page and this stands down.
const DRAFT_RACE = {
  name: '', durationH: 24, startMs: null,
  fcy: { mode: 'auto', active: false, startMs: null, source: 'none', flag: null, overrideFlag: null }
};

function renderDraftSettings() {
  if (state) return;
  renderSettings(draft, carCalcs(draft, DRAFT_RACE, Date.now()));
}

// ---- setup presets ----

$('btn-preset-save').addEventListener('click', () => {
  const name = $('preset-name').value.trim();
  if (!name) return alert('Give the preset a name first.');
  if (state?.presets?.[name] && !confirm(`Preset "${name}" exists — overwrite it?`)) return;
  send({ type: 'savePreset', name });
  $('preset-name').value = '';
});

let presetListKey = null;
function renderPresets() {
  const presets = state?.presets || {};
  const key = (onDraft() ? 'draft|' : 'live|') +
    Object.entries(presets).map(([n, p]) => n + p.savedMs).join('|');
  if (key === presetListKey) return;
  presetListKey = key;
  const wrap = $('preset-list');
  const names = Object.keys(presets).sort();
  // A preset lives in the shared state on the pit wall, so it is the one thing
  // on this page that genuinely needs a link. The car file above does the same
  // job with no pit wall at all — say so rather than showing an empty list.
  $('btn-preset-save').disabled = onDraft();
  $('preset-name').disabled = onDraft();
  wrap.innerHTML = names.length ? '' : `<p class="hint">${onDraft()
    ? 'Presets are kept on the pit wall PC — they need a connected station. With no pit wall, save a car file instead.'
    : 'No presets saved yet.'}</p>`;
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
  patchSettings({ tyreSets: sets, config: { tyreSets: sets.length } });
}

$('btn-tyreset-add').addEventListener('click', () => {
  const sets = settingsCar().tyreSets || [];
  let n = sets.length + 1;
  while (sets.some(t => t.id === 't' + n)) n++;
  patchTyreSets([...sets.map(t => ({ ...t })), newTyreSet('t' + n, 'S' + n)]);
});

// ---- generate a batch of sets ----
// The allocation for a 24h arrives numbered on the rubber, not as twelve rows
// to type in one at a time. The form asks the three things that description
// needs — pattern, first number, how many — and shows the names it would
// write before anything is committed; nothing is patched until GENERATE.

const genForm = { count: 12, start: 1, pattern: TYRE_SET_PATTERN, replace: false };

function openTyreGen(open) {
  const box = $('tyreset-gen');
  box.hidden = !open;
  if (!open) return;
  // Continue the numbering already on the shelf rather than colliding with it.
  genForm.start = nextSetNumber((settingsCar().tyreSets || []).map(t => t.name));
  $('gen-count').value = genForm.count;
  $('gen-start').value = genForm.start;
  $('gen-pattern').value = genForm.pattern;
  renderTyreGen();
}

// What the form is asking for right now, clamped the same way the model does.
function readTyreGen() {
  genForm.count = Math.max(1, Math.min(TYRE_SET_GEN_MAX, parseInt($('gen-count').value, 10) || 1));
  genForm.start = Math.max(0, parseInt($('gen-start').value, 10) || 0);
  genForm.pattern = $('gen-pattern').value.trim() || TYRE_SET_PATTERN;
  return generateTyreSets(settingsCar(), {
    pattern: genForm.pattern, start: genForm.start,
    count: genForm.count, replaceUnused: genForm.replace
  });
}

function renderTyreGen() {
  if ($('tyreset-gen').hidden) return;
  const gen = readTyreGen();
  $('gen-preview').innerHTML = gen.names
    .map(n => `<span class="tag${gen.duplicates.includes(n) ? ' dup' : ''}">${esc(n)}</span>`).join('');
  $('btn-gen-replace').classList.toggle('on', genForm.replace);
  const note = $('gen-note');
  const dup = [...new Set(gen.duplicates)];
  if (dup.length) {
    note.className = 'hint warn';
    note.textContent = `Already in the list: ${dup.join(', ')} — rename, renumber, ` +
      'or turn REPLACE UNUSED on if those are the placeholder sets.';
  } else {
    note.className = 'hint';
    note.textContent =
      `${gen.names.length} set${gen.names.length === 1 ? '' : 's'} added` +
      (gen.removed ? `, ${gen.removed} unused set${gen.removed === 1 ? '' : 's'} removed` : '') +
      ` — ${gen.sets.length} in the pool afterwards.`;
  }
  $('btn-gen-go').disabled = dup.length > 0;
}

$('btn-tyreset-gen').addEventListener('click', () => {
  openTyreGen($('tyreset-gen').hidden);
});
$('btn-gen-cancel').addEventListener('click', () => openTyreGen(false));
$('btn-gen-replace').addEventListener('click', () => {
  genForm.replace = !genForm.replace;
  renderTyreGen();
});
for (const id of ['gen-count', 'gen-start', 'gen-pattern']) {
  $(id).addEventListener('input', renderTyreGen);
}

$('btn-gen-go').addEventListener('click', () => {
  const gen = readTyreGen();
  if (gen.duplicates.length) return;
  if (gen.removed && !confirm(
    `Replace ${gen.removed} unused set${gen.removed === 1 ? '' : 's'} with ` +
    `${gen.names.length} new one${gen.names.length === 1 ? '' : 's'}? ` +
    'Sets that have run, the set on the car and scrapped sets are kept.')) return;
  // A stop still pointing at a set that just went out of the pool would show
  // as "NO SET FREE" in the planner — let it fall back to the next new set.
  const chosen = settingsCar().nextStop?.tyreSetId;
  const patch = { tyreSets: gen.sets, config: { tyreSets: gen.sets.length } };
  if (chosen && !gen.sets.some(t => t.id === chosen)) patch.nextStop = { tyreSetId: null };
  patchSettings(patch);
  openTyreGen(false);
});

// Why a set gets binned. Picking the reason IS the confirmation step — a
// single destructive button next to a laps field is too easy to hit at 03:00,
// and "why" is the thing worth having in the log afterwards.
const SCRAP_REASONS = ['worn out', 'flat spot', 'damage', 'wrong compound'];
let scrapAsk = null; // id of the set whose reason strip is open

// A set counts as used exactly while it carries mileage — so typing the laps
// or the kilometres back to zero puts it back in the new pool, which is how a
// crew undoes a figure they mistyped into the wrong row. The set on the car is
// used whatever the boxes say: it is on the car.
const tyreSetUsed = (t, onCar) => onCar || +t.laps > 0 || +t.km > 0;

let tyreSetKey = '';
let tyreSetHold = false;
function renderTyreSets(car) {
  const wrap = $('tyreset-list');
  if (!wrap) return;
  const sets = car.tyreSets || [];
  const curId = car.state.currentTyreSetId;
  const key = sets.map(t => `${t.id}:${t.name}:${t.compound}:${t.laps}:${t.km}:${t.kmFcy}:${t.used}:${t.scrapped}:${t.scrapReason}`).join('|') +
    `|${curId}:${car.state.tyreLapsOnSet}|${scrapAsk}`;
  if (key === tyreSetKey) return;
  // Every counted lap moves these numbers, and rebuilding the list under the
  // crew's hands would throw away the figure they are half way through typing.
  // Hold the redraw while a box in here has focus; the buttons still redraw at
  // once, so the scrap strip is never held back.
  const editing = document.activeElement;
  if (editing && editing.tagName === 'INPUT' && wrap.contains(editing)) {
    if (!tyreSetHold) {
      tyreSetHold = true;
      wrap.addEventListener('focusout', () => {
        tyreSetHold = false;
        setTimeout(() => renderTyreSets(settingsCar()), 0);
      }, { once: true });
    }
    return;
  }
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
      <input data-set-name type="text" />
      <span class="setpill ${pill[0]}">${pill[1]}</span>
      <button data-act="compound" class="setpill ${t.compound === 'wet' ? 'iswet' : 'isslick'}"
        title="Which stock this set belongs to. Wets are insurance — they are never counted toward the dry-running budget, and a wet track proposes them first.">${
        t.compound === 'wet' ? 'WET' : 'SLICK'}</button>
      <span class="meta figs">laps <input data-set-laps type="number" min="0" step="1" style="width:60px" ${onCar ? 'disabled title="live — counted in the tyre panel"' : ''} />
        km <input data-set-km type="number" min="0" step="1" style="width:70px" title="Mileage banked on this set — type in what rubber that has already run arrives with" /></span>
      <span class="km" title="The part of this set's mileage driven under a neutralisation">${
        mil.kmFcy > 0 ? `<em>${mil.kmFcy.toFixed(0)} yellow</em>` : ''}</span>
      <span class="meta">${t.scrapped && t.scrapReason ? esc(t.scrapReason) : ''}</span>
      <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
        ${onDraft() ? '' : t.scrapped
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
      next[i].used = tyreSetUsed(next[i], onCar);
      patchTyreSets(next);
    });
    // Kilometres are the figure tyre life is measured in, so a set that arrives
    // with mileage on it — a test day, a set bought used — has to be typed in
    // here or the app reads it as a fresh 300 km of life.
    const kmInp = row.querySelector('[data-set-km]');
    kmInp.value = +mil.km.toFixed(1);
    kmInp.addEventListener('change', () => {
      const v = parseFloat(kmInp.value);
      const next = sets.map(x => ({ ...x }));
      next[i].km = isNaN(v) || v < 0 ? 0 : +v.toFixed(2);
      next[i].kmFcy = Math.min(Math.max(0, +next[i].kmFcy || 0), next[i].km);
      next[i].used = tyreSetUsed(next[i], onCar);
      patchTyreSets(next);
    });
    row.querySelector('[data-act="compound"]').addEventListener('click', () => {
      const next = sets.map(x => ({ ...x }));
      next[i].compound = next[i].compound === 'wet' ? 'slick' : 'wet';
      patchTyreSets(next);
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (onCar || t.used) return;
      patchTyreSets(sets.filter((_, j) => j !== i));
    });
    row.querySelector('[data-act="scrap"]')?.addEventListener('click', () => {
      scrapAsk = scrapAsk === t.id ? null : t.id;
      tyreSetKey = '';
      renderTyreSets(settingsCar());
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
          else renderTyreSets(settingsCar());
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
  patchSettings({ brakeSets: { [comp]: sets }, config: { brakeSets: { [comp]: sets.length } } });
}

// ---- generate a rack ----
// The tyre generator, once per pool: the crew ticks the groups a delivery
// covers and one pattern names them all, because [P] is each group's own
// prefix. One starting number across the rack on purpose — parts that arrive
// together carry the same number, which is how the trolley is loaded.

const bGenForm = {
  comps: new Set(BRAKE_COMPONENTS.map(b => b.id)),
  count: 4, start: 1, pattern: BRAKE_SET_PATTERN, replace: false, startTouched: false
};

// One past the highest number in every pool the form is writing to, so no
// group lands on a name it already has.
function bGenNextStart() {
  const names = [...bGenForm.comps]
    .flatMap(comp => brakeSetsOf(settingsCar(), comp).map(t => t.name));
  return nextSetNumber(names);
}

function openBrakeGen(open) {
  $('brakeset-gen').hidden = !open;
  if (!open) return;
  bGenForm.startTouched = false;
  bGenForm.start = bGenNextStart();
  $('bgen-count').value = bGenForm.count;
  $('bgen-start').value = bGenForm.start;
  $('bgen-pattern').value = bGenForm.pattern;
  renderBrakeGen();
}

function readBrakeGen() {
  bGenForm.count = Math.max(1, Math.min(TYRE_SET_GEN_MAX, parseInt($('bgen-count').value, 10) || 1));
  bGenForm.start = Math.max(0, parseInt($('bgen-start').value, 10) || 0);
  bGenForm.pattern = $('bgen-pattern').value.trim() || BRAKE_SET_PATTERN;
  return generateBrakeSets(settingsCar(), {
    comps: BRAKE_COMPONENTS.map(b => b.id).filter(id => bGenForm.comps.has(id)),
    pattern: bGenForm.pattern, start: bGenForm.start,
    count: bGenForm.count, replaceUnused: bGenForm.replace
  });
}

function renderBrakeGen() {
  if ($('brakeset-gen').hidden) return;
  const gen = readBrakeGen();
  const chips = $('bgen-comps');
  if (!chips.children.length) {
    chips.innerHTML = BRAKE_COMPONENTS
      .map(b => `<button class="flag" data-bgen-comp="${b.id}">${b.short}</button>`).join('');
    for (const btn of chips.children) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.bgenComp;
        if (bGenForm.comps.has(id)) bGenForm.comps.delete(id);
        else bGenForm.comps.add(id);
        if (!bGenForm.startTouched) {
          bGenForm.start = bGenNextStart();
          $('bgen-start').value = bGenForm.start;
        }
        renderBrakeGen();
      });
    }
  }
  for (const btn of chips.children) {
    btn.classList.toggle('on', bGenForm.comps.has(btn.dataset.bgenComp));
  }
  $('btn-bgen-replace').classList.toggle('on', bGenForm.replace);

  // One preview line per pool, so what each group gets named is readable
  // before it is written.
  $('bgen-preview').innerHTML = BRAKE_COMPONENTS.filter(b => gen[b.id]).map(b => {
    const g = gen[b.id];
    return `<div class="setgen-row"><span class="axlehead">${b.short}</span>` +
      `<span class="setgen-preview">${g.names
        .map(n => `<span class="tag${g.duplicates.includes(n) ? ' dup' : ''}">${esc(n)}</span>`)
        .join('')}</span></div>`;
  }).join('');

  const dup = [...new Set(Object.values(gen).flatMap(g => g.duplicates))];
  const added = Object.values(gen).reduce((n, g) => n + g.names.length, 0);
  const removed = Object.values(gen).reduce((n, g) => n + g.removed, 0);
  const note = $('bgen-note');
  if (!bGenForm.comps.size) {
    note.className = 'hint warn';
    note.textContent = 'Pick at least one component group to write to.';
  } else if (dup.length) {
    note.className = 'hint warn';
    note.textContent = `Already on the rack: ${dup.join(', ')} — renumber, or turn ` +
      'REPLACE UNUSED on if those are the placeholder sets.';
  } else {
    note.className = 'hint';
    note.textContent = `${added} set${added === 1 ? '' : 's'} added across ` +
      `${bGenForm.comps.size} group${bGenForm.comps.size === 1 ? '' : 's'}` +
      (removed ? `, ${removed} unused set${removed === 1 ? '' : 's'} removed` : '') + '.';
  }
  $('btn-bgen-go').disabled = dup.length > 0 || !bGenForm.comps.size;
}

$('btn-brakeset-gen').addEventListener('click', () => {
  openBrakeGen($('brakeset-gen').hidden);
});
$('btn-bgen-cancel').addEventListener('click', () => openBrakeGen(false));
$('btn-bgen-replace').addEventListener('click', () => {
  bGenForm.replace = !bGenForm.replace;
  renderBrakeGen();
});
$('bgen-start').addEventListener('input', () => { bGenForm.startTouched = true; renderBrakeGen(); });
for (const id of ['bgen-count', 'bgen-pattern']) {
  $(id).addEventListener('input', renderBrakeGen);
}

$('btn-bgen-go').addEventListener('click', () => {
  const gen = readBrakeGen();
  const removed = Object.values(gen).reduce((n, g) => n + g.removed, 0);
  if (Object.values(gen).some(g => g.duplicates.length) || !bGenForm.comps.size) return;
  if (removed && !confirm(
    `Replace ${removed} unused set${removed === 1 ? '' : 's'} on the rack? ` +
    'Sets that have run, the sets on the car and scrapped sets are kept.')) return;
  const brakeSets = {};
  const counts = {};
  const chosen = { ...(settingsCar().nextStop?.brakeSetIds || {}) };
  let stopEdited = false;
  for (const [comp, g] of Object.entries(gen)) {
    brakeSets[comp] = g.sets;
    counts[comp] = g.sets.length;
    // A stop pointing at a part that just left the rack falls back to the next
    // unused set rather than reading as nothing free.
    if (chosen[comp] && !g.sets.some(t => t.id === chosen[comp])) {
      chosen[comp] = null;
      stopEdited = true;
    }
  }
  const patch = { brakeSets, config: { brakeSets: counts } };
  if (stopEdited) patch.nextStop = { brakeSetIds: chosen };
  patchSettings(patch);
  openBrakeGen(false);
});

let brakeScrapAsk = null; // `${comp}:${setId}` of the set whose reason strip is open
let brakeLinkAsk = null; // `${axle}:disc:${id}` / `${axle}:pad:${id}` — which link strip is open
let brakeEditAsk = null; // `${comp}:${setId}` — the one row whose editor is unfolded

// The rack, read the way the crew reads the car: the two axles side by side —
// front on the left, rear on the right, the way the consumables board does it —
// and inside each axle one block per kit, the disc set with the pads bedded
// onto it underneath. A row is a glance, not a form: the part number, how much
// of its life is gone as a bar, and what state it is in. Everything that
// CHANGES a part — its number, its hours, scrapping it, binning it — folds out
// under the row that was clicked, so three numbered parts per axle no longer
// read as fifteen input boxes stacked down one column.
let brakeSetKey = '';
function renderBrakeSets(car) {
  const wrap = $('brakeset-list');
  if (!wrap) return;
  const cur = car.state.currentBrakeSetId || {};
  const key = BRAKE_COMPONENTS.map(b => b.id + '=' + brakeSetsOf(car, b.id)
    .map(t => `${t.id}:${t.name}:${t.hours}:${t.used}:${t.scrapped}:${t.scrapReason}:${t.padSetId}:${t.kitName}`).join('|') +
    `@${cur[b.id]}:${(car.state.brakeUsedH || {})[b.id]}:${car.config?.brakeLifeH?.[b.id]}`).join('/') +
    // onDraft is in the key because it decides which buttons exist at all: a
    // rack drawn before the pit wall answered would otherwise keep its
    // read-only head for as long as nothing else about the parts changed.
    `|${brakeScrapAsk}|${brakeLinkAsk}|${brakeEditAsk}|${onDraft()}`;
  if (key === brakeSetKey) return;
  brakeSetKey = key;
  wrap.innerHTML = '';
  wrap.className = 'brack';

  const redraw = () => { brakeSetKey = ''; renderBrakeSets(settingsCar()); };

  const isDisc = comp => BRAKE_AXLES.some(a => a.discs === comp);
  // What a part is measured against. A pad set and a disc set on the same axle
  // have different lives, so the bar under each is that part's own.
  const lifeOf = comp => Math.max(0.01, +car.config?.brakeLifeH?.[comp] || 1);
  // What the brake panel reads right now for the part on the car: the counter
  // seeded at the last stop plus the stint that is running. This is the figure
  // a measured correction replaces, so it is what the editor prefills.
  const liveHours = comp => {
    const now = Date.now();
    const start = stintStartOf(car, state.race);
    const stintH = raceClock(state.race, now).running && start
      ? drivenMs(state.race, start, now) / 3600e3 : 0;
    return Math.max(0, +car.state.brakeUsedH?.[comp] || 0) + stintH;
  };

  const el = (cls, html) => {
    const d = document.createElement('div');
    d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  };

  // One part, whichever pool it lives in, read at a glance: the number written
  // on it, the hours on it, and how much of its life that leaves. Clicking it
  // unfolds the editor — see editStrip.
  const partRow = (comp, sets, i) => {
    const t = sets[i];
    const onCar = t.id === cur[comp];
    const hours = brakeSetHours(car, comp, t);
    const lifeH = lifeOf(comp);
    const gone = Math.min(1, hours / lifeH);
    const left = Math.max(0, Math.round((1 - gone) * 100));
    const wear = t.scrapped ? 'scrapped' : gone >= 0.85 ? 'crit' : gone >= 0.6 ? 'warn' : '';
    const pill = t.scrapped ? ['scrapped', 'SCRAPPED']
      : onCar ? ['oncar', 'ON CAR']
      : t.used ? ['', 'USED'] : ['new', 'NEW'];
    const open = brakeEditAsk === `${comp}:${t.id}`;
    const row = el('brack-row' + (onCar ? ' oncar' : '') + (t.scrapped ? ' isscrapped' : '') +
      (open ? ' open' : ''), `
      <span class="brack-glyph"><i class="${isDisc(comp) ? 'g-disc' : 'g-pad'}"></i></span>
      <span class="brack-name">${esc(t.name)}<small>${isDisc(comp) ? 'discs' : 'pads'}${
        t.scrapped && t.scrapReason ? ' · ' + esc(t.scrapReason) : ''}</small></span>
      <span class="brack-val ${wear}" title="${fmtH(hours)} of ${fmtH(lifeH)}">${fmtH(hours)}</span>
      <span class="brack-barwrap">
        <span class="brack-bar ${wear}"><i style="width:${t.scrapped ? 0 : left}%"></i></span>
        <span class="brack-left ${wear}">${t.scrapped ? '—' : left + '%'}</span>
      </span>
      <span class="brack-pill ${pill[0]}">${pill[1]}</span>`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = onCar
      ? 'on the car — its hours tick in the brake panel. Click to type over them with a measured figure'
      : 'click to change the number on this part, its hours or wear, or take it out of the rack';
    const toggle = () => {
      const k = `${comp}:${t.id}`;
      brakeEditAsk = brakeEditAsk === k ? null : k;
      brakeScrapAsk = null;
      brakeLinkAsk = null;
      redraw();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    return row;
  };

  // The folded-out editor: everything that used to sit on the row itself. It
  // belongs to exactly one part at a time, which is what keeps the board
  // readable — the boxes are there when a part is being worked on, and gone
  // the rest of the time.
  const editStrip = (comp, sets, i, extra = '') => {
    const t = sets[i];
    if (brakeEditAsk !== `${comp}:${t.id}`) return null;
    const onCar = t.id === cur[comp];
    const hours = onCar ? liveHours(comp) : brakeSetHours(car, comp, t);
    const lifeH = lifeOf(comp);
    const leftPct = h => Math.max(0, Math.round((1 - Math.min(1, h / lifeH)) * 100));
    const strip = el('brack-edit', `
      <label>NO. <input data-bset-name type="text" title="the number written on the part" /></label>
      <label>HOURS <input data-bset-hours type="number" min="0" step="0.1" ${
        onCar ? 'title="what the live counter reads — type over it with a measured figure"' : ''} /></label>
      <label>LEFT % <input data-bset-left type="number" min="0" max="100" step="1"
        title="life left as the crew measures it — writes the hours to match" /></label>
      <span class="brack-editacts">
        ${extra}
        ${onDraft() ? '' : t.scrapped
          ? `<button data-act="restore">RESTORE</button>`
          : `<button data-act="scrap" ${onCar ? 'disabled title="the part on the car has to come off first"' : ''}>SCRAP&hellip;</button>`}
        <button data-act="del" class="danger" ${onCar || t.used ? 'disabled title="only never-used sets can be removed"' : ''}>${icon('x')}</button>
      </span>`);
    const nameInp = strip.querySelector('[data-bset-name]');
    nameInp.value = t.name;
    nameInp.addEventListener('change', () => {
      const next = sets.map(x => ({ ...x }));
      next[i].name = nameInp.value.trim() || t.name;
      patchBrakeSets(comp, next);
    });
    // Hours and life-left are one figure written two ways: the crew that logs
    // run time types hours, the crew that gauges pad thickness types the
    // percent left, and either box writes the other through the part's life.
    // In the rack the figure goes on the set; on the car it re-seeds the live
    // counter, which keeps ticking from what was typed.
    const applyHours = h => {
      h = isNaN(h) || h < 0 ? 0 : +h.toFixed(4);
      if (onCar) return send({ type: 'brakeSetHours', comp, setId: t.id, hours: h });
      const next = sets.map(x => ({ ...x }));
      next[i].hours = h;
      // Same rule as the tyres: the hours box is what says whether a part has
      // run, so typing it back to zero returns the part to the new pool.
      next[i].used = next[i].hours > 0;
      patchBrakeSets(comp, next);
    };
    const hInp = strip.querySelector('[data-bset-hours]');
    const leftInp = strip.querySelector('[data-bset-left]');
    hInp.value = +hours.toFixed(2);
    leftInp.value = leftPct(hours);
    hInp.addEventListener('change', () => applyHours(parseFloat(hInp.value)));
    leftInp.addEventListener('change', () => {
      const v = parseFloat(leftInp.value);
      if (isNaN(v)) { leftInp.value = leftPct(hours); return; }
      applyHours((1 - Math.max(0, Math.min(100, v)) / 100) * lifeH);
    });
    strip.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (onCar || t.used) return;
      brakeEditAsk = null;
      patchBrakeSets(comp, sets.filter((_, j) => j !== i));
    });
    strip.querySelector('[data-act="scrap"]')?.addEventListener('click', () => {
      const k = `${comp}:${t.id}`;
      brakeScrapAsk = brakeScrapAsk === k ? null : k;
      brakeLinkAsk = null;
      redraw();
    });
    strip.querySelector('[data-act="restore"]')?.addEventListener('click', () =>
      send({ type: 'brakeSetDecision', comp, setId: t.id, scrapped: false }));
    return strip;
  };

  // Second step of a scrap: nothing is binned until a reason is picked.
  const scrapStrip = (comp, t, hours) => {
    if (brakeScrapAsk !== `${comp}:${t.id}` || t.scrapped) return null;
    const ask = el('brack-ask', `<span class="meta">Scrap ${esc(t.name)} — ${fmtH(hours)}. Why?</span>` +
      `<span class="brack-askacts">` +
      BRAKE_SCRAP_REASONS.map(r => `<button data-why="${r}">${r.toUpperCase()}</button>`).join('') +
      `<button data-why="">CANCEL</button></span>`);
    for (const btn of ask.querySelectorAll('[data-why]')) {
      btn.addEventListener('click', () => {
        const why = btn.dataset.why;
        brakeScrapAsk = null;
        if (why) { brakeEditAsk = null; send({ type: 'brakeSetDecision', comp, setId: t.id, scrapped: true, reason: why }); }
        redraw();
      });
    }
    return ask;
  };

  // The link strip: which pads go onto this disc, or which disc these pads go
  // onto. One tap makes the kit — the name comes from the axle's series and
  // can be typed over on the kit chip afterwards.
  const linkStrip = (a, opts) => {
    const strip = el('brack-ask');
    if (!opts.choices.length) {
      strip.innerHTML = `<span class="meta">${opts.empty}</span>` +
        `<span class="brack-askacts"><button data-cancel>CLOSE</button></span>`;
    } else {
      strip.innerHTML = `<span class="meta">${opts.prompt}</span><span class="brack-askacts">` +
        opts.choices.map(c => `<button data-pick="${c.id}">${esc(c.label)}</button>`).join('') +
        `<button data-cancel>CANCEL</button></span>`;
    }
    strip.querySelector('[data-cancel]').addEventListener('click', () => {
      brakeLinkAsk = null;
      redraw();
    });
    for (const btn of strip.querySelectorAll('[data-pick]')) {
      btn.addEventListener('click', () => {
        brakeLinkAsk = null;
        brakeEditAsk = null;
        send({ type: 'brakeKitLink', axle: a.id, ...opts.link(btn.dataset.pick) });
      });
    }
    return strip;
  };

  const board = el('brack-board');
  wrap.appendChild(board);

  BRAKE_AXLES.forEach((a, ai) => {
    if (ai) board.appendChild(el('brack-vline'));
    const col = el('brack-axle');
    board.appendChild(col);

    const discs = brakeSetsOf(car, a.discs);
    const pads = brakeSetsOf(car, a.pads);
    const free = freePadSets(car, a.id, { includeScrapped: true });
    const kits = brakeKitsOf(car, a.id);
    col.appendChild(el('brack-tag', `${a.label}<span class="meta">${kits.length} kit${
      kits.length === 1 ? '' : 's'} · ${discs.length} disc set${discs.length === 1 ? '' : 's'} · ${
      free.length} pad set${free.length === 1 ? '' : 's'} free</span>`));

    discs.forEach((d, di) => {
      const kit = kitOfDiscSet(car, a.id, d.id);
      const kitOnCar = cur[a.discs] === d.id && cur[a.pads] === d.padSetId;
      const block = el('brack-kit' + (kitOnCar ? ' oncar' : '') + (kit ? '' : ' unbedded'));
      // The kit's own line: what the pair is called, and the one decision that
      // is taken about the PAIR rather than about either part.
      const head = el('brack-kithead', kit
        ? `<span class="kitchip" title="the pads bedded onto these discs — click the name to change it">KIT
             <input data-kitname type="text" maxlength="12" />
           </span>` +
          (onDraft() || kitOnCar ? '' : `<button data-act="unlink" title="take the pads back off these discs">UNBED</button>`)
        : `<span class="kitchip none" title="a disc set with no pads bedded onto it cannot go on the car as a kit">NO KIT</span>` +
          (onDraft() ? '' : `<button data-act="link" ${
            free.some(p => !p.scrapped) ? '' : 'disabled title="every pad set is already bedded onto a disc"'}>BED PADS&hellip;</button>`));
      const kitNameInp = head.querySelector('[data-kitname]');
      if (kitNameInp) {
        kitNameInp.value = kit.name;
        kitNameInp.addEventListener('change', () =>
          send({ type: 'brakeKitRename', axle: a.id, discSetId: d.id, name: kitNameInp.value }));
      }
      head.querySelector('[data-act="unlink"]')?.addEventListener('click', () =>
        send({ type: 'brakeKitLink', axle: a.id, discSetId: d.id, padSetId: null }));
      head.querySelector('[data-act="link"]')?.addEventListener('click', () => {
        const k = `${a.id}:disc:${d.id}`;
        brakeLinkAsk = brakeLinkAsk === k ? null : k;
        brakeScrapAsk = null;
        brakeEditAsk = null;
        redraw();
      });
      block.appendChild(head);

      block.appendChild(partRow(a.discs, discs, di));
      const dEdit = editStrip(a.discs, discs, di);
      if (dEdit) block.appendChild(dEdit);
      const dScrap = scrapStrip(a.discs, d, brakeSetHours(car, a.discs, d));
      if (dScrap) block.appendChild(dScrap);

      if (kit) {
        const pi = pads.findIndex(t => t.id === kit.pad.id);
        block.appendChild(partRow(a.pads, pads, pi));
        const pEdit = editStrip(a.pads, pads, pi);
        if (pEdit) block.appendChild(pEdit);
        const pScrap = scrapStrip(a.pads, kit.pad, brakeSetHours(car, a.pads, kit.pad));
        if (pScrap) block.appendChild(pScrap);
      } else {
        block.appendChild(el('brack-nopad',
          `no pads bedded onto ${esc(d.name)}${d.scrapped ? '' : ' — it cannot go on the car as a kit'}`));
      }
      if (brakeLinkAsk === `${a.id}:disc:${d.id}`) {
        block.appendChild(linkStrip(a, {
          prompt: `Bed which pads onto ${esc(d.name)}?`,
          empty: 'every pad set on this axle is already bedded onto a disc',
          choices: free.filter(p => !p.scrapped).map(p => ({
            id: p.id,
            label: `${p.name} ${p.used ? fmtH(brakeSetHours(car, a.pads, p)) : 'new'}`
          })),
          link: padSetId => ({ discSetId: d.id, padSetId })
        }));
      }
      col.appendChild(block);
    });

    if (free.length) {
      col.appendChild(el('brack-tag sub',
        `AVAILABLE PADS<span class="meta">bedded onto nothing yet — click a set to bed it on</span>`));
      const block = el('brack-kit loose');
      for (const p of free) {
        const pi = pads.findIndex(t => t.id === p.id);
        const bare = discs.filter(x => !x.padSetId && !x.scrapped);
        const act = onDraft() || p.scrapped ? ''
          : `<button data-act="bed" ${bare.length ? '' : 'disabled title="every disc set already carries a pad set"'}>BED ONTO&hellip;</button>`;
        block.appendChild(partRow(a.pads, pads, pi));
        const edit = editStrip(a.pads, pads, pi, act);
        if (edit) {
          edit.querySelector('[data-act="bed"]')?.addEventListener('click', () => {
            const k = `${a.id}:pad:${p.id}`;
            brakeLinkAsk = brakeLinkAsk === k ? null : k;
            brakeScrapAsk = null;
            redraw();
          });
          block.appendChild(edit);
        }
        const strip = scrapStrip(a.pads, p, brakeSetHours(car, a.pads, p));
        if (strip) block.appendChild(strip);
        if (brakeLinkAsk === `${a.id}:pad:${p.id}`) {
          block.appendChild(linkStrip(a, {
            prompt: `Bed ${esc(p.name)} onto which discs?`,
            empty: 'every disc set on this axle already carries a pad set',
            choices: bare.map(x => ({
              id: x.id,
              label: `${x.name} ${x.used ? fmtH(brakeSetHours(car, a.discs, x)) : 'new'}`
            })),
            link: discSetId => ({ discSetId, padSetId: p.id })
          }));
        }
      }
      col.appendChild(block);
    }
  });
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
  // Nothing was planned, so there is no planned driver change to show — but
  // live timing usually already knows who climbed in. Offer that as the
  // preselected answer rather than making the engineer find the name: it is
  // the single most common thing an unplanned stop got wrong.
  const wantDrv = svc.driverChange ||
    (h.unplanned && !h.corrected && feedDriverId && feedDriverId !== prevDrvId ? feedDriverId : null);
  return `<span class="correctform">
    <label>FUEL LEFT WITH <input data-fix="fuel" type="number" min="0" step="1"
      value="${Math.round(Number(svc.fuelLiters) || 0)}" title="0 = no fuel was taken"></label>
    <label>TYRES <select data-fix="tyres">
      <option value="">not changed</option>
      ${sets.map(t => `<option value="${t.id}" ${svc.tyres && t.id === fittedId ? 'selected' : ''}>fitted ${esc(t.name)}</option>`).join('')}
    </select></label>
    <label>DRIVER <select data-fix="driver">
      <option value="">no change${prevDrvId ? ' — ' + esc(car.drivers.find(d => d.id === prevDrvId)?.name || '') : ''}</option>
      ${car.drivers.map(d => `<option value="${d.id}" ${wantDrv === d.id ? 'selected' : ''}>${esc(d.name)} got in${d.id === feedDriverId ? ' · live timing says so' : ''}</option>`).join('')}
    </select></label>
    <span class="fixbrakes">${BRAKE_AXLES.map(a => {
      const work = svc[a.discs] ? 'kit' : svc[a.pads] ? 'pads' : 'none';
      // The part that was on the car before the stop cannot be what "went on":
      // if the axle really was worked on, something else came off the rack.
      const sel = comp => {
        const fitted = car.state.currentBrakeSetId?.[comp];
        const wasOn = h.brakeSetIds?.[comp];
        const pool = usableBrakeSets(car, comp).filter(t => t.id !== wasOn);
        return `<select data-fixbset="${comp}" title="which numbered set actually went on">
          ${pool.map(t => `<option value="${t.id}" ${t.id === fitted ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>`;
      };
      return `<span class="fixbrake" data-fixaxle="${a.id}" data-work="${work}">
        <b>${a.label}</b>
        ${[['none', 'NO'], ['pads', 'PADS'], ['kit', 'KIT']].map(([w, lab]) =>
          `<button class="toggle ${work === w ? 'on' : ''}" data-fixwork="${a.id}:${w}">${lab}</button>`).join('')}
        ${sel(a.pads)}${sel(a.discs)}</span>`;
    }).join('')}</span>
  </span>`;
}

// What the last pit-lane visit was, and what the app did about it. Four things
// it can say: the stop applied itself (with an undo while it is still fresh),
// the car was serviced with nothing planned — so the visit is on the sheet but
// nobody has said what was done to the car — the car only drove through so
// nothing was touched, or the board is carrying a stop the sheet never saw.
//
// None of these expire. A notice that quietly removes itself is how a whole
// session goes by with a stop missing from the sheet and nobody the wiser:
// they are answered, or they stay on screen.
let pitVisitKey = '';
function renderPitVisit(car) {
  const el = $('pit-visit');
  if (!el) return;
  const v = car.state.lastPitVisit;
  const miss = car.state.pitCatchUp;
  if (!v && !miss) {
    el.classList.add('hidden');
    pitVisitKey = '';
    return;
  }
  // A stop missing outright outranks one that only needs signing off.
  if (miss && !(v && v.applied && !v.disputed && v.atMs > miss.atMs)) {
    const key = `miss:${miss.atMs}:${miss.stops}`;
    if (key === pitVisitKey) return;
    pitVisitKey = key;
    el.classList.remove('hidden');
    el.innerHTML = `<span class="lab" style="color:var(--amber)">STOP MISSING FROM THE SHEET</span>
      <b style="color:var(--amber)">NOTHING APPLIED</b>
      <span class="mil">live timing came back showing <b>${miss.stops}</b> more stop${miss.stops === 1 ? '' : 's'}
        than the sheet has — the car pitted while the feed was down</span>
      <span class="acts">
        <button class="keep" data-act="apply">APPLY AS A STOP</button>
        <button data-act="dismisspit">OK</button></span>`;
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
      (v.feedTimed ? ' <span style="opacity:.7">(timed by the feed)</span>' : '') +
      (v.transitSec ? ` <span style="opacity:.7">(drive-through ${v.transitSec} s)</span>` : '')
    : v.byHand ? 'applied by hand' : 'the feed did not time this visit';

  if (v.applied && v.disputed) {
    // Denied: the stop is on the sheet as planned, and now the engineer writes
    // down what really happened. Saving moves every figure to match.
    el.innerHTML = `<span class="lab" style="color:var(--amber)">WHAT ACTUALLY HAPPENED</span>
      ${correctForm(car)}
      <span class="acts">
        <button data-act="undo" class="scrap">NO STOP HAPPENED — UNDO IT</button>
        <button data-act="cancel">BACK</button>
        <button class="keep" data-act="save">${icon('check')} SAVE WHAT HAPPENED</button></span>`;
  } else if (v.unplanned && v.applied) {
    // Nothing was ordered and the car was serviced anyway — a stop taken on
    // the radio, or one the crew simply never put through the card. The visit
    // is on the sheet and on the timeline where it happened, and NO service
    // has been applied: the fuel, the rubber and the seat are still whatever
    // they were. That is the question, and it stays up until it is answered.
    el.innerHTML = `<span class="lab" style="color:var(--amber)">STOP LOGGED · NOTHING WAS PLANNED</span>
      <b>WHAT WAS DONE TO THE CAR?</b>
      <span class="mil">${timing} — the stint is closed, no fuel, tyres or driver change applied</span>
      <span class="acts">
        <button class="scrap" data-act="undo">NO STOP HAPPENED — UNDO IT</button>
        <button data-act="confirm">NOTHING WAS DONE</button>
        <button class="keep" data-act="dispute">${icon('check')} SAY WHAT WAS DONE</button></span>`;
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
      <span class="mil">${timing}${v.kind === 'held' ? ' — the car was in the lane with the clock stopped' : ' — the car was serviced without a plan'}</span>
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


// ---- tyre warmers ----
// The rack says what rubber the team owns; the warmers say what is ready to go
// on the car. The icon on the tyre card opens the boxes: how many there are and
// what is in each one, filled from the same stock the stop plan fits — so a set
// is only ever in one place, and the question the crew actually asks at 03:00
// ("is the set we are calling for hot?") is answered on the card.

let warmersOpen = false;
let warmerKey = '';

function closeWarmers() {
  if (!warmersOpen) return;
  warmersOpen = false;
  warmerKey = '';
  renderWarmers(state?.cars[carId]);
}

// What a warmer row says about the rubber in it. The set on the car is never in
// a box, so these figures are the ones banked on the set — no live counter.
function warmerSetLine(car, set) {
  if (!set) return 'nothing in it';
  if (!set.used) return 'new';
  const km = tyreSetMileage(set).km;
  const left = tyreKmLeft(car, set);
  return `${set.laps} laps · ${km.toFixed(0)} km` + (left != null ? ` · ${left.toFixed(0)} km left` : '');
}

function renderWarmers(car) {
  const btn = $('btn-warmers');
  const pop = $('warmer-pop');
  if (!btn || !pop) return;
  if (!car) { pop.classList.add('hidden'); return; }
  const warmers = car.tyreWarmers || [];
  const sets = car.tyreSets || [];
  const setOf = id => sets.find(t => t.id === id) || null;
  const full = warmers.filter(w => setOf(w.setId)).length;
  // The set the next stop would fit — the one the boxes are being judged on.
  const next = stopTyreSet(car, car.nextStop);
  const holding = next ? warmers.find(w => w.setId === next.id) : null;

  btn.classList.toggle('on', warmersOpen);
  btn.classList.toggle('cold', !!next && warmers.length > 0 && !holding);
  btn.setAttribute('aria-expanded', String(warmersOpen));
  $('warmer-badge').textContent = warmers.length ? `${full}/${warmers.length}` : '—';

  pop.classList.toggle('hidden', !warmersOpen);
  if (!warmersOpen) { warmerKey = ''; return; }

  // Redraw only when something on show moved: the fitted set banks kilometres
  // every lap, and rebuilding under an open picker would shut it in the
  // engineer's face.
  const key = JSON.stringify([
    warmers.map(w => [w.id, w.name, w.setId]),
    warmers.map(w => warmerSetLine(car, setOf(w.setId))),
    warmableTyreSets(car).map(t => [t.id, t.name]),
    next?.id || null, holding?.id || null
  ]);
  if (key === warmerKey) return;
  warmerKey = key;

  const rows = warmers.map(w => {
    const set = setOf(w.setId);
    const isNext = !!set && !!next && set.id === next.id;
    const opts = warmableTyreSets(car, w.setId);
    return `<div class="wrow${set ? ' on' : ''}${isNext ? ' isnext' : ''}">
      <span class="wnm">${esc(w.name)}</span>
      <select data-warmer="${w.id}" title="What is in ${esc(w.name)}">
        <option value="">— empty —</option>
        ${opts.map(t => `<option value="${t.id}"${t.id === w.setId ? ' selected' : ''}>${
          esc(t.name)}${t.used ? '' : ' · new'}</option>`).join('')}
      </select>
      <span class="wmeta">${warmerSetLine(car, set)}</span>
      ${isNext ? '<span class="wpill">NEXT</span>' : ''}
      <button data-empty="${w.id}"${set ? '' : ' disabled'} title="Take it out">${icon('x')}</button>
    </div>`;
  }).join('');

  // The stock line: what is left on the rack that could still go in a box.
  const spare = warmableTyreSets(car).length;
  const foot = !warmers.length
    ? '<p class="hint">No warmers. Press + once for each one the garage has.</p>'
    : (next
        ? `<p class="hint${holding ? '' : ' warn'}">${esc(next.name)} goes on at the next stop — ${
            holding ? `it is in ${esc(holding.name)}.` : 'it is in no warmer.'}</p>`
        : '<p class="hint">No stop is fitting tyres right now.</p>') +
      `<p class="hint">${spare} set${spare === 1 ? '' : 's'} on the rack still out of a warmer.</p>`;

  pop.innerHTML = `
    <div class="wtop">
      <span class="wlab">${icon('warmer')} TYRE WARMERS</span>
      <span class="wcount" title="How many warmers the garage has">
        <button data-act="less"${warmers.length ? '' : ' disabled'}>−</button>
        <b>${warmers.length}</b>
        <button data-act="more"${warmers.length >= TYRE_WARMER_MAX ? ' disabled' : ''}>+</button>
      </span>
    </div>
    ${warmers.length ? `<div class="wrows">${rows}</div>` : ''}
    ${foot}`;

  pop.querySelector('[data-act="more"]')?.addEventListener('click', () =>
    send({ type: 'tyreWarmerCount', count: warmers.length + 1 }));
  pop.querySelector('[data-act="less"]')?.addEventListener('click', () =>
    send({ type: 'tyreWarmerCount', count: warmers.length - 1 }));
  for (const sel of pop.querySelectorAll('[data-warmer]')) {
    sel.addEventListener('change', () => send({
      type: 'tyreWarmerLoad', warmerId: sel.dataset.warmer, setId: sel.value || null
    }));
  }
  for (const b of pop.querySelectorAll('[data-empty]')) {
    b.addEventListener('click', () => send({
      type: 'tyreWarmerLoad', warmerId: b.dataset.empty, setId: null
    }));
  }
}

$('btn-warmers').addEventListener('click', e => {
  e.stopPropagation();
  warmersOpen = !warmersOpen;
  warmerKey = '';
  renderWarmers(state?.cars[carId]);
});
document.addEventListener('click', e => {
  if (!e.target.closest('#warmer-pop') && !e.target.closest('#btn-warmers')) closeWarmers();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWarmers(); });

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
      const d = settingsCar().drivers[+i];
      const L = learnedOf(settingsCar().learn, d.id, cond);
      const target = settingsCar().config.fuelModel === 'driver-laptime'
        ? `a curve point at ${fmtLap(L.avgSec)}` : `${d.name}'s ${cond} average`;
      if (confirm(`Adopt ${L.burnLPerLap} L/lap (${cond}) as ${target}? Projections update immediately.`)) {
        adoptLearned(+i, cond, L);
      }
    });
  }
}

// ---- in-car correction (driver + stint clock, set by hand) ----------------
// The NOW strip's DRIVER and STINT readings open this: the manual override for
// a seat the sheet has wrong (a swap the feed saw but nobody logged, or a feed
// reading the wrong name) and for a stint clock that started on the wrong
// moment (a stop the app missed). Both are corrections of the record, not a
// pit stop — a real driver change is logged in the stop planner.

const incarOverlay = $('incar-overlay');

// "1:23:45", "23:45" or "23" (minutes) → ms, null when it does not read.
function parseClockMs(text) {
  const parts = String(text).trim().split(':').map(p => p.trim());
  if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  if (parts.length === 3) return ((n[0] * 60 + n[1]) * 60 + n[2]) * 1000;
  if (parts.length === 2) return (n[0] * 60 + n[1]) * 1000;
  return n[0] * 60e3;
}

function openIncar() {
  const car = state?.cars[carId];
  if (!car) return;
  const sel = $('incar-driver');
  sel.innerHTML = car.drivers
    .map(d => `<option value="${d.id}" ${d.id === car.currentDriverId ? 'selected' : ''}>${esc(d.name)}</option>`)
    .join('');
  // The stint clock is only a thing while a stint is running.
  const clock = raceClock(state.race, Date.now());
  const startMs = clock.running ? stintStartOf(car, state.race) : null;
  const inp = $('incar-stint');
  inp.value = startMs ? fmtClock(drivenMs(state.race, startMs, Date.now())) : '';
  inp.disabled = !startMs;
  inp.title = startMs ? 'h:mm:ss or m:ss' : 'No running stint — the stint clock starts with the race.';
  const hint = $('incar-feed-hint');
  const rec = feedDriverId ? car.drivers.find(d => d.id === feedDriverId) : null;
  if (rec && rec.id !== car.currentDriverId) {
    hint.hidden = false;
    hint.innerHTML = `${icon('warn')} Live timing reads <b>${esc(rec.name)}</b> in the car — pick them above if the feed is right.`;
  } else {
    hint.hidden = true;
  }
  incarOverlay.classList.remove('hidden');
}
// One tap on the feed's disagreement puts its driver in the seat. It does not
// log a stop — the whole point is that this is the swap nobody logged — so the
// current stint keeps running and is credited to the driver now named on it,
// exactly as the manual correction in the dialog behind it does.
$('now-driver-feed').addEventListener('click', e => {
  const b = e.target.closest('button[data-act="seat"]');
  if (!b) return;
  e.stopPropagation(); // the strip behind it opens the full correction dialog
  const car = state?.cars[carId];
  const drv = car?.drivers.find(d => d.id === b.dataset.drv);
  if (!drv || drv.id === car.currentDriverId) return;
  if (!confirm(`Put ${drv.name} in the car?\n\nLive timing reads them in it. ` +
    'The running stint is credited to them and NO pit stop is logged — if they got in at a stop, log the stop instead.')) return;
  send({ type: 'setDriver', driverId: drv.id });
});

$('now-driver-itm').addEventListener('click', openIncar);
$('now-stint-itm').addEventListener('click', openIncar);
$('btn-incar-close').addEventListener('click', () => incarOverlay.classList.add('hidden'));
incarOverlay.addEventListener('click', e => { if (e.target === incarOverlay) incarOverlay.classList.add('hidden'); });

$('btn-incar-apply').addEventListener('click', () => {
  const car = state?.cars[carId];
  if (!car) return incarOverlay.classList.add('hidden');
  const inp = $('incar-stint');
  let stintMs = null;
  if (!inp.disabled && inp.value.trim()) {
    stintMs = parseClockMs(inp.value);
    if (stintMs == null) {
      return alert(`Cannot read "${inp.value}" as a stint time — use h:mm:ss or m:ss.`);
    }
  }
  const id = $('incar-driver').value;
  if (id && id !== car.currentDriverId) send({ type: 'setDriver', driverId: id });
  if (stintMs != null) {
    // Only a real edit is sent: the prefilled value keeps ticking underneath,
    // so re-applying an untouched field must not nudge the clock.
    const startMs = stintStartOf(car, state.race);
    const curMs = startMs ? drivenMs(state.race, startMs, Date.now()) : 0;
    if (Math.abs(stintMs - curMs) >= 1500) send({ type: 'setStintTime', elapsedMs: stintMs });
  }
  incarOverlay.classList.add('hidden');
});

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
  // Written on every render until the engineer types, so a panel opened before
  // the pit wall answered does not sit on two blank fields once it does. A
  // field with the caret in it is left alone, and only a real change is
  // written — a date input rewritten on every tick swallows its own picker.
  const dur = $('plan-duration');
  const start = $('plan-start');
  const startVal = state.race.startMs ? toLocalInput(state.race.startMs) : '';
  if (document.activeElement !== dur && dur.value !== String(state.race.durationH)) {
    dur.value = state.race.durationH;
  }
  if (document.activeElement !== start && start.value !== startVal) start.value = startVal;
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

// Why the plan cannot be built right now, or '' when it can. One reading for
// the panel and for both buttons, so what the panel says and what a press does
// can never disagree.
const NO_LINK_WHY = 'The stint plan is race state and lives on the pit wall, so ' +
  'every station and the wall itself read the same one — a station cannot build ' +
  'one on its own.';
function planRefusal() {
  if (!state) return 'There is no link to the pit wall. ' + NO_LINK_WHY;
  const why = planBlockers(state.cars[carId], planRace());
  return why.length
    ? 'The stint plan cannot be built yet:\n\n· ' + why.join('\n· ')
    : '';
}

$('btn-plan-generate').addEventListener('click', () => {
  const no = planRefusal();
  if (no) return alert(no);
  const race = planRace();
  const plan = generatePlan(state.cars[carId], race, Date.now());
  plan.durationH = race.durationH;
  patchCar({ plan });
});
$('btn-plan-replan').addEventListener('click', () => {
  const no = planRefusal();
  if (no) return alert(no);
  const clock = raceClock(state.race, Date.now());
  if (!clock.running) return alert('The race is not running — use GENERATE for a pre-race plan.');
  const plan = replanFromNow(state.cars[carId], state.race, Date.now());
  plan.durationH = state.race.durationH;
  patchCar({ plan });
});

// Reassigning a planned stint. Delegated from the panel because the table is
// re-rendered on every state push, so per-row listeners would not survive.
$('plan-out').addEventListener('change', e => {
  const sel = e.target.closest('select.plan-drv');
  if (!sel) return;
  send({ type: 'planStint', index: +sel.dataset.idx, driverId: sel.value });
});

// ---- saved plans (kept in the shared state on the pit wall PC) ----

$('btn-plan-save').addEventListener('click', () => {
  if (!state) return;
  const plan = state.cars[carId].plan;
  if (!plan?.stints?.length) return alert('No plan to save — press GENERATE first.');
  // No name typed: name it after the race it was built for, so saving is one
  // tap. A second save under the same default asks before overwriting.
  const name = $('plan-name').value.trim() ||
    `${plan.durationH || state.race.durationH} h race plan`;
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
  if (planOverlay.classList.contains('hidden')) return;
  // Opened with no pit wall to talk to — the documented way to work ahead of
  // the event. The settings pages fall back to this PC's draft car there, but
  // a plan cannot: it is shared race state and the wall is where it lives. So
  // the panel says that, instead of showing two blank fields and two buttons
  // that do nothing.
  if (!state) {
    planKey = 'nolink';
    savedPlanKey = 'nolink';
    $('plan-saved-list').innerHTML =
      '<p class="hint">Saved plans live on the pit wall with the race state — there is no link to it.</p>';
    $('sheet-out').innerHTML = '';
    $('plan-out').innerHTML = `<p class="planwarn">${icon('warn')} <b>No link to the pit wall.</b> ${
      esc(NO_LINK_WHY)} The crew can be filled in now under SETTINGS → DRIVERS — the plan itself builds in one press once the link is up.</p>`;
    return;
  }
  const car = state.cars[carId];
  // A panel opened before the wall answered still has its fields to fill.
  fillPlanTimeline();
  renderSavedPlans(car);
  const plan = car.plan;
  // The running order is part of the key: a driver moved up from the stop card
  // changes no timestamp, and the table would sit there showing the old order.
  // So is the driver table itself — what the order is measured against — or a
  // night flag turned off in SETTINGS would leave the plan silently approving
  // a stint it should now be warning about.
  const key = (plan ? String(plan.generatedMs) : 'none') +
    `|${car.stintHistory.length}|${car.state.lapsThisStint}` +
    `|${plan?.stints ? plan.stints.map(st => st.driverId).join(',') : ''}` +
    `|${car.drivers.map(d => `${d.id}:${d.name}:${d.night ? 1 : 0}${d.doubleStint ? 1 : 0}`).join('~')}` +
    `|${car.config.regTotalMin || 0}:${car.config.reg6hMin || 0}`;
  if (!force && key === planKey) return;
  planKey = key;
  renderStintSheet(car);
  const out = $('plan-out');
  if (!plan || !plan.stints?.length) {
    // "Press GENERATE" is no help when GENERATE cannot do anything: name what
    // is missing, in the order the engineer would go and fix it.
    const why = planBlockers(car, planRace());
    out.innerHTML = why.length
      ? `<p class="planwarn">${icon('warn')} <b>Nothing to build a plan from yet:</b> ${
          why.map(esc).join(' · ')}.</p>`
      : '<p class="hint">No plan yet — press GENERATE.</p>';
    return;
  }
  const drvOf = id => car.drivers.find(d => d.id === id);
  const idxOf = id => car.drivers.findIndex(d => d.id === id);
  const wallTime = ms => new Date(plan.startMs + ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const pva = planVsActual(car, state.race, Date.now());

  // A stint already driven is history; the running one and everything after it
  // is still the crew's to reassign, which is what the stop recommendation reads.
  const firstEditable = car.stintHistory.length;
  const issues = planDriverIssues(car);
  const nextIdx = plannedNextStintIndex(car, state.race, Date.now());
  const rows = plan.stints.map((s, i) => {
    const d = drvOf(s.driverId);
    const editable = i >= firstEditable;
    const dot = `<span class="dot" style="background:${DRIVER_COLORS[idxOf(s.driverId) % DRIVER_COLORS.length]}"></span>`;
    const warn = s.noNightCover ? ` <span title="no night-capable driver — flag needs attention">${icon('warn')}</span>` : '';
    // What this row breaks in the driver table. Amber on the row itself, so a
    // hand-edited order shows where it went wrong and not just that it did.
    const rowBad = issues.byStint[i] || [];
    const bad = rowBad.length
      ? ` <span class="warn" title="${esc(rowBad.map(x => x.text).join(' · '))}">${icon('warn')}</span>`
      : '';
    const r = pva?.rows[i];
    let actual = '<td></td><td></td>';
    let rowCls = s.night ? 'night' : '';
    if (i === nextIdx) rowCls += ' next';
    if (rowBad.length) rowCls += ' offplan';
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
      <td class="drv">${dot} ${editable
        ? `<select class="plan-drv" data-idx="${i}">${car.drivers.map(o =>
            `<option value="${o.id}"${o.id === s.driverId ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`
        : (d ? d.name.replace(/</g, '&lt;') : '?')}${s.night ? ' ' + icon('moon') : ''}${warn}${bad}</td>
      <td class="num">${fmtMinSec(s.toMs - s.fromMs)}</td>
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
    ? `<p class="hint">${icon('timer')} Planned for a <b>${plan.durationH} h</b> race starting ${new Date(plan.startMs).toLocaleString()} — the live session is ${state.race.durationH} h. SAVE CURRENT PLAN above keeps it for the real race.</p>`
    : '';

  // Everything the order now breaks, in one line above the table — the totals
  // pills next to it are the other half of the same reading.
  const issueLine = issues.list.length
    ? `<p class="planwarn">${icon('warn')} <b>The running order no longer matches the driver table:</b> ` +
      issues.list.map(x => esc(x.text) + (!x.indexes?.length ? ''
        : ` (stint${x.indexes.length > 1 ? 's' : ''} ${x.indexes.map(n => n + 1).join(', ')})`)).join(' · ') +
      ' — fix it in the DRIVER column, or REPLAN REST FROM NOW.</p>'
    : '';

  // The generator hit its stint cap before the flag. Never a planning choice —
  // a stint length this short comes from a setting, and the plan on screen is
  // not the race, so it is said before the table rather than left to be noticed
  // in the last row.
  const cutLine = plan.truncated
    ? `<p class="planwarn">${icon('warn')} <b>This plan stops at ${
        fmtClock(plan.truncated.atMs)} of ${fmtClock(plan.truncated.totalMs)}.</b> The stints came out so short that ${
        PLAN_STINT_CAP} of them do not reach the flag — check the tank size and the safety fuel under SETTINGS → FUEL, and the max stint time under WEAR &amp; PIT.</p>`
    : '';

  out.innerHTML = `
    ${customTimeline}
    ${cutLine}
    ${issueLine}
    ${plan.assumedStart ? `<p class="hint">${icon('warn')} No race start time set — night hours assume the race starts now (${new Date(plan.startMs).toLocaleString()}). Set a start time on the pit wall for correct night stints.</p>` : ''}
    ${driftLine}
    <div class="plan-totals">${totals}</div>
    <table class="drv-table plan-table">
      <thead><tr><th>#</th><th>Race time</th><th>Clock</th><th>Driver</th><th>Length</th><th>Fuel used</th><th>Actual</th><th>Δ end</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">${plan.replanned ? 'Replanned' : 'Generated'} ${new Date(plan.generatedMs).toLocaleString()} · ${plan.stints.length} stints. Each stint is a tank of fuel — it runs until the usable fuel is burnt at the driver's dry burn (only the max stint time cuts it shorter), so Fuel used is the litres the stint burns, not the fill. The plan is shared — every station and reconnect sees the same one. Rows: ✓/driver = as driven, Δ end = actual stop time vs plan.</p>`;
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
      // The stop that ended this stint was never planned and nobody has said
      // what was done at it — the row is real, the service behind it is blank.
      open: !!h.unplanned && !h.confirmed,
      tyreSet: setName(h.tyreSetId), live: false };
  });
  if (clock.running && car.state.stintStartMs) {
    const st = stintStats(car.state.stintLapSec);
    const used = car.state.stintFuelStartL != null
      ? Math.max(0, car.state.stintFuelStartL - car.state.fuelLiters) : null;
    entries.push({
      i: entries.length, driverId: car.currentDriverId,
      fromMs: stintStartOf(car, state.race), toMs: now, laps: car.state.lapsThisStint,
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
      <td class="num">${e.i + 1}${e.open
        ? ` <span style="color:var(--amber)" title="the stop that ended this stint was not planned — nobody has said what was done">${icon('warn')}</span>`
        : ''}</td>
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
  // Only costs anything while the card is flipped to the settings side.
  if (!cautionPanel.hasAttribute('hidden')) {
    fillCautionInputs();
    renderCautionOut(car);
    renderCautionGraph(car);
    renderFlagRule(car);
  }

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
    // Everything in the lane is discounted by the same factor, so a
    // neutralisation is when to do the work as well as the fuel. Say what a
    // tyre change actually costs on top while the field is crawling.
    const tyreSec = car.config.tyreChangeSec || 0;
    if (tyreSec > 0) {
      const rig = refuelTimeSec(car.config, fs && !fs.noStopNeeded
        ? Math.max(0, fs.fillTargetL - car.state.fuelLiters) : 0);
      const fuelOnly = pitCostSec(car, cond.pace, { refuelSec: rig });
      const withWork = pitCostSec(car, cond.pace, { refuelSec: rig, boxWorkSec: tyreSec });
      const nowSec = withWork.lossNeutral - fuelOnly.lossNeutral;
      const greenSec = withWork.lossGreen - fuelOnly.lossGreen;
      if (greenSec > nowSec + 0.5) {
        boxHint += ` · tyres cost <b>${nowSec.toFixed(0)} s</b> extra now ` +
          `<small>(${greenSec.toFixed(0)} s under green)</small>`;
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

  // ---- under green: what the next flag would be worth, before it flies.
  // The banner above only exists during a neutralisation, which is the moment
  // the crew has no time left to work anything out. This is the same maths
  // read forward: if a board went out on this lap, what does the stop become?
  const preview = $('fcy-preview');
  const showPreview = cond.id === 'green' && c.clock.running && fs && !fs.noStopNeeded;
  preview.classList.toggle('hidden', !showPreview);
  if (showPreview) {
    const fillL = Math.max(0, fs.fillTargetL - car.state.fuelLiters);
    const rig = refuelTimeSec(car.config, fillL);
    const tyreSec = car.config.tyreChangeSec || 0;
    const leg = key => {
      const cost = pitCostSec(car, key, { refuelSec: rig });
      // Same comparison the verdict makes: an open window costs nothing extra,
      // a shut one buys a whole pit loss that the discount has to cover.
      const net = (fs.windowOpen ? 0 : (car.config.pitLossSec || 0)) - cost.gainSec;
      const withT = pitCostSec(car, key, { refuelSec: rig, boxWorkSec: tyreSec });
      const tyreNow = withT.lossNeutral - cost.lossNeutral;
      const label = key === 'fcy' ? 'CODE 60' : 'SAFETY CAR';
      return `<span class="${net <= 0 ? 'good' : 'no'}">${label} ` +
        (net <= 0 ? `save ~${Math.abs(net).toFixed(0)} s` : `lose ~${net.toFixed(0)} s`) +
        `</span>` + (tyreSec > 0 ? ` <small>(tyres +${tyreNow.toFixed(0)} s)</small>` : '');
    };
    preview.innerHTML = `${icon('flag')} <b>IF A FLAG DROPS NOW</b> ` +
      `<small>fill ${fillL.toFixed(0)} L · window ${fs.windowOpen ? 'open' : 'shut'}</small> ` +
      leg('fcy') + ' <i>·</i> ' + leg('sc');
  }

  // fuel
  // The server drains the tank (and broadcasts) every 10 s; between snapshots
  // the countdowns keep ticking against the time the snapshot arrived. Frozen
  // while the car sits in the pit lane — the server pauses the burn there too.
  const fuelTick = ms => c.clock.running && !car.state.inPit && stateRxMs
    ? Math.max(0, ms - (Date.now() - stateRxMs)) : ms;
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
  $('fuel-time').textContent = fmtMinSec(fuelTick(c.msToSafety));
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

  // The standing call for a flag that has not flown yet. With the window shut,
  // a stop under a neutralisation buys an extra stop later — it only pays if
  // the fill is big enough to cover it, and that threshold never moves during
  // the race. So the crew can be told now what the next Code 60 is worth.
  const beEl = $('fuel-breakeven');
  const windowOpen = !!fs && fs.windowOpen && !fs.noStopNeeded;
  const needL = fs && !fs.noStopNeeded ? Math.max(0, fs.fillTargetL - car.state.fuelLiters) : null;
  // Both flags, always — the Safety Car is the harder call of the two and the
  // engineer has no time to work it out once the board is out. The one that is
  // actually flying is marked so the eye lands on it first.
  const beCell = key => {
    const be = fs?.breakEven?.[key] || fuelBreakEven(car, key === 'fcy' ? 'fcy' : 'sc');
    const label = key === 'fcy' ? 'C60' : 'SC';
    if (!be) return `<span class="dim">${label} —</span>`;
    const live = cond.pace === key;
    const met = windowOpen || (be.rule === 'always') ||
      (be.rule !== 'never' && needL != null && needL >= be.litersL);
    const text = windowOpen || be.rule === 'always' ? 'any'
      : be.rule === 'never' ? 'never'
      : `${be.litersL.toFixed(0)} L`;
    return `<span class="${met ? 'good' : ''}${live ? ' live' : ''}">${label} ${text}</span>`;
  };
  beEl.innerHTML = beCell('fcy') + ' <i>·</i> ' + beCell('sc') +
    (needL != null ? ` <small>need ${needL.toFixed(0)} L</small>` : '');
  beEl.className = 'v bethresh' + (windowOpen ? ' good' : '');

  // Low-fuel banner: flashes once the tank is down to the warning liters.
  // Muted while the car is already in the pit lane (the stop is happening) and
  // when the maths says the fuel reaches the flag anyway (end of race).
  // Liters lead, because that is the unit the threshold is set in and the one
  // the crew reads off the rig; the laps and the clock follow.
  const fwEl = $('fuel-warn');
  const fw = fs?.warn;
  if (fw && fw.level !== 'ok' && !fs.noStopNeeded && !car.state.inPit) {
    fwEl.classList.remove('hidden');
    fwEl.classList.toggle('crit', fw.level === 'crit');
    fwEl.innerHTML = `${icon('fuel')} LOW FUEL — ${Math.floor(fw.litersLeft)} L ` +
      `(${fw.lapsLeft} LAP${fw.lapsLeft === 1 ? '' : 'S'}) ` +
      `TO SAFETY LEVEL — BOX IN ${fmtMinSec(fuelTick(fw.msLeft))}` +
      (fs.windowOpen ? ` · FILL TO ${fs.fillTargetL} L` : '');
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
  // The rationing line: fresh sets against what the distance to the flag still
  // needs. This is where spending sets early stops being invisible — the margin
  // is what every "free" tyre change under a flag is drawing down.
  {
    const el = $('tyre-stock');
    let b = null;
    try { b = tyreBudget(car, state.race, Date.now(), c); } catch { b = null; }
    if (!b || !(b.kmToRun > 0)) {
      el.textContent = '—';
      el.className = 'v';
    } else {
      const m = b.setsMargin;
      const other = b.activeCompound === 'wet' ? 'slick' : 'wet';
      el.textContent = `${b.setsFresh} ${b.activeCompound} · needs ~${b.setsNeededMin} · margin ${m >= 0 ? '+' : ''}${m}`
        + (b.setsFreshOther > 0 ? ` · ${b.setsFreshOther} ${other} held back` : '');
      el.className = 'v ' + (m < 0 ? 'crit' : m <= 1 ? 'warn' : 'good');
    }
  }
  renderSetDecision(car, c);
  renderWarmers(car);
  renderPitVisit(car);

  // brakes — same card as the tyres, below the rubber
  renderBrakes(c);

  // rolling pace of the driver in the car
  renderPace(car);

  // drivers + NOW strip (the timing-fed cells are set in renderTiming)
  renderDrivers(car, c);
  const drvNow = car.drivers.find(d => d.id === car.currentDriverId);
  $('now-driver').textContent = drvNow ? drvNow.name : '—';
  $('stint-time').textContent = fmtMinSec(c.stintElapsedMs);
  $('stint-time').className = 'num' + (c.msDriverLeft < 5 * 60e3 ? ' crit' : c.msDriverLeft < 10 * 60e3 ? ' warn' : '');
  // Under a red flag the stint clock stands still with the field: the tag
  // says why the number is not moving.
  $('stint-held').hidden = !c.stintHeld;
  $('stint-max').textContent = car.config.maxStintMin + ' min';
  $('now-fuel').textContent = c.clock.running ? fmtMinSec(fuelTick(c.msToSafety)) : '—';
  $('now-fuel').className = 'num' + (c.lapsToEmpty <= 3 ? ' crit' : c.lapsToEmpty <= 8 ? ' warn' : '');
  // The hour the car is due in the lane under green: the same binding limit the
  // alert chip counts down, laid on the wall clock so the crew reads a time of
  // day and not a countdown. The limit stops at the safety fuel level, so this
  // hour is the stop itself, not the moment the tank runs dry. Nothing to name
  // once the limit falls beyond the flag — that stint runs to the end.
  const gsEl = $('now-greenstop');
  const stopDue = c.clock.running && c.limit.ms < c.clock.remainingMs;
  gsEl.textContent = stopDue
    ? new Date(now + c.limit.ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : '—';
  gsEl.className = 'num' + (!stopDue ? ''
    : c.limit.ms < 5 * 60e3 ? ' crit' : c.limit.ms < 15 * 60e3 ? ' warn' : '');
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
  // Faces settle before the fit: the pinned heights are what autofit sums.
  facesAfterRender();
  autofit();
}

// ---- the stop panel -------------------------------------------------------

const PLAN_TABS = [['green', 'GREEN'], ['fcy', 'CODE 60'], ['sc', 'SAFETY CAR']];
const VERDICT_CLS = {
  boxNow: 'crit', box: 'go', stay: 'hold', noStop: 'go', plan: 'calm', none: 'calm'
};

// Brake work the plan on screen calls for — the starting point when the
// engineer begins toggling components by hand. Resolved live from that plan,
// not from the stop record, which only carries figures once one is sent.
function plannedBrakes(car) {
  const plans = recommendedStops(car, state.race, Date.now());
  const r = resolveStop(car, plans[planTab] || plans.green);
  return BRAKE_COMPONENTS.filter(b => r[b.id]).map(b => b.id);
}

let planLinesKey = '';
let planHoldKey = '';
let planWallKey = '';
// Estimated seconds in the pit lane for the stop the card is planning — set
// by renderPlanner, read by the timeline so both price the stop the same way.
let nextStopLaneSec = null;

function renderPlanner(car, c, now) {
  const stop = car.nextStop;
  const plans = recommendedStops(car, state.race, now, c);
  // Until the engineer holds one, the card follows whatever is actually flying.
  const tab = activePlanKey(car, plans);
  planTab = tab;
  const plan = plans[tab];
  const pinned = stopPins(car, tab);
  const inPit = car.state.inPit;
  const live = stop.status !== 'draft'; // the engineer has committed this stop
  const held = PLAN_KEYS.includes(stop.plan);

  // ---- the three situations: when each would happen, and how far each plan
  // has been written. A corner dot says this one is no longer just the app's
  // answer — somebody has shaped it, and whether it has been signed off.
  for (const b of $('plan-tabs').children) {
    const id = b.dataset.plan;
    const p = plans[id];
    const ap = stop.approvals?.[id];
    const custom = Object.keys(stopPins(car, id)).length > 0;
    b.classList.toggle('on', id === tab);
    b.classList.toggle('live', plans.live === id);
    b.classList.toggle('held', held && stop.plan === id);
    b.classList.toggle('mk-approved', !!ap && !ap.stale);
    b.classList.toggle('mk-stale', !!ap && !!ap.stale);
    b.classList.toggle('mk-custom', !ap && custom);
    const onWall = wallShowsPlan(car, id);
    b.classList.toggle('offwall', !onWall);
    b.title = (id === tab && held
      ? `Holding the ${PLAN_LABEL[id]} plan — tap again to follow the race. `
      : `Write the ${PLAN_LABEL[id]} plan. `) +
      (custom ? 'Its own lines are pinned here. ' : 'Every line follows the app here. ') +
      (onWall ? '' : 'The wall carries no column for it until the flag is out.');
    b.querySelector('[data-when]').textContent =
      plans.live === id ? 'NOW'
        : p.dueMs != null && p.dueMs > 0 ? fmtMinSec(p.dueMs)
        : id === 'green' ? '—' : 'if it drops';
  }

  // ---- does the wall carry a column for this situation? Two neutralisation
  // columns that say the same thing are width the crew cannot spare — and the
  // wall never folds them together on its own, because a column that comes and
  // goes with what a plan happens to say reads as news across the garage. So it
  // is the engineer who takes one down. Green never offers the switch: the
  // planned stop is what the whole card is built around.
  const wallEl = $('plan-wall');
  const onWall = wallShowsPlan(car, tab);
  wallEl.classList.toggle('hidden', tab === 'green');
  // Rebuilt only when the words change, for the same reason the hold bar is.
  const wallKey = tab === 'green' ? '' : tab + '|' + onWall;
  if (wallKey && wallKey !== planWallKey) {
    wallEl.className = 'planwall' + (onWall ? '' : ' off');
    wallEl.innerHTML = `${icon('monitor')} <span>` + (onWall
      ? `The wall carries an <b>IF ${PLAN_LABEL[tab]}</b> column for this car`
      : `<b>OFF THE WALL</b> — no ${PLAN_LABEL[tab]} column. The plan still stands, ` +
        `and the wall shows it the moment the flag is out`) +
      `</span><button data-wall="${onWall ? 'hide' : 'show'}">` +
      `${onWall ? 'TAKE IT OFF THE WALL' : 'PUT IT BACK'}</button>`;
  }
  planWallKey = wallKey;

  // Holding a tab means the card has stopped following the race — and SEND
  // would ship this plan, not the one for what is flying. Say so, always.
  const holdEl = $('plan-hold');
  holdEl.classList.toggle('hidden', !held || live);
  // Rebuilt only when the words change — a bar that re-renders every second
  // eats the tap on its own button.
  const holdKey = held && !live ? tab + '|' + plans.live : '';
  if (holdKey && holdKey !== planHoldKey) {
    holdEl.innerHTML = `${icon('alert')} <span>WRITING THE <b>${PLAN_LABEL[tab]}</b> PLAN` +
      (plans.live === tab ? '' : ` — the race is ${PLAN_LABEL[plans.live]}`) +
      `</span><button data-follow>FOLLOW THE RACE</button>`;
  }
  planHoldKey = holdKey;

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
  // The notes underneath carry live figures — litres still to add, a seat-time
  // countdown, hours left on the pads — so the key moves on nearly every tick,
  // and rebuilding the lines throws away whatever field the engineer has their
  // hands on. The hand-typed fuel figure could not be typed at all: every
  // keystroke landed in a box that was replaced a second later. While a field
  // in here holds focus the lines are left standing and only their live text is
  // refreshed in place; the rebuild waits until the field is let go. Buttons
  // take focus themselves, so a pin still redraws the moment it is pressed.
  const typing = document.activeElement;
  if (typing && typing.tagName === 'INPUT' && $('plan-lines').contains(typing)) {
    planLinesKey = ''; // whatever else moved is drawn once the field is let go
    $('plan-lines').querySelectorAll(':scope > .pline').forEach((el, i) => {
      const l = lines[i];
      if (!l) return;
      const v = el.querySelector(':scope > .top > .kv2 > .v');
      const n = el.querySelector(':scope > .top > .kv2 > .n');
      if (v && v.innerHTML !== l.v) v.innerHTML = l.v;
      if (n && n.innerHTML !== l.n) n.innerHTML = l.n;
    });
  } else if (key !== planLinesKey) {
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
  // The timeline prices its next-stop marker with the same figure this card
  // quotes, rather than working the plan out a second time. renderPlanner runs
  // before renderTimeline in render(), so the marker is never a tick stale.
  nextStopLaneSec = anyService ? svc.totalSec : null;
  $('stop-est').textContent = anyService
    ? `${svc.addLiters > 0 ? '+' + svc.addLiters.toFixed(0) + ' L · ' : ''}${Math.round(svc.totalSec)} s · ` +
      `${Math.round(svc.totalSec + (car.config.pitLossSec || 0))} s`
    : '—';

  // ---- the approval tick, for the plan on screen
  const ap = stop.approvals?.[tab];
  const bar = $('plan-approve');
  bar.className = 'approvebar' + (ap ? (ap.stale ? ' stale' : ' done') : '');
  bar.innerHTML = ap && !ap.stale
    ? `<span class="box">${icon('check')}</span>
       <span><b>${PLAN_LABEL[tab]} PLAN APPROVED ${new Date(ap.atMs).toLocaleTimeString()}</b><br>the crew is preparing against this plan</span>
       <button data-approve="no">UNDO</button>`
    : ap && ap.stale
      ? `<span class="box">${icon('warn')}</span>
         <span><b>THE ${PLAN_LABEL[tab]} PLAN MOVED SINCE YOU APPROVED IT</b><br>the wall says so too</span>
         <button data-approve="yes">RE-APPROVE</button>`
      : `<span class="box"></span>
         <span>The crew sees the ${PLAN_LABEL[tab]} plan as the app's suggestion until you approve it</span>
         <button class="send" data-approve="yes">${icon('check')} APPROVE ${PLAN_LABEL[tab]}</button>`;

  // ---- lifecycle. The engineer owns SEND and BOX; the feed owns what follows.
  const acts = $('stop-actions');
  const feedDrives = timing?.conn === 'connected' && state.timing?.autoLap?.[carId] !== false;
  // Nothing is watching the pit-entry loop for this car — the feed is down or
  // auto lap is off — so the car can arrive in the lane at any point in the
  // lifecycle, and most of all at the point where no stop was ever planned: a
  // puncture, damage, a driver called in off-plan. Marking it in must not
  // require sending and boxing a stop that never existed.
  const manualIn = feedDrives ? '' : `<div class="actions" style="margin-top:6px">
      <button data-act="inpit">CAR IN PIT LANE</button></div>`;
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
        <button class="box big" data-act="box">BOX BOX</button></div>` + manualIn;
  } else {
    // Naming the plan on the button is the last chance to notice that a held
    // tab is about to be sent instead of the one for what is flying.
    acts.innerHTML = `<div class="actions">
        <button data-act="clear" title="Clears this situation's plan only — the other two stand">CLEAR ${PLAN_LABEL[tab]}</button>
        <button class="send" data-act="send">SEND ${held ? PLAN_LABEL[tab] + ' PLAN' : 'TO CREW'}</button></div>` + manualIn;
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
  // Brake work names the kit and the part numbers — that is what gets laid out
  // on the trolley.
  const brakes = BRAKE_AXLES.map(a => stopBrakeAxle(car, a.id, r))
    .filter(x => x.work !== 'none')
    .map(x => x.work === 'kit'
      ? `${x.label.toLowerCase()} kit${x.name ? ' ' + esc(x.name) : ''}` +
        (x.disc && x.pad ? ` <span class="t">(${esc(x.disc.name)} + ${esc(x.pad.name)})</span>` : '')
      : `${x.label.toLowerCase()} pads${x.pad ? ' ' + esc(x.pad.name) : ''}`);
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
  // The GREEN plan is the stint plan's running order: a driver called for here
  // has already been moved up in it, so the line says so rather than letting
  // the engineer find out by opening the plan. Anything the order now breaks
  // is carried back to the same line — the warning belongs where the call is
  // made, not only in a modal nobody has open — and it is shown on all three
  // tabs, because a broken running order is broken whatever flag is flying.
  const planIssues = car.plan?.stints?.length ? planDriverIssues(car) : null;
  let drvNote = plan.driver.why;
  if (planTab === 'green' && drvPin) {
    drvNote = drvPin === 'stay'
      ? 'written into the stint plan as a double stint'
      : 'moved up in the stint plan — the order behind it slides one stint back';
  }
  if (planIssues) {
    // What is wrong with THIS stop's stint, and what is wrong with the crew's
    // race as a whole, said in full — those are the engineer's to answer now.
    // A fault ten stints away is not: it is counted, so the card admits the
    // order is broken, and reading it is a trip into the plan.
    const at = plannedNextStintIndex(car, state.race, Date.now());
    const here = [...new Set([
      ...(planIssues.byStint[at] || []).map(x => x.text),
      ...planIssues.list.filter(x => x.index == null).map(x => x.text)
    ])];
    const later = new Set();
    for (const x of planIssues.list) {
      if (here.includes(x.text)) continue;
      for (const i of x.indexes || []) later.add(i);
    }
    const more = (here.length - 1) + (later.size ? 1 : 0);
    if (here.length) {
      drvNote += ` · <span class="warn">${icon('warn')} ${esc(here[0])}${
        more > 0 ? ` · +${more} more in the stint plan` : ''}</span>`;
    } else if (later.size) {
      drvNote += ` · <span class="warn">${icon('warn')} ${later.size} later stint${
        later.size === 1 ? '' : 's'} no longer match${
        later.size === 1 ? 'es' : ''} the driver table</span>`;
    }
  }
  // The app's pick and "stays in" cover the normal calls; everyone else who
  // could take the car gets their own button, so a swap is one tap. The driver
  // already in the car is not offered — that is what STAYS IN means.
  const drvOpts = [['auto', 'APP'], ['stay', 'STAYS IN'],
    ...car.drivers.filter(d => d.id !== car.currentDriverId)
      .map(d => [d.id, driverAbbrev(d).toUpperCase()])];

  const brakeIds = BRAKE_COMPONENTS.filter(b => r[b.id]).map(b => b.id);
  const brakePin = pinned.brakes || null;
  const brakeSetPin = pinned.brakeSets || null;
  // Brakes are called by axle: a whole KIT (discs with the pads bedded onto
  // them) or PADS onto the discs already on the car. The part numbers are the
  // detail underneath — what the crew has to pull off the rack.
  const brakeAxles = BRAKE_AXLES.map(a => stopBrakeAxle(car, a.id, r));
  const brakeWork = brakeAxles.filter(x => x.work !== 'none');
  const partTag = (comp, set) => !set ? '—'
    : set.used ? fmtH(brakeSetHours(car, comp, set)) : 'new';
  // SELECT PARTS… lights while the rack is open and stays lit once a specific
  // set is pinned — the button is the state, not just a door. It sits alongside
  // the component buttons rather than replacing them: which components get
  // changed and which numbers go on them are two separate calls, and the app
  // can still own the first while the engineer owns the second. (Copied, never
  // the pinned array itself — this list gets pushed to.)
  const brakeSel = brakePin
    ? (brakePin.length
      ? BRAKE_AXLES.map(a => `${a.id}:${brakeAxleWork(brakePin)[a.id]}`).filter(k => !k.endsWith(':none'))
      : ['none'])
    : ['auto'];
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
      n: drvNote,
      sel: [!drvPin ? 'auto' : drvPin],
      opts: drvOpts
    },
    {
      id: 'brakes', k: 'BRAKES', icon: 'brake', pinned: !!(brakePin || brakeSetPin),
      quiet: !brakeWork.length,
      v: brakeWork.length
        ? brakeWork.map(x => x.work === 'kit'
          ? `${x.label} KIT ${x.name ? esc(x.name) : '—'}`
          : `${x.label} PADS ${x.pad ? esc(x.pad.name) : 'NO SET'}`).join(' · ')
        : 'NO WORK',
      n: brakeWork.length
        ? brakeWork.map(x => {
          const a = brakeAxle(x.axle);
          if (x.work === 'kit') {
            if (x.blocked) return `${x.label}: no kit free in the rack`;
            return `${esc(x.disc.name)} ${partTag(a.discs, x.disc)} + ${esc(x.pad.name)} ${partTag(a.pads, x.pad)}` +
              (x.formed ? ' · a new kit, bedded at this stop' : '');
          }
          if (!x.pad) return `${x.label}: no free pad set in the rack`;
          return `${esc(x.pad.name)} ${partTag(a.pads, x.pad)} onto ${esc(currentBrakeSet(car, a.discs)?.name || 'the discs on the car')}`;
        }).join(' · ')
        : BRAKE_AXLES.map(a => {
          const ax = c.brakeAxles[a.id];
          return `${a.label}${ax.name ? ' ' + esc(ax.name) : ''} ${fmtH(ax.leftH)}`;
        }).join(' · '),
      sel: brakeSel,
      opts: [['auto', 'APP'], ['none', 'NONE'],
        ...BRAKE_AXLES.flatMap(a => [
          [`${a.id}:pads`, `${a.short} PADS`],
          [`${a.id}:kit`, `${a.short} KIT`]
        ]),
        ['pick', 'SELECT PARTS…']]
    }
  ];
}

// The rack, opened from SELECT PARTS…: for an axle having its kit changed,
// the made-up kits still in the rack, each one line with both numbers on it;
// for an axle only having pads, the pad sets bedded onto nothing. Scrapped
// parts are not in here, and neither is a kit half of which is on the car.
function brakePicker(car, r) {
  const axles = BRAKE_AXLES.filter(a => r[a.pads] || r[a.discs]);
  if (!axles.length) {
    return `<div class="setpicker"><div class="srow mounted">
      <span class="meta">Nothing to change — pick an axle above first.</span></div></div>`;
  }
  const cur = car.state.currentBrakeSetId || {};
  const body = axles.map(a => {
    const kitWork = !!r[a.discs];
    let rows;
    if (kitWork) {
      const kits = brakeKitsOf(car, a.id).filter(k => !k.scrapped);
      rows = kits.map(k => {
        const mounted = k.onCar;
        const h = brakeSetHours(car, a.discs, k.disc) + brakeSetHours(car, a.pads, k.pad);
        return `<div class="srow ${mounted ? 'mounted' : ''} ${k.disc.id === r.brakeSetIds?.[a.discs] ? 'on' : ''}" ${
          mounted ? '' : `data-bkit="${a.id}:${k.disc.id}"`}>
          <span class="nm">${esc(k.name)}</span>
          <span>${esc(k.disc.name)} + ${esc(k.pad.name)}</span>
          <span class="meta">${mounted ? 'on the car' : k.used ? fmtH(h) + ' between them' : 'unused'}</span>
        </div>`;
      }).join('');
      const bare = brakeSetsOf(car, a.discs).filter(t => !t.scrapped && !t.padSetId).length;
      if (bare) {
        rows += `<div class="srow mounted"><span class="meta">${bare} disc set${bare === 1 ? '' : 's'} with no pads bedded on ${
          bare === 1 ? 'it' : 'them'} — bed a set on in SETTINGS to make ${bare === 1 ? 'it' : 'them'} a kit</span></div>`;
      }
    } else {
      const pool = freePadSets(car, a.id).filter(t => t.id !== cur[a.pads]);
      rows = pool.map(t => {
        const h = brakeSetHours(car, a.pads, t);
        return `<div class="srow ${t.id === r.brakeSetIds?.[a.pads] ? 'on' : ''}" data-bset="${a.pads}:${t.id}">
          <span class="nm">${esc(t.name)}</span>
          <span>${t.used ? 'used' : 'new'}</span>
          <span class="meta">${t.used ? fmtH(h) : 'unused'}</span>
        </div>`;
      }).join('') || `<div class="srow mounted"><span class="meta">every pad set on this axle is bedded onto a disc — change the kit instead</span></div>`;
    }
    const head = kitWork ? `${a.label} — KITS` : `${a.label} — PAD SETS ONTO ${esc(currentBrakeSet(car, a.discs)?.name || 'THE DISCS ON THE CAR')}`;
    return `<div class="srow mounted"><span class="nm">${head}</span></div>${rows}`;
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

// How the page is sized. AUTO fits the window between UI_AUTO_FLOOR and what
// this screen has room for across; a factor set in SETTINGS → DISPLAY is used
// as given. Either way, anything the window cannot hold scrolls (page-scroll)
// instead of being shrunk away or clipped.
const FIT_SLACK = 34;   // breathing room AUTO leaves under the last panel
const SLACK_MAX = 54;   // ...and how far that may drift before it re-fits
const SCROLL_ON = 2;    // clipped by more than this -> the columns scroll
const SCROLL_OFF = 24;  // ...and only stop once there is this much to spare
const SETTLE_MAX = 3;   // deferred passes allowed after a factor change
let settlePasses = 0;

// The exact drop below the fold, for the settings hint. Read off the columns
// rather than worked out from the fit, which rounds a grid's worth of padding
// and gaps in its own favour and would quote the crew a number they cannot
// find on the screen.
function columnOverflow(cols) {
  return Math.max(0, ...cols.map(c => c.scrollHeight - c.clientHeight));
}

// `deferred` marks a pass this function asked for itself, so a factor that
// refuses to converge (each change re-wraps text, which moves the height that
// chose the factor) strobes for three frames rather than for ever.
function autofit(deferred = false) {
  if (!deferred) settlePasses = 0;
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
  const cur = Number(document.body.style.zoom) || 1;
  const innerH = window.innerHeight;
  const picked = getUiZoom();

  let z = cur;
  if (picked === 'auto') {
    // Dead-band control, in real px: re-fit only when the current factor clips
    // the bottom or leaves more than SLACK_MAX. Content height jitters a little
    // on every render (race-control lines wrap and unwrap, values change
    // width), and reacting to each wiggle makes the whole app visibly resize
    // once a second — worse, a factor change re-wraps text, feeding the next
    // wiggle. Fitting onto FIT_SLACK keeps that jitter inside the band.
    const realH = need * cur; // need is layout px; × zoom gives real px
    if (realH - innerH > SCROLL_ON || innerH - realH > SLACK_MAX) {
      z = Math.max(UI_AUTO_FLOOR, Math.min(maxUiZoom(), (innerH - FIT_SLACK) / need));
    }
  } else {
    z = clampUiZoom(parseFloat(picked));
  }
  z = Math.round(z * 1000) / 1000; // or the last digit alone re-triggers a pass
  // The fixed overlays are laid out against the real screen, not the zoomed
  // page: a vh inside a zoomed body paints at zoom × the viewport, so a
  // settings modal capped at 90vh runs off the top and bottom of a scaled-up
  // station. app.css divides by this; it is set on every pass, including the
  // first, so a modal is never sized against a factor that has moved.
  document.documentElement.style.setProperty('--uizoom', String(z));

  if (z !== cur) {
    document.body.style.zoom = z;
    // Whether the leftover scrolls is decided on a pass that changed nothing:
    // mid-settle the height still belongs to the old factor, and acting on it
    // would flash a scrollbar in and out on the way to a factor that fits.
    if (settlePasses < SETTLE_MAX) {
      settlePasses++;
      requestAnimationFrame(() => autofit(true));
    }
  } else {
    // Hysteresis: the scrollbar itself narrows the columns and re-wraps their
    // text, so a single threshold lets the bar appear and disappear on a loop.
    // AUTO aims at FIT_SLACK, which sits clear of SCROLL_OFF, so a page that
    // fits is never left claiming it scrolls.
    const spare = innerH - need * z;
    const cl = document.body.classList;
    if (spare < -SCROLL_ON) cl.add('page-scroll');
    else if (spare > SCROLL_OFF) cl.remove('page-scroll');
  }
  noteUiFit({
    applied: z,
    fitsAt: Math.floor(((innerH - FIT_SLACK) / need) * 100),
    over: document.body.classList.contains('page-scroll') ? columnOverflow(cols) : 0
  });
}
window.addEventListener('resize', () => autofit());

// Meters read like a fuel gauge: the bar shows what is LEFT and drains as the
// resource is consumed. `left` is the remaining fraction (1 = full, 0 = empty).
function setMeter(el, left) {
  left = Math.max(0, Math.min(1, left));
  el.querySelector('i').style.width = (left * 100).toFixed(1) + '%';
  el.className = 'meter' + (left <= 0.15 ? ' crit' : left <= 0.25 ? ' warn' : '');
}

// Pads and discs share one gauge card, grouped by axle and headed by the kit
// on that axle: FRONT KIT F1 with its disc and pad estimates under it, then
// REAR, so the crew reads one end — and one part number pair — at a glance.
function renderBrakes(c) {
  const wrap = $('brakes');
  if (wrap.children.length === 0) {
    for (const axle of ['Front', 'Rear']) {
      const head = document.createElement('div');
      head.className = 'axlehead';
      head.innerHTML = `${axle.toUpperCase()} <b class="kitname" data-kit="${axle.toLowerCase()}"></b>`;
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
  for (const a of BRAKE_AXLES) {
    const el = wrap.querySelector(`[data-kit="${a.id}"]`);
    const ax = c.brakeAxles?.[a.id];
    el.textContent = ax?.name ? `KIT ${ax.name}` : '';
    el.title = ax?.kit ? `${ax.kit.disc.name} + ${ax.kit.pad.name} have run together` : '';
    el.className = 'kitname' + (ax?.kit ? '' : ' none');
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

// Rolling pace of the driver in the car, over their last N timed laps. N is
// the engineer's own setting (config.paceAvgLaps, set in the card's label):
// widen it to read consistency over a stint, drop it to two or three laps
// when the track is changing and only the newest laps mean anything.
// The window follows the DRIVER, not the stint — a driver getting back in
// keeps the laps they did earlier in the race. N counts LAPS THAT COUNT:
// a lap over 107% of the average is struck through and replaced by an
// older one, so the in-lap never lands in the number the crew calls.
const PACE_STRIP_MAX = 10; // chips shown; anything older is counted, not drawn

function renderPace(car) {
  const drv = car.drivers.find(d => d.id === car.currentDriverId);
  const n = paceWindowLaps(car);
  const p = paceWindowStats(car, car.currentDriverId, n);
  $('pace-driver').textContent = drv ? drv.name : 'no driver';
  setInput($('pace-laps'), n);
  $('pace-avg').textContent = fmtLap(p.avgSec);
  $('pace-count').textContent = `${p.counted} of ${p.total}`;

  // The last lap against the window average — the number the crew actually
  // calls. When the newest lap was struck through (the in-lap, a yellow) the
  // row falls back to the last lap that counted and says so, rather than
  // calling a four-minute pit lap as this driver's pace.
  $('pace-last-k').textContent = p.lastIsOut ? 'Last counted lap · vs average' : 'Last lap · vs average';
  $('pace-last-k').title = p.lastIsOut
    ? `the newest lap was a ${fmtLap(p.lastRawSec)} and is not representative`
    : '';
  $('pace-last').textContent = fmtLap(p.lastSec);
  const dEl = $('pace-delta');
  // With a single lap in the window the lap IS the average; a "+0.0" there
  // would read as a measurement rather than as the tautology it is.
  if (p.avgSec != null && p.lastSec != null && p.counted > 1) {
    const d = p.lastSec - p.avgSec;
    dEl.textContent = `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;
    dEl.className = 'dlt' + (d <= -0.1 ? ' fast' : d >= 0.1 ? ' slow' : '');
  } else {
    dEl.textContent = '';
    dEl.className = 'dlt';
  }

  $('pace-range').textContent = p.bestSec != null
    ? `${fmtLap(p.bestSec)} · ${fmtLap(p.worstSec)}`
    : '—';

  // What the window threw away, and the time a lap had to beat to count —
  // so a headline average that just jumped is explained on the same card.
  const struckRow = $('pace-struck-row');
  struckRow.hidden = !p.ignored;
  if (p.ignored) {
    $('pace-struck').textContent = `${p.ignored} lap${p.ignored === 1 ? '' : 's'} over ${fmtLap(p.cutSec)}`;
  }

  const strip = $('pace-strip');
  if (!p.laps.length) {
    strip.innerHTML = '<span class="more">no timed laps for this driver yet</span>';
    return;
  }
  const shown = p.laps.slice(-PACE_STRIP_MAX);
  const hidden = p.laps.length - shown.length;
  const cells = shown.map((t, i) => {
    const idx = i + hidden;
    const out = p.outliers[idx];
    const d = p.avgSec != null ? t - p.avgSec : 0;
    const cls = out ? ' out' : d <= -0.1 ? ' fast' : d >= 0.1 ? ' slow' : '';
    const last = idx === p.laps.length - 1 ? ' now' : '';
    const title = out
      ? `over ${fmtLap(p.cutSec)} — in/out lap, traffic or a neutralisation, in no figure on this card`
      : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} on the average`;
    return `<span class="lap${cls}${last}" title="${title}">${fmtLap(t)}</span>`;
  });
  if (hidden > 0) cells.unshift(`<span class="more" title="in the window, not drawn">+${hidden}</span>`);
  strip.innerHTML = cells.join('');
}

// The other half of seat time: how long a driver has been out of the car. It
// is what the next driver change is actually planned around — a driver two
// hours out is ready, one who climbed out ten minutes ago is not. Drivers who
// have not driven yet have been resting since the start. Still short of a
// mandatory rest period, the cell turns amber and says how much is left.
function restCell(d, cur, c) {
  const r = c.reg?.byDriver?.[d.id];
  if (cur) return '<span class="rest num" title="in the car"></span>';
  const restMs = r?.restMs ?? (c.clock.running ? c.clock.elapsedMs : null);
  if (restMs == null) return '<span class="rest num"></span>';
  const title = r?.resting
    ? `resting ${fmtClock(restMs)} — ${fmtMinSec(r.restLeftMs)} short of the mandatory rest`
    : `resting ${fmtClock(restMs)}` + (r?.restMs == null ? ' — has not driven yet' : '');
  return `<span class="rest num${r?.resting ? ' warn' : ''}" title="${title}">${icon('pause')} ${fmtClock(restMs)}</span>`;
}

function renderDrivers(car, c) {
  const wrap = $('drivers');
  wrap.innerHTML = '';
  const reg = c.reg;
  car.drivers.forEach((d, i) => {
    const cur = d.id === car.currentDriverId;
    // Seat time from the same bookkeeping the regulations are read off, so
    // the panel and the 6 h / total lines can never disagree — and neither
    // can count a stint that belongs to an earlier session.
    const total = c.reg.byDriver[d.id]?.totalMs ?? (d.totalMs + (cur ? c.stintElapsedMs : 0));
    const row = document.createElement('div');
    row.className = 'drv-row' + (cur ? ' cur' : '');
    row.innerHTML = `
      <span class="dot" style="background:${DRIVER_COLORS[i % DRIVER_COLORS.length]}"></span>
      <span class="nm">${cur ? icon('play') + ' ' : ''}${esc(d.name)}</span>
      <span class="badge${d.doubleStint ? '' : ' off'}" title="double stints ${d.doubleStint ? 'yes' : 'no'}">${icon('ff')}</span>
      <span class="badge${d.night ? '' : ' off'}" title="night driving ${d.night ? 'yes' : 'no'}">${icon('moon')}</span>
      <span class="badge${d.rain ? '' : ' off'}" title="rain ${d.rain ? 'yes' : 'no'}">${icon('rain')}</span>
      ${restCell(d, cur, c)}
      <span class="tm num" title="seat time driven">${fmtClock(total)}</span>`;
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

// A pit time the way the crew quotes it: seconds up to two minutes, m:ss
// beyond — past that the car is being repaired, and minutes read faster.
function fmtPitSec(sec) {
  return sec < 120 ? `${Math.round(sec)}s` : fmtMinSec(sec * 1000);
}

// The pit lane on the timeline: a block on the bar for every visit — lane
// entry to release — and above it what the visit costs, the point of the
// panel that the bare stint blocks could not say. The block is the marker:
// a 60 s stop is one pixel wide on a 24 h bar, so it keeps a minimum width
// and the chip above carries the real figure.
//
// Which blocks carry a figure is a question of what is actually known:
//   done   — what the feed timed in the lane, or the planned figure when the
//            stop was applied by hand and nobody timed it
//   live   — the car is in the lane now: the seconds so far, ticking
//   next   — the estimate the plan card quotes for the stop being planned
//   later  — nothing. No service is planned against them yet, so any number
//            would be invented; they stay blocks.
function drawLanes(parts, blocks, x, geo) {
  const { W, barY, barH, stopY, stopH } = geo;
  const lanes = blocks.filter(b => b.kind === 'lane').map(b => {
    const bx = x(b.from), bw = Math.max(6, x(b.to) - bx);
    let txt = '', note;
    if (b.done) {
      txt = b.sec > 0 ? fmtPitSec(b.sec) : '';
      // A stop the app logged because it happened, with nothing planned
      // against it and nobody having said yet what was done, is drawn in
      // amber: it IS on the sheet — that is the point — but the service
      // behind it is still blank.
      note = `Stop ${b.stint + 1} · ${new Date(state.race.startMs + b.to).toLocaleTimeString()} · ` +
        (b.pitSec != null
          ? `${b.pitSec} s in the lane, ${b.stationarySec} s stationary`
          : b.sec > 0
            ? `${Math.round(b.sec)} s planned — the feed did not time this stop`
            : 'not timed') +
        (b.open ? ' — nothing was planned, nobody has said what was done' : '');
    } else if (b.live) {
      txt = fmtPitSec(b.sec);
      note = `In the lane now — ${Math.round(b.sec)} s so far`;
    } else if (b.next && nextStopLaneSec > 0) {
      txt = '~' + fmtPitSec(nextStopLaneSec);
      note = `Next stop — about ${Math.round(nextStopLaneSec)} s in the lane on this plan`;
    } else {
      note = 'Projected stop — nothing planned against it yet';
    }
    return { ...b, bx, bw, cx: bx + bw / 2, txt, note,
      col: b.open ? 'var(--amber)' : 'var(--tl-lane)', solid: b.done || b.live };
  });

  // Every block first, then the chips: a chip must never be cut by the block
  // of the stop after it.
  for (const l of lanes) {
    parts.push(`<g><title>${esc(l.note)}</title>` +
      `<rect x="${l.bx}" y="${barY + 2}" width="${l.bw}" height="${barH - 4}" rx="2" style="fill:${l.col}"${l.solid ? '' : ' opacity=".55"'}/>` +
      (l.solid ? '' : `<rect x="${l.bx}" y="${barY + 2}" width="${l.bw}" height="${barH - 4}" rx="2" fill="url(#tl-hatch)"/>`) +
      '</g>');
  }
  let lastRight = -Infinity;
  for (const l of lanes) {
    if (!l.txt) continue;
    const cw = l.txt.length * 7 + 12;
    const cx = Math.min(Math.max(l.cx - cw / 2, 1), W - cw - 1);
    // On a crowded bar the chips are dropped, not shuffled: the block still
    // says where the stop is, and a row of overlapping times says nothing.
    if (cx < lastRight + 4) continue;
    lastRight = cx + cw;
    const box = l.solid
      ? `style="fill:${l.col}"`
      : `style="fill:var(--panel);stroke:${l.col}" stroke-width="1.5" stroke-dasharray="3 2"`;
    parts.push(`<g><title>${esc(l.note)}</title>` +
      `<path d="M ${cx + cw / 2} ${stopY + stopH} L ${l.cx} ${barY}" fill="none" style="stroke:${l.col}" stroke-width="1" opacity=".5"/>` +
      `<rect x="${cx}" y="${stopY}" width="${cw}" height="${stopH}" rx="4" ${box}/>` +
      `<text x="${cx + cw / 2}" y="${stopY + stopH - 5}" text-anchor="middle" font-size="11" font-weight="700" ` +
      `style="fill:${l.solid ? 'var(--bg)' : l.col}">${l.txt}</text></g>`);
  }
  return lanes.some(l => l.open);
}

// What the flag row calls each condition. Code 60 and a full course yellow
// are the same thing to the strategy (one neutralised pace), so they share a
// name on the bar; the safety car is the one to tell apart.
const FLAG_LABELS = { sc: 'SC', fcy: 'FCY', code60: 'FCY', red: 'RED' };

// A flag period's length the way the row says it: minutes, hours past sixty.
function fmtFlagLen(ms) {
  const m = Math.max(1, Math.round(ms / 60e3));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`;
}

// Flag periods on the bar: a row of their own above the stop chips with one
// band per period, coloured as the top bar flashes it (SC / FCY in the
// condition yellow, the red flag red) and labelled with type and length; on
// a crowded bar the label drops and the band stays, with everything on
// hover. A neutralisation also tints the bar through its whole height, so a
// stop under the safety car reads as a lane block inside a yellow band. A
// red flag needs no tint — the stint blocks are cut into a red block where
// it fell. A period still running ends at the NOW line.
function drawFlags(parts, flags, x, geo) {
  const { barY, barH, flagY, flagH } = geo;
  let lastRight = -Infinity;
  for (const f of flags) {
    const col = f.id === 'red' ? 'var(--red)' : 'var(--cond-yellow)';
    const fx = x(f.from), fw = Math.max(3, x(f.to) - fx);
    if (f.id !== 'red') {
      parts.push(`<g><title>${esc(f.note)}</title>` +
        `<rect x="${fx}" y="${barY}" width="${fw}" height="${barH}" style="fill:${col}" opacity=".2"/>` +
        `<line x1="${fx}" y1="${barY}" x2="${fx}" y2="${barY + barH}" style="stroke:${col}" stroke-width="1" opacity=".7"/>` +
        (f.open ? '' : `<line x1="${fx + fw}" y1="${barY}" x2="${fx + fw}" y2="${barY + barH}" style="stroke:${col}" stroke-width="1" opacity=".7"/>`) +
        '</g>');
    }
    const txt = `${FLAG_LABELS[f.id]} ${fmtFlagLen(f.to - f.from)}`;
    const tw = txt.length * 6.6 + 8;
    const inside = fw >= tw;
    const lx = inside ? fx + fw / 2 : fx + fw + 4;
    const drop = !inside && lx < lastRight + 6;
    parts.push(`<g><title>${esc(f.note)}</title>` +
      `<rect x="${fx}" y="${flagY}" width="${fw}" height="${flagH}" rx="3" style="fill:${col}"/>` +
      (drop ? '' : `<text x="${lx}" y="${flagY + flagH - 4}" text-anchor="${inside ? 'middle' : 'start'}" font-size="11" font-weight="700" ` +
        `style="fill:${inside ? 'var(--bg)' : col}">${txt}</text>`) + '</g>');
    lastRight = Math.max(lastRight, inside || drop ? fx + fw : lx + tw);
  }
}

function renderTimeline(car, now) {
  const svg = $('timeline');
  const race = state.race;
  const clock = raceClock(race, now);
  // Draw in real pixels (viewBox = client size): a fixed 1000-unit canvas
  // stretched to the panel width distorts everything, most visibly the text.
  // Fallback size covers the svg being display:none while another tab is up.
  const W = svg.clientWidth || 1000, H = svg.clientHeight || 190;
  // Vertical budget above the bar: the axis labels along the top, the flag
  // row, then the pit-stop chips — a stop is the one event on this bar that
  // has to be read off it without counting blocks, so it gets a row of its
  // own. Below the bar: the NOW pill and the glyph legend. 118 = all of it.
  const tickY = 13, flagY = 23, flagH = 15, stopY = 45, stopH = 18;
  const barY = 72, barH = H - 118;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const x = ms => (ms / clock.totalMs) * W;
  let parts = [];

  // time grid — colors via style="…var(--x)" so the SVG follows the theme
  // (CSS variables don't work in bare fill/stroke presentation attributes).
  // The tick step adapts to the session length (feed sessions can be 30 min
  // as well as 24 h): smallest step that keeps the axis under ~14 ticks.
  const durH = clock.totalMs / 3600e3;
  const stepH = [1 / 12, 0.25, 0.5, 1, 2].find(s => durH / s <= 14) ?? Math.ceil(durH / 14);

  // "Not driven yet" is diagonal cuts of the page background through the
  // block's own colour — provisional at a glance in both themes, without
  // inventing a separate palette for the future.
  parts.push(`<defs><pattern id="tl-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" style="stroke:var(--bg)" stroke-width="2.5" opacity=".55"/></pattern></defs>`);
  parts.push(`<rect x="0" y="${barY}" width="${W}" height="${barH}" style="fill:var(--well)" rx="4"/>`);

  for (let i = 0; i * stepH <= durH + 1e-9; i++) {
    const h = i * stepH;
    const px = x(h * 3600e3);
    const label = stepH >= 1 ? `${h}h` : `${Math.round(h * 60)}m`;
    parts.push(`<line x1="${px}" y1="${tickY + 4}" x2="${px}" y2="${barY + barH + 6}" style="stroke:var(--line)" stroke-width="1"/>`);
    parts.push(`<text x="${px + 3}" y="${tickY}" style="fill:var(--dim)" font-size="13">${label}</text>`);
  }

  // Night ribbon — the 21:00–06:00 window the plan generator schedules around,
  // drawn where those hours fall in THIS race, so "who covers the night" is a
  // glance at the bar instead of date arithmetic. Hour edges are walked with
  // setHours so a DST change can't drift the 21:00 line.
  const nightBands = [];
  if (race.startMs) {
    const endAbs = race.startMs + clock.totalMs;
    const marks = [race.startMs];
    const d = new Date(race.startMs); d.setMinutes(0, 0, 0);
    while (marks.length < 400) {
      d.setHours(d.getHours() + 1);
      if (d.getTime() >= endAbs) break;
      marks.push(d.getTime());
    }
    marks.push(endAbs);
    for (let i = 0; i < marks.length - 1; i++) {
      if (!isNightAt(marks[i])) continue;
      let j = i + 1;
      while (j < marks.length - 1 && isNightAt(marks[j])) j++;
      nightBands.push([marks[i] - race.startMs, marks[j] - race.startMs]);
      i = j - 1;
    }
    for (const [a, b] of nightBands) {
      parts.push(`<rect x="${x(a)}" y="${barY - 7}" width="${Math.max(1, x(b) - x(a))}" height="5" rx="2.5" style="fill:var(--tl-night)"/>`);
    }
  }

  const driverIdx = {};
  car.drivers.forEach((d, i) => (driverIdx[d.id] = i));

  if (clock.running) {
    const labels = [];
    const blocks = projectStints(car, race, now)
      .map(b => ({ ...b, from: Math.max(0, b.from), to: Math.min(clock.totalMs, b.to) }))
      // A lane block keeps its place even at zero length (no pit loss
      // configured): it is the stop marker, and a stop is never nothing.
      .filter(b => b.kind === 'lane' ? b.to >= b.from : b.to > b.from);
    // The laps figure reads once per stint, in its widest piece — a stint is
    // two pieces when NOW cuts it, more when a red flag did.
    const widest = {};
    blocks.forEach((b, i) => {
      if (b.kind === 'lane' || b.kind === 'red') return;
      const w = blocks[widest[b.stint]];
      if (!w || b.to - b.from > w.to - w.from) widest[b.stint] = i;
    });
    const clockAt = ms => new Date(race.startMs + ms).toLocaleTimeString();
    blocks.forEach((b, bi) => {
      if (b.kind === 'lane') return;
      const bx = x(b.from), bw = Math.max(1, x(b.to) - x(b.from) - 1);
      if (b.kind === 'red') {
        const note = `Red flag · ${clockAt(b.from)} – ${b.open ? 'still out' : clockAt(b.to)} · ` +
          `${fmtFlagLen(b.to - b.from)} · the stint clock stood still`;
        parts.push(`<g><title>${esc(note)}</title>` +
          `<rect x="${bx}" y="${barY + 2}" width="${bw}" height="${barH - 4}" style="fill:var(--red)" opacity=".85" rx="2"/></g>`);
        return;
      }
      const di = (driverIdx[b.driverId] ?? 0) % DRIVER_COLORS.length;
      const color = DRIVER_COLORS[di];
      // The driver's tag inside the block, when it fits: reading the bar must
      // not require decoding the colour legend from the DRIVERS table.
      const ab = b.driverId != null ? esc(driverAbbrev(car.drivers[driverIdx[b.driverId]] || {})) : '';
      // Proposed laps for the stint (to the safety fuel level, or the flag).
      const laps = widest[b.stint] === bi && b.laps > 0 ? b.laps : null;
      const lapsTxt = laps != null ? `${laps} laps` : '';
      const abFits = ab && bw > ab.length * 8 + 10;
      const lapsFits = lapsTxt && bw > lapsTxt.length * 6 + 8;
      const cy = barY + barH / 2;
      const label = (fillAttr, abOp, lapsOp) => {
        if (abFits && lapsFits) {
          labels.push(`<text x="${bx + bw / 2}" y="${cy - 2}" text-anchor="middle" font-size="12" font-weight="700" ${fillAttr} opacity="${abOp}">${ab}</text>`);
          labels.push(`<text x="${bx + bw / 2}" y="${cy + 11}" text-anchor="middle" font-size="10" ${fillAttr} opacity="${lapsOp}">${lapsTxt}</text>`);
        } else if (abFits) {
          labels.push(`<text x="${bx + bw / 2}" y="${cy + 4}" text-anchor="middle" font-size="12" font-weight="700" ${fillAttr} opacity="${abOp}">${ab}</text>`);
        } else if (lapsFits) {
          labels.push(`<text x="${bx + bw / 2}" y="${cy + 3.5}" text-anchor="middle" font-size="10" ${fillAttr} opacity="${lapsOp}">${lapsTxt}</text>`);
        }
      };
      if (b.kind === 'past' || b.kind === 'current') {
        parts.push(`<rect x="${bx}" y="${barY + 2}" width="${bw}" height="${barH - 4}" style="fill:${color}" rx="2"/>`);
        label('fill="#10151d"', '.85', '.7');
      } else {
        const fill = b.kind === 'projected' ? color : 'var(--tl-future)';
        parts.push(`<rect x="${bx}" y="${barY + 2}" width="${bw}" height="${barH - 4}" style="fill:${fill}" opacity="${b.kind === 'projected' ? 0.4 : 0.7}" rx="2"/>`);
        parts.push(`<rect x="${bx}" y="${barY + 2}" width="${bw}" height="${barH - 4}" fill="url(#tl-hatch)" rx="2"/>`);
        label('style="fill:var(--text)"', '.7', '.6');
      }
    });

    // Flag periods, clipped to the race: the neutralisations tint the bar
    // under the labels and lane blocks, then the row above carries them all.
    const flags = flagPeriods(race, now)
      .filter(p => p.id !== 'finish')
      .map(p => ({ ...p, from: Math.max(0, p.fromMs - race.startMs), to: Math.min(clock.totalMs, p.toMs - race.startMs) }))
      .filter(p => p.to > p.from)
      .map(p => {
        const under = blocks.some(b => b.kind === 'lane' && b.done && b.to > p.from && b.from < p.to);
        const name = { sc: 'Safety car', fcy: 'Full course yellow', code60: 'Code 60', red: 'Red flag' }[p.id] || p.id;
        return { ...p, note: `${name} · ${clockAt(p.from)} – ${p.open ? 'still out' : clockAt(p.to)} · ${fmtFlagLen(p.to - p.from)}` +
          ` · ${p.source === 'feed' ? 'from the feed' : 'called by hand'}` + (under ? ' · we stopped under it' : '') };
      });
    const geo = { W, barY, barH, stopY, stopH, flagY, flagH };
    drawFlags(parts, flags.filter(f => f.id !== 'red'), x, geo);
    parts.push(...labels);
    const openStops = drawLanes(parts, blocks, x, geo);
    // The red bands go up last: their block on the bar is already drawn.
    drawFlags(parts, flags.filter(f => f.id === 'red'), x, geo);
    // Plan overlay: amber markers where the shared stint plan expects each
    // stop, so plan-vs-projection divergence is visible at a glance.
    if (car.plan?.stints?.length) {
      for (const s of car.plan.stints) {
        if (!(s.toMs > 0) || s.toMs >= clock.totalMs) continue;
        const px = x(s.toMs);
        parts.push(`<path d="M ${px - 4.5} ${barY - 9} l 4.5 8 l 4.5 -8 z" style="fill:var(--amber)"/>`);
      }
    }
    // now marker: the line, and a pill that stays on-screen at either end
    const nowX = x(clock.elapsedMs);
    parts.push(`<line x1="${nowX}" y1="${barY - 2}" x2="${nowX}" y2="${barY + barH + 8}" style="stroke:var(--text)" stroke-width="2"/>`);
    const pw = 42, pillX = Math.min(Math.max(nowX - pw / 2, 2), W - pw - 2);
    parts.push(`<rect x="${pillX}" y="${barY + barH + 8}" width="${pw}" height="17" rx="8.5" style="fill:var(--text)"/>`);
    parts.push(`<text x="${pillX + pw / 2}" y="${barY + barH + 20.5}" text-anchor="middle" font-size="11" font-weight="700" style="fill:var(--bg)">NOW</text>`);
    // glyph legend — each key drawn with the mark it explains, not described
    // in a sentence
    let lx = 2;
    const gy = H - 12;
    const leg = (glyph, label) => {
      parts.push(glyph);
      parts.push(`<text x="${lx + 18}" y="${H - 3}" style="fill:var(--dim)" font-size="12">${label}</text>`);
      lx += 18 + label.length * 6.5 + 14;
    };
    const curColor = DRIVER_COLORS[(driverIdx[car.currentDriverId] ?? 0) % DRIVER_COLORS.length];
    leg(`<rect x="${lx}" y="${gy}" width="14" height="9" rx="2" style="fill:${curColor}"/>`, 'driven');
    leg(`<rect x="${lx}" y="${gy}" width="14" height="9" rx="2" style="fill:${curColor}" opacity=".4"/><rect x="${lx}" y="${gy}" width="14" height="9" rx="2" fill="url(#tl-hatch)"/>`, 'projected');
    leg(`<rect x="${lx + 4}" y="${gy - 1}" width="6" height="11" rx="1.5" style="fill:var(--tl-lane)"/>`, 'in the pit lane · time above');
    if (openStops)
      leg(`<rect x="${lx + 4}" y="${gy - 1}" width="6" height="11" rx="1.5" style="fill:var(--amber)"/>`, 'stop nobody has said what was done at');
    if (flags.some(f => f.id !== 'red'))
      leg(`<rect x="${lx}" y="${gy}" width="14" height="9" rx="2" style="fill:var(--cond-yellow)"/>`, 'SC · FCY');
    if (flags.some(f => f.id === 'red'))
      leg(`<rect x="${lx}" y="${gy}" width="14" height="9" rx="2" style="fill:var(--red)"/>`, 'red flag · stint clock held');
    if (car.plan?.stints?.length)
      leg(`<path d="M ${lx + 2.5} ${gy} l 4.5 8 l 4.5 -8 z" style="fill:var(--amber)"/>`, 'plan');
    if (nightBands.length)
      leg(`<rect x="${lx}" y="${gy + 2}" width="14" height="5" rx="2.5" style="fill:var(--tl-night)"/>`, 'night');
  } else if (clock.scheduled) {
    parts.push(`<text x="${W / 2}" y="${barY + barH / 2 + 4}" style="fill:var(--amber)" font-size="14" text-anchor="middle">Race starts in ${fmtClock(clock.msToStart)}</text>`);
  } else {
    parts.push(`<text x="${W / 2}" y="${barY + barH / 2 + 4}" style="fill:var(--dim)" font-size="14" text-anchor="middle">Race not started — waiting for pit wall</text>`);
  }
  svg.innerHTML = parts.join('');
}

// With no pit wall the settings pages are the whole app: draw them once at
// boot so a car file can be built on a PC that has never seen a server.
renderDraftSettings();

// re-render every second so clocks/accruals tick between broadcasts
setInterval(render, 1000);
