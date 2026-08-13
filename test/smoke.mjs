// Headless smoke test: boots the server, drives it over WebSocket like a
// station + pit wall would, and asserts the state transitions.
// Run with: npm test
import { startServer } from '../server/server.js';
import {
  carCalcs, projectStints, raceClock, effectiveBurn, stopServiceTime, fcyCalc, pitLaneCalc, pitEta, generatePlan,
  fuelStrategy, defaultCar, emptyStop,
  recommendedStops, resolveStop,
  raceCondition,
  burnAtLapTime, normalizeCurve, pushLapTime, burnDetail, LAP_AVG_WINDOW,
  driveTimeStats, pitCongestion, replanFromNow, planVsActual, stintStats, learnedOf, fmtGapUs,
  carPickLabel, driverAbbrev, matchTimingDriver, createFeedSeen
} from '../shared/model.js';
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ports 8485/8486 so tests never touch a live app on the default port 8484.
// Main server: no ticking, so fuel values stay deterministic.
const info = startServer({ dataFile: null, port: 8485, tickMs: 3600e3 });
console.log('server up on', info.port, 'ips:', info.ips);

const ws = new WebSocket('ws://127.0.0.1:' + info.port);
let state = null;
let stationsOnline = {};
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'state') state = m.state;
  if (m.type === 'stations') stationsOnline = m.online || {};
});

const send = o => ws.send(JSON.stringify(o));
const wait = ms => new Promise(r => setTimeout(r, ms));

// Wait for a broadcast to actually satisfy `fn` rather than sleeping a fixed
// time — under load the old fixed sleeps raced the server's reply and failed
// a whole block of unrelated checks.
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fn()) return true;
    } catch {}
    await wait(20);
  }
  return false;
}
let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!cond) failures++;
}

await new Promise(r => ws.on('open', r));
await until(() => state && Object.keys(state.cars).length === 4);
check('initial state received', state && Object.keys(state.cars).length === 4);

// scheduled start: future start time counts down, aligns first stints
const futureStart = Date.now() + 3600e3;
send({ type: 'race', patch: { startMs: futureStart } });
await until(() => state.race.startMs === futureStart);
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
check('fuel reset to the stop level', Math.abs(s1.fuelLiters - 60) < 0.01); // tank set TO 60, not +60
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

// FCY procedure: overrides driver-specific burn with the car's FCY rate.
// SC and FCY are separate rates — FCY defaults to 0.9 L/lap over a 180 s lap,
// Safety Car to 1.2 L/lap over 165 s.
send({ type: 'fcy', mode: 'fcy' });
await wait(150);
check('fcy active', state.race.fcy.active === true && !!state.race.fcy.startMs);
check('fcy overrides driver burn', effectiveBurn(state.cars['1'], 'dry', 'fcy') === 0.9);
check('sc burn is a separate rate', effectiveBurn(state.cars['1'], 'dry', 'sc') === 1.2);
const cFcy = carCalcs(state.cars['1'], state.race, Date.now());
check('carCalcs uses fcy lap time + burn', cFcy.fcyActive === true && cFcy.lapMs === 180000 && cFcy.burn === 0.9);
check('carCalcs exposes the condition', cFcy.condition.id === 'fcy' && cFcy.condition.source === 'manual');
send({ type: 'fcy', mode: 'green' });
await wait(150);
check('fcy ended', state.race.fcy.active === false && state.race.fcy.startMs === null);
check('back to driver burn after fcy', carCalcs(state.cars['1'], state.race, Date.now()).burn === 3.5);

// Race-condition resolver: feed flag → condition, with the manual override on
// top. Exercised directly, since it has to behave with no feed connected too.
check('flag 7 is FCY from the feed',
  raceCondition({ fcy: { mode: 'auto' } }, 7).id === 'fcy');
check('flag 3 is safety car, sc pace',
  raceCondition({ fcy: { mode: 'auto' } }, 3).pace === 'sc');
check('flag 4 is code 60 on the fcy pace',
  raceCondition({ fcy: { mode: 'auto' } }, 4).pace === 'fcy');
check('flag 2 stops the burn',
  raceCondition({ fcy: { mode: 'auto' } }, 2).pace === 'stopped');
check('green is not an alert',
  raceCondition({ fcy: { mode: 'auto' } }, 6).alert === false);
check('fcy is an alert', raceCondition({ fcy: { mode: 'auto' } }, 7).alert === true);
check('force green overrides a feed fcy',
  raceCondition({ fcy: { mode: 'green' } }, 7).id === 'green');
check('force green cannot hide a red flag',
  raceCondition({ fcy: { mode: 'green' } }, 2).id === 'red');
check('force fcy overrides a feed green',
  raceCondition({ fcy: { mode: 'fcy' } }, 6).id === 'fcy');
check('force sc overrides a feed green',
  raceCondition({ fcy: { mode: 'sc' } }, 6).pace === 'sc');
check('force red stops the field with no feed at all',
  raceCondition({ fcy: { mode: 'red' } }, null).pace === 'stopped');
check('legacy boolean state still resolves',
  raceCondition({ fcy: { active: true } }, null).id === 'fcy');
// With no feed, AUTO means green — a stale `active` must not latch the race
// into FCY forever once the pit wall has released it.
check('auto with no feed is green, not a latched fcy',
  raceCondition({ fcy: { mode: 'auto', active: true } }, null).id === 'green');
check('forced fcy survives with no feed at all',
  raceCondition({ fcy: { mode: 'fcy' } }, null).id === 'fcy');
check('red flag burns nothing',
  effectiveBurn(state.cars['1'], 'dry', 'stopped') === 0);

// A manual FCY must survive the feed simply *reporting* the flag that was
// already showing — only a genuine change releases the override. Regression:
// the first flag the server observed used to cancel a manual call instantly.
send({ type: 'fcy', mode: 'fcy' });
await wait(150);
check('manual fcy holds while the feed flag is unchanged',
  state.race.fcy.mode === 'fcy' && state.race.fcy.active === true);
send({ type: 'fcy', mode: 'auto' });
await wait(150);
check('auto mode clears the override stamp',
  state.race.fcy.mode === 'auto' && state.race.fcy.overrideFlag === null);

// Crowd-sourced intervention: SC and red are startable/stoppable from any
// screen exactly like FCY — one message flips the whole field for everyone.
send({ type: 'fcy', mode: 'sc' });
await wait(150);
check('manual sc is race-wide',
  state.race.fcy.condition === 'sc' && state.race.fcy.active === true && !!state.race.fcy.startMs);
check('manual sc burns at the sc rate',
  carCalcs(state.cars['1'], state.race, Date.now()).burn === 1.2);
send({ type: 'fcy', mode: 'red' });
await wait(150);
check('manual red stops the field',
  state.race.fcy.condition === 'red' &&
  carCalcs(state.cars['1'], state.race, Date.now()).condition.pace === 'stopped');
send({ type: 'fcy', mode: 'auto' });
await wait(150);
check('manual red released back to auto', state.race.fcy.mode === 'auto' &&
  carCalcs(state.cars['1'], state.race, Date.now()).condition.id === 'green');

// pit stop timing: on board 60, fill to 100 -> add 40 L at 2.5 L/s = 16 s, + 25 s tyres = 41 s
const stTime = stopServiceTime(state.cars['1'], { fuelLiters: 100, tyres: true });
check('stop service time', Math.abs(stTime.totalSec - 41) < 0.01 &&
  Math.abs(stTime.refuelSec - 16) < 0.01 && Math.abs(stTime.addLiters - 40) < 0.01);
check('stop time without tyres', Math.abs(stopServiceTime(state.cars['1'], { fuelLiters: 100, tyres: false }).totalSec - 16) < 0.01);
check('target below on-board adds nothing', stopServiceTime(state.cars['1'], { fuelLiters: 30, tyres: false }).totalSec === 0);

// FCY calculator: 4 km at 80 km/h = 180 s lap; green dry 105 s -> +75 s gain; net pit loss 55-75 = -20
const fc = fcyCalc(state.cars['1']);
check('fcy lap time', Math.abs(fc.fcyLapSec - 180) < 0.01);
check('fcy gain per lap', Math.abs(fc.gainSec - 75) < 0.01);
check('fcy net pit loss (free stop)', Math.abs(fc.netPitLossSec - -20) < 0.01);

// pit lane at the limit: 0.4 km at 60 km/h = 24 s; 55 s loss leaves 31 s overhead
const pl = pitLaneCalc(state.cars['1']);
check('pit lane transit time', Math.abs(pl.transitSec - 24) < 0.01);
check('pit lane overhead vs configured loss', Math.abs(pl.overheadSec - 31) < 0.01);
check('pit lane needs both figures', pitLaneCalc({ config: { pitLaneKm: 0.4, pitSpeedKmh: 0 } }) === null);

// car picker labels: the slot keeps its "Car N" identity, name/number append
check('car label default', carPickLabel('1', { number: '1', name: 'Car #1' }) === 'Car 1');
check('car label named', carPickLabel('1', { number: '34', name: 'Red Racer' }) === 'Car 1 — Red Racer');
check('car label number only', carPickLabel('2', { number: '107', name: 'Car #107' }) === 'Car 2 — #107');

// ---- feed-seen tracking: "not in the feed yet" vs "vanished from the board" ----
{
  const fsn = createFeedSeen();
  check('feed-seen: unknown nr is waiting', !fsn.has('26'));
  fsn.update({ conn: 'connected', session: { name: 'Race' }, entries: [{ nr: '26' }, { nr: ' 7 ' }] });
  check('feed-seen: posted nr is seen', fsn.has('26'));
  check('feed-seen: nrs are trimmed', fsn.has('7'));
  fsn.update({ conn: 'connected', session: { name: 'Race' }, entries: [{ nr: '7' }] });
  check('feed-seen: a dropped nr stays seen in-session', fsn.has('26'));
  fsn.update({ conn: 'error', session: { name: 'Practice' }, entries: [] });
  check('feed-seen: non-live snapshots change nothing', fsn.has('26'));
  fsn.update({ conn: 'connected', session: { name: 'Night Race' }, entries: [{ nr: '7' }] });
  check('feed-seen: session change forgets the field', !fsn.has('26'));
  fsn.update({ conn: 'replay', session: { name: 'Night Race' }, sessions: { selected: 's2' }, entries: [{ nr: 26 }] });
  check('feed-seen: session-picker switch starts over', !fsn.has('7'));
  check('feed-seen: replay posts count, numeric nr matches', fsn.has('26'));
}

// ---- driver recognition from the timing feed ----
{
  const rosterCar = { drivers: [
    { id: 'd1', name: 'Max Verstappen', abbrev: '', timingName: '' },
    { id: 'd2', name: 'Kévin Van der Berg', abbrev: 'KVB', timingName: 'VAN DER BERG' },
    { id: 'd3', name: 'John Doe', abbrev: '', timingName: '' },
    { id: 'd4', name: 'Jane Doe', abbrev: 'JAN', timingName: '' }
  ] };
  check('abbrev entered wins', driverAbbrev(rosterCar.drivers[1]) === 'KVB');
  check('abbrev derived from surname', driverAbbrev(rosterCar.drivers[0]) === 'VER');
  check('match exact name', matchTimingDriver(rosterCar, 'Max Verstappen')?.id === 'd1');
  check('match reordered name', matchTimingDriver(rosterCar, 'VERSTAPPEN Max')?.id === 'd1');
  check('match initial + surname', matchTimingDriver(rosterCar, 'M. VERSTAPPEN')?.id === 'd1');
  check('match timing name w/ accents', matchTimingDriver(rosterCar, 'Kevin van der Berg')?.id === 'd2');
  check('match surname-only timing name', matchTimingDriver(rosterCar, 'J. VAN DER BERG')?.id === 'd2');
  check('match abbrev as code', matchTimingDriver(rosterCar, 'JAN')?.id === 'd4');
  check('ambiguous surname no match', matchTimingDriver(rosterCar, 'DOE') === null);
  check('unknown name no match', matchTimingDriver(rosterCar, 'Somebody Else') === null);
  check('empty feed text no match', matchTimingDriver(rosterCar, '') === null);
}

// renaming a car — the pit wall settings and the station's CAR tab send the
// same plain car patch
send({ type: 'update', carId: '2', patch: { name: 'Red Racer' } });
await until(() => state.cars['2'].name === 'Red Racer');
check('car rename lands in shared state', state.cars['2'].name === 'Red Racer');

// ---- fuel strategy: the pit window (pure) ----
// Test car: tank 100 L, safety 3 (usable 97), dry burn 2.8 L/lap, finish
// margin 5 L, avg lap 100 s, pit loss 55 s. fsRace(n) = n laps remaining.
const fsNow = Date.now();
const fsCar = defaultCar('9', '9');
fsCar.config.avgLapSec.dry = 100;
const fsRace = laps => ({
  durationH: 2,
  startMs: fsNow - (2 * 3600e3 - laps * 100e3),
  fcy: { mode: 'auto', active: false, startMs: null, source: 'none', flag: null }
});

// 36 laps to go on 60 L: 105.8 L needed → one stop minimum, but a fill-up now
// tops at 100 L and leaves 5.8 L to fetch later → boxing now adds a stop.
fsCar.state.fuelLiters = 60;
let fstr = fuelStrategy(fsCar, fsRace(36), fsNow);
check('window: one stop minimum', fstr.stopsMin === 1);
check('window: boxing now adds a stop', fstr.stopsIfNow === 2 && !fstr.windowOpen && fstr.verdict === 'wait');
check('window: opens in 3 laps', fstr.lapsToWindow === 3 && Math.abs(fstr.msToWindow - 300e3) < 1);
check('window: early box costs one pit-lane loss', Math.abs(fstr.netPitNowSec - 55) < 0.01);

// 33 laps to go (97.4 L needed ≤ tank): one fill-to-full reaches the flag.
fstr = fuelStrategy(fsCar, fsRace(33), fsNow);
check('window open in one-stop range', fstr.windowOpen && fstr.stopsIfNow === 1 && fstr.verdict === 'open');
check('window: box is time-neutral under green', fstr.netPitNowSec === 0);
check('window: fill target capped at the tank', fstr.fillTargetL === 100);
check('window: closes when the tank runs to safety', fstr.windowLapsLeft === Math.floor((60 - 3) / 2.8));

// Full tank inside the last stint: no fuel stop needed at all.
fsCar.state.fuelLiters = 100;
fstr = fuelStrategy(fsCar, fsRace(33), fsNow);
check('no stop needed on a full tank', fstr.noStopNeeded && fstr.verdict === 'noStop' && fstr.stopsMin === 0);

// FCY with the window open: fuel need stays projected on green pace (no
// "whole race stays FCY" optimism), and the stop is discounted by the gain
// (4 km at 80 km/h = 180 s FCY lap vs 100 s green → 80 s per lap).
fsCar.state.fuelLiters = 60;
const fcyRace = { ...fsRace(33), fcy: { mode: 'fcy', active: true, startMs: fsNow, source: 'manual', flag: null } };
fstr = fuelStrategy(fsCar, fcyRace, fsNow);
check('fcy: fuel need stays on green basis', fstr.stopsMin === 1 && Math.abs(fstr.fuelToEnd - 97.4) < 0.01);
check('fcy: box now saves the gain', fstr.verdict === 'pitNow' && Math.abs(fstr.netPitNowSec + 80) < 0.01);

// Low-fuel warning levels (laps counted above the safety reserve).
fsCar.state.fuelLiters = 3 + 4 * 2.8; // exactly 4 laps of usable fuel
fstr = fuelStrategy(fsCar, fsRace(33), fsNow);
check('low fuel warns at the threshold', fstr.warn.level === 'warn' && fstr.warn.lapsLeft === 4);
fsCar.state.fuelLiters = 3 + 1.5 * 2.8;
fstr = fuelStrategy(fsCar, fsRace(33), fsNow);
check('low fuel goes critical at 2 laps', fstr.warn.level === 'crit');
fsCar.config.fuelWarnLaps = 0;
check('low fuel warning can be disabled', fuelStrategy(fsCar, fsRace(33), fsNow).warn.level === 'ok');
fsCar.config.fuelWarnLaps = 5;
check('no window before the race runs', fuelStrategy(fsCar, { durationH: 2, startMs: null, fcy: {} }, fsNow) === null);

// other cars untouched
check('car 2 untouched', state.cars['2'].state.totalLaps === 0);

// ---- settings, presets, stint plan ----
check('global settings exist', state.settings && state.settings.backupIntervalMin === 5);
send({ type: 'settings', patch: { backupIntervalMin: 10 } });
await wait(150);
check('settings patch applied', state.settings.backupIntervalMin === 10);

// ---- event settings: edited once on the pit wall, mirrored to every car ----
check('event settings seeded', state.event && state.event.trackKm === 4 && state.event.refuelLps === 2.5 &&
  state.event.pitSpeedKmh === 60 && state.event.pitLaneKm === 0.4);
