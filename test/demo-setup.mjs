// One-shot demo configurator for a presentation of the app.
//
// Run it AGAINST A RUNNING PIT WALL (start the app, press START PIT WALL):
//
//     node test/demo-setup.mjs [port]
//
// It connects to ws://127.0.0.1:8484 (or the given port) like a station
// would and sets the whole board up for the demo built around the recorded
// session replay-20260822-200722.jsonl (Asian Le Mans Series demo feed,
// 2 h 8 min, 24 cars):
//
//   - disconnects the live timing feed (the demo runs on the replay instead)
//   - resets the race data (car SETUPS are kept by the server; every setup
//     field the demo needs is then written below anyway)
//   - names the four cars as the feed's LMP2 entries #26 / #34 / #45 / #96
//     and links them to those race numbers, so standings, tracker and
//     driver-matching all line up with the replayed feed
//   - fills each car's driver table with the drivers the feed actually
//     prints for that car (timing names match => the wall confirms who is
//     in the car), plus fuel model / pace figures that give believable
//     stints (~75 L tank at ~3.1 L/lap and ~1:59 laps ≈ 45 min of fuel)
//   - sets drive-time regulations so the Drivers panel legality clocks
//     have something to show
//
// It does NOT start the race (that is a beat in the demo itself) and does
// not touch the replay files. Run it as often as you like — it is
// idempotent. After it reports DEMO READY, take a snapshot on the wall
// (SETTINGS -> BACKUPS -> SAVE SNAPSHOT NOW): restoring that snapshot is
// the reset button for the whole demo.

import WebSocket from 'ws';

const port = parseInt(process.argv[2], 10) || 8484;

// Whatever goes wrong, never sit silent: a presenter running this before a
// meeting needs an answer, not a stuck terminal.
setTimeout(() => {
  console.error('TIMEOUT — no confirmation from the pit wall after 30 s. Is START PIT WALL pressed?');
  process.exit(1);
}, 30000);

const ws = new WebSocket('ws://127.0.0.1:' + port);

let state = null;
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'state') state = m.state;
});
const send = o => ws.send(JSON.stringify(o));
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch {}
    await wait(25);
  }
  return false;
}

ws.on('error', e => {
  console.error('\nCannot reach the pit wall on port ' + port + ': ' + e.message);
  console.error('Start the app, press START PIT WALL, then run this again.');
  console.error('(If the wall shows another port in its top bar, pass it: node test/demo-setup.mjs <port>)');
  process.exit(1);
});

await new Promise(r => ws.on('open', r));
await until(() => state && Object.keys(state.cars || {}).length === 4);
if (!state) {
  console.error('Connected, but no state arrived — is this really the pit wall server?');
  process.exit(1);
}

// The demo runs on the recorded replay, never on the live feed — and a booted
// wall auto-reconnects a feed that was left "wanted". Kill that first so the
// live demo feed cannot grab the clock or the flags mid-presentation.
send({ type: 'timingDisconnect' });

// Clear old laps/stints/clock. Setups are kept, but everything the demo
// relies on is (re)written below, so stale test data cannot leak through.
send({ type: 'resetRace' });
await until(() => !state.race.startMs &&
  Object.values(state.cars).every(c => c.state.totalLaps === 0));

send({ type: 'race', patch: { name: '24H Endurance — DEMO', durationH: 24 } });

// Event settings: the state already carries Zolder's official geometry
// (track 4.007 km, lane 411 m, loss 55 s). Add a realistic rig speed and
// drive-time regulations so the legality clocks in the Drivers panel and the
// DRIVE LIMIT row in the stop planner are live during the demo.
send({
  type: 'event',
  patch: {
    refuelLps: 2.5, // 75 L full fill ≈ 30 s at the rig
    maxStintMin: 120,
    reg6hMin: 120, // max 2 h at the wheel in any rolling 6 h
    regTotalMin: 480, // max 8 h total
    regRestMin: 60 // min 1 h rest between stints
  }
});

// The four team cars = the four LMP2 entries of the replayed feed. Driver
// names are EXACTLY as the feed prints them (timingName match), and the
// first driver in each table is the one the feed shows in the car at the
// start of the replay — so the wall's "feed agrees who is in the car" check
// reads green from the first minute.
const D = (n, name, abbrev, fuelDry, extra = {}) => ({
  id: 'd' + n, name, abbrev, timingName: name,
  totalMs: 0, doubleStint: true, night: true, rain: true,
  fuelDry, fuelWet: Math.round((fuelDry - 0.5) * 100) / 100, fuelCurve: [],
  ...extra
});

