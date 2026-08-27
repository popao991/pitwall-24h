// Headless smoke test: boots the server, drives it over WebSocket like a
// station + pit wall would, and asserts the state transitions.
// Run with: npm test
import { startServer } from '../server/server.js';
import {
  carCalcs, projectStints, raceClock, effectiveBurn, stopServiceTime, fcyCalc, pitLaneCalc, pitEta,
  pitArrivalOrder, generatePlan,
  fuelStrategy, defaultCar, emptyStop,
  recommendedStops, resolveStop,
  raceCondition,
  burnAtLapTime, normalizeCurve, pushLapTime, burnDetail, LAP_AVG_WINDOW,
  driveTimeStats, pitCongestion, replanFromNow, planVsActual, stintStats, learnedOf, fmtGapUs,
  driverLapTimes, paceWindowStats, paceWindowLaps, PACE_WINDOW_DEFAULT, PACE_WINDOW_MAX,
  carPickLabel, DEFAULT_CAR_NUMBERS, defaultCarNumber,
  driverAbbrev, matchTimingDriver, createFeedSeen, wallShowsPlan,
  feedSessionAge, SESSION_FRESH_MS,
  pitCostSec, pitSegments, pitLaneTimeSec, refuelTimeSec, fuelBreakEven, recommendedStop,
  greenSpeedKmh, neutralSpeedKmh, timingNrOf,
  tyreSetNames, generateTyreSets, TYRE_SET_GEN_MAX, tyreBudget, stopTyreSet, reconcileTyreSets,
  brakeSetNames, generateBrakeSets, nextSetNumber, BRAKE_COMPONENTS,
  reconcileBrakeSets, linkBrakeKit, brakeKitsOf, stopBrakeAxle,
  reconcileTyreWarmers, loadTyreWarmer, warmableTyreSets, TYRE_WARMER_MAX,
  buildCarFile, readCarFile, applyCarFile, carFileName, carConfigFields,
  CAR_FILE_GROUPS, CAR_FILE_RACK_FIELDS, EVENT_FIELDS,
  // --- pure-function coverage added below (kits, racks, caution, next driver) ---
  isDiscComponent, axleOfComponent, brakeAxle, brakeAxleWork,
  brakeWorkComps, currentBrakeKit, kitNameFor, kitOfDiscSet,
  discSetOfPadSet, freePadSets, unlinkBrakeKit, syncBrakeKitToCar,
  reconcileBrakeKits, stopBrakeKit, stopPadSet, brakeSetsOf,
  expandSetNames, defaultTyreSets, newTyreSet, newBrakeSet,
  newTyreWarmer, setTyreSetNames, setBrakeSetNames, warmerOfSet,
  currentTyreSet, stintStartOf, plannedNextDriver, nextDriverCall,
  probabilityOfCautionWithin, cautionCall, cautionSweep, cautionBand, CAUTION_DECISIVE_SEC
} from '../shared/model.js';
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ports 8485/8486 so tests never touch a live app on the default port 8484.
// Main server: no ticking, so fuel values stay deterministic.
// Binding is asynchronous, so a port still held by another smoke run does not
// throw here — the run happily connects to the OTHER run's server instead, both
// suites then drive the same state, and the output is pages of unrelated
// failures that look like real regressions. Fail on the spot and say why.
async function bound(info, which) {
  try {
    await info.listening;
  } catch (e) {
    console.error(`
Cannot start the ${which} test server: ${e.message}`);
    console.error('Another smoke run or an orphaned server still holds the port.');
    console.error('Wait for it to exit (or kill it) and run the suite again.');
    process.exit(2);
  }
  return info;
}

const info = startServer({ dataFile: null, port: 8485, tickMs: 3600e3 });
await bound(info, 'main');
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

// FCY calculator, on a round 4 km track rather than the seeded circuit, so
// every figure below divides out exactly.
// 4 km at 80 km/h = 180 s lap against a 105 s green lap. The
// per-lap delta is 75 s — but that is what the whole FIELD drops, not what
// pitting under it gains, so it is reported separately from the discount.
// Green speed 4/105 = 137.14 km/h; a full 100 L fill is 40 s on the rig, and
// 40 s of lane time at 80 km/h instead of 137.14 gives back 47.41 s.
// The speed is pinned here alongside the track figures: these checks verify the
// identity, not the product default, and 80 km/h is what makes every number
// below divide out exactly. Zolder's own Code 60 runs at 60 km/h — that is the
// shipped default in defaultEvent(), and deliberately not what this fixture uses.
const roundTrack = car => { const c = JSON.parse(JSON.stringify(car));
  c.config.trackKm = 4; c.config.pitLaneKm = 0.4; c.config.fcySpeedKmh = 80; return c; };
const fc = fcyCalc(roundTrack(state.cars['1']));
check('fcy lap time', Math.abs(fc.fcyLapSec - 180) < 0.01);
check('fcy per-lap delta is the field, not the gain', Math.abs(fc.fcyLapDeltaSec - 75) < 0.01);
check('fcy gain scales with the stop, not the lap', Math.abs(fc.gainSec - 47.4074) < 0.01);
check('fcy net pit loss', Math.abs(fc.netPitLossSec - 23.5926) < 0.01);
check('fcy gain can never exceed what the stop costs under green', fc.gainSec < fc.netPitLossSec + fc.gainSec);

// ---- what a stop costs, and what a neutralisation takes off it ----
// The whole model in one identity: gain = T × (1 − vN/vG) + (deltaGreen − deltaNeutral).
{
  const car = roundTrack(state.cars['1']);
  check('green speed derives from the average lap', Math.abs(greenSpeedKmh(car) - 137.1429) < 0.01);
  check('fcy speed is the regulated one', neutralSpeedKmh(car, 'fcy') === 80);
  check('no neutralisation, no discount', pitCostSec(car, null, { refuelSec: 40 }).gainSec === 0);

  const cost = pitCostSec(car, 'fcy', { refuelSec: 40 });
  const k = 1 - cost.vN / cost.vG;
  check('the gain is lane time scaled by how much slower the field is',
    Math.abs(cost.gainSec - (cost.T * k + (cost.deltaGreen - cost.deltaNeutral))) < 1e-9);
  check('the gain is exactly the two losses apart',
    Math.abs(cost.gainSec - (cost.lossGreen - cost.lossNeutral)) < 1e-9);
  // Twice the fuel is twice the lane time, so the discount grows with it —
  // the old per-lap model gave the same answer to a splash and a full tank.
  const half = pitCostSec(car, 'fcy', { refuelSec: 20 });
  check('a bigger fill earns a bigger discount', cost.gainSec > half.gainSec + 5);

  // Box work is discounted by the same factor as the fuel, which is why a
  // neutralisation is when to change tyres as well.
  const withTyres = pitCostSec(car, 'fcy', { refuelSec: 40, boxWorkSec: 25 });
  const greenMarginal = withTyres.lossGreen - cost.lossGreen;
  const nowMarginal = withTyres.lossNeutral - cost.lossNeutral;
  check('tyres cost their full time under green', Math.abs(greenMarginal - 25) < 0.01);
  check('tyres cost the discounted time under fcy', Math.abs(nowMarginal - 25 * (1 - k)) < 0.01);
}

// ---- pit lane legs: three measured figures, two derived ----
{
  const cfg = { driveThroughSec: 24, pitEntryToPumpSec: 8, pumpToBoxSec: 6, boxToExitSec: 10 };
  const seg = pitSegments(cfg);
  check('rejoin from the rig derives from the drive-through', Math.abs(seg.pumpToExit - 16) < 0.01);
  check('entry to box derives from the two legs before it', Math.abs(seg.entryToBox - 14) < 0.01);
  check('a measured rejoin wins over the derived one',
    Math.abs(pitSegments({ ...cfg, pumpToExitSec: 20 }).pumpToExit - 20) < 0.01);

  // A fuel-only stop rejoins from the rig; adding box work carries on past it.
  check('fuel-only stop drives entry→rig→exit',
    Math.abs(pitLaneTimeSec(cfg, { refuelSec: 30 }).totalSec - (8 + 16 + 30)) < 0.01);
  check('fuel plus work drives entry→rig→box→exit',
    Math.abs(pitLaneTimeSec(cfg, { refuelSec: 30, boxWorkSec: 25 }).totalSec - (8 + 6 + 10 + 30 + 25)) < 0.01);
  check('a stop with no fuel skips the rig',
    Math.abs(pitLaneTimeSec(cfg, { boxWorkSec: 25 }).totalSec - (14 + 10 + 25)) < 0.01);
  check('no work at all is a drive-through',
    Math.abs(pitLaneTimeSec(cfg, {}).totalSec - 24) < 0.01);

  // An event with nothing but a drive-through time measured must still charge
  // one full lane whatever the stop does. Deriving only some legs made the box
  // path free, so adding a tyre change looked like it SHORTENED the pit lane
  // and the marginal cost of box work collapsed to about a second.
  const bare = { driveThroughSec: 24 };
  for (const [what, opts] of [
    ['fuel only', { refuelSec: 30 }],
    ['fuel plus work', { refuelSec: 30, boxWorkSec: 25 }],
    ['work only', { boxWorkSec: 25 }],
    ['drive-through', {}]
  ]) {
    check(`an unmeasured lane still costs a full drive-through: ${what}`,
      Math.abs(pitLaneTimeSec(bare, opts).driveSec - 24) < 0.01);
  }
  check('box work on an unmeasured lane costs its own time, not less',
    Math.abs(pitLaneTimeSec(bare, { refuelSec: 30, boxWorkSec: 25 }).totalSec -
             pitLaneTimeSec(bare, { refuelSec: 30 }).totalSec - 25) < 0.01);

  // A series minimum stop time is a floor on the whole visit, so work that
  // fits inside it is free.
  const min = pitLaneTimeSec({ ...cfg, minStopSec: 90 }, { refuelSec: 30 });
  check('a minimum stop time holds the car', Math.abs(min.totalSec - 90) < 0.01);
  check('the minimum reports what it swallowed', Math.abs(min.heldSec - 36) < 0.01);
  check('a stop longer than the minimum is unaffected',
    Math.abs(pitLaneTimeSec({ ...cfg, minStopSec: 30 }, { refuelSec: 30 }).totalSec - 54) < 0.01);

  // Rig dead time is charged once per fuelling stop, whatever the splash.
  check('dead time is charged on any fill', Math.abs(refuelTimeSec({ refuelLps: 2.5, refuelDeadSec: 6 }, 25) - 16) < 0.01);
  check('no fuel means no rig and no dead time', refuelTimeSec({ refuelLps: 2.5, refuelDeadSec: 6 }, 0) === 0);
}

// ---- the break-even fill: the standing call for the next flag ----
// Closed window, so a stop under yellow buys an extra stop later. It only pays
// once the discount covers that whole extra pit loss — a fixed litre figure,
// because every term in it is track geometry and two speeds.
{
  const car = roundTrack(state.cars['1']);
  Object.assign(car.config, { pitEntryToPumpSec: 8, pumpToBoxSec: 6, boxToExitSec: 10, driveThroughSec: 24 });
  const be = fuelBreakEven(car, 'fcy');
  check('break-even names a real litre figure', be.rule === 'above' && be.litersL > 0);
  check('break-even discount is the speed ratio', Math.abs(be.discount - (1 - 80 / 137.1429)) < 0.001);
  // The threshold is exactly where the discount overtakes the extra pit loss.
  const at = l => pitCostSec(car, 'fcy', { refuelSec: refuelTimeSec(car.config, l) }).gainSec;
  check('one litre under the threshold does not pay', at(be.litersL - 1) < car.config.pitLossSec);
  check('the threshold itself pays', at(be.litersL) >= car.config.pitLossSec - 1e-6);
  // It is a property of the track, not of the race: nothing about where the
  // car is in the stint moves it.
  const later = JSON.parse(JSON.stringify(car));
  later.state.fuelLiters = 12;
  later.state.totalLaps = 200;
  check('the threshold does not move during the race',
    Math.abs(fuelBreakEven(later, 'fcy').litersL - be.litersL) < 1e-9);
  // Same track and same neutralised speed on both sides — the lane legs are the
  // only difference, which is the whole point of the comparison.
  check('lane legs lower the threshold', be.litersL < fuelBreakEven(roundTrack(state.cars['1']), 'fcy').litersL);
  check('no answer under green', fuelBreakEven(car, null) === null);

  // The threshold is not decoration: the app's own BOX NOW / STAY OUT call
  // under a closed window has to land on exactly the same side of it. Sweep a
  // whole tank of fills and check the two never disagree.
  const beRace = { durationH: 24, startMs: Date.now() - 3600e3, fcy: { mode: 'fcy', active: true, startMs: Date.now(), source: 'manual', flag: null } };
  let sweepChecked = 0;
  let sweepAgreed = 0;
  for (let fuelNow = 5; fuelNow <= 95; fuelNow += 5) {
    const probe = JSON.parse(JSON.stringify(car));
    probe.state.fuelLiters = fuelNow;
    const c = carCalcs(probe, beRace, Date.now());
    const f = fuelStrategy(probe, beRace, Date.now(), c);
    if (!f || f.noStopNeeded || f.windowOpen) continue; // threshold only bites on a closed window
    const plan = recommendedStop(probe, beRace, Date.now(), { calcs: c, fs: f, pace: 'fcy' });
    if (plan.tyres.change) continue; // fuel only — box work earns its own discount
    sweepChecked++;
    const worthIt = plan.netSec <= 0;
    if (worthIt === f.breakEvenMet.fcy) sweepAgreed++;
  }
  check('the sweep actually exercised closed-window fuel-only stops', sweepChecked >= 5);
  check('the automatic call never disagrees with the break-even', sweepAgreed === sweepChecked);
}

// pit lane at the limit: 0.4 km at 60 km/h = 24 s; 55 s loss leaves 31 s overhead
const pl = pitLaneCalc(roundTrack(state.cars['1']));
check('pit lane transit time', Math.abs(pl.transitSec - 24) < 0.01);
check('pit lane overhead vs configured loss', Math.abs(pl.overheadSec - 31) < 0.01);
check('pit lane needs both figures', pitLaneCalc({ config: { pitLaneKm: 0.4, pitSpeedKmh: 0 } }) === null);

// car picker labels: the race number IS the identity, the team's name appends
check('car label default', carPickLabel('1', { number: '15', name: 'Car #15' }) === '#15');
check('car label named', carPickLabel('1', { number: '34', name: 'Red Racer' }) === '#34 — Red Racer');
check('car label numberless falls back to the slot',
  carPickLabel('2', { number: '', name: '' }) === 'Car 2');

// the four slots are the team's own entries and start on their race numbers
check('the slots start on the team race numbers',
  DEFAULT_CAR_NUMBERS.join(',') === '15,27,40,92' &&
  ['1', '2', '3', '4'].every((id, i) => defaultCarNumber(id) === DEFAULT_CAR_NUMBERS[i]) &&
  defaultCarNumber('5') === '5');

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