send({ type: 'event', patch: { pitSpeedKmh: 50 } });
await wait(150);
check('pit speed mirrored to every car', Object.values(state.cars).every(c => c.config.pitSpeedKmh === 50));
send({ type: 'event', patch: { pitSpeedKmh: 60 } });
await wait(150);
send({ type: 'event', patch: { refuelLps: 3, fcySpeedKmh: 60 } });
await wait(150);
check('event patch stored', state.event.refuelLps === 3 && state.event.fcySpeedKmh === 60);
check('event mirrored to every car', Object.values(state.cars).every(c =>
  c.config.refuelLps === 3 && c.config.fcySpeedKmh === 60));
send({ type: 'update', carId: '2', patch: { config: { pitLossSec: 99 } } });
await wait(150);
check('config patch cannot fork event fields', state.cars['2'].config.pitLossSec === state.event.pitLossSec);

send({ type: 'savePreset', carId: '1', name: 'test setup' });
await wait(150);
const preset = state.presets['test setup'];
check('preset saved', !!preset && preset.config.tankLiters === 100 && preset.drivers.length === 4);
check('preset zeroes seat time', preset.drivers.every(d => d.totalMs === 0));

const seatTimeBefore = state.cars['2'].drivers[0].totalMs;
send({ type: 'update', carId: '2', patch: { config: { tankLiters: 80 } } });
await wait(150);
send({ type: 'event', patch: { refuelLps: 2.8 } });
await wait(150);
send({ type: 'loadPreset', carId: '2', name: 'test setup' });
await wait(150);
check('preset loaded onto car 2', state.cars['2'].config.tankLiters === 100);
check('event settings win over preset values', state.cars['2'].config.refuelLps === 2.8);
check('preset load keeps seat time', state.cars['2'].drivers[0].totalMs === seatTimeBefore);
send({ type: 'deletePreset', name: 'test setup' });
await wait(150);
check('preset deleted', !state.presets['test setup']);

// ---- race setups: race name + duration + event settings under a name ----
send({ type: 'race', patch: { name: 'Test 30min', durationH: 0.5 } });
await wait(150);
send({ type: 'saveRaceSetup', name: 'zolder 24h' });
await wait(150);
const rs = state.raceSetups['zolder 24h'];
check('race setup saved', !!rs && rs.race.name === 'Test 30min' && rs.race.durationH === 0.5 &&
  rs.event.refuelLps === 2.8);
send({ type: 'race', patch: { name: 'Other', durationH: 24 } });
await wait(150);
send({ type: 'event', patch: { refuelLps: 3.2 } });
await wait(150);
const startBeforeLoad = state.race.startMs;
send({ type: 'loadRaceSetup', name: 'zolder 24h' });
await wait(150);
check('race setup loaded', state.race.name === 'Test 30min' && state.race.durationH === 0.5 &&
  state.event.refuelLps === 2.8);
check('race setup load keeps start time', state.race.startMs === startBeforeLoad);
check('race setup load mirrors event to cars', Object.values(state.cars).every(c => c.config.refuelLps === 2.8));
send({ type: 'deleteRaceSetup', name: 'zolder 24h' });
send({ type: 'race', patch: { durationH: 24 } });
await wait(150);
check('race setup deleted', !state.raceSetups['zolder 24h']);

// ---- custom-timeline plan + named saved plans ----
// A 24 h plan generated while the configured session is something else
// entirely: the generator only reads the race object it is handed.
const customPlan = generatePlan(state.cars['1'], { durationH: 24, startMs: Date.now() + 7 * 86400e3 }, Date.now());
check('custom timeline plan spans 24h', customPlan.stints.length > 10 &&
  customPlan.stints[customPlan.stints.length - 1].toMs === 24 * 3600e3);
check('custom timeline start is not assumed', customPlan.assumedStart === false);
customPlan.durationH = 24;
send({ type: 'update', carId: '1', patch: { plan: customPlan } });
await wait(150);
send({ type: 'savePlan', carId: '1', name: 'race plan A' });
await wait(150);
const sp = state.cars['1'].savedPlans['race plan A'];
check('plan saved under name', !!sp && sp.plan.stints.length === customPlan.stints.length);
send({ type: 'update', carId: '1', patch: { plan: null } });
await wait(150);
check('active plan cleared', state.cars['1'].plan === null);
send({ type: 'loadPlan', carId: '1', name: 'race plan A' });
await wait(150);
check('saved plan reloaded as active', state.cars['1'].plan?.stints?.length === customPlan.stints.length &&
  state.cars['1'].plan.durationH === 24);
send({ type: 'deletePlan', carId: '1', name: 'race plan A' });
await wait(150);
check('saved plan deleted', !state.cars['1'].savedPlans['race plan A']);

check('fuel model default', state.cars['1'].config.fuelModel === 'driver-avg');

// ---- per-lap-time fuel model ----

const CURVE = [
  { lapSec: 100, fuelL: 3.0 },
  { lapSec: 110, fuelL: 2.5 },
  { lapSec: 120, fuelL: 2.0 }
];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

check('curve interpolates between points', near(burnAtLapTime(CURVE, 105), 2.75));
check('curve returns exact measured points', near(burnAtLapTime(CURVE, 110), 2.5));
check('curve holds flat below the range', near(burnAtLapTime(CURVE, 80), 3.0));
check('curve holds flat above the range', near(burnAtLapTime(CURVE, 200), 2.0));
check('curve with one point is constant', near(burnAtLapTime([{ lapSec: 100, fuelL: 2.2 }], 175), 2.2));
check('empty curve returns null', burnAtLapTime([], 100) === null);
check('curve ignores junk rows',
  normalizeCurve([{ lapSec: 0, fuelL: 3 }, { lapSec: 100, fuelL: 0 }, { lapSec: 105, fuelL: 2 }]).length === 1);
check('curve sorts unordered points', (() => {
  const n = normalizeCurve([{ lapSec: 120, fuelL: 2 }, { lapSec: 100, fuelL: 3 }]);
  return n[0].lapSec === 100 && n[1].lapSec === 120;
})());

// Rolling lap average: outliers (in/out laps) must not drag the reference lap.
check('lap average smooths and drops outliers', (() => {
  let acc = { recentLapSec: [], avgLapSecLive: null };
  for (const t of [100, 101, 100, 160, 99]) acc = pushLapTime(acc.recentLapSec, t);
  return acc.avgLapSecLive > 99 && acc.avgLapSecLive < 102;
})());
check('lap average window is bounded', (() => {
  let acc = { recentLapSec: [], avgLapSecLive: null };
  for (let i = 0; i < 20; i++) acc = pushLapTime(acc.recentLapSec, 100);
  return acc.recentLapSec.length === LAP_AVG_WINDOW;
})());

// burnDetail precedence, on a detached copy so the live state is untouched.
const curveCar = JSON.parse(JSON.stringify(state.cars['1']));
curveCar.condition = 'dry';
curveCar.config.fuelModel = 'driver-laptime';
curveCar.currentDriverId = curveCar.drivers[0].id;
curveCar.drivers[0].fuelCurve = CURVE;
curveCar.drivers[0].fuelDry = 9.9; // must lose to the curve

check('lap-time model reads the curve', near(burnDetail(curveCar, 'dry', false, 105).burn, 2.75));
check('lap-time model reports its source', burnDetail(curveCar, 'dry', false, 105).source === 'curve');
check('lap-time model flags clamped lap times', burnDetail(curveCar, 'dry', false, 300).clamped === true);
check('FCY overrides the curve', (() => {
  const d = burnDetail(curveCar, 'dry', 'fcy', 105);
  return d.source === 'fcy' && near(d.burn, curveCar.config.burnPerLap.fcy);
})());
check('legacy true still means FCY', (() => {
  const d = burnDetail(curveCar, 'dry', true, 105);
  return d.source === 'fcy' && near(d.burn, curveCar.config.burnPerLap.fcy);
})());
check('FCY rate falls back to SC when unset', (() => {
  const old = JSON.parse(JSON.stringify(curveCar));
  delete old.config.burnPerLap.fcy;
  return near(burnDetail(old, 'dry', 'fcy', 105).burn, old.config.burnPerLap.sc);
})());
check('driver average wins when the curve is empty', (() => {
  const c2 = JSON.parse(JSON.stringify(curveCar));
  c2.drivers[0].fuelCurve = [];
  const d = burnDetail(c2, 'dry', false, 105);
  return d.source === 'driver' && near(d.burn, 9.9);
})());
check('avg model ignores the curve entirely', (() => {
  const c3 = JSON.parse(JSON.stringify(curveCar));
  c3.config.fuelModel = 'driver-avg';
  const d = burnDetail(c3, 'dry', false, 105);
  return d.source === 'driver' && near(d.burn, 9.9);
})());
check('carCalcs uses the live lap average as the curve reference', (() => {
  const c4 = JSON.parse(JSON.stringify(curveCar));
  c4.state.avgLapSecLive = 105;
  c4.state.lastLapSec = 160; // one bad lap must not win over the average
  const calc = carCalcs(c4, state.race, Date.now());
  return near(calc.refLapSec, 105) && near(calc.burn, 2.75) && near(calc.lapMs, 105000);
})());
check('plan uses the curve at the configured average lap', (() => {
  const c5 = JSON.parse(JSON.stringify(curveCar));
  c5.config.avgLapSec.dry = 110;
  for (const d of c5.drivers) d.fuelCurve = CURVE;
  const p = generatePlan(c5, state.race, Date.now());
  const usable = c5.config.tankLiters - c5.config.safetyFuelL;
  return p.stints[0].laps === Math.min(
    Math.floor(usable / 2.5),
    Math.floor((c5.config.maxStintMin * 60e3) / 110000));
})());

// Live laps arriving over the wire must feed the rolling average.
send({ type: 'lap', carId: '3', lapSec: 101 });
send({ type: 'lap', carId: '3', lapSec: 103 });
await wait(200);
check('logged laps build the live lap average',
  state.cars['3'].state.avgLapSecLive > 100 && state.cars['3'].state.avgLapSecLive < 104);

const plan = generatePlan(state.cars['1'], state.race, Date.now());
check('plan covers the race', plan.stints.length > 10 &&
  plan.stints[plan.stints.length - 1].toMs >= state.race.durationH * 3600e3 - 1);
check('plan forces driver changes (no triple stints)', (() => {
  let run = 1;
  for (let i = 1; i < plan.stints.length; i++) {
    run = plan.stints[i].driverId === plan.stints[i - 1].driverId ? run + 1 : 1;
    if (run > 2) return false;
  }
  return true;
})());
check('plan balances seat time', (() => {
  const t = Object.values(plan.totals);
  return Math.max(...t) - Math.min(...t) < 4 * 3600e3;
})());
// night stints only for night-capable drivers (when at least one exists)
const nightOk = plan.stints.every(s => {
  if (!s.night || s.noNightCover) return true;
  const d = state.cars['1'].drivers.find(x => x.id === s.driverId);
  return d && d.night;
});
check('night stints respect night flag', nightOk);

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

// ---- pit lane: burn pauses, applyStop resets the level and releases the car ----
send2({ type: 'inPit', carId: '1', inPit: true });
await wait(300);
check('in-pit flag set', state2.cars['1'].state.inPit === true && !!state2.cars['1'].state.pitEnterMs);
const fuelAtEntry = state2.cars['1'].state.fuelLiters;
await wait(600);
check('no fuel burn while in pit', state2.cars['1'].state.fuelLiters === fuelAtEntry);
check('other cars keep burning', state2.cars['2'].state.fuelLiters < 100);

send2({ type: 'update', carId: '1', patch: { nextStop: { fuelLiters: 80, status: 'box' } } });
await wait(150);
send2({ type: 'applyStop', carId: '1' });
await wait(250);
check('stop resets fuel to the planned level', Math.abs(state2.cars['1'].state.fuelLiters - 80) < 0.05);
check('stop releases the car from the pit', state2.cars['1'].state.inPit === false &&
  state2.cars['1'].state.pitEnterMs === null);

// drive-through: in and out with no service keeps the fuel level untouched
send2({ type: 'inPit', carId: '1', inPit: true });
await wait(200);
const fuelDriveThrough = state2.cars['1'].state.fuelLiters;
send2({ type: 'inPit', carId: '1', inPit: false });
await wait(200);
check('drive-through keeps fuel level', Math.abs(state2.cars['1'].state.fuelLiters - fuelDriveThrough) < 0.05 &&
  state2.cars['1'].state.inPit === false);

// ---- driver add/remove + migration of a saved state with no drivers ----
const brokenState = JSON.parse(JSON.stringify(state));
brokenState.cars['1'].drivers = [];
brokenState.cars['1'].currentDriverId = 'd1';
brokenState.cars['2'].currentDriverId = 'd99';
delete brokenState.cars['1'].state.inPit; // saved before the pit-lane field existed
delete brokenState.cars['1'].state.pitEnterMs;
delete brokenState.event; // saved before event settings existed
brokenState.cars['1'].config.pitLossSec = 40;
const tmpFile = path.join(os.tmpdir(), `pitwall-smoke-${process.pid}.json`);
fs.writeFileSync(tmpFile, JSON.stringify(brokenState));

const info3 = startServer({ dataFile: tmpFile, port: 8487, tickMs: 3600e3 });
const ws3 = new WebSocket('ws://127.0.0.1:' + info3.port);
let state3 = null;
ws3.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'state') state3 = m.state;
});
await new Promise(r => ws3.on('open', r));
const send3 = o => ws3.send(JSON.stringify(o));
await wait(200);
check('empty driver list reseeded on restore', state3.cars['1'].drivers.length === 4);
check('pit-lane fields migrated on restore', state3.cars['1'].state.inPit === false &&
  state3.cars['1'].state.pitEnterMs === null);
check('dangling currentDriverId repaired', state3.cars['2'].currentDriverId === state3.cars['2'].drivers[0].id);
check('event adopted from first car on restore', state3.event.pitLossSec === 40);
check('event mirrored to all cars on restore', state3.cars['2'].config.pitLossSec === 40);

// stations add/remove drivers by patching the whole array (arrays replace, not merge)
const plus = [...state3.cars['1'].drivers, { id: 'd5', name: 'Driver 5', totalMs: 0,
  doubleStint: true, night: true, rain: true, fuelDry: 0, fuelWet: 0 }];
send3({ type: 'update', carId: '1', patch: { drivers: plus } });
await wait(150);
check('driver added via patch', state3.cars['1'].drivers.length === 5 &&
  state3.cars['1'].drivers[4].name === 'Driver 5');
send3({ type: 'update', carId: '1', patch: { drivers: state3.cars['1'].drivers.filter(d => d.id !== 'd5') } });
await wait(150);
check('driver removed via patch', state3.cars['1'].drivers.length === 4 &&
  !state3.cars['1'].drivers.some(d => d.id === 'd5'));
try { fs.unlinkSync(tmpFile); } catch {}

// ---- live timing: decoder units ----
const {
  compressToUTF16, decompressFromUTF16, decodeBootstrap, parseTimeToUs,
  parseXmlFragment, xmlToObj, TimingEngine, parseTsDateUs, tsPortImpliesSsl,
  createTimingRecorder, readReplayFile, listReplayFiles, createTimingService,
  applyWatchFlag, TeamStreamRelay
} = await import('../server/livetiming.js');

// the raw wire tap must see every complete message before ANY interpretation —
// including bare non-XML text the element decoder silently drops
const rawSeen = [];
const rawRelay = new TeamStreamRelay({ host: 'x', key: 'k' }, {
  onRaw: t => rawSeen.push(t), onFrame: () => {}, onStatus: () => {}
});
rawRelay._processMessage('<pass nr="1" lap="2" ms="1" loopid="111"/>');
rawRelay._processMessage('TRACK STATUS UNKNOWN PACKET');
check('ts raw tap sees every message including bare text',
  rawSeen.length === 2 && rawSeen[1] === 'TRACK STATUS UNKNOWN PACKET');

// LZString round-trip (the getraceresults bootstrap compression)
const lzSample = JSON.stringify([['h_i', { n: 'Test Heat', f: 6 }], ['s_t', 123456789]]);
check('lzstring round trip', decompressFromUTF16(compressToUTF16(lzSample)) === lzSample);
check('bootstrap OK<µs> form', JSON.stringify(decodeBootstrap('OK1730000000000000')) ===
  JSON.stringify([['s_t', 1730000000000000]]));
const boot = decodeBootstrap(compressToUTF16(lzSample));
check('bootstrap decompress form', boot.length === 2 && boot[0][0] === 'h_i' && boot[1][1] === 123456789);

// time parsing: µs / ms / s numbers + clock strings, all to µs
check('parseTimeToUs µs', parseTimeToUs(104500000) === 104500000);
check('parseTimeToUs ms', parseTimeToUs(104500) === 104500000);
check('parseTimeToUs s', parseTimeToUs(104.5) === 104500000);
check('parseTimeToUs m:ss', parseTimeToUs('1:44.500') === 104500000);
check('parseTimeToUs h:m:s', parseTimeToUs('1:00:00') === 3600e6);
check('parseTimeToUs junk', parseTimeToUs('DNF') === null && parseTimeToUs('') === null);

