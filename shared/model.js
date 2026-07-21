// Shared domain model + strategy math.
// This module runs both in the server (Node, on the pit wall PC) and in the
// renderer UIs, so it must stay dependency-free.

export const PORT = 8484;

export const CONDITIONS = [
  { id: 'dry', label: 'DRY' },
  { id: 'wet', label: 'WET' },
  { id: 'sc', label: 'SC / FCY' }
];

export const BRAKE_COMPONENTS = [
  { id: 'padsFront', label: 'PADS FRONT' },
  { id: 'padsRear', label: 'PADS REAR' },
  { id: 'discsFront', label: 'DISCS FRONT' },
  { id: 'discsRear', label: 'DISCS REAR' }
];

export const DRIVER_COLORS = ['#4cc2ff', '#ffb454', '#7ee787', '#ff7eb6'];

export function emptyStop() {
  return {
    fuelLiters: 0,
    tyres: false,
    driverChange: null,
    padsFront: false,
    padsRear: false,
    discsFront: false,
    discsRear: false,
    notes: '',
    status: 'draft' // draft -> sent -> box -> (applied)
  };
}

export function defaultDriver(n) {
  return {
    id: 'd' + n,
    name: `Driver ${n}`,
    totalMs: 0,
    doubleStint: true,
    night: true,
    rain: true,
    fuelDry: 0, // L/lap; 0 = use the car's default burn rate
    fuelWet: 0
  };
}

export function defaultCar(id, number) {
  return {
    id,
    number,
    name: `Car #${number}`,
    make: '',
    model: '',
    condition: 'dry',
    drivers: [1, 2, 3, 4].map(defaultDriver),
    currentDriverId: 'd1',
    config: {
      tankLiters: 100,
      burnPerLap: { dry: 2.8, wet: 2.4, sc: 1.2 },
      avgLapSec: { dry: 105, wet: 118, sc: 165 },
      tyreLifeLaps: 90,
      tyreSets: 12,
      brakeLifeH: { padsFront: 8, padsRear: 10, discsFront: 14, discsRear: 16 },
      maxStintMin: 65,
      pitLossSec: 55,
      refuelLps: 2.5,
      tyreChangeSec: 25,
      trackKm: 4.0,
      fcySpeedKmh: 80,
      finishFuelL: 5,
      safetyFuelL: 3
    },
    state: {
      stintStartMs: null,
      lapsThisStint: 0,
      totalLaps: 0,
      fuelLiters: 100,
      tyreLapsOnSet: 0,
      tyreSetsUsed: 1,
      brakeUsedH: { padsFront: 0, padsRear: 0, discsFront: 0, discsRear: 0 },
      lastLapSec: null
    },
    nextStop: emptyStop(),
    stintHistory: []
  };
}

export function defaultState() {
  const cars = {};
  for (let i = 1; i <= 4; i++) cars[String(i)] = defaultCar(String(i), String(i));
  return {
    race: {
      name: '24H Race',
      durationH: 24,
      startMs: null,
      fcy: { active: false, startMs: null }
    },
    cars
  };
}

// Merge a patch into target. Plain objects merge recursively; arrays and
// scalars replace wholesale.
export function deepMerge(target, patch) {
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])
    ) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export function raceClock(race, now) {
  const totalMs = race.durationH * 3600e3;
  if (!race.startMs) {
    return { running: false, scheduled: false, elapsedMs: 0, remainingMs: totalMs, totalMs };
  }
  if (now < race.startMs) {
    return {
      running: false, scheduled: true, msToStart: race.startMs - now,
      elapsedMs: 0, remainingMs: totalMs, totalMs
    };
  }
  const elapsedMs = Math.max(0, now - race.startMs);
  return { running: true, scheduled: false, elapsedMs, remainingMs: Math.max(0, totalMs - elapsedMs), totalMs };
}

// Burn rate for a condition, preferring the current driver's own dry/wet
// consumption when set (> 0); SC always uses the car-level figure. An active
// FCY procedure overrides everything with the car's SC/FCY burn rate.
export function effectiveBurn(car, cond = car.condition, fcy = false) {
  if (fcy) return car.config.burnPerLap.sc || 0;
  const d = car.drivers.find(x => x.id === car.currentDriverId);
  if (d) {
    if (cond === 'dry' && d.fuelDry > 0) return d.fuelDry;
    if (cond === 'wet' && d.fuelWet > 0) return d.fuelWet;
  }
  return car.config.burnPerLap[cond] || 0;
}

