// Pit wall display (5th PC). Starts the embedded server, then shows one big
// card per car. Idle cards show a compact running summary; when a stop is
// planned the card becomes a service board the crew reads from meters away.
// The only action here is confirming a completed stop.

import {
  PORT, carCalcs, raceClock, stopServiceTime, fmtClock, fmtMinSec
} from '../../shared/model.js';
import { connect } from './net.js';

const $ = id => document.getElementById(id);
let state = null;
let net = null;

async function boot() {
  let port = PORT;
  try {
    const info = await window.pitwallApi.startServer();
    port = info.port;
    $('server-ips').textContent = info.ips.length
      ? 'Stations connect to: ' + info.ips.join('  or  ') + `  (port ${info.port})`
      : `port ${info.port}`;
    $('server-ips').classList.add('ok');
  } catch (e) {
    $('server-ips').textContent = 'server failed: ' + e.message;
    $('server-ips').classList.add('bad');
  }

  net = connect({
    url: `ws://127.0.0.1:${port}`,
    onState: s => { state = s; render(); },
    onStatus: ok => {
      const el = $('conn');
      el.textContent = ok ? 'live' : 'reconnecting…';
      el.className = 'conn ' + (ok ? 'ok' : 'bad');
    }
  });
}
boot();

$('btn-back').addEventListener('click', () => (location.href = 'index.html'));
$('btn-start').addEventListener('click', () => {
  if (state && state.race.startMs && Date.now() >= state.race.startMs) return;
  if (confirm('Start the race clock now?')) net.send({ type: 'startRace' });
});
$('btn-fcy').addEventListener('click', () => {
  if (!state) return;
  net.send({ type: 'fcy', active: !state.race.fcy?.active });
});
$('btn-reset').addEventListener('click', () => {
  if (confirm('Reset the whole race? Stint history and clocks are cleared (car setups are kept).')) {
    if (confirm('Really sure? This cannot be undone.')) net.send({ type: 'resetRace' });
  }
});

// ---- race settings modal ----

const overlay = $('settings-overlay');
$('btn-settings').addEventListener('click', () => overlay.classList.remove('hidden'));
$('btn-settings-close').addEventListener('click', () => overlay.classList.add('hidden'));
overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });

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
  $('race-hint').textContent = state.race.startMs
    ? (Date.now() < state.race.startMs
        ? `Scheduled — race starts ${new Date(state.race.startMs).toLocaleString()}`
        : `Race started ${new Date(state.race.startMs).toLocaleString()}`)
    : 'No start time set.';
}

// ---- car cards ----

const wall = $('wall');