// TeamStream XML: fragments, repeat elements, entities, self-closing
const tsXml = '<session><name>24H Test</name><enrollment><no>17</no><team>A &amp; B</team>' +
  '<teammember><name>Alice</name></teammember><teammember><name>Bob</name></teammember>' +
  '</enrollment></session><time>12:00:00</time><brk/>';
const tsEls = parseXmlFragment(tsXml);
check('xml fragment roots', tsEls.length === 3 && tsEls[0].tag === 'session' && tsEls[2].tag === 'brk');
const tsObj = xmlToObj(tsEls[0]);
check('xml entities + lists', tsObj.enrollment[0].team === 'A & B' &&
  tsObj.enrollment[0].teammember.length === 2);

// getraceresults board: header detection, init grid, cell deltas → entries + lap events
const events = [];
const eng = new TimingEngine({ onEvent: e => events.push(e), onLog: () => {} });
eng.applyFrame({ handle: 'r_i', payload: {
  l: {
    h: [
      { n: 'Position', c: 'Pos' }, { n: 'StartNumber', c: 'Nr' }, { n: 'State', c: 'ETA' },
      { n: 'CurrentDriver', c: 'Driver' }, { n: 'Name', c: 'Team' }, { n: 'Class', c: 'Cls' },
      { n: 'PitStops', c: 'Pit' }, { n: 'LastRoundTime', c: 'Last' }, { n: 'FastestRoundTime', c: 'Best' }
    ],
    d: [
      ['1', '17', 'E1730000000000000', 'Alice', 'Team Alpha', 'GT3', '2', '105300000', '104100000'],
      ['2', '23', 'SIn Pit', 'Carol', 'Team Beta', '992', '3', '106000000', '105000000']
    ]
  }
}, ts: Date.now() });
let snap = eng.snapshot();
check('grr entries decoded', snap.entries.length === 2 && snap.entries[0].nr === '17' &&
  snap.entries[0].driver === 'Alice' && snap.entries[0].team === 'Team Alpha');
check('grr lap times decoded', snap.entries[0].lastUs === 105300000 && snap.entries[0].bestUs === 104100000);
check('grr pit state decoded', snap.entries[1].inPit === true && snap.entries[0].inPit === false);
check('init fires no lap events', events.length === 0);

// heat + flag + remaining clock
eng.applyFrame({ handle: 'h_i', payload: { n: 'Race', f: 6, lt: 24 * 3600e6, r: 3600e6 }, ts: Date.now() });
snap = eng.snapshot();
check('heat decoded', snap.session.name === 'Race' && snap.session.flag === 6);
check('remaining clock', Math.abs(snap.session.remainUs - 23 * 3600e6) < 5e6);
check('session clock exposed', snap.session.totalUs === 24 * 3600e6 &&
  Math.abs(snap.session.elapsedUs - 3600e6) < 5e6);

// server-clock anchoring: an s_t right after the heat (same bootstrap) anchors
// the elapsed time to the feed's clock; a later s_t revealing the heat was 12 s
// stale on arrival must pull the countdown forward by those 12 s.
eng.applyFrame({ handle: 's_t', payload: 1730000000000000, ts: Date.now() });
eng.applyFrame({ handle: 's_t', payload: 1730000012000000, ts: Date.now() });
snap = eng.snapshot();
check('remaining follows server clock', Math.abs(snap.session.remainUs - (23 * 3600e6 - 12e6)) < 5e6);
// s_i is a reconnect message index, never a clock sample
eng.applyFrame({ handle: 's_i', payload: 42, ts: Date.now() });
check('s_i does not corrupt server time', eng.serverTimeUs === 1730000012000000);
// the heat's q field is the server time at which r was sampled — the feed
// publishes r ~10 s behind its own clock, so elapsed = r + (serverNow − q)
eng.applyFrame({ handle: 'h_h', payload: { r: 2 * 3600e6, q: 1730000002000000, h: false }, ts: Date.now() });
snap = eng.snapshot();
check('heat q anchors elapsed', Math.abs(snap.session.remainUs - (22 * 3600e6 - 10e6)) < 5e6);

// A sprint board (getraceresults demo2, TCR Europe) has no PIC/TEAM/CLASS/INT
// columns at all. Those keys must stay empty — the default layout's indices
// point at this board's BEST / LAPS / PIT / S columns, so falling back to them
// showed the unset-best sentinel under PIC and "+6.0" under INT.
const engSprint = new TimingEngine({ onEvent: () => {}, onLog: () => {} });
engSprint.applyFrame({ handle: 'r_i', payload: {
  l: {
    h: [
      { n: 'Position', c: 'Pos' }, { n: '', c: '' }, { n: 'StartNumber', c: 'Nr' },
      { n: 'State', c: 'State' }, { n: 'Name', c: 'Name' }, { n: 'Nationality', c: 'Nat' },
      { n: 'Rounds', c: 'Laps' }, { n: 'Hole', c: 'Gap' }, { n: 'LastRoundTime', c: 'Last' },
      { n: 'FastestRoundTime', c: 'Best' }, { n: 'PitStops', c: 'Pit' },
      { n: 'SectorTimes', p: '1', c: 'Sect-1' }, { n: 'SectorTimes', p: '2', c: 'Sect-2' },
      { n: 'SectorTimes', p: '3', c: 'Sect-3' }, { n: 'SectionMarker', c: 'S' },
      { n: 'Car', c: 'Vehicle' }
    ],
    // BEST unset = Long.MAX_VALUE; S = 6; LAPS/PIT = 0 — exactly what the
    // wrongly-defaulted PIC / INT / TEAM / CLASS columns used to pick up.
    d: [['1', '', '9', '?', 'Josh Files', 'GBR', '0', '', '', '9223372036854775807',
         '0', '37921000', '32061000', '', '6', 'Hyundai i30 N TCR']]
  }
}, ts: Date.now() });
const sprint = engSprint.snapshot().entries[0];
check('sprint board decodes its own columns', sprint.nr === '9' && sprint.pos === 1 &&
  sprint.driver === 'Josh Files' && sprint.nat === 'GBR' && sprint.car === 'Hyundai i30 N TCR' &&
  sprint.s1 === 37921000 && sprint.s2 === 32061000 && sprint.smarker === '6');
check('absent columns stay empty, not defaulted', sprint.pic == null && sprint.team == null &&
  sprint.cls == null && sprint.diff == null);
check('unset-best sentinel is not a value', sprint.bestUs === null);

// a changed LAST cell = one completed lap for that car
eng.applyFrame({ handle: 'r_c', payload: [[0, 7, '104900000']], ts: Date.now() });
check('lap event from LAST change', events.length === 1 && events[0].type === 'lap' &&
  events[0].nr === '17' && Math.abs(events[0].lapSec - 104.9) < 0.001);
// pit out for row 1 (state col = 2)
eng.applyFrame({ handle: 'r_c', payload: [[1, 2, 'SOutLap']], ts: Date.now() });
check('pitOut event from STATE change', events.some(e => e.type === 'pitOut' && e.nr === '23'));

// tracker frames: t_i seeds the timing loops + car rows, t_p updates one car;
// the heat's `c` field is the track length in mm
eng.applyFrame({ handle: 't_i', payload: {
  l: [[0, false, 0], [10, true, 1], [341000, true, 1], [-40000, true, 1], [1733000, false, 0]],
  d: [[0, '17', 1733000, 3611000, 1, 44061, false, 1730000010000000]]
}, ts: Date.now() });
eng.applyFrame({ handle: 't_p',
  payload: [[1, '23', -40000, 341000, -1, 13889, true, 1730000011000000]], ts: Date.now() });
eng.applyFrame({ handle: 'h_h', payload: { c: '5451000' }, ts: Date.now() });
snap = eng.snapshot();
check('tracker rows decoded', !!snap.tracker && snap.tracker.cars['17'].fromMm === 1733000 &&
  snap.tracker.cars['17'].speedMmS === 44061 && snap.tracker.cars['23'].inPit === true);
check('tracker length from heat c', snap.tracker.lenMm === 5451000);
check('tracker loops kept', snap.tracker.loops.length === 5 &&
  snap.tracker.loops[3][0] === -40000 && snap.tracker.loops[3][1] === true);
check('server clock exposed for dead reckoning', typeof snap.serverNowUs === 'number');

// A second r_i is a complete new board: previous rows must not survive. This
// one also carries the qualifying columns of the getraceresults web layout
// (IN LAP / 2nd TIME / 2nd LAP / section marker, verified at Assen).
eng.applyFrame({ handle: 'r_i', payload: { l: {
  h: [
    { n: 'Position', c: 'POS' }, { n: 'StartNumber', c: 'NR' }, { n: 'State', c: 'E.T.A.' },
    { n: 'Name', c: 'NAME' }, { n: 'FastestRoundTime', c: 'BEST TIME' },
    { n: 'FastestRoundNumber', c: 'IN LAP' }, { n: '2nd_fastestRoundTime', c: '2nd TIME' },
    { n: '2nd_fastestRoundNumber', c: '2nd LAP' }, { n: 'SectionMarker', c: 'S' }
  ],
  d: [['1', '96', 'E1730000100000000', 'Milan Marczak', '97690000', '3', '98139000', '4', 'III']]
} }, ts: Date.now() });
snap = eng.snapshot();
check('re-init replaces the whole board', snap.entries.length === 1 && snap.entries[0].nr === '96');
check('quali columns mapped (in lap / 2nd / marker)', snap.entries[0].bestLap === 3 &&
  snap.entries[0].best2Us === 98139000 && snap.entries[0].best2Lap === 4 &&
  snap.entries[0].smarker === 'III');

// heat name change = new session: never leave the old standings underneath
eng.applyFrame({ handle: 'h_h', payload: { n: 'YTCC - Race 1' }, ts: Date.now() });
snap = eng.snapshot();
check('session change clears the board', snap.entries.length === 0);
check('session change event fired', events.some(e => e.type === 'session' && e.name === 'YTCC - Race 1'));

// TeamStream frames through the same engine: <all/> history is silent, live passes fire
const tsEvents = [];
const eng2 = new TimingEngine({ onEvent: e => tsEvents.push(e), onLog: () => {} });
eng2.applyFrame({ handle: 'ts_session', payload: tsObj, ts: Date.now() });
eng2.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { no: '17', lap: '10', laptime: '1:45.100', pos: '3' },
  { no: '17', lap: '11', laptime: '1:44.900', pos: '3' },
  { no: '17', lap: '12', laptime: '1:44.700', pos: '2' },
  { no: '17', lap: '13', laptime: '1:44.500', pos: '2' }
] }, ts: Date.now() }); // >3 passes = history replay, must stay silent
check('ts history replay silent', tsEvents.length === 0);
eng2.applyFrame({ handle: 'ts_pass', payload: { passes: [{ no: '17', lap: '14', laptime: '1:44.300', pos: '1' }] }, ts: Date.now() });
const snap2 = eng2.snapshot();
check('ts live pass fires lap', tsEvents.length === 1 && tsEvents[0].type === 'lap' &&
  Math.abs(tsEvents[0].lapSec - 104.3) < 0.001);
check('ts entry decoded', snap2.entries[0].nr === '17' && snap2.entries[0].laps === 14 &&
  snap2.entries[0].pos === 1 && snap2.entries[0].driver === 'Alice / Bob');

// TeamStream announces only remaining time — no session length/elapsed derivable
eng2.applyFrame({ handle: 'ts_remaining', payload: '2:00:00', ts: Date.now() });
const snapTs = eng2.snapshot();
check('ts remaining-only clock', Math.abs(snapTs.session.remainUs - 2 * 3600e6) < 5e6 &&
  snapTs.session.totalUs === null && snapTs.session.elapsedUs === null);

// ---- TeamStream: the real Time Service shape (captured live at Assen) ----
// Loop-crossing passes + session loops/sections/enrollments must reconstruct
// the full scoreboard: PIC, sectors, best/in-lap/2nd, pit cycle, E.T.A.
// state, quali + race gaps, session clock and the finish inference.
check('ts datetime is 2000-epoch local', parseTsDateUs('01.08.2026 10:30:00') ===
  (Date.UTC(2026, 7, 1, 10, 30, 0) - Date.UTC(2000, 0, 1)) * 1000);
check('ts datetime junk', parseTsDateUs('') === null && parseTsDateUs('garbage') === null);
check('ts port implies ssl', tsPortImpliesSsl(12921) === false && tsPortImpliesSsl(12922) === true &&
  tsPortImpliesSsl(12961) === false && tsPortImpliesSsl(12962) === true && tsPortImpliesSsl(9000) === null);

const tsEv = [];
const engTs = new TimingEngine({ onEvent: e => tsEv.push(e), onLog: () => {} });
const assenSession = {
  event: "Jack's Casino Racing Days", group: 'Porsche Carrera Cup Benelux', name: 'Qualifying',
  laps: '0', start: '01.08.2026 10:30:00', end: '01.08.2026 11:05:00', mode: '0',
  loop: [
    { id: '111', name: 'S/F', pos: '0', pit: '0', func: 'SFAL' },
    { id: '112', name: 'Int1', pos: '1561730', pit: '0', func: '' },
    { id: '113', name: 'Int2', pos: '3366780', pit: '0', func: '' },
    { id: '103', name: 'Pit In', pos: '-39220', pit: '1', func: 'I' },
    { id: '110', name: 'Pit Out', pos: '286080', pit: '1', func: 'SO' }
  ],
  section: [
    { id: 'a', name: 'Section 1', startloopid: '111', endloopid: '112' },
    { id: 'b', name: 'Section 2', startloopid: '112', endloopid: '113' },
    { id: 'c', name: 'Section 3', startloopid: '113', endloopid: '111' }
  ],
  enrollment: [
    { nr: '14', name: 'Kuster', first: 'Boudewijn', nat: 'NLD', team: 'JW Raceservice',
      man: 'Porsche 911 Cup', class: 'PRO', teammember: [{ nr: '1', name: 'Kuster', first: 'Boudewijn' }] },
    { nr: '8', name: 'Muller', first: 'Joep', nat: 'NLD', team: 'PG Motorsport',
      man: 'Porsche 911 Cup', class: 'R', teammember: [{ nr: '1', name: 'Muller', first: 'Joep' }] }
  ]
};
engTs.applyFrame({ handle: 'ts_session', payload: assenSession, ts: Date.now() });
let ts = engTs.snapshot();
check('ts session name group — session', ts.session.name === 'Porsche Carrera Cup Benelux — Qualifying');
// The window alone gives the session length — before any pass anchors the
// clock, so pre-start the feed already knows how long the session is.
check('ts window length known before any pass', ts.session.totalUs === 35 * 60e6 &&
  ts.session.remainUs === null);
const e14 = () => engTs.snapshot().entries.find(e => e.nr === '14');
const e8 = () => engTs.snapshot().entries.find(e => e.nr === '8');
check('ts enrollment mapped', e14().driver === 'Boudewijn Kuster' && e14().team === 'JW Raceservice' &&
  e14().cls === 'PRO' && e14().nat === 'NLD' && e14().car === 'Porsche 911 Cup');