// Everything the UIs derive from raw car state, computed in one place.
export function carCalcs(car, race, now) {
  const cfg = car.config;
  const s = car.state;
  const cond = car.condition;
  const fcyActive = !!(race && race.fcy && race.fcy.active);
  const burn = effectiveBurn(car, cond, fcyActive) || 1;
  const lapMs = ((fcyActive ? cfg.avgLapSec.sc : cfg.avgLapSec[cond]) || 100) * 1000;
  const clock = raceClock(race, now);

  const stintElapsedMs = clock.running && s.stintStartMs ? Math.max(0, now - s.stintStartMs) : 0;

  // Fuel above the safety level is what strategy can actually spend; the
  // finish margin is what should still be on board at the flag.
  const safety = cfg.safetyFuelL || 0;
  const finishMargin = Math.max(cfg.finishFuelL || 0, safety);
  const usableFuel = Math.max(0, s.fuelLiters - safety);
  const lapsToEmpty = Math.floor(usableFuel / burn);
  const msToEmpty = lapsToEmpty * lapMs;

  const tyreLapsLeft = Math.max(0, cfg.tyreLifeLaps - s.tyreLapsOnSet);
  const msToTyres = tyreLapsLeft * lapMs;

  const msDriverLeft = Math.max(0, cfg.maxStintMin * 60e3 - stintElapsedMs);

  const brakes = {};
  for (const b of BRAKE_COMPONENTS) {
    const usedH = (s.brakeUsedH[b.id] || 0) + stintElapsedMs / 3600e3;
    const lifeH = cfg.brakeLifeH[b.id] || 1;
    brakes[b.id] = {
      usedH,
      lifeH,
      leftH: Math.max(0, lifeH - usedH),
      pct: Math.min(1, usedH / lifeH)
    };
  }

  const limits = [
    { key: 'fuel', label: 'FUEL', ms: msToEmpty },
    { key: 'tyres', label: 'TYRES', ms: msToTyres },
    { key: 'driver', label: 'DRIVER TIME', ms: msDriverLeft }
  ].sort((a, b) => a.ms - b.ms);
  const limit = limits[0];

  const lapsRemainingRace = Math.ceil(clock.remainingMs / lapMs);
  const fuelToEnd = lapsRemainingRace * burn + finishMargin;
  const fullStintLaps = Math.floor(Math.max(0, cfg.tankLiters - safety) / burn);

  // Fuel needed at the next stop: enough to reach the end with the finish
  // margin still on board, capped by tank size.
  const remainingAfterStop = Math.max(0, clock.remainingMs - limit.ms);
  const lapsAfterStop = Math.ceil(remainingAfterStop / lapMs);
  const fuelAtStop = Math.max(0, s.fuelLiters - Math.floor(limit.ms / lapMs) * burn);
  const suggestedFuel = Math.max(
    0,
    Math.min(cfg.tankLiters - fuelAtStop, lapsAfterStop * burn + burn + finishMargin - fuelAtStop)
  );

  return {
    clock, stintElapsedMs, burn, lapMs, fcyActive,
    safety, finishMargin, usableFuel,
    lapsToEmpty, msToEmpty,
    tyreLapsLeft, msToTyres,
    msDriverLeft,
    brakes,
    limit, limits,
    lapsRemainingRace, fuelToEnd, fullStintLaps,
    suggestedFuel
  };
}

// Stint blocks for the 24h timeline: past stints from history, the current
// stint projected to the limiting factor, then repeated full fuel stints
// until the end of the race.
export function projectStints(car, race, now) {
  const clock = raceClock(race, now);
  if (!clock.running) return [];
  const calcs = carCalcs(car, race, now);
  const start = race.startMs;
  const end = start + clock.totalMs;
  const blocks = [];

  for (const h of car.stintHistory) {
    blocks.push({ from: h.startMs - start, to: h.endMs - start, kind: 'past', driverId: h.driverId });
  }

  const s = car.state;
  if (s.stintStartMs) {
    const stopAt = Math.min(now + calcs.limit.ms, end);
    blocks.push({ from: s.stintStartMs - start, to: now - start, kind: 'current', driverId: car.currentDriverId });
    blocks.push({ from: now - start, to: stopAt - start, kind: 'projected', driverId: car.currentDriverId });

    // Future stints, fuel-limited full tanks.
    const stintMs = Math.max(calcs.fullStintLaps * calcs.lapMs, 10 * 60e3);
    let t = stopAt + (car.config.pitLossSec || 0) * 1000;
    let i = 0;
    while (t < end && i < 60) {
      const to = Math.min(t + stintMs, end);
      blocks.push({ from: t - start, to: to - start, kind: 'future', driverId: null });
      t = to + (car.config.pitLossSec || 0) * 1000;
      i++;
    }
  }
  return blocks;
}

// Estimated stationary time for a planned stop, in seconds. Refuelling and
// tyre work are assumed sequential (the safe assumption in most endurance
// series, where no other work is allowed while fuel is flowing).
export function stopServiceTime(car, stop = car.nextStop) {
  const cfg = car.config;
  const refuelSec = (Number(stop.fuelLiters) || 0) / (cfg.refuelLps || 2.5);
  const tyreSec = stop.tyres ? (cfg.tyreChangeSec || 0) : 0;
  return { refuelSec, tyreSec, totalSec: refuelSec + tyreSec };
}

// Full-course-yellow economics: while the field circulates at the FCY speed,
// every lap takes (fcyLap - greenLap) longer than under green, so a stop
// taken under FCY effectively costs that much less. Returns null until track
// length and FCY speed are set.
export function fcyCalc(car) {
  const cfg = car.config;
  const cond = car.condition === 'wet' ? 'wet' : 'dry';
  const greenLapSec = cfg.avgLapSec[cond] || 0;
  const trackKm = cfg.trackKm || 0;
  const fcyKmh = cfg.fcySpeedKmh || 0;
  if (!trackKm || !fcyKmh || !greenLapSec) return null;
  const fcyLapSec = (trackKm / fcyKmh) * 3600;
  const gainSec = fcyLapSec - greenLapSec;
  return {
    cond,
    greenLapSec,
    greenSpeedKmh: (trackKm / greenLapSec) * 3600,
    fcyLapSec,
    gainSec,
    netPitLossSec: (cfg.pitLossSec || 0) - gainSec
  };
}

// ---- formatting helpers ----

export function fmtClock(ms) {
  ms = Math.max(0, ms);
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  const s = Math.floor((ms % 60e3) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function fmtMinSec(ms) {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60e3);
  const s = Math.floor((ms % 60e3) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtLap(sec) {
  if (sec == null) return '--:--.-';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

export function fmtH(h) {
  let whole = Math.floor(h);
  let min = Math.round((h - whole) * 60);
  if (min === 60) { whole++; min = 0; }
  return `${whole}h${String(min).padStart(2, '0')}`;
}
