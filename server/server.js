// WebSocket hub run on the pit wall PC (embedded in the Electron main process).
// Holds the authoritative race state, applies all mutations, broadcasts the
// full state to every connected client, and persists to disk after each change.

import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultState, defaultCar, defaultDriver, defaultTiming, defaultEvent, EVENT_FIELDS,
  timingNrOf, deepMerge, emptyStop, effectiveBurn, pushLapTime, raceCondition, paceLapSec,
  FCY_MODES, PORT, defaultTyreSets, reconcileTyreSets, stopTyreSet, stintStats,
  learnLapSample, learnFuelReading, dirtyFuelRef, startFuelOf,
  currentTyreSet, tyreSetMileage, recommendedStops, resolveStop, stopPlanHash,
  pitVisitKind, stopServiceTime, BRAKE_COMPONENTS,
  defaultAllBrakeSets, reconcileBrakeSets, stopBrakeSet, brakeSetsOf, DEFAULT_BRAKE_SET_COUNT
} from '../shared/model.js';
import { createTimingService } from './livetiming.js';

export function startServer({ dataFile, backupDir, replayDir, port = PORT, tickMs = 10000 } = {}) {
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

  // Event settings are the single source of truth for values shared by all
  // cars; mirror them into every car config so the strategy math (which reads
  // car.config everywhere) stays untouched.
  function syncEventConfig(s) {
    for (const c of Object.values(s.cars)) {
      for (const f of EVENT_FIELDS) c.config[f] = s.event[f];
    }
  }

  // Align a car's first stint to the race start (or, joining a session already
  // under way, to the join — see anchorRaceStart). The fuel load at that moment
  // is a trusted quantity: it seeds the stint sheet's consumption figures and
  // anchors the burn learning.
  function seedFirstStint(c, startMs) {
    c.state.stintStartMs = startMs;
    // A car that has not turned a lap yet takes its configured start load —
    // the reading the rest of the seeding below is anchored on.
    c.state.fuelLiters = startFuelOf(c);
    c.state.stintFuelStartL = c.state.fuelLiters;
    learnFuelReading(c, c.state.fuelLiters, startMs);
  }

  // Fill in fields added after a saved state was written.
  function migrate(s) {
    s.race.fcy ??= { active: false, startMs: null };
    // Race-condition fields added with feed-driven FCY. A state written by an
    // older build only has active/startMs; default it to following the feed.
    s.race.fcy.mode ??= 'auto';
    s.race.fcy.source ??= s.race.fcy.active ? 'manual' : 'none';
    s.race.fcy.flag ??= null;
    s.race.fcy.overrideFlag ??= null;
    s.settings ??= {};
    s.settings.backupIntervalMin ??= 5;
    // States saved before event settings existed: adopt the first car's
    // values so a tuned setup survives the upgrade.
    if (!s.event) {
      s.event = defaultEvent();
      const first = Object.values(s.cars)[0];
      if (first) {
        for (const f of EVENT_FIELDS) s.event[f] = first.config[f] ?? s.event[f];
      }
    }
    s.event = { ...defaultEvent(), ...s.event };
    s.presets ??= {};
    s.raceSetups ??= {};
    s.timing = { ...defaultTiming(), ...(s.timing || {}) };
    s.timing.links ??= {};
    s.timing.autoLap ??= {};
    s.timing.wanted ??= false;
    s.timing.watchUrl ??= '';
    for (const c of Object.values(s.cars)) {
      c.make ??= '';
      c.model ??= '';
      // The track condition is DRY/WET only — neutralisations are race-wide
      // now. A car left on the old car-level 'sc' comes back on dry rather
      // than sitting on a condition no button can clear.
      if (c.condition !== 'dry' && c.condition !== 'wet') c.condition = 'dry';
      c.plan ??= null;
      c.savedPlans ??= {};
      c.config.fuelModel ??= 'driver-avg';
      c.config.startFuelL ??= 0;
      c.config.refuelLps ??= 2.5;
      c.config.tyreChangeSec ??= 25;
      c.config.trackKm ??= 4.0;
      c.config.fcySpeedKmh ??= 80;
      // Separate FCY / Code 60 rates: a car tuned before they existed inherits
      // its Safety Car figures, so nothing changes until they are edited.
      c.config.burnPerLap.fcy ??= c.config.burnPerLap.sc;
      c.config.avgLapSec.fcy ??= c.config.avgLapSec.sc;
      c.config.finishFuelL ??= 5;
      c.config.safetyFuelL ??= 3;
      c.state.inPit ??= false;
      c.state.pitEnterMs ??= null;
      c.state.avgLapSecLive ??= null;
      if (!Array.isArray(c.state.recentLapSec)) c.state.recentLapSec = [];
      if (!Array.isArray(c.state.stintLapSec)) c.state.stintLapSec = [];
      c.state.stintFuelStartL ??= null;
      c.state.liveSeenMs ??= null;
      c.state.pendingSetDecision ??= null;
      c.state.lastPitVisit ??= null;
      c.nextStop.tyreSetId ??= null;
      // The stop plan gained a situation, per-line pins and an approval.
      // `plan` is null by design — the card follows whatever is flying until
      // the engineer picks a tab — so only add the key when it is missing.
      if (!('plan' in c.nextStop)) c.nextStop.plan = null;
      c.nextStop.pinned ??= {};
      c.nextStop.approved ??= null;
      // Tyre life moved from laps to kilometres: a car tuned in laps keeps the
      // same life by converting it over the track length, so nothing changes
      // until the km figure is edited.
      c.config.tyreLifeKm ??= c.config.tyreLifeLaps > 0 && c.config.trackKm > 0
        ? Math.round(c.config.tyreLifeLaps * c.config.trackKm)
        : 300;
      c.config.driveThroughSec ??= 0;
      c.learn ??= { byDriver: {}, fuelRef: null };
      c.learn.byDriver ??= {};
      // Named tyre sets: a state saved before they existed gets a list built
      // from the configured count, with the sets consumed so far marked used.
      if (!Array.isArray(c.tyreSets) || c.tyreSets.length === 0) {
        c.tyreSets = defaultTyreSets(c.config.tyreSets || 12);
        const used = Math.max(1, Math.min(c.state.tyreSetsUsed || 1, c.tyreSets.length));
        for (let i = 0; i < used; i++) c.tyreSets[i].used = true;
        c.state.currentTyreSetId = c.tyreSets[used - 1].id;
      }
      reconcileTyreSets(c);
      // Numbered brake sets: a state saved before they existed gets a rack
      // built from the default counts, with the hours already on the car
      // carried by the set that is fitted (state.brakeUsedH stays the live
      // counter), so nothing is lost mid-race by an update.
      c.config.brakeSets ??= { ...DEFAULT_BRAKE_SET_COUNT };
      c.nextStop.brakeSetIds ??= { padsFront: null, padsRear: null, discsFront: null, discsRear: null };
      if (!c.brakeSets || typeof c.brakeSets !== 'object') c.brakeSets = defaultAllBrakeSets(c.config.brakeSets);
      reconcileBrakeSets(c);
      if (!Array.isArray(c.drivers) || c.drivers.length === 0) {
        c.drivers = [1, 2, 3, 4].map(defaultDriver);
      }
      for (const d of c.drivers) {
        d.doubleStint ??= true;
        d.night ??= true;
        d.rain ??= true;
        d.fuelDry ??= 0;
        d.fuelWet ??= 0;
        d.abbrev ??= '';
        d.timingName ??= '';
        if (!Array.isArray(d.fuelCurve)) d.fuelCurve = [];
      }
      if (!c.drivers.some(d => d.id === c.currentDriverId)) {
        c.currentDriverId = c.drivers[0].id;
      }
    }
    syncEventConfig(s);
  }

  migrate(state); // also seeds fields on a fresh default state (timing etc.)

  const wss = new WebSocketServer({ port });
  console.log('[server] listening on port', port);
  wss.on('error', e => console.error('[server] error:', e.message));

  // One completed lap, from either a station's +LAP or the timing feed:
  // counters and tyre wear (fuel burns by time), the rolling reference lap,
  // the stint sheet, and — on representative green laps — the per-driver
  // pace learning.
  function recordLap(car, lapSec) {
    car.state.totalLaps++;
    car.state.lapsThisStint++;
    car.state.tyreLapsOnSet++;
    bankTyreKm(car, +1);
    if (lapSec > 0) {
      car.state.lastLapSec = +(+lapSec).toFixed(3);
      car.state.stintLapSec.push(car.state.lastLapSec);
      if (car.state.stintLapSec.length > 300) car.state.stintLapSec.shift();
      // Learn pace only under green and out of the pit lane, judged against
      // the rolling average *before* this lap enters it.
      if (raceCondition(state.race).pace === null && !car.state.inPit) {
        learnLapSample(car, car.state.lastLapSec);
      }
      // Feeds the per-lap-time fuel curve; in/out and traffic laps are
      // filtered out inside pushLapTime.
      Object.assign(car.state, pushLapTime(car.state.recentLapSec, car.state.lastLapSec));
    }
  }

  // Mileage on the rubber that is on the car, banked lap by lap rather than at
  // the stop — a set carries its distance even if the stop is logged late or
  // never. Laps run under a neutralisation are counted separately: they are far
  // gentler on a tyre, and at the flag the split is what says whether a set is
  // actually worn out or has spent an hour crawling behind a safety car.
  // `dir` is +1 for a lap, −1 to take one back (UNDO LAP).
  function bankTyreKm(car, dir) {
    const set = currentTyreSet(car);
    const km = +car.config.trackKm || 0;
    if (!set || !(km > 0)) return;
    const neutral = ['sc', 'fcy'].includes(raceCondition(state.race).pace);
    set.km = Math.max(0, +((+set.km || 0) + dir * km).toFixed(2));
    if (neutral) set.kmFcy = Math.max(0, +((+set.kmFcy || 0) + dir * km).toFixed(2));
    set.kmFcy = Math.min(set.km, +set.kmFcy || 0);
    if (dir > 0) set.used = true;
  }

  // ---- the feed closes the stop ------------------------------------------
  // Live timing reports the car in and out of the pit lane, so the last two
  // steps of a stop need no human: entry stages it (fuel burn pauses), exit
  // applies it. What it must never do is apply a service to a car that only
  // drove through — hence pitVisitKind, and hence the undo.
  const undoBuffer = new Map(); // carId → { car: deep copy, atMs }

  // Every applied stop waits for the engineer to say what actually happened.
  // There is no deadline: it is answered — went to plan, or here is what really
  // happened — or it stays on screen. The pre-stop snapshot is kept for exactly
  // that long, so a correction can be worked out against it whenever it comes.
  function openStopReview(car, visit) {
    undoBuffer.set(car.id, { car: JSON.parse(JSON.stringify(car)), atMs: Date.now() });
    return { ...visit, applied: true, atMs: Date.now() };
  }

  // The stop did not go to plan. The engineer fills in what actually happened
  // and every figure moves to match — as a delta on the state as it stands, so
  // the laps run since the stop are untouched and a correction ten minutes
  // later is as safe as one made straight away.
  function correctStop(car, actual) {
    const snapEntry = undoBuffer.get(car.id);
    const h = car.stintHistory[car.stintHistory.length - 1];
    if (!snapEntry || !h) return false;
    const snap = snapEntry.car;
    const applied = h.service || {};
    const s = car.state;
    const now = Date.now();
    const sinceH = Math.max(0, now - (h.endMs || now)) / 3600e3;
    const stintH = Math.max(0, (h.endMs || now) - h.startMs) / 3600e3;

    // Fuel — the two leave-with figures differ by a constant, whatever has
    // burnt since, so the correction is that difference. A stop that took no
    // fuel leaves the level the car came in with.
    const entryFuel = snap.state.fuelLiters;
    const leaveOf = st => (Number(st.fuelLiters) > 0 ? Number(st.fuelLiters) : entryFuel);
    const delta = leaveOf(actual) - leaveOf(applied);
    if (delta !== 0) {
      s.fuelLiters = Math.max(0, Math.min(car.config.tankLiters, +(s.fuelLiters + delta).toFixed(2)));
      dirtyFuelRef(car); // the span across a corrected stop is not a real one
    }

    // Tyres — move the laps and mileage run since the stop onto the set that
    // really ran, and give the set that was never fitted its old figures back.
    const sets = reconcileTyreSets(car);
    const snapSets = new Map((snap.tyreSets || []).map(t => [t.id, t]));
    const outgoingId = h.tyreSetId; // what was on the car when it came in
    const fitted = sets.find(t => t.id === s.currentTyreSetId);
    const wantId = actual.tyres ? (actual.tyreSetId || fitted?.id) : outgoingId;
    const target = wantId ? sets.find(t => t.id === wantId) : null;
    if (fitted && target && target.id !== fitted.id) {
      const snapFitted = snapSets.get(fitted.id);
      const kmSince = Math.max(0, +(fitted.km - (snapFitted?.km || 0)).toFixed(2));
      const kmFcySince = Math.max(0, +(fitted.kmFcy - (snapFitted?.kmFcy || 0)).toFixed(2));
      // laps the fitted set carried the moment it went on
      const lapsAtFit = fitted.id === outgoingId ? snap.state.tyreLapsOnSet : (snapFitted?.laps || 0);
      const lapsSince = Math.max(0, s.tyreLapsOnSet - lapsAtFit);

      fitted.km = Math.max(0, +(fitted.km - kmSince).toFixed(2));
      fitted.kmFcy = Math.max(0, +(fitted.kmFcy - kmFcySince).toFixed(2));
      if (snapFitted) { fitted.laps = snapFitted.laps; fitted.used = snapFitted.used; }

      target.km = +((target.km || 0) + kmSince).toFixed(2);
      target.kmFcy = +((target.kmFcy || 0) + kmFcySince).toFixed(2);
      target.used = true;
      const targetLapsAtFit = target.id === outgoingId
        ? snap.state.tyreLapsOnSet
        : (snapSets.get(target.id)?.laps || 0);
      s.currentTyreSetId = target.id;
      s.tyreLapsOnSet = targetLapsAtFit + lapsSince;
      s.tyreSetsUsed = sets.filter(t => t.used).length;
    }
    // Nothing came off if the tyres were never changed.
    if (!actual.tyres) s.pendingSetDecision = null;

    // Driver — whoever actually got in; nobody means the one who was already
    // there. Seat time follows, since the running stint is credited at the
    // next stop.
    const wantDriver = actual.driverChange || snap.currentDriverId;
    if (wantDriver && wantDriver !== car.currentDriverId) car.currentDriverId = wantDriver;

    // Brakes — rebuild each component group from the pre-stop reading rather
    // than patching it. The pool goes back to what it was before the stop, then
    // the change that really happened is replayed onto it: the part that came
    // off banks the hours it had at the stop, the set that really went on
    // becomes the live one, and everything run since is added on top. A group
    // that was not touched keeps the part that came in, hours unbroken.
    reconcileBrakeSets(car);
    for (const b of BRAKE_COMPONENTS) {
      const sets = brakeSetsOf(car, b.id);
      const snapSets = new Map((snap.brakeSets?.[b.id] || []).map(t => [t.id, t]));
      for (const t of sets) {
        const sn = snapSets.get(t.id);
        if (sn) { t.hours = sn.hours; t.used = sn.used; }
      }
      const preId = snap.state.currentBrakeSetId?.[b.id] || null; // part that came in
      const hoursAtStop = Math.max(0, (snap.state.brakeUsedH[b.id] || 0) + stintH);
      if (!actual[b.id]) {
        if (preId) s.currentBrakeSetId[b.id] = preId;
        s.brakeUsedH[b.id] = +(hoursAtStop + sinceH).toFixed(4);
        continue;
      }
      const off = sets.find(t => t.id === preId);
      if (off) { off.hours = +hoursAtStop.toFixed(4); off.used = true; }
      const wantId = actual.brakeSetIds?.[b.id] || null;
      const on = sets.find(t => t.id === wantId && !t.scrapped) ||
        sets.find(t => !t.used && !t.scrapped && t.id !== preId) ||
        sets.filter(t => t.id !== preId && !t.scrapped).sort((x, y) => x.hours - y.hours)[0] ||
        off;
      if (!on) continue;
      on.used = true;
      s.currentBrakeSetId[b.id] = on.id;
      s.brakeUsedH[b.id] = +((on.id === preId ? hoursAtStop : on.hours || 0) + sinceH).toFixed(4);
    }

    // The sheet records what happened, not what was planned.
    h.service = { ...applied, ...actual };
    h.corrected = true;
    h.confirmed = { by: String(actual.by || '').slice(0, 24) || 'engineer', atMs: now, corrected: true };
    undoBuffer.delete(car.id);
    car.state.lastPitVisit = null;
    return true;
  }

  function finishPitVisit(car, pitMs) {
    const armed = car.nextStop.status !== 'draft';
    const visit = pitVisitKind(car, pitMs, armed);
    const running = state.race.startMs && Date.now() >= state.race.startMs;
    const stopped = raceCondition(state.race).pace === 'stopped'; // red / chequered
    visit.atMs = Date.now();
    visit.applied = false;
    // A car sitting in the lane under a red flag has not done a pit stop.
    if (visit.kind === 'service' && running && !stopped) {
      const review = openStopReview(car, visit);
      applyStop(car, visit);
      car.state.lastPitVisit = review;
      return;
    }
    if (visit.kind === 'service') visit.kind = 'held'; // right length, wrong moment
    // The station reads this to say what happened, and to offer the one-tap
    // correction when the app deliberately did nothing.
    car.state.lastPitVisit = visit;
  }

  // Start the race over: every car's running data, stint sheet, seat time and
  // rubber go back to zero, and each tank to its configured start load. Car
  // tuning (config, names, drivers) is kept — a reset is a new race, not a new
  // team. Driven by the RESET RACE button and by adopting a new feed session.
  function resetRaceData() {
    state.race.startMs = null;
    state.race.fcy = { mode: 'auto', active: false, startMs: null, source: 'none', flag: null, overrideFlag: null };
    const nowOnline = stationsOnline();
    for (const c of Object.values(state.cars)) {
      const fresh = defaultCar(c.id, c.number).state;
      fresh.fuelLiters = startFuelOf(c);
      // A station that is connected through the reset stays "seen" — only its
      // car's race data starts over.
      if (nowOnline[c.id]) fresh.liveSeenMs = Date.now();
      c.state = fresh;
      c.nextStop = emptyStop();
      c.stintHistory = [];
      for (const d of c.drivers) d.totalMs = 0;
      // Fresh rubber and a clean learning slate — a reset usually means a new
      // event, where old pace/burn data would only mislead.
      c.tyreSets = defaultTyreSets(c.config.tyreSets || 12);
      c.tyreSets[0].used = true;
      c.state.currentTyreSetId = c.tyreSets[0].id;
      // A fresh rack too, with the first of each set fitted.
      c.brakeSets = defaultAllBrakeSets(c.config.brakeSets);
      c.state.currentBrakeSetId = Object.fromEntries(
        BRAKE_COMPONENTS.map(b => [b.id, c.brakeSets[b.id][0].id]));
      c.learn = { byDriver: {}, fuelRef: null };
      reconcileTyreSets(c);
      reconcileBrakeSets(c);
    }
  }

  // ---- feed session guard ---------------------------------------------------
  // The race data belongs to exactly ONE session. A feed showing a different
  // one — the next race of the weekend, another session picked in the Al Kamel
  // list, a laptop left connected since qualifying, a reconnect to a session
  // already under way — must never pour its laps, clock and flags into the
  // numbers already on screen. That is how a 30 minute stint ends up reading
  // 136 laps, a stint clock hours old and an empty tank nobody ever burnt.
  //
  // So: the session the data belongs to is remembered, and any mismatch stops
  // the feed from touching the race until the pit wall says which it is —
  // a fresh race for the new session, or keep what is on screen.

  function sessionKeyOf(snap) {
    // Replays are simulations: they never write to the race state (the timing
    // service drops their events), so they can never own the race data either.
    if (!snap || snap.conn !== 'connected') return null;
    return String(snap.session?.name || '').trim() || null;
  }

  // Has anything actually been raced into this state? A pristine state adopts
  // whatever session the feed is on without asking; one with laps or finished
  // stints in it is somebody's race, and only the pit wall may throw it away.
  // A clock already running counts as raced-in even with no laps logged yet —
  // silently re-anchoring a live race onto another session's clock would move
  // the start out from under the crew.
  function raceDataEmpty() {
    if (state.race.startMs && Date.now() >= state.race.startMs) return false;
    return Object.values(state.cars)
      .every(c => c.state.totalLaps === 0 && c.stintHistory.length === 0);
  }

  function bindSession(key) {
    state.timing.sessionKey = key || null;
    state.timing.sessionAlert = null;
  }

  // Reconcile the bound session with what the feed is showing. `name` is the
  // session-change event's own name, used because a couple of feeds clear the
  // board before the new name reaches the snapshot.
  function syncSessionFromFeed(name = null) {
    const key = (name && String(name).trim()) || sessionKeyOf(timing.snapshot());
    if (!key) return false;
    const alert = state.timing.sessionAlert;
    if (alert) {
      // Already asked — keep the question pointed at the session the feed is
      // on now, in case it moved on again while nobody answered.
      if (alert.to === key) return false;
      alert.to = key;
      return true;
    }
    if (state.timing.sessionKey === key) return false;
    if (raceDataEmpty()) {
      bindSession(key); // nothing to lose — this race is this session
      return true;
    }
    state.timing.sessionAlert = {
      from: state.timing.sessionKey,
      to: key,
      ms: Date.now(),
      laps: Object.values(state.cars).reduce((n, c) => n + c.state.totalLaps, 0)
    };
    console.log(`[server] feed session "${state.timing.sessionKey || '—'}" → "${key}" — feed held until the pit wall answers`);
    return true;
  }

  // Fresh race for the session the feed is on: the previous session's laps,
  // stints, seat time and rubber go, the clock re-anchors to the feed and every
  // car's first stint starts here.
  function startFreshForSession(key) {
    resetRaceData();
    bindSession(key || sessionKeyOf(timing.snapshot()));
    syncRaceDurationFromFeed();
    syncRaceStartFromFeed();
  }

  // ---- live timing (upstream connection lives here, on the pit wall PC) ----
  // Decoded standings are rebroadcast to every client as a separate 'timing'
  // message so the high-frequency feed never hits the persisted race state.
  // Lap and pit events for linked cars flow into the strategy state below.
  function onTimingEvent(ev) {
    // The session change is the one event that must be seen while the feed is
    // held — it is what raises (or re-points) the question in the first place.
    if (ev.type === 'session') {
      if (syncSessionFromFeed(ev.name)) broadcast();
      return;
    }
    if (ev.type !== 'lap' && ev.type !== 'pitIn' && ev.type !== 'pitOut') return;
    // Feed and race state disagree about which session this is: nothing from
    // the feed may touch the numbers until the pit wall answers.
    if (state.timing.sessionAlert) return;
    const now = Date.now();
    const running = state.race.startMs && now >= state.race.startMs;
    let changed = false;
    for (const car of Object.values(state.cars)) {
      // Auto lap is on by default — only an explicit OFF blocks the feed.
      if (state.timing.autoLap[car.id] === false) continue;
      if (timingNrOf(state.timing, car) !== String(ev.nr).trim()) continue;
      // A feed event for a linked car proves the car is out there running,
      // station connected or not.
      car.state.liveSeenMs = now;
      changed = true;
      if (ev.type === 'lap') {
        // Same rules as a station's +LAP: counters and tyre wear only, fuel
        // burns by time. Only while the race clock runs (ignores qualifying).
        if (!running) continue;
        recordLap(car, ev.lapSec);
      } else if (ev.type === 'pitIn') {
        car.state.inPit = true;
        car.state.pitEnterMs = now;
        // The pit-lane crawl makes the fuel span unrepresentative.
        dirtyFuelRef(car);
      } else {
        // Pit exit: the feed has just told us the whole stop is over, so the
        // engineer should not have to press anything to end it.
        const enteredMs = car.state.pitEnterMs;
        car.state.inPit = false;
        car.state.pitEnterMs = null;
        finishPitVisit(car, enteredMs ? now - enteredMs : 0);
      }
      changed = true;
    }
    if (changed) broadcast();
  }

  const timing = createTimingService({
    onEvent: onTimingEvent,
    onLog: m => console.log('[timing]', m),
    replayDir
  });

  // The configured race duration is only a pre-event guess. Once a connected
  // feed publishes the session length there is no reason to keep planning
  // against the settings value, so it is adopted whether or not the clock
  // follow lock is on. Remaining-only feeds can't provide a length and keep
  // the configured duration.
  function syncRaceDurationFromFeed() {
    const totalUs = timing.engine.totalUs();
    if (!(totalUs > 0)) return false;
    const durationH = Math.round((totalUs / 3600e6) * 1e4) / 1e4;
    if (state.race.durationH === durationH) return false;
    state.race.durationH = durationH;
    return true;
  }

  function anchorRaceStart(startMs, thresholdMs) {
    if (Math.abs((state.race.startMs ?? 0) - startMs) <= thresholdMs) return false;
    state.race.startMs = startMs;
    // A start in the past means the session was already running when we joined
    // it. The race clock belongs back there — the stint sheet does not: the
    // stint and its fuel reading start at the join, not at a start nobody was
    // connected for. Back-dating them is what produced a 100 minute stint on a
    // 65 minute limit and a tank drained by laps the app never saw.
    const seedMs = Math.max(startMs, Date.now());
    for (const c of Object.values(state.cars)) {
      if (c.state.totalLaps === 0 && c.stintHistory.length === 0) {
        seedFirstStint(c, seedMs);
      }
    }
    return true;
  }

  // Pull the race clock onto the feed's session clock: the duration is
  // adopted, and the start time is anchored so ELAPSED + TO GO always equals
  // the feed's clock; remaining-only feeds (TeamStream without a session
  // window) keep the configured duration and anchor the finish instead.
  // While the session has not started, the start is held — a race clock
  // running before the field is released would be fiction. `thresholdMs`
  // ignores sub-threshold drift so the follow tick doesn't rebroadcast the
  // whole state every second over normal clock jitter.
  function syncRaceClockFromFeed(thresholdMs = 0) {
    let changed = syncRaceDurationFromFeed();
    const remainUs = timing.engine.remainingUs();
    if (remainUs == null) return changed;
    const totalUs = timing.engine.totalUs();
    let startMs;
    if (totalUs != null) {
      const elapsedUs = timing.engine.sessionElapsedUs();
      if (elapsedUs == null) return changed; // session not started yet — hold
      startMs = Math.round(Date.now() - elapsedUs / 1000);
    } else {
      startMs = Math.round(Date.now() - (state.race.durationH * 3600e3 - remainUs / 1000));
    }
    return anchorRaceStart(startMs, thresholdMs) || changed;
  }

  // The feed recognises the session start, so the race clock starts itself —
  // nobody should have to press START RACE while the timekeeper's clock is
  // already running. One-shot: once the race clock runs, only the follow lock
  // keeps realigning it.
  function syncRaceStartFromFeed() {
    if (state.race.startMs && Date.now() >= state.race.startMs) return false;
    const elapsedUs = timing.engine.sessionElapsedUs();
    if (elapsedUs == null) return false;
    const remainUs = timing.engine.remainingUs();
    if (remainUs != null && remainUs <= 0) return false; // session already over
    return anchorRaceStart(Math.round(Date.now() - elapsedUs / 1000), 0);
  }

  // ---- race condition (feed flag → race-wide neutralisation) ----------------
  // The timing feed's flag is authoritative unless the pit wall has forced an
  // override. A *change* in the feed's flag releases any force back to AUTO:
  // the override exists to correct a wrong or late flag, not to latch for the
  // rest of the race. Returns true when the persisted state changed.
  function syncConditionFromFeed() {
    const snap = timing.snapshot();
    // A feed sitting on another session than the race data flies that
    // session's flags — held, exactly like its laps, until that is resolved.
    const live = snap.conn === 'connected' && !state.timing.sessionAlert;
    const flag = live ? (snap.session?.flag ?? null) : null;
    const fcy = state.race.fcy;
    let changed = false;

    if (flag !== fcy.flag) {
      // Release the override only when the feed moves away from the flag that
      // was showing when the pit wall took control — that is the new
      // information the override was compensating for. Comparing against
      // `overrideFlag` (not the previous flag) means the first flag the server
      // ever sees, or the feed connecting later, cannot cancel a manual call.
      // Losing the feed (flag → null) never releases it either.
      if (flag != null && fcy.mode !== 'auto' && flag !== fcy.overrideFlag) {
        fcy.mode = 'auto';
        fcy.overrideFlag = null;
      }
      fcy.flag = flag;
      changed = true;
    }

    const cond = raceCondition(state.race, flag);
    const active = cond.pace === 'sc' || cond.pace === 'fcy';
    if (active !== fcy.active) {
      fcy.active = active;
      fcy.startMs = active ? Date.now() : null;
      changed = true;
    }
    if (cond.source !== fcy.source) {
      fcy.source = cond.source;
      changed = true;
    }
    // The condition id is stored so every client shows the same label without
    // having to re-derive it from a timing snapshot it may not have yet.
    if (cond.id !== fcy.condition) {
      fcy.condition = cond.id;
      changed = true;
    }
    return changed;
  }

  let lastTimingJson = '';
  function broadcastTiming(force = false) {
    const json = JSON.stringify({ type: 'timing', timing: timing.snapshot() });
    if (!force && json === lastTimingJson) return;
    lastTimingJson = json;
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(json);
    }
  }
  setInterval(() => {
    let dirty = false;
    // Connected feed: the published session length always wins over the
    // configured duration, and the session going live starts the race clock.
    // Follow mode additionally locks the whole clock to the feed (red-flag
    // freezes, drift corrected within ~2 s).
    if (timing.snapshot().conn === 'connected') {
      // Which session is this? Answered first — while it is open the feed
      // drives nothing: not the clock, not the duration, not the flag.
      if (syncSessionFromFeed()) dirty = true;
      if (!state.timing.sessionAlert) {
        if (state.timing.followClock) {
          if (syncRaceClockFromFeed(1500)) dirty = true;
        } else {
          if (syncRaceDurationFromFeed()) dirty = true;
          if (syncRaceStartFromFeed()) dirty = true;
        }
      }
    }
    // A flag change from the feed neutralises (or releases) every car at once.
    if (syncConditionFromFeed()) dirty = true;
    if (dirty) broadcast();
    broadcastTiming();
  }, 1000);

  // The pit wall connected the feed before a crash/restart — resume it so the
  // race never loses timing to a reboot.
  if (state.timing.wanted && (state.timing.url || state.timing.host)) {
    timing.connect(state.timing).then(() => broadcastTiming(true)).catch(() => {});
    if (state.timing.watchUrl) timing.flagWatchConnect(state.timing.watchUrl);
  }

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

  // The app's own plan for every car — green, code 60 and safety car — kept
  // fresh here rather than on a screen, so it exists from lights out whether or
  // not a station is connected, and the wall can show the crew what would
  // happen if a yellow dropped right now. Purely derived: nothing downstream
  // acts on it until the engineer sends or approves a stop.
  function refreshAutoStops() {
    const now = Date.now();
    for (const car of Object.values(state.cars)) {
      try {
        car.autoStop = recommendedStops(car, state.race, now);
        // An approval is for the plan the engineer read. If any line has moved
        // materially since, say so rather than letting the tick stand.
        const ap = car.nextStop.approved;
        if (ap) {
          const plan = car.autoStop[car.nextStop.plan || 'green'] || car.autoStop.green;
          ap.stale = stopPlanHash(resolveStop(car, plan)) !== ap.hash;
        }
      } catch (e) {
        car.autoStop = null;
      }
    }
  }

  // Has anybody put anything in this stop yet? A blank one is safe to fill from
  // the app's plan; one with figures in it belongs to the engineer.
  function stopIsBlank(stop) {
    return !stop.fuelLiters && !stop.tyres && !stop.tyreSetId && !stop.driverChange &&
      !stop.padsFront && !stop.padsRear && !stop.discsFront && !stop.discsRear;
  }

  // Write the resolved plan (app's answer + the engineer's pins) into the stop
  // itself. Only ever called from a deliberate action — sending, boxing or
  // approving — so a draft nobody has touched never rewrites itself under the
  // engineer's hands, and applyStop keeps executing exactly what is on screen.
  function materialiseStop(car) {
    const plans = car.autoStop || recommendedStops(car, state.race, Date.now());
    const plan = plans[car.nextStop.plan || 'green'] || plans.green;
    const r = resolveStop(car, plan);
    Object.assign(car.nextStop, {
      fuelLiters: r.fuelLiters,
      fuelMode: r.fuelMode,
      tyres: r.tyres,
      tyreSetId: r.tyreSetId,
      driverChange: r.driverChange,
      padsFront: r.padsFront,
      padsRear: r.padsRear,
      discsFront: r.discsFront,
      discsRear: r.discsRear,
      brakeSetIds: { ...r.brakeSetIds }
    });
    return r;
  }

  function broadcast() {
    refreshAutoStops();
    const msg = JSON.stringify({ type: 'state', state });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
    save();
  }

  // Which cars have a station attached right now. Stations tag their socket
  // via 'hello'; the wall uses this map (against each car's lasting
  // liveSeenMs stamp) to tell "car entry never used" from "laptop dropped".
  function stationsOnline() {
    const online = {};
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.stationCarId) online[client.stationCarId] = true;
    }
    return online;
  }

  function broadcastStations() {
    const msg = JSON.stringify({ type: 'stations', online: stationsOnline() });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'state', state }));
    ws.send(JSON.stringify({ type: 'timing', timing: timing.snapshot() }));
    ws.send(JSON.stringify({ type: 'stations', online: stationsOnline() }));
    ws.on('close', () => {
      if (ws.stationCarId) broadcastStations();
    });
    ws.on('message', raw => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        handle(m, ws);
      } catch (e) {
        console.error('[server] bad message:', e.message);
      }
      broadcast();
    });
  });

  function handle(m, ws) {
    const car = m.carId ? state.cars[m.carId] : null;
    switch (m.type) {
      // A station introduces itself with its car on every (re)connect. The
      // socket is tagged for the live map and the car keeps a lasting "was
      // live this race" stamp that only a race reset clears.
      case 'hello':
        if (m.role === 'station' && car) {
          ws.stationCarId = car.id;
          car.state.liveSeenMs = Date.now();
          broadcastStations();
        }
        break;

      case 'update':
        if (car && m.patch) {
          // A manual fuel figure is a *real reading* — close the span since
          // the previous trusted reading into a consumption sample first.
          const fuelReading = typeof m.patch.state?.fuelLiters === 'number';
          // A track-condition flip makes the running fuel span unrepresentative.
          if (typeof m.patch.condition === 'string' && m.patch.condition !== car.condition) {
            dirtyFuelRef(car);
          }
          deepMerge(car, m.patch);
          if (fuelReading) learnFuelReading(car, car.state.fuelLiters, Date.now());
          // A stray patch can never fork a car away from the event settings.
          if (m.patch.config) syncEventConfig(state);
          // Before the race is under way the tank simply follows the start-fuel
          // setting, so editing it shows on the gauge straight away. Once the
          // clock runs the on-board figure is a live quantity and is left alone
          // (joining a running session, the level comes from the join seeding
          // and is corrected with the station's SET reading, not by a setting).
          const startFuelEdit =
            m.patch.config &&
            (m.patch.config.startFuelL != null || m.patch.config.tankLiters != null);
          if (startFuelEdit && !fuelReading && !state.race.startMs) {
            car.state.fuelLiters = startFuelOf(car);
            car.state.stintFuelStartL = car.state.fuelLiters;
          }
          // Keep the named set list and the legacy count coherent whichever
          // one the client edited.
          if (m.patch.config?.tyreSets != null || m.patch.tyreSets) reconcileTyreSets(car);
          if (m.patch.config?.brakeSets || m.patch.brakeSets) reconcileBrakeSets(car);
          // Sending a stop to the crew (or calling the car in) commits it: the
          // app's live answers stop moving and become the work order. Only a
          // stop with nothing filled in yet is written from the plan — one that
          // already carries service figures is the engineer's, whether it came
          // from the new panel's pins or straight from a patch, and is sent
          // exactly as it stands.
          if (m.patch.nextStop?.status && m.patch.nextStop.status !== 'draft' &&
              stopIsBlank(car.nextStop)) {
            materialiseStop(car);
          }
        }
        break;

      // Event settings (pit wall only): shared by all cars.
      case 'event':
        if (m.patch) {
          deepMerge(state.event, m.patch);
          syncEventConfig(state);
        }
        break;

      case 'race':
        if (m.patch) {
          deepMerge(state.race, m.patch);
          // A (re)scheduled start realigns the first stint of every car that
          // has not turned a lap yet.
          if ('startMs' in m.patch) {
            for (const c of Object.values(state.cars)) {
              if (c.state.totalLaps === 0 && c.stintHistory.length === 0) {
                seedFirstStint(c, state.race.startMs);
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
              seedFirstStint(c, now);
            }
          }
        }
        break;
      }

      case 'resetRace':
        resetRaceData();
        // A hand reset makes whatever the feed is showing this race's session.
        bindSession(sessionKeyOf(timing.snapshot()));
        break;

      // ---- the pit wall answers "which session is this race?" ---------------
      // NEW: the feed moved on and so do we — the data on screen was the
      // previous session's. KEEP: what is on screen is the real race, so bind
      // the feed's session to it and let laps, clock and flags flow again.
      // Only while the question is actually open: this one throws a race away.
      case 'sessionNew':
        if (state.timing.sessionAlert) startFreshForSession(state.timing.sessionAlert.to);
        break;

      case 'sessionKeep':
        bindSession(state.timing.sessionAlert?.to || state.timing.sessionKey);
        break;

      // Manual override of the race condition, sent by the wall or ANY
      // station — whoever calls it, everyone gets it: 'auto' follows the
      // feed, a condition id ('fcy' | 'sc' | 'code60' | 'red') forces that
      // condition race-wide, 'green' holds green against the feed. `active`
      // is still accepted so an older client keeps working (true → force
      // FCY, false → force green).
      case 'fcy': {
        const mode = FCY_MODES.includes(m.mode)
          ? m.mode
          : (m.active ? 'fcy' : 'green');
        state.race.fcy.mode = mode;
        // Remember the flag the override was taken against, so the release
        // rule above fires on the next genuine flag change and not before.
        // Read it from the live snapshot rather than the last persisted value:
        // the override may be set before the 1 s tick has recorded the flag,
        // and stamping a stale null would make that first tick release it.
        const snapNow = timing.snapshot();
        state.race.fcy.overrideFlag = mode === 'auto'
          ? null
          : (snapNow.conn === 'connected' ? (snapNow.session?.flag ?? null) : state.race.fcy.flag);
        syncConditionFromFeed();
        break;
      }

      case 'settings':
        if (m.patch) deepMerge(state.settings, m.patch);
        break;

      // Setup presets live inside the shared state, so every station sees the
      // same list and they survive with the normal state file.
      case 'savePreset':
        if (car && m.name) {
          state.presets[m.name] = {
            savedMs: Date.now(),
            make: car.make,
            model: car.model,
            config: JSON.parse(JSON.stringify(car.config)),
            drivers: car.drivers.map(d => ({ ...d, totalMs: 0 }))
          };
        }
        break;

      case 'loadPreset': {
        const p = state.presets[m.name];
        if (car && p) {
          car.make = p.make;
          car.model = p.model;
          car.config = JSON.parse(JSON.stringify(p.config));
          syncEventConfig(state); // presets never override event settings
          // Keep accrued seat time and the driver currently in the car.
          if (Array.isArray(p.drivers) && p.drivers.length) {
            car.drivers = p.drivers.map((d, i) => ({
              ...d,
              fuelCurve: Array.isArray(d.fuelCurve) ? d.fuelCurve : [],
              totalMs: car.drivers[i] ? car.drivers[i].totalMs : 0
            }));
            if (!car.drivers.some(d => d.id === car.currentDriverId)) {
              car.currentDriverId = car.drivers[0].id;
            }
          }
        }
        break;
      }

      case 'deletePreset':
        delete state.presets[m.name];
        break;

      // Race setups (pit wall): race name + duration + event settings, saved
      // under a name so the real event can be prepared during a test session
      // and loaded back when it counts. The start time is deliberately not
      // stored — loading a setup must never move a running clock.
      case 'saveRaceSetup':
        if (m.name) {
          state.raceSetups[m.name] = {
            savedMs: Date.now(),
            race: { name: state.race.name, durationH: state.race.durationH },
            event: JSON.parse(JSON.stringify(state.event))
          };
        }
        break;

      case 'loadRaceSetup': {
        const p = state.raceSetups[m.name];
        if (p) {
          state.race.name = p.race?.name ?? state.race.name;
          if (p.race?.durationH > 0) state.race.durationH = p.race.durationH;
          state.event = { ...defaultEvent(), ...(p.event || {}) };
          syncEventConfig(state);
        }
        break;
      }

      case 'deleteRaceSetup':
        delete state.raceSetups[m.name];
        break;

      // Named stint plans (per car): keep e.g. the 24h race plan safe while a
      // short practice session runs, and pull it back up when it matters.
      case 'savePlan':
        if (car && m.name && car.plan) {
          car.savedPlans[m.name] = {
            savedMs: Date.now(),
            plan: JSON.parse(JSON.stringify(car.plan))
          };
        }
        break;

      case 'loadPlan': {
        const p = car?.savedPlans?.[m.name];
        if (p) car.plan = JSON.parse(JSON.stringify(p.plan));
        break;
      }

      case 'deletePlan':
        if (car) delete car.savedPlans[m.name];
        break;

      // Laps drive tyre wear and counters only — fuel burns by time (see the
      // tick loop below), so a logged lap must not subtract fuel again.
      case 'lap':
        if (car) recordLap(car, m.lapSec);
        break;

      case 'undoLap':
        if (car && car.state.totalLaps > 0) {
          car.state.totalLaps--;
          car.state.lapsThisStint = Math.max(0, car.state.lapsThisStint - 1);
          car.state.tyreLapsOnSet = Math.max(0, car.state.tyreLapsOnSet - 1);
          bankTyreKm(car, -1);
          car.state.stintLapSec.pop();
        }
        break;

      // A set that came off is kept (back in the pool) or scrapped (out of the
      // pool for good, with the reason recorded). Answers the pending question
      // raised by applyStop, and doubles as the scrap/restore control in the
      // tyre set list — a binned set can always be brought back.
      case 'tyreSetDecision': {
        if (!car) break;
        const set = (car.tyreSets || []).find(t => t.id === m.setId);
        if (!set) break;
        // The rubber on the car cannot be binned — it has to come off first.
        if (m.scrapped && set.id === car.state.currentTyreSetId) break;
        set.scrapped = !!m.scrapped;
        set.scrapReason = set.scrapped ? (String(m.reason || '').slice(0, 40) || 'scrapped') : null;
        if (car.state.pendingSetDecision?.setId === set.id) car.state.pendingSetDecision = null;
        // Never leave a scrapped set as the plan's chosen rubber.
        if (set.scrapped && car.nextStop.tyreSetId === set.id) car.nextStop.tyreSetId = null;
        break;
      }

      // Same control for a numbered brake set: out of the rack for good (with
      // the reason recorded) or back in it. A binned set can always be
      // restored — nothing is thrown away silently.
      case 'brakeSetDecision': {
        if (!car || !BRAKE_COMPONENTS.some(b => b.id === m.comp)) break;
        const set = brakeSetsOf(car, m.comp).find(t => t.id === m.setId);
        if (!set) break;
        // The part on the car cannot be binned — it has to come off first.
        if (m.scrapped && set.id === car.state.currentBrakeSetId?.[m.comp]) break;
        set.scrapped = !!m.scrapped;
        set.scrapReason = set.scrapped ? (String(m.reason || '').slice(0, 40) || 'scrapped') : null;
        // Never leave a scrapped set as the plan's chosen part.
        if (set.scrapped) {
          if (car.nextStop.brakeSetIds?.[m.comp] === set.id) car.nextStop.brakeSetIds[m.comp] = null;
          if (car.nextStop.pinned?.brakeSets?.[m.comp] === set.id) delete car.nextStop.pinned.brakeSets[m.comp];
        }
        break;
      }

      // Car entered / left the pit lane. Fuel does not burn while in the pit;
      // toggling off without applyStop covers a drive-through (no service).
      case 'inPit':
        if (car) {
          car.state.inPit = !!m.inPit;
          car.state.pitEnterMs = m.inPit ? Date.now() : null;
          dirtyFuelRef(car);
        }
        break;

      case 'applyStop':
        if (car) {
          // Applying by hand goes through the same review — the engineer still
          // says afterwards whether it went to plan.
          // A recent visit lends its measured times — including one the app
          // read as a drive-through and the engineer has just overruled — but
          // this is a service stop now, whatever that visit was called.
          const prev = car.state.lastPitVisit;
          const visit = prev && Date.now() - prev.atMs < 5 * 60e3 ? { ...prev, kind: 'service' } : { kind: 'service' };
          const review = openStopReview(car, visit);
          applyStop(car, visit.pitSec ? visit : null);
          car.state.lastPitVisit = { ...review, byHand: true };
        }
        break;

      // "It went to plan." The stop is signed off: the stint sheet records who
      // said so and when, and the banner clears. Nothing about the numbers
      // changes — this is the engineer taking responsibility for them.
      case 'confirmStop': {
        if (!car) break;
        const h = car.stintHistory[car.stintHistory.length - 1];
        if (h) h.confirmed = { by: String(m.by || '').slice(0, 24) || 'engineer', atMs: Date.now() };
        undoBuffer.delete(car.id);
        car.state.lastPitVisit = null;
        break;
      }

      // "It did not go to plan" — opens the correction, changing nothing yet.
      case 'disputeStop':
        if (car?.state.lastPitVisit?.applied) car.state.lastPitVisit.disputed = true;
        break;

      case 'undisputeStop':
        if (car?.state.lastPitVisit) car.state.lastPitVisit.disputed = false;
        break;

      // What actually happened at the stop. Every figure is moved to match and
      // the stint sheet is rewritten, so the record is the truth rather than
      // the plan.
      case 'correctStop':
        if (car && m.service) correctStop(car, { ...m.service, by: m.by });
        break;

      // Take back a stop that should not have been applied at all — it
      // restores fuel, tyres, driver, seat time, wear and the stint sheet in
      // one move. Open for as long as the stop is unanswered.
      case 'undoStop': {
        if (!car) break;
        const snap = undoBuffer.get(car.id);
        if (!snap) break;
        Object.assign(car, JSON.parse(JSON.stringify(snap.car)));
        undoBuffer.delete(car.id);
        car.state.lastPitVisit = null;
        break;
      }

      // "That was a stop after all" — the correction offered when the app
      // deliberately did nothing (drive-through length, or nothing planned).
      case 'dismissPitVisit':
        if (car) car.state.lastPitVisit = null;
        break;

      // ---- the stop plan: which situation, which lines are pinned, and the
      // engineer's approval ----

      // Switch the plan being worked on (green / fcy / sc). The other two keep
      // being computed — this only says which one the stop follows.
      case 'stopPlan':
        if (car && ['green', 'fcy', 'sc'].includes(m.plan)) car.nextStop.plan = m.plan;
        break;

      // Pin one line to a value, or hand it back to the app with value null.
      // Pinning never freezes the other lines: they keep tracking the race.
      case 'pinStop': {
        if (!car || !['fuel', 'tyres', 'driver', 'brakes', 'brakeSets'].includes(m.field)) break;
        car.nextStop.pinned ??= {};
        if (m.value == null) delete car.nextStop.pinned[m.field];
        else car.nextStop.pinned[m.field] = m.value;
        // The plan the crew was shown has changed under them.
        if (car.nextStop.approved) car.nextStop.approved.stale = true;
        break;
      }

      // "I have read this and it is the plan." Freezes the numbers into the
      // stop so the wall and the crew are looking at something concrete.
      case 'approveStop': {
        if (!car) break;
        const r = materialiseStop(car);
        car.nextStop.approved = {
          by: String(m.by || '').slice(0, 24) || 'engineer',
          atMs: Date.now(),
          hash: stopPlanHash(r),
          stale: false
        };
        break;
      }

      case 'unapproveStop':
        if (car) car.nextStop.approved = null;
        break;

      // ---- live timing control (any screen may drive it; the connection
      // itself always runs here on the pit wall PC) ----
      case 'timingConnect':
        if (m.cfg) deepMerge(state.timing, m.cfg);
        state.timing.wanted = true;
        timing.connect(state.timing).then(() => broadcastTiming(true));
        if (state.timing.watchUrl) timing.flagWatchConnect(state.timing.watchUrl);
        else timing.flagWatchDisconnect();
        break;

      case 'timingDisconnect':
        state.timing.wanted = false;
        // Nothing is driving the race any more, so the open session question
        // is moot — it comes back if the feed does, still on another session.
        state.timing.sessionAlert = null;
        timing.disconnect();
        timing.flagWatchDisconnect();
        broadcastTiming(true);
        break;

      case 'timingLink':
        if (m.carId != null) state.timing.links[m.carId] = String(m.nr ?? '').trim();
        break;

      case 'timingAutoLap':
        if (m.carId != null) state.timing.autoLap[m.carId] = !!m.on;
        break;

      // Al Kamel feeds can carry several sessions — pick one explicitly.
      case 'timingSession':
        if (m.sessionId) timing.selectSession(String(m.sessionId));
        break;

      // Align the race clock with the session clock of the timing feed. Done
      // here (not on the client) so the freshest feed sample wins and client
      // clock skew cannot creep in.
      case 'timingSyncClock':
        syncRaceClockFromFeed(0);
        break;

      // Keep the race clock permanently locked to the feed's session clock
      // (the follow tick above); turning it on aligns immediately.
      case 'timingFollowClock':
        state.timing.followClock = !!m.on;
        if (m.on) syncRaceClockFromFeed(0);
        break;

      // ---- session replays (recorded automatically, one file per session) --
      case 'timingReplayList':
        ws?.send(JSON.stringify({ type: 'timingReplays', list: timing.listReplays() }));
        break;

      case 'timingReplayOpen': {
        // A replay takes over the timing channel; make sure a reboot doesn't
        // silently resurrect the live feed underneath the simulation. A replay
        // never owns the race data, so any open session question goes with it.
        state.timing.wanted = false;
        state.timing.sessionAlert = null;
        timing.flagWatchDisconnect();
        const r = timing.replayOpen(String(m.file || ''));
        if (!r.ok) console.log('[timing] replay open failed:', r.error);
        ws?.send(JSON.stringify({ type: 'timingReplayResult', ...r }));
        broadcastTiming(true);
        break;
      }

      case 'timingReplayCtl':
        timing.replayControl({ op: String(m.op || ''), value: m.value });
        broadcastTiming(true);
        break;
    }
  }

  // Called when the stop is complete — by the timing feed's pit-exit event, or
  // by hand from a screen: folds the finished stint into history/wear totals,
  // then applies the planned service. `visit` carries the measured pit-lane
  // time when the feed drove it, so the sheet records what the stop really
  // cost rather than what it was estimated to.
  function applyStop(car, visit = null) {
    const now = Date.now();
    const s = car.state;
    const stop = car.nextStop;
    const stintMs = s.stintStartMs ? Math.max(0, now - s.stintStartMs) : 0;

    for (const k of Object.keys(s.brakeUsedH)) {
      s.brakeUsedH[k] = +(s.brakeUsedH[k] + stintMs / 3600e3).toFixed(4);
    }
    const drv = car.drivers.find(d => d.id === car.currentDriverId);
    if (drv) drv.totalMs += stintMs;

    // Stint sheet: lap statistics and (model-tracked) fuel over the stint.
    const stats = stintStats(s.stintLapSec);
    const fuelAtEntry = s.fuelLiters;
    car.stintHistory.push({
      startMs: s.stintStartMs,
      endMs: now,
      driverId: car.currentDriverId,
      laps: s.lapsThisStint,
      bestSec: stats.bestSec,
      avgSec: stats.avgSec,
      lapTimes: s.stintLapSec.slice(-300),
      fuelStartL: s.stintFuelStartL,
      fuelUsedL: s.stintFuelStartL != null
        ? +Math.max(0, s.stintFuelStartL - fuelAtEntry).toFixed(1)
        : null,
      tyreSetId: s.currentTyreSetId ?? null,
      brakeSetIds: { ...(s.currentBrakeSetId || {}) }, // the parts that ran this stint
      service: { ...stop },
      // What the stop actually took, when the feed timed it.
      pitSec: visit?.pitSec ?? null,
      stationarySec: visit?.stationarySec ?? null,
      estStationarySec: +stopServiceTime(car, stop).totalSec.toFixed(1)
    });

    // The stop's fuel figure is the level on board at release — reset the
    // (time-drained, possibly drifted) tank to it. 0 = no refuelling.
    const refuelTo = Number(stop.fuelLiters) || 0;
    if (refuelTo > 0) s.fuelLiters = Math.min(car.config.tankLiters, +refuelTo.toFixed(2));
    if (stop.tyres) {
      const sets = reconcileTyreSets(car);
      const cur = sets.find(t => t.id === s.currentTyreSetId);
      if (cur) {
        cur.laps = s.tyreLapsOnSet;
        cur.used = true;
        // The set is off the car: ask the engineer whether it goes back on the
        // rack or in the bin, with the mileage it has just banked. Until that
        // is answered the set stays in the pool — nothing is decided silently.
        const mil = tyreSetMileage(cur);
        s.pendingSetDecision = {
          setId: cur.id, atMs: now, laps: cur.laps, km: mil.km, kmFcy: mil.kmFcy
        };
      }
      // The chosen set, else the next unused one; with nothing fresh left, the
      // least-worn used set not already on the car. Scrapped sets are out of
      // the pool at every step.
      let next = stopTyreSet(car, stop) ||
        sets.filter(t => t.id !== s.currentTyreSetId && !t.scrapped).sort((a, b) => a.laps - b.laps)[0] ||
        cur;
      if (next) {
        next.used = true;
        s.currentTyreSetId = next.id;
        // A refitted used set starts pre-worn, so the wear meter keeps
        // reading total laps on the rubber.
        s.tyreLapsOnSet = next.laps || 0;
      } else {
        s.tyreLapsOnSet = 0;
      }
      s.tyreSetsUsed = sets.filter(t => t.used).length;
    }
    if (stop.driverChange) car.currentDriverId = stop.driverChange;
    // Brakes, component group by component group: the part that comes off banks
    // the hours it has run, the numbered set that goes on becomes the live one,
    // and a used set going back on starts pre-worn so the meter keeps reading
    // total hours on that part.
    reconcileBrakeSets(car);
    for (const b of BRAKE_COMPONENTS) {
      if (!stop[b.id]) continue;
      const sets = brakeSetsOf(car, b.id);
      const cur = sets.find(t => t.id === s.currentBrakeSetId[b.id]);
      if (cur) {
        cur.hours = +Math.max(0, s.brakeUsedH[b.id] || 0).toFixed(4);
        cur.used = true;
      }
      // The chosen set, else the next unused one; with nothing fresh left, the
      // least-worn used set not already on the car. Scrapped sets are out of
      // the pool at every step.
      const next = stopBrakeSet(car, b.id, stop) ||
        sets.filter(t => t.id !== s.currentBrakeSetId[b.id] && !t.scrapped)
          .sort((x, y) => x.hours - y.hours)[0] ||
        cur;
      if (next) {
        next.used = true;
        s.currentBrakeSetId[b.id] = next.id;
        s.brakeUsedH[b.id] = +Math.max(0, next.hours || 0).toFixed(4);
      } else {
        s.brakeUsedH[b.id] = 0;
      }
    }

    s.lapsThisStint = 0;
    s.stintStartMs = now;
    s.stintLapSec = [];
    s.inPit = false;
    s.pitEnterMs = null;
    car.nextStop = emptyStop();

    // The new stint's starting fuel; a refuel to a planned level is a trusted
    // reading, so it re-anchors the consumption learning (a no-refuel stop
    // leaves the running span alone unless the driver changed).
    s.stintFuelStartL = s.fuelLiters;
    if (refuelTo > 0) {
      car.learn ??= { byDriver: {}, fuelRef: null };
      car.learn.fuelRef = {
        ms: now,
        liters: s.fuelLiters,
        laps: s.totalLaps,
        driverId: car.currentDriverId,
        cond: car.condition === 'wet' ? 'wet' : car.condition === 'dry' ? 'dry' : null,
        dirty: false
      };
    } else if (stop.driverChange) {
      dirtyFuelRef(car);
    }
  }

  // Continuous fuel burn: while the race clock runs, each car's tank drains
  // at its effective burn rate divided by its lap time — except while the car
  // sits in the pit lane. Corrections come in via the station's SET button;
  // refuelling via applyStop.
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const running = state.race.startMs && now >= state.race.startMs;
    if (running && now > lastTick) {
      const dt = now - lastTick;
      // One resolved condition for the whole field — an FCY detected on the
      // feed drains every car at its SC/FCY rate, not just the ones a station
      // happens to be watching.
      const pace = raceCondition(state.race).pace;
      for (const car of Object.values(state.cars)) {
        // Any neutralisation poisons the running consumption-learning span.
        if (pace) dirtyFuelRef(car);
        if (car.state.inPit) continue;
        // Same reference lap as carCalcs: the smoothed live average when the
        // feed is running, so the tank drains at the rate the lap-time fuel
        // curve is actually predicting.
        const refLap = car.state.avgLapSecLive > 0 ? car.state.avgLapSecLive
          : (car.state.lastLapSec > 0 ? car.state.lastLapSec : car.config.avgLapSec[car.condition]);
        const burn = effectiveBurn(car, car.condition, pace, refLap);
        const lapSec = (paceLapSec(car, pace)
          ?? (car.config.fuelModel === 'driver-laptime' && refLap > 0
            ? refLap : car.config.avgLapSec[car.condition])) || 100;
        const litersPerMs = burn / (lapSec * 1000);
        car.state.fuelLiters = Math.max(0, +(car.state.fuelLiters - litersPerMs * dt).toFixed(3));
      }
      broadcast();
    }
    lastTick = now;
  }, tickMs);

  // ---- interval backups (crash recovery) ----
  // Every backupIntervalMin minutes a timestamped snapshot of the full state
  // is written next to the live state file; the newest 100 are kept.
  let lastBackupMs = Date.now();
  function writeBackup() {
    if (!backupDir) return null;
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const file = path.join(backupDir, `pitwall-backup-${stamp}.json`);
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
      const old = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('pitwall-backup-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(100);
      for (const f of old) fs.unlinkSync(path.join(backupDir, f));
      return file;
    } catch (e) {
      console.error('[server] backup failed:', e.message);
      return null;
    }
  }
  setInterval(() => {
    const min = Number(state.settings?.backupIntervalMin);
    if (!backupDir || !min || min <= 0) return;
    if (Date.now() - lastBackupMs < min * 60e3) return;
    lastBackupMs = Date.now();
    writeBackup();
  }, 30e3);

  function listBackups() {
    if (!backupDir || !fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter(f => f.startsWith('pitwall-backup-') && f.endsWith('.json'))
      .map(f => {
        const st = fs.statSync(path.join(backupDir, f));
        return { name: f, ms: st.mtimeMs, bytes: st.size };
      })
      .sort((a, b) => b.ms - a.ms);
  }

  function restoreBackup(name) {
    // Name comes from our own list; still refuse anything path-like.
    if (!backupDir || !/^pitwall-backup-[\d-]+\.json$/.test(name)) {
      return { ok: false, error: 'invalid backup name' };
    }
    try {
      const restored = JSON.parse(fs.readFileSync(path.join(backupDir, name), 'utf8'));
      migrate(restored);
      state = restored;
      broadcast();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  return { port, ips, listBackups, restoreBackup, writeBackup, timing };
}