const T0 = parseTsDateUs('01.08.2026 10:40:00') / 1000; // wire `ms` field
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: '1', nr: '14', lap: '4', pos: '1', cpos: '1', laptime: '1:38.500', inttime: '22.500', ms: String(T0), loopid: '111', dnr: '1', status: '' },
  { enr: '2', nr: '8', lap: '4', pos: '2', cpos: '1', laptime: '1:39.200', inttime: '23.000', ms: String(T0 + 2000), loopid: '111', dnr: '1', status: '' },
  { enr: '3', nr: '14', lap: '5', pos: '1', cpos: '1', inttime: '37.100', ms: String(T0 + 37100), loopid: '112', dnr: '1', status: '' },
  { enr: '4', nr: '14', lap: '5', pos: '1', cpos: '1', inttime: '41.000', ms: String(T0 + 78100), loopid: '113', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts replay stays silent', tsEv.length === 0);
check('ts pos/pic/laps/last', e14().pos === 1 && e14().pic === 1 && e14().laps === 5 &&
  e14().lastUs === 98500000);
check('ts sectors fill and clear like the web board', e14().s1 === 37100000 &&
  e14().s2 === 41000000 && e14().s3 == null);
check('ts best + in-lap', e14().bestUs === 98500000 && e14().bestLap === 4);
check('ts quali gap/diff on best times', e8().gap === 700000 && e8().diff === 700000 &&
  (e14().gap === '' || e14().gap == null));
check('ts ETA state anchors the lap start', e14().state === 'E' + String(T0 * 1000));
ts = engTs.snapshot();
check('ts session clock from the window', ts.session.totalUs === 35 * 60e6 &&
  Math.abs(ts.session.remainUs - (25 * 60e6 - 78.1e6)) < 5e6 && ts.session.flag === 6);

// a live S/F pass fires the lap event and rolls best → 2nd best
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: '5', nr: '14', lap: '6', pos: '1', cpos: '1', laptime: '1:37.690', inttime: '20.590', ms: String(T0 + 98690), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts live lap event', tsEv.some(e => e.type === 'lap' && e.nr === '14' && Math.abs(e.lapSec - 97.69) < 0.001));
check('ts best rolls to 2nd', e14().bestUs === 97690000 && e14().bestLap === 6 &&
  e14().best2Us === 98500000 && e14().best2Lap === 4);
check('ts s3 fills, s1 clears at the line', e14().s3 === 20590000 && e14().s1 == null);

// pit cycle via the pit-lane loop functions
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: '6', nr: '14', lap: '6', ms: String(T0 + 160000), loopid: '103', status: '' }
] }, ts: Date.now() });
check('ts pit in', e14().inPit === true && e14().pits === 1 &&
  tsEv.some(e => e.type === 'pitIn' && e.nr === '14'));
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: '7', nr: '14', lap: '6', ms: String(T0 + 220000), loopid: '110', status: '' }
] }, ts: Date.now() });
check('ts pit out + frozen pit time', e14().inPit === false && e14().state === 'SOutLap' &&
  e14().lpit === 'L' + String(60000 * 1000) &&
  tsEv.some(e => e.type === 'pitOut' && e.nr === '14'));

// race control cancels the best lap (mpass CANCELLED referencing the pass id)
engTs.applyFrame({ handle: 'ts_mpass', payload: { passes: [
  { enr: '5', nr: '14', lap: '', status: 'CANCELLED', ms: String(T0 + 230000), loopid: '111' }
] }, ts: Date.now() });
check('ts cancelled lap loses best', e14().bestUs === 98500000 && e14().bestLap === 4 &&
  e14().best2Us == null);

// a crossing after the session window = chequered flag for car and session
const TEND = parseTsDateUs('01.08.2026 11:05:30') / 1000;
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: '8', nr: '8', lap: '20', pos: '2', laptime: '1:39.000', ms: String(TEND), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
ts = engTs.snapshot();
check('ts finish inferred from the window', ts.session.flag === 5 &&
  e8().state === 'SFinish' && ts.session.remainUs === 0);

// race-control text: live messages surface, replayed history is dated + dropped
engTs.applyFrame({ handle: 'ts_smsg', payload: { id: 'x', text: 'YELLOW FLAG AT T1, T4',
  start: '01.08.2026 11:05:30', end: '01.08.2026 11:59:00', type: '1' }, ts: Date.now() });
ts = engTs.snapshot();
check('ts race control surfaced, local yellow keeps flag', ts.session.rc === 'YELLOW FLAG AT T1, T4' &&
  ts.session.flag === 5);
engTs.applyFrame({ handle: 'ts_smsg', payload: { id: 'y', text: 'RED FLAG',
  start: '01.08.2026 10:31:00', end: '01.08.2026 10:35:00', type: '1' }, ts: Date.now() });
check('ts stale replayed message ignored', engTs.snapshot().session.flag === 5);
// ...but both messages land in the history log, dated and in time order —
// the replayed RED FLAG started ~34.5 min before the live yellow.
const rcl = engTs.snapshot().rcLog;
check('ts rc log keeps dated history in order', rcl.length === 2 &&
  rcl[0].text === 'RED FLAG' && rcl[1].text === 'YELLOW FLAG AT T1, T4' &&
  Math.abs((rcl[1].ms - rcl[0].ms) - 34.5 * 60e3) < 5e3 &&
  Math.abs(rcl[1].ms - Date.now()) < 5e3);
engTs.applyFrame({ handle: 'ts_smsg', payload: { id: 'x', text: 'YELLOW FLAG AT T1, T4',
  start: '01.08.2026 11:05:30', end: '01.08.2026 11:59:00', type: '1' }, ts: Date.now() });
check('ts rc log dedupes the <all/> replay', engTs.snapshot().rcLog.length === 2);
// messages that merely MENTION a flag never drive it ("INFO - Results pending
// due to TL and FCY infringements" latched a phantom FCY after the finish at
// Assen), and after the chequered only a session change moves the flag anyway
engTs.applyFrame({ handle: 'ts_smsg', payload: { id: 'i1',
  text: 'INFO - Results pending due to TL and FCY infringements',
  start: '01.08.2026 11:05:35', end: '01.08.2026 11:59:00', type: '0' }, ts: Date.now() });
check('ts INFO mentioning FCY never drives the flag', engTs.snapshot().session.flag === 5);
engTs.applyFrame({ handle: 'ts_time', payload: '09:05:31', ts: Date.now() });
check('ts wall-clock keepalive cannot clobber the clock', engTs.serverTimeUs >= TEND * 1000);

// next session on the same connection: fresh board, race mode, race gaps
engTs.applyFrame({ handle: 'ts_session', payload: { ...assenSession, name: 'Race 1', laps: '18',
  start: '01.08.2026 12:00:00', end: '01.08.2026 12:40:00' }, ts: Date.now() });
ts = engTs.snapshot();
check('ts session change resets the board', ts.session.name.includes('Race 1') &&
  ts.entries.length === 2 && ts.entries.every(e => e.lastUs == null && e.pits == null));
check('ts session change event', tsEv.some(e => e.type === 'session' && e.name.includes('Race 1')));
check('ts session change clears the rc log', ts.rcLog.length === 0);
const R0 = parseTsDateUs('01.08.2026 12:20:00') / 1000;
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'r1', nr: '14', lap: '10', pos: '1', cpos: '1', laptime: '1:40.000', ms: String(R0), loopid: '111', dnr: '1', status: '' },
  { enr: 'r2', nr: '8', lap: '10', pos: '2', cpos: '1', laptime: '1:41.000', ms: String(R0 + 12300), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts race gap/diff at the line', e8().gap === 12300000 && e8().diff === 12300000 &&
  (e14().gap === '' || e14().gap == null));
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'r3', nr: '14', lap: '11', pos: '1', laptime: '1:40.000', ms: String(R0 + 100000), loopid: '111', dnr: '1', status: '' },
  { enr: 'r4', nr: '14', lap: '12', pos: '1', laptime: '1:40.000', ms: String(R0 + 200000), loopid: '111', dnr: '1', status: '' },
  { enr: 'r5', nr: '8', lap: '11', pos: '2', laptime: '2:00.000', ms: String(R0 + 220000), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts race gap in laps once lapped', e8().gap === '1 lap');
// flag-station transponders (nr "⚐-4") are not cars — the board hides them
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'z1', nr: '⚐-4', lap: '', ms: String(R0 + 300000), loopid: '112', status: '' }
] }, ts: Date.now() });
check('ts non-car transponders filtered', engTs.snapshot().entries.length === 2);

// Positions are recomputed from laps completed + crossing time, never taken
// from the stale per-pass pos field: a new car on 12 laps slots between the
// leader (12 laps, earlier crossing) and the lapped #8 (11 laps) even though
// the wire calls it 999 (unclassified) — and #8's wire pos still says 2.
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'r6', nr: '5', lap: '12', pos: '999', laptime: '1:39.000', ms: String(R0 + 210000), loopid: '111', status: '' }
] }, ts: Date.now() });
const e5 = () => engTs.snapshot().entries.find(e => e.nr === '5');
check('ts order recomputed, bogus wire pos ignored', e14().pos === 1 && e5().pos === 2 && e8().pos === 3);
check('ts pic recomputed per class', e14().pic === 1 && e8().pic === 1);

// ---- race-control messages NEVER drive the flag. The flag enum comes only
// from explicit flag data: the web board's h-frame `f` (URL connection or
// the flag check URL watch) — the direct TeamStream socket carries no flag
// element at all (verified in the full raw captures, Assen 2026-08-01/02).
// Text parsing kept producing wrong flags live: a phantom FCY from an INFO
// text, and a stuck SC when the SC pitted with no End/Green message ever
// posted (Interserie-F1 R2) — the board flag just flipped to green. So
// messages are banner + history log only.
engTs.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'p1', nr: '14', lap: '13', pos: '1', laptime: '1:40.000', ms: String(R0 + 230000), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
engTs.applyFrame({ handle: 'ts_smsg', payload: { id: 'f1', text: 'Full Course Yellow',
  start: '01.08.2026 12:24:00', end: '01.08.2026 12:24:00', type: '1' }, ts: Date.now() });
check('ts FCY message never drives the flag', engTs.snapshot().session.flag === 6);
engTs.applyFrame({ handle: 'ts_smsg', payload: { id: 'g1', text: 'Safety Car',
  start: '01.08.2026 12:24:30', end: '01.08.2026 12:26:00', type: '1' }, ts: Date.now() });
check('ts SC message never drives the flag', engTs.snapshot().session.flag === 6);
engTs.applyFrame({ handle: 'ts_smsg', payload: { id: 'g2', text: 'RED FLAG',
  start: '01.08.2026 12:24:40', end: '01.08.2026 12:38:00', type: '1' }, ts: Date.now() });
check('ts red flag message never drives the flag', engTs.snapshot().session.flag === 6);
check('ts flag messages still reach the banner and the log',
  engTs.snapshot().session.rc === 'RED FLAG' &&
  engTs.snapshot().rcLog.some(m => m.text === 'Safety Car'));

// ---- flag watch: the public web board's explicit flag is the authority ----
const wNow = Date.now();
check('watch flag overrides the inferred flag',
  applyWatchFlag({ flag: 7 }, { conn: 'connected', flag: 6, lastFrameMs: wNow }, wNow).flag === 6 &&
  applyWatchFlag({ flag: 7 }, { conn: 'connected', flag: 6, lastFrameMs: wNow }, wNow).flagSrc === 'board');
check('stale watch never overrides',
  applyWatchFlag({ flag: 7 }, { conn: 'connected', flag: 6, lastFrameMs: wNow - 300e3 }, wNow).flag === 7);
check('disconnected watch never overrides',
  applyWatchFlag({ flag: 7 }, { conn: 'retrying', flag: 6, lastFrameMs: wNow }, wNow).flag === 7);
check('pre-start board states say nothing about the track',
  applyWatchFlag({ flag: 6 }, { conn: 'connected', flag: 1, lastFrameMs: wNow }, wNow).flag === 6);
const svcW = createTimingService({ onLog: () => {} });
svcW._flagWatchTest({ handle: 'h_h', payload: { f: '7' } });
check('watch parses the board heat flag', svcW.flagWatch.flag === 7);
svcW._flagWatchTest({ handle: 'h_h', payload: { n: 'Race 1' } });
check('watch keeps the flag across heat frames without f', svcW.flagWatch.flag === 7 &&
  svcW.flagWatch.name === 'Race 1');

// gap formatting: engine numbers are µs (a 0.086 s gap must not become
// "+1433:20.0"), feed strings are seconds, lap counts pass through
check('gap format µs vs strings', fmtGapUs(86000) === '+0.086' && fmtGapUs(2822000) === '+2.8' &&
  fmtGapUs('2.822') === '+2.8' && fmtGapUs('2 laps') === '2 laps' && fmtGapUs(75.5e6) === '+1:15.5');
// a negative value is the vendor's "difference in laps", not a negative time
check('gap negative is laps down', fmtGapUs(-1) === '1 lap' && fmtGapUs(-3) === '3 laps' &&
  fmtGapUs('-2') === '2 laps' && fmtGapUs(0) === '—');

// ---- TeamStream: late session start (captured live at Assen, IoM CSB Q2) ----
// The <session> window is only the SCHEDULE and is never updated when a
// session runs late; the real clock start arrives as a "Green Flag - <group>
// - <name>" screen message. Joining mid-session, the green comes from the
// <all/> replay after passes have already walked the clock past the stale
// scheduled end — the wrongly inferred finish must roll back.
const lateSession = {
  ...assenSession,
  loop: [...assenSession.loop, { id: '104', name: 'Pit SF', pos: '0', pit: '1', func: 'FL' }]
};
const engLate = new TimingEngine({ onEvent: () => {}, onLog: () => {} });
engLate.applyFrame({ handle: 'ts_session', payload: lateSession, ts: Date.now() });
const L1 = parseTsDateUs('01.08.2026 11:07:00') / 1000; // wire `ms`, past the 11:05 sched end
engLate.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'l1', nr: '14', lap: '3', pos: '1', laptime: '1:38.000', ms: String(L1 - 300000), loopid: '111', dnr: '1', status: '' },
  { enr: 'l2', nr: '14', lap: '4', pos: '1', laptime: '1:38.100', ms: String(L1), loopid: '111', dnr: '1', status: '' },
  { enr: 'l3', nr: '8', lap: '3', pos: '2', laptime: '1:39.000', ms: String(L1 + 5000), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
let lateTs = engLate.snapshot();
check('ts stale schedule infers finish first', lateTs.session.flag === 5 &&
  lateTs.session.remainUs === 0 && lateTs.entries.some(e => e.state === 'SFinish'));
engLate.applyFrame({ handle: 'ts_smsg', payload: { id: 'g', type: '1',
  text: 'Green Flag - Porsche Carrera Cup Benelux - Qualifying',
  start: '01.08.2026 10:37:00', end: '01.08.2026 10:38:00' }, ts: Date.now() });
lateTs = engLate.snapshot();
check('ts green message re-anchors the clock', lateTs.session.flag === 6 &&
  engLate.tsSessStartUs === parseTsDateUs('01.08.2026 10:37:00') &&
  engLate.tsSessEndUs === parseTsDateUs('01.08.2026 11:12:00') &&
  lateTs.session.remainUs > 0 && lateTs.session.totalUs === 35 * 60e6);
check('ts finish rolled back on cars', lateTs.entries.every(e => e.state !== 'SFinish') &&
  lateTs.entries.find(e => e.nr === '14').state === 'E' + String(L1 * 1000));
// a restart green after a red must not re-arm the clock
engLate.applyFrame({ handle: 'ts_smsg', payload: { id: 'g2', type: '1',
  text: 'Green Flag - Porsche Carrera Cup Benelux - Qualifying',
  start: '01.08.2026 11:00:00', end: '01.08.2026 11:01:00' }, ts: Date.now() });
check('ts restart green keeps the first anchor', engLate.tsGreenUs === parseTsDateUs('01.08.2026 10:37:00'));
// flags branded for another session on the same stream must not drive ours
engLate.applyFrame({ handle: 'ts_smsg', payload: { id: 'f1', type: '1',
  text: 'Finish Flag - Interserie-F1 - Qualifying',
  start: '01.08.2026 11:08:00', end: '01.08.2026 11:59:00' }, ts: Date.now() });
check('ts other session finish ignored', engLate.snapshot().session.flag === 6);

// pit-lane laps never score a best: completed on the pit S/F loop (in-lap /
// drive-through) or begun at the pit exit (out-lap)
const e8L = () => engLate.snapshot().entries.find(e => e.nr === '8');
const e14L = () => engLate.snapshot().entries.find(e => e.nr === '14');
engLate.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'q1', nr: '8', lap: '3', ms: String(L1 + 80000), loopid: '103', status: '' },
  { enr: 'q2', nr: '8', lap: '4', pos: '2', laptime: '3:20.000', ms: String(L1 + 90000), loopid: '104', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts pit-lane lap keeps last but not best', e8L().lastUs === 200000000 &&
  e8L().bestUs === 99000000 && e8L().pits === 1);
engLate.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'q3', nr: '8', lap: '4', ms: String(L1 + 120000), loopid: '110', status: '' },
  { enr: 'q4', nr: '8', lap: '5', pos: '2', laptime: '1:45.000', ms: String(L1 + 200000), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts out-lap keeps last but not best', e8L().lastUs === 105000000 && e8L().bestUs === 99000000);
engLate.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'q5', nr: '8', lap: '6', pos: '2', laptime: '1:38.500', ms: String(L1 + 230000), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts first clean lap after the pit scores again', e8L().bestUs === 98500000);
// a drive-through read only deeper in the lane (no pit-entry crossing) flags
// the car in pit but is not a stop
engLate.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'q6', nr: '14', lap: '5', ms: String(L1 + 240000), loopid: '104', status: '' }
] }, ts: Date.now() });
check('ts drive-through is in pit but no stop', e14L().inPit === true && e14L().pits == null);
engLate.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'q7', nr: '14', lap: '5', ms: String(L1 + 250000), loopid: '110', status: '' }
] }, ts: Date.now() });
check('ts drive-through exit', e14L().inPit === false && e14L().pits == null);
// a real stop reads a lane loop first, then the entry loop — twice (the lane
// double-reads transponders): one stop, counted on the entry loop
engLate.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'q8', nr: '14', lap: '5', ms: String(L1 + 260000), loopid: '104', status: '' },
  { enr: 'q9', nr: '14', lap: '5', ms: String(L1 + 262000), loopid: '103', status: '' },
  { enr: 'q10', nr: '14', lap: '5', ms: String(L1 + 263000), loopid: '103', status: '' }
] }, ts: Date.now() });
check('ts entry loop counts the stop once', e14L().inPit === true && e14L().pits === 1);
// even our own finish flag message never drives the flag — finish comes
// from the session clock (or the board flag watch), not from text
engLate.applyFrame({ handle: 'ts_smsg', payload: { id: 'f2', type: '1',
  text: 'Finish Flag - Porsche Carrera Cup Benelux - Qualifying',
  start: '01.08.2026 11:12:30', end: '01.08.2026 11:59:00' }, ts: Date.now() });
