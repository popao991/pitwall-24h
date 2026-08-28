// Pit wall display (5th PC). Starts the embedded server, then shows one big
// card per car. Idle cards show a compact running summary; when a stop is
// planned the card becomes a service board the crew reads from meters away.
// The only action here is confirming a completed stop.

import {
  PORT, carCalcs, raceClock, stopServiceTime, fuelStrategy, pitLaneCalc, pitEta, pitArrivalOrder,
  fmtClock, fmtMinSec,
  stopTyreSet, tyreSetMileage, isNightAt, BRAKE_AXLES, stopBrakeAxle,
  recommendedStops, resolveStop, PIT_SERVICE_MARGIN_SEC, PLAN_LABEL, activePlanKey, wallShowsPlan,
  TIMING_FLAGS, fmtLapUs, fmtGapUs, timingNrOf, createFeedSeen,
  driverAbbrev, matchTimingDriver, pitSegments, pitLaneTimeSec, refuelTimeSec,
  fuelBreakEven, buildCarFile, readCarFile, carFileName, flagRuleCall
} from '../../shared/model.js';
import { connect } from './net.js';
import { renderConditionBar } from './condition.js';
import { icon, applyIcons } from './icons.js';
import { initTheme, mountThemeSettings, initWallZoom, mountWallSizeSettings, gradeBoard } from './theme.js';
import { initHelpToggles } from './help.js';
import { createTracker } from './trackmap.js';
import { createRcPanel } from './rcmsg.js';

applyIcons();
initTheme();
mountThemeSettings();
initWallZoom();
mountWallSizeSettings();
initHelpToggles();

const $ = id => document.getElementById(id);
// The verdict lines are written straight in; they wrap when they are long
// (see .verdict in app.css), so nothing on the board has to travel to be read.
// The guard keeps an unchanged line's nodes alive across the 1 s render tick.
const setLine = (el, html) => {
  if (!el || el.__html === html) return;
  el.__html = html;
  el.innerHTML = html;
};
const esc = s => String(s).replace(/</g, '&lt;');
let state = null;
let timing = null;
let timingRxMs = 0; // when the last timing snapshot arrived (E.T.A. ticking)
const feedSeen = createFeedSeen(); // timing nrs the feed has posted this session
let stations = {}; // carId → how many station sockets are open on that car
let net = null;
let serverInfo = null; // { ips, port } once the embedded server is up, { error } if not
let wsOk = false; // this page's own socket to the server

// The wall has room for one more message line than a pit-lane laptop.
const rcPanel = createRcPanel({ limit: 4 });

async function boot() {
  let port = PORT;
  try {
    const info = await window.pitwallApi.startServer();
    port = info.port;
    serverInfo = info;
    $('server-ips').textContent = info.ips.length
      ? 'Stations connect to: ' + info.ips.join('  or  ') + `  (port ${info.port})`
      : `port ${info.port}`;
    // The server walked off the default port (it was already held). Stations
    // assume the default, so each one needs this port typed into its
    // SETTINGS → CONNECTION tab — said here, on the screen the crew reads
    // the address off anyway.
    if (info.port !== PORT) {
      $('server-ips').textContent +=
        ` — port ${PORT} was taken, set port ${info.port} on each station (SETTINGS → CONNECTION)`;
    }
    $('server-ips').classList.add('ok');
  } catch (e) {
    serverInfo = { error: e.message };
    $('server-ips').textContent = 'server failed: ' + e.message;
    $('server-ips').classList.add('bad');
  }
  renderHealth();

  net = connect({
    url: `ws://127.0.0.1:${port}`,
    onState: s => { state = s; tracker.setData(s, null); render(); },
    onTiming: t => { timing = t; timingRxMs = Date.now(); feedSeen.update(t); tracker.setData(null, t, timingRxMs); renderTiming(); rcPanel.update(t); },
    onStatus: ok => {
      wsOk = ok;
      const el = $('conn');
      el.textContent = ok ? 'live' : 'reconnecting…';
      el.className = 'conn ' + (ok ? 'ok' : 'bad');
      renderHealth();
    },
    onMessage: m => {
      if (m.type === 'stations') { stations = m.online || {}; if (state) render(); }
      if (m.type === 'timingReplays') renderReplayList(m.list || []);
      if (m.type === 'timingReplayResult' && !m.ok) alert('Replay failed: ' + m.error);
      if (m.type === 'carFileResult') {
        alert(m.ok
          ? `Car file loaded onto ${m.name} — ${(m.applied || []).join(', ')}.` +
            ((m.warnings || []).length ? '\n\n' + m.warnings.join('\n') : '')
          : 'Car file refused: ' + (m.error || 'unknown error'));
      }
    }
  });
}
boot();

// ---- view tabs (wall / tracker) ----

const tracker = createTracker($('trkview'));
const viewTabs = $('view-tabs');
viewTabs.addEventListener('click', e => {
  const btn = e.target.closest('button[data-view]');
  if (btn) showView(btn.dataset.view);
});
let view = 'wall';
function showView(v) {
  view = v;
  for (const b of viewTabs.children) b.classList.toggle('on', b.dataset.view === v);
  $('wall').classList.toggle('hidden', v !== 'wall');
  $('trkview').classList.toggle('hidden', v !== 'tracker');
  if (v === 'tracker') tracker.show();
  else tracker.hide();
  if (state) render();
}

$('btn-back').addEventListener('click', () => (location.href = 'index.html'));
$('btn-start').addEventListener('click', () => {
  if (state && state.race.startMs && Date.now() >= state.race.startMs) return;
  if (confirm('Start the race clock now?')) net.send({ type: 'startRace' });
});
// ---- top bar popovers: admin menu + connection health detail ----
// The wall is display-only during the race, so the manual condition calls
// live on the stations, not here, and the admin buttons hide in a menu.

