// Car strategy station (PCs 1-4). Connects to the pit wall server, shows the
// live strategy picture for one car and lets the engineer plan the next stop.

import {
  PORT, CONDITIONS, BRAKE_COMPONENTS, DRIVER_COLORS,
  carCalcs, raceClock, projectStints, emptyStop,
  stopServiceTime, fcyCalc,
  fmtClock, fmtMinSec, fmtLap, fmtH
} from '../../shared/model.js';
import { connect } from './net.js';

const carId = localStorage.getItem('carId') || '1';
const serverIp = localStorage.getItem('serverIp') || '127.0.0.1';
const serverPort = localStorage.getItem('serverPort') || PORT; // override used by tests

const $ = id => document.getElementById(id);
let state = null;

const net = connect({
  url: `ws://${serverIp}:${serverPort}`,
  onState: s => { state = s; render(); },
  onStatus: ok => {
    const el = $('conn');
    el.textContent = ok ? `connected ${serverIp}` : `reconnecting ${serverIp}…`;
    el.className = 'conn ' + (ok ? 'ok' : 'bad');
  }
});

const send = msg => net.send({ carId, ...msg });
const patchCar = patch => send({ type: 'update', patch });
const patchStop = patch => patchCar({ nextStop: patch });

$('btn-back').addEventListener('click', () => (location.href = 'index.html'));

// ---- lap logging ----

$('btn-lap').addEventListener('click', () => {
  const t = parseFloat($('lap-time').value);
  send({ type: 'lap', lapSec: isNaN(t) ? null : t });
  $('lap-time').value = '';
});
$('btn-undo').addEventListener('click', () => send({ type: 'undoLap' }));

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

$('btn-fcy').addEventListener('click', () => {
  if (!state) return;
  net.send({ type: 'fcy', active: !state.race.fcy?.active });
});

// ---- stop planner ----

$('stop-fuel').addEventListener('change', () =>
  patchStop({ fuelLiters: Math.max(0, parseFloat($('stop-fuel').value) || 0) })
);
$('btn-fuel-fill').addEventListener('click', () => {
  if (!state) return;
  const car = state.cars[carId];
  patchStop({ fuelLiters: Math.round(car.config.tankLiters) });
});
$('btn-fuel-end').addEventListener('click', () => {
  if (!state) return;
  const car = state.cars[carId];
  const c = carCalcs(car, state.race, Date.now());
  patchStop({ fuelLiters: Math.ceil(Math.min(c.suggestedFuel, car.config.tankLiters)) });
});

for (const key of ['tyres', 'padsFront', 'padsRear', 'discsFront', 'discsRear']) {
  $('stop-' + key).addEventListener('click', () => {
    if (!state) return;
    patchStop({ [key]: !state.cars[carId].nextStop[key] });
  });
}
$('stop-driver').addEventListener('change', () =>
  patchStop({ driverChange: $('stop-driver').value || null })
);
$('stop-notes').addEventListener('change', () => patchStop({ notes: $('stop-notes').value }));

$('btn-send').addEventListener('click', () => patchStop({ status: 'sent' }));
$('btn-box').addEventListener('click', () => patchStop({ status: 'box' }));
$('btn-clear').addEventListener('click', () => patchCar({ nextStop: emptyStop() }));

// ---- settings modal ----

const overlay = $('settings-overlay');
$('btn-settings').addEventListener('click', () => overlay.classList.remove('hidden'));
$('btn-settings-close').addEventListener('click', () => overlay.classList.add('hidden'));
overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });

// Every input with data-path patches that field on the car when changed.
for (const inp of overlay.querySelectorAll('input[data-path]')) {
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

let driverTableBuilt = false;
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
    body.appendChild(tr);
  });
  driverTableBuilt = true;
}