check('ts finish flag message never drives the flag', engLate.snapshot().session.flag === 6);
engLate.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'q11', nr: '8', lap: '6', ms: String(L1 + 330000), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts finish still inferred from the session clock', engLate.snapshot().session.flag === 5);

// ---- TeamStream: race clock anchors on the start trigger (captured live at
// Assen, Interserie-F1 R1) ---- A race's "Green Flag" smsg can be posted when
// the cars are released to the grid, minutes before the start (16:15:01 vs an
// actual start of 16:27:30 against a 16:26–16:46 schedule); the official
// countdown followed the field's lap-0 S/F crossing (ran to 16:47:30 = start
// + scheduled duration). Races must ignore the green and anchor on the lap-0
// crossing; a crossing far before the schedule (grid approach at circuits
// where the grid sits beyond the line) must not arm the clock.
const engRace = new TimingEngine({ onEvent: () => {}, onLog: () => {} });
engRace.applyFrame({ handle: 'ts_session', payload: { ...assenSession,
  group: 'Interserie-F1', name: 'Race 1',
  start: '01.08.2026 16:26:00', end: '01.08.2026 16:46:00' }, ts: Date.now() });
engRace.applyFrame({ handle: 'ts_smsg', payload: { id: 'rg', type: '1',
  text: 'Green Flag - Interserie-F1 - Race 1',
  start: '01.08.2026 16:15:01', end: '01.08.2026 16:16:01' }, ts: Date.now() });
const G0 = parseTsDateUs('01.08.2026 16:19:00') / 1000; // > 5 min before sched
engRace.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 's0', nr: '1', lap: '0', pos: '1', ms: String(G0), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts race green does not anchor the clock',
  engRace.tsGreenUs === parseTsDateUs('01.08.2026 16:15:01') &&
  engRace.tsSessStartUs === parseTsDateUs('01.08.2026 16:26:00'));
check('ts early lap-0 crossing outside the leash ignored', engRace.tsStartTrigUs == null);
const S0 = parseTsDateUs('01.08.2026 16:27:30') / 1000;
engRace.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 's1', nr: '1', lap: '0', pos: '1', ms: String(S0), loopid: '111', dnr: '1', status: '' },
  { enr: 's2', nr: '21', lap: '0', pos: '2', ms: String(S0 + 2000), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts race clock anchors on the lap-0 crossing',
  engRace.tsStartTrigUs === parseTsDateUs('01.08.2026 16:27:30') &&
  engRace.tsSessStartUs === parseTsDateUs('01.08.2026 16:27:30') &&
  engRace.tsSessEndUs === parseTsDateUs('01.08.2026 16:47:30') &&
  engRace.snapshot().session.totalUs === 20 * 60e6);
check('ts later lap-0 crossings keep the first anchor',
  engRace.tsStartTrigUs === parseTsDateUs('01.08.2026 16:27:30'));

// ---- Timing Data Protocol v1.34 fields on the TeamStream elements ----
// <session> serializes the Heat record, so an export can carry Status and
// HeatType — and can carry them as attributes, which the XML decoder used to
// throw away. Child elements still win, and a leaf's text still beats its own
// attributes so <text lang="en">…</text> stays the string its consumers read.
const attrObj = xmlToObj(parseXmlFragment(
  '<session status="GREEN" type="R" name="attr"><name>Race 1</name>' +
  '<loop id="111" name="S/F" pos="0" pit="0" func="SFAL" allowfastest="1"/></session>')[0]);
check('xml attributes decoded', attrObj.status === 'GREEN' && attrObj.type === 'R');
check('xml child element outranks the attribute', attrObj.name === 'Race 1');
check('xml attribute-only leaf becomes an object', attrObj.loop.length === 1 &&
  attrObj.loop[0].id === '111' && attrObj.loop[0].allowfastest === '1');
const txtObj = xmlToObj(parseXmlFragment('<smsg id="9"><text lang="en">RED FLAG</text></smsg>')[0]);
check('xml leaf text still wins over its attributes', txtObj.text === 'RED FLAG' && txtObj.id === '9');

// Heat Status is the one flag source on this socket that is not an inference.
const engSt = new TimingEngine({ onEvent: () => {}, onLog: () => {} });
engSt.applyFrame({ handle: 'ts_session', payload: { ...assenSession, status: 'GREEN' }, ts: Date.now() });
check('ts explicit heat status sets the flag', engSt.snapshot().session.flag === 6);
engSt.applyFrame({ handle: 'ts_session', payload: { ...assenSession, status: 'RED' }, ts: Date.now() });
const SE = parseTsDateUs('01.08.2026 11:30:00') / 1000; // well past the 11:05 scheduled end
engSt.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'st1', nr: '14', lap: '9', pos: '1', laptime: '1:38.000', ms: String(SE), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts red status outranks the elapsed-window finish', engSt.snapshot().session.flag === 2);
engSt.applyFrame({ handle: 'ts_session', payload: { ...assenSession, status: 'CODE 60' }, ts: Date.now() });
check('ts code60 status normalised', engSt.snapshot().session.flag === 4);
engSt.applyFrame({ handle: 'ts_session', payload: { ...assenSession, status: 'WHATEVER' }, ts: Date.now() });
check('ts unrecognised status leaves the flag alone', engSt.snapshot().session.flag === 4);

// HeatType beats the session-name keyword test in both directions.
const engQ = new TimingEngine({ onEvent: () => {}, onLog: () => {} });
engQ.applyFrame({ handle: 'ts_session', payload: { ...assenSession, name: 'Final', type: 'Q' }, ts: Date.now() });
check('ts HeatType Q outranks a race-sounding name', engQ.tsRace === false);
const engR = new TimingEngine({ onEvent: () => {}, onLog: () => {} });
engR.applyFrame({ handle: 'ts_session', payload: { ...assenSession, name: 'Course 1', type: 'R' }, ts: Date.now() });
check('ts HeatType R rescues a name the keywords miss', engR.tsRace === true);

// Loop AllowFastest replaces the pit-lane guess for the loop a lap ENDED on —
// but never the out-lap test, which is about where the lap began.
const A0 = parseTsDateUs('01.08.2026 10:40:00') / 1000;
const engAF = new TimingEngine({ onEvent: () => {}, onLog: () => {} });
engAF.applyFrame({ handle: 'ts_session', payload: { ...assenSession, loop: [
  { id: '111', name: 'S/F', pos: '0', pit: '0', func: 'SFAL', allowfastest: '0' },
  { id: '103', name: 'Pit In', pos: '-39220', pit: '1', func: 'I' },
  { id: '110', name: 'Pit Out', pos: '286080', pit: '1', func: 'SO' }
] }, ts: Date.now() });
engAF.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'a1', nr: '14', lap: '4', pos: '1', laptime: '1:38.500', ms: String(A0), loopid: '111', dnr: '1', status: '' }
] }, ts: Date.now() });
const eAF = engAF.snapshot().entries.find(e => e.nr === '14');
check('ts AllowFastest=0 blocks the best on the S/F loop itself',
  eAF.lastUs === 98500000 && eAF.bestUs == null);
const engAF2 = new TimingEngine({ onEvent: () => {}, onLog: () => {} });
engAF2.applyFrame({ handle: 'ts_session', payload: { ...assenSession, loop: [
  ...assenSession.loop, { id: '104', name: 'Pit SF', pos: '0', pit: '1', func: 'FL', allowfastest: '1' }
] }, ts: Date.now() });
engAF2.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { enr: 'b1', nr: '14', lap: '4', pos: '1', laptime: '1:38.500', ms: String(A0), loopid: '104', dnr: '1', status: '' }
] }, ts: Date.now() });
check('ts AllowFastest=1 lets a pit-lane loop score after all',
  engAF2.snapshot().entries.find(e => e.nr === '14').bestUs === 98500000);

// Int32.MAX_VALUE is the vendor's other "no value" default (appendix 1) — as a
// best lap it would otherwise read as a perfectly plausible 35:47.483.
const engSent = new TimingEngine({ onEvent: () => {}, onLog: () => {} });
engSent.applyFrame({ handle: 'r_i', payload: { l: {
  h: [{ n: 'Position', c: 'Pos' }, { n: 'StartNumber', c: 'Nr' },
      { n: 'FastestRoundTime', c: 'Best' }, { n: 'LastRoundTime', c: 'Last' }],
  d: [['2147483647', '17', '2147483647', '105300000']]
} }, ts: Date.now() });
const sent = engSent.snapshot().entries[0];
check('int32 sentinel is an empty cell, not a 35:47 best lap',
  sent.bestUs == null && sent.pos == null && sent.lastUs === 105300000);

// Fields a real feed sends that we do not consume are reported once each, so a
// live session settles what a timekeeper actually exports.
const noteLogs = [];
const engNote = new TimingEngine({ onEvent: () => {}, onLog: m => noteLogs.push(m) });
const noted = { ...assenSession, weather: 'DRY', airtemp: '21' };
engNote.applyFrame({ handle: 'ts_session', payload: noted, ts: Date.now() });
engNote.applyFrame({ handle: 'ts_session', payload: noted, ts: Date.now() });
check('unused feed fields are reported once each',
  noteLogs.filter(m => m.includes('unused <session> field')).length === 2 &&
  noteLogs.some(m => m.includes('weather')) && noteLogs.some(m => m.includes('airtemp')));

// ---- replay recording + playback ----
// One session = one file: the recorder rotates on session change so a new
// session can never spill into the previous session's replay, and a saved
// file re-simulates through the service (seek / play / pause).
const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-replay-'));
const rec = createTimingRecorder({ dir: replayDir, onLog: () => {} });
rec.open('feed-A');
rec.session('Session A');
rec.frame({ ts: Date.now(), handle: 'ts_time', payload: '10:00:00' });
rec.frame({ ts: Date.now() + 500, handle: 'ts_time', payload: '10:00:30' });
rec.rotate();
rec.session('Session B');
rec.frame({ ts: Date.now() + 1000, handle: 'ts_time', payload: '10:01:00' });
rec.close();
const recFiles = listReplayFiles(replayDir);
check('recorder rotates per session', recFiles.length === 2);
const bySession = Object.fromEntries(recFiles.map(f => [f.session, f]));
check('recorder labels files with the session', !!bySession['Session A'] && !!bySession['Session B']);
check('no spilling between session files',
  readReplayFile(path.join(replayDir, bySession['Session A'].name)).frames.length === 2 &&
  readReplayFile(path.join(replayDir, bySession['Session B'].name)).frames.length === 1);

// hand-written session replay: open → board loads, seek → scrubs, no events leak
const rpEvents = [];
const rpSvc = createTimingService({ onEvent: e => rpEvents.push(e), onLog: () => {}, replayDir });
const rpFile = 'replay-20260801-110000.jsonl';
fs.writeFileSync(path.join(replayDir, rpFile), [
  JSON.stringify({ type: 'meta', v: 1, startedMs: 1000, src: 'getraceresults.com' }),
  JSON.stringify({ type: 'session', name: 'Replayed Quali' }),
  JSON.stringify([0, 'ts_session', assenSession]),
  JSON.stringify([1000, 'ts_pass', { passes: [
    { enr: 'p1', nr: '14', lap: '4', pos: '1', cpos: '1', laptime: '1:38.500', ms: String(T0), loopid: '111', dnr: '1', status: '' }
  ] }]),
  JSON.stringify([5000, 'ts_pass', { passes: [
    { enr: 'p2', nr: '14', lap: '5', pos: '1', cpos: '1', laptime: '1:37.900', ms: String(T0 + 98500), loopid: '111', dnr: '1', status: '' }
  ] }]),
  ''
].join('\n'));
const rpOpen = rpSvc.replayOpen(rpFile);
let rp = rpSvc.snapshot();
check('replay opens paused at 0', rpOpen.ok === true && rp.conn === 'replay' &&
  rp.replay.playing === false && rp.replay.posMs === 0 && rp.replay.durMs === 5000);
check('replay loads the board at t=0', rp.entries.length === 2 &&
  rp.entries.some(e => e.nr === '14' && e.driver === 'Boudewijn Kuster') &&
  rp.entries.every(e => e.lastUs == null));
rpSvc.replayControl({ op: 'seek', value: 5000 });
rp = rpSvc.snapshot();
check('replay seek applies frames', rp.entries.find(e => e.nr === '14').lastUs === 97900000 &&
  rp.entries.find(e => e.nr === '14').laps === 5);
rpSvc.replayControl({ op: 'seek', value: 1500 });
rp = rpSvc.snapshot();
check('replay rewind rebuilds the board', rp.entries.find(e => e.nr === '14').lastUs === 98500000 &&
  rp.replay.posMs === 1500);
check('replay never leaks lap/pit events into the race', rpEvents.length === 0);
rpSvc.replayControl({ op: 'speed', value: 60 });
rpSvc.replayControl({ op: 'play' });
await wait(700);
rp = rpSvc.snapshot();
check('replay fast-forward reaches the end and pauses', rp.replay.posMs === 5000 &&
  rp.replay.playing === false);
rpSvc.replayControl({ op: 'close' });
check('replay close returns the channel', rpSvc.snapshot().conn === 'off');
check('replay list scans labels', listReplayFiles(replayDir)
  .some(f => f.name === rpFile && f.session === 'Replayed Quali' && f.durMs === 5000));
try { fs.rmSync(replayDir, { recursive: true, force: true }); } catch {}

// Al Kamel standings through the same engine (ms → µs conversion)
const akEvents = [];
const eng3 = new TimingEngine({ onEvent: e => akEvents.push(e), onLog: () => {} });
eng3.applyFrame({ handle: 'ak_entry', payload: { entry: {
  17: { name: 'Alice', team: 'Team Alpha', vehicle: 'GT3 R', class: 'GT3' }
} }, ts: Date.now() });
eng3.applyFrame({ handle: 'ak_standings', payload: { standings: { standings: {
  a: { data: '1;17;RUNNING;1;30;2;180;1730000000000;TRACK;30;', lastLapTime: 105300, bestLapTime: 104100 }
} } }, ts: Date.now() });
const snap3 = eng3.snapshot();
check('ak entry + standings merged', snap3.entries.length === 1 && snap3.entries[0].pos === 1 &&
  snap3.entries[0].driver === 'Alice' && snap3.entries[0].laps === 30 && snap3.entries[0].pits === 2);
check('ak ms→µs', snap3.entries[0].lastUs === 105300000 && snap3.entries[0].bestUs === 104100000);
eng3.applyFrame({ handle: 'ak_standings', payload: { standings: { standings: {
  a: { data: '1;17;RUNNING;1;31;2;180;1730000200000;TRACK;31;', lastLapTime: 104800, bestLapTime: 104100 }
} } }, ts: Date.now() });
check('ak lap event on lastLapTime change', akEvents.some(e => e.type === 'lap' && e.nr === '17' &&
  Math.abs(e.lapSec - 104.8) < 0.001));

// Al Kamel race control: shape-tolerant extraction into the same log, and a
// re-sent (changed) document must not duplicate the messages.
eng3.applyFrame({ handle: 'ak_rc', payload: { raceControl: { messages: [
  { id: 'm1', text: 'CAR 17 DRIVE THROUGH PENALTY — TRACK LIMITS', timestamp: 1730000100 },
  { id: 'm2', text: 'SAFETY CAR DEPLOYED', timestamp: 1730000200 }
] } }, ts: Date.now() });
eng3.applyFrame({ handle: 'ak_rc', payload: { raceControl: { messages: [
  { id: 'm1', text: 'CAR 17 DRIVE THROUGH PENALTY — TRACK LIMITS', timestamp: 1730000100 },
  { id: 'm2', text: 'SAFETY CAR DEPLOYED', timestamp: 1730000200 }
] } }, ts: Date.now() });
const akRc = eng3.snapshot().rcLog;
check('ak race control logged once with epoch times', akRc.length === 2 &&
  akRc[0].text.includes('DRIVE THROUGH') && akRc[0].ms === 1730000100000 &&
  akRc[1].text === 'SAFETY CAR DEPLOYED' && akRc[1].ms === 1730000200000);