const menuPop = $('menu-pop');
const healthPop = $('health-pop');
function closePops() {
  menuPop.classList.add('hidden');
  healthPop.classList.add('hidden');
}
$('btn-menu').addEventListener('click', e => {
  e.stopPropagation();
  healthPop.classList.add('hidden');
  menuPop.classList.toggle('hidden');
});
$('health-pill').addEventListener('click', e => {
  e.stopPropagation();
  menuPop.classList.add('hidden');
  healthPop.classList.toggle('hidden');
});
menuPop.addEventListener('click', e => { if (e.target.closest('button')) closePops(); });
document.addEventListener('click', e => { if (!e.target.closest('.tb-pop')) closePops(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePops(); });

// Two laptops can pick the same car — nothing on either screen says so, and
// the pair read as one healthy station while every LAP or APPLY STOP press
// lands twice. A station whose WiFi dropped also leaves its old socket on the
// server until the heartbeat prunes it, which counts as two for a few seconds;
// that reconnect is the common case and must not cry wolf, so the doubling has
// to hold before the wall shouts about it.
const DOUBLE_HOLD_MS = 10000;
const doubledSince = {}; // carId → when its station count first went above one
function doubledCars() {
  const now = Date.now();
  const out = [];
  for (const id of Object.keys(state.cars)) {
    if ((stations[id] || 0) < 2) { delete doubledSince[id]; continue; }
    if (!doubledSince[id]) doubledSince[id] = now;
    if (now - doubledSince[id] >= DOUBLE_HOLD_MS) out.push(id);
  }
  return out;
}

// One pill answers "is everything connected?". Green only when genuinely all
// live; setup time shows the join count plus the address stations need;
// anything degraded names itself. Full detail sits in the popover.
let healthStationsKey = '';
function renderHealth() {
  const pill = $('health-pill');
  const text = $('health-text');
  if (!state) {
    pill.className = 'healthpill';
    text.textContent = serverInfo?.error ? 'SERVER FAILED' : 'starting…';
    return;
  }
  const carIds = Object.keys(state.cars);
  const online = carIds.filter(id => stations[id]).length;
  // Same rule as the cards: a station that never sent live data isn't "lost",
  // the entry simply isn't used (or hasn't joined yet).
  const lost = carIds.filter(id => !stations[id] && state.cars[id].state.liveSeenMs);
  const doubled = doubledCars();
  const running = raceClock(state.race, Date.now()).running;

  const probs = [];
  let sev = 0; // 0 info · 1 warn · 2 bad
  const push = (p, s) => { probs.push(p); if (s > sev) sev = s; };
  if (serverInfo?.error) push('SERVER FAILED', 2);
  if (!wsOk) push('LINK DOWN', 2);
  if (lost.length) push('STATION LOST ' + lost.map(id => '#' + state.cars[id].number).join(' '), 1);
  if (doubled.length) {
    push('DOUBLE STATION ' + doubled.map(id => `#${state.cars[id].number}×${stations[id]}`).join(' '), 1);
  }
  const conn = timing?.conn || 'off';
  if (conn === 'replay') push('REPLAY', 0);
  else if (conn !== 'connected' && conn !== 'off') push('FEED ' + conn.toUpperCase(), 1);
  else if (conn === 'off' && running) push('FEED OFF', 0);

  if (!running && !probs.length) {
    const addr = serverInfo?.ips?.length ? ` · ${serverInfo.ips[0]}:${serverInfo.port}` : '';
    pill.className = 'healthpill' + (carIds.length && online === carIds.length ? ' ok' : '');
    text.textContent = `STATIONS ${online}/${carIds.length}${addr}`;
  } else if (!probs.length) {
    pill.className = 'healthpill ok';
    text.textContent = 'ALL SYSTEMS';
  } else {
    pill.className = 'healthpill ' + (sev === 2 ? 'bad' : sev === 1 ? 'warn' : '');
    text.textContent = probs.join(' · ');
  }

  // popover: one chip per car station
  const det = carIds.map(id => {
    const n = stations[id] || 0;
    const dbl = doubled.includes(id);
    const was = state.cars[id].state.liveSeenMs;
    const cls = dbl ? ' warn' : n ? ' ok' : was ? ' bad' : '';
    const t = dbl ? `${n} stations on this car — every button press lands ${n} times`
      : n ? 'online' : was ? 'connection lost' : 'never connected';
    return `<span class="conn${cls}" title="${t}">#${esc(state.cars[id].number)}` +
      `${dbl ? ' ×' + n : ''}</span>`;
  }).join('');
  if (det !== healthStationsKey) {
    healthStationsKey = det;
    $('health-stations').innerHTML = det || '—';
  }
}

$('btn-reset').addEventListener('click', () => {
  if (confirm('Reset the whole race? Stint history and clocks are cleared (car setups are kept).')) {
    if (confirm('Really sure? This cannot be undone.')) net.send({ type: 'resetRace' });
  }
});

// ---- "which session is this race?" ------------------------------------------
// Raised by the server when the feed is showing a different session than the
// race data on screen (next session of the weekend, another session picked in
// the feed's list, an app left running since qualifying, a mid-session join).
// Laps, clock and flags from the feed are held until this is answered, so the
// previous session's numbers can never bleed into the new one.
//
// Only the genuinely ambiguous half reaches these buttons: a session that is
// starting right now is saved-and-rolled by the server without asking, and
// leaves a notice here instead — with the way back, if it read it wrong.

$('btn-session-new').addEventListener('click', () => {
  const to = state?.timing?.sessionAlert?.to || 'this session';
  if (!confirm(`Start a fresh race for "${to}"?\n\n` +
      'Laps, stint history, seat time, tyre sets and the clock start over ' +
      '(car setups are kept), and the race clock takes the feed\'s session clock.\n\n' +
      'Each car starts on its configured start fuel — joining a session already ' +
      'under way, correct the on-board figure from the stations.')) return;
  net.send({ type: 'sessionNew' });
});
$('btn-session-keep').addEventListener('click', () => {
  const to = state?.timing?.sessionAlert?.to || 'the feed\'s session';
  if (!confirm(`Keep the race on screen and treat "${to}" as its session?\n\n` +
      'Nothing is cleared, and the feed starts counting laps for it again.')) return;
  net.send({ type: 'sessionKeep' });
});

$('btn-session-undo').addEventListener('click', () => {
  const r = state?.timing?.sessionRolled;
  if (!r?.backup) return;
  if (!confirm(`Put "${r.from || 'the saved race'}" back on every screen?

` +
      'It is restored exactly as it was saved, and then runs on ' +
      `"${r.to}" — the session the feed is showing.

` +
      'Everything counted on the new session since is lost.')) return;
  net.send({ type: 'sessionRollUndo' });
});
$('btn-session-ok').addEventListener('click', () => net.send({ type: 'sessionRollOk' }));

function renderSessionAlert() {
  const a = state?.timing?.sessionAlert;
  const rolled = state?.timing?.sessionRolled;
  // A question the wall has to answer outranks a notice about one it did not.
  const asking = !!a && !a.pending;
  const settling = !!a && !!a.pending;
  const show = !!a || !!rolled;
  $('session-strip').classList.toggle('hidden', !show);
  // Amber is for the question. The rest is the app reporting what it did.
  $('session-strip').classList.toggle('info', show && !asking);
  $('btn-session-new').hidden = !asking;
  $('btn-session-keep').hidden = !asking;
  $('btn-session-undo').hidden = !(!a && rolled?.backup);
  $('btn-session-ok').hidden = !(!a && rolled);
  if (!show) return;

  const title = $('session-title');
  const line = $('session-line');
  const sub = $('session-sub');

  // Held while the feed says what the new session is — a second, no more, and
  // the wall never has to touch it.
  if (settling) {
    setLine(title, icon('feed') + ' NEW SESSION');
    line.textContent = `Live timing moved to "${a.to}" — reading what it is.`;
    sub.textContent = 'Laps, clock and flags are held for a moment.';
    return;
  }

  if (asking) {
    setLine(title, icon('warn') + ' WHICH SESSION?');
    line.textContent = a.from
      ? `Live timing moved to "${a.to}" — the race on screen is "${a.from}".`
      : `Live timing is on "${a.to}" — the race on screen was not started from it.`;
    const laps = a.laps || 0;
    sub.textContent =
      (laps ? `${laps} lap${laps === 1 ? '' : 's'} counted on it. ` : 'Nothing counted on it yet. ') +
      'Feed laps, clock and flags are held until you answer.';
    return;
  }

  // Rolled by itself: say what was thrown away and where it went.
  setLine(title, icon('save') + ' NEW SESSION STARTED');
  line.textContent = rolled.from
    ? `"${rolled.to}" started — "${rolled.from}" was saved and a fresh race runs on it.`
    : `"${rolled.to}" started — the race that was on screen was saved and a fresh one runs on it.`;
  const laps = rolled.laps || 0;
  const at = new Date(rolled.ms).toLocaleTimeString();
  sub.textContent = rolled.backup
    ? `${laps ? `${laps} lap${laps === 1 ? '' : 's'} saved` : 'Saved'} at ${at} — ` +
      'in the backup list under SETTINGS, or put straight back here.'
    : `Nothing could be saved at ${at} — no backup folder on this PC.`;
}

// ---- race settings modal ----

const overlay = $('settings-overlay');
$('btn-settings').addEventListener('click', () => { ltFormDirty = false; overlay.classList.remove('hidden'); refreshBackups(); refreshReplays(); });
$('btn-settings-close').addEventListener('click', () => overlay.classList.add('hidden'));
// No click-outside close either: race settings is a form, and a stray click on
// the backdrop mid-edit throws the page away. CLOSE is the way out.

// settings tabs
const tabbar = $('settings-tabs');
function showTab(tab) {
  for (const b of tabbar.children) b.classList.toggle('on', b.dataset.tab === tab);
  for (const sec of overlay.querySelectorAll('[data-pane]')) sec.hidden = sec.dataset.pane !== tab;
  if (tab === 'replays') refreshReplays();
  if (tab === 'backup') refreshBackups();
}
tabbar.addEventListener('click', e => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) showTab(btn.dataset.tab);
});
showTab('race');

// ---- automatic backups ----

$('backup-interval').addEventListener('change', () => {
  const v = parseInt($('backup-interval').value, 10);
  if (!isNaN(v) && v >= 0) net.send({ type: 'settings', patch: { backupIntervalMin: v } });
});
$('btn-backup-refresh').addEventListener('click', refreshBackups);
$('btn-backup-now').addEventListener('click', async () => {
  try {
    const r = await window.pitwallApi.backupNow();
    if (!r.ok) alert('Snapshot failed: ' + (r.error || 'server not running'));
  } catch (e) {
    alert('Snapshot failed: ' + e.message);
  }
  refreshBackups();
});

async function refreshBackups() {
  const wrap = $('backup-list');
  let backups = [];
  try {
    backups = await window.pitwallApi.listBackups();
  } catch {
    wrap.innerHTML = '<p class="hint">Backup list unavailable.</p>';
    return;
  }
  wrap.innerHTML = backups.length ? '' : '<p class="hint">No backups yet.</p>';
  for (const b of backups.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.innerHTML = `
      <span class="nm num">${new Date(b.ms).toLocaleString()}</span>
      <span class="meta">${(b.bytes / 1024).toFixed(1)} kB</span>
      <button data-act="restore" class="danger">RESTORE</button>`;
    row.querySelector('[data-act="restore"]').addEventListener('click', async () => {
      if (!confirm(`Restore the backup from ${new Date(b.ms).toLocaleString()}?\nThe current race state is replaced on every screen.`)) return;
      const r = await window.pitwallApi.restoreBackup(b.name);
      alert(r.ok ? 'Backup restored — all stations are updated.' : 'Restore failed: ' + r.error);
    });
    wrap.appendChild(row);
  }
}

// ---- live timing (feed runs on this PC, stations get the rebroadcast) ----

// The server rebroadcasts state roughly once a second. Until the user hits
// CONNECT (or reopens the settings pane), this form holds an in-progress
// edit that must not be clobbered by that broadcast — otherwise switching
// the source dropdown or filling in host/port/key gets reverted mid-edit.
let ltFormDirty = false;

$('lt-mode').addEventListener('change', () => { ltFormDirty = true; updateLtMode(); });
for (const id of ['lt-url', 'lt-host', 'lt-port', 'lt-key', 'lt-watch']) {
  $(id).addEventListener('input', () => { ltFormDirty = true; });
}
for (const id of ['lt-ssl', 'lt-selfsigned']) {
  $(id).addEventListener('change', () => { ltFormDirty = true; });
}
function updateLtMode() {
  const m = $('lt-mode').value;
  $('lt-url-row').style.display = m === 'url' ? '' : 'none';
  $('lt-ts-rows').style.display = m === 'teamstream' ? '' : 'none';
}

$('btn-lt-connect').addEventListener('click', () => {
  const cfg = {
    mode: $('lt-mode').value,
    url: $('lt-url').value.trim(),
    host: $('lt-host').value.trim(),
    port: parseInt($('lt-port').value, 10) || null,
    ssl: $('lt-ssl').checked,
    allowSelfSigned: $('lt-selfsigned').checked,
    key: $('lt-key').value.trim(),
    watchUrl: $('lt-watch').value.trim()
  };
  if (cfg.mode === 'url' && !cfg.url) return alert('Paste the live timing page URL first.');
  if (cfg.mode === 'teamstream' && (!cfg.host || !cfg.key)) {
    return alert('The direct connector needs the timekeeper host and your TeamStream key.');
  }
  ltFormDirty = false;
  net.send({ type: 'timingConnect', cfg });
});
$('btn-lt-disconnect').addEventListener('click', () => { ltFormDirty = false; net.send({ type: 'timingDisconnect' }); });
$('lt-session').addEventListener('change', () => {
  const id = $('lt-session').value;
  if (id) net.send({ type: 'timingSession', sessionId: id });
});