function renderSettings(car) {
  for (const inp of overlay.querySelectorAll('input[data-path]')) {
    setInput(inp, getPath(car, inp.dataset.path) ?? '');
  }
  if (!driverTableBuilt) buildDriverTable(car);
  car.drivers.forEach((d, i) => {
    const nameInp = overlay.querySelector(`input[data-drv-name="${i}"]`);
    if (nameInp) setInput(nameInp, d.name);
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

  // FCY calculator readout
  const fc = fcyCalc(car);
  $('fcy-out').innerHTML = fc
    ? `
      <div class="kv"><span class="k">Green avg lap (${fc.cond}, ${fc.greenSpeedKmh.toFixed(0)} km/h)</span><span class="v">${fc.greenLapSec.toFixed(0)} s</span></div>
      <div class="kv"><span class="k">FCY lap at ${car.config.fcySpeedKmh} km/h</span><span class="v">${fc.fcyLapSec.toFixed(0)} s</span></div>
      <div class="kv"><span class="k">Time gained per FCY lap</span><span class="v good">+${fc.gainSec.toFixed(0)} s</span></div>
      <div class="kv"><span class="k">Net pit-lane loss if pitting under FCY</span><span class="v ${fc.netPitLossSec <= 0 ? 'good' : 'warn'}">${fc.netPitLossSec <= 0 ? 'FREE STOP (' + fc.netPitLossSec.toFixed(0) + ' s)' : fc.netPitLossSec.toFixed(0) + ' s'}</span></div>`
    : '<p class="hint">Set track length and FCY speed to calculate.</p>';
}

// ---- rendering ----

function setInput(el, value) {
  if (document.activeElement !== el) el.value = value;
}

function render() {
  if (!state) return;
  const car = state.cars[carId];
  if (!car) return;
  const now = Date.now();
  const c = carCalcs(car, state.race, now);

  document.title = `PitWall 24H — ${car.name}`;
  const defaultName = `Car #${car.number}`;
  const carMakeModel = [car.make, car.model].filter(Boolean).join(' ');
  const titleName = car.name === defaultName ? 'CAR' : car.name.toUpperCase();
  $('car-title').innerHTML = `${titleName} <span>#${car.number}</span>` +
    (carMakeModel ? ` <small style="color:var(--dim);font-size:13px;font-weight:400">${carMakeModel}</small>` : '');
  $('clock-elapsed').textContent = c.clock.scheduled
    ? 'T–' + fmtClock(c.clock.msToStart)
    : fmtClock(c.clock.elapsedMs);
  $('clock-remaining').textContent = fmtClock(c.clock.remainingMs);

  // laps
  $('laps-stint').textContent = car.state.lapsThisStint;
  $('laps-total').textContent = car.state.totalLaps;
  $('last-lap').textContent = fmtLap(car.state.lastLapSec);

  // condition
  for (const b of condRow.children) {
    b.className = b.dataset.cond === car.condition ? 'on ' + b.dataset.cond : '';
  }

  // FCY procedure
  const fcy = state.race.fcy || {};
  const fcyBtn = $('btn-fcy');
  fcyBtn.textContent = fcy.active ? '🟢 END FCY — BACK TO GREEN' : '🟡 START FCY (RACE-WIDE)';
  fcyBtn.className = 'fcybtn' + (fcy.active ? ' on' : '');
  const fcyBanner = $('fcy-banner');
  fcyBanner.classList.toggle('hidden', !fcy.active);
  if (fcy.active) {
    const dur = fcy.startMs ? fmtMinSec(now - fcy.startMs) : '';
    fcyBanner.textContent = `🟡 FCY ACTIVE ${dur} — burn ${c.burn.toFixed(2)} L/lap · lap ${(c.lapMs / 1000).toFixed(0)} s`;
  }

  // fuel
  const fuelPct = car.state.fuelLiters / car.config.tankLiters;
  $('fuel-now').textContent = car.state.fuelLiters.toFixed(1) + ' L';
  $('fuel-now').className = 'v big' +
    (car.state.fuelLiters <= c.safety || c.lapsToEmpty <= 3 ? ' crit' : c.lapsToEmpty <= 8 ? ' warn' : '');
  setMeter($('fuel-meter'), 1 - fuelPct);
  $('fuel-usable').textContent = c.usableFuel.toFixed(1) + ' L';
  $('fuel-usable').className = 'v' + (c.usableFuel <= 0 ? ' crit' : '');
  const burnPerMin = (c.burn * 60000) / c.lapMs;
  $('fuel-burn').textContent = `${c.burn.toFixed(2)} L · ${burnPerMin.toFixed(2)} L`;
  $('fuel-laps').textContent = c.lapsToEmpty;
  $('fuel-time').textContent = fmtMinSec(c.msToEmpty);
  $('fuel-to-end').textContent = c.clock.running ? Math.ceil(c.fuelToEnd) + ' L' : '—';

  // tyres
  $('tyre-laps').textContent = car.state.tyreLapsOnSet;
  setMeter($('tyre-meter'), car.state.tyreLapsOnSet / car.config.tyreLifeLaps);
  $('tyre-left').textContent = c.tyreLapsLeft;
  $('tyre-sets').textContent = `${car.state.tyreSetsUsed} / ${car.config.tyreSets}`;

  // limit banner
  $('limit-key').textContent = c.limit.label;
  $('limit-time').textContent = c.clock.running ? fmtMinSec(c.limit.ms)
    : c.clock.scheduled ? 'starts soon' : 'not started';
  const banner = $('limit-banner');
  banner.className = 'limitbanner' + (c.limit.ms < 5 * 60e3 ? ' crit' : c.limit.ms < 15 * 60e3 ? ' warn' : '');
  const stintMs = Math.max(c.fullStintLaps * c.lapMs, 1);
  $('stops-left').textContent = c.clock.running
    ? Math.max(0, Math.ceil((c.clock.remainingMs - c.limit.ms) / stintMs))
    : '—';

  // brakes
  renderBrakes(c);

  // drivers
  renderDrivers(car, c);
  $('stint-time').textContent = fmtMinSec(c.stintElapsedMs);
  $('stint-time').className = 'v big' + (c.msDriverLeft < 5 * 60e3 ? ' crit' : c.msDriverLeft < 10 * 60e3 ? ' warn' : '');
  $('stint-max').textContent = car.config.maxStintMin + ' min';

  // planner
  const stop = car.nextStop;
  setInput($('stop-fuel'), stop.fuelLiters || 0);
  for (const key of ['tyres', 'padsFront', 'padsRear', 'discsFront', 'discsRear']) {
    const b = $('stop-' + key);
    b.textContent = stop[key] ? 'CHANGE' : 'NO';
    b.className = 'toggle' + (stop[key] ? ' on' : '');
  }
  const drvSel = $('stop-driver');
  if (drvSel.options.length !== car.drivers.length + 1) {
    drvSel.innerHTML = '<option value="">no change</option>' +
      car.drivers.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  } else {
    car.drivers.forEach((d, i) => { drvSel.options[i + 1].textContent = d.name; });
  }
  if (document.activeElement !== drvSel) drvSel.value = stop.driverChange || '';
  setInput($('stop-notes'), stop.notes || '');

  // estimated stop duration
  const st = stopServiceTime(car, stop);
  const anyService = (Number(stop.fuelLiters) || 0) > 0 || stop.tyres;
  $('stop-est').textContent = anyService
    ? `${Math.round(st.totalSec)} s · ${Math.round(st.totalSec + (car.config.pitLossSec || 0))} s`
    : '—';

  const statusEl = $('stop-status');
  statusEl.textContent =
    stop.status === 'sent' ? '— SENT TO PIT WALL —' :
    stop.status === 'box' ? '— BOX BOX — CAR COMING IN —' : '— DRAFT —';
  statusEl.className = 'status-line ' + stop.status;

  renderSettings(car);
  renderTimeline(car, now);
}

function setMeter(el, pct) {
  pct = Math.max(0, Math.min(1, pct));
  el.querySelector('i').style.width = (pct * 100).toFixed(1) + '%';
  el.className = 'meter' + (pct > 0.9 ? ' crit' : pct > 0.75 ? ' warn' : '');
}

function renderBrakes(c) {
  const wrap = $('brakes');
  if (wrap.children.length === 0) {
    for (const b of BRAKE_COMPONENTS) {
      const div = document.createElement('div');
      div.innerHTML = `
        <div class="kv"><span class="k">${b.label}</span><span class="v" data-val="${b.id}">—</span></div>
        <div class="meter" data-meter="${b.id}"><i></i></div>`;
      wrap.appendChild(div);
    }
  }
  for (const b of BRAKE_COMPONENTS) {
    const info = c.brakes[b.id];
    const val = wrap.querySelector(`[data-val="${b.id}"]`);
    val.textContent = `${fmtH(info.usedH)} / ${fmtH(info.lifeH)}  (${fmtH(info.leftH)} left)`;
    val.className = 'v' + (info.pct > 0.9 ? ' crit' : info.pct > 0.75 ? ' warn' : '');
    setMeter(wrap.querySelector(`[data-meter="${b.id}"]`), info.pct);
  }
}

function renderDrivers(car, c) {
  const wrap = $('drivers');
  wrap.innerHTML = '';
  car.drivers.forEach((d, i) => {
    const cur = d.id === car.currentDriverId;
    const total = d.totalMs + (cur ? c.stintElapsedMs : 0);
    const row = document.createElement('div');
    row.className = 'drv-row' + (cur ? ' cur' : '');
    row.innerHTML = `
      <span class="dot" style="background:${DRIVER_COLORS[i % DRIVER_COLORS.length]}"></span>
      <span class="nm">${cur ? '▶ ' : ''}${d.name}</span>
      <span class="badge${d.doubleStint ? '' : ' off'}" title="double stints ${d.doubleStint ? 'yes' : 'no'}">⏩</span>
      <span class="badge${d.night ? '' : ' off'}" title="night driving ${d.night ? 'yes' : 'no'}">🌙</span>
      <span class="badge${d.rain ? '' : ' off'}" title="rain ${d.rain ? 'yes' : 'no'}">🌧️</span>
      <span class="tm num">${fmtClock(total)}</span>`;
    wrap.appendChild(row);
  });
}

function renderTimeline(car, now) {
  const svg = $('timeline');
  const race = state.race;
  const clock = raceClock(race, now);
  const W = 1000, H = 110, barY = 30, barH = 40;
  const x = ms => (ms / clock.totalMs) * W;
  let parts = [];

  // hour grid
  for (let h = 0; h <= race.durationH; h += 2) {
    const px = x(h * 3600e3);
    parts.push(`<line x1="${px}" y1="${barY - 8}" x2="${px}" y2="${barY + barH + 8}" stroke="#263145" stroke-width="1"/>`);
    parts.push(`<text x="${px + 3}" y="${barY - 12}" fill="#7d8ca1" font-size="11">${h}h</text>`);
  }
  parts.push(`<rect x="0" y="${barY}" width="${W}" height="${barH}" fill="#0e1520" rx="4"/>`);

  const driverIdx = {};
  car.drivers.forEach((d, i) => (driverIdx[d.id] = i));

  if (clock.running) {
    for (const b of projectStints(car, race, now)) {
      const from = Math.max(0, b.from);
      const to = Math.min(clock.totalMs, b.to);
      if (to <= from) continue;
      let fill = '#31405a', opacity = 1;
      if (b.kind === 'past' || b.kind === 'current') {
        fill = DRIVER_COLORS[(driverIdx[b.driverId] ?? 0) % DRIVER_COLORS.length];
      } else if (b.kind === 'projected') {
        fill = DRIVER_COLORS[(driverIdx[b.driverId] ?? 0) % DRIVER_COLORS.length];
        opacity = 0.35;
      } else {
        opacity = 0.55;
      }
      parts.push(`<rect x="${x(from)}" y="${barY + 2}" width="${Math.max(1, x(to) - x(from) - 1)}" height="${barH - 4}" fill="${fill}" opacity="${opacity}" rx="2"/>`);
      if (b.kind === 'future' || b.kind === 'projected') {
        parts.push(`<line x1="${x(to)}" y1="${barY - 4}" x2="${x(to)}" y2="${barY + barH + 4}" stroke="#ff5d5d" stroke-width="2"/>`);
      }
    }
    // now marker
    const nowX = x(clock.elapsedMs);
    parts.push(`<line x1="${nowX}" y1="${barY - 10}" x2="${nowX}" y2="${barY + barH + 10}" stroke="#dbe4f0" stroke-width="2"/>`);
    parts.push(`<text x="${Math.min(nowX + 4, W - 40)}" y="${barY + barH + 24}" fill="#dbe4f0" font-size="12">NOW</text>`);
    parts.push(`<text x="0" y="${H - 4}" fill="#7d8ca1" font-size="11">solid = driven · faded = projected · red ticks = pit stops</text>`);
  } else if (clock.scheduled) {
    parts.push(`<text x="${W / 2}" y="${barY + barH / 2 + 4}" fill="#ffb454" font-size="14" text-anchor="middle">Race starts in ${fmtClock(clock.msToStart)}</text>`);
  } else {
    parts.push(`<text x="${W / 2}" y="${barY + barH / 2 + 4}" fill="#7d8ca1" font-size="14" text-anchor="middle">Race not started — waiting for pit wall</text>`);
  }
  svg.innerHTML = parts.join('');
}

// re-render every second so clocks/accruals tick between broadcasts
setInterval(render, 1000);