// ---- live timing: hub wiring (links, auto-lap, snapshot broadcast) ----
let timingMsg = null;
const ws4 = new WebSocket('ws://127.0.0.1:' + info.port);
ws4.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'state') state = m.state;
  if (m.type === 'timing') timingMsg = m.timing;
});
await new Promise(r => ws4.on('open', r));
const send4 = o => ws4.send(JSON.stringify(o));
await wait(200);
check('timing snapshot sent on connect', timingMsg && timingMsg.conn === 'off');
check('timing defaults migrated into state', state.timing && state.timing.mode === 'url');

send4({ type: 'timingLink', carId: '1', nr: '17' });
await wait(200);
check('timing link stored', state.timing.links['1'] === '17');

// auto lap is on by default: a lap for the linked number counts with no flag set
const lapsDefault = state.cars['1'].state.totalLaps;
info.timing.engine.onEvent({ type: 'lap', nr: '17', lapUs: 104000000, lapSec: 104.0 });
await wait(200);
check('auto-lap defaults on', state.cars['1'].state.totalLaps === lapsDefault + 1);

// only an explicit OFF gates the feed
send4({ type: 'timingAutoLap', carId: '1', on: false });
await wait(200);
check('auto-lap off stored', state.timing.autoLap['1'] === false);
const lapsOff = state.cars['1'].state.totalLaps;
info.timing.engine.onEvent({ type: 'lap', nr: '17', lapUs: 104100000, lapSec: 104.1 });
await wait(200);
check('auto-lap off gates the feed', state.cars['1'].state.totalLaps === lapsOff);

send4({ type: 'timingAutoLap', carId: '1', on: true });
await wait(200);
check('auto-lap flag stored', state.timing.autoLap['1'] === true);

// inject engine frames on the server's own timing service: linked car gets the lap
const lapsBefore = state.cars['1'].state.totalLaps;
info.timing.engine.onEvent({ type: 'lap', nr: '17', lapUs: 104300000, lapSec: 104.3 });
info.timing.engine.onEvent({ type: 'lap', nr: '99', lapUs: 104300000, lapSec: 104.3 }); // not linked
info.timing.engine.onEvent({ type: 'pitIn', nr: '17' });
await wait(200);
check('auto-lap feeds linked car only', state.cars['1'].state.totalLaps === lapsBefore + 1 &&
  state.cars['1'].state.lastLapSec === 104.3);
check('auto pit-in feeds linked car', state.cars['1'].state.inPit === true);
info.timing.engine.onEvent({ type: 'pitOut', nr: '17' });
await wait(200);
check('auto pit-out clears pit state', state.cars['1'].state.inPit === false);

// ---- the feed closes the stop, with the drive-through guard ----
// Pit entry stages the stop and pit exit applies it — but only when the car
// stood there long enough to have been serviced. The pit-lane time is faked by
// moving pitEnterMs back, since a test cannot wait a minute.
send({ type: 'update', carId: '1', patch: { nextStop: { fuelLiters: 80, tyres: true, status: 'box' } } });
await until(() => state.cars['1'].nextStop.status === 'box');
info.timing.engine.onEvent({ type: 'pitIn', nr: '17' });
await until(() => state.cars['1'].state.inPit === true);
send({ type: 'update', carId: '1', patch: { state: { pitEnterMs: Date.now() - 8000 } } });
await until(() => state.cars['1'].state.pitEnterMs < Date.now() - 7000);
// the pit-out above already logged a (very short) visit — wait for a new one
const prevVisitMs = state.cars['1'].state.lastPitVisit?.atMs || 0;
info.timing.engine.onEvent({ type: 'pitOut', nr: '17' });
await until(() => (state.cars['1'].state.lastPitVisit?.atMs || 0) > prevVisitMs);
{
  const car1 = state.cars['1'];
  check('a drive-through applies no service',
    car1.state.lastPitVisit.kind === 'driveThrough' && car1.state.lastPitVisit.applied === false);
  check('the stop stays armed after a drive-through', car1.nextStop.status === 'box');
  check('the visit reports what it saw', car1.state.lastPitVisit.pitSec >= 7 &&
    car1.state.lastPitVisit.minServiceSec >= 25);
}

const histBefore = state.cars['1'].stintHistory.length;
const fuelBefore = state.cars['1'].state.fuelLiters;
const setBefore = state.cars['1'].state.currentTyreSetId;
info.timing.engine.onEvent({ type: 'pitIn', nr: '17' });
await until(() => state.cars['1'].state.inPit === true);
send({ type: 'update', carId: '1', patch: { state: { pitEnterMs: Date.now() - 62000 } } });
await until(() => state.cars['1'].state.pitEnterMs < Date.now() - 60000);
info.timing.engine.onEvent({ type: 'pitOut', nr: '17' });
await until(() => state.cars['1'].stintHistory.length === histBefore + 1);
{
  const car1 = state.cars['1'];
  const h = car1.stintHistory[histBefore];
  check('the feed applies the stop on pit exit',
    Math.abs(car1.state.fuelLiters - 80) < 0.01 && car1.state.currentTyreSetId !== setBefore);
  check('the applied stop clears itself', car1.nextStop.status === 'draft');
  check('the stint sheet records what the stop really took',
    h.pitSec >= 60 && h.stationarySec > 0 && h.estStationarySec > 0);
  check('the visit waits to be answered, with no deadline on it',
    car1.state.lastPitVisit.applied === true && car1.state.lastPitVisit.undoUntilMs === undefined);
}
send({ type: 'undoStop', carId: '1' });
await until(() => state.cars['1'].stintHistory.length === histBefore);
{
  const car1 = state.cars['1'];
  check('undo puts fuel, rubber and the stop back',
    Math.abs(car1.state.fuelLiters - fuelBefore) < 0.01 &&
    car1.state.currentTyreSetId === setBefore &&
    car1.nextStop.status === 'box');
  check('undo clears the visit banner', car1.state.lastPitVisit === null);
}
send({ type: 'update', carId: '1', patch: { nextStop: emptyStop() } });
await until(() => state.cars['1'].nextStop.status === 'draft');

// The measured drive-through time is what separates a pass from a stop, so a
// visit that counted as service on a short pit lane stops counting on a long
// one. 40 s drive-through + 5 s margin = 45 s.
send({ type: 'event', patch: { driveThroughSec: 40 } });
await until(() => state.cars['1'].config.driveThroughSec === 40);
send({ type: 'update', carId: '1', patch: { nextStop: { fuelLiters: 70, status: 'box' } } });
await until(() => state.cars['1'].nextStop.status === 'box');
info.timing.engine.onEvent({ type: 'pitIn', nr: '17' });
await until(() => state.cars['1'].state.inPit === true);
send({ type: 'update', carId: '1', patch: { state: { pitEnterMs: Date.now() - 42000 } } });
await until(() => state.cars['1'].state.pitEnterMs < Date.now() - 41000);
const visitBeforeDt = state.cars['1'].state.lastPitVisit?.atMs || 0;
info.timing.engine.onEvent({ type: 'pitOut', nr: '17' });
await until(() => (state.cars['1'].state.lastPitVisit?.atMs || 0) > visitBeforeDt);
{
  const v = state.cars['1'].state.lastPitVisit;
  check('the drive-through setting sets the bar', v.minServiceSec === 45 && v.transitSec === 40);
  check('42 s is a pass when driving through takes 40 s',
    v.kind === 'driveThrough' && v.applied === false);
}

// ...and a stop that clears the bar waits for the engineer to sign it off
const histDt = state.cars['1'].stintHistory.length;
info.timing.engine.onEvent({ type: 'pitIn', nr: '17' });
await until(() => state.cars['1'].state.inPit === true);
send({ type: 'update', carId: '1', patch: { state: { pitEnterMs: Date.now() - 75000 } } });
await until(() => state.cars['1'].state.pitEnterMs < Date.now() - 74000);
info.timing.engine.onEvent({ type: 'pitOut', nr: '17' });
await until(() => state.cars['1'].stintHistory.length === histDt + 1);
check('an applied stop stays unconfirmed until the engineer answers',
  state.cars['1'].state.lastPitVisit.applied === true &&
  state.cars['1'].stintHistory[histDt].confirmed === undefined);
send({ type: 'confirmStop', carId: '1', by: 'T. Claes' });
await until(() => state.cars['1'].state.lastPitVisit === null);
check('the engineer signs off what happened',
  state.cars['1'].stintHistory[histDt].confirmed.by === 'T. Claes' &&
  state.cars['1'].stintHistory[histDt].confirmed.atMs > 0);
check('the signed-off stop keeps its measured time',
  state.cars['1'].stintHistory[histDt].pitSec >= 74);
// ---- a stop that did not go to plan is rewritten to what happened ----
// The plan said 90 L, new rubber, a driver change and front pads. The crew
// only splashed 55 L and changed nothing else — and two laps have been run
// since, which the correction must leave alone.
const carC = () => state.cars['1'];
const fuelPre = carC().state.fuelLiters;
const setPre = carC().state.currentTyreSetId;
const drvPre = carC().currentDriverId;
send({ type: 'update', carId: '1', patch: {
  nextStop: { fuelLiters: 90, tyres: true, driverChange: drvPre === 'd2' ? 'd3' : 'd2',
    padsFront: true, status: 'box' } } });
await until(() => carC().nextStop.status === 'box');
info.timing.engine.onEvent({ type: 'pitIn', nr: '17' });
await until(() => carC().state.inPit === true);
send({ type: 'update', carId: '1', patch: { state: { pitEnterMs: Date.now() - 80000 } } });
await until(() => carC().state.pitEnterMs < Date.now() - 79000);
const histFix = carC().stintHistory.length;
info.timing.engine.onEvent({ type: 'pitOut', nr: '17' });
await until(() => carC().stintHistory.length === histFix + 1);
const drvAfterPlan = carC().currentDriverId;
info.timing.engine.onEvent({ type: 'lap', nr: '17', lapUs: 104300000, lapSec: 104.3 });
info.timing.engine.onEvent({ type: 'lap', nr: '17', lapUs: 104300000, lapSec: 104.3 });
await until(() => carC().state.tyreLapsOnSet === 2);
check('the planned stop went in as planned',
  Math.abs(carC().state.fuelLiters - 90) < 0.2 && carC().state.currentTyreSetId !== setPre &&
  drvAfterPlan !== drvPre && carC().state.brakeUsedH.padsFront < 0.01);

send({ type: 'disputeStop', carId: '1' });
await until(() => carC().state.lastPitVisit?.disputed === true);
check('denying a stop changes nothing by itself',
  Math.abs(carC().state.fuelLiters - 90) < 0.2 && carC().state.currentTyreSetId !== setPre);

send({ type: 'correctStop', carId: '1', by: 'T. Claes',
  service: { fuelLiters: 55, tyres: false, tyreSetId: null, driverChange: null,
    padsFront: false, padsRear: false, discsFront: false, discsRear: false } });
await until(() => carC().state.lastPitVisit === null);
{
  const c1 = carC();
  const h = c1.stintHistory[histFix];
  check('the corrected fuel figure lands on the car',
    Math.abs(c1.state.fuelLiters - 55) < 0.2);
  check('the tyres that never came off are back on the car',
    c1.state.currentTyreSetId === setPre);
  check('the laps run since the stop are still on that set',
    c1.state.tyreLapsOnSet >= 2);
  check('the driver who never got in is not in the car', c1.currentDriverId === drvPre);
  check('brake hours that were never reset come back', c1.state.brakeUsedH.padsFront > 0);
  check('the sheet records what happened, signed',
    h.service.fuelLiters === 55 && h.service.tyres === false &&
    h.corrected === true && h.confirmed.by === 'T. Claes');
  check('the correction did not disturb the fuel already burnt',
    c1.state.fuelLiters < fuelPre + 60);
}

send({ type: 'event', patch: { driveThroughSec: 0 } });
send({ type: 'update', carId: '1', patch: { nextStop: emptyStop() } });
await until(() => state.cars['1'].config.driveThroughSec === 0);

// race clock sync: feed says 1 h elapsed of a 24 h session
info.timing.engine.applyFrame({ handle: 'h_i', payload: { n: 'Race', lt: 24 * 3600e6, r: 3600e6 }, ts: Date.now() });
send4({ type: 'timingSyncClock' });
await wait(200);
check('clock synced from feed', state.race.durationH === 24 &&
  Math.abs(Date.now() - state.race.startMs - 3600e3) < 5e3);

// follow mode: turning the lock on re-aligns immediately and stores the flag
info.timing.engine.applyFrame({ handle: 'h_h', payload: { r: 2 * 3600e6 }, ts: Date.now() });
send4({ type: 'timingFollowClock', on: true });
await wait(200);
check('follow lock stored + aligned', state.timing.followClock === true &&
  Math.abs(Date.now() - state.race.startMs - 2 * 3600e3) < 5e3);
send4({ type: 'timingFollowClock', on: false });
await wait(150);
check('follow lock released', state.timing.followClock === false);

// A TeamStream session window with no passes yet (pre-start): the length is
// known even though remaining is not, and a sync adopts it — the configured
// duration is only a guess once the feed shows the real session.
info.timing.engine.reset();
info.timing.engine.applyFrame({ handle: 'ts_session', payload: {
  name: 'Race 1', start: '01.08.2026 12:00:00', end: '01.08.2026 12:30:00'
}, ts: Date.now() });
check('ts pre-start length on the service engine', info.timing.engine.totalUs() === 30 * 60e6 &&
  info.timing.engine.remainingUs() === null);
send4({ type: 'timingSyncClock' });
await wait(200);
check('feed session length adopted without a clock', state.race.durationH === 0.5);
send4({ type: 'race', patch: { durationH: 24 } });
await wait(150);

// ---- feed auto-start: the session going live starts the race clock ----
send4({ type: 'resetRace' });
await wait(200);
check('auto-start baseline: clock cleared', state.race.startMs === null);
// The 1 s follow tick only acts on a connected feed — impersonate one.
const snapOrig = info.timing.snapshot;
info.timing.snapshot = () => ({ ...snapOrig.call(info.timing), conn: 'connected' });
info.timing.engine.reset();
info.timing.engine.applyFrame({ handle: 'ts_session', payload: {
  name: 'Race 1', start: '01.08.2026 12:00:00', end: '01.08.2026 12:30:00'
}, ts: Date.now() });
// a pit-lane crossing 5 min before the window opens (driving to the grid)
// anchors the official clock but must NOT start the race
info.timing.engine.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { nr: '14', lap: '0', ms: String(parseTsDateUs('01.08.2026 11:55:00') / 1000), loopid: 'x', status: '' }
] }, ts: Date.now() });
await wait(1300);
check('grid crossings do not start the race', state.race.startMs === null);
check('duration adopted while waiting for the start', state.race.durationH === 0.5);
// a crossing 90 s into the window: the session is live — the clock starts
info.timing.engine.applyFrame({ handle: 'ts_pass', payload: { passes: [
  { nr: '14', lap: '1', pos: '1', laptime: '1:30.000', ms: String(parseTsDateUs('01.08.2026 12:01:30') / 1000), loopid: 'x', status: '' }
] }, ts: Date.now() });
await wait(1300);
check('race auto-starts when the session goes live', state.race.startMs != null &&
  Math.abs(Date.now() - state.race.startMs - 90e3) < 5e3);
info.timing.snapshot = snapOrig;
info.timing.engine.reset();
send4({ type: 'race', patch: { durationH: 24 } });
await wait(150);

// ---- starting fuel / starting driver ----

// Back to a pre-start state so the start settings are in their normal context.
send({ type: 'resetRace' });
await wait(200);
check('reset clears the start time', state.race.startMs === null);
check('reset fills the tank by default', state.cars['2'].state.fuelLiters === state.cars['2'].config.tankLiters);

// Pre-start, the gauge follows the start-fuel setting straight away.
send({ type: 'update', carId: '2', patch: { config: { startFuelL: 62 } } });
await wait(200);
check('start fuel stored', state.cars['2'].config.startFuelL === 62);
check('pre-start tank follows start fuel', state.cars['2'].state.fuelLiters === 62);

// A part-tank start survives a reset, unlike the old hardcoded full tank.
send({ type: 'resetRace' });
await wait(200);
check('reset restores the start fuel', state.cars['2'].state.fuelLiters === 62);
check('reset still fills untouched cars', state.cars['3'].state.fuelLiters === state.cars['3'].config.tankLiters);

// Start fuel is capped at the tank size.
send({ type: 'update', carId: '2', patch: { config: { startFuelL: 999 } } });
await wait(200);
check('start fuel capped at tank size', state.cars['2'].state.fuelLiters === state.cars['2'].config.tankLiters);

// 0 means "full tank".
send({ type: 'update', carId: '2', patch: { config: { startFuelL: 45 } } });
await wait(150);
send({ type: 'update', carId: '2', patch: { config: { startFuelL: 0 } } });
await wait(200);
check('start fuel 0 means a full tank', state.cars['2'].state.fuelLiters === state.cars['2'].config.tankLiters);