// ---- session replays (recorded per session on the server, replayed to all) --

function refreshReplays() {
  net.send({ type: 'timingReplayList' });
}
$('btn-replay-refresh').addEventListener('click', refreshReplays);

function renderReplayList(list) {
  const wrap = $('lt-replays');
  if (!list.length) {
    wrap.innerHTML = '<p class="hint">No replays yet — they are recorded automatically while the feed is connected.</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const r of list.slice(0, 30)) {
    const dur = r.durMs ? fmtMinSec(r.durMs) : '—';
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.innerHTML = `
      <span class="nm">${esc(r.session || r.src || r.name)}</span>
      <span class="meta">${new Date(r.ms).toLocaleString()} · ${dur} · ${(r.bytes / 1024).toFixed(0)} kB</span>
      <button data-act="open">${icon('play')} OPEN</button>`;
    row.querySelector('[data-act="open"]').addEventListener('click', () => {
      if (timing?.conn === 'connected' &&
          !confirm('Opening a replay stops the live timing feed on every screen. Continue?')) return;
      net.send({ type: 'timingReplayOpen', file: r.name });
    });
    wrap.appendChild(row);
  }
}

let replaySeekDrag = false;
$('replay-seek').addEventListener('input', () => { replaySeekDrag = true; updateReplayPosLabel(); });
$('replay-seek').addEventListener('change', () => {
  replaySeekDrag = false;
  net.send({ type: 'timingReplayCtl', op: 'seek', value: parseInt($('replay-seek').value, 10) || 0 });
});
$('btn-replay-toggle').addEventListener('click', () => {
  const playing = timing?.replay?.playing;
  net.send({ type: 'timingReplayCtl', op: playing ? 'pause' : 'play' });
});
$('replay-speed').addEventListener('change', () => {
  net.send({ type: 'timingReplayCtl', op: 'speed', value: parseFloat($('replay-speed').value) });
});
$('btn-replay-close').addEventListener('click', () => {
  net.send({ type: 'timingReplayCtl', op: 'close' });
  refreshReplays();
});

function updateReplayPosLabel() {
  const durMs = timing?.replay?.durMs || 0;
  const posMs = replaySeekDrag ? parseInt($('replay-seek').value, 10) || 0 : timing?.replay?.posMs || 0;
  $('replay-pos').textContent = `${fmtMinSec(posMs)} / ${fmtMinSec(durMs)}`;
}

function renderReplayCtl() {
  const box = $('lt-replay-ctl');
  const r = timing?.conn === 'replay' ? timing.replay : null;
  box.classList.toggle('hidden', !r);
  if (!r) return;
  $('btn-replay-toggle').innerHTML = r.playing
    ? icon('pause') + ' PAUSE'
    : icon('play') + ' PLAY';
  if (document.activeElement !== $('replay-speed')) $('replay-speed').value = String(r.speed);
  const seek = $('replay-seek');
  seek.max = String(r.durMs || 1);
  if (!replaySeekDrag) seek.value = String(r.posMs || 0);
  updateReplayPosLabel();
}

function timingEntryFor(car) {
  if (!timing?.entries?.length || !state?.timing) return null;
  const nr = timingNrOf(state.timing, car);
  return timing.entries.find(e => String(e.nr).trim() === nr) || null;
}

function renderTiming() {
  const chip = $('lt-chip');
  if (!timing || !timing.conn || timing.conn === 'off') {
    chip.textContent = 'feed off';
    chip.className = 'conn ltchip';
  } else if (timing.conn === 'replay') {
    chip.style.display = '';
    chip.innerHTML = icon(timing.replay?.playing ? 'play' : 'pause') +
      ` REPLAY ${timing.replay?.playing ? timing.replay.speed + '×' : 'PAUSED'}`;
    chip.className = 'conn ok ltchip lt-none';
  } else if (timing.conn === 'connected') {
    // The TO GO clock in the top bar already shows the feed's countdown —
    // the chip only carries the flag state.
    const flag = TIMING_FLAGS[timing.session?.flag];
    chip.style.display = '';
    chip.innerHTML = icon('timer') + ' ' + (flag ? flag.label : 'LIVE');
    chip.className = 'conn ok ltchip lt-' + (flag?.cls || 'none');
  } else {
    chip.style.display = '';
    chip.innerHTML = icon('timer') + ' LT ' + esc(timing.conn.toUpperCase());
    chip.className = 'conn bad ltchip';
  }

  // settings pane status line
  const st = $('lt-status');
  if (!timing || timing.conn === 'off') {
    st.textContent = 'Feed off.';
  } else {
    const bits = [timing.conn.toUpperCase()];
    if (timing.conn === 'replay' && timing.replay) bits.push(timing.replay.file);
    if (timing.eventName) bits.push(timing.eventName);
    if (timing.session?.name) bits.push(timing.session.name);
    if (timing.entries?.length) bits.push(timing.entries.length + ' cars');
    if (timing.session?.rc) bits.push('RC: ' + timing.session.rc);
    if (timing.lastError) bits.push('error: ' + timing.lastError);
    if (timing.flagWatch) {
      const fw = timing.flagWatch;
      bits.push('flag check ' + (fw.conn === 'connected'
        ? 'LIVE' + (TIMING_FLAGS[fw.flag] ? ': ' + TIMING_FLAGS[fw.flag].label : '')
        : fw.conn.toUpperCase() + (fw.error ? ' — ' + fw.error : '')));
    }
    st.textContent = bits.join(' · ');
  }
  renderReplayCtl();

  // Al Kamel session picker
  const row = $('lt-session-row');
  const sel = $('lt-session');
  const sessions = timing?.sessions;
  if (sessions?.list?.length) {
    row.style.display = '';
    const html = sessions.list.map(s => {
      const label = (s.champ ? s.champ + ' — ' : '') + (s.name || s.id) + (s.closed ? ' (ended)' : '');
      return `<option value="${esc(s.id)}"${s.id === sessions.selected ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
    if (sel.innerHTML !== html && document.activeElement !== sel) sel.innerHTML = html;
  } else {
    row.style.display = 'none';
  }

  renderHealth();
  renderTimingCards();
}

// The feed row a car's pit E.T.A. is reconstructed from. Nothing to go on
// while the feed is down, and nothing left to estimate once the car is in the
// lane — either way the E.T.A. and the pit order simply leave the car out.
function pitFeedEntry(car) {
  const live = timing?.conn === 'connected' || timing?.conn === 'replay';
  const e = live ? timingEntryFor(car) : null;
  return e && !car.state.inPit && !e.inPit ? e : null;
}

// One tick's worth of pit arrivals: every car's E.T.A. worked out once, plus
// the order they put the cars in. `rank` is empty unless two or more cars are
// on their way in — a queue of one is not an order — while `eta` always
// carries whatever each card's own sub-line needs.
function pitArrivals(now) {
  const eta = new Map();
  if (!state) return { eta, rank: new Map() };
  for (const car of Object.values(state.cars)) {
    const e = pitFeedEntry(car);
    eta.set(car.id, e ? pitEta(car, state.race, timing, e, timingRxMs, now) : null);
  }
  const list = pitArrivalOrder(Object.values(state.cars), car => eta.get(car.id), now);
  return { eta, rank: new Map(list.map(q => [q.carId, q])) };
}

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const ordinal = n => ORDINALS[n] || n + 'th';

// Pit arrival estimate: where the car is and when it reaches the pit, from
// its last timing-loop / sector crossing (green pace to the flag, FCY pace
// after). Shown while a stop is live or the race is neutralised — exactly
// when the crew in the box needs to know how long they have. Returns the
// verdict sub-line for the card, or null when there is nothing to show.
function pitEtaLine(car, eta) {
  if (!eta || !(eta.neutral || car.nextStop.status !== 'draft')) return null;
  const dist = eta.distM >= 1000 ? (eta.distM / 1000).toFixed(2) + ' km' : Math.round(eta.distM) + ' m';
  if (eta.stale) {
    return {
      cls: 'stale',
      html: `${icon('boxin')} PIT ENTRY ~${fmtMinSec(eta.etaEntrySec * 1000)} ` +
        `<small>estimate only — no passing for ${fmtMinSec(eta.crossAgeSec * 1000)}</small>`
    };
  }
  return {
    cls: eta.neutral ? 'fcy' : '',
    html: `${icon('boxin')} PIT ENTRY IN <b>~${fmtMinSec(eta.etaEntrySec * 1000)}</b>` +
      (eta.etaBoxSec != null ? ` · AT BOX ~${fmtMinSec(eta.etaBoxSec * 1000)}` : '') +
      ` <small>${dist} @ ${Math.round(eta.paceKmh)} km/h</small>`
  };
}

// One compact line per wall card: position, laps, pace and pit state.
function renderTimingCards() {
  if (!state) return;
  const now = Date.now();
  for (const [id, car] of Object.entries(state.cars)) {
    const card = document.getElementById('card-' + id);
    const el = card?.querySelector('[data-f="lt"]');
    if (!el) continue;
    const feedTag = card.querySelector('[data-f="driver-feed"]');
    // A card showing NO CAR RUNNING keeps its timing lines down too.
    if (card.classList.contains('nocar')) {
      el.style.display = 'none';
      if (feedTag) feedTag.hidden = true;
      continue;
    }
    const e = timing?.conn === 'connected' || timing?.conn === 'replay' ? timingEntryFor(car) : null;
    if (!e) {
      el.style.display = 'none';
      if (feedTag) feedTag.hidden = true;
      continue;
    }
    // Driver recognition under the IN CAR name: quiet agreement, loud
    // disagreement — a swap done on the radio and never logged shows up here.
    const rec = e.driver ? matchTimingDriver(car, e.driver) : null;
    if (feedTag) {
      if (rec && rec.id !== car.currentDriverId) {
        feedTag.hidden = false;
        feedTag.className = 'drvfeed warn';
        feedTag.innerHTML = `${icon('warn')} feed: ${esc(driverAbbrev(rec))}`;
        feedTag.title = `Live timing shows "${e.driver}" in the car`;
      } else if (rec) {
        feedTag.hidden = false;
        feedTag.className = 'drvfeed ok';
        feedTag.innerHTML = `${icon('check')} feed`;
        feedTag.title = `Live timing agrees ("${e.driver}")`;
      } else {
        feedTag.hidden = true;
      }
    }
    el.style.display = '';
    const bits = [];
    if (e.pos != null) bits.push(`P${e.pos}` + (e.pic != null && e.cls ? ` <small>(${esc(e.cls)} ${esc(e.pic)})</small>` : ''));
    if (e.laps != null) bits.push(`${e.laps} laps`);
    if (e.lastUs) bits.push(`last <b>${fmtLapUs(e.lastUs)}</b>`);
    if (e.bestUs) bits.push(`best ${fmtLapUs(e.bestUs)}`);
    if (e.gap != null) bits.push(`gap ${esc(fmtGapUs(e.gap))}`);
    if (e.pits != null) bits.push(`${e.pits} stops`);
    if (e.driver) bits.push(esc(e.driver) + (rec ? ` <span class="drvtag">${esc(driverAbbrev(rec))}</span>` : ''));
    el.innerHTML = (e.inPit ? '<span class="ltpit">IN PIT</span> ' : '') + bits.join(' · ');
    el.classList.toggle('pit', !!e.inPit);
  }
}

let ltLinksKey = '';
function renderLtLinks() {
  const wrap = $('lt-links');
  if (!state?.timing) return;
  const key = Object.values(state.cars).map(c => c.id + ':' + c.number).join('|');
  if (key !== ltLinksKey) {
    ltLinksKey = key;
    wrap.innerHTML = Object.values(state.cars).map(c => `
      <div class="preset-row">
        <span class="nm">#${esc(c.number)} ${esc(c.name || '')}</span>
        <span class="meta">timing nr
          <input data-lt-nr="${esc(c.id)}" type="text" style="width:70px" placeholder="${esc(c.number)}" />
        </span>
        <button data-lt-auto="${esc(c.id)}" class="flag on">AUTO ON</button>
      </div>`).join('');
    for (const inp of wrap.querySelectorAll('input[data-lt-nr]')) {
      inp.addEventListener('change', () =>
        net.send({ type: 'timingLink', carId: inp.dataset.ltNr, nr: inp.value.trim() }));
    }
    for (const btn of wrap.querySelectorAll('button[data-lt-auto]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ltAuto;
        const on = state.timing.autoLap?.[id] === false;
        if (!on && !confirm(`Car #${state.cars[id]?.number}: turn off auto lap?\nThe feed stops driving this car's lap counter and the station's manual lap logging returns.`)) return;
        net.send({ type: 'timingAutoLap', carId: id, on });
      });
    }
  }
  for (const c of Object.values(state.cars)) {
    const inp = wrap.querySelector(`input[data-lt-nr="${CSS.escape(c.id)}"]`);
    if (inp && document.activeElement !== inp) inp.value = state.timing.links?.[c.id] ?? '';
    const btn = wrap.querySelector(`button[data-lt-auto="${CSS.escape(c.id)}"]`);
    if (btn) {
      const on = state.timing.autoLap?.[c.id] !== false; // default ON
      btn.textContent = on ? 'AUTO ON' : 'AUTO OFF';
      btn.className = 'flag' + (on ? ' on' : '');
    }
  }
}