function buildCards() {
  wall.innerHTML = '';
  for (const id of Object.keys(state.cars)) {
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
        <div class="incar">
          <span class="lab">IN CAR</span>
          <b data-f="driver"></b>
        </div>
      </div>
      <div class="statusband" data-f="status"></div>
      <div class="service" data-f="service">
        <div class="srow fuel" data-r="fuel"><span class="lab">⛽ FUEL</span><span class="val" data-f="fuel"></span></div>
        <div class="srow" data-r="tyres"><span class="lab">🛞 TYRES</span><span class="val" data-f="tyres"></span></div>
        <div class="srow" data-r="driver"><span class="lab">🧑‍✈️ DRIVER</span><span class="val" data-f="driverChange"></span></div>
        <div class="srow brakes" data-r="brakes"><span class="lab">🛑 BRAKES</span>
          <span class="chips">
            <span class="chip" data-c="padsFront">PADS F</span>
            <span class="chip" data-c="discsFront">DISCS F</span>
            <span class="chip" data-c="padsRear">PADS R</span>
            <span class="chip" data-c="discsRear">DISCS R</span>
          </span>
        </div>
        <div class="esttime" data-f="est"></div>
        <div class="notes" data-f="notes"></div>
      </div>
      <div class="idle" data-f="idle">
        <div class="nextstop">
          <span class="lab">NEXT STOP</span>
          <span class="val" data-f="idle-next"></span>
          <span class="why" data-f="idle-why"></span>
        </div>
        <div class="stats" data-f="idle-stats"></div>
      </div>
      <div class="foot"><button class="done" data-f="done">✔ STOP DONE — CAR RELEASED</button></div>`;
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

function render() {
  if (!state) return;
  const now = Date.now();
  const clock = raceClock(state.race, now);
  $('clock-elapsed').textContent = clock.scheduled
    ? 'T–' + fmtClock(clock.msToStart)
    : fmtClock(clock.elapsedMs);
  $('clock-remaining').textContent = fmtClock(clock.remainingMs);
  $('btn-start').style.display = clock.running ? 'none' : '';

  const fcy = state.race.fcy || {};
  const fcyBtn = $('btn-fcy');
  fcyBtn.textContent = fcy.active
    ? `🟢 END FCY ${fcy.startMs ? fmtMinSec(now - fcy.startMs) : ''}`
    : '🟡 START FCY';
  fcyBtn.className = 'fcybtn' + (fcy.active ? ' on' : '');
  document.querySelector('.topbar .title').innerHTML =
    state.race.name && state.race.name !== '24H Race'
      ? `${state.race.name.toUpperCase().replace(/</g, '&lt;')}`
      : 'PIT<span>WALL</span>';
  renderSettings();

  if (wall.children.length !== Object.keys(state.cars).length) buildCards();

  for (const [id, car] of Object.entries(state.cars)) {
    const card = document.getElementById('card-' + id);
    const stop = car.nextStop;
    const c = carCalcs(car, state.race, now);
    const f = name => card.querySelector(`[data-f="${name}"]`);
    const active = stop.status !== 'draft';

    card.className = 'wallcard' +
      (stop.status === 'box' ? ' box' : stop.status === 'sent' ? ' sent' : '');

    // head
    f('number').textContent = car.number;
    const makeModel = [car.make, car.model].filter(Boolean).join(' ');
    const customName = car.name !== `Car #${car.number}` ? car.name : '';
    f('name').textContent = customName || makeModel || `Car #${car.number}`;
    f('makemodel').textContent = customName && makeModel ? makeModel : '';
    const drv = car.drivers.find(d => d.id === car.currentDriverId);
    f('driver').textContent = drv ? drv.name : '—';

    // status band
    f('status').textContent =
      stop.status === 'box' ? '🔴 BOX BOX — CAR COMING IN' :
      stop.status === 'sent' ? '🟠 NEXT STOP — PREPARE' :
      '— NO STOP SCHEDULED —';

    // service board vs idle summary
    f('service').style.display = active ? '' : 'none';
    f('idle').style.display = active ? 'none' : '';

    if (active) {
      const setRow = (row, on) =>
        card.querySelector(`[data-r="${row}"]`).classList.toggle('on', on);

      const fuel = Number(stop.fuelLiters) || 0;
      f('fuel').textContent = fuel > 0 ? fuel + ' L' : '—';
      setRow('fuel', fuel > 0);

      f('tyres').textContent = stop.tyres ? 'CHANGE' : '—';
      setRow('tyres', !!stop.tyres);

      const newDrv = car.drivers.find(d => d.id === stop.driverChange);
      f('driverChange').textContent = newDrv ? '→ ' + newDrv.name : 'NO CHANGE';
      setRow('driver', !!newDrv);

      let anyBrake = false;
      for (const key of ['padsFront', 'padsRear', 'discsFront', 'discsRear']) {
        const on = !!stop[key];
        anyBrake = anyBrake || on;
        card.querySelector(`[data-c="${key}"]`).classList.toggle('on', on);
      }
      setRow('brakes', anyBrake);

      const st = stopServiceTime(car, stop);
      f('est').textContent = st.totalSec > 0
        ? `⏱ EST. STATIONARY ~${Math.round(st.totalSec)} s`
        : '';

      f('notes').textContent = stop.notes ? '📝 ' + stop.notes : '';
    } else {
      if (clock.running) {
        f('idle-next').textContent = '~' + fmtMinSec(c.limit.ms);
        f('idle-why').textContent = c.limit.label + ' LIMITED';
        f('idle-stats').textContent =
          `fuel ${c.lapsToEmpty} laps · tyres ${c.tyreLapsLeft} laps · ` +
          `stint ${car.state.lapsThisStint} laps ${fmtMinSec(c.stintElapsedMs)}`;
      } else if (clock.scheduled) {
        f('idle-next').textContent = 'T–' + fmtClock(clock.msToStart);
        f('idle-why').textContent = 'RACE START';
        f('idle-stats').textContent = 'waiting for the start';
      } else {
        f('idle-next').textContent = '—';
        f('idle-why').textContent = '';
        f('idle-stats').textContent = 'race not started';
      }
    }

    f('done').style.visibility = active ? 'visible' : 'hidden';
  }
}

setInterval(render, 1000);
