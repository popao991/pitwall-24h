// Headless smoke test: boots the server, drives it over WebSocket like a
// station + pit wall would, and asserts the state transitions.
// Run with: npm test
import { startServer } from '../server/server.js';
import {
  carCalcs, projectStints, raceClock, effectiveBurn, stopServiceTime, fcyCalc
} from '../shared/model.js';
import WebSocket from 'ws';

// Ports 8485/8486 so tests never touch a live app on the default port 8484.
// Main server: no ticking, so fuel values stay deterministic.
const info = startServer({ dataFile: null, port: 8485, tickMs: 3600e3 });
console.log('server up on', info.port, 'ips:', info.ips);

const ws = new WebSocket('ws://127.0.0.1:' + info.port);
let state = null;
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'state') state = m.state;
});

const send = o => ws.send(JSON.stringify(o));
const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!cond) failures++;
}

await new Promise(r => ws.on('open', r));
await wait(200);
check('initial state received', state && Object.keys(state.cars).length === 4);

// scheduled start: future start time counts down, aligns first stints
const futureStart = Date.now() + 3600e3;
send({ type: 'race', patch: { startMs: futureStart } });
await wait(150);
check('start time scheduled', state.race.startMs === futureStart);
check('first stints aligned to scheduled start', state.cars['1'].state.stintStartMs === futureStart);
const preClock = raceClock(state.race, Date.now());
check('clock counts down pre-start', preClock.scheduled && !preClock.running && preClock.msToStart > 0);

send({ type: 'startRace' });
await wait(150);
check('startRace overrides scheduled start', !!state.race.startMs && state.race.startMs <= Date.now());
check('stints started', state.cars['1'].state.stintStartMs === state.race.startMs);

// laps count tyres/counters but do NOT burn fuel (fuel is time-based)
for (let i = 0; i < 5; i++) send({ type: 'lap', carId: '1', lapSec: 104.5 });
await wait(200);
check('5 laps logged', state.cars['1'].state.totalLaps === 5);
check('lap does not burn fuel', state.cars['1'].state.fuelLiters === 100);
check('tyre laps track', state.cars['1'].state.tyreLapsOnSet === 5);
check('last lap stored', state.cars['1'].state.lastLapSec === 104.5);

send({ type: 'undoLap', carId: '1' });
await wait(150);
check('undo lap counters', state.cars['1'].state.totalLaps === 4 && state.cars['1'].state.tyreLapsOnSet === 4);

// burn rates per condition (pure)
check('dry burn default', effectiveBurn(state.cars['1'], 'dry') === 2.8);
check('sc burn', effectiveBurn(state.cars['1'], 'sc') === 1.2);

// derived calcs with safety level: usable = 100 - 3 = 97 -> 34 laps at 2.8
const c1 = carCalcs(state.cars['1'], state.race, Date.now());
check('safety + finish margin exposed', c1.safety === 3 && c1.finishMargin === 5);
check('lapsToEmpty uses usable fuel', c1.lapsToEmpty === Math.floor(97 / 2.8));
check('fuelToEnd includes finish margin', Math.abs(c1.fuelToEnd - (c1.lapsRemainingRace * 2.8 + 5)) < 0.01);
check('full stint laps respect safety', c1.fullStintLaps === Math.floor(97 / 2.8));
check('limit computed', ['fuel', 'tyres', 'driver'].includes(c1.limit.key));
check('brakes accrue', c1.brakes.padsFront.usedH > 0);
check('timeline blocks projected', projectStints(state.cars['1'], state.race, Date.now()).length > 10);

// plan a stop: fuel 60, tyres, driver change, pads front
send({ type: 'update', carId: '1', patch: { nextStop: { fuelLiters: 60, tyres: true, driverChange: 'd2', padsFront: true, status: 'sent' } } });
await wait(150);
check('stop sent', state.cars['1'].nextStop.status === 'sent');

send({ type: 'update', carId: '1', patch: { nextStop: { status: 'box' } } });
await wait(150);
check('box box', state.cars['1'].nextStop.status === 'box');