// Car numbers and names: editable on the wall so the whole team's labels can
// be fixed in one place, and so a car whose station is offline can still be
// given its race number — the number is what the board shows and what the
// timing feed is matched on, so it cannot wait for a laptop to come back.
// Both are plain car patches, exactly as if the station's own CAR tab had
// sent them; make and model stay on each station.
let carNamesKey = '';
function renderCarNames() {
  const wrap = $('car-names');
  // Slot order, not board order: these rows are where the numbers are typed,
  // and a list that re-sorts itself under the cursor as a number is entered
  // is a list you cannot fill in. The board itself still runs in number order.
  const slots = Object.keys(state.cars)
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const key = slots.join('|');
  if (key !== carNamesKey) {
    carNamesKey = key;
    wrap.innerHTML = slots.map(id => `
      <div class="preset-row">
        <span class="nm">CAR ${esc(id)}</span>
        <span class="meta">number
          <input data-car-nr="${esc(id)}" type="text" style="width:70px"
                 title="The number on the car's door — shown on the board, and what live timing is matched on unless the LIVE TIMING tab links this car to another number" />
          &nbsp;name
          <input data-car-name="${esc(id)}" type="text" style="width:220px" />
        </span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button data-car-file-load="${esc(id)}" title="Load a car file onto this car — its whole setup in one action">${icon('folder')} LOAD FILE</button>
          <button data-car-file-save="${esc(id)}" title="Write this car's setup out as a car file">${icon('save')} SAVE FILE</button>
        </span>
      </div>`).join('');
    for (const btn of wrap.querySelectorAll('button[data-car-file-load]')) {
      btn.addEventListener('click', () => loadCarFileInto(btn.dataset.carFileLoad));
    }
    for (const btn of wrap.querySelectorAll('button[data-car-file-save]')) {
      btn.addEventListener('click', () => saveCarFileFrom(btn.dataset.carFileSave));
    }
    for (const inp of wrap.querySelectorAll('input[data-car-nr]')) {
      inp.addEventListener('change', () => {
        const id = inp.dataset.carNr;
        // Never blank: the board, the pickers and the feed matching all read
        // this, so an emptied box falls back to the car's slot number.
        const number = inp.value.trim() || id;
        net.send({ type: 'update', carId: id, patch: { number } });
      });
    }
    for (const inp of wrap.querySelectorAll('input[data-car-name]')) {
      inp.addEventListener('change', () => {
        const id = inp.dataset.carName;
        const name = inp.value.trim() || `Car #${state.cars[id].number}`;
        net.send({ type: 'update', carId: id, patch: { name } });
      });
    }
  }
  for (const id of slots) {
    const c = state.cars[id];
    const nrInp = wrap.querySelector(`input[data-car-nr="${CSS.escape(id)}"]`);
    if (nrInp && document.activeElement !== nrInp) nrInp.value = c.number;
    const inp = wrap.querySelector(`input[data-car-name="${CSS.escape(id)}"]`);
    if (!inp) continue;
    // The default name lives in the placeholder, so the box reads empty until
    // the team actually names the car — and follows the number when it changes,
    // including while the box itself is being typed into (tabbing straight from
    // the number is the normal way to fill a row in).
    inp.placeholder = `Car #${c.number}`;
    if (document.activeElement === inp) continue;
    inp.value = c.name && c.name !== `Car #${c.number}` ? c.name : '';
  }
}

// Event settings: one value for all cars, editable only on the pit wall.
for (const inp of overlay.querySelectorAll('input[data-ev]')) {
  inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (isNaN(v) || v < 0) return;
    net.send({ type: 'event', patch: { [inp.dataset.ev]: v } });
  });
}

$('race-name').addEventListener('change', () =>
  net.send({ type: 'race', patch: { name: $('race-name').value || '24H Race' } }));
$('race-duration').addEventListener('change', () => {
  const h = parseFloat($('race-duration').value);
  if (!isNaN(h) && h > 0) net.send({ type: 'race', patch: { durationH: h } });
});
$('btn-apply-start').addEventListener('click', () => {
  const v = $('race-start').value;
  if (!v) return alert('Pick a date & time first.');
  const ms = new Date(v).getTime();
  if (isNaN(ms)) return alert('Invalid date/time.');
  const started = state?.race.startMs && Date.now() >= state.race.startMs;
  const msg = started
    ? 'The race clock is already running — changing the start time shifts the whole race clock. Continue?'
    : `Set race start to ${new Date(ms).toLocaleString()}?`;
  if (confirm(msg)) net.send({ type: 'race', patch: { startMs: ms } });
});
$('btn-clear-start').addEventListener('click', () => {
  if (confirm('Clear the race start time? The clock stops until a new start is set.')) {
    net.send({ type: 'race', patch: { startMs: null } });
  }
});
$('lt-follow').addEventListener('change', () => {
  const on = $('lt-follow').checked;
  if (on && timing?.conn !== 'connected') {
    $('lt-follow').checked = false;
    return alert('Connect the timing feed first (Live timing tab) — the lock needs a session clock to follow.');
  }
  net.send({ type: 'timingFollowClock', on });
});