const CARS = {
  1: {
    number: 26, name: 'G-Drive Racing By Algarve', make: 'Aurus', model: '01',
    lap: 118.5, burn: 3.1,
    drivers: [
      D(1, 'Leonard Hoogenboom', 'HOO', 3.05),
      D(2, 'Roman Rusinov', 'RUS', 3.2),
      D(3, 'James French', 'FRE', 3.1, { night: false })
    ]
  },
  2: {
    number: 34, name: 'Inter Europol Endurance', make: 'Ligier', model: 'JS P217',
    lap: 119.5, burn: 3.15,
    drivers: [
      D(1, 'Mathias Beche', 'BEC', 3.1),
      D(2, 'Jamie Winslow', 'WIN', 3.25, { doubleStint: false }),
      D(3, 'Jakub Smiechowski', 'SMI', 3.15)
    ]
  },
  3: {
    number: 45, name: 'Thunderhead Carlin Racing', make: 'Dallara', model: 'P217',
    lap: 118.0, burn: 3.2,
    drivers: [
      D(1, 'Jack Manchester', 'MAN', 3.2),
      D(2, 'Ben Barnicoat', 'BAR', 3.0),
      D(3, 'Harry Tincknell', 'TIN', 3.05)
    ]
  },
  4: {
    number: 96, name: 'K2 Uchino Racing', make: 'Oreca', model: '07',
    lap: 119.0, burn: 3.1,
    drivers: [
      D(1, 'Haruki Kurosawa', 'KUR', 3.1),
      D(2, 'Shaun Thong', 'THO', 3.2),
      D(3, 'Kenta Yamada', 'YAM', 3.15, { rain: false })
    ]
  }
};

for (const [id, c] of Object.entries(CARS)) {
  send({
    type: 'update',
    carId: id,
    patch: {
      number: c.number,
      name: c.name,
      make: c.make,
      model: c.model,
      currentDriverId: 'd1',
      drivers: c.drivers,
      config: {
        tankLiters: 75,
        startFuelL: 0, // full tank at the start
        burnPerLap: { dry: c.burn, wet: c.burn - 0.5, sc: 1.4, fcy: 1.0 },
        avgLapSec: { dry: c.lap, wet: c.lap + 13, sc: 150, fcy: 240 },
        tyreLifeKm: 300,
        tyreChangeSec: 25,
        fuelWarnL: 15,
        finishFuelL: 5,
        safetyFuelL: 3
      }
    }
  });
  send({ type: 'timingLink', carId: id, nr: String(c.number) });
  send({ type: 'timingAutoLap', carId: id, on: true });
}

const ok = await until(() =>
  Object.entries(CARS).every(([id, c]) =>
    state.cars[id]?.name === c.name &&
    String(state.cars[id]?.number) === String(c.number) &&
    state.cars[id]?.drivers?.length === 3 &&
    state.cars[id]?.config?.tankLiters === 75 &&
    state.timing.links?.[id] === String(c.number)) &&
  state.race.durationH === 24 &&
  state.event.refuelLps === 2.5 &&
  !state.race.startMs);

if (!ok) {
  console.error('\nFAILED — the server did not confirm the demo setup. State now:');
  for (const [id, c] of Object.entries(state.cars)) {
    console.error(`  car ${id}: #${c.number} "${c.name}" drivers=${c.drivers?.length} tank=${c.config?.tankLiters}`);
  }
  process.exit(1);
}

console.log('DEMO READY on port ' + port + ':');
for (const [id, c] of Object.entries(CARS)) {
  console.log(`  car ${id}  ->  #${c.number}  ${c.name}  (${c.drivers.map(d => d.abbrev).join('/')})  linked to feed nr ${c.number}`);
}
console.log('  race: "24H Endurance — DEMO", 24 h, NOT started (START RACE is a demo beat)');
console.log('  live feed disconnected — open the replay instead:');
console.log('    SETTINGS -> REPLAYS -> replay-20260822-200722.jsonl  (2 h 08, 24 cars)');
console.log('  then SETTINGS -> BACKUPS -> SAVE SNAPSHOT NOW  = your demo reset point.');
ws.close();
process.exit(0);