send({ type: 'applyStop', carId: '1' });
await wait(150);
const s1 = state.cars['1'].state;
check('fuel added capped at tank', Math.abs(s1.fuelLiters - 100) < 0.01); // 100 + 60 capped at 100
check('tyres reset', s1.tyreLapsOnSet === 0 && s1.tyreSetsUsed === 2);
check('driver changed', state.cars['1'].currentDriverId === 'd2');
check('pads front reset', s1.brakeUsedH.padsFront === 0);
check('pads rear kept', s1.brakeUsedH.padsRear > 0);
check('stint reset', s1.lapsThisStint === 0);
check('history recorded', state.cars['1'].stintHistory.length === 1 && state.cars['1'].stintHistory[0].laps === 4);
check('next stop cleared', state.cars['1'].nextStop.status === 'draft' && state.cars['1'].nextStop.fuelLiters === 0);
check('driver time folded', state.cars['1'].drivers[0].totalMs > 0);

// per-driver fuel consumption: d2 (now in car) with own dry burn
const drivers = state.cars['1'].drivers.map(d => d.id === 'd2' ? { ...d, fuelDry: 3.5 } : d);
send({ type: 'update', carId: '1', patch: { drivers } });
await wait(150);
check('effectiveBurn uses driver figure', effectiveBurn(state.cars['1'], 'dry') === 3.5);
check('effectiveBurn falls back for wet', effectiveBurn(state.cars['1'], 'wet') === state.cars['1'].config.burnPerLap.wet);
check('driver flags default on', state.cars['1'].drivers[0].doubleStint === true && state.cars['1'].drivers[0].night === true && state.cars['1'].drivers[0].rain === true);

// FCY procedure: overrides driver-specific burn with the SC/FCY rate
send({ type: 'fcy', active: true });
await wait(150);
check('fcy active', state.race.fcy.active === true && !!state.race.fcy.startMs);
check('fcy overrides driver burn', effectiveBurn(state.cars['1'], 'dry', true) === 1.2);
const cFcy = carCalcs(state.cars['1'], state.race, Date.now());
check('carCalcs uses fcy lap time + burn', cFcy.fcyActive === true && cFcy.lapMs === 165000 && cFcy.burn === 1.2);
send({ type: 'fcy', active: false });
await wait(150);
check('fcy ended', state.race.fcy.active === false && state.race.fcy.startMs === null);
check('back to driver burn after fcy', carCalcs(state.cars['1'], state.race, Date.now()).burn === 3.5);

// pit stop timing: 60 L at 2.5 L/s = 24 s, + 25 s tyres = 49 s
const stTime = stopServiceTime(state.cars['1'], { fuelLiters: 60, tyres: true });
check('stop service time', Math.abs(stTime.totalSec - 49) < 0.01 && Math.abs(stTime.refuelSec - 24) < 0.01);
check('stop time without tyres', Math.abs(stopServiceTime(state.cars['1'], { fuelLiters: 60, tyres: false }).totalSec - 24) < 0.01);

// FCY calculator: 4 km at 80 km/h = 180 s lap; green dry 105 s -> +75 s gain; net pit loss 55-75 = -20
const fc = fcyCalc(state.cars['1']);
check('fcy lap time', Math.abs(fc.fcyLapSec - 180) < 0.01);
check('fcy gain per lap', Math.abs(fc.gainSec - 75) < 0.01);
check('fcy net pit loss (free stop)', Math.abs(fc.netPitLossSec - -20) < 0.01);

// other cars untouched
check('car 2 untouched', state.cars['2'].state.totalLaps === 0);

// ---- time-based fuel burn on a fast-ticking second server ----
const info2 = startServer({ dataFile: null, port: 8486, tickMs: 150 });
const ws2 = new WebSocket('ws://127.0.0.1:' + info2.port);
let state2 = null;
ws2.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'state') state2 = m.state;
});
await new Promise(r => ws2.on('open', r));
const send2 = o => ws2.send(JSON.stringify(o));
await wait(200);
check('tick server up', state2 && state2.cars['1'].state.fuelLiters === 100);
check('no burn before race start', (await wait(400), state2.cars['1'].state.fuelLiters === 100));
send2({ type: 'startRace' });
await wait(1200);
const burned = 100 - state2.cars['1'].state.fuelLiters;
// dry: 2.8 L / 105 s = 0.0267 L/s -> ~0.03 L in ~1.2 s
check('fuel drains with time while clock runs', burned > 0.005 && burned < 0.2);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