$('btn-sync-lt-clock').addEventListener('click', () => {
  const s = timing?.conn === 'connected' ? timing.session : null;
  if (!s || s.remainUs == null) {
    return alert('The timing feed has no session clock yet — connect it on the Live timing tab first.');
  }
  const detail = s.totalUs != null
    ? `elapsed ${fmtClock(s.elapsedUs / 1000)}, remaining ${fmtClock(s.remainUs / 1000)} — race duration becomes ${(s.totalUs / 3600e6).toFixed(1).replace(/\.0$/, '')} h`
    : `remaining ${fmtClock(s.remainUs / 1000)} — the feed does not publish the session length, so the ${state?.race.durationH ?? '?'} h duration is kept`;
  if (confirm(`Sync the race clock with the live timing session clock?\n\nFeed: ${detail}.\n\nThis shifts the race start time on every screen.`)) {
    net.send({ type: 'timingSyncClock' });
  }
});

// ---- saved race setups (race name + duration + event settings) ----

// ---- car files ----
// A car's whole setup as one file. The wall can do this for any of the four
// without walking to that station — which is how three cars get set up on the
// Thursday from one seat, and how a car whose laptop was swapped is put back
// exactly as it was.

let carFileVersion = '';
window.pitwallApi?.getVersion?.().then(v => { carFileVersion = v?.version || ''; }).catch(() => {});

async function saveCarFileFrom(id) {
  const car = state?.cars?.[id];
  const api = window.pitwallApi;
  if (!car) return;
  if (!api?.saveCarFile) return alert('This build cannot reach the file system.');
  const res = await api.saveCarFile(carFileName(car), buildCarFile(car, { app: carFileVersion }));
  if (res?.canceled) return;
  if (!res?.ok) return alert('Could not save the car file: ' + (res?.error || 'unknown error'));
  alert(`${car.name} saved to\n${res.path}`);
}

async function loadCarFileInto(id) {
  const car = state?.cars?.[id];
  const api = window.pitwallApi;
  if (!car) return;
  if (!api?.openCarFile) return alert('This build cannot reach the file system.');
  const res = await api.openCarFile();
  if (res?.canceled) return;
  if (!res?.ok) return alert('Could not open the file: ' + (res?.error || 'unknown error'));
  const read = readCarFile(res.text);
  if (!read.ok) return alert(read.error);
  const who = [read.file.car?.number ? '#' + read.file.car.number : '', read.file.car?.name || '']
    .filter(Boolean).join(' ') || 'a car';
  const ok = confirm(
    `Load "${res.name}" (${who}) onto CAR ${id} — ${car.name}?\n\n` +
    'It sets the car information, fuel and pace figures, wear limits, the driver table and ' +
    'the tyre/brake racks on that car, everywhere at once.\n\n' +
    'Laps, mileage, banked hours, seat time and every set that has already run are kept, and ' +
    'the event settings are not touched.');
  if (!ok) return;
  net.send({ type: 'loadCarFile', carId: id, file: read.file });
}

$('btn-racesetup-save').addEventListener('click', () => {
  const name = $('racesetup-name').value.trim();
  if (!name) return alert('Give the race setup a name first.');
  if (state?.raceSetups?.[name] && !confirm(`Race setup "${name}" exists — overwrite it?`)) return;
  net.send({ type: 'saveRaceSetup', name });
  $('racesetup-name').value = '';
});

