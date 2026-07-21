// WebSocket hub run on the pit wall PC (embedded in the Electron main process).
// Holds the authoritative race state, applies all mutations, broadcasts the
// full state to every connected client, and persists to disk after each change.

import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import { defaultState, defaultCar, deepMerge, emptyStop, effectiveBurn, PORT } from '../shared/model.js';

export function startServer({ dataFile, port = PORT, tickMs = 10000 } = {}) {
  let state = defaultState();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      console.log('[server] restored state from', dataFile);
      migrate(state);
    } catch (e) {
      console.error('[server] could not restore state:', e.message);
    }
  }

  // Fill in fields added after a saved state was written.
  function migrate(s) {
    s.race.fcy ??= { active: false, startMs: null };
    for (const c of Object.values(s.cars)) {
      c.make ??= '';
      c.model ??= '';
      c.config.refuelLps ??= 2.5;
      c.config.tyreChangeSec ??= 25;
      c.config.trackKm ??= 4.0;
      c.config.fcySpeedKmh ??= 80;
      c.config.finishFuelL ??= 5;
      c.config.safetyFuelL ??= 3;
      for (const d of c.drivers) {
        d.doubleStint ??= true;
        d.night ??= true;
        d.rain ??= true;
        d.fuelDry ??= 0;
        d.fuelWet ??= 0;
      }
    }
  }

  const wss = new WebSocketServer({ port });
  console.log('[server] listening on port', port);
  wss.on('error', e => console.error('[server] error:', e.message));

  let saveTimer = null;
  function save() {
    if (!dataFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(dataFile, JSON.stringify(state));
      } catch (e) {
        console.error('[server] save failed:', e.message);
      }
    }, 400);
  }

  function broadcast() {
    const msg = JSON.stringify({ type: 'state', state });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
    save();
  }

  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'state', state }));
    ws.on('message', raw => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        handle(m);
      } catch (e) {
        console.error('[server] bad message:', e.message);
      }
      broadcast();
    });
  });

  function handle(m) {
    const car = m.carId ? state.cars[m.carId] : null;
    switch (m.type) {
      case 'update':
        if (car && m.patch) deepMerge(car, m.patch);
        break;

      case 'race':
        if (m.patch) {
          deepMerge(state.race, m.patch);
          // A (re)scheduled start realigns the first stint of every car that
          // has not turned a lap yet.
          if ('startMs' in m.patch) {
            for (const c of Object.values(state.cars)) {
              if (c.state.totalLaps === 0 && c.stintHistory.length === 0) {
                c.state.stintStartMs = state.race.startMs;
              }
            }
          }
        }
        break;

      case 'startRace': {
        const now = Date.now();
        // Starts the race now, also overriding a scheduled start still in the future.
        if (!state.race.startMs || now < state.race.startMs) {
          state.race.startMs = now;
          for (const c of Object.values(state.cars)) {
            if (c.state.totalLaps === 0 && c.stintHistory.length === 0) {
              c.state.stintStartMs = now;
            }
          }
        }
        break;
      }

      case 'resetRace': {
        // Fresh race, but keep each car's tuning (config, names, drivers).
        state.race.startMs = null;
        state.race.fcy = { active: false, startMs: null };
        for (const c of Object.values(state.cars)) {
          const fresh = defaultCar(c.id, c.number).state;
          fresh.fuelLiters = c.config.tankLiters;
          c.state = fresh;
          c.nextStop = emptyStop();
          c.stintHistory = [];
          for (const d of c.drivers) d.totalMs = 0;
        }
        break;
      }

      case 'fcy':
        state.race.fcy = {
          active: !!m.active,
          startMs: m.active ? Date.now() : null
        };
        break;

      // Laps drive tyre wear and counters only — fuel burns by time (see the
      // tick loop below), so a logged lap must not subtract fuel again.
      case 'lap':
        if (car) {
          car.state.totalLaps++;
          car.state.lapsThisStint++;
          car.state.tyreLapsOnSet++;
          if (m.lapSec) car.state.lastLapSec = m.lapSec;
        }
        break;

      case 'undoLap':
        if (car && car.state.totalLaps > 0) {
          car.state.totalLaps--;
          car.state.lapsThisStint = Math.max(0, car.state.lapsThisStint - 1);
          car.state.tyreLapsOnSet = Math.max(0, car.state.tyreLapsOnSet - 1);
        }
        break;

      case 'applyStop':
        if (car) applyStop(car);
        break;
    }
  }

  // Called from the pit wall when the stop is complete: folds the finished
  // stint into history/wear totals, then applies the planned service.
  function applyStop(car) {
    const now = Date.now();
    const s = car.state;
    const stop = car.nextStop;
    const stintMs = s.stintStartMs ? Math.max(0, now - s.stintStartMs) : 0;

    for (const k of Object.keys(s.brakeUsedH)) {
      s.brakeUsedH[k] = +(s.brakeUsedH[k] + stintMs / 3600e3).toFixed(4);
    }
    const drv = car.drivers.find(d => d.id === car.currentDriverId);
    if (drv) drv.totalMs += stintMs;

    car.stintHistory.push({
      startMs: s.stintStartMs,
      endMs: now,
      driverId: car.currentDriverId,
      laps: s.lapsThisStint,
      service: { ...stop }
    });

    s.fuelLiters = Math.min(car.config.tankLiters, +(s.fuelLiters + (Number(stop.fuelLiters) || 0)).toFixed(2));
    if (stop.tyres) {
      s.tyreLapsOnSet = 0;
      s.tyreSetsUsed++;
    }
    if (stop.driverChange) car.currentDriverId = stop.driverChange;
    for (const k of ['padsFront', 'padsRear', 'discsFront', 'discsRear']) {
      if (stop[k]) s.brakeUsedH[k] = 0;
    }

    s.lapsThisStint = 0;
    s.stintStartMs = now;
    car.nextStop = emptyStop();
  }

  // Continuous fuel burn: while the race clock runs, each car's tank drains
  // at its effective burn rate divided by its lap time. Corrections come in
  // via the station's SET button; refuelling via applyStop.
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const running = state.race.startMs && now >= state.race.startMs;
    if (running && now > lastTick) {
      const dt = now - lastTick;
      for (const car of Object.values(state.cars)) {
        const fcy = state.race.fcy?.active;
        const burn = effectiveBurn(car, car.condition, fcy);
        const lapSec = (fcy ? car.config.avgLapSec.sc : car.config.avgLapSec[car.condition]) || 100;
        const litersPerMs = burn / (lapSec * 1000);
        car.state.fuelLiters = Math.max(0, +(car.state.fuelLiters - litersPerMs * dt).toFixed(3));
      }
      broadcast();
    }
    lastTick = now;
  }, tickMs);

  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  return { port, ips };
}