// Starting driver: selectable before the start, and the green flag seeds the
// first stint's seat time onto that driver.
send({ type: 'update', carId: '2', patch: { currentDriverId: 'd3' } });
await wait(200);
check('starting driver stored', state.cars['2'].currentDriverId === 'd3');

send({ type: 'update', carId: '2', patch: { config: { startFuelL: 70 } } });
await wait(150);
send({ type: 'startRace' });
await wait(200);
check('race start uses the configured start fuel', state.cars['2'].state.fuelLiters === 70);
check('first stint anchored on the start load', state.cars['2'].state.stintFuelStartL === 70);
check('starting driver drives the first stint', state.cars['2'].currentDriverId === 'd3');

// A real fuel reading still wins over the start setting once running.
send({ type: 'update', carId: '2', patch: { state: { fuelLiters: 51 } } });
await wait(200);
check('fuel correction overrides start fuel mid-race', state.cars['2'].state.fuelLiters === 51);
// Once the clock runs the tank is a live quantity: a start-fuel edit no longer
// touches it (the crew's SET reading is the only thing that may).
send({ type: 'update', carId: '2', patch: { config: { startFuelL: 80 } } });
await wait(200);
check('start fuel leaves a running car\'s tank alone', state.cars['2'].state.fuelLiters === 51);

// ---- named tyre sets + stint sheet + learning (fresh scenario after the reset above) ----
// The race is running again (startRace above); car 1 is on fresh rubber with
// zero laps. Driver in car 1 is still d2 from the pre-reset stop.
check('reset returns every car to fresh rubber',
  state.cars['1'].tyreSets.length === 12 && state.cars['1'].config.tyreSets === 12 &&
  state.cars['1'].state.currentTyreSetId === 't1' && state.cars['1'].state.tyreSetsUsed === 1 &&
  state.cars['1'].tyreSets.every(t => t.laps === 0));
check('stop plan defaults to no explicit set', state.cars['1'].nextStop.tyreSetId === null);
check('reset clears the learning slate', Object.keys(state.cars['1'].learn.byDriver).length === 0);

// three timed green laps: 130 is an out-lap and must not drag any average
send({ type: 'lap', carId: '1', lapSec: 100 });
send({ type: 'lap', carId: '1', lapSec: 101 });
send({ type: 'lap', carId: '1', lapSec: 130 });
await wait(200);
check('stint sheet collects lap times',
  state.cars['1'].state.stintLapSec.join() === '100,101,130');

// stop A: refuel to 60, tyres (auto -> first fresh set), driver d2 -> d3
send({ type: 'update', carId: '1', patch: { nextStop: { fuelLiters: 60, tyres: true, driverChange: 'd3', status: 'sent' } } });
await wait(150);
send({ type: 'applyStop', carId: '1' });
await wait(200);
{
  const car1 = state.cars['1'];
  const h0 = car1.stintHistory[0];
  check('auto tyre choice fits the next fresh set', car1.state.currentTyreSetId === 't2' &&
    car1.state.tyreLapsOnSet === 0 && car1.state.tyreSetsUsed === 2);
  check('outgoing set wear recorded', car1.tyreSets.find(t => t.id === 't1').laps === 3);
  check('history carries stint stats', h0.laps === 3 && h0.bestSec === 100 &&
    h0.avgSec != null && h0.avgSec < 102 && h0.tyreSetId === 't1');
  check('history carries the fuel window', h0.fuelStartL === car1.config.tankLiters && h0.fuelUsedL === 0);
  check('stint lap sheet resets after the stop', car1.state.stintLapSec.length === 0);
}

// d3 turns three clean laps, then a real fuel reading closes the span:
// 60 L (trusted refuel) -> 50 L over 3 laps = 3.33 L/lap learned.
for (let i = 0; i < 3; i++) send({ type: 'lap', carId: '1', lapSec: 104 });
await wait(200);
send({ type: 'update', carId: '1', patch: { state: { fuelLiters: 50 } } });
await wait(200);
{
  const burn = learnedOf(state.cars['1'].learn, 'd3', 'dry');
  check('consumption learned between fuel readings',
    burn.burnLaps === 3 && burn.burnLPerLap === 3.33);
  const paceD3 = learnedOf(state.cars['1'].learn, 'd3', 'dry');
  const paceD2 = learnedOf(state.cars['1'].learn, 'd2', 'dry');
  check('pace learned per driver, outliers dropped',
    paceD3.laps === 3 && paceD3.avgSec === 104 &&
    paceD2.laps === 2 && paceD2.avgSec === 100.5);
}