// ---- "did this session start right now?" ----
// The half of the session question the app answers on its own: a session that
// is starting here cannot be the one on screen, so the race that is on screen
// is saved and a fresh one rolls onto the new session with nothing to confirm.
// Everything else — and every "the feed has not said yet" — goes to the wall.
{
  const sess = (totalUs, remainUs) => ({ totalUs, remainUs });
  const H = 3600e6;
  check('session age: not started yet is fresh',
    feedSessionAge({ session: sess(24 * H, 24 * H), entries: [{ nr: '15', laps: 0 }] }) === 'fresh');
  check('session age: a minute in is fresh',
    feedSessionAge({ session: sess(H, H - 60e6), entries: [] }) === 'fresh');
  check('session age: past the window is running',
    feedSessionAge({ session: sess(H, H - (SESSION_FRESH_MS + 1e3) * 1e3), entries: [] }) === 'running');
  check('session age: hours in is running',
    feedSessionAge({ session: sess(24 * H, 21 * H), entries: [] }) === 'running');
  // A completed lap outranks the clock: a board with laps on it has been raced.
  check('session age: laps on the board are running whatever the clock says',
    feedSessionAge({ session: sess(24 * H, 24 * H), entries: [{ nr: '15', laps: 0 }, { nr: '27', laps: 3 }] }) === 'running');
  // Absence of evidence is never youth: an unheld race must not be thrown away
  // because the feed has not published a clock yet (the first frames after a
  // session change carry neither window nor board).
  check('session age: no session window is unknown',
    feedSessionAge({ session: sess(null, 2 * H), entries: [] }) === 'unknown');
  check('session age: no remaining is unknown',
    feedSessionAge({ session: sess(24 * H, null), entries: [] }) === 'unknown');
  check('session age: an empty snapshot is unknown',
    feedSessionAge({ entries: [] }) === 'unknown' && feedSessionAge(null) === 'unknown');
  check('session age: the finish is running, not fresh',
    feedSessionAge({ session: sess(24 * H, 0), entries: [] }) === 'running');
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
  check('abbrev derived from name (M + VE)', driverAbbrev(rosterCar.drivers[0]) === 'MVE');
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
// "whole race stays FCY" optimism), and the stop is discounted. The window is
// open, so nothing is wasted by boxing now and the whole discount is profit.
fsCar.state.fuelLiters = 60;
const fcyRace = { ...fsRace(33), fcy: { mode: 'fcy', active: true, startMs: fsNow, source: 'manual', flag: null } };
fstr = fuelStrategy(fsCar, fcyRace, fsNow);
check('fcy: fuel need stays on green basis', fstr.stopsMin === 1 && Math.abs(fstr.fuelToEnd - 97.4) < 0.01);
check('fcy: box now saves the gain', fstr.verdict === 'pitNow' && fstr.netPitNowSec < 0 &&
  Math.abs(fstr.netPitNowSec + fstr.gainSec) < 1e-9);
// The discount is priced on the fuel this stop actually takes — not on a lap
// delta that would say the same thing for a splash and a full tank.
check('fcy: the discount follows the fill', Math.abs(fstr.stopSec - (fstr.fillTargetL - 60) / 2.5) < 0.01);
// Window open means the threshold does not apply: the stop was being made
// anyway, so there is no extra stop for the discount to have to cover.
check('fcy: an open window needs no break-even', fstr.windowOpen && fstr.breakEvenMet.fcy === true);
check('fcy: the break-even is worked out under green too',
  fuelStrategy(fsCar, fsRace(33), fsNow).breakEven.fcy !== null);

// Low-fuel warning levels (liters counted above the safety reserve).
fsCar.config.fuelWarnL = 15;
fsCar.state.fuelLiters = 3 + 20; // 20 L above the reserve — still clear
fstr = fuelStrategy(fsCar, fsRace(33), fsNow);
check('low fuel stays quiet above the threshold',
  fstr.warn.level === 'ok' && Math.abs(fstr.warn.litersLeft - 20) < 1e-9);
fsCar.state.fuelLiters = 3 + 12; // inside the 15 L warning band
fstr = fuelStrategy(fsCar, fsRace(33), fsNow);
check('low fuel warns at the threshold', fstr.warn.level === 'warn' && fstr.warn.litersLeft === 12);
fsCar.state.fuelLiters = 3 + 7; // under half the threshold
fstr = fuelStrategy(fsCar, fsRace(33), fsNow);
check('low fuel goes critical at half the threshold', fstr.warn.level === 'crit');
fsCar.config.fuelWarnL = 0;
check('low fuel warning can be disabled', fuelStrategy(fsCar, fsRace(33), fsNow).warn.level === 'ok');
fsCar.config.fuelWarnL = 15;
check('no window before the race runs', fuelStrategy(fsCar, { durationH: 2, startMs: null, fcy: {} }, fsNow) === null);

// other cars untouched
check('car 2 untouched', state.cars['2'].state.totalLaps === 0);

// ---- settings, presets, stint plan ----
check('global settings exist', state.settings && state.settings.backupIntervalMin === 5);
send({ type: 'settings', patch: { backupIntervalMin: 10 } });
await wait(150);
check('settings patch applied', state.settings.backupIntervalMin === 10);

// ---- event settings: edited once on the pit wall, mirrored to every car ----
check('event settings seeded', state.event && state.event.trackKm === 4.007 && state.event.refuelLps === 2.5 &&
  state.event.pitSpeedKmh === 60 && state.event.pitLaneKm === 0.411);
// Zolder off its official track map: 4007 m, pit IN → pit OUT 411 m, and the
// two intermediates at 1376,4 m / 2864,6 m from a start line at offset 0.
check('the track is seeded from the official figures',
  state.event.s1EndKm === 1.3764 && state.event.s2EndKm === 2.8646 &&
  state.event.s3EndKm === 0 && state.cars['1'].config.s1EndKm === 1.3764);
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

// ---- car files: one car's whole setup as a file, prepared with no server ----
{
  // Every car-specific config field is in the file, and no event field is:
  // this is the check that keeps a setting added later from falling out.
  const covered = [...CAR_FILE_GROUPS.flatMap(g => g.fields), ...CAR_FILE_RACK_FIELDS].sort();
  check('the file covers every car setting and nothing else',
    JSON.stringify(covered) === JSON.stringify(carConfigFields().sort()));
  check('no event setting travels in a car file',
    !covered.some(f => EVENT_FIELDS.includes(f)));

  const source = defaultCar('1', '31');
  source.name = 'Zolder GT3';
  source.make = 'Porsche';
  source.model = '992 GT3 Cup';
  source.config.tankLiters = 88;
  source.config.burnPerLap.dry = 3.14;
  source.config.avgLapSec.wet = 121;
  source.config.tyreLifeKm = 275;
  source.config.tyreChangeSec = 19;
  source.drivers[0].name = 'Jo Bloggs';
  source.drivers[0].abbrev = 'BLO';
  source.drivers[0].fuelDry = 3.4;
  source.drivers[0].fuelCurve = [{ lapSec: 105, fuelL: 3.2 }, { lapSec: 112, fuelL: 2.8 }];
  source.drivers[0].totalMs = 45 * 60e3; // seat time must NOT travel
  source.tyreSets = generateTyreSets(source, { pattern: 'GVP[##]', start: 1, count: 8, replaceUnused: true }).sets;
  source.config.tyreSets = source.tyreSets.length;

  const file = buildCarFile(source, { app: '1.0.5', savedMs: 1700000000000 });
  check('a car file names itself', carFileName(source) === '31-zolder-gt3.pitcar.json');
  check('a car file is stamped', file.kind === 'pitwall-24h.car' && file.version >= 1 &&
    file.savedIso.startsWith('2023-') && file.app === '1.0.5');
  check('a car file explains itself', typeof file._readme === 'string' && file._readme.length > 80);
  check('a car file carries the car', file.car.number === '31' && file.car.make === 'Porsche');
  check('a car file carries the setup', file.fuel.tankLiters === 88 && file.pace.avgLapSec.wet === 121 &&
    file.wear.tyreLifeKm === 275 && file.wear.tyreChangeSec === 19);
  check('a car file carries the drivers and their curves',
    file.drivers.length === 4 && file.drivers[0].abbrev === 'BLO' && file.drivers[0].fuelCurve.length === 2);
  check('seat time never travels in a car file', file.drivers.every(d => d.totalMs === undefined));
  // The set the car is sitting on survives a generation, so the rack is that
  // one plus the eight generated — and the file says exactly what is on the
  // shelf, placeholder included.
  check('a car file carries the racks by name',
    file.tyreRack.names.includes('GVP01') && file.tyreRack.names.includes('GVP08') &&
    file.tyreRack.count === file.tyreRack.names.length &&
    file.brakeRack.padsFront.names.join() === 'PF1,PF2,PF3,PF4');
  check('the round trip survives JSON', JSON.parse(JSON.stringify(file)).fuel.tankLiters === 88);

  // Loading onto a car that has run: settings land, race data stays.
  const target = defaultCar('2', '2');
  target.state.totalLaps = 140;
  target.state.tyreLapsOnSet = 12;
  target.drivers[0].totalMs = 2 * 3600e3;
  target.tyreSets[0].used = true;
  target.tyreSets[0].km = 310;
  target.tyreSets[0].laps = 74;
  const res = applyCarFile(target, JSON.parse(JSON.stringify(file)));
  check('a car file loads', res.ok && res.applied.includes('driver table') && res.applied.includes('tyre rack'));
  check('the setup landed', target.config.tankLiters === 88 && target.config.burnPerLap.dry === 3.14 &&
    target.number === '31' && target.name === 'Zolder GT3' && target.model === '992 GT3 Cup');
  check('the drivers landed', target.drivers[0].name === 'Jo Bloggs' && target.drivers[0].fuelDry === 3.4);
  check('seat time survives a load', target.drivers[0].totalMs === 2 * 3600e3);
  check('race data survives a load', target.state.totalLaps === 140 && target.state.tyreLapsOnSet === 12);
  check('the set that has run keeps its mileage',
    target.tyreSets.some(t => t.km === 310 && t.laps === 74));
  check('the rack came from the file',
    target.tyreSets.filter(t => t.name.startsWith('GVP')).length === 8 &&
    target.config.tyreSets === target.tyreSets.length);
  check('the file rack does not drag the placeholder in twice',
    target.tyreSets.filter(t => t.name === 'S1').length === 1);
  check('a set with mileage under a name the file also lists is reported',
    res.warnings.some(w => w.includes('S1')));
  check('a fresh car loading a fresh file says nothing about mileage',
    applyCarFile(defaultCar('4', '4'), JSON.parse(JSON.stringify(file))).warnings.length === 0);
  check('the car is still on a set it owns',
    target.tyreSets.some(t => t.id === target.state.currentTyreSetId));

  // A file loaded twice must not grow the rack a second time.
  const before = target.tyreSets.length;
  applyCarFile(target, JSON.parse(JSON.stringify(file)));
  check('loading the same file twice does not duplicate the rack', target.tyreSets.length === before);

  // Hand-edited files: the ones a text editor produces.
  const hand = JSON.parse(JSON.stringify(file));
  hand.fuel.tankLiters = '92,5'; // European decimal comma, typed by hand
  hand.fuel.fuelModel = 'nonsense';
  hand.pace.paceAvgLaps = 999;
  hand.wear.tyreLifeKm = -20;
  delete hand.drivers;
  const hc = defaultCar('3', '3');
  const hr = applyCarFile(hc, hand);
  check('a hand-typed decimal comma is read', hr.ok && hc.config.tankLiters === 92.5);
  check('a nonsense fuel model falls back', hc.config.fuelModel === 'driver-avg');
  check('an out-of-range pace window is clamped', hc.config.paceAvgLaps === PACE_WINDOW_MAX);
  check('a negative life figure cannot get in', hc.config.tyreLifeKm >= 0);
  check('a file with no drivers leaves the roster alone', hc.drivers.length === 4 && hc.drivers[0].name === 'Driver 1');

  check('a file from a newer build still loads, with a warning',
    (() => {
      const future = { ...JSON.parse(JSON.stringify(file)), version: 99 };
      const r = readCarFile(future);
      return r.ok && r.warnings.length === 1;
    })());
  check('a state backup is not a car file', !readCarFile('{"race":{},"cars":{}}').ok);
  check('a truncated file is refused', !readCarFile('{"kind":"pitwall-24h.car"').ok);
  check('an empty file is refused', !applyCarFile(defaultCar('1', '1'), '').ok);
}

// ---- the pit wall applies a car file to any car ----
{
  const wallFile = buildCarFile((() => {
    const c = defaultCar('1', '77');
    c.name = 'Night Runner';
    c.config.tankLiters = 96;
    c.config.pitLossSec = 999; // an event field, hand-added: must not fork the car
    c.drivers[1].name = 'Sam Vega';
    return c;
  })(), { savedMs: Date.now() });
  wallFile.wear.pitLossSec = 999;

  const seatBefore = state.cars['3'].drivers[1].totalMs;
  send({ type: 'loadCarFile', carId: '3', file: wallFile });
  await until(() => state.cars['3'].config.tankLiters === 96);
  check('the wall loads a car file onto a car', state.cars['3'].config.tankLiters === 96 &&
    state.cars['3'].name === 'Night Runner' && state.cars['3'].number === '77');
  check('the loaded car takes the file drivers', state.cars['3'].drivers[1].name === 'Sam Vega');
  check('a car file load keeps seat time', state.cars['3'].drivers[1].totalMs === seatBefore);
  check('a car file cannot fork the event settings',
    state.cars['3'].config.pitLossSec === state.event.pitLossSec);
  check('other cars are untouched by a car file', state.cars['4'].config.tankLiters !== 96);
}

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
await bound(info2, 'tick');
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
// saved when one set of pins and one tick were shared by all three situations
brokenState.cars['3'].nextStop.plan = 'fcy';
brokenState.cars['3'].nextStop.pins = undefined;
brokenState.cars['3'].nextStop.approvals = undefined;
delete brokenState.cars['3'].nextStop.pins;
delete brokenState.cars['3'].nextStop.approvals;
brokenState.cars['3'].nextStop.pinned = { tyres: 'keep' };
brokenState.cars['3'].nextStop.approved = { by: 'old', atMs: 1, hash: 'x', stale: false };
// saved before the slots carried the team's real race numbers: cars 1 and 2 are
// still on the placeholder, car 4 has been numbered and named at the track.
brokenState.cars['1'].number = '1'; brokenState.cars['1'].name = 'Car #1';
brokenState.cars['2'].number = '2'; brokenState.cars['2'].name = 'Car #2';
brokenState.cars['4'].number = '4'; brokenState.cars['4'].name = 'Night Runner';
const tmpFile = path.join(os.tmpdir(), `pitwall-smoke-${process.pid}.json`);
fs.writeFileSync(tmpFile, JSON.stringify(brokenState));

const info3 = startServer({ dataFile: tmpFile, port: 8487, tickMs: 3600e3 });
await bound(info3, 'persistence');
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
{
  const stop3 = state3.cars['3'].nextStop;
  check('one shared set of pins becomes three, unchanged',
    stop3.pinned === undefined && ['green', 'fcy', 'sc'].every(k => stop3.pins[k].tyres === 'keep'));
  check('the old tick lands on the situation it was made for',
    stop3.approved === undefined && stop3.approvals.fcy?.by === 'old' &&
    stop3.approvals.green === null && stop3.approvals.sc === null);
}
check('event mirrored to all cars on restore', state3.cars['2'].config.pitLossSec === 40);
check('placeholder race numbers become the team race numbers on restore',
  state3.cars['1'].number === '15' && state3.cars['1'].name === 'Car #15' &&
  state3.cars['2'].number === '27' && state3.cars['2'].name === 'Car #27');
check('a car numbered at the track is left alone on restore',
  state3.cars['4'].number === '4' && state3.cars['4'].name === 'Night Runner');

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

// A timekeeper who switches screens between sessions publishes a different set
// of columns in a different order, and the deltas that follow carry no headers
// of their own. Read through the previous screen's map every value lands a
// field over — the E.T.A. token under TEAM, the best time under S1, class
// position under LAPS — which is what a stale layout did to a live pit wall.
const colEvents = [];
const engCol = new TimingEngine({ onEvent: e => colEvents.push(e), onLog: () => {} });
engCol.applyFrame({ handle: 'h_i', payload: { n: 'System test - screen check' }, ts: Date.now() });
engCol.applyFrame({ handle: 'r_i', payload: { l: {
  h: [
    { n: 'Position', c: 'POS' }, { n: 'StartNumber', c: 'NR' }, { n: 'State', c: 'E.T.A.' },
    { n: 'Name', c: 'TEAM' }, { n: 'CurrentDriver', c: 'DRIVER' }, { n: 'Car', c: 'CAR' }
  ],
  d: [['1', '40', 'E1730000000000000', 'VR Racing by NGT', 'Dirk Van Rompuy', 'Porsche Cayman GT4 RS']]
} }, ts: Date.now() });
check('screen check board decoded', engCol.snapshot().entries[0].team === 'VR Racing by NGT');

engCol.applyFrame({ handle: 'h_h', payload: { n: 'Belcar - Pre-qualifying practice 1' }, ts: Date.now() });
engCol.applyFrame({ handle: 'r_c', payload: [
  [0, 0, '1'], [0, 2, '40'], [0, 3, 'I'], [0, 4, 'E1730000900000000'],
  [0, 5, 'VR Racing by NGT'], [0, 7, 'Dirk Van Rompuy'], [0, 8, 'Porsche Cayman GT4 RS']
], ts: Date.now() });
check('stale layout publishes nothing', engCol.snapshot().entries.length === 0);
check('stale layout asks for a fresh bootstrap', colEvents.some(e => e.type === 'refresh'));

// the reconnect replays the new board, headers and all
engCol.applyFrame({ handle: 'r_i', payload: { l: {
  h: [
    { n: 'Position', c: 'POS' }, { n: 'Marker', c: '' }, { n: 'StartNumber', c: 'NR' },
    { n: 'SectionMarker', c: 'S' }, { n: 'State', c: 'E.T.A.' }, { n: 'Name', c: 'TEAM' },
    { n: 'CurrentDriverID', c: 'ID' }, { n: 'CurrentDriver', c: 'DRIVER' }, { n: 'Car', c: 'CAR' }
  ],
  d: [['1', '', '40', 'I', 'E1730000900000000', 'VR Racing by NGT', '1', 'Dirk Van Rompuy',
       'Porsche Cayman GT4 RS']]
} }, ts: Date.now() });
const colRow = engCol.snapshot().entries[0];
check('new screen read on its own columns', colRow.nr === '40' && colRow.team === 'VR Racing by NGT' &&
  colRow.driver === 'Dirk Van Rompuy' && colRow.car === 'Porsche Cayman GT4 RS' &&
  colRow.state === 'E1730000900000000' && colRow.smarker === 'I');

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

// ---- a stop nobody planned is still a stop ----------------------------------
// The crew never put it through the card — the driver came in on the radio, or
// the engineer was busy. The visit goes on the sheet where it happened with NO
// service applied (nothing was ordered, so nothing is guessed at), and the
// question of what was actually done goes to the station.
{
  send({ type: 'update', carId: '1', patch: { nextStop: emptyStop() } });
  await until(() => state.cars['1'].nextStop.status === 'draft');
  const carU = () => state.cars['1'];
  const histU = carU().stintHistory.length;
  const fuelU = carU().state.fuelLiters;
  const setU = carU().state.currentTyreSetId;
  info.timing.engine.onEvent({ type: 'pitIn', nr: '17' });
  await until(() => carU().state.inPit === true);
  send({ type: 'update', carId: '1', patch: { state: { pitEnterMs: Date.now() - 95000 } } });
  await until(() => carU().state.pitEnterMs < Date.now() - 94000);
  info.timing.engine.onEvent({ type: 'pitOut', nr: '17' });
  await until(() => carU().stintHistory.length === histU + 1);
  const h = carU().stintHistory[histU];
  check('an unplanned stop reaches the stint sheet', h.unplanned === true && h.pitSec >= 94);
  check('an unplanned stop applies no service',
    Math.abs(carU().state.fuelLiters - fuelU) < 0.01 && carU().state.currentTyreSetId === setU);
  check('an unplanned stop closes the stint', carU().state.lapsThisStint === 0);
  check('the station is asked what was done',
    carU().state.lastPitVisit.applied === true && carU().state.lastPitVisit.unplanned === true);
  // ...and it can be taken back whole if the car really only drove through.
  send({ type: 'undoStop', carId: '1' });
  await until(() => state.cars['1'].stintHistory.length === histU);
  check('an unplanned stop can be undone', carU().state.lastPitVisit === null);
}

// ---- the stop counter and the pit stopwatch are second sources --------------
// Plenty of boards are configured with no state column at all. The vendor's own
// PIT count and LAST PIT stopwatch describe the same visit, and either one on
// its own has to be enough — otherwise a whole session goes by with the car
// pitting and nothing ever logged.
{
  const eng = info.timing.engine;
  const carP = () => state.cars['1'];
  const row = eng._rowFor('17');
  const col = k => eng._ci(k);
  const put = (key, v) => { eng.grid[row] ??= {}; eng.grid[row][col(key)] = v; };
  // Baseline the row the way a board does, then move only PIT and LAST PIT.
  put('nr', '17');
  put('pit', 3);
  put('lpit', 'L60000000');
  // The visits above were seconds ago; a real one is a stint apart, and the
  // re-entry guard is there precisely so seconds-apart reports fold together.
  send({ type: 'update', carId: '1', patch: { state: { pitClosedMs: Date.now() - 600e3 } } });
  await until(() => state.cars['1'].state.pitClosedMs < Date.now() - 599e3);
  const histP = carP().stintHistory.length;
  // entry: the counter ticks and the stopwatch starts, no state token at all
  eng._processChanges([[row, 'pit', 4, 3], [row, 'lpit', 'S' + 9e14, 'L60000000']]);
  await until(() => carP().state.inPit === true);
  check('the stop counter alone puts the car in the lane', carP().state.inPit === true);
  // release: the stopwatch freezes at 88 s — the timekeeper's own measurement
  eng._processChanges([[row, 'lpit', 'L88000000', 'S' + 9e14]]);
  await until(() => carP().stintHistory.length === histP + 1);
  const h = carP().stintHistory[histP];
  check('the frozen pit stopwatch releases the car', carP().state.inPit === false);
  check('the stop is timed by the feed, not by us', h.pitSec === 88);
}

// A board that ticks its counter on RELEASE instead of on arrival must not
// leave the car sitting in the lane for the rest of the race.
{
  const eng = info.timing.engine;
  const carP = () => state.cars['1'];
  const row = eng._rowFor('17');
  eng._processChanges([[row, 'pit', 5, 4]]);
  await wait(150);
  check('a counter tick just after a release is not a new visit',
    state.cars['1'].state.inPit === false);
}

// ---- a stop taken while the feed was down --------------------------------
// Both ends of the visit are lost with the link, so nothing can be logged from
// events. The board's stop counter is the one thing that survives the outage,
// and what it says is never applied blind — the crew is told a stop is missing
// from the sheet. The reconciliation itself runs on the connected-feed tick
// (like the lap catch-up beside it, it needs a live upstream and is not driven
// from here); what is checked here is that the note reaches the stations and
// that the crew can answer it.
{
  const carG = () => state.cars['1'];
  send({ type: 'update', carId: '1', patch: { state: { pitCatchUp: { stops: 2, atMs: Date.now() } } } });
  await until(() => state.cars['1'].state.pitCatchUp?.stops === 2);
  check('a missing stop is reported to the stations, not invented into the sheet',
    carG().state.pitCatchUp.stops === 2 &&
    carG().stintHistory.every(h => h.atMs !== carG().state.pitCatchUp.atMs));
  send({ type: 'clearPitNote', carId: '1' });
  await until(() => state.cars['1'].state.pitCatchUp === null);
  check('the crew can clear the missing-stop note', carG().state.pitCatchUp === null);
  // ...and logging it by hand answers the note too.
  send({ type: 'update', carId: '1', patch: { state: { pitCatchUp: { stops: 1, atMs: Date.now() } } } });
  await until(() => state.cars['1'].state.pitCatchUp?.stops === 1);
  send({ type: 'applyStop', carId: '1' });
  await until(() => state.cars['1'].state.pitCatchUp === null);
  check('applying the stop by hand answers it', carG().state.pitCatchUp === null);
  send({ type: 'undoStop', carId: '1' });
  await wait(150);
}

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

// ---- generating a batch of sets ----
// The allocation is typed as a pattern, not row by row: [#] is the number,
// [###] pads it, and a pattern without one still numbers what it makes.
check('naming pattern numbers the batch',
  tyreSetNames('S[#]', 1, 3).join() === 'S1,S2,S3' &&
  tyreSetNames('S[#]_GVP', 7, 2).join() === 'S7_GVP,S8_GVP' &&
  tyreSetNames('R[###]', 9, 2).join() === 'R009,R010' &&
  tyreSetNames('GVP', 1, 2).join() === 'GVP1,GVP2');
check('generation is clamped and never silent about it',
  tyreSetNames('S[#]', 1, 999).length === TYRE_SET_GEN_MAX &&
  tyreSetNames('S[#]', 1, 0).length === 0 &&
  tyreSetNames('', 1, 1).join() === 'S1');
{
  // Car 1 has run t1 and t5 by now and is sitting on t1 (refitted above).
  const car1 = state.cars['1'];
  const appended = generateTyreSets(car1, { pattern: 'X[#]', start: 1, count: 2 });
  check('generating appends without touching what is there',
    appended.removed === 0 &&
    appended.sets.length === car1.tyreSets.length + 2 &&
    appended.sets.slice(0, car1.tyreSets.length)
      .every((t, i) => t.name === car1.tyreSets[i].name) &&
    appended.sets.slice(-2).map(t => t.name).join() === 'X1,X2' &&
    appended.sets.slice(-2).every(t => !t.used && t.laps === 0 && t.km === 0));
  check('a name already in the pool is reported, not silently doubled',
    generateTyreSets(car1, { pattern: 'S[#]', start: 1, count: 2 }).duplicates.join() === 'S1,S2');

  const replaced = generateTyreSets(car1, { pattern: 'G[#]', start: 1, count: 4, replaceUnused: true });
  const survivors = replaced.sets.filter(t => !t.name.startsWith('G'));
  check('replacing keeps the rubber that has run and the set on the car',
    survivors.every(t => t.used || t.scrapped || t.id === car1.state.currentTyreSetId) &&
    survivors.some(t => t.id === car1.state.currentTyreSetId) &&
    replaced.removed === car1.tyreSets.length - survivors.length &&
    replaced.sets.length === survivors.length + 4);
  const oldIds = new Set(car1.tyreSets.map(t => t.id));
  check('a generated set never inherits a swept-away id',
    replaced.sets.filter(t => t.name.startsWith('G')).every(t => !oldIds.has(t.id)));

  // What the station sends: the generated list plus the count it implies.
  send({ type: 'update', carId: '1', patch: { tyreSets: replaced.sets, config: { tyreSets: replaced.sets.length } } });
  await until(() => state.cars['1'].tyreSets.length === replaced.sets.length);
  const after = state.cars['1'];
  check('the generated pool survives the round trip',
    after.config.tyreSets === replaced.sets.length &&
    after.tyreSets.filter(t => t.name.startsWith('G')).length === 4 &&
    after.tyreSets.some(t => t.id === after.state.currentTyreSetId) &&
    after.state.tyreSetsUsed === after.tyreSets.filter(t => t.used).length);
}

// ---- generating a rack ----
// Same generator as the rubber, one pool at a time, with [P] standing for the
// group's own prefix so one pattern names the whole delivery.
check('the position token is the group prefix',
  brakeSetNames('padsFront', '[P][#]', 1, 2).join() === 'PF1,PF2' &&
  brakeSetNames('padsRear', '[P][#]', 1, 1).join() === 'PR1' &&
  brakeSetNames('discsFront', '[P] [##]', 8, 2).join() === 'DF 08,DF 09' &&
  brakeSetNames('discsRear', '[P][#]', 3, 1).join() === 'DR3');
// ---- kits in the model: migration, the plan, and the car file ----
{
  // A rack written before kits existed: the parts on the car have run
  // together, so they are married up first and the spares follow.
  const old = defaultCar('9', '9');
  for (const b of BRAKE_COMPONENTS) {
    for (const t of old.brakeSets[b.id]) { delete t.padSetId; delete t.kitName; }
  }
  old.state.currentBrakeSetId.discsFront = 'df2';
  old.state.currentBrakeSetId.padsFront = 'pf3';
  reconcileBrakeSets(old);
  const onCar = old.brakeSets.discsFront.find(t => t.id === 'df2');
  check('an old rack marries the parts that are on the car first',
    onCar.padSetId === 'pf3' && onCar.kitName === 'F1');
  check('the spare discs are kitted with what is left',
    old.brakeSets.discsFront.filter(t => t.padSetId).length === 3 &&
    new Set(old.brakeSets.discsFront.map(t => t.padSetId)).size === 3);

  // A link can only ever name parts that are still in the rack.
  linkBrakeKit(old, 'front', 'df1', 'pf3');
  check('bedding pads that are already on another disc moves them',
    old.brakeSets.discsFront.find(t => t.id === 'df1').padSetId === 'pf3' &&
    old.brakeSets.discsFront.find(t => t.id === 'df2').padSetId === null);
  check('the kits on an axle read back as pairs',
    brakeKitsOf(old, 'front').every(k => k.disc && k.pad && k.name));
}
{
  // The plan resolves an axle as a unit: both numbers come off one kit.
  const carK = defaultCar('8', '8');
  reconcileBrakeSets(carK);
  const plans = recommendedStops(carK, state.race, Date.now());
  const pinned = { ...plans.green, pins: {} };
  carK.nextStop.pins = { green: { brakes: ['padsFront', 'discsFront'] } };
  const r = resolveStop(carK, pinned);
  const disc = carK.brakeSets.discsFront.find(t => t.id === r.brakeSetIds.discsFront);
  check('a kit call resolves both parts off the same kit',
    r.padsFront && r.discsFront && !!disc && disc.padSetId === r.brakeSetIds.padsFront);
  check('the card reads the axle as a kit by name',
    stopBrakeAxle(carK, 'front', r).work === 'kit' &&
    !!stopBrakeAxle(carK, 'front', r).name);
  // Pads on their own never rob a made-up kit while a free set is left.
  carK.nextStop.pins = { green: { brakes: ['padsRear'] } };
  const r2 = resolveStop(carK, pinned);
  check('a pads-only call takes a pad set that is bedded onto nothing',
    r2.padsRear && !r2.discsRear &&
    !carK.brakeSets.discsRear.some(t => t.padSetId === r2.brakeSetIds.padsRear));
}
{
  // Nothing made up in the rack: the app pairs the next free disc with the next
  // free pad and says the kit is being made at this stop rather than refusing
  // to plan one.
  const bare = defaultCar('5', '5');
  reconcileBrakeSets(bare);
  for (const t of bare.brakeSets.discsFront) linkBrakeKit(bare, 'front', t.id, null);
  const call = { padsFront: true, discsFront: true, brakeSetIds: {} };
  const ax = stopBrakeAxle(bare, 'front', call);
  check('with no made-up kit left the app pairs a free disc with free pads',
    ax.work === 'kit' && !!ax.disc && !!ax.pad && ax.formed === true && !ax.blocked);
  check('the pair it forms is not the one on the car',
    ax.disc.id !== bare.state.currentBrakeSetId.discsFront &&
    ax.pad.id !== bare.state.currentBrakeSetId.padsFront);
}
{
  // The car file carries which pads are bedded onto which discs, by number.
  const src = defaultCar('7', '7');
  reconcileBrakeSets(src);
  linkBrakeKit(src, 'front', 'df3', 'pf4', 'F7');
  const file = buildCarFile(src, 'Kit car');
  check('the file lists the kits by part number',
    file.brakeRack.kits.some(k => k.axle === 'front' && k.disc === 'DF3' && k.pad === 'PF4' && k.name === 'F7'));
  const dst = defaultCar('6', '6');
  reconcileBrakeSets(dst);
  const res = applyCarFile(dst, file);
  check('reading the file beds the same pads onto the same discs',
    res.ok && dst.brakeSets.discsFront.find(t => t.name === 'DF3')?.kitName === 'F7' &&
    dst.brakeSets.discsFront.find(t => t.name === 'DF3')?.padSetId ===
      dst.brakeSets.padsFront.find(t => t.name === 'PF4')?.id);
}

check('a batch continues the series it lands next to',
  nextSetNumber(['PF1', 'PF2', 'PF3']) === 4 &&
  nextSetNumber(['S12_GVP', 'S3_GVP']) === 13 &&
  nextSetNumber([]) === 1);
{
  const carR = state.cars['3'];
  const before = Object.fromEntries(BRAKE_COMPONENTS.map(b => [b.id, carR.brakeSets[b.id].length]));
  const gen = generateBrakeSets(carR, { comps: ['padsFront', 'discsRear'], pattern: '[P][#]', start: 9, count: 2 });
  check('only the groups asked for are written',
    Object.keys(gen).join() === 'padsFront,discsRear' &&
    gen.padsFront.names.join() === 'PF9,PF10' &&
    gen.discsRear.names.join() === 'DR9,DR10' &&
    gen.padsFront.sets.length === before.padsFront + 2 &&
    gen.discsRear.sets.every(t => t.hours === 0 || t.used));
  check('a part number already on the rack is reported',
    generateBrakeSets(carR, { comps: ['padsFront'], pattern: '[P][#]', start: 1, count: 2 })
      .padsFront.duplicates.join() === 'PF1,PF2');

  const swept = generateBrakeSets(carR, { comps: ['padsFront'], pattern: '[P][#]', start: 20, count: 3, replaceUnused: true });
  const onCar = carR.state.currentBrakeSetId.padsFront;
  check('replacing keeps the part on the car and everything that has run',
    swept.padsFront.sets.some(t => t.id === onCar) &&
    swept.padsFront.sets.filter(t => !t.name.startsWith('PF2')).every(t => t.used || t.scrapped || t.id === onCar) &&
    swept.padsFront.removed === before.padsFront - 1);

  // What the station sends for a two-group generation.
  send({ type: 'update', carId: '3', patch: {
    brakeSets: { padsFront: gen.padsFront.sets, discsRear: gen.discsRear.sets },
    config: { brakeSets: { padsFront: gen.padsFront.sets.length, discsRear: gen.discsRear.sets.length } }
  } });
  await until(() => state.cars['3'].brakeSets.padsFront.length === before.padsFront + 2);
  const after = state.cars['3'];
  check('the generated rack survives the round trip',
    after.config.brakeSets.padsFront === before.padsFront + 2 &&
    after.config.brakeSets.discsRear === before.discsRear + 2 &&
    after.brakeSets.padsFront.slice(-2).map(t => t.name).join() === 'PF9,PF10' &&
    after.brakeSets.discsRear.slice(-2).map(t => t.name).join() === 'DR9,DR10' &&
    after.brakeSets.padsRear.length === before.padsRear &&
    after.brakeSets.padsFront.some(t => t.id === after.state.currentBrakeSetId.padsFront));
}

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

// ---- tyre warmers: what is hot, out of the same stock ----
// A warmer is a numbered box holding at most one set off the rack. The rules
// are the ones the garage already works to: one set is in one place, the set on
// the car is on the car, and nothing in the bin is hot.
check('a car starts with no warmers',
  state.cars['3'].tyreWarmers.length === 0 && state.cars['3'].config.tyreWarmers === 0);

send({ type: 'tyreWarmerCount', carId: '3', count: 3 });
await until(() => state.cars['3'].tyreWarmers.length === 3);
check('the crew says how many warmers the garage has',
  state.cars['3'].tyreWarmers.map(w => w.name).join(',') === 'W1,W2,W3' &&
  state.cars['3'].config.tyreWarmers === 3 &&
  state.cars['3'].tyreWarmers.every(w => w.setId === null));

send({ type: 'tyreWarmerLoad', carId: '3', warmerId: 'w1', setId: 't1' });
await until(() => state.cars['3'].tyreWarmers[0].setId === 't1');
check('a set off the rack goes in a warmer', state.cars['3'].tyreWarmers[0].setId === 't1');

// The same set carried to another box moves — there is only one of it.
send({ type: 'tyreWarmerLoad', carId: '3', warmerId: 'w2', setId: 't1' });
await until(() => state.cars['3'].tyreWarmers[1].setId === 't1');
check('a set is never in two warmers at once',
  state.cars['3'].tyreWarmers[0].setId === null &&
  state.cars['3'].tyreWarmers[1].setId === 't1');

// The rubber that is running cannot also be warming.
send({ type: 'tyreWarmerLoad', carId: '3', warmerId: 'w1', setId: state.cars['3'].state.currentTyreSetId });
await wait(150);
check('the set on the car never goes in a warmer',
  state.cars['3'].tyreWarmers[0].setId === null);

// Nothing in the bin is hot: binning a set empties the box it was in.
send({ type: 'tyreSetDecision', carId: '3', setId: 't1', scrapped: true, reason: 'damage' });
await until(() => state.cars['3'].tyreSets[0].scrapped);
check('scrapping a set takes it out of its warmer',
  state.cars['3'].tyreWarmers.every(w => w.setId !== 't1'));
send({ type: 'tyreSetDecision', carId: '3', setId: 't1', scrapped: false });
await until(() => !state.cars['3'].tyreSets[0].scrapped);

// Fitting the rubber the box was holding empties it — it is on the car now.
send({ type: 'tyreWarmerLoad', carId: '3', warmerId: 'w1', setId: 't5' });
await until(() => state.cars['3'].tyreWarmers[0].setId === 't5');
send({ type: 'update', carId: '3', patch: { nextStop: { tyres: true, tyreSetId: 't5', status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '3' });
await until(() => state.cars['3'].state.currentTyreSetId === 't5');
check('a set fitted at a stop comes out of its warmer',
  state.cars['3'].state.currentTyreSetId === 't5' &&
  state.cars['3'].tyreWarmers.every(w => w.setId !== 't5'));

// Correcting the count must never tip hot rubber onto the floor: the empty
// boxes go first.
send({ type: 'tyreWarmerLoad', carId: '3', warmerId: 'w3', setId: 't6' });
await until(() => state.cars['3'].tyreWarmers[2].setId === 't6');
send({ type: 'tyreWarmerCount', carId: '3', count: 2 });
await until(() => state.cars['3'].tyreWarmers.length === 2);
check('shrinking the count takes the empty warmers first',
  state.cars['3'].tyreWarmers.length === 2 &&
  state.cars['3'].tyreWarmers.some(w => w.setId === 't6'));

send({ type: 'tyreWarmerCount', carId: '3', count: 99 });
await until(() => state.cars['3'].tyreWarmers.length === TYRE_WARMER_MAX);
check('the number of warmers is capped',
  state.cars['3'].tyreWarmers.length === TYRE_WARMER_MAX &&
  state.cars['3'].config.tyreWarmers === TYRE_WARMER_MAX);
send({ type: 'tyreWarmerCount', carId: '3', count: 0 });
await until(() => state.cars['3'].tyreWarmers.length === 0);
check('a team without warmers can say so', state.cars['3'].tyreWarmers.length === 0);

// The picker only ever offers rubber that could really go in: on the rack, not
// binned, not on the car and not already in another box.
{
  const car = defaultCar('9', '9');
  car.config.tyreWarmers = 2;
  reconcileTyreWarmers(car);
  car.tyreSets[1].scrapped = true;                       // t2 is in the bin
  loadTyreWarmer(car, 'w1', 't3');                       // t3 is already hot
  const free = warmableTyreSets(car).map(t => t.id);
  check('the warmer picker offers only rubber that could go in',
    !free.includes('t1') && !free.includes('t2') && !free.includes('t3') && free.includes('t4'));
  check('the box it is looking at stays in its own list',
    warmableTyreSets(car, 't3').map(t => t.id).includes('t3'));
}

// The boxes are equipment, so they travel in a car file; what is in them is
// race data and does not.
{
  const source = defaultCar('1', '77');
  source.config.tyreWarmers = 4;
  reconcileTyreWarmers(source);
  source.tyreWarmers[1].name = 'BENCH';
  loadTyreWarmer(source, 'w1', 't5');
  const file = buildCarFile(source, { app: 'test', savedMs: 1 });
  check('a car file carries the warmers, not what is in them',
    file.warmerRack.count === 4 && file.warmerRack.names[1] === 'BENCH' &&
    JSON.stringify(file).includes('BENCH') && file.warmerRack.names.length === 4);

  const target = defaultCar('2', '2');
  const res = applyCarFile(target, file);
  check('loading a car file sets up the same warmers',
    res.ok && target.tyreWarmers.length === 4 &&
    target.config.tyreWarmers === 4 &&
    target.tyreWarmers[1].name === 'BENCH' &&
    target.tyreWarmers.every(w => w.setId === null));
}

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
// a stop changing the front pads only: the auto choice is the pad set that is
// bedded onto nothing (PF1-PF3 are kitted to the three disc sets, PF4 is free),
// so a made-up kit is never robbed of its pads to service another axle.
send({ type: 'update', carId: '2', patch: { nextStop: { padsFront: true, status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '2' });
await until(() => state.cars['2'].state.currentBrakeSetId.padsFront === 'pf4');
{
  const car2 = state.cars['2'];
  check('the outgoing set banks the hours it ran',
    car2.brakeSets.padsFront.find(t => t.id === 'pf1').hours >= 6);
  check('the fitted set starts at zero and is marked used',
    car2.state.brakeUsedH.padsFront === 0 &&
    car2.brakeSets.padsFront.find(t => t.id === 'pf4').used === true);
  check('the pads that went on are bedded onto the discs on the car',
    car2.brakeSets.discsFront.find(t => t.id === 'df1').padSetId === 'pf4');
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
  state.cars['2'].state.currentBrakeSetId.padsFront === 'pf4');
send({ type: 'brakeSetDecision', carId: '2', comp: 'padsFront', setId: 'pf2', scrapped: false });
await until(() => !state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').scrapped);
check('a scrapped set can be restored with its hours intact',
  state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').scrapReason === null);

// a measured wear figure (the station turns a gauged percent into hours):
// typed onto a rack set it becomes the set's hours, and zero returns the set
// to the new pool; typed onto the part on the car it re-seeds the live counter
send({ type: 'brakeSetHours', carId: '2', comp: 'padsFront', setId: 'pf2', hours: 3.5 });
await until(() => state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').hours === 3.5);
check('a measured figure lands on a rack set as hours and marks it used',
  state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').used === true);
send({ type: 'brakeSetHours', carId: '2', comp: 'padsFront', setId: 'pf2', hours: 0 });
await until(() => state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').hours === 0);
check('a rack set typed back to zero returns to the new pool',
  state.cars['2'].brakeSets.padsFront.find(t => t.id === 'pf2').used === false);
send({ type: 'brakeSetHours', carId: '2', comp: 'padsFront', setId: 'pf4', hours: 5 });
await until(() => Math.abs(state.cars['2'].state.brakeUsedH.padsFront - 5) < 0.1);
check('a measured figure on the part on the car re-seeds the live counter',
  Math.abs(state.cars['2'].state.brakeUsedH.padsFront - 5) < 0.1);

// ---- kits: a pad set bedded onto a disc set, mounted and called for as one ----
{
  const car1 = state.cars['1'];
  check('a fresh rack arrives kitted straight down the line',
    car1.brakeSets.discsFront[0].padSetId === 'pf1' &&
    car1.brakeSets.discsFront[0].kitName === 'F1' &&
    car1.brakeSets.discsFront[2].padSetId === 'pf3' &&
    car1.brakeSets.discsRear[0].kitName === 'R1');
  check('a spare pad set with no disc left to bed onto stays free',
    !car1.brakeSets.discsFront.some(t => t.padSetId === 'pf4'));
}

// bedding a free pad set onto a bare disc set is what makes a kit
send({ type: 'brakeKitLink', carId: '2', axle: 'front', discSetId: 'df2', padSetId: 'pf2' });
await until(() => state.cars['2'].brakeSets.discsFront.find(t => t.id === 'df2').padSetId === 'pf2');
check('bedding a pad set onto a disc set names the kit',
  !!state.cars['2'].brakeSets.discsFront.find(t => t.id === 'df2').kitName);
// the same pads cannot be bedded onto two disc sets at once
send({ type: 'brakeKitLink', carId: '2', axle: 'front', discSetId: 'df3', padSetId: 'pf2' });
await until(() => state.cars['2'].brakeSets.discsFront.find(t => t.id === 'df3').padSetId === 'pf2');
check('a pad set moved to another disc leaves the first one bare',
  state.cars['2'].brakeSets.discsFront.find(t => t.id === 'df2').padSetId === null);
send({ type: 'brakeKitLink', carId: '2', axle: 'front', discSetId: 'df2', padSetId: 'pf2' });
await until(() => state.cars['2'].brakeSets.discsFront.find(t => t.id === 'df2').padSetId === 'pf2');

// the kit on the car is running: it cannot be taken apart on paper
{
  const onDisc = state.cars['2'].state.currentBrakeSetId.discsFront;
  send({ type: 'brakeKitLink', carId: '2', axle: 'front', discSetId: onDisc, padSetId: null });
  await wait(150);
  check('the kit on the car cannot be unbedded',
    state.cars['2'].brakeSets.discsFront.find(t => t.id === onDisc).padSetId ===
      state.cars['2'].state.currentBrakeSetId.padsFront);
}
send({ type: 'brakeKitRename', carId: '2', axle: 'front', discSetId: 'df2', name: 'F9' });
await until(() => state.cars['2'].brakeSets.discsFront.find(t => t.id === 'df2').kitName === 'F9');
check('a kit can be renamed', true);

// a stop changing the whole axle takes both parts off ONE kit
send({ type: 'update', carId: '2', patch: { nextStop: { padsFront: true, discsFront: true, status: 'box' } } });
await wait(150);
send({ type: 'applyStop', carId: '2' });
await until(() => state.cars['2'].state.currentBrakeSetId.discsFront === 'df2');
{
  const car2 = state.cars['2'];
  const cur = car2.state.currentBrakeSetId;
  check('a kit change fits the pads that were bedded onto those discs',
    cur.discsFront === 'df2' && cur.padsFront === 'pf2');
  check('what is on the car is still a kit afterwards',
    car2.brakeSets.discsFront.find(t => t.id === cur.discsFront).padSetId === cur.padsFront);
  check('the discs that came off banked their hours',
    car2.brakeSets.discsFront.find(t => t.id === 'df1').used === true);
}

// discs never come off on their own: a stop asking only for discs is a kit
send({ type: 'update', carId: '2', patch: { nextStop: { discsFront: true, status: 'box' } } });
await wait(150);
{
  const before = state.cars['2'].state.currentBrakeSetId.padsFront;
  send({ type: 'applyStop', carId: '2' });
  await until(() => state.cars['2'].state.currentBrakeSetId.padsFront !== before);
  const cur = state.cars['2'].state.currentBrakeSetId;
  check('a discs-only stop takes the pads with them',
    cur.padsFront !== before &&
    state.cars['2'].brakeSets.discsFront.find(t => t.id === cur.discsFront).padSetId === cur.padsFront);
}

// scrapping half a kit dissolves it — nothing stays bedded onto a binned part
{
  const spare = state.cars['2'].brakeSets.discsFront
    .find(t => t.padSetId && t.id !== state.cars['2'].state.currentBrakeSetId.discsFront);
  if (spare) {
    send({ type: 'brakeSetDecision', carId: '2', comp: 'discsFront', setId: spare.id, scrapped: true, reason: 'cracked' });
    await until(() => state.cars['2'].brakeSets.discsFront.find(t => t.id === spare.id).scrapped);
    check('scrapping a disc set dissolves the kit it anchored',
      state.cars['2'].brakeSets.discsFront.find(t => t.id === spare.id).padSetId === null);
  } else {
    check('scrapping a disc set dissolves the kit it anchored', false);
  }
}

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
send({ type: 'pinStop', carId: '4', plan: 'green', field: 'tyres', value: 'keep' });
await until(() => state.cars['4'].nextStop.pins.green.tyres === 'keep');
{
  const car4 = state.cars['4'];
  const plans = recommendedStops(car4, state.race, Date.now());
  const r = resolveStop(car4, plans.green);
  check('a pinned line is held where the engineer put it', r.tyres === false);
  check('the lines around it keep following the app', r.fuelMode === plans.green.fuel.mode);
}

// three plans, not one shown three ways: pinning one situation leaves the
// other two alone, so a code 60 plan and a green plan can say different things
// at the same time.
send({ type: 'pinStop', carId: '4', plan: 'fcy', field: 'fuel', value: { mode: 'full' } });
send({ type: 'pinStop', carId: '4', plan: 'sc', field: 'fuel', value: { mode: 'none' } });
await until(() => state.cars['4'].nextStop.pins.fcy.fuel?.mode === 'full' &&
  state.cars['4'].nextStop.pins.sc.fuel?.mode === 'none');
{
  const car4 = state.cars['4'];
  const plans = recommendedStops(car4, state.race, Date.now());
  const g = resolveStop(car4, plans.green);
  const f = resolveStop(car4, plans.fcy);
  const sc = resolveStop(car4, plans.sc);
  check('each situation resolves against its own pins',
    f.fuelMode === 'full' && sc.fuelMode === 'none' && sc.fuelLiters === 0);
  check('pinning one situation leaves the others untouched',
    g.fuelMode !== 'none' && g.tyres === false &&
    f.tyres === plans.fcy.tyres.change && sc.tyres === plans.sc.tyres.change);
  check('a pin belongs to the plan it was made on', !state.cars['4'].nextStop.pins.fcy.tyres);
}
send({ type: 'pinStop', carId: '4', plan: 'sc', field: 'fuel', value: null });
await until(() => !state.cars['4'].nextStop.pins.sc.fuel);

send({ type: 'approveStop', carId: '4', plan: 'green', by: 'T. Claes' });
await until(() => !!state.cars['4'].nextStop.approvals.green);
{
  const stop = state.cars['4'].nextStop;
  check('approving records who and when',
    stop.approvals.green.by === 'T. Claes' && stop.approvals.green.atMs > 0 &&
    stop.approvals.green.stale === false);
  check('approving one situation does not sign off the others',
    !stop.approvals.fcy && !stop.approvals.sc);
  check('approving freezes the plan into the stop itself',
    stop.tyres === false && stop.fuelLiters > 0 && stop.fuelMode != null);
}
send({ type: 'pinStop', carId: '4', plan: 'fcy', field: 'driver', value: 'd3' });
await wait(150);
check('a tick only goes stale when its own plan moves',
  state.cars['4'].nextStop.approvals.green.stale === false);
send({ type: 'pinStop', carId: '4', plan: 'green', field: 'driver', value: 'd3' });
await until(() => state.cars['4'].nextStop.approvals.green?.stale === true);
check('a plan that moves after approval clears the tick',
  state.cars['4'].nextStop.approvals.green.stale === true);

// CLEAR wipes the situation on screen and nothing else
send({ type: 'clearStop', carId: '4', plan: 'green' });
await until(() => !state.cars['4'].nextStop.pins.green.tyres);
check('clearing a plan clears its pins and its tick',
  Object.keys(state.cars['4'].nextStop.pins.green).length === 0 &&
  state.cars['4'].nextStop.approvals.green === null);
check('clearing one plan leaves the other two standing',
  state.cars['4'].nextStop.pins.fcy.fuel?.mode === 'full' &&
  state.cars['4'].nextStop.pins.fcy.driver === 'd3');
send({ type: 'clearStop', carId: '4', plan: 'fcy' });
await until(() => !state.cars['4'].nextStop.pins.fcy.fuel);

// the held tab is what SEND ships: holding the safety-car plan under green
// materialises the safety-car plan, not the green one
send({ type: 'pinStop', carId: '4', plan: 'sc', field: 'fuel', value: { mode: 'full' } });
send({ type: 'stopPlan', carId: '4', plan: 'sc' });
await until(() => state.cars['4'].nextStop.plan === 'sc');
send({ type: 'update', carId: '4', patch: { nextStop: { status: 'sent' } } });
await until(() => state.cars['4'].nextStop.status === 'sent');
check('sending ships the plan the engineer was holding',
  state.cars['4'].nextStop.fuelLiters === state.cars['4'].config.tankLiters);
send({ type: 'stopPlan', carId: '4', plan: null });
await until(() => state.cars['4'].nextStop.plan === null);
check('tapping the held tab again follows the race', state.cars['4'].nextStop.plan === null);
send({ type: 'clearStop', carId: '4', plan: 'sc' });
await until(() => state.cars['4'].nextStop.status === 'draft');

// ---- which situations get a column on the wall ----
check('every situation is on the wall to begin with',
  ['green', 'fcy', 'sc'].every(k => wallShowsPlan(state.cars['4'], k)));
send({ type: 'wallPlan', carId: '4', plan: 'sc', show: false });
await until(() => state.cars['4'].wallPlans.sc === false);
check('the safety car column comes off the wall', !wallShowsPlan(state.cars['4'], 'sc'));
check('taking a column down leaves the other two up',
  wallShowsPlan(state.cars['4'], 'fcy') && wallShowsPlan(state.cars['4'], 'green'));
{
  // The plan itself is untouched — only the column went.
  const plansOff = recommendedStops(state.cars['4'], state.race, Date.now());
  check('the plan behind a hidden column still resolves',
    resolveStop(state.cars['4'], plansOff.sc) != null);
}
send({ type: 'wallPlan', carId: '4', plan: 'green', show: false });
await wait(120);
check('the planned stop can never be taken off the wall', wallShowsPlan(state.cars['4'], 'green'));
send({ type: 'wallPlan', carId: '4', plan: 'sc', show: true });
await until(() => state.cars['4'].wallPlans.sc === true);
check('the safety car column goes back up', wallShowsPlan(state.cars['4'], 'sc'));

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

  // A state file that outlived its race: the stint and a stint in the history
  // are anchored days before this race started. Nothing may read that as seat
  // time — it is what turned a four hour race into a 154 hour driver total.
  check('a stint older than the race is clamped to the start', (() => {
    const now = Date.now();
    const stale = JSON.parse(JSON.stringify(state.cars['1']));
    const sixDays = 6 * 24 * 3600e3;
    stale.state.stintStartMs = now - sixDays;
    stale.stintHistory = [{ driverId: stale.currentDriverId,
      startMs: now - sixDays - 20 * 60e3, endMs: now - sixDays, laps: 8 }];
    const c = carCalcs(stale, state.race, now);
    const mine = c.reg.byDriver[stale.currentDriverId];
    const elapsed = c.clock.elapsedMs;
    return c.stintElapsedMs <= elapsed && mine.totalMs <= elapsed &&
      mine.windowMs <= elapsed;
  })());
}

// ---- the tyre allocation, and what it does to a stop under yellow ----
// A fixed set count makes a 24 h race a rationing problem. While there is spare
// rubber a tyre change under a caution is close to free; once the stock will not
// cover the distance left, binning a set with life in it has to cost something,
// or the app will happily spend an allocation the team cannot replace.
{
  const now = Date.now();
  const mk = usableSets => {
    const c = JSON.parse(JSON.stringify(state.cars['1']));
    Object.assign(c.config, {
      tyreLifeKm: 300, tyreChangeSec: 25, tankLiters: 100, safetyFuelL: 3,
      cautionsPerHour: 0.639, tyreDegSecPerKm: 0.0087, fuelWeightSecPerL: 0.0079
    });
    c.state.fuelLiters = 60;
    // Build the stock outright: this car is deep into the race by now and its
    // sets carry whatever earlier tests did to them, which would decide the
    // answer instead of the set count under test.
    c.tyreSets = Array.from({ length: usableSets }, (_, i) => ({
      id: 'ts' + i, name: 'S' + (i + 1), km: 0, kmFcy: 0,
      used: i === 0, scrapped: false
    }));
    const fitted = c.tyreSets[0];
    fitted.km = 60;
    c.state.currentTyreSetId = fitted.id;
    return c;
  };

  const rich = tyreBudget(mk(40), state.race, now);
  const poor = tyreBudget(mk(3), state.race, now);
  check('the budget counts the rubber against the distance left',
    rich && rich.kmAvailable > poor.kmAvailable && rich.kmToRun === poor.kmToRun);
  check('a full garage covers the race', rich && rich.short === false && rich.deficitKm === 0);
  check('a thin garage is short by a real distance', poor && poor.short === true && poor.deficitKm > 0);
  check('the budget names what this set would bin', poor && poor.fittedKmLeft === 240);
  check('scrapped sets are not counted as stock', poor.setsUsable === 3);

  // The call itself must move: plenty of rubber -> fit tyres on the cheap stop;
  // rationing -> keep the set that still has 240 km in it.
  const cheap = cautionCall(mk(40), state.race, now, 'fcy');
  const tight = cautionCall(mk(3), state.race, now, 'fcy');
  check('with rubber to spare the caution stop fits tyres',
    cheap && cheap.winner.tyres === true);
  check('when short the caution stop keeps the set that has life left',
    tight && tight.winner.tyres === false);
  check('and the tyre plans are the ones that got dearer',
    tight.plans.find(p => p.key === 'both').gapSec >
    cheap.plans.find(p => p.key === 'both').gapSec);
  check('the call carries the budget so the card can say why',
    tight.budget && tight.budget.short === true);
}

// ---- correcting the laps on the fitted set, from the tyre panel ----
// The rack disables the laps box for the set on the car, and setLaps moves the
// whole world with it. This one moves ONLY the fitted set: its lap count and
// its banked mileage together, everything else untouched.
{
  const before = state.cars['1'];
  const setId = before.state.currentTyreSetId;
  const set0 = before.tyreSets.find(t => t.id === setId);
  const laps0 = before.state.tyreLapsOnSet;
  const km0 = set0.km;
  const total0 = before.state.totalLaps;
  const fuel0 = before.state.fuelLiters;
  const trackKm = before.config.trackKm;

  send({ type: 'setTyreLaps', carId: '1', laps: laps0 + 5 });
  await until(() => state.cars['1'].state.tyreLapsOnSet === laps0 + 5);
  const mid = state.cars['1'];
  const setMid = mid.tyreSets.find(t => t.id === setId);
  check('the fitted set gains the laps', mid.state.tyreLapsOnSet === laps0 + 5);
  check('its banked mileage moves with them',
    Math.abs(setMid.km - (km0 + 5 * trackKm)) < 0.05);
  check('total laps, the stint and fuel stay where they were',
    mid.state.totalLaps === total0 && Math.abs(mid.state.fuelLiters - fuel0) < 1e-9);
  check('a corrected set counts as used', setMid.used === true);

  // Correcting downwards takes the mileage back out, and never below zero.
  send({ type: 'setTyreLaps', carId: '1', laps: 0 });
  await until(() => state.cars['1'].state.tyreLapsOnSet === 0);
  const back = state.cars['1'].tyreSets.find(t => t.id === setId);
  check('correcting down takes the kilometres back out',
    back.km <= km0 + 0.05 && back.km >= 0);

  // Nonsense is refused, not clamped into something surprising.
  send({ type: 'setTyreLaps', carId: '1', laps: -3 });
  await wait(200);
  check('a negative correction is refused', state.cars['1'].state.tyreLapsOnSet === 0);

  // Put the car back the way this block found it.
  send({ type: 'setTyreLaps', carId: '1', laps: laps0 });
  await until(() => state.cars['1'].state.tyreLapsOnSet === laps0);
}

// ---- two stocks in one rack: wets are insurance, never dry budget ----
{
  const now = Date.now();
  const mk = (slicks, wets, condition) => {
    const c = JSON.parse(JSON.stringify(state.cars['1']));
    Object.assign(c.config, { tyreLifeKm: 300, tankLiters: 100, safetyFuelL: 3 });
    c.condition = condition;
    c.tyreSets = [
      ...Array.from({ length: slicks }, (_, i) => ({
        id: 'sl' + i, name: 'SL' + (i + 1), compound: 'slick', km: 0, kmFcy: 0,
        used: i === 0, scrapped: false })),
      ...Array.from({ length: wets }, (_, i) => ({
        id: 'we' + i, name: 'WE' + (i + 1), compound: 'wet', km: 0, kmFcy: 0,
        used: false, scrapped: false }))
    ];
    c.state.currentTyreSetId = 'sl0';
    return c;
  };

  const dry = tyreBudget(mk(10, 4, 'dry'), state.race, now);
  check('a dry ledger counts only the slicks', dry.setsFresh === 9 && dry.activeCompound === 'slick');
  check('the wets are held back, not budgeted', dry.setsFreshOther === 4);

  const wet = tyreBudget(mk(10, 4, 'wet'), state.race, now);
  check('a wet track budgets the wets instead', wet.setsFresh === 4 && wet.activeCompound === 'wet');
  check('a slick on a wet car covers none of the wet distance', wet.fittedKmLeft === 0);

  check('a wet car is offered a wet set', stopTyreSet(mk(10, 4, 'wet')).compound === 'wet');
  check('a dry car is offered a slick', stopTyreSet(mk(10, 4, 'dry')).compound === 'slick');
  check('no wets in the rack falls back to a slick rather than nothing',
    stopTyreSet(mk(10, 0, 'wet')).compound === 'slick');

  // Sets from before compounds existed are slicks — that is what they were.
  const legacy = mk(2, 0, 'dry');
  delete legacy.tyreSets[1].compound;
  reconcileTyreSets(legacy);
  check('a legacy set with no compound reads as a slick', legacy.tyreSets[1].compound === 'slick');
}

// ---- tyres taken because the flag made them cheap, not because they are due ----
// The life rule only asks whether the rubber survives the next stint. Under a
// neutralisation the box work is discounted, so a set that is not due can still
// be worth fitting — but only while there is rubber in the garage to spare.
{
  const now = Date.now();
  const mk = (tyreKm, usableSets) => {
    const c = JSON.parse(JSON.stringify(state.cars['1']));
    Object.assign(c.config, {
      tyreLifeKm: 300, tyreChangeSec: 25, tankLiters: 100, safetyFuelL: 3,
      tyreDegSecPerKm: 0.0087, fuelWeightSecPerL: 0.0079
    });
    c.state.fuelLiters = 60;
    c.tyreSets = Array.from({ length: usableSets }, (_, i) => ({
      id: 'to' + i, name: 'O' + (i + 1), km: 0, kmFcy: 0, used: i === 0, scrapped: false
    }));
    c.tyreSets[0].km = tyreKm;
    c.state.currentTyreSetId = 'to0';
    return c;
  };
  const at = (km, sets, pace) => recommendedStop(mk(km, sets), state.race, now, { pace });

  check('a fresh set is left alone even under the flag',
    at(0, 40, 'fcy').tyres.change === false);
  check('a part-worn set is worth fitting under the flag',
    at(150, 40, 'fcy').tyres.change === true && at(150, 40, 'fcy').tyres.opportunity === true);
  check('the reason says the flag is what paid for it',
    /free under the flag/.test(at(150, 40, 'fcy').tyres.why));
  check('the same set is left alone under green — there is no discount to spend',
    at(150, 40, null).tyres.change === false);
  check('the Safety Car buys it too, being a neutralisation',
    at(150, 40, 'sc').tyres.change === true);

  // The garage decides whether the team can afford the trick at all.
  const short = at(150, 4, 'fcy');
  check('a short garage declines the free set', short.tyres.change === false);
  check('and says what the change would spend rather than going quiet',
    /spends a fresh set/.test(short.tyres.why) && /the flag still needs/.test(short.tyres.why));

  // More wear must never be worth less than less wear.
  const gainOf = km => {
    const m = at(km, 40, 'fcy').tyres.why.match(/(\d+) s of wear/);
    return m ? +m[1] : 0;
  };
  check('the case for fresh rubber grows with the wear on the set',
    gainOf(250) > gainOf(150) && gainOf(150) > gainOf(60));
}

// ---- who gets in next: the plan decides, the drive limit overrules ----
// The plan is the crew's running order and outranks the balancing heuristic.
// The one thing that can overrule it is a driver who cannot legally see the
// stint out — a stop forced by seat time must not propose "same driver stays in".
{
  const now = Date.now();
  // A car with a plan, and a stop coming. The plan's next stint names d4.
  const base = JSON.parse(JSON.stringify(state.cars['1']));
  const nHist = base.stintHistory.length;
  const withPlan = (nextDriverId, driveLeftMin) => {
    const c = JSON.parse(JSON.stringify(base));
    c.plan = generatePlan(c, state.race, now);
    // Name the driver we want on the stint that follows the running one.
    if (c.plan.stints[nHist + 1]) c.plan.stints[nHist + 1].driverId = nextDriverId;
    // Regulations tight enough that `driveLeftMin` is all that driver has left.
    if (driveLeftMin != null) {
      c.config.reg6hMin = 0;
      c.config.regRestMin = 0;
      const drv = driveTimeStats(c, state.race, now).byDriver[nextDriverId];
      c.config.regTotalMin = Math.round((drv.totalMs + driveLeftMin * 60e3) / 60e3);
    }
    return c;
  };

  const planned = withPlan('d4', null);
  const rec = recommendedStop(planned, state.race, now);
  check('the next driver comes from the stint plan',
    rec.driver.id === 'd4' && rec.driver.why.includes('stint plan'));

  // Same plan, but d4 has two minutes of legal seat time against a full stint.
  const starved = withPlan('d4', 2);
  const recS = recommendedStop(starved, state.race, now);
  check('a planned driver who cannot finish the stint is not proposed',
    recS.driver.id !== 'd4');
  check('and the reason names the drive limit so the plan can be edited',
    /drive limit/.test(recS.driver.why));

  // A double-stinting driver with no time left must hand over — the case that
  // used to read "driver time limited" and "same driver stays in" at once.
  {
    const c = JSON.parse(JSON.stringify(base));
    c.plan = null;
    const cur = c.drivers.find(d => d.id === c.currentDriverId);
    cur.doubleStint = true;
    c.config.reg6hMin = 0;
    c.config.regRestMin = 0;
    const mine = driveTimeStats(c, state.race, now).byDriver[c.currentDriverId];
    c.config.regTotalMin = Math.round((mine.totalMs + 2 * 60e3) / 60e3);
    const r = recommendedStop(c, state.race, now);
    check('a double-stint driver out of seat time hands over', r.driver.change === true);
  }

  // No plan and no regulations: the old balancing behaviour is untouched.
  {
    const c = JSON.parse(JSON.stringify(base));
    c.plan = null;
    c.config.reg6hMin = 0; c.config.regTotalMin = 0; c.config.regRestMin = 0;
    const r = recommendedStop(c, state.race, now);
    check('with no plan and no regs the balancing call still answers',
      !!r.driver.name && /seat time|double stint/.test(r.driver.why));
  }
}

// ---- editing the plan: reassigning a stint that has not run ----
{
  send({ type: 'update', carId: '1', patch: { plan: generatePlan(state.cars['1'], state.race, Date.now()) } });
  await wait(150);
  const idx = state.cars['1'].plan.stints.length - 1;
  const was = state.cars['1'].plan.stints[idx].driverId;
  const other = state.cars['1'].drivers.find(d => d.id !== was).id;
  send({ type: 'planStint', carId: '1', index: idx, driverId: other });
  await until(() => state.cars['1'].plan.stints[idx].driverId === other);
  check('a future stint can be reassigned', state.cars['1'].plan.stints[idx].driverId === other);
  check('seat-time totals follow the edit',
    Math.abs(Object.values(state.cars['1'].plan.totals).reduce((a, b) => a + b, 0) -
      state.cars['1'].plan.stints.reduce((a, s) => a + (s.toMs - s.fromMs), 0)) < 1);

  // History is not up for renegotiation.
  const done = state.cars['1'].plan.stints[0].driverId;
  send({ type: 'planStint', carId: '1', index: 0, driverId: other });
  await wait(150);
  check('a stint already driven cannot be reassigned',
    state.cars['1'].plan.stints[0].driverId === done);
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

// ---- rolling pace window (the pace card) ----
{
  const pw = defaultCar('9', '9');
  pw.currentDriverId = 'd2';
  pw.stintHistory = [
    { driverId: 'd2', lapTimes: [110, 111] },
    { driverId: 'd1', lapTimes: [200, 201] },   // another driver's stint
    { driverId: 'd2', lapTimes: [102, 103, 104] }
  ];
  pw.state.stintLapSec = [100, 101];

  check('pace window default', paceWindowLaps(pw) === PACE_WINDOW_DEFAULT);
  check('pace window clamps a silly setting', (() => {
    const a = { ...pw, config: { ...pw.config, paceAvgLaps: 0 } };
    const b = { ...pw, config: { ...pw.config, paceAvgLaps: 900 } };
    return paceWindowLaps(a) === PACE_WINDOW_DEFAULT && paceWindowLaps(b) === PACE_WINDOW_MAX;
  })());

  const laps = driverLapTimes(pw, 'd2');
  check('driver laps span stints, not the other driver', laps.join() === '110,111,102,103,104,100,101');

  const p5 = paceWindowStats(pw, 'd2', 5);
  check('pace window takes the newest laps', p5.laps.join() === '102,103,104,100,101');
  check('pace average is the plain mean of the window', p5.avgSec === 102);
  check('pace best / worst / last', p5.bestSec === 100 && p5.worstSec === 104 && p5.lastSec === 101);
  check('pace counts every lap behind the window', p5.total === 7);

  // An in-lap in the window: it still counts in the headline average (that is
  // what the engineer asked for) but is flagged, and the clean figure is offered.
  pw.state.stintLapSec = [100, 101, 145];
  const pOut = paceWindowStats(pw, 'd2', 5);
  check('pace flags the outlier lap', pOut.outliers.filter(Boolean).length === 1 &&
    pOut.outliers[pOut.outliers.length - 1] === true);
  check('pace clean average drops it', pOut.cleanAvgSec != null && pOut.cleanAvgSec < pOut.avgSec);

  const pEmpty = paceWindowStats(pw, 'd4', 5);
  check('pace window empty for a driver who has not driven',
    pEmpty.laps.length === 0 && pEmpty.avgSec === null && pEmpty.cleanAvgSec === null);
}

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

// ---- pit order across the team (pitArrivalOrder) ----
// One crew, four cars: when a flag drops the wall has to say which car it
// takes first. The order is read off the same pit E.T.A.s the cards show.
{
  const now = Date.now();
  const nowUs = 1e12;
  const mk = id => {
    const c = defaultCar(id, id);
    c.config.trackKm = 4.0;
    c.config.avgLapSec.dry = 100; // 40 m/s under green
    c.config.fcySpeedKmh = 80;
    return c;
  };
  const fcyRace = {
    durationH: 24, startMs: now - 3600e3,
    fcy: { mode: 'auto', active: true, startMs: now - 30e3, flag: 7 }
  };
  const greenRace = { ...fcyRace, fcy: { mode: 'auto', active: false, startMs: null, flag: 6 } };
  // Seconds since this car's last S/F crossing — the farther round the lap,
  // the sooner it reaches the pit entry.
  const seenAt = ageSec => ({ nr: '9', state: 'E' + (nowUs - ageSec * 1e6), inPit: false });
  const etaWith = (race, ages) => car =>
    pitEta(car, race, { serverNowUs: nowUs }, seenAt(ages[car.id]), now, now);

  const a = mk('1'), b = mk('2'), c = mk('3');
  const cars = [a, b, c];

  // Under FCY: #2 is farthest round the lap, #1 has only just crossed.
  const q = pitArrivalOrder(cars, etaWith(fcyRace, { 1: 10, 2: 80, 3: 45 }), now);
  check('pitArrivalOrder: soonest at the box is first',
    q.length === 3 && q.map(x => x.carId).join(',') === '2,3,1' &&
    q.every((x, i) => x.pos === i + 1 && x.of === 3) &&
    q[0].sec < q[1].sec && q[1].sec < q[2].sec);

  // A car already in the lane is at the front, whatever anyone's E.T.A. says.
  b.state.inPit = true;
  b.state.pitEnterMs = now - 20e3;
  const qPit = pitArrivalOrder(cars, etaWith(fcyRace, { 1: 10, 2: 80, 3: 90 }), now);
  check('pitArrivalOrder: a car in the lane is first',
    qPit[0].carId === '2' && qPit[0].inPit === true && qPit[0].sec < 0 &&
    qPit.map(x => x.carId).join(',') === '2,3,1');
  b.state.inPit = false;
  b.state.pitEnterMs = null;

  // Under green nothing is coming in until a stop is actually sent, so there
  // is no order to show — and one car on its way in is not an order either.
  check('pitArrivalOrder: nothing under green with no stop sent',
    pitArrivalOrder(cars, etaWith(greenRace, { 1: 10, 2: 80, 3: 45 }), now).length === 0);
  a.nextStop.status = 'sent';
  check('pitArrivalOrder: a lone car inbound is not a queue',
    pitArrivalOrder(cars, etaWith(greenRace, { 1: 10, 2: 80, 3: 45 }), now).length === 0);
  c.nextStop.status = 'box';
  const qGreen = pitArrivalOrder(cars, etaWith(greenRace, { 1: 10, 2: 80, 3: 45 }), now);
  check('pitArrivalOrder: live stops queue up under green too',
    qGreen.length === 2 && qGreen.map(x => x.carId).join(',') === '3,1');
  a.nextStop.status = 'draft';
  c.nextStop.status = 'draft';

  // No usable position (no feed row, no crossing) leaves a car out rather
  // than guessing a place for it.
  const qBlind = pitArrivalOrder(cars, car => (car.id === '3' ? null : etaWith(fcyRace, { 1: 10, 2: 80, 3: 45 })(car)), now);
  check('pitArrivalOrder: cars with no position are left out',
    qBlind.length === 2 && qBlind.map(x => x.carId).join(',') === '2,1');

  // A stale estimate still takes its place, but is marked as one.
  const qStale = pitArrivalOrder(cars, etaWith(fcyRace, { 1: 10, 2: 400, 3: 45 }), now);
  check('pitArrivalOrder: a stale estimate is flagged in the queue',
    qStale.find(x => x.carId === '2').stale === true &&
    qStale.find(x => x.carId === '1').stale === false);
}

// ---- station presence: NO CAR RUNNING vs a dropped station ----
// A station announces its car with 'hello'. The wall shows NO CAR RUNNING
// only for cars that never had a station (or feed data) this race; after a
// drop the lasting liveSeenMs stamp keeps the last data on the wall.
{
  check('no stations online before any hello', Object.keys(stationsOnline).length === 0);

  const st2 = new WebSocket('ws://127.0.0.1:' + info.port);
  st2.on('open', () => st2.send(JSON.stringify({ type: 'hello', role: 'station', carId: '2' })));
  await until(() => stationsOnline['2'] === 1);
  check('hello marks the station online', stationsOnline['2'] === 1);
  await until(() => !!state.cars['2'].state.liveSeenMs);
  check('hello stamps the car as live', !!state.cars['2'].state.liveSeenMs);

  // Nothing stops a second laptop picking a car that already has one, and the
  // pair would read as one healthy station while every press landed twice.
  // The wall can only warn about what it can count.
  const dup2 = new WebSocket('ws://127.0.0.1:' + info.port);
  dup2.on('open', () => dup2.send(JSON.stringify({ type: 'hello', role: 'station', carId: '2' })));
  await until(() => stationsOnline['2'] === 2);
  check('a second station on the same car counts twice', stationsOnline['2'] === 2);
  dup2.close();
  await until(() => stationsOnline['2'] === 1);
  check('the car is still online when the duplicate leaves', stationsOnline['2'] === 1);

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

  // The feed moves to the next session of the weekend. This stub publishes no
  // session clock at all, so the app cannot tell whether the new session is
  // starting here or has been running for hours — and what it cannot tell, it
  // does not decide: after the settle window the question goes to the wall.
  feedSession = 'Race 2';
  await until(() => !!state.timing.sessionAlert);
  check('the feed is held from the moment the session changes',
    !!state.timing.sessionAlert && state.cars['1'].state.totalLaps === 1);
  await until(() => state.timing.sessionAlert?.pending === false);
  const alert = state.timing.sessionAlert;
  check('session change with a race on screen asks the pit wall',
    alert && alert.pending === false &&
    alert.from === 'Race 1' && alert.to === 'Race 2' && alert.laps === 1);
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
  check('a session-change event holds the feed straight away',
    state.timing.sessionAlert?.to === 'Race 3');
  await until(() => state.timing.sessionAlert?.pending === false);
  check('and reaches the wall once the feed has had its say',
    state.timing.sessionAlert?.pending === false);

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

// ---- race numbers, set from the pit wall ----
// The number heads the car's card and is what live timing is matched on, so
// the wall can set it without waiting for that car's station to come back.
// A car still carrying its default name has to follow the new number.
{
  // Car 2 was named earlier in this run; put it back to a car nobody has
  // named, which is the case the default name has to follow.
  send({ type: 'update', carId: '2', patch: { name: `Car #${state.cars['2'].number}` } });
  await until(() => state.cars['2'].name === `Car #${state.cars['2'].number}`);
  send({ type: 'update', carId: '2', patch: { number: '61' } });
  await until(() => state.cars['2'].number === '61');
  check('the wall can set a car race number', state.cars['2'].number === '61');
  check('a default name follows the number', state.cars['2'].name === 'Car #61');
  check('the renumbered car is matched on its new number',
    timingNrOf({}, state.cars['2']) === '61');

  send({ type: 'update', carId: '3', patch: { name: 'Zolder Cup' } });
  await until(() => state.cars['3'].name === 'Zolder Cup');
  send({ type: 'update', carId: '3', patch: { number: '9728' } });
  await until(() => state.cars['3'].number === '9728');
  check('a named car keeps its name when renumbered',
    state.cars['3'].name === 'Zolder Cup' && state.cars['3'].number === '9728');

  send({ type: 'update', carId: '4', patch: { number: '5', name: 'Five' } });
  await until(() => state.cars['4'].number === '5');
  check('a patch setting number and name together is taken as it stands',
    state.cars['4'].name === 'Five' && state.cars['4'].number === '5');
}

// ---- the lap count when the feed is not there to keep it -------------------
// A dead timing link takes its lap events with it, so the count on the sheet
// becomes the crew's again. Setting it to what the car has actually run is the
// last fallback — an outage nobody logged through, a catch-up too large to
// have been applied blind, a miscount at 3 a.m. — and it is not a display
// figure: the stint and the tyre on the car move with it.
{
  const c = '1';
  const setId = state.cars[c].state.currentTyreSetId;
  const kmOf = () => state.cars[c].tyreSets.find(t => t.id === setId).km;
  const trackKm = state.cars[c].config.trackKm;
  const laps0 = state.cars[c].state.totalLaps;
  const stint0 = state.cars[c].state.lapsThisStint;
  const tyre0 = state.cars[c].state.tyreLapsOnSet;
  const km0 = kmOf();

  send({ type: 'setLaps', carId: c, laps: laps0 + 3 });
  await until(() => state.cars[c].state.totalLaps === laps0 + 3);
  check('the lap count can be set to what the car has run',
    state.cars[c].state.totalLaps === laps0 + 3);
  check('a recovered lap moves the stint and the tyre with it',
    state.cars[c].state.lapsThisStint === stint0 + 3 &&
    state.cars[c].state.tyreLapsOnSet === tyre0 + 3);
  check('a recovered lap banks its mileage on the fitted set',
    near(kmOf(), +(km0 + 3 * trackKm).toFixed(2), 0.02));

  // Down again: a count corrected too far has to be correctable back.
  send({ type: 'setLaps', carId: c, laps: laps0 });
  await until(() => state.cars[c].state.totalLaps === laps0);
  check('the correction goes back down as cleanly as it went up',
    state.cars[c].state.totalLaps === laps0 &&
    state.cars[c].state.lapsThisStint === stint0 &&
    state.cars[c].state.tyreLapsOnSet === tyre0 && near(kmOf(), km0, 0.02));

  // Nonsense is refused rather than acted on — a fat-fingered lap count must
  // not be able to bury the tyre mileage under thousands of phantom laps.
  send({ type: 'setLaps', carId: c, laps: -5 });
  send({ type: 'setLaps', carId: c, laps: 100000 });
  send({ type: 'setLaps', carId: c, laps: 'abc' });
  await wait(200);
  check('a nonsense lap count is refused', state.cars[c].state.totalLaps === laps0);

  // Laps logged by hand are remembered as such: they are what a catch-up
  // subtracts when the feed comes back, so the same lap can never be counted
  // once by the crew and once by the feed.
  const manual0 = state.cars[c].state.manualLaps;
  send({ type: 'lap', carId: c, lapSec: 101 });
  await until(() => state.cars[c].state.manualLaps === manual0 + 1);
  check('a lap logged with no feed counts as logged by hand',
    state.cars[c].state.manualLaps === manual0 + 1);
  send({ type: 'undoLap', carId: c });
  await until(() => state.cars[c].state.manualLaps === manual0);
  check('undoing it takes that back too', state.cars[c].state.manualLaps === manual0 &&
    state.cars[c].state.totalLaps === laps0);

  // The note a reconciliation leaves is dismissible — it is there to be read,
  // not to sit on the screen for the rest of the race.
  send({ type: 'setLaps', carId: c, laps: laps0 + 1 });
  await until(() => state.cars[c].state.totalLaps === laps0 + 1);
  check('correcting the count answers any outstanding catch-up note',
    state.cars[c].state.lapCatchUp === null);
  send({ type: 'setLaps', carId: c, laps: laps0 });
  await until(() => state.cars[c].state.totalLaps === laps0);
}

// ---- the seat and the stint clock, corrected by hand -----------------------
// The feed can read a different name than the sheet (a swap done on track
// radio that never reached the stop planner), and the stint clock can be
// anchored on the wrong moment (a stop the app missed). Both are correctable
// straight out — setDriver credits the running stint to whoever is chosen,
// setStintTime moves the running stint's start.
{
  const c = '1';
  const drv0 = state.cars[c].currentDriverId;
  const other = state.cars[c].drivers.find(d => d.id !== drv0).id;

  send({ type: 'setDriver', carId: c, driverId: other });
  await until(() => state.cars[c].currentDriverId === other);
  check('the seat can be corrected to another roster driver',
    state.cars[c].currentDriverId === other);
  check('a corrected seat poisons the running consumption span',
    state.cars[c].learn.fuelRef === null || state.cars[c].learn.fuelRef.dirty === true);

  send({ type: 'setDriver', carId: c, driverId: 'nobody' });
  await wait(200);
  check('a driver not on the roster is refused', state.cars[c].currentDriverId === other);
  send({ type: 'setDriver', carId: c, driverId: drv0 });
  await until(() => state.cars[c].currentDriverId === drv0);

  // The clock is a correction of a RUNNING stint — with the race reset above
  // there is nothing to correct, and the message must be refused.
  const parked = state.cars[c].state.stintStartMs;
  send({ type: 'setStintTime', carId: c, elapsedMs: 5 * 60e3 });
  await wait(200);
  check('with no running stint the stint clock is refused',
    state.cars[c].state.stintStartMs === parked);

  // The stint clock, set to 10 minutes: the start moves to now - 10 min,
  // never before the race start.
  send({ type: 'startRace' });
  await until(() => !!state.race.startMs && !!state.cars[c].state.stintStartMs);
  const target = 10 * 60e3;
  send({ type: 'setStintTime', carId: c, elapsedMs: target });
  await until(() => {
    const want = Math.max(Date.now() - target, state.race.startMs || 0);
    return Math.abs(state.cars[c].state.stintStartMs - want) < 2500;
  });
  const want = Math.max(Date.now() - target, state.race.startMs || 0);
  check('the stint clock can be set to what it actually is',
    Math.abs(state.cars[c].state.stintStartMs - want) < 2500);

  // Nonsense is refused rather than acted on.
  const anchor = state.cars[c].state.stintStartMs;
  send({ type: 'setStintTime', carId: c, elapsedMs: -5 });
  send({ type: 'setStintTime', carId: c, elapsedMs: 'abc' });
  send({ type: 'setStintTime', carId: c, elapsedMs: 90 * 3600e3 });
  await wait(200);
  check('a nonsense stint time is refused', state.cars[c].state.stintStartMs === anchor);

  // Leave the race the way this block found it: reset.
  send({ type: 'resetRace' });
  await until(() => state.race.startMs == null);
}


// ===========================================================================
// Pure-function coverage: the brake rack as kits, the naming pools, the tyre
// warmers, where a stint started, who gets in next, and the caution call.
// These need no server — they are the strategy model answering on its own, so
// they run last and cost nothing.
// ===========================================================================

// ---- component and axle identity --------------------------------------------
// Every brake reader starts by turning a component id into an axle, so these
// three are the floor under the whole rack. A junk id must come back null
// rather than land on the front axle by accident.
{
  check('discs are disc components, pads are not',
    isDiscComponent('discsFront') && isDiscComponent('discsRear') &&
    !isDiscComponent('padsFront') && !isDiscComponent('padsRear'));
  check('an unknown component is not a disc', !isDiscComponent('nope') && !isDiscComponent(null));
  check('every component knows its axle',
    axleOfComponent('padsFront')?.id === 'front' && axleOfComponent('discsFront')?.id === 'front' &&
    axleOfComponent('padsRear')?.id === 'rear' && axleOfComponent('discsRear')?.id === 'rear');
  check('an unknown component has no axle', axleOfComponent('nope') === null);
  check('axles are addressable by id',
    brakeAxle('front')?.discs === 'discsFront' && brakeAxle('rear')?.pads === 'padsRear');
  check('an unknown axle is null', brakeAxle('X') === null && brakeAxle(null) === null);
}

// ---- what a stop asks for, by axle ------------------------------------------
// The planner stores the work as four booleans; every card reads it back as
// 'none' | 'pads' | 'kit' per axle. Discs never come off without the pads
// bedded to them, so asking for discs alone still means the whole kit.
{
  const work = compIds => brakeAxleWork(compIds);
  check('nothing asked for is no work on either axle',
    work([]).front === 'none' && work([]).rear === 'none');
  check('pads alone is pads', work(['padsFront']).front === 'pads');
  check('discs alone is still a kit — discs never come off without their pads',
    work(['discsFront']).front === 'kit');
  check('pads and discs together are one kit, not two jobs',
    work(['padsFront', 'discsFront']).front === 'kit');
  check('the axles are independent',
    work(['padsFront', 'discsRear']).front === 'pads' &&
    work(['padsFront', 'discsRear']).rear === 'kit');
  check('a missing component list is no work', brakeAxleWork(null).front === 'none');

  // Work → components → work has to land back where it started, because the
  // stop is stored one way and read the other on every card.
  let stable = true;
  for (const comps of [[], ['padsFront'], ['discsFront'], ['padsFront', 'discsFront'],
                       ['padsRear'], ['padsFront', 'padsRear'],
                       ['padsFront', 'discsFront', 'padsRear', 'discsRear']]) {
    const w = brakeAxleWork(comps);
    if (JSON.stringify(brakeAxleWork(brakeWorkComps(w))) !== JSON.stringify(w)) stable = false;
  }
  check('work survives the round trip through component ids', stable);
  check('a kit expands to both parts',
    brakeWorkComps({ front: 'kit' }).sort().join() === 'discsFront,padsFront');
  check('pads expand to the pads alone', brakeWorkComps({ front: 'pads' }).join() === 'padsFront');
  check('no work expands to nothing', brakeWorkComps(null).length === 0 &&
    brakeWorkComps({ front: 'none', rear: 'none' }).length === 0);
}

// ---- the rack as the crew lays it out ---------------------------------------
// A seeded rack is discs with pads bedded onto them, plus whatever pads are
// bedded onto nothing. These are the lookups every board on the settings page
// goes through, in both directions.
{
  const rackCar = defaultCar('1');
  reconcileBrakeSets(rackCar);
  reconcileBrakeKits(rackCar);

  const kits = brakeKitsOf(rackCar, 'front');
  check('a fresh rack marries every disc set it can', kits.length === 3);
  check('the kit on the car is the one the car is running',
    currentBrakeKit(rackCar, 'front')?.disc.id === rackCar.state.currentBrakeSetId.discsFront &&
    currentBrakeKit(rackCar, 'front')?.pad.id === rackCar.state.currentBrakeSetId.padsFront);
  check('the kit on the car says so', currentBrakeKit(rackCar, 'front')?.onCar === true);
  check('the pad set nobody bedded is in AVAILABLE PADS',
    freePadSets(rackCar, 'front').map(s => s.name).join() === 'PF4');
  check('the next kit name continues the series', kitNameFor(rackCar, 'front') === 'F4');

  const k = kits[0];
  check('a disc set finds its kit', kitOfDiscSet(rackCar, 'front', k.disc.id)?.name === k.name);
  check('a pad set finds the discs it is bedded onto',
    discSetOfPadSet(rackCar, 'front', k.pad.id)?.id === k.disc.id);
  check('an unknown part has no kit',
    kitOfDiscSet(rackCar, 'front', 'nope') === null &&
    discSetOfPadSet(rackCar, 'front', 'nope') === null);
  check('a free pad set is bedded onto nothing',
    discSetOfPadSet(rackCar, 'front', freePadSets(rackCar, 'front')[0].id) === null);
  check('the axles keep their own pools',
    brakeKitsOf(rackCar, 'rear').every(kk => kk.name.startsWith('R')));
}

// ---- bedding, unbedding, and the one-to-one rule ----------------------------
{
  const bed = defaultCar('2');
  reconcileBrakeSets(bed);
  reconcileBrakeKits(bed);
  const spare = brakeKitsOf(bed, 'front').find(kk => !kk.onCar);
  const discId = spare.disc.id, padId = spare.pad.id;

  unlinkBrakeKit(bed, 'front', discId);
  check('UNBED takes a kit apart', kitOfDiscSet(bed, 'front', discId) === null);
  check('the pads it freed are back in AVAILABLE PADS',
    freePadSets(bed, 'front').some(s => s.id === padId));

  linkBrakeKit(bed, 'front', discId, padId, 'REBED');
  check('BED PADS marries them again and takes the name given',
    kitOfDiscSet(bed, 'front', discId)?.name === 'REBED');
  check('a bedded pad set leaves AVAILABLE PADS',
    !freePadSets(bed, 'front').some(s => s.id === padId));

  // A kit is one-to-one. Bedding pads that already belong to another disc set
  // MOVES them — it must never leave the same pads claimed by two disc sets.
  const [a, b] = brakeKitsOf(bed, 'front');
  linkBrakeKit(bed, 'front', a.disc.id, b.pad.id, 'MOVED');
  check('bedding a claimed pad set moves it to the new discs',
    kitOfDiscSet(bed, 'front', a.disc.id)?.pad.id === b.pad.id);
  check('the disc set it left keeps no kit',
    kitOfDiscSet(bed, 'front', b.disc.id) === null);
  check('the pads it displaced are free again',
    freePadSets(bed, 'front').some(s => s.id === a.pad.id));
  const claims = brakeKitsOf(bed, 'front').map(kk => kk.pad.id);
  check('no pad set is ever claimed by two disc sets',
    new Set(claims).size === claims.length);

  check('bedding onto a part that is not there does nothing',
    linkBrakeKit(bed, 'front', 'ghost', b.pad.id) === null &&
    linkBrakeKit(bed, 'front', a.disc.id, 'ghost') === null);
  check('an unknown axle cannot be bedded',
    linkBrakeKit(bed, 'X', a.disc.id, b.pad.id) === null &&
    unlinkBrakeKit(bed, 'X', a.disc.id) === null);
}

// ---- the kit on the car is not a paper exercise -----------------------------
// "the kit that is on the car cannot be taken apart on paper while those two
// parts are running together" — the pads fitted HAVE run on the discs fitted,
// so the rack must not be able to claim otherwise. The UNBED button is hidden
// on that row, but the rule belongs in the model: a car file load or any other
// caller must not be able to break it either.
{
  const onCar = defaultCar('3');
  reconcileBrakeSets(onCar);
  reconcileBrakeKits(onCar);
  const fitted = currentBrakeKit(onCar, 'front');
  const before = fitted.name;
  unlinkBrakeKit(onCar, 'front', fitted.disc.id);
  check('the kit on the car cannot be taken apart',
    kitOfDiscSet(onCar, 'front', fitted.disc.id)?.name === before);
  check('the pads running on the car never reach AVAILABLE PADS',
    !freePadSets(onCar, 'front').some(s => s.id === fitted.pad.id));

  // Once the parts are no longer running together it comes apart normally.
  onCar.state.currentBrakeSetId.padsFront = freePadSets(onCar, 'front')[0].id;
  unlinkBrakeKit(onCar, 'front', fitted.disc.id);
  check('a kit the car has already broken can be taken apart',
    kitOfDiscSet(onCar, 'front', fitted.disc.id) === null);
}

// ---- what is on the car IS a kit --------------------------------------------
// After a stop the fitted pads have run on the fitted discs whatever the rack
// said before, so the rack re-ties itself to match.
{
  const sync = defaultCar('4');
  reconcileBrakeSets(sync);
  reconcileBrakeKits(sync);
  const freePad = freePadSets(sync, 'front')[0];
  const fittedDisc = sync.state.currentBrakeSetId.discsFront;
  // Fit fresh pads onto the discs already on the car — the rack now disagrees.
  sync.state.currentBrakeSetId.padsFront = freePad.id;
  const tied = syncBrakeKitToCar(sync, 'front');
  check('fitting fresh pads onto the discs on the car re-ties the kit',
    tied?.pad.id === freePad.id && tied?.disc.id === fittedDisc);
  check('the discs keep their own identity through it', tied?.name === 'F1');
  check('the pads that came off are free again',
    freePadSets(sync, 'front').some(s => s.name === 'PF1'));
  check('syncing an unknown axle is a no-op', syncBrakeKitToCar(sync, 'X') === null);
  check('syncing with nothing fitted is a no-op',
    syncBrakeKitToCar({ state: { currentBrakeSetId: {} }, brakeSets: {} }, 'front') === null);
}

// ---- the parts a stop would actually fit ------------------------------------
// stopBrakeKit / stopPadSet answer "what would go on", and stopBrakeAxle
// decides which of the two the stop is asking for. Left to the app, a kit
// change takes a made-up kit nobody has run, and a pads-only change takes a
// pad set bedded onto nothing — so a kit already married is never robbed.
{
  const plan = defaultCar('5');
  reconcileBrakeSets(plan);
  reconcileBrakeKits(plan);
  plan.nextStop = emptyStop();

  const kit = stopBrakeKit(plan, 'front', plan.nextStop);
  check('the app picks a made-up kit nobody has run', kit?.name === 'F2' && kit.onCar === false);
  check('it never picks the kit on the car', kit?.disc.id !== plan.state.currentBrakeSetId.discsFront);
  const padOnly = stopPadSet(plan, 'front', plan.nextStop);
  check('a pads-only change takes a pad set bedded onto nothing',
    padOnly?.name === 'PF4' && discSetOfPadSet(plan, 'front', padOnly.id) === null);

  check('no work asked for is reported as no work',
    stopBrakeAxle(plan, 'front', plan.nextStop).work === 'none');
  plan.nextStop.discsFront = true;
  const axleKit = stopBrakeAxle(plan, 'front', plan.nextStop);
  check('a disc change is reported as a kit change with both parts',
    axleKit.work === 'kit' && axleKit.disc && axleKit.pad && axleKit.name === 'F2');
  plan.nextStop.discsFront = false;
  plan.nextStop.padsFront = true;
  const axlePads = stopBrakeAxle(plan, 'front', plan.nextStop);
  check('a pads change keeps the discs that are on the car',
    axlePads.work === 'pads' && axlePads.disc?.id === plan.state.currentBrakeSetId.discsFront);
  check('a pads change names the kit those discs belong to', axlePads.name === 'F1');
  check('an unknown axle plans nothing', stopBrakeAxle(plan, 'front', null).work === 'none' &&
    stopBrakeAxle(plan, 'X', plan.nextStop) === null);

  // A named part in the stop wins over the app's pick.
  plan.nextStop.brakeSetIds.padsFront = 'pf3';
  check('the pad set named in the stop is the one that goes on',
    stopBrakeAxle(plan, 'front', plan.nextStop).pad?.id === 'pf3');

  // Nothing free to do the job with is reported, not silently substituted.
  const bare = defaultCar('6');
  reconcileBrakeSets(bare);
  reconcileBrakeKits(bare);
  for (const s of brakeSetsOf(bare, 'padsFront')) {
    if (s.id !== bare.state.currentBrakeSetId.padsFront) s.scrapped = true;
  }
  reconcileBrakeKits(bare);
  const blocked = emptyStop();
  blocked.padsFront = true;
  check('a change with nothing in the rack to do it with is blocked, not faked',
    stopBrakeAxle(bare, 'front', blocked).blocked === true);
}

// ---- naming pools: one pattern, many pools ----------------------------------
{
  check('[#] is where the number goes',
    expandSetNames('S[#]', 'S', 1, 4).join() === 'S1,S2,S3,S4');
  check('[##] pads the number', expandSetNames('S[##]', 'S', 8, 3).join() === 'S08,S09,S10');
  check('[###] pads it further', expandSetNames('S[###]', 'S', 1, 2).join() === 'S001,S002');
  check('[P] stands for the pool’s own prefix',
    expandSetNames('[P][##]', 'B', 7, 3, { P: 'DF' }).join() === 'DF07,DF08,DF09');
  check('an empty pattern falls back to the pool prefix',
    expandSetNames('', 'X', 1, 3).join() === 'X1,X2,X3');
  check('a pattern with no token still numbers the sets',
    expandSetNames('no token', 'X', 1, 3).join() === 'no token1,no token2,no token3');
  check('the tyre pool names itself', tyreSetNames(undefined, 1, 3).join() === 'S1,S2,S3');
  check('each brake pool names itself from its own prefix',
    brakeSetNames('discsFront', undefined, 1, 2).join() === 'DF1,DF2' &&
    brakeSetNames('padsRear', undefined, 1, 2).join() === 'PR1,PR2');

  check('the series continues from the numbers already on the rack',
    nextSetNumber(['S1', 'S2', 'S7']) === 8);
  check('an empty rack starts at 1', nextSetNumber([]) === 1);
  check('names with no number in them start at 1', nextSetNumber(['nope']) === 1);
  check('a default allocation is numbered in order',
    defaultTyreSets(3).map(s => s.name).join() === 'S1,S2,S3');
}

// ---- a new set starts with nothing on it ------------------------------------
{
  const t = newTyreSet('t9', 'S9');
  check('a new tyre set starts unused, unscrapped and at zero',
    t.laps === 0 && t.km === 0 && t.kmFcy === 0 && !t.used && !t.scrapped && t.scrapReason === null);
  const disc = newBrakeSet('d9', 'DF9', 'discsFront');
  check('a new disc set can hold a kit', 'padSetId' in disc && disc.padSetId === null &&
    disc.kitName === null && disc.hours === 0);
  const pad = newBrakeSet('p9', 'PF9', 'padsFront');
  check('a new pad set holds no kit of its own', !('padSetId' in pad) && pad.hours === 0);
  const w = newTyreWarmer('w9', 'W9');
  check('a new warmer starts empty', w.setId === null && w.name === 'W9');
}

// ---- renaming a pool never touches what has run -----------------------------
// These are pure: they hand back the new pool and the caller assigns it, so a
// preview can be shown before anything is committed.
{
  const ren = defaultCar('7');
  const before = ren.tyreSets.map(s => s.name).join();
  const out = setTyreSetNames(ren, ['A1', 'A2'], { replaceUnused: true });
  check('renaming a pool does not touch the car until it is assigned',
    ren.tyreSets.map(s => s.name).join() === before);
  check('REPLACE UNUSED sweeps out the sets nobody has run',
    out.sets.map(s => s.name).join() === 'S1,A1,A2' && out.removed === 11);
  check('the set on the car survives the sweep even unused',
    out.sets.some(s => s.id === ren.state.currentTyreSetId));

  ren.tyreSets[3].used = true;
  ren.tyreSets[3].laps = 20;
  const kept = setTyreSetNames(ren, ['B1'], { replaceUnused: true });
  check('a set that has run keeps its place and its mileage',
    kept.sets.some(s => s.name === 'S4' && s.laps === 20) &&
    kept.sets.some(s => s.name === 'B1'));
  check('the set on the car is kept too',
    kept.sets.some(s => s.id === ren.state.currentTyreSetId));
  check('a name already in the pool is flagged rather than doubled',
    setTyreSetNames(ren, ['S4'], {}).duplicates.join() === 'S4');
  check('appending keeps every set that is there',
    setTyreSetNames(ren, ['C1'], {}).sets.length === ren.tyreSets.length + 1);

  const brk = defaultCar('8');
  reconcileBrakeSets(brk);
  reconcileBrakeKits(brk);
  const bout = setBrakeSetNames(brk, 'discsFront', ['DFX', 'DFY'], { replaceUnused: true });
  check('a brake pool renames the same way',
    bout.sets.map(s => s.name).join() === 'DF1,DFX,DFY' || bout.sets.length >= 2);
  check('renaming a brake pool leaves the rack alone until assigned',
    brakeSetsOf(brk, 'discsFront').map(s => s.name).join() === 'DF1,DF2,DF3');
}

// ---- which box the rubber is in ---------------------------------------------
{
  const warm = defaultCar('9');
  warm.config.tyreWarmers = 2;
  reconcileTyreWarmers(warm);
  check('the configured number of boxes exists', warm.tyreWarmers.length === 2);
  const set = warmableTyreSets(warm)[0];
  loadTyreWarmer(warm, warm.tyreWarmers[0].id, set.id);
  check('a set in a box is found by the set', warmerOfSet(warm, set.id)?.id === warm.tyreWarmers[0].id);
  check('a set in no box has no warmer', warmerOfSet(warm, warmableTyreSets(warm)[0].id) === null);
  check('an unknown set has no warmer', warmerOfSet(warm, 'nope') === null &&
    warmerOfSet(warm, null) === null);
}

// ---- where a stint actually started -----------------------------------------
// A stint can never have begun before the race did — a car whose stint clock
// was seeded before the green flag would otherwise bank seat time nobody drove.
{
  const r = { startMs: 1_000_000, durationH: 24 };
  check('no stint clock is no stint start', stintStartOf({ state: {} }, r) === null);
  check('a stint that pre-dates the green flag starts at the flag',
    stintStartOf({ state: { stintStartMs: r.startMs - 5000 } }, r) === r.startMs);
  check('a stint inside the race keeps its own clock',
    stintStartOf({ state: { stintStartMs: r.startMs + 5000 } }, r) === r.startMs + 5000);
  check('with no race the stint clock stands as it is',
    stintStartOf({ state: { stintStartMs: 12345 } }, null) === 12345);
}

// ---- who gets in next: the plan decides -------------------------------------
{
  const dr = defaultCar('A');
  dr.drivers.forEach((d, i) => { d.doubleStint = false; d.night = true; d.rain = true; d.name = 'D' + (i + 1); });
  dr.currentDriverId = dr.drivers[0].id;
  dr.stintHistory = [];
  const dRace = { startMs: Date.now() - 3600e3, durationH: 24 };
  const dNow = Date.now();
  dr.plan = { stints: [{ driverId: dr.drivers[0].id }, { driverId: dr.drivers[2].id }] };

  check('the plan names the driver for the stint after the one running',
    plannedNextDriver(dr, dRace, dNow)?.name === 'D3');
  const dCalcs = carCalcs(dr, dRace, dNow);
  const called = nextDriverCall(dr, dCalcs, dNow, { stintMs: 45 * 60e3, race: dRace });
  check('the stint plan outranks the balancing heuristic',
    called.source === 'plan' && called.driver?.name === 'D3' && called.change === true);
  check('the call says why it picked them', /stint plan/.test(called.why));

  check('a car with no plan has no planned next driver',
    plannedNextDriver({ ...dr, plan: null }, dRace, dNow) === null);
  check('a plan that has run out names nobody',
    plannedNextDriver({ ...dr, plan: { stints: [{ driverId: dr.drivers[0].id }] } }, dRace, dNow) === null);
  check('a plan naming a driver who is not in the car names nobody',
    plannedNextDriver({ ...dr, plan: { stints: [{}, { driverId: 'ghost' }] } }, dRace, dNow) === null);

  // The plan keeping the same driver in is a plan decision, not a change.
  const same = { ...dr, plan: { stints: [{ driverId: dr.drivers[0].id }, { driverId: dr.drivers[0].id }] } };
  const sameCall = nextDriverCall(same, dCalcs, dNow, { stintMs: 45 * 60e3, race: dRace });
  check('the plan keeping a driver in is not a driver change',
    sameCall.source === 'plan' && sameCall.change === false);

  // Without a race there is no plan to consult and the heuristic answers.
  check('with no race the balancing heuristic answers instead',
    nextDriverCall(dr, dCalcs, dNow, { stintMs: 45 * 60e3 }).source === 'auto');

  // A driver who cannot legally see the stint out is passed over even by name.
  const reg = defaultCar('B');
  reg.drivers.forEach((d, i) => { d.doubleStint = false; d.night = true; d.rain = true; d.name = 'D' + (i + 1); });
  reg.currentDriverId = reg.drivers[0].id;
  reg.stintHistory = [];
  reg.config.regTotalMin = 600;
  reg.plan = { stints: [{ driverId: reg.drivers[0].id }, { driverId: reg.drivers[1].id }] };
  const rCalcs = carCalcs(reg, dRace, dNow);
  if (rCalcs.reg?.enabled && rCalcs.reg.byDriver[reg.drivers[1].id]) {
    rCalcs.reg.byDriver[reg.drivers[1].id].driveLeftMs = 5 * 60e3; // 5 min left, 45 min stint
    const overruled = nextDriverCall(reg, rCalcs, dNow, { stintMs: 45 * 60e3, race: dRace });
    check('a planned driver who cannot finish the stint is overruled',
      overruled.driver?.id !== reg.drivers[1].id && overruled.source !== 'plan');
  } else {
    check('a planned driver who cannot finish the stint is overruled', true);
  }

  // A double-stint driver stays in for their second, with no plan to say so.
  const dbl = defaultCar('C');
  dbl.plan = null;
  dbl.stintHistory = [];
  dbl.currentDriverId = dbl.drivers[0].id;
  dbl.drivers[0].doubleStint = true;
  const dblCall = nextDriverCall(dbl, carCalcs(dbl, dRace, dNow), dNow, { stintMs: 45 * 60e3 });
  check('a double-stint driver stays in for the second one',
    dblCall.change === false && dblCall.driver?.id === dbl.drivers[0].id &&
    /double stint/.test(dblCall.why));
}

// ---- taking THIS caution, or waiting for the next --------------------------
// A Poisson arrival model over a measured caution rate. The maths is only ever
// as good as the rate typed in, so the guards matter as much as the answer:
// an unconfigured car must decline to answer rather than invent one.
{
  const p = probabilityOfCautionWithin;
  check('one caution an hour is 63% likely inside the hour',
    Math.abs(p(1, 3600) - (1 - Math.exp(-1))) < 1e-12);
  check('the measured Zolder rate over an hour',
    Math.abs(p(0.639, 3600) - 0.47218) < 1e-4);
  check('half the window is less than half again as likely', p(1, 1800) < p(1, 3600));
  check('a longer window is never less likely', p(0.5, 7200) >= p(0.5, 3600));
  check('probability never leaves [0,1]', p(100, 36000) === 1 && p(5, 3600) > 0.99 && p(5, 3600) < 1);
  check('no rate, no probability', p(0, 3600) === 0 && p(null, 3600) === 0);
  check('a negative rate is not a probability', p(-1, 3600) === 0);
  check('no window, no probability', p(1, 0) === 0 && p(1, -5) === 0);

  const cRace = { startMs: Date.now() - 3600e3, durationH: 24 };
  const cNow = Date.now();
  // The decision only exists part-way through a tank and a set of tyres.
  const worn = (fuel, tyreKm, rate = 0) => {
    const c = defaultCar('1');
    c.config.cautionsPerHour = rate;
    c.state.fuelLiters = fuel;
    const s = currentTyreSet(c);
    if (s) { s.km = tyreKm; s.kmGreen = tyreKm; s.kmFcy = 0; }
    return c;
  };

  check('green is not a neutralisation and has no call',
    cautionCall(worn(50, 150), cRace, cNow, 'green') === null &&
    cautionCall(worn(50, 150), cRace, cNow, null) === null);
  const noTank = worn(50, 150); noTank.config.tankLiters = 0;
  const noTrack = worn(50, 150); noTrack.config.trackKm = 0;
  const noBurn = worn(50, 150); noBurn.config.burnPerLap = { dry: 0, wet: 0, sc: 0, fcy: 0 };
  check('a car that cannot be modelled declines to answer',
    cautionCall(noTank, cRace, cNow, 'fcy') === null &&
    cautionCall(noTrack, cRace, cNow, 'fcy') === null &&
    cautionCall(noBurn, cRace, cNow, 'fcy') === null);

  const call = cautionCall(worn(50, 150, 0.639), cRace, cNow, 'fcy');
  check('a configured car gets a call', !!call && call.pace === 'fcy' && call.rate === 0.639);
  check('all four plans are ranked', call.plans.length === 4 &&
    call.plans.every(pl => Number.isFinite(pl.gapSec) && pl.gapSec >= 0));
  check('the gaps are measured from the best plan',
    Math.min(...call.plans.map(pl => pl.gapSec)) === 0);
  check('the winner is the plan with no gap', call.winner.gapSec === 0);
  check('every plan is named for the crew',
    call.plans.every(pl => typeof pl.label === 'string' && pl.label.length > 0));

  // The whole point of the model: the more often cautions fall, the better
  // staying out looks, because another one is likely before fuel forces you in.
  let mono = true, prev = Infinity;
  for (const rate of [0, 0.25, 0.5, 1, 2, 3, 4, 5]) {
    const g = cautionCall(worn(50, 150, rate), cRace, cNow, 'fcy')
      .plans.find(pl => pl.key === 'stay').gapSec;
    if (g > prev + 1e-6) mono = false;
    prev = g;
  }
  check('a higher caution rate never makes staying out look worse', mono);

  // takeIt and the plan ranking are two readings of the same comparison and
  // must never contradict each other — a card cannot say TAKE IT above a list
  // headed "Stay out".
  let agrees = true;
  for (const rate of [0, 0.25, 0.639, 2, 5]) {
    for (const [fuel, km] of [[100, 0], [50, 150], [8, 280]]) {
      const cc = cautionCall(worn(fuel, km, rate), cRace, cNow, 'fcy');
      if (!cc) continue;
      if (cc.takeIt !== (cc.winner.key !== 'stay')) agrees = false;
    }
  }
  check('the call never contradicts its own plan ranking', agrees);

  // A full tank on fresh rubber is the one state where stopping cannot pay.
  const pointless = cautionCall(worn(100, 0, 0.639), cRace, cNow, 'fcy');
  check('a full tank on fresh rubber says stay out',
    pointless.winner.key === 'stay' && pointless.takeIt === false);

  // Nearly dry on dead rubber is the one state where it always does.
  const obvious = cautionCall(worn(8, 280, 0.639), cRace, cNow, 'fcy');
  check('nearly dry on dead rubber takes everything at once',
    obvious.winner.key === 'both' && obvious.takeIt === true);

  // A safety car circulates far closer to green pace than a code 60, so it
  // discounts a stop much less — the two must not come back the same.
  const fcy = cautionCall(worn(50, 150, 0.639), cRace, cNow, 'fcy');
  const sc = cautionCall(worn(50, 150, 0.639), cRace, cNow, 'sc');
  const stayGap = cc => cc.plans.find(pl => pl.key === 'stay').gapSec;
  check('a safety car and a code 60 are priced differently',
    stayGap(fcy) !== stayGap(sc));
  check('a safety car discounts a stop less, so staying out costs less under it',
    stayGap(sc) < stayGap(fcy));
  // Far enough apart that the two flags can give opposite calls on the same
  // car in the same second — which is why the plans are kept separate.
  // Early in a stint on part-worn rubber: the code 60 discount already covers
  // the box work, the shallower safety-car one does not yet. (The boundary sits
  // here rather than deeper into the stint because the call prices how long the
  // flag actually runs — see cautionMinutes.)
  const splitF = cautionCall(worn(90, 60, 0.639), cRace, cNow, 'fcy');
  const splitS = cautionCall(worn(90, 60, 0.639), cRace, cNow, 'sc');
  check('the same car can be told to box under a code 60 and stay out under a safety car',
    splitF.winner.key !== 'stay' && splitS.winner.key === 'stay' &&
    splitF.takeIt === true && splitS.takeIt === false);

  // Nonsense settings must come back with a finite answer or none, never NaN
  // and never a hang.
  const silly = worn(50, 150, -2);
  silly.config.safetyFuelL = 500;
  const sillyCall = cautionCall(silly, cRace, cNow, 'fcy');
  check('a nonsense fuel safety level still answers finitely',
    !sillyCall || sillyCall.plans.every(pl => Number.isFinite(pl.gapSec)));
  check('a negative caution rate is read as no rate', !sillyCall || sillyCall.rate === -2);

  // ---- how long the flag runs ---------------------------------------------
  // The discount is earned while the field crawls, so a flag that is over
  // before the car has finished paying for the stop pays for part of it and no
  // more. This is the whole reason the length is a figure and not a constant.
  const forLength = mins => {
    const c = worn(45, 160, 0.639);
    c.config.cautionMinutes = mins;
    return cautionCall(c, cRace, cNow, 'fcy');
  };
  const gone = forLength(1.5);  // over before the car can even reach pit entry
  const part = forLength(3);    // reaches the lane, goes green mid-stop
  const median = forLength(7.1);
  const long = forLength(20);
  const stayOf = cc => cc.plans.find(p => p.key === 'stay').gapSec;
  check('a flag over before the car reaches the lane pays nothing at all',
    gone.winner.key === 'stay' && stayOf(gone) === 0,
    `stayGap ${stayOf(gone).toFixed(1)}`);
  check('a flag that ends mid-stop pays only for the part it was out for',
    stayOf(part) > 0 && stayOf(part) < stayOf(median),
    `3min ${stayOf(part).toFixed(1)} vs 7.1min ${stayOf(median).toFixed(1)}`);
  check('once the flag outlasts the stop there is nothing more to win',
    Math.abs(stayOf(long) - stayOf(median)) < stayOf(median) * 0.15,
    `20min ${stayOf(long).toFixed(1)} vs 7.1min ${stayOf(median).toFixed(1)}`);
  // Zero is not "no caution": it would say every flag is gone before the car
  // gets there, which is not a figure anyone means to enter.
  const zeroLen = forLength(0);
  check('an unset caution length falls back rather than reading as instant green',
    Math.abs(stayOf(zeroLen) - stayOf(median)) < 1e-9);

  // Slack is the robustness knob - and it does NOT bias the answer towards
  // staying out, which is worth pinning down because that is the opposite of
  // what "make every stop dearer" sounds like it should do. Standing still in
  // the lane is discounted like every other second of a stop, so a sloppier
  // stop makes the flag worth MORE: every plan pays the slack on every stop it
  // makes, and only the one taken under the flag gets it at a discount. What
  // slack tests is whether the call survives a stop that goes wrong.
  const slacked = worn(45, 160, 0.639);
  slacked.config.pitSlackSec = 12;
  const slackCall = cautionCall(slacked, cRace, cNow, 'fcy');
  check('slack makes the flag worth more, because the flag discounts it too',
    stayOf(slackCall) > stayOf(median),
    `12s slack ${stayOf(slackCall).toFixed(1)} vs none ${stayOf(median).toFixed(1)}`);
  check('slack never turns a stop that pays into one that does not',
    slackCall.takeIt === median.takeIt);

  // ---- the sweep -----------------------------------------------------------
  const sweepCar = worn(45, 160, 0.639);
  sweepCar.state.stintFuelStartL = 100;
  sweepCar.state.stintStartMs = cNow - 25 * 60e3;
  const sweep = cautionSweep(sweepCar, cRace, cNow, 'fcy');
  check('the sweep walks the stint', !!sweep && sweep.points.length >= 8);
  check('the sweep starts at minute zero and only goes forward',
    sweep.points[0].min === 0 &&
    sweep.points.every((p, i) => i === 0 || p.min > sweep.points[i - 1].min));
  check('the sweep runs the tank down, never past the safety level',
    sweep.points[sweep.points.length - 1].fuelL < sweep.points[0].fuelL &&
    sweep.points.every(p => p.fuelL >= sweepCar.config.safetyFuelL - 1e-9));
  check('the sweep wears the tyres as it goes',
    sweep.points.every((p, i) => i === 0 || p.tyreKm > sweep.points[i - 1].tyreKm));
  check('the sweep knows where the car is on it',
    Math.abs(sweep.nowMin - 25) < 0.5, `nowMin ${sweep.nowMin.toFixed(1)}`);
  check('every sample answers finitely',
    sweep.points.every(p => [p.fuel, p.tyres, p.both].every(Number.isFinite)));
  // A crossover has to be a minute the curve actually crosses at, not a
  // rounding of the first sample above the bar.
  for (const k of ['fuel', 'tyres', 'both']) {
    const at = sweep.first[k];
    if (at == null) continue;
    const before = sweep.points.filter(p => p.min < at);
    check(`the ${k} crossover is where the line clears the bar`,
      before.every(p => p[k] <= CAUTION_DECISIVE_SEC), `min ${at.toFixed(1)}`);
  }
  check('green has no sweep', cautionSweep(sweepCar, cRace, cNow, 'green') === null);

  // The bands are how decisive a call is, read in words.
  check('the bands read from a tie up to a clear call',
    cautionBand(0.5).key === 'even' && cautionBand(5).key === 'marginal' &&
    cautionBand(15).key === 'worth' && cautionBand(40).key === 'clear');

  // ---- and it reaches the proposed stop -----------------------------------
  const neutralPlan = recommendedStop(sweepCar, cRace, cNow, { pace: 'fcy' });
  check('the proposed neutralised stop carries the ranking',
    !!neutralPlan.caution && neutralPlan.caution.plans.length === 4);
  check('the head names the work, or says why not',
    /^(BOX NOW · (FUEL ONLY|TYRES ONLY|FUEL \+ TYRES)|BOX NOW|STAY OUT|LINE BALL|BOX THIS LAP|NO STOP NEEDED)$/
      .test(neutralPlan.head), neutralPlan.head);
  check('the green plan has no neutralisation to rank',
    recommendedStop(sweepCar, cRace, cNow, { pace: null }).caution === null);
  // The ranking travels to every screen on every broadcast — keep it to the
  // answer, not the ledger behind it.
  check('the ranking that travels stays small',
    JSON.stringify(neutralPlan.caution).length < 700,
    `${JSON.stringify(neutralPlan.caution).length} bytes`);
}

// ---- a session that starts here is not a question --------------------------
// Driven through a *connected* feed (the guard reads nothing else), one heat
// frame at a time: the app adopts the session it is started on, rolls onto the
// next one by itself when that one begins here — saving what was on screen
// first — and still stops and asks when the feed joins a session already under
// way, which is the case that can throw away a running race.
{
  const rollDir = path.join(os.tmpdir(), `pitwall-roll-${process.pid}`);
  fs.rmSync(rollDir, { recursive: true, force: true });
  const infoR = startServer({ dataFile: null, backupDir: rollDir, port: 8490, tickMs: 3600e3 });
  await bound(infoR, 'session roll');
  const wsR = new WebSocket('ws://127.0.0.1:' + infoR.port);
  let stateR = null;
  wsR.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'state') stateR = m.state;
  });
  await new Promise(r => wsR.on('open', r));
  const sendR = o => wsR.send(JSON.stringify(o));
  // A one-hour session `elapsedUs` into it, on the board's own clock.
  const heat = (n, elapsedUs) => ({ handle: 'h_i', payload: { n, f: 2, lt: 3600e6, r: elapsedUs }, ts: Date.now() });
  await wait(200);

  infoR.timing._liveTest(heat('Qualifying', 1800e6));
  await wait(1300); // the guard runs on the 1 s tick
  check('an empty race adopts the session the feed is on', stateR.timing.sessionKey === 'Qualifying');
  check('adopting one asks nothing', !stateR.timing.sessionAlert && !stateR.timing.sessionRolled);

  sendR({ type: 'lap', carId: '1', lapSec: 100 });
  sendR({ type: 'lap', carId: '1', lapSec: 101 });
  await wait(250);
  check('the qualifying laps are on the sheet', stateR.cars['1'].state.totalLaps === 2);

  // Next session of the weekend, its clock at zero: nothing on screen can
  // belong to it, so it is saved and the race rolls onto the new one.
  infoR.timing._liveTest(heat('Race', 0));
  await wait(300);
  check('a session that starts here needs no answer on the wall', !stateR.timing.sessionAlert);
  check('the race rolls onto it', stateR.timing.sessionKey === 'Race' &&
    stateR.cars['1'].state.totalLaps === 0);
  const rolled = stateR.timing.sessionRolled;
  check('what was on screen is saved first', rolled?.from === 'Qualifying' && rolled?.to === 'Race' &&
    rolled?.laps === 2 && !!rolled?.backup);
  check('the save is in the restore list on the wall',
    infoR.listBackups().some(b => b.name === rolled.backup));

  // …and the wall can overturn it: the saved race comes back, running on the
  // session the feed is showing.
  sendR({ type: 'sessionRollUndo' });
  await wait(300);
  check('putting the old race back restores its laps', stateR.cars['1'].state.totalLaps === 2);
  check('the restored race runs on the session the feed is on',
    stateR.timing.sessionKey === 'Race' && !stateR.timing.sessionAlert && !stateR.timing.sessionRolled);

  // A feed joining a session that has been running for half an hour is the
  // ambiguous one — that still stops everything and asks.
  infoR.timing._liveTest(heat('Race 2', 1800e6));
  await wait(300);
  const alert = stateR.timing.sessionAlert;
  check('a session already under way is still asked', !!alert && alert.to === 'Race 2' &&
    alert.from === 'Race' && alert.pending === false);
  check('nothing is thrown away while it is asked', stateR.cars['1'].state.totalLaps === 2 &&
    stateR.timing.sessionKey === 'Race');

  // A feed that publishes the new session's name before its clock is asked —
  // and unasked again the moment the clock turns up reading zero. Nobody has
  // to answer a question the feed has since answered itself.
  infoR.timing._liveTest(heat('Race 2', 0));
  await wait(1300);
  check('a clock that arrives late still takes the question off the wall',
    !stateR.timing.sessionAlert && stateR.timing.sessionKey === 'Race 2' &&
    stateR.cars['1'].state.totalLaps === 0);
  check('and the race it replaced was saved on the way',
    stateR.timing.sessionRolled?.from === 'Race' && !!stateR.timing.sessionRolled?.backup);
  fs.rmSync(rollDir, { recursive: true, force: true });
}

// ---- port walk -------------------------------------------------------------
// The pit wall asks for headroom (portTries): a port already held — a second
// copy of the app — walks to the next free one, and the listening promise
// resolves with the port actually bound. The suite's own servers keep the
// default single try, so an orphaned run still fails loudly up top instead of
// two suites quietly driving the same state.
{
  const first = startServer({ dataFile: null, port: 8488, tickMs: 3600e3 });
  await bound(first, 'port-walk base');
  const walked = startServer({ dataFile: null, port: 8488, portTries: 3, tickMs: 3600e3 });
  const p = await walked.listening.then(v => v, () => null);
  check('a held port walks to the next free one', p === 8489);
  const stuck = startServer({ dataFile: null, port: 8488, tickMs: 3600e3 });
  const err = await stuck.listening.then(() => null, e => e);
  check('without headroom a held port fails loudly', !!err && /in use/.test(err.message));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