let raceSetupKey = '';
function renderRaceSetups() {
  const setups = state?.raceSetups || {};
  const key = Object.entries(setups).map(([n, p]) => n + p.savedMs).join('|');
  if (key === raceSetupKey) return;
  raceSetupKey = key;
  const wrap = $('racesetup-list');
  const names = Object.keys(setups).sort();
  wrap.innerHTML = names.length ? '' : '<p class="hint">No race setups saved yet.</p>';
  for (const name of names) {
    const p = setups[name];
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.innerHTML = `
      <span class="nm">${esc(name)}</span>
      <span class="meta">${esc(p.race?.name || '')} · ${p.race?.durationH ?? '?'} h · saved ${new Date(p.savedMs).toLocaleString()}</span>
      <button data-act="load" class="primary">LOAD</button>
      <button data-act="del" class="danger">${icon('x')}</button>`;
    row.querySelector('[data-act="load"]').addEventListener('click', () => {
      if (confirm(`Load race setup "${name}"? Race name, duration and all event settings are replaced on every screen (the start time is kept).`)) {
        net.send({ type: 'loadRaceSetup', name });
      }
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (confirm(`Delete race setup "${name}"?`)) net.send({ type: 'deleteRaceSetup', name });
    });
    wrap.appendChild(row);
  }
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderSettings() {
  const setInput = (el, v) => { if (document.activeElement !== el) el.value = v; };
  setInput($('race-name'), state.race.name || '');
  setInput($('race-duration'), state.race.durationH);
  setInput($('race-start'), state.race.startMs ? toLocalInput(state.race.startMs) : '');
  // A connected feed that publishes the session length overrides the
  // configured duration outright; the follow lock additionally drives the
  // start time.
  const locked = !!state.timing?.followClock;
  if (document.activeElement !== $('lt-follow')) $('lt-follow').checked = locked;
  const followsDuration = timing?.conn === 'connected' && timing?.session?.totalUs != null;
  $('race-duration').disabled = followsDuration;
  $('race-duration').title = followsDuration
    ? 'The timing feed publishes the session length — the duration follows the feed'
    : '';
  // The lock only holds the start time while there is a feed to hold it to.
  // With the link down the clock is the app's own again, and correcting it is
  // exactly what the crew needs to do — leaving the field greyed out because
  // a checkbox is still ticked would take the fallback away at the one moment
  // it is wanted. The lock stays on, and resumes driving the clock when the
  // feed comes back.
  const clockFollows = locked && timing?.conn === 'connected';
  $('race-start').disabled = clockFollows;
  $('btn-apply-start').disabled = clockFollows;
  $('race-start').title = clockFollows
    ? 'The race clock is locked to the timing feed — untick to set the start time by hand'
    : locked ? 'Feed down — the start time can be set by hand until it is back' : '';
  setInput($('backup-interval'), state.settings?.backupIntervalMin ?? 5);
  if (state.event) {
    for (const inp of overlay.querySelectorAll('input[data-ev]')) {
      setInput(inp, state.event[inp.dataset.ev] ?? '');
    }
    // Driving the lane at the limit is only part of the pit loss — show both,
    // and say what the drive-through figure is doing to the stop detector.
    const pl = pitLaneCalc({ config: state.event });
    const dt = +state.event.driveThroughSec || 0;
    const usedDt = dt > 0 ? dt : (pl ? pl.transitSec : 0);
    $('event-derived').textContent = (pl
      ? `At ${pl.kmh} km/h the ${pl.km} km pit lane takes ${pl.transitSec.toFixed(1)} s to drive — ` +
        (pl.overheadSec >= 0
          ? `the ${pl.lossSec} s pit lane loss leaves ${pl.overheadSec.toFixed(1)} s for entry/exit and the detour. `
          : `already more than the ${pl.lossSec} s pit lane loss set above — the loss figure looks too low. `)
      : '') +
      (usedDt > 0
        ? `A pit-lane visit counts as a stop from ${(usedDt + PIT_SERVICE_MARGIN_SEC).toFixed(1)} s ` +
          `(${dt > 0 ? 'measured' : 'derived'} drive-through ${usedDt.toFixed(1)} s + ${PIT_SERVICE_MARGIN_SEC} s); ` +
          `anything quicker applies no service.`
        : 'With no drive-through time and no lane geometry, a visit counts as a stop from 25 s.');

    // The legs composed into the stops the crew actually makes. A worked
    // example beats six raw numbers: it shows what derived, and it shows the
    // minimum stop time swallowing work when one is set.
    const seg = pitSegments(state.event);
    const anyLeg = seg.entryToPump || seg.pumpToBox || seg.boxToExit ||
      +state.event.pumpToExitSec || +state.event.pitEntryToBoxSec || +state.event.minStopSec;
    const legsEl = $('pit-legs-derived');
    if (!anyLeg) {
      legsEl.textContent = 'No legs set — a stop is priced as its stationary work alone ' +
        '(refuelling, then tyres), with the pit lane loss added on top.';
    } else {
      // Reference fill: a full tank on car 1, the stop the crew pictures.
      const car1 = state.cars?.['1'];
      const fillL = car1?.config?.tankLiters || 0;
      const rig = refuelTimeSec(state.event, fillL);
      const tyreSec = car1?.config?.tyreChangeSec || 0;
      const fuelOnly = pitLaneTimeSec(state.event, { refuelSec: rig });
      const both = pitLaneTimeSec(state.event, { refuelSec: rig, boxWorkSec: tyreSec });
      const held = both.heldSec > 0
        ? ` The ${(+state.event.minStopSec || 0).toFixed(0)} s minimum stop still holds the car ` +
          `${both.heldSec.toFixed(0)} s beyond that, so that much work is free.`
        : '';
      legsEl.textContent =
        `Rejoin from the rig derives to ${seg.pumpToExit.toFixed(1)} s, entry to box to ` +
        `${seg.entryToBox.toFixed(1)} s. A ${fillL} L fill (${rig.toFixed(1)} s on the rig) ` +
        `occupies the lane for ${fuelOnly.totalSec.toFixed(1)} s fuel-only, or ` +
        `${both.totalSec.toFixed(1)} s with a ${tyreSec} s tyre change at the box.${held}`;
    }
  }
  $('race-hint').textContent = state.race.startMs
    ? (Date.now() < state.race.startMs
        ? `Scheduled — race starts ${new Date(state.race.startMs).toLocaleString()}`
        : `Race started ${new Date(state.race.startMs).toLocaleString()}`)
    : 'No start time set.';

  // live timing form (values live in the shared state)
  const t = state.timing;
  if (t) {
    if (!ltFormDirty) {
      const setCheck = (el, v) => { el.checked = !!v; };
      $('lt-mode').value = t.mode || 'url';
      updateLtMode();
      setInput($('lt-url'), t.url || '');
      setInput($('lt-host'), t.host || '');
      setInput($('lt-port'), t.port || '');
      setInput($('lt-key'), t.key || '');
      setInput($('lt-watch'), t.watchUrl || '');
      setCheck($('lt-ssl'), t.ssl !== false);
      setCheck($('lt-selfsigned'), t.allowSelfSigned);
    }
    renderLtLinks();
  }
  renderCarNames();
  renderRaceSetups();
}

// ---- car cards ----

const wall = $('wall');

// Wall order: by race number, so the cards match the pit boxes, not the order
// the cars happen to sit in the state object.
function sortedCarIds() {
  return Object.keys(state.cars).sort((a, b) => {
    const na = parseInt(state.cars[a].number, 10);
    const nb = parseInt(state.cars[b].number, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(state.cars[a].number).localeCompare(String(state.cars[b].number), undefined, { numeric: true });
  });
}

function buildCards() {
  wall.innerHTML = '';
  for (const id of sortedCarIds()) {
    const card = document.createElement('div');
    card.className = 'wallcard';
    card.id = 'card-' + id;
    card.innerHTML = `
      <div class="head">
        <span class="carno">#<span data-f="number"></span></span>
        <div class="carid">
          <span class="carname" data-f="name"></span>
          <span class="makemodel" data-f="makemodel"></span>
        </div>
        <div class="pitorder" data-f="pitorder" style="display:none"></div>
        <div class="incar">
          <span class="lab">IN CAR</span>
          <b data-f="driver"></b>
          <span class="drvfeed" data-f="driver-feed" hidden></span>
        </div>
      </div>
      <div class="verdict" data-f="verdict">
        <div class="vmain" data-f="v-main"></div>
        <div class="vsub" data-f="v-sub" style="display:none"></div>
      </div>
      <div class="stationline" data-f="station" style="display:none"></div>
      <div class="stationline" data-f="pitnote" style="display:none"></div>
      <div class="grab" data-f="tiles"></div>
      <div class="extra" data-f="extra" style="display:none"></div>
      <div class="ltline" data-f="lt" style="display:none"></div>
      <div class="wapprove" data-f="approve" style="display:none"></div>
      <div class="foot">
        <button class="inpit" data-f="inpit">${icon('parking')} CAR IN PIT LANE</button>
        <button class="done" data-f="done">${icon('check')} STOP DONE — CAR RELEASED</button>
      </div>`;
    card.querySelector('[data-f="inpit"]').addEventListener('click', () => {
      net.send({ type: 'inPit', carId: id, inPit: true });
    });
    card.querySelector('[data-f="done"]').addEventListener('click', () => {
      const stop = state.cars[id].nextStop;
      if (stop.status === 'draft') return;
      if (confirm(`Car #${state.cars[id].number}: confirm stop complete and apply service?`)) {
        net.send({ type: 'applyStop', carId: id });
      }
    });
    wall.appendChild(card);
  }
}

// Who sits in the car after a stop taken right now: the change already planned
// on the stop if there is one, else the same rule the stint planner uses — a
// double-stint driver stays for their second stint, otherwise the eligible
// driver (night / rain / drive-time regs permitting) with the least seat time
// takes over.
function driverCall(car, c, now) {
  const cur = car.drivers.find(d => d.id === car.currentDriverId) || null;
  const planned = car.drivers.find(d => d.id === car.nextStop.driverChange);
  if (planned) return { change: !cur || planned.id !== cur.id, next: planned };

  const night = isNightAt(now);
  const wet = car.condition === 'wet';
  const fits = d => (!night || d.night) && (!wet || d.rain) &&
    (!c.reg.enabled || c.reg.byDriver[d.id]?.eligible !== false);
  let pool = car.drivers.filter(fits);
  if (!pool.length) pool = car.drivers.slice();

  // Consecutive stints the current driver has already run, incl. this one.
  let run = 1;
  for (let i = car.stintHistory.length - 1; i >= 0; i--) {
    if (car.stintHistory[i].driverId === car.currentDriverId) run++;
    else break;
  }
  if (cur && cur.doubleStint && run === 1 && pool.some(d => d.id === cur.id)) {
    return { change: false, next: cur };
  }
  let cands = pool.filter(d => !cur || d.id !== cur.id);
  if (!cands.length) cands = pool;
  cands.sort((a, b) => (c.reg.byDriver[a.id]?.totalMs || 0) - (c.reg.byDriver[b.id]?.totalMs || 0));
  return { change: !cur || cands[0].id !== cur.id, next: cands[0] };
}

// What the crew needs to know about the set they are about to grab: new, or
// how much is already on it. Mileage is the honest measure across tracks.
function setTag(set) {
  if (!set.used) return 'NEW';
  const km = tyreSetMileage(set).km;
  return km > 0 ? `${km.toFixed(0)} KM` : `${set.laps} LAPS`;
}

// The crew's grab list. Parts down the side, one column per situation: what
// this car needs IF A YELLOW DROPS THIS SECOND, and what the planned green
// stop takes. Every cell always states its own instruction in full — somebody
// reading one column across the garage must never have to look sideways to
// learn what their column asks for. Cells that only repeat what the column
// beside them says are dimmed and left unhighlighted, so the differences are
// still the only thing that pulls the eye.
// Colour is the instruction itself, never a health score: RED means this
// part comes off the car, GREEN means it stays on, amber means the change is
// asked for but there is nothing free in the rack to do it with.
// Each column is headed by its own flag chip in its own colour, so which
// situation a column answers for reads before the words do.
// The engineer keeps a separate plan per situation, so under green the code 60
// and safety car plans get a column each — whether they agree or not. Which
// columns stand is settled by the flag and by what the engineer has left on
// the wall, never by what a plan currently says: a column that came and went
// as the plans converged would have the crew reading a layout change as news.
// Sending a stop takes none of them down either. The stop becomes the card's
// anchor column, and the IF columns stay beside it — the flag can still drop
// while the car is on its way in, and that is exactly when the crew needs to
// know what it would change.
function renderGrab(card, car, c, plans, now) {
  const wrap = card.querySelector('[data-f="tiles"]');
  const stop = car.nextStop;
  const live = stop.status !== 'draft' || car.state.inPit;

  if (!c.clock.running && !live) {
    wrap.innerHTML = '<div class="grabempty">no plan until the race clock runs</div>';
    return;
  }

  // What one plan (or the live stop) asks the crew for, row by row.
  const rowsOf = src => {
    // Fuel is planned as the level to leave with, but the crew's job is the
    // fill — what actually goes in through the rig. So the fill is the figure
    // on the card and the level it fills to rides underneath: nobody standing
    // at the rig should have to subtract the gauge off the plan to work out
    // how much to put in.
    const addL = Math.max(0, Math.ceil(src.fuelLiters - car.state.fuelLiters));
    const fuelTxt = src.fuelLiters <= 0 ? 'NO FUEL'
      : addL > 0 ? `+${addL} L` : 'NOTHING TO ADD';
    const fuelNote = src.fuelLiters <= 0 ? ''
      : addL > 0
        ? `to ${src.fuelMode === 'full' ? 'FULL · ' : ''}${src.fuelLiters} L · ` +
          `${Math.round(refuelTimeSec(car.config, addL))} s on the rig`
        : `already above the ${src.fuelLiters} L it asks for`;
    const set = src.tyres
      ? (src.tyreSetId ? (car.tyreSets || []).find(t => t.id === src.tyreSetId) : stopTyreSet(car, { tyreSetId: null }))
      : null;
    const drv = car.drivers.find(d => d.id === src.driverChange);
    // Brake work by axle, under the name of the kit — and then the part
    // numbers, because the crew grabs numbered parts off the rack and "FRONT
    // KIT" alone is not an instruction.
    const parts = BRAKE_AXLES.map(a => stopBrakeAxle(car, a.id, src))
      .filter(x => x.work !== 'none');
    return [
      { v: fuelTxt, n: fuelNote, chg: addL > 0 },
      { v: src.tyres ? (set ? `${esc(set.name)} · ${setTag(set)}` : 'NO SET FREE') : 'KEEP',
        n: src.tyres ? (set ? (set.used ? `${set.laps} laps on it` : 'unused') : 'every spare is used or scrapped') : '',
        chg: src.tyres, blocked: src.tyres && !set },
      // The tag, not the full name — a name like "Hoogenboom" wraps the
      // column; the full name rides in the small print underneath.
      { v: drv ? `→ ${esc(driverAbbrev(drv))}` : 'STAYS IN', n: drv ? esc(drv.name) : '', chg: !!drv },
      { v: parts.length
          ? parts.map(x => x.work === 'kit'
            ? `${x.label} KIT ${x.name ? esc(x.name) : '—'}`
            : `${x.label} PADS ${x.pad ? esc(x.pad.name) : '—'}`).join(' · ')
          : '—',
        n: parts.some(x => x.blocked) ? 'nothing free in the rack'
          : parts.map(x => x.work === 'kit'
            ? `${esc(x.disc.name)} + ${esc(x.pad.name)}${x.formed ? ' · new kit' : ''}`
            : `${esc(x.pad.name)} onto ${esc(x.disc?.name || 'the discs on the car')}`).join(' · '),
        chg: parts.length > 0, blocked: parts.some(x => x.blocked) }
    ];
  };

  const cats = [['fuel', 'FUEL'], ['tyre', 'TYRES'], ['driver', 'DRIVER'], ['brake', 'BRAKES']];

  // A neutralisation column is what the crew would grab if the flag were out
  // now; under an actual neutralisation only the flag that is flying counts.
  const neutralCol = (key, when) => {
    const r = resolveStop(car, plans[key]);
    return {
      tone: key, ico: key === 'sc' ? 'safetycar' : 'flag', lab: PLAN_LABEL[key], when,
      rows: rowsOf(r),
      foot: `${Math.round(stopServiceTime(car, r).totalSec)} s stationary`
    };
  };
  // Which situations get a column: the flag that is out, else the ones this
  // car keeps on the wall. Never what a plan currently says — two that agree
  // still stand side by side, the repeated cells simply going dim.
  const neutrals = plans.live === 'fcy' || plans.live === 'sc'
    ? [neutralCol(plans.live, 'flying now')]
    : ['fcy', 'sc'].filter(k => wallShowsPlan(car, k)).map(k => neutralCol(k, 'if it drops'));

  // The anchor column is the work order itself: the stop the crew has already
  // been given, else the planned green one. The IF columns stand beside either.
  let cols;
  if (live) {
    cols = [{
      tone: 'now', ico: 'boxin', lab: 'THIS STOP',
      when: stop.status === 'box' || car.state.inPit ? 'now' : 'sent to the crew',
      rows: rowsOf(stop),
      foot: `${Math.round(stopServiceTime(car, stop).totalSec)} s stationary`
    }, ...neutrals];
  } else {
    const greenR = resolveStop(car, plans.green);
    cols = [...neutrals, {
      tone: 'green', ico: 'flag', lab: 'GREEN',
      when: `planned · ${plans.green.dueMs != null ? fmtMinSec(Math.max(0, plans.green.dueMs)) : '—'}`,
      rows: rowsOf(greenR),
      foot: `${Math.round(stopServiceTime(car, greenR).totalSec + (car.config.pitLossSec || 0))} s total`
    }];
  }

  wrap.innerHTML = `<table class="grabtable">
    <thead><tr><th></th>${cols.map(col => `<th class="sc-${col.tone}">
      <span class="sit">${icon(col.ico)}<b>${col.lab}</b></span>
      <span class="when">${col.when}</span></th>`).join('')}</tr></thead>
    <tbody>${cats.map(([ic, label], i) => `
      <tr>
        <td class="cat">${icon(ic)}<span>${label}</span></td>
        ${cols.map((col, ci) => {
          const cell = col.rows[i];
          // Only repeating the column beside it: written out in full all the
          // same — a column has to be readable on its own — but dimmed and
          // unhighlighted so colour stays reserved for the differences.
          const echo = ci > 0 && cell.v === cols[0].rows[i].v;
          return `<td class="${echo ? 'echo' : cell.blocked ? 'blocked' : cell.chg ? 'chg' : 'keep'}">
            <span class="v">${cell.v}</span>${!echo && cell.n ? `<span class="n">${cell.n}</span>` : ''}</td>`;
        }).join('')}
      </tr>`).join('')}
    </tbody>
    <tfoot><tr><td></td>${cols.map(col => `<td>${col.foot}</td>`).join('')}</tr></tfoot>
  </table>`;
}

// Has an engineer read this plan? Each of the three situations is approved on
// its own, so the line speaks for the one the stop would actually follow — the
// flag that is flying, or the plan the engineer is holding the card on. Until
// somebody has looked, the card says so: the crew can still lay out what the
// columns agree on, they just know nobody has signed it. Read-only here — the
// tick is set on the car station.
function renderApproval(card, car, plans) {
  const el = card.querySelector('[data-f="approve"]');
  const key = activePlanKey(car, plans);
  const ap = car.nextStop.approvals?.[key];
  const live = car.nextStop.status !== 'draft';
  if (live) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.className = 'wapprove' + (ap ? (ap.stale ? ' stale' : ' done') : '');
  el.innerHTML = ap && !ap.stale
    ? `${icon('check')} ${PLAN_LABEL[key]} PLAN APPROVED ${new Date(ap.atMs).toLocaleTimeString()} · ${esc(ap.by)}`
    : ap && ap.stale
      ? `${icon('warn')} ${PLAN_LABEL[key]} PLAN CHANGED SINCE APPROVAL — waiting on the engineer`
      : `${icon('timer')} APP'S OWN ${PLAN_LABEL[key]} PLAN — not approved yet`;
}

function render() {
  if (!state) return;
  const now = Date.now();
  const clock = raceClock(state.race, now);
  // One countdown: to a scheduled start, then time to go — straight from
  // the timing feed's session clock whenever the feed is live.
  // …but not while the feed is sitting on a session this race is not part of:
  // that countdown belongs to somebody else's session until the wall says so.
  const feedRemainUs = timing?.conn === 'connected' && !state.timing?.sessionAlert
    ? timing.session?.remainUs : null;
  $('clock-label').textContent = clock.scheduled ? 'STARTS IN' : 'TO GO';
  $('clock-remaining').textContent = clock.scheduled
    ? fmtClock(clock.msToStart)
    : fmtClock(feedRemainUs != null ? feedRemainUs / 1000 : clock.remainingMs);
  $('btn-start').style.display = clock.running ? 'none' : '';

  // The whole top bar still carries the race condition tint (green leaves it
  // untouched); the words moved to their own strip so the bar never reflows.
  const cond = renderConditionBar($('topbar'), $('cond-block'), state, now);
  const strip = $('cond-strip');
  strip.classList.toggle('hidden', cond.id === 'green');
  for (const c of ['fcy', 'code60', 'sc', 'red', 'finish']) {
    strip.classList.toggle('cond-' + c, cond.id === c);
  }

  // Clock sub-line. Under a red flag with the feed connected the TO GO above
  // follows the feed's held session clock, so say that instead of an elapsed
  // figure that suggests time is still passing.
  const sub = $('clock-sub');
  if (clock.running && cond.id === 'red' && timing?.conn === 'connected') {
    sub.textContent = 'OFFICIAL CLOCK HELD';
    sub.className = 'clocksub num warn';
  } else {
    sub.className = 'clocksub num';
    sub.textContent = clock.running ? 'ELAPSED ' + fmtClock(clock.elapsedMs)
      : clock.scheduled ? 'STARTS ' + new Date(state.race.startMs).toLocaleTimeString([], { hour12: false })
      : 'WAITING FOR START';
  }

  $('bar-title').textContent =
    state.race.name && state.race.name !== '24H Race'
      ? state.race.name.toUpperCase()
      : '24H';
  renderSessionAlert();
  renderHealth();
  renderSettings();

  // Every car's run to the pit, and who gets the box first.
  const arrivals = pitArrivals(now);
  const doubled = new Set(doubledCars());

  // Rebuild when cars appear/disappear or a number edit changes the order.
  const order = sortedCarIds();
  if (order.length !== wall.children.length ||
      order.some((id, i) => wall.children[i].id !== 'card-' + id)) buildCards();

  for (const [id, car] of Object.entries(state.cars)) {
    const card = document.getElementById('card-' + id);
    const stop = car.nextStop;
    const c = carCalcs(car, state.race, now);
    const f = name => card.querySelector(`[data-f="${name}"]`);
    const active = stop.status !== 'draft';

    // Live-connection verdict: no station attached and no live data this race
    // means the entry simply isn't used — say so instead of showing numbers.
    // Once data has flowed, a drop only flags the link and the last-known
    // figures stay on the wall (most likely the laptop lost its connection).
    const online = !!stations[id];
    const noCar = !online && !car.state.liveSeenMs;

    // The feed is live and lists the field, but nothing in it answers to
    // this car's timing number. Early in a session that is normal — boards
    // rebuild on session changes and a row can wait for the car's first
    // crossing — so a number never seen this session reads as a calm
    // "waiting"; one the board knew and dropped gets the loud
    // check-the-number warning. With the station also away there is no
    // data source at all, so an explanatory line replaces the (stale)
    // figures; while a station is online its data is real and the card
    // only carries the note.
    const feedLive = timing?.conn === 'connected' || timing?.conn === 'replay';
    const notInFeed = feedLive && timing.entries?.length > 0 && !timingEntryFor(car);
    const ltNr = notInFeed ? timingNrOf(state.timing || {}, car) : null;
    const feedWaiting = notInFeed && !feedSeen.has(ltNr);
    const parked = noCar || (notInFeed && !online);

    const inPit = car.state.inPit;
    card.className = 'wallcard' +
      (parked ? ' nocar' :
        inPit ? ' inpit' : stop.status === 'box' ? ' box' : stop.status === 'sent' ? ' sent' : '');

    // A stop the app logged with nothing planned against it, or one the board
    // is carrying that the sheet never saw, is a question sitting unanswered
    // on a station — and a station nobody is looking at is exactly how it goes
    // unanswered for the rest of the race. The wall says so for every car at
    // once. It does not offer the answer: race-time decisions are the crew's,
    // taken at the car's own station. Set before the early exits below, so a
    // car with no station and no feed row still carries its note.
    const pitNoteEl = f('pitnote');
    const miss = car.state.pitCatchUp;
    const lpv = car.state.lastPitVisit;
    const openStop = lpv?.applied && lpv.unplanned && !lpv.disputed;
    if (miss) {
      pitNoteEl.style.display = '';
      pitNoteEl.className = 'stationline lost';
      pitNoteEl.innerHTML = `${icon('warn')} ${miss.stops} STOP${miss.stops === 1 ? '' : 'S'} MISSING FROM THE SHEET — ` +
        'taken while the feed was down · answer at the station';
    } else if (openStop) {
      pitNoteEl.style.display = '';
      pitNoteEl.className = 'stationline lost';
      pitNoteEl.innerHTML = `${icon('warn')} STOP LOGGED, NOTHING WAS PLANNED — ` +
        'no fuel, tyres or driver change applied · answer at the station';
    } else {
      pitNoteEl.style.display = 'none';
    }

    // head
    f('number').textContent = car.number;
    const makeModel = [car.make, car.model].filter(Boolean).join(' ');
    const customName = car.name !== `Car #${car.number}` ? car.name : '';
    f('name').textContent = customName || makeModel || `Car #${car.number}`;
    f('makemodel').textContent = customName && makeModel ? makeModel : '';
    const drv = car.drivers.find(d => d.id === car.currentDriverId);
    // The tag, not the full name — the head has no width for "Hoogenboom".
    const drvEl = f('driver');
    drvEl.textContent = parked ? '—' : drv ? driverAbbrev(drv) : '—';
    drvEl.title = !parked && drv ? drv.name : '';

    // Pit order, read straight off the arrival estimates: with more than one
    // car on its way in, the crew's next question is which one they take
    // first, and it is answered where the eye already is — beside the number.
    const q = parked ? null : arrivals.rank.get(id);
    const orderEl = f('pitorder');
    orderEl.style.display = q ? '' : 'none';
    if (q) {
      orderEl.className = 'pitorder' + (q.pos === 1 ? ' first' : '') + (q.stale ? ' est' : '');
      setLine(orderEl,
        `${icon('boxin')}<span class="pos"><b>${q.stale ? '~' : ''}${ordinal(q.pos)}</b>` +
        `<span class="of">${q.inPit ? 'IN THE LANE' : 'OF ' + q.of + ' TO BOX'}</span></span>`);
    }

    const stationEl = f('station');
    if (noCar) {
      stationEl.style.display = '';
      stationEl.className = 'stationline';
      stationEl.innerHTML = `${icon('monitor')} no station connected for this car`;
      f('v-sub').style.display = 'none';
      f('verdict').className = 'verdict calm';
      setLine(f('v-main'), '— NO CAR RUNNING —');
      f('lt').style.display = 'none';
      f('tiles').style.display = 'none';
      f('extra').style.display = 'none';
      continue;
    }
    if (notInFeed && !online) {
      stationEl.style.display = '';
      if (feedWaiting) {
        stationEl.className = 'stationline';
        stationEl.innerHTML = `${icon('timer')} no car #${esc(ltNr)} in the feed yet — check the timing number if this stays`;
        setLine(f('v-main'), '— WAITING ON LIVE TIMING —');
      } else {
        stationEl.className = 'stationline lost';
        stationEl.innerHTML = `${icon('warn')} check the car's timing number — Settings → LIVE TIMING`;
        setLine(f('v-main'), `— NO CAR #${esc(ltNr)} IN LIVE TIMING —`);
      }
      f('v-sub').style.display = 'none';
      f('verdict').className = 'verdict calm';
      f('lt').style.display = 'none';
      f('tiles').style.display = 'none';
      f('extra').style.display = 'none';
      continue;
    }
    f('tiles').style.display = '';
    if (online && notInFeed) {
      stationEl.style.display = '';
      stationEl.className = 'stationline' + (feedWaiting ? '' : ' lost');
      stationEl.innerHTML = feedWaiting
        ? `${icon('timer')} waiting on live timing — no car #${esc(ltNr)} in the feed yet`
        : `${icon('warn')} NO CAR #${esc(ltNr)} IN LIVE TIMING — check the timing number`;
    } else if (doubled.has(id)) {
      // Both laptops look fine to the people sitting at them; only the wall
      // can see there are two, and every LAP or APPLY STOP they press is
      // counted twice on this car.
      stationEl.style.display = '';
      stationEl.className = 'stationline lost';
      stationEl.innerHTML = `${icon('warn')} ${stations[id]} STATIONS ON THIS CAR — ` +
        'every button press lands ' + stations[id] + ' times';
    } else if (online) {
      stationEl.style.display = 'none';
    } else {
      stationEl.style.display = '';
      stationEl.className = 'stationline lost';
      stationEl.innerHTML = `${icon('warn')} STATION OFFLINE — showing last data`;
    }

    const fs = fuelStrategy(car, state.race, now, c);
    const neutralised = c.condition.pace === 'sc' || c.condition.pace === 'fcy';

    // Verdict band: one answer per car. The stop status when one is live,
    // else the pit-window verdict (a flag flying turns the wall into an
    // answer sheet — per car: box or stay out), else the next-stop countdown.
    // Same colour language as the grab list below it: RED says the car
    // comes in, GREEN says it stays out. Amber is never an answer, only a
    // warning attached to one (stop sent, fuel running low).
    let vCls = 'calm';
    let vHtml;
    if (inPit) {
      vCls = 'inpit';
      vHtml = `${icon('parking')} IN PIT LANE ${car.state.pitEnterMs ? fmtMinSec(now - car.state.pitEnterMs) : ''} — SERVICE NOW`;
    } else if (stop.status === 'box') {
      vCls = 'box';
      vHtml = `${icon('boxin')} BOX BOX — CAR COMING IN`;
    } else if (stop.status === 'sent') {
      vCls = 'sent';
      vHtml = `${icon('alert')} NEXT STOP — PREPARE`;
    } else if (fs && fs.noStopNeeded) {
      vCls = 'stay';
      vHtml = `${icon('check')} NO FUEL STOP NEEDED — reaches the flag`;
    } else if (fs && neutralised) {
      // A car whose crew has written its own points is answered off them and
      // not off the pit-time maths — the same call the station is showing, or
      // the wall and the station disagree about the car with the flag out.
      const rule = flagRuleCall(car, c);
      if (rule && !rule.empty) {
        vCls = rule.box ? 'go' : 'stay';
        vHtml = rule.box
          ? `${icon('boxin')} BOX NOW${rule.tyres ? ' · FUEL + TYRES' : ''} <small>your own points</small>`
          : `${icon('stop')} STAY OUT <small>your points` +
            (rule.msToPoint != null ? ` — first one in ${fmtMinSec(rule.msToPoint)}` : '') + '</small>';
      } else if (fs.netPitNowSec <= 0) {
        vCls = 'go';
        vHtml = `${icon('boxin')} BOX NOW — ${fs.netPitNowSec <= -1
          ? 'saves ' + Math.abs(fs.netPitNowSec).toFixed(0) + ' s'
          : 'free stop'}`;
      } else {
        vCls = 'stay';
        vHtml = `${icon('stop')} STAY OUT — box now +${fs.netPitNowSec.toFixed(0)} s` +
          (fs.windowOpen ? '' : ` <small>window in ${fs.lapsToWindow} laps</small>`);
      }
    } else if (fs && fs.windowOpen) {
      vCls = 'chg';
      vHtml = `${icon('fuel')} FUEL WINDOW OPEN — box within ${fs.windowLapsLeft} laps`;
    } else if (clock.running) {
      vHtml = `NEXT STOP IN <b>~${fmtMinSec(c.limit.ms)}</b> <small>${c.limit.label} limited</small>`;
    } else if (clock.scheduled) {
      vHtml = `T–${fmtClock(clock.msToStart)} <small>race start</small>`;
    } else {
      vHtml = '— RACE NOT STARTED —';
    }
    if (fs && fs.warn.level !== 'ok' && !fs.noStopNeeded && !inPit) {
      vHtml = `<b class="lowfuel">LOW FUEL — ${Math.floor(fs.warn.litersLeft)} L</b> · ` + vHtml;
      vCls += ' ' + fs.warn.level;
    }
    f('verdict').className = 'verdict ' + vCls;
    setLine(f('v-main'), vHtml);

    // Sub-line: the pit-arrival estimate while it matters, else the fuel
    // window countdown — the band always says when something is next due.
    const sub = f('v-sub');
    const etaLine = pitEtaLine(car, arrivals.eta.get(id));
    if (etaLine) {
      sub.style.display = '';
      sub.className = 'vsub' + (etaLine.cls ? ' ' + etaLine.cls : '');
      setLine(sub, etaLine.html);
    } else if (!inPit && stop.status === 'draft' && clock.running &&
               fs && !fs.noStopNeeded && !fs.windowOpen && !neutralised) {
      sub.style.display = '';
      sub.className = 'vsub';
      setLine(sub, `${icon('fuel')} fuel window in ${fs.lapsToWindow} laps <small>~${fmtMinSec(fs.msToWindow)}</small>`);
    } else {
      sub.style.display = 'none';
    }

    // The grab list — what to have ready if a yellow drops now, against the
    // planned green stop — plus whether an engineer has approved it.
    const plans = recommendedStops(car, state.race, now, c);
    renderGrab(card, car, c, plans, now);
    renderApproval(card, car, plans);

    // Under the tiles: crew notes as soon as they're written, plus the
    // stationary estimate once the stop is live.
    const extra = f('extra');
    const bits = [];
    if (active) {
      const st = stopServiceTime(car, stop);
      if (st.totalSec > 0) bits.push(`${icon('timer')} EST. STATIONARY ~${Math.round(st.totalSec)} s`);
    }
    if (stop.notes) bits.push(icon('note') + ' ' + esc(stop.notes));
    extra.innerHTML = bits.join(' &nbsp;·&nbsp; ');
    extra.style.display = bits.length ? '' : 'none';

    f('inpit').style.display = active && !inPit ? '' : 'none';
    f('done').style.visibility = active ? 'visible' : 'hidden';
  }

  renderTimingCards();
  // What the cards ended up carrying decides how tight the board has to be
  // drawn — a stop going live adds a note and two buttons to one card.
  gradeBoard();
}

setInterval(render, 1000);