// stop B: explicitly chosen set t5
send({ type: 'update', carId: '1', patch: { nextStop: { tyres: true, tyreSetId: 't5', status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '1' });
await wait(200);
{
  const car1 = state.cars['1'];
  const h1 = car1.stintHistory[1];
  check('explicitly chosen set fitted', car1.state.currentTyreSetId === 't5' &&
    car1.state.tyreLapsOnSet === 0 && car1.state.tyreSetsUsed === 3);
  check('no-refuel stop keeps the corrected level', car1.state.fuelLiters === 50);
  check('stint fuel actuals recorded', h1.fuelStartL === 60 && h1.fuelUsedL === 10 &&
    h1.laps === 3 && h1.bestSec === 104);
}

// stop C: refit the used t1 — it starts pre-worn with its recorded laps
send({ type: 'update', carId: '1', patch: { nextStop: { tyres: true, tyreSetId: 't1', status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '1' });
await wait(200);
check('refitted used set starts pre-worn', state.cars['1'].state.currentTyreSetId === 't1' &&
  state.cars['1'].state.tyreLapsOnSet === 3);

// editing the legacy count reconciles the named list (unused sets trimmed)
send({ type: 'update', carId: '2', patch: { config: { tyreSets: 6 } } });
await wait(150);
check('tyre count edit reconciles the set list',
  state.cars['2'].tyreSets.length === 6 && state.cars['2'].config.tyreSets === 6);

// ---- tyre mileage, life in km, and scrapping ----
// Mileage rides on the set itself (laps x track length) and is split by how it
// was driven, so at the flag a set's green and yellow kilometres are both known.
send({ type: 'event', patch: { trackKm: 4 } });
send({ type: 'update', carId: '3', patch: { config: { tyreLifeKm: 300 } } });
await until(() => state.cars['3'].config.trackKm === 4 && state.cars['3'].config.tyreLifeKm === 300);
{
  const car3 = state.cars['3'];
  check('tyre life in km becomes laps over the track length',
    carCalcs(car3, state.race, Date.now()).tyreLifeLaps === 75);
}
for (let i = 0; i < 3; i++) send({ type: 'lap', carId: '3', lapSec: 104 });
await until(() => state.cars['3'].state.tyreLapsOnSet === 3);
{
  const set = state.cars['3'].tyreSets.find(t => t.id === state.cars['3'].state.currentTyreSetId);
  check('green laps bank mileage on the fitted set', set.km === 12 && set.kmFcy === 0);
}
send({ type: 'fcy', mode: 'fcy' });
await until(() => raceCondition(state.race).pace === 'fcy');
send({ type: 'lap', carId: '3', lapSec: 180 });
await until(() => state.cars['3'].state.tyreLapsOnSet === 4);
{
  const set = state.cars['3'].tyreSets.find(t => t.id === state.cars['3'].state.currentTyreSetId);
  check('neutralised laps are banked separately', set.km === 16 && set.kmFcy === 4);
  const c3 = carCalcs(state.cars['3'], state.race, Date.now());
  check('carCalcs reports the mileage split', c3.tyreMileage.km === 16 &&
    c3.tyreMileage.kmGreen === 12 && c3.tyreMileage.kmFcy === 4 && c3.tyreKmRemaining === 284);
}
send({ type: 'undoLap', carId: '3' });
await until(() => state.cars['3'].state.tyreLapsOnSet === 3);
{
  const set = state.cars['3'].tyreSets.find(t => t.id === state.cars['3'].state.currentTyreSetId);
  check('undo lap takes the mileage back too', set.km === 12 && set.kmFcy === 0);
}
send({ type: 'fcy', mode: 'green' });
await until(() => raceCondition(state.race).pace === null);

// a stop asks what happens to the set that came off, with its mileage
send({ type: 'update', carId: '3', patch: { nextStop: { tyres: true, status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '3' });
await until(() => !!state.cars['3'].state.pendingSetDecision);
{
  const pend = state.cars['3'].state.pendingSetDecision;
  check('the set that came off asks to be kept or scrapped',
    pend.setId === 't1' && pend.laps === 3 && pend.km === 12 && pend.kmFcy === 0);
  check('a fresh set is on the car', state.cars['3'].state.currentTyreSetId === 't2');
}
send({ type: 'tyreSetDecision', carId: '3', setId: 't1', scrapped: true, reason: 'flat spot' });
await until(() => state.cars['3'].tyreSets[0].scrapped);
{
  const car3 = state.cars['3'];
  check('scrapping records the reason and clears the question',
    car3.tyreSets[0].scrapReason === 'flat spot' && car3.state.pendingSetDecision === null);
  check('a scrapped set keeps its banked mileage', car3.tyreSets[0].km === 12);
}
// the rubber on the car cannot be binned — it has to come off first
send({ type: 'tyreSetDecision', carId: '3', setId: 't2', scrapped: true, reason: 'damage' });
await wait(150);
check('the set on the car cannot be scrapped',
  state.cars['3'].tyreSets.find(t => t.id === 't2').scrapped === false);

// a scrapped set is out of the pool: not pickable, and never chosen by the app
send({ type: 'update', carId: '3', patch: { nextStop: { tyres: true, tyreSetId: 't1', status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '3' });
await until(() => state.cars['3'].state.currentTyreSetId !== 't2');
check('a stop never fits a scrapped set',
  state.cars['3'].state.currentTyreSetId === 't3');
send({ type: 'tyreSetDecision', carId: '3', setId: 't1', scrapped: false });
await until(() => !state.cars['3'].tyreSets[0].scrapped);
check('a scrapped set can be restored to the pool',
  state.cars['3'].tyreSets[0].scrapped === false &&
  state.cars['3'].tyreSets[0].scrapReason === null &&
  state.cars['3'].tyreSets[0].km === 12);
send({ type: 'tyreSetDecision', carId: '3', setId: 't2', scrapped: false });
await wait(100);

// ---- numbered brake sets: one pool per component group ----
// Front discs are a numbered pair, rear discs another, and so are the front and
// rear pads. Each pool works like the tyre sets: the part that comes off banks
// its hours, the chosen number goes on, and refitting a used one starts it worn.
{
  const car2 = state.cars['2'];
  check('every component group has its own numbered rack',
    car2.brakeSets.padsFront.length === 4 && car2.brakeSets.discsFront.length === 3 &&
    car2.brakeSets.padsFront[0].name === 'PF1' && car2.brakeSets.discsRear[0].name === 'DR1');
  check('the car starts on the first set of each',
    car2.state.currentBrakeSetId.padsFront === 'pf1' &&
    car2.state.currentBrakeSetId.discsRear === 'dr1');
  check('the fitted set is the only one marked used',
    car2.brakeSets.padsFront[0].used === true && car2.brakeSets.padsFront[1].used === false);
}

// hours have to be on the parts before a change is worth checking
send({ type: 'update', carId: '2', patch: { state: { brakeUsedH: { padsFront: 6, discsFront: 9 } } } });
await wait(150);
// a stop changing the front pads only: auto choice takes the next unused set
send({ type: 'update', carId: '2', patch: { nextStop: { padsFront: true, status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '2' });
await until(() => state.cars['2'].state.currentBrakeSetId.padsFront === 'pf2');
{
  const car2 = state.cars['2'];
  check('the outgoing set banks the hours it ran',
    car2.brakeSets.padsFront.find(t => t.id === 'pf1').hours >= 6);
  check('the fitted set starts at zero and is marked used',
    car2.state.brakeUsedH.padsFront === 0 &&
    car2.brakeSets.padsFront.find(t => t.id === 'pf2').used === true);
  check('a group that was not changed keeps its part and its hours',
    car2.state.currentBrakeSetId.discsFront === 'df1' && car2.state.brakeUsedH.discsFront >= 9);
  check('the stint sheet records the parts that ran',
    car2.stintHistory[car2.stintHistory.length - 1].brakeSetIds.padsFront === 'pf1');
}

// an explicitly chosen number, then refitting a used set: it starts pre-worn
send({ type: 'update', carId: '2', patch: { nextStop: { padsFront: true, brakeSetIds: { padsFront: 'pf4' }, status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '2' });
await until(() => state.cars['2'].state.currentBrakeSetId.padsFront === 'pf4');
check('the chosen number is the one fitted',
  state.cars['2'].state.currentBrakeSetId.padsFront === 'pf4');
send({ type: 'update', carId: '2', patch: { nextStop: { padsFront: true, brakeSetIds: { padsFront: 'pf1' }, status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '2' });
await until(() => state.cars['2'].state.currentBrakeSetId.padsFront === 'pf1');
check('a refitted used set starts pre-worn',
  state.cars['2'].state.brakeUsedH.padsFront >= 6);

// scrapping: out of the rack for good, never chosen by the app, restorable
send({ type: 'brakeSetDecision', carId: '2', comp: 'padsFront', setId: 'pf2', scrapped: true, reason: 'cracked' });
await until(() => state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').scrapped);
check('a scrapped set records why',
  state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').scrapReason === 'cracked');
send({ type: 'brakeSetDecision', carId: '2', comp: 'padsFront', setId: 'pf1', scrapped: true, reason: 'damage' });
await wait(150);
check('the part on the car cannot be scrapped',
  state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf1').scrapped === false);
send({ type: 'update', carId: '2', patch: { nextStop: { padsFront: true, status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '2' });
await until(() => state.cars['2'].state.currentBrakeSetId.padsFront !== 'pf1');
check('a stop never fits a scrapped set',
  state.cars['2'].state.currentBrakeSetId.padsFront === 'pf3');
send({ type: 'brakeSetDecision', carId: '2', comp: 'padsFront', setId: 'pf2', scrapped: false });
await until(() => !state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').scrapped);
check('a scrapped set can be restored with its hours intact',
  state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').scrapReason === null);

// editing the count reconciles the rack (unused sets trimmed from the end)
send({ type: 'update', carId: '4', patch: { config: { brakeSets: { discsRear: 5 } } } });
await until(() => state.cars['4'].brakeSets.discsRear.length === 5);
check('growing the count appends fresh numbered sets',
  state.cars['4'].brakeSets.discsRear[4].name === 'DR5' &&
  state.cars['4'].config.brakeSets.discsRear === 5);
send({ type: 'update', carId: '4', patch: { config: { brakeSets: { discsRear: 2 } } } });
await until(() => state.cars['4'].brakeSets.discsRear.length === 2);
check('shrinking the count trims only never-used sets',
  state.cars['4'].brakeSets.discsRear.length === 2 &&
  state.cars['4'].state.currentBrakeSetId.discsRear === 'dr1');

// ---- the app's own stop plan: three situations, per-line pins, approval ----
{
  const car4 = state.cars['4'];
  const plans = recommendedStops(car4, state.race, Date.now());
  check('a plan for each situation', !!plans.green && !!plans.fcy && !!plans.sc);
  check('the live situation is named', ['green', 'fcy', 'sc'].includes(plans.live));
  check('only the safety-car plan asks about the pit lane',
    !!plans.sc.ask && !plans.green.ask && !plans.fcy.ask);
  check('the app fills every line of the stop',
    plans.green.fuel.mode !== undefined && typeof plans.green.tyres.change === 'boolean' &&
    typeof plans.green.driver.change === 'boolean' && Array.isArray(plans.green.brakes));
  check('the plan carries the words, not just the numbers',
    typeof plans.green.head === 'string' && plans.green.head.length > 0 &&
    typeof plans.green.sub === 'string');
  check('the server keeps the plan for screens that are not connected',
    car4.autoStop && ['green', 'fcy', 'sc'].every(k => !!car4.autoStop[k]));
}
send({ type: 'pinStop', carId: '4', field: 'tyres', value: 'keep' });
await until(() => state.cars['4'].nextStop.pinned.tyres === 'keep');
{
  const car4 = state.cars['4'];
  const plans = recommendedStops(car4, state.race, Date.now());
  const r = resolveStop(car4, plans.green);
  check('a pinned line is held where the engineer put it', r.tyres === false);
  check('the lines around it keep following the app', r.fuelMode === plans.green.fuel.mode);
}
send({ type: 'approveStop', carId: '4', by: 'T. Claes' });
await until(() => !!state.cars['4'].nextStop.approved);
{
  const stop = state.cars['4'].nextStop;
  check('approving records who and when',
    stop.approved.by === 'T. Claes' && stop.approved.atMs > 0 && stop.approved.stale === false);
  check('approving freezes the plan into the stop itself',
    stop.tyres === false && stop.fuelLiters > 0 && stop.fuelMode != null);
}
send({ type: 'pinStop', carId: '4', field: 'driver', value: 'd3' });
await until(() => state.cars['4'].nextStop.approved?.stale === true);
check('a plan that moves after approval clears the tick',
  state.cars['4'].nextStop.approved.stale === true);

// a stop nobody has filled in is sent as the app planned it
send({ type: 'update', carId: '4', patch: { nextStop: emptyStop() } });
await until(() => state.cars['4'].nextStop.status === 'draft' && !state.cars['4'].nextStop.fuelLiters);
send({ type: 'update', carId: '4', patch: { nextStop: { status: 'sent' } } });
await until(() => state.cars['4'].nextStop.status === 'sent');
check('sending an untouched stop fills it from the app plan',
  state.cars['4'].nextStop.fuelLiters > 0);
send({ type: 'update', carId: '4', patch: { nextStop: emptyStop() } });
await wait(100);

// ---- drive-time regulations ----
send({ type: 'event', patch: { reg6hMin: 300, regTotalMin: 480, regRestMin: 30 } });
await wait(150);
check('regulations mirrored to every car', Object.values(state.cars).every(c =>
  c.config.reg6hMin === 300 && c.config.regTotalMin === 480 && c.config.regRestMin === 30));
{
  const cReg = carCalcs(state.cars['1'], state.race, Date.now());
  check('drive limit joins the pit limits', cReg.reg.enabled === true &&
    cReg.limits.some(l => l.key === 'reg'));
  const dts = driveTimeStats(state.cars['1'], state.race, Date.now());
  check('driver in the car counts as driving',
    dts.byDriver['d3'].driving === true && dts.byDriver['d3'].windowMs > 0);
  check('recently-relieved driver is resting',
    dts.byDriver['d2'].resting === true && dts.byDriver['d2'].eligible === false);
  check('never-driven driver is eligible', dts.byDriver['d4'].eligible === true);
  check('regs off means no reg limit', (() => {
    const bare = JSON.parse(JSON.stringify(state.cars['1']));
    bare.config.reg6hMin = 0; bare.config.regTotalMin = 0; bare.config.regRestMin = 0;
    const c = carCalcs(bare, state.race, Date.now());
    return c.reg.enabled === false && !c.limits.some(l => l.key === 'reg');
  })());
}

// ---- pit congestion ----
{
  const cg = pitCongestion(Object.values(state.cars), state.race, Date.now());
  check('congestion projects stops for all running cars',
    cg.perCar.length === 4 && cg.perCar.every(p => p.stops.length > 0));
  // cars 2-4 are identical and started together, so they must clash
  check('identical cars clash in the pit window', cg.conflicts.length >= 1);
}

// ---- replan from now + plan vs actual ----
{
  const nHist = state.cars['1'].stintHistory.length;
  const rp = replanFromNow(state.cars['1'], state.race, Date.now());
  check('replan keeps driven stints as actual', rp.replanned === true &&
    rp.stints.filter(s => s.actual).length === nHist && rp.stints.some(s => s.current));
  check('replan covers the rest of the race',
    rp.stints[rp.stints.length - 1].toMs >= state.race.durationH * 3600e3 - 1);

  send({ type: 'update', carId: '1', patch: { plan: generatePlan(state.cars['1'], state.race, Date.now()) } });
  await wait(200);
  const pva = planVsActual(state.cars['1'], state.race, Date.now());
  check('plan vs actual matches history by index', pva && pva.completed === nHist &&
    pva.rows[0].status === 'done' &&
    pva.rows[0].actualLaps === state.cars['1'].stintHistory[0].laps &&
    typeof pva.rows[0].deltaEndMs === 'number');
  check('plan vs actual marks the running stint', pva.rows[nHist]?.status === 'current');
}

check('stintStats filters outliers', (() => {
  const st = stintStats([100, 101, 130, 99]);
  return st.bestSec === 99 && st.avgSec === 100 && st.n === 4;
})());

// ---- pit arrival estimate (pitEta) ----
// 4 km track, 100 s green lap (40 m/s), FCY 80 km/h (22.22 m/s), the last
// crossing is the S/F line (lap-clock source) — all figures are exact.
{
  const now = Date.now();
  const nowUs = 1e12;
  const petCar = defaultCar('9', '9');
  petCar.config.trackKm = 4.0;
  petCar.config.avgLapSec.dry = 100;
  petCar.config.fcySpeedKmh = 80;
  petCar.config.pitLaneKm = 0.4;
  petCar.config.pitSpeedKmh = 60;
  const green = { durationH: 24, startMs: now - 3600e3, fcy: { mode: 'auto', active: false, startMs: null, flag: 6 } };
  const entryAt = ageSec => ({ nr: '9', state: 'E' + (nowUs - ageSec * 1e6), inPit: false });
  const near = (a, b, eps = 0.6) => Math.abs(a - b) <= eps;

  // Green: 60 s since S/F at 40 m/s = 2.4 km around → 1.6 km to the line = 40 s.
  const g = pitEta(petCar, green, { serverNowUs: nowUs }, entryAt(60), now, now);
  check('pitEta green: dead-reckons at green pace', g && g.source === 'lapclock' &&
    near(g.etaEntrySec, 40) && near(g.toBoxSec, 12) && near(g.etaBoxSec, 52) && !g.stale && !g.neutral);

  // FCY started 30 s ago, crossing 60 s ago: 30 s green (1.2 km) + 30 s at
  // 80 km/h (666.7 m) = 1.867 km around → 2.133 km left at 22.22 m/s = 96 s.
  const fcyRace = { ...green, fcy: { mode: 'auto', active: true, startMs: now - 30e3, flag: 7 } };
  const f = pitEta(petCar, fcyRace, { serverNowUs: nowUs }, entryAt(60), now, now);
  check('pitEta FCY: green pace to the flag, FCY pace after', f && f.neutral &&
    near(f.etaEntrySec, 96) && near(f.paceKmh, 80, 0.1));

  // Tracker source: crossing 3.5 km from S/F 10 s ago at green pace → 3.9 km;
  // pit entry loop 40 m before S/F → 60 m to go.
  const trkTiming = {
    serverNowUs: nowUs,
    tracker: {
      lenMm: 4e6,
      loops: [[-40000, 1, 0], [300000, 1, 0], [1000000, 0, 0]],
      cars: { 9: { fromMm: 3.5e6, toMm: 3.7e6, seg: 5, speedMmS: 40000, inPit: false, tsUs: nowUs - 10e6 } }
    }
  };
  const t = pitEta(petCar, green, trkTiming, { nr: '9', inPit: false }, now, now);
  check('pitEta tracker: pit-entry loop is the target', t && t.source === 'tracker' &&
    near(t.etaEntrySec, 60000 / 40000, 0.1) && near(t.distM, 60, 2));

  // TeamStream loops announce positions in meters — the scale is recovered
  // from the farthest loop vs the track length (2000 m → 2.0 km around).
  const tsTiming = { serverNowUs: nowUs, track: { pitInMm: 3900, sfMm: 0, maxLoopMm: 3900 } };
  const s = pitEta(petCar, green, tsTiming,
    { nr: '9', crossMm: 2000, crossUs: nowUs - 10e6, inPit: false }, now, now);
  check('pitEta TeamStream: loop unit auto-detected', s && s.source === 'loop' &&
    near(s.etaEntrySec, (3.9e6 - (2e6 + 400000)) / 40000, 0.1));

  // No crossing for 1.5 laps of travel → the estimate flags itself stale.
  const st = pitEta(petCar, green, { serverNowUs: nowUs }, entryAt(150), now, now);
  check('pitEta stale after a silent lap', st && st.stale === true);

  check('pitEta null without position data',
    pitEta(petCar, green, { serverNowUs: nowUs }, { nr: '9', inPit: false }, now, now) === null &&
    pitEta(petCar, green, { serverNowUs: nowUs }, { nr: '9', state: 'E' + (nowUs - 5e6), inPit: true }, now, now) === null &&
    pitEta(petCar, green, {}, entryAt(10), now, now) === null);

  // Red flag: the field is stopped, no arrival time exists.
  const redRace = { ...green, fcy: { mode: 'auto', active: false, startMs: null, flag: 2 } };
  check('pitEta null under red flag',
    pitEta(petCar, redRace, { serverNowUs: nowUs }, entryAt(10), now, now) === null);

  // Hand-entered sector geometry (event settings): S2 ends at 2.4 km, pit
  // entry at 3.9 km. A sector-2 crossing 10 s ago at green pace (400 m
  // travelled) → 1.1 km to the entry = 27.5 s.
  petCar.config.s1EndKm = 1.2;
  petCar.config.s2EndKm = 2.4;
  petCar.config.pitInKm = 3.9;
  const sec = pitEta(petCar, green, { serverNowUs: nowUs },
    { nr: '9', sectNr: 2, sectUs: nowUs - 10e6, inPit: false }, now, now);
  check('pitEta sector: configured distances place the car', sec && sec.source === 'sector' &&
    near(sec.etaEntrySec, 27.5, 0.1) && near(sec.distM, 1100, 2));

  // The same anchor without the wire stamp: the running lap started 70 s ago,
  // S1 and S2 done in 30 s each → the S2 crossing was 10 s ago.
  const sec2 = pitEta(petCar, green, { serverNowUs: nowUs },
    { nr: '9', state: 'E' + (nowUs - 70e6), s1: 30e6, s2: 30e6, inPit: false }, now, now);
  check('pitEta sector: lap start + sector times reconstruct the crossing',
    sec2 && sec2.source === 'sector' && near(sec2.etaEntrySec, 27.5, 0.1));

  // Safety car at a fixed 100 km/h (event setting): 30 s green (1.2 km) +
  // 30 s at 27.8 m/s (833 m) → 1.867 km to the 3.9 km pit entry = 67.2 s.
  petCar.config.scSpeedKmh = 100;
  const scRace = { ...green, fcy: { mode: 'auto', active: true, startMs: now - 30e3, flag: 3 } };
  const sc = pitEta(petCar, scRace, { serverNowUs: nowUs }, entryAt(60), now, now);
  check('pitEta SC: safety-car speed setting drives the pace', sc && sc.neutral &&
    near(sc.paceKmh, 100, 0.1) && near(sc.etaEntrySec, 67.2));
}

// ---- station presence: NO CAR RUNNING vs a dropped station ----
// A station announces its car with 'hello'. The wall shows NO CAR RUNNING
// only for cars that never had a station (or feed data) this race; after a
// drop the lasting liveSeenMs stamp keeps the last data on the wall.
{
  check('no stations online before any hello', Object.keys(stationsOnline).length === 0);

  const st2 = new WebSocket('ws://127.0.0.1:' + info.port);
  st2.on('open', () => st2.send(JSON.stringify({ type: 'hello', role: 'station', carId: '2' })));
  await until(() => stationsOnline['2'] === true);
  check('hello marks the station online', stationsOnline['2'] === true);
  await until(() => !!state.cars['2'].state.liveSeenMs);
  check('hello stamps the car as live', !!state.cars['2'].state.liveSeenMs);

  st2.close();
  await until(() => !stationsOnline['2']);
  check('socket close clears the online map', !stationsOnline['2']);
  check('live stamp survives the drop (wall keeps last data)', !!state.cars['2'].state.liveSeenMs);

  // A reset starts every car over, but a station connected through it stays
  // "seen" — only cars with nobody attached fall back to NO CAR RUNNING.
  const st3 = new WebSocket('ws://127.0.0.1:' + info.port);
  st3.on('open', () => st3.send(JSON.stringify({ type: 'hello', role: 'station', carId: '3' })));
  await until(() => stationsOnline['3'] === true);
  send({ type: 'resetRace' });
  await until(() => state.cars['2'].state.liveSeenMs == null);
  check('race reset clears the stamp for unattended cars', state.cars['2'].state.liveSeenMs == null);
  check('race reset keeps a connected station seen', !!state.cars['3'].state.liveSeenMs);
  st3.close();
  await until(() => !stationsOnline['3']);
}

// ---- feed session guard: the race belongs to one session --------------------
// Joining a feed that is on a different session than the data on screen must
// never pour that session's laps, clock and flags into the numbers already
// there — the pit wall decides: fresh race, or keep this one.
{
  // Impersonate a connected feed whose session name we control.
  const snapOrig2 = info.timing.snapshot;
  let feedSession = 'Race 1';
  info.timing.snapshot = () => ({
    ...snapOrig2.call(info.timing),
    conn: 'connected',
    session: { name: feedSession, flag: null, remainUs: null, totalUs: null, elapsedUs: null, frozen: false, rc: null }
  });
  info.timing.engine.reset();

  send4({ type: 'resetRace' });
  send4({ type: 'timingLink', carId: '1', nr: '17' });
  send4({ type: 'timingAutoLap', carId: '1', on: true });
  await until(() => state.timing.sessionKey === 'Race 1');
  check('empty race adopts the feed session without asking',
    state.timing.sessionKey === 'Race 1' && !state.timing.sessionAlert);

  send4({ type: 'startRace' });
  await until(() => state.race.startMs != null);
  info.timing.engine.onEvent({ type: 'lap', nr: '17', lapUs: 100e6, lapSec: 100 });
  await until(() => state.cars['1'].state.totalLaps === 1);
  check('feed laps count for the bound session', state.cars['1'].state.totalLaps === 1);

  // The feed moves to the next session of the weekend.
  feedSession = 'Race 2';
  await until(() => !!state.timing.sessionAlert);
  const alert = state.timing.sessionAlert;
  check('session change with a race on screen asks the pit wall',
    alert && alert.from === 'Race 1' && alert.to === 'Race 2' && alert.laps === 1);
  check('the race stays bound to its own session', state.timing.sessionKey === 'Race 1');

  info.timing.engine.onEvent({ type: 'lap', nr: '17', lapUs: 101e6, lapSec: 101 });
  info.timing.engine.onEvent({ type: 'pitIn', nr: '17' });
  await wait(250);
  check('the other session\'s laps are held', state.cars['1'].state.totalLaps === 1);
  check('the other session\'s pit events are held', state.cars['1'].state.inPit === false);

  // KEEP: this is still the race, the feed just renamed/rejoined it.
  send4({ type: 'sessionKeep' });
  await until(() => !state.timing.sessionAlert);
  check('keeping the race binds it to the feed session',
    state.timing.sessionKey === 'Race 2' && !state.timing.sessionAlert);
  info.timing.engine.onEvent({ type: 'lap', nr: '17', lapUs: 102e6, lapSec: 102 });
  await until(() => state.cars['1'].state.totalLaps === 2);
  check('laps flow again once the session is answered', state.cars['1'].state.totalLaps === 2);

  // A session change event from the engine raises the question immediately,
  // without waiting for the next follow tick.
  feedSession = 'Race 3';
  info.timing.engine.onEvent({ type: 'session', name: 'Race 3', prevName: 'Race 2' });
  await until(() => !!state.timing.sessionAlert);
  check('a session-change event asks straight away',
    state.timing.sessionAlert?.to === 'Race 3');

  // NEW: the previous session's race is over — start this one clean.
  const set2 = state.cars['1'].state.currentTyreSetId;
  send4({ type: 'sessionNew' });
  await until(() => state.cars['1'].state.totalLaps === 0);
  check('a fresh session clears the previous session\'s laps',
    state.cars['1'].state.totalLaps === 0 && state.cars['1'].stintHistory.length === 0);
  check('a fresh session binds itself and closes the question',
    state.timing.sessionKey === 'Race 3' && !state.timing.sessionAlert);
  check('a fresh session starts on fresh rubber and a seeded tank',
    state.cars['1'].state.currentTyreSetId === 't1' && set2 !== null &&
    state.cars['1'].state.fuelLiters === state.cars['1'].config.tankLiters);

  // Joining a session already two hours old: the race clock belongs back at
  // the session start, the stint sheet and the fuel reading belong here.
  info.timing.engine.applyFrame({
    handle: 'h_i', payload: { n: 'Race 3', lt: 24 * 3600e6, r: 2 * 3600e6 }, ts: Date.now()
  });
  send4({ type: 'timingSyncClock' });
  await until(() => state.race.startMs != null && Date.now() - state.race.startMs > 3600e3);
  const joined = state.cars['1'].state;
  check('mid-session join anchors the race clock to the session start',
    Math.abs(Date.now() - state.race.startMs - 2 * 3600e3) < 5e3);
  check('mid-session join starts the stint at the join, not hours ago',
    Math.abs(Date.now() - joined.stintStartMs) < 5e3);
  check('mid-session join seeds the tank instead of draining it',
    joined.fuelLiters === state.cars['1'].config.tankLiters &&
    joined.stintFuelStartL === joined.fuelLiters);

  info.timing.snapshot = snapOrig2;
  info.timing.engine.reset();
  send4({ type: 'resetRace' });
  await wait(200);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
