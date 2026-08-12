// Shared domain model + strategy math.
// This module runs both in the server (Node, on the pit wall PC) and in the
// renderer UIs, so it must stay dependency-free.

export const PORT = 8484;

// Track condition: what the surface is doing, per car. Deliberately DRY/WET
// only — a neutralisation is not a track state, it is a race condition, and it
// is called on the manual FCY / SC / RED controls (or read from the feed) so
// it applies to the whole field at once. Two ways to say "SC" would let one
// station sit on a stale car-level SC after the race went green again.
export const CONDITIONS = [
  { id: 'dry', label: 'DRY' },
  { id: 'wet', label: 'WET' }
];

// The four things that get changed as a unit. Front discs come off as a pair
// and carry one number between them, and so do the rear discs, the front pads
// and the rear pads — which is why each of these is one line on the stop card
// and one numbered pool in the rack, never four corners.
export const BRAKE_COMPONENTS = [
  { id: 'padsFront', label: 'PADS FRONT', short: 'PADS F', prefix: 'PF' },
  { id: 'padsRear', label: 'PADS REAR', short: 'PADS R', prefix: 'PR' },
  { id: 'discsFront', label: 'DISCS FRONT', short: 'DISCS F', prefix: 'DF' },
  { id: 'discsRear', label: 'DISCS REAR', short: 'DISCS R', prefix: 'DR' }
];

export const DRIVER_COLORS = ['#4cc2ff', '#ffb454', '#7ee787', '#ff7eb6'];

// Live timing flag enum (getraceresults heat field `f`; other providers are
// mapped onto it by the server-side timing engine).
export const TIMING_FLAGS = {
  '-1': { label: 'NOT STARTED', cls: 'none' },
  0: { label: 'NOT STARTED', cls: 'none' },
  1: { label: 'READY', cls: 'none' },
  2: { label: 'RED FLAG', cls: 'red' },
  3: { label: 'SAFETY CAR', cls: 'sc' },
  4: { label: 'CODE 60', cls: 'code60' },
  5: { label: 'FINISH', cls: 'finish' },
  6: { label: 'GREEN', cls: 'green' },
  7: { label: 'FCY', cls: 'fcy' }
};

// ---------------------------------------------------------------------------
// Race condition
// ---------------------------------------------------------------------------
// The race is always in exactly one condition. It is derived from the timing
// feed's flag, with a manual override on top, and it is the single thing that
// drives fuel burn, lap-time projections and the alert styling in every view.
//
// `pace` selects which of the car's rate pairs applies:
//   null → normal (driver / curve / car rate for the track condition)
//   'sc' → the car's Safety Car rates (rolling queue, higher pace than Code 60)
//   'fcy' → the car's FCY / Code 60 rates (fixed delta speed)
//   'stopped' → the field is not running, so nothing is being consumed
//
// `alert: true` is what makes a top bar flash. It is deliberately limited to
// the conditions where a pit decision changes *right now* — flashing everything
// would make the flash mean nothing.
export const RACE_CONDITIONS = {
  green: { id: 'green', label: 'GREEN', cls: 'green', pace: null, alert: false, rank: 0 },
  finish: { id: 'finish', label: 'CHEQUERED FLAG', cls: 'finish', pace: 'stopped', alert: false, rank: 1 },
  sc: { id: 'sc', label: 'SAFETY CAR', cls: 'sc', pace: 'sc', alert: true, rank: 2 },
  fcy: { id: 'fcy', label: 'FULL COURSE YELLOW', cls: 'fcy', pace: 'fcy', alert: true, rank: 3 },
  code60: { id: 'code60', label: 'CODE 60', cls: 'code60', pace: 'fcy', alert: true, rank: 3 },
  red: { id: 'red', label: 'RED FLAG', cls: 'red', pace: 'stopped', alert: false, rank: 4 }
};

// Timing flag enum → race condition id. Flags with no entry (not started,
// ready) leave the condition alone: they carry no pace information.
export const FLAG_TO_CONDITION = {
  2: 'red',
  3: 'sc',
  4: 'code60',
  5: 'finish',
  6: 'green',
  7: 'fcy'
};

// Manual override modes for the race-condition controls. 'auto' follows the
// feed; a condition id forces that condition for the whole field — any station
// or the wall can call it, so a spotter who sees the boards before the feed
// reacts can neutralise everyone. 'green' holds green against a flag the feed
// still reports. Every force wins over the feed until the feed's flag next
// changes (see server.js), so a stale override cannot silently persist.
export const FCY_MODES = ['auto', 'fcy', 'sc', 'code60', 'red', 'green'];

// Resolve the current race condition from feed flag + manual override.
// `race.fcy` holds { mode, active, startMs, source, flag }; `flag` is the raw
// timing flag the server last saw. Returns the condition plus where it came
// from, so the UI can always say *why* it is showing what it shows.
export function raceCondition(race, timingFlag = null) {
  const fcy = (race && race.fcy) || {};
  const mode = FCY_MODES.includes(fcy.mode) ? fcy.mode : 'auto';
  const flag = timingFlag ?? fcy.flag ?? null;
  const fromFeed = flag != null ? FLAG_TO_CONDITION[flag] : undefined;

  if (mode !== 'auto' && mode !== 'green') {
    // A forced condition (FCY / SC / Code 60 / red) beats whatever the feed
    // reports — the override exists to correct a wrong or late flag.
    return { ...RACE_CONDITIONS[mode], source: 'manual', overridden: true, feedId: fromFeed || null };
  }
  if (mode === 'green') {
    // Forcing green must not hide a red flag — the field is genuinely stopped
    // and no fuel is being burned regardless of what the pit wall thinks.
    if (fromFeed === 'red') {
      return { ...RACE_CONDITIONS.red, source: 'feed', overridden: false, feedId: fromFeed };
    }
    return { ...RACE_CONDITIONS.green, source: 'manual', overridden: true, feedId: fromFeed || null };
  }
  if (fromFeed) {
    return { ...RACE_CONDITIONS[fromFeed], source: 'feed', overridden: false, feedId: fromFeed };
  }
  // No usable feed flag. A state written by an older build has no `mode` at
  // all, so its `active` boolean is the only thing describing the race — honour
  // it. Once `mode` exists it is authoritative: in AUTO with no feed the race
  // is green, otherwise ending an FCY with the feed down could never take
  // effect and the neutralisation would latch for the rest of the race.
  if (fcy.mode === undefined && fcy.active) {
    return { ...RACE_CONDITIONS.fcy, source: 'manual', overridden: false, feedId: null };
  }
  return { ...RACE_CONDITIONS.green, source: 'none', overridden: false, feedId: null };
}

// Event-level settings: values that are by nature the same for every car in
// the race (track properties and event regulations). They are edited on the
// pit wall only; the server mirrors them into every car's config so all
// strategy math keeps reading car.config.
export const EVENT_FIELDS = [
  'trackKm', 'fcySpeedKmh', 'scSpeedKmh', 'pitSpeedKmh', 'pitLaneKm', 'pitLossSec',
  'driveThroughSec', 'refuelLps', 'maxStintMin',
  's1EndKm', 's2EndKm', 's3EndKm', 'pitInKm',
  'reg6hMin', 'regTotalMin', 'regRestMin'
];

export function defaultEvent() {
  return {
    trackKm: 4.0,
    fcySpeedKmh: 80,
    scSpeedKmh: 0, // Safety-Car train speed; 0 = derive from the car's SC lap time
    pitSpeedKmh: 60,
    pitLaneKm: 0.4,
    pitLossSec: 55,
    // Measured time to drive the pit lane without stopping. Timed at the track
    // it beats the figure derived from lane length and speed limit, and it is
    // what tells a drive-through from a stop. 0 = derive it.
    driveThroughSec: 0,
    refuelLps: 2.5,
    maxStintMin: 65,
    // Track geometry for the pit-arrival estimate, measured from the S/F line
    // (km). Sector ends place a car by its last completed sector; the pit
    // entry point is where the E.T.A. counts to. 0 = not set (feed geometry
    // or the S/F line is used instead).
    s1EndKm: 0,
    s2EndKm: 0,
    s3EndKm: 0,
    pitInKm: 0,
    // Driver drive-time regulations (series rulebook). 0 = rule not enforced.
    reg6hMin: 0, // max minutes behind the wheel in any rolling 6 h window
    regTotalMin: 0, // max minutes behind the wheel over the whole race
    regRestMin: 0 // minimum rest between two stints
  };
}

// Live timing settings live in the shared state so every screen sees the same
// feed config, car links and auto-lap switches. The pit wall PC makes the one
// upstream connection; stations only display the rebroadcast snapshot.
export function defaultTiming() {
  return {
    mode: 'url', // 'url' (getraceresults / Al Kamel page) or 'teamstream' (direct TCP/SSL)
    url: '',
    host: '',
    port: null, // null = default port for the transport (12921 plain / 12922 SSL)
    ssl: true,
    allowSelfSigned: false,
    key: '',
    followClock: false, // keep race elapsed/remaining locked to the feed's session clock
    links: {}, // carId → timing car number ('' = use the car's own number)
    autoLap: {}, // carId → true: feed laps from timing into the strategy state
    // Which feed session the race data on screen belongs to, and the pending
    // question when the feed is showing a different one (see the session
    // guard in server.js). null/null = nothing bound, nothing asked.
    sessionKey: null,
    sessionAlert: null // { from, to, ms, laps } while the pit wall has not answered
  };
}

// The timing number a car listens to: explicit link, else its race number.
export function timingNrOf(timing, car) {
  const linked = timing?.links?.[car.id];
  const nr = linked != null && String(linked).trim() !== '' ? linked : car.number;
  return String(nr).trim();
}

// Which timing numbers the feed has posted in the current session. Boards
// rebuild on session changes, and a row can wait for the car's first
// crossing — so a number that has not appeared *yet* is normal early in a
// session (calm "waiting"), while one the board knew and dropped points at
// a real problem. The session key follows the snapshot, so a session change
// forgets the previous field.
export function createFeedSeen() {
  let seen = new Set();
  let key = '';
  return {
    update(t) {
      if (!t || (t.conn !== 'connected' && t.conn !== 'replay')) return;
      const k = (t.sessions?.selected || '') + '|' + (t.session?.name || '');
      if (k !== key) { key = k; seen = new Set(); }
      for (const e of t.entries || []) seen.add(String(e.nr).trim());
    },
    has: nr => seen.has(String(nr).trim())
  };
}

// Every timing number the team answers to (nr → car). One lookup shared by
// the scoreboard, the around-table and the track map, so a car number filled
// in on any screen lights the same rows and dots up everywhere.
export function ourTimingNrs(state) {
  const map = new Map();
  for (const car of Object.values(state?.cars || {})) {
    const nr = timingNrOf(state.timing || {}, car);
    if (nr) map.set(nr, car);
  }
  return map;
}

export function emptyStop() {
  return {
    fuelLiters: 0,
    tyres: false,
    tyreSetId: null, // which set to fit; null = next unused set
    driverChange: null,
    padsFront: false,
    padsRear: false,
    discsFront: false,
    discsRear: false,
    // Which numbered set each changed component gets; null = next unused.
    brakeSetIds: { padsFront: null, padsRear: null, discsFront: null, discsRear: null },
    notes: '',
    status: 'draft', // draft -> sent -> box -> (applied)
    // Which of the three situations the engineer is planning for, the lines
    // they have pinned (everything else keeps following the app), and the
    // approval that tells the crew a human has read this plan.
    plan: null, // null = follow whatever is flying; 'green' | 'fcy' | 'sc' = pinned by the engineer
    // { fuel: {mode,liters}, tyres: 'keep'|'new'|setId, driver: 'stay'|driverId,
    //   brakes: [ids], brakeSets: { compId: setId } }
    pinned: {},
    approved: null // { by, atMs, hash, stale }
  };
}

// ---------------------------------------------------------------------------
// Tyre set management
// ---------------------------------------------------------------------------
// Each car carries a list of named tyre sets. `laps` is the wear accumulated
// over completed fittings; while a set is on the car its live total is
// state.tyreLapsOnSet (seeded with the set's stored laps when a used set is
// refitted, so the wear meter keeps reading total laps on the rubber).
//
// `km` is the mileage banked on the rubber — added lap by lap while the set is
// on the car (so it is never lost if a stop is logged late), and `kmFcy` is the
// part of it driven under a neutralisation. Yellow kilometres are far gentler
// on a tyre than green ones, so the split is what tells you at the flag whether
// a 280 km set is actually worn out or has spent an hour crawling behind a
// safety car. `scrapped` takes a set out of the pool for good (until restored):
// neither the picker nor the app's own choice may fit it again.

export function defaultTyreSets(count = 12) {
  return Array.from({ length: Math.max(1, count) }, (_, i) => ({
    id: 't' + (i + 1),
    name: 'S' + (i + 1),
    laps: 0,
    km: 0,
    kmFcy: 0,
    used: false,
    scrapped: false,
    scrapReason: null
  }));
}

// Mileage of one set, split by how it was driven. Green km = total − yellow.
export function tyreSetMileage(set) {
  const km = Math.max(0, +(set?.km || 0));
  const kmFcy = Math.min(km, Math.max(0, +(set?.kmFcy || 0)));
  return { km, kmFcy, kmGreen: +(km - kmFcy).toFixed(2) };
}

// Tyre life is set in kilometres (a distance the crew can reason about across
// tracks); laps are derived from the track length. Falls back to the legacy
// per-lap figure while a track length or the km setting is missing.
export function tyreLifeLapsOf(car) {
  const cfg = car.config || {};
  const km = +cfg.tyreLifeKm || 0;
  const trackKm = +cfg.trackKm || 0;
  if (km > 0 && trackKm > 0) return Math.max(1, Math.round(km / trackKm));
  return Math.max(1, +cfg.tyreLifeLaps || 90);
}

// Kilometres a set may still do before it is out of life.
export function tyreKmLeft(car, set = currentTyreSet(car)) {
  const lifeKm = +car.config?.tyreLifeKm || 0;
  if (!(lifeKm > 0)) return null;
  return Math.max(0, +(lifeKm - tyreSetMileage(set).km).toFixed(1));
}

export function currentTyreSet(car) {
  return (car.tyreSets || []).find(t => t.id === car.state.currentTyreSetId) || null;
}

// The set a stop with tyres would fit: the explicitly chosen one, else the
// first never-used set that is not already on the car. Scrapped sets are out
// of the pool — the app must never propose rubber the crew has binned.
export function stopTyreSet(car, stop = car.nextStop) {
  const sets = car.tyreSets || [];
  const chosen = sets.find(t => t.id === stop?.tyreSetId);
  if (chosen && !chosen.scrapped) return chosen;
  return sets.find(t => !t.used && !t.scrapped && t.id !== car.state.currentTyreSetId) || null;
}

// Sets that may still be fitted: everything but the scrapped ones (the set on
// the car stays in the list — it is what the wear meter reads).
export function usableTyreSets(car) {
  return (car.tyreSets || []).filter(t => !t.scrapped);
}

// Keep the tyre set list and the legacy config.tyreSets count coherent:
// growing the count appends fresh sets, shrinking trims unused ones from the
// end (never a used set or the one on the car), and the count is written back
// so both views always agree.
export function reconcileTyreSets(car) {
  if (!Array.isArray(car.tyreSets) || car.tyreSets.length === 0) {
    car.tyreSets = defaultTyreSets(car.config.tyreSets || 12);
  }
  const sets = car.tyreSets;
  // Sets written by an older build (or hand-edited) get the mileage and scrap
  // fields, so every reader can assume they exist.
  for (const t of sets) {
    t.laps = Math.max(0, +t.laps || 0);
    t.km = Math.max(0, +t.km || 0);
    t.kmFcy = Math.min(t.km, Math.max(0, +t.kmFcy || 0));
    t.used = !!t.used || t.laps > 0 || t.km > 0;
    t.scrapped = !!t.scrapped;
    t.scrapReason = t.scrapped ? (t.scrapReason || null) : null;
  }
  const want = Math.max(1, Math.round(car.config.tyreSets) || sets.length);
  let nextNr = sets.length + 1;
  while (sets.length < want) {
    while (sets.some(t => t.id === 't' + nextNr)) nextNr++;
    sets.push({ id: 't' + nextNr, name: 'S' + nextNr, laps: 0, km: 0, kmFcy: 0, used: false, scrapped: false, scrapReason: null });
  }
  for (let i = sets.length - 1; i >= 0 && sets.length > want; i--) {
    if (!sets[i].used && sets[i].id !== car.state.currentTyreSetId) sets.splice(i, 1);
  }
  if (!sets.some(t => t.id === car.state.currentTyreSetId)) {
    // Never land the car on a binned set: prefer a used one still in the pool,
    // then anything unscrapped, and only then whatever is left.
    const cur = sets.find(t => t.used && !t.scrapped) || sets.find(t => !t.scrapped) || sets[0];
    cur.used = true;
    cur.scrapped = false;
    car.state.currentTyreSetId = cur.id;
  }
  car.config.tyreSets = sets.length;
  car.state.tyreSetsUsed = sets.filter(t => t.used).length;
  return car.tyreSets;
}

// ---------------------------------------------------------------------------
// Brake set management
// ---------------------------------------------------------------------------
// Same idea as the tyre sets, one pool per component group: the front discs are
// a numbered pair, the rear discs another, and so are the front and rear pads.
// The crew types the real part number into `name` — that is what is written on
// the rack and what the stop card has to say.
//
// `hours` is the running time banked on a set over its completed fittings.
// While a set is on the car its live total is state.brakeUsedH[comp] (seeded
// from the set's stored hours when a used set goes back on), so the wear meter
// always reads total hours on that part. `scrapped` takes a set out of the pool
// for good until it is restored — neither the picker nor the app may fit it.

export const DEFAULT_BRAKE_SET_COUNT = { padsFront: 4, padsRear: 4, discsFront: 3, discsRear: 3 };

export function brakeComponent(comp) {
  return BRAKE_COMPONENTS.find(b => b.id === comp) || null;
}

export function defaultBrakeSets(comp, count = DEFAULT_BRAKE_SET_COUNT[comp] || 4) {
  const pre = brakeComponent(comp)?.prefix || 'B';
  return Array.from({ length: Math.max(1, count) }, (_, i) => ({
    id: pre.toLowerCase() + (i + 1),
    name: pre + (i + 1),
    hours: 0,
    used: false,
    scrapped: false,
    scrapReason: null
  }));
}

// A full rack: every component's pool, with the set that is on the car at the
// start of the race already marked used.
export function defaultAllBrakeSets(counts = DEFAULT_BRAKE_SET_COUNT) {
  const out = {};
  for (const b of BRAKE_COMPONENTS) {
    out[b.id] = defaultBrakeSets(b.id, counts?.[b.id] ?? DEFAULT_BRAKE_SET_COUNT[b.id]);
    out[b.id][0].used = true;
  }
  return out;
}

export function brakeSetsOf(car, comp) {
  return car?.brakeSets?.[comp] || [];
}

export function currentBrakeSet(car, comp) {
  const id = car?.state?.currentBrakeSetId?.[comp];
  return brakeSetsOf(car, comp).find(t => t.id === id) || null;
}

// Sets that may still be fitted: everything but the scrapped ones (the one on
// the car stays in the list — it is what the wear meter reads).
export function usableBrakeSets(car, comp) {
  return brakeSetsOf(car, comp).filter(t => !t.scrapped);
}

// The set a stop changing this component would fit: the explicitly chosen one,
// else the first never-used set that is not already on the car. Scrapped sets
// are out of the pool — the app must never propose a part the crew has binned.
export function stopBrakeSet(car, comp, stop = car.nextStop) {
  const sets = brakeSetsOf(car, comp);
  const onCar = car?.state?.currentBrakeSetId?.[comp];
  const chosen = sets.find(t => t.id === stop?.brakeSetIds?.[comp]);
  if (chosen && !chosen.scrapped) return chosen;
  return sets.find(t => !t.used && !t.scrapped && t.id !== onCar) || null;
}

// Hours already on a set, reading the live counter for the one on the car.
export function brakeSetHours(car, comp, set) {
  if (!set) return 0;
  return set.id === car?.state?.currentBrakeSetId?.[comp]
    ? Math.max(0, +car.state.brakeUsedH?.[comp] || 0)
    : Math.max(0, +set.hours || 0);
}

// Keep each pool and its configured count coherent: growing the count appends
// fresh sets, shrinking trims unused ones from the end (never a used set or the
// one on the car), and the count is written back so both views always agree.
export function reconcileBrakeSets(car) {
  car.brakeSets ??= {};
  car.config.brakeSets ??= { ...DEFAULT_BRAKE_SET_COUNT };
  car.state.currentBrakeSetId ??= {};
  for (const b of BRAKE_COMPONENTS) {
    if (!Array.isArray(car.brakeSets[b.id]) || car.brakeSets[b.id].length === 0) {
      car.brakeSets[b.id] = defaultBrakeSets(b.id, car.config.brakeSets[b.id]);
    }
    const sets = car.brakeSets[b.id];
    // Sets written by an older build (or hand-edited) get every field, so
    // each reader can assume they exist.
    for (const t of sets) {
      t.hours = Math.max(0, +t.hours || 0);
      t.used = !!t.used || t.hours > 0;
      t.scrapped = !!t.scrapped;
      t.scrapReason = t.scrapped ? (t.scrapReason || null) : null;
    }
    const want = Math.max(1, Math.round(car.config.brakeSets[b.id]) || sets.length);
    let nextNr = sets.length + 1;
    const pre = b.prefix;
    while (sets.length < want) {
      while (sets.some(t => t.id === pre.toLowerCase() + nextNr)) nextNr++;
      sets.push({
        id: pre.toLowerCase() + nextNr, name: pre + nextNr,
        hours: 0, used: false, scrapped: false, scrapReason: null
      });
    }
    for (let i = sets.length - 1; i >= 0 && sets.length > want; i--) {
      if (!sets[i].used && sets[i].id !== car.state.currentBrakeSetId[b.id]) sets.splice(i, 1);
    }
    if (!sets.some(t => t.id === car.state.currentBrakeSetId[b.id])) {
      // Never land the car on a binned part: prefer a used one still in the
      // pool, then anything unscrapped, and only then whatever is left.
      const cur = sets.find(t => t.used && !t.scrapped) || sets.find(t => !t.scrapped) || sets[0];
      cur.used = true;
      cur.scrapped = false;
      car.state.currentBrakeSetId[b.id] = cur.id;
    }
    car.config.brakeSets[b.id] = sets.length;
  }
  return car.brakeSets;
}

export function defaultDriver(n) {
  return {
    id: 'd' + n,
    name: `Driver ${n}`,
    abbrev: '', // short code for compact readouts (VER); '' = derived from the name
    timingName: '', // driver name exactly as the timing feed prints it; '' = match on name
    totalMs: 0,
    doubleStint: true,
    night: true,
    rain: true,
    fuelDry: 0, // L/lap; 0 = use the car's default burn rate
    fuelWet: 0,
    // Lap time → consumption points for the 'driver-laptime' fuel model.
    // Consumption between two measured points is interpolated linearly.
    fuelCurve: []
  };
}

// ---------------------------------------------------------------------------
// Driver recognition from the timing feed
// ---------------------------------------------------------------------------
// The feed's standings carry a driver text for every car. Matching that text
// against the roster is what lets every screen say WHO is in the car — and
// flag it when the feed disagrees with the strategy state.

// Short driver tag for compact readouts: the entered abbreviation, else the
// first three letters of the name's last word (surname, racing convention).
export function driverAbbrev(d) {
  const ab = String(d?.abbrev || '').trim().toUpperCase();
  if (ab) return ab;
  const words = String(d?.name || '').trim().split(/\s+/).filter(Boolean);
  return words.length ? words[words.length - 1].slice(0, 3).toUpperCase() : '';
}

// Fold a name to a comparable form: accents stripped, case and punctuation
// ignored — "Kévin Van der Berg" and "VAN DER BERG, Kevin" both survive this.
export function normTimingName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

// Which roster driver does the feed's driver text refer to? Rules are tried
// in order of trust, and a rule only answers when it matches exactly one
// driver — an ambiguous text (two Janssens, a joined member list) returns
// null rather than a guess:
//   1. the driver's TIMING NAME, exactly as entered
//   2. the timing name as whole words of the feed text (a surname is enough)
//   3. the driver's display name — exact, reordered, or one side's words
//      contained in the other's ("M. VERSTAPPEN" vs "Max Verstappen")
//   4. the abbreviation as a word of its own (feeds that print codes)
export function matchTimingDriver(car, feedName) {
  const fn = normTimingName(feedName);
  if (!fn) return null;
  const drivers = car?.drivers || [];
  const one = list => (list.length === 1 ? list[0] : null);
  const wordIn = (frag, full) => (' ' + full + ' ').includes(' ' + frag + ' ');

  let hit = one(drivers.filter(d => {
    const t = normTimingName(d.timingName);
    return t && t === fn;
  }));
  if (hit) return hit;
  hit = one(drivers.filter(d => {
    const t = normTimingName(d.timingName);
    return t && t.length >= 2 && (wordIn(t, fn) || wordIn(fn, t));
  }));
  if (hit) return hit;
  // Initials ("M.") normalise to single letters — too weak to count as words.
  const tokensOf = s => s.split(' ').filter(w => w.length >= 2);
  const subset = (a, b) => a.length > 0 && a.every(w => b.includes(w));
  const ft = tokensOf(fn);
  hit = one(drivers.filter(d => {
    const n = normTimingName(d.name);
    if (!n) return false;
    if (n === fn) return true;
    const nt = tokensOf(n);
    return subset(ft, nt) || subset(nt, ft);
  }));
  if (hit) return hit;
  return one(drivers.filter(d => {
    const a = normTimingName(d.abbrev);
    return a && a.length >= 2 && (fn === a || fn.split(' ').includes(a));
  }));
}

// A curve point the UI can hand to the table. Both fields are edited by hand.
export function emptyCurvePoint() {
  return { lapSec: 0, fuelL: 0 };
}

// Usable curve points: positive on both axes, sorted by lap time, one point
// per lap time (a later duplicate wins, matching last-edit-wins in the table).
export function normalizeCurve(points) {
  if (!Array.isArray(points)) return [];
  const byLap = new Map();
  for (const p of points) {
    const lapSec = Number(p?.lapSec);
    const fuelL = Number(p?.fuelL);
    if (!(lapSec > 0) || !(fuelL > 0)) continue;
    byLap.set(lapSec, fuelL);
  }
  return [...byLap.entries()]
    .map(([lapSec, fuelL]) => ({ lapSec, fuelL }))
    .sort((a, b) => a.lapSec - b.lapSec);
}

// Consumption at a lap time, linearly interpolated between the bracketing
// measured points. Outside the measured range the nearest point's value is
// held flat rather than extrapolated — a curve fitted to 5 laps of data says
// nothing about a lap 20 s slower, and guessing there would quietly corrupt
// the fuel projection. Returns null when the curve cannot answer.
export function burnAtLapTime(points, lapSec) {
  const curve = normalizeCurve(points);
  if (curve.length === 0 || !(lapSec > 0)) return null;
  if (curve.length === 1) return curve[0].fuelL;
  if (lapSec <= curve[0].lapSec) return curve[0].fuelL;
  const last = curve[curve.length - 1];
  if (lapSec >= last.lapSec) return last.fuelL;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (lapSec <= b.lapSec) {
      const t = (lapSec - a.lapSec) / (b.lapSec - a.lapSec);
      return a.fuelL + t * (b.fuelL - a.fuelL);
    }
  }
  return last.fuelL;
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
    plan: null,
    tyreSets: defaultTyreSets(12).map((t, i) => (i === 0 ? { ...t, used: true } : t)),
    brakeSets: defaultAllBrakeSets(),
    learn: { byDriver: {}, fuelRef: null },
    config: {
      fuelModel: 'driver-avg', // 'driver-avg' now; 'driver-laptime' once live timing exists
      tankLiters: 100,
      // Fuel on board at the start of the race. Series often start on a
      // part tank (minimum-fuel qualifying, a formation-lap top-up cap), so
      // this is set per car rather than assumed to be a full tank. 0 = full.
      startFuelL: 0,
      // 'sc' = behind the Safety Car (rolling queue, still moving at a fair
      // pace); 'fcy' = Full Course Yellow / Code 60 (fixed delta speed, so
      // slower and thirstier per lap in time but leaner per lap in fuel).
      burnPerLap: { dry: 2.8, wet: 2.4, sc: 1.2, fcy: 0.9 },
      avgLapSec: { dry: 105, wet: 118, sc: 165, fcy: 180 },
      // Tyre life as a distance — laps come from the track length (see
      // tyreLifeLapsOf). tyreLifeLaps stays for states saved before that.
      tyreLifeKm: 300,
      tyreLifeLaps: 90,
      tyreSets: 12,
      brakeLifeH: { padsFront: 8, padsRear: 10, discsFront: 14, discsRear: 16 },
      // How many numbered sets of each are in the rack.
      brakeSets: { ...DEFAULT_BRAKE_SET_COUNT },
      maxStintMin: 65,
      pitLossSec: 55,
      driveThroughSec: 0, // event setting, mirrored here like the rest
      refuelLps: 2.5,
      tyreChangeSec: 25,
      trackKm: 4.0,
      fcySpeedKmh: 80,
      scSpeedKmh: 0,
      s1EndKm: 0,
      s2EndKm: 0,
      s3EndKm: 0,
      pitInKm: 0,
      finishFuelL: 5,
      safetyFuelL: 3,
      fuelWarnLaps: 5 // low-fuel warning once this few laps remain (0 = off)
    },
    state: {
      stintStartMs: null,
      lapsThisStint: 0,
      totalLaps: 0,
      inPit: false,
      pitEnterMs: null,
      fuelLiters: 100,
      tyreLapsOnSet: 0,
      tyreSetsUsed: 1,
      // Set that just came off and is waiting for KEEP or SCRAP:
      // { setId, atMs, laps, km, kmFcy }. Cleared by the engineer's answer.
      pendingSetDecision: null,
      // What the last pit-lane visit was and what the app did about it:
      // { kind, pitSec, stationarySec, applied, atMs, undoUntilMs }.
      lastPitVisit: null,
      currentTyreSetId: 't1',
      brakeUsedH: { padsFront: 0, padsRear: 0, discsFront: 0, discsRear: 0 },
      // The numbered set of each component that is on the car right now.
      currentBrakeSetId: { padsFront: 'pf1', padsRear: 'pr1', discsFront: 'df1', discsRear: 'dr1' },
      lastLapSec: null,
      avgLapSecLive: null, // rolling average of recent green laps (feeds the fuel curve)
      recentLapSec: [], // the laps behind avgLapSecLive, newest last
      stintLapSec: [], // every timed lap of the current stint (for the stint sheet)
      stintFuelStartL: null, // fuel on board when the stint started (actual-burn stats)
      // Last time live data arrived for this car — a station connecting or a
      // linked timing-feed event. null = nothing yet this race, so the wall
      // can tell an unused car entry from a station that dropped mid-race.
      liveSeenMs: null
    },
    nextStop: emptyStop(),
    stintHistory: []
  };
}

// Label for the car pickers (start screen, station CONNECTION tab). The slot
// keeps its "Car N" identity — that is what a station connects as — with the
// team's own name (or the race number, when it differs) appended so the
// pickers read like the pit wall, not like an anonymous 1–4 list.
export function carPickLabel(id, car) {
  const def = `Car #${car.number}`;
  const name = String(car.name || '').trim();
  if (name && name !== def) return `Car ${id} — ${name}`;
  if (String(car.number) !== String(id)) return `Car ${id} — #${car.number}`;
  return `Car ${id}`;
}

// Fuel the car should be sitting on when the race starts. A start figure of 0
// (or one over the tank) means "full tank", so a car that never touches the
// setting behaves exactly as it did before the setting existed.
export function startFuelOf(car) {
  const tank = Number(car?.config?.tankLiters) || 0;
  const start = Number(car?.config?.startFuelL) || 0;
  return start > 0 ? Math.min(start, tank) : tank;
}

export function defaultState() {
  const cars = {};
  for (let i = 1; i <= 4; i++) cars[String(i)] = defaultCar(String(i), String(i));
  return {
    race: {
      name: '24H Race',
      durationH: 24,
      startMs: null,
      // mode: manual override ('auto' | 'fcy' | 'green'); flag: the last flag
      // seen from the timing feed; active/startMs: the resolved neutralisation
      // and when it began (kept for the elapsed-time readouts).
      fcy: { mode: 'auto', active: false, startMs: null, source: 'none', flag: null, overrideFlag: null }
    },
    settings: {
      backupIntervalMin: 5
    },
    event: defaultEvent(),
    presets: {},
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

// Burn rate for a condition, with the source of the figure, so the UI can say
// where the number came from. Precedence:
//   neutralised race      → the car's SC or FCY rate (overrides everything)
//   'driver-laptime' model → the driver's lap-time curve at the reference lap
//   driver average         → the driver's own dry/wet L/lap when set (> 0)
//   car default            → config.burnPerLap[cond]
// `lapSec` is the lap time to read the curve at; carCalcs passes the smoothed
// live lap time. SC/FCY always use the car-level figure.
//
// `pace` is the race condition's pace (null | 'sc' | 'fcy' | 'stopped'). It
// also accepts the legacy `true` for FCY so older callers keep working.
export function burnDetail(car, cond = car.condition, pace = null, lapSec = null) {
  const p = pace === true ? 'fcy' : pace;
  if (p === 'stopped') {
    return { burn: 0, source: 'stopped', lapSec: null };
  }
  if (p === 'sc' || p === 'fcy') {
    const rates = car.config.burnPerLap || {};
    // Fall back to the SC figure when the FCY rate has never been set, so a
    // state saved by an older build behaves exactly as it did before.
    const burn = (p === 'fcy' ? (rates.fcy ?? rates.sc) : rates.sc) || 0;
    return { burn, source: p, lapSec: null };
  }
  const d = car.drivers.find(x => x.id === car.currentDriverId);
  if (d && car.config.fuelModel === 'driver-laptime' && cond !== 'sc') {
    const ref = lapSec > 0 ? lapSec : car.config.avgLapSec?.[cond];
    const fromCurve = burnAtLapTime(d.fuelCurve, ref);
    if (fromCurve != null) {
      return {
        burn: fromCurve,
        source: 'curve',
        lapSec: ref,
        // True when the reference lap sits outside the measured points and the
        // value is being held flat — worth flagging in the UI.
        clamped: isCurveClamped(d.fuelCurve, ref)
      };
    }
  }
  if (d) {
    if (cond === 'dry' && d.fuelDry > 0) return { burn: d.fuelDry, source: 'driver', lapSec: null };
    if (cond === 'wet' && d.fuelWet > 0) return { burn: d.fuelWet, source: 'driver', lapSec: null };
  }
  return { burn: car.config.burnPerLap[cond] || 0, source: 'car', lapSec: null };
}

// How many recent laps back the live average, and how far off the median a lap
// may be before it is treated as an out-lap / traffic lap and ignored.
export const LAP_AVG_WINDOW = 5;
export const LAP_OUTLIER_FACTOR = 1.15;

// Fold a new lap time into the rolling window and recompute the average that
// the fuel curve is read at. Laps more than LAP_OUTLIER_FACTOR off the window
// median (in/out laps, traffic, FCY laps) still enter the window but are left
// out of the average, so the fuel projection tracks representative green laps.
// Returns the new { recentLapSec, avgLapSecLive }.
export function pushLapTime(recent, lapSec) {
  const list = [...(Array.isArray(recent) ? recent : [])];
  if (lapSec > 0) list.push(lapSec);
  while (list.length > LAP_AVG_WINDOW) list.shift();
  if (list.length === 0) return { recentLapSec: list, avgLapSecLive: null };

  const sorted = [...list].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const clean = list.filter(x => x <= median * LAP_OUTLIER_FACTOR);
  const use = clean.length > 0 ? clean : list;
  const avg = use.reduce((a, b) => a + b, 0) / use.length;
  return { recentLapSec: list, avgLapSecLive: Math.round(avg * 1000) / 1000 };
}

// Whether a lap time falls outside the curve's measured range (value held flat).
export function isCurveClamped(points, lapSec) {
  const curve = normalizeCurve(points);
  if (curve.length === 0) return false;
  return lapSec < curve[0].lapSec || lapSec > curve[curve.length - 1].lapSec;
}

export function effectiveBurn(car, cond = car.condition, pace = null, lapSec = null) {
  return burnDetail(car, cond, pace, lapSec).burn;
}

// Projected lap time under a neutralisation, with the same SC → FCY fallback
// as the burn rates.
export function paceLapSec(car, pace) {
  const laps = car.config.avgLapSec || {};
  if (pace === 'fcy') return laps.fcy ?? laps.sc;
  if (pace === 'sc') return laps.sc;
  return null;
}

// ---------------------------------------------------------------------------
// Driver drive-time regulations
// ---------------------------------------------------------------------------
// Series rulebooks limit how long a driver may be behind the wheel: in any
// rolling 6 h window, over the whole race, and how long they must rest between
// stints. The three limits live in the event settings (0 = not enforced).
// Everything is computed from the stint history plus the running stint, so it
// is exact bookkeeping, not an estimate.

export const REG_WINDOW_MS = 6 * 3600e3;

export function driveTimeStats(car, race, now) {
  const cfg = car.config;
  const clock = raceClock(race, now);
  const winStart = now - REG_WINDOW_MS;
  const max6hMs = (cfg.reg6hMin || 0) * 60e3;
  const maxTotalMs = (cfg.regTotalMin || 0) * 60e3;
  const minRestMs = (cfg.regRestMin || 0) * 60e3;
  const enabled = max6hMs > 0 || maxTotalMs > 0 || minRestMs > 0;

  const byDriver = {};
  for (const d of car.drivers) {
    byDriver[d.id] = { windowMs: 0, totalMs: 0, lastEndMs: null, driving: false, restMs: null };
  }
  const addSpan = (id, from, to) => {
    const s = byDriver[id];
    if (!s || !(to > from)) return;
    s.totalMs += to - from;
    s.windowMs += Math.max(0, Math.min(to, now) - Math.max(from, winStart));
    if (s.lastEndMs == null || to > s.lastEndMs) s.lastEndMs = to;
  };
  for (const h of car.stintHistory) addSpan(h.driverId, h.startMs, h.endMs);
  if (clock.running && car.state.stintStartMs && byDriver[car.currentDriverId]) {
    addSpan(car.currentDriverId, car.state.stintStartMs, now);
    byDriver[car.currentDriverId].driving = true;
  }

  for (const d of car.drivers) {
    const s = byDriver[d.id];
    s.restMs = s.driving || s.lastEndMs == null ? null : Math.max(0, now - s.lastEndMs);
    // Time this driver may still drive right now. The 6 h window figure is
    // conservative: old driving rolls out of the window over time, so the
    // real allowance can only be larger — never smaller — than this.
    s.window6hLeftMs = max6hMs > 0 ? Math.max(0, max6hMs - s.windowMs) : null;
    s.totalLeftMs = maxTotalMs > 0 ? Math.max(0, maxTotalMs - s.totalMs) : null;
    s.over6h = max6hMs > 0 && s.windowMs > max6hMs;
    s.overTotal = maxTotalMs > 0 && s.totalMs > maxTotalMs;
    s.resting = minRestMs > 0 && !s.driving && s.restMs != null && s.restMs < minRestMs;
    s.restLeftMs = s.resting ? minRestMs - s.restMs : 0;
    const leftCandidates = [s.window6hLeftMs, s.totalLeftMs].filter(v => v != null);
    s.driveLeftMs = leftCandidates.length ? Math.min(...leftCandidates) : null;
    s.eligible = !s.over6h && !s.overTotal && !s.resting &&
      (s.driveLeftMs == null || s.driveLeftMs > 0);
  }

  return {
    enabled,
    limits: {
      max6hMs: max6hMs || null,
      maxTotalMs: maxTotalMs || null,
      minRestMs: minRestMs || null
    },
    byDriver
  };
}

// Everything the UIs derive from raw car state, computed in one place.
export function carCalcs(car, race, now) {
  const cfg = car.config;
  const s = car.state;
  const cond = car.condition;
  // One resolved condition drives burn, lap time and the UI alert styling.
  const condition = raceCondition(race);
  const pace = condition.pace;
  const fcyActive = pace === 'sc' || pace === 'fcy'; // kept for existing callers

  // Reference lap time for the lap-time fuel model: the smoothed rolling
  // average of recent live laps if there is one, else the last lap, else the
  // configured average. A single traffic or out-lap must not swing the whole
  // fuel projection, hence the average rather than the raw last lap.
  const refLapSec = s.avgLapSecLive > 0 ? s.avgLapSecLive
    : (s.lastLapSec > 0 ? s.lastLapSec : cfg.avgLapSec[cond]);

  const burnInfo = burnDetail(car, cond, pace, refLapSec);
  // Under a red flag / chequered nothing is being consumed, but the downstream
  // projections divide by burn — so hold the green rate for the arithmetic and
  // let the UI show the condition instead of a misleading infinite range.
  const burn = burnInfo.burn > 0
    ? burnInfo.burn
    : (burnDetail(car, cond, null, refLapSec).burn || 1);

  // With the lap-time model the projection should run on the lap time the
  // consumption was read at, not the static configured average — otherwise
  // fuel and time disagree about how fast the car is going.
  const projLapSec = pace === 'sc' || pace === 'fcy'
    ? paceLapSec(car, pace)
    : (burnInfo.source === 'curve' && refLapSec > 0 ? refLapSec : cfg.avgLapSec[cond]);
  const lapMs = (projLapSec || 100) * 1000;
  const clock = raceClock(race, now);

  const stintElapsedMs = clock.running && s.stintStartMs ? Math.max(0, now - s.stintStartMs) : 0;

  // Fuel above the safety level is what strategy can actually spend; the
  // finish margin is what should still be on board at the flag.
  const safety = cfg.safetyFuelL || 0;
  const finishMargin = Math.max(cfg.finishFuelL || 0, safety);
  const usableFuel = Math.max(0, s.fuelLiters - safety);
  const lapsToEmpty = Math.floor(usableFuel / burn);
  const msToEmpty = lapsToEmpty * lapMs;

  // Tyre life is configured as a distance; the lap figure follows the track.
  const tyreLifeLaps = tyreLifeLapsOf(car);
  const tyreLapsLeft = Math.max(0, tyreLifeLaps - s.tyreLapsOnSet);
  const msToTyres = tyreLapsLeft * lapMs;
  // Mileage banked on the rubber currently fitted, and how it was driven.
  const tyreMileage = tyreSetMileage(currentTyreSet(car));
  const tyreKmRemaining = tyreKmLeft(car);

  const msDriverLeft = Math.max(0, cfg.maxStintMin * 60e3 - stintElapsedMs);

  const brakes = {};
  for (const b of BRAKE_COMPONENTS) {
    const usedH = (s.brakeUsedH[b.id] || 0) + stintElapsedMs / 3600e3;
    const lifeH = cfg.brakeLifeH[b.id] || 1;
    // The numbered set that is on the car, so every readout can name the part
    // it is talking about rather than just its hours.
    const set = currentBrakeSet(car, b.id);
    brakes[b.id] = {
      usedH,
      lifeH,
      leftH: Math.max(0, lifeH - usedH),
      pct: Math.min(1, usedH / lifeH),
      set,
      setName: set?.name || ''
    };
  }

  const limits = [
    { key: 'fuel', label: 'FUEL', ms: msToEmpty },
    { key: 'tyres', label: 'TYRES', ms: msToTyres },
    { key: 'driver', label: 'DRIVER TIME', ms: msDriverLeft }
  ];
  // Drive-time regulations, when the event enforces any: the current driver's
  // remaining legal seat time is a pit limit like fuel or tyres.
  const reg = driveTimeStats(car, race, now);
  const regNow = reg.byDriver[car.currentDriverId];
  if (reg.enabled && regNow && regNow.driveLeftMs != null) {
    limits.push({ key: 'reg', label: 'DRIVE LIMIT', ms: regNow.driveLeftMs });
  }
  limits.sort((a, b) => a.ms - b.ms);
  const limit = limits[0];

  const lapsRemainingRace = Math.ceil(clock.remainingMs / lapMs);
  const fuelToEnd = lapsRemainingRace * burn + finishMargin;
  const fullStintLaps = Math.floor(Math.max(0, cfg.tankLiters - safety) / burn);

  // Fuel level to leave the next stop with: enough to reach the end with the
  // finish margin still on board, capped by tank size. (The stop plan's fuel
  // figure is the level on board at release, not liters added — applyStop
  // resets the tank to it.)
  const remainingAfterStop = Math.max(0, clock.remainingMs - limit.ms);
  const lapsAfterStop = Math.ceil(remainingAfterStop / lapMs);
  const suggestedFuel = Math.max(
    0,
    Math.min(cfg.tankLiters, lapsAfterStop * burn + burn + finishMargin)
  );

  return {
    clock, stintElapsedMs, burn, burnInfo, refLapSec, lapMs, fcyActive, condition,
    safety, finishMargin, usableFuel,
    lapsToEmpty, msToEmpty,
    tyreLifeLaps, tyreLapsLeft, msToTyres, tyreMileage, tyreKmRemaining,
    msDriverLeft,
    brakes,
    limit, limits,
    reg,
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

// Projected pit stop times for one car, as absolute wall-clock ms: the end of
// the current stint (whatever runs out first), then repeated full stints to
// the end of the race. The first entry carries the limiting factor.
export function projectedStops(car, race, now, horizonMs = Infinity) {
  const clock = raceClock(race, now);
  if (!clock.running || !car.state.stintStartMs) return [];
  const calcs = carCalcs(car, race, now);
  const end = race.startMs + clock.totalMs;
  const stintMs = Math.max(calcs.fullStintLaps * calcs.lapMs, 10 * 60e3);
  const stops = [];
  let t = now + calcs.limit.ms;
  let i = 0;
  while (t < end && t <= now + horizonMs && i < 60) {
    stops.push({ atMs: t, limit: i === 0 ? calcs.limit.key : 'fuel' });
    t += (car.config.pitLossSec || 0) * 1000 + stintMs;
    i++;
  }
  return stops;
}

// Pit congestion across the team: every pair of cars projected to stop within
// `windowMs` of each other inside the horizon. One crew services four cars, so
// two stops at the same minute is a problem worth seeing hours ahead.
export function pitCongestion(cars, race, now, { windowMs = 150e3, horizonMs = 3 * 3600e3 } = {}) {
  const perCar = cars.map(car => ({ car, stops: projectedStops(car, race, now, horizonMs) }));
  const conflicts = [];
  for (let a = 0; a < perCar.length; a++) {
    for (let b = a + 1; b < perCar.length; b++) {
      for (const sa of perCar[a].stops) {
        for (const sb of perCar[b].stops) {
          if (Math.abs(sa.atMs - sb.atMs) <= windowMs) {
            conflicts.push({
              carA: perCar[a].car.id,
              carB: perCar[b].car.id,
              atMs: (sa.atMs + sb.atMs) / 2,
              deltaMs: Math.abs(sa.atMs - sb.atMs)
            });
          }
        }
      }
    }
  }
  conflicts.sort((x, y) => x.atMs - y.atMs);
  return { perCar, conflicts };
}

// Estimated stationary time for a planned stop, in seconds. The stop's fuel
// figure is the level to leave with, so liters added = target − on board
// (the on-board level freezes when the car enters the pit lane). Refuelling
// and tyre work are assumed sequential (the safe assumption in most endurance
// series, where no other work is allowed while fuel is flowing).
export function stopServiceTime(car, stop = car.nextStop) {
  const cfg = car.config;
  const target = Number(stop.fuelLiters) || 0;
  const addLiters = target > 0 ? Math.max(0, target - (car.state?.fuelLiters || 0)) : 0;
  const refuelSec = addLiters / (cfg.refuelLps || 2.5);
  const tyreSec = stop.tyres ? (cfg.tyreChangeSec || 0) : 0;
  return { addLiters, refuelSec, tyreSec, totalSec: refuelSec + tyreSec };
}

// Time spent driving the pit lane at the speed limit, and how much of the
// configured pit-lane loss that transit accounts for. The remainder is the
// entry/exit deceleration and the detour versus staying on track. Returns
// null until the pit lane length and speed limit are set.
export function pitLaneCalc(car) {
  const cfg = car.config;
  const km = cfg.pitLaneKm || 0;
  const kmh = cfg.pitSpeedKmh || 0;
  if (!km || !kmh) return null;
  const transitSec = (km / kmh) * 3600;
  return {
    km,
    kmh,
    transitSec,
    lossSec: cfg.pitLossSec || 0,
    // What the loss figure covers beyond the limited-speed transit itself.
    overheadSec: (cfg.pitLossSec || 0) - transitSec
  };
}

// Seconds a car has to spend in the pit lane beyond a clean drive-through
// before the visit counts as a service stop. Small on purpose: the drive-
// through figure is measured, and a real stop is many seconds longer.
export const PIT_SERVICE_MARGIN_SEC = 5;

// How long the engineer has to say what actually happened at a stop — long
// enough to watch the car leave and think, short enough that the answer is
// still about the stop in front of them.
export const STOP_REVIEW_MS = 120e3;

// What a pit-lane visit actually was. The timing feed reports the car in and
// out of the lane, but not what happened in between — and a drive-through, a
// penalty or an aborted stop must never apply a service. The discriminator is
// time: driving the lane at the speed limit takes `transitSec`, so anything
// meaningfully longer stood still somewhere.
//
//   'service'      — a stop was armed and the car stayed long enough: apply it
//   'driveThrough' — too quick to have been serviced: apply nothing
//   'unplanned'    — long enough to be a stop, but nothing was planned: the
//                    engineer is asked rather than guessed at
export function pitVisitKind(car, pitMs, armed) {
  const cfg = car.config;
  const pitSec = Math.max(0, pitMs / 1000);
  const lane = pitLaneCalc(car);
  // The measured drive-through time is the honest figure — a lap of the pit
  // lane at the limit, timed at the track — so it wins over the one computed
  // from lane length and speed limit whenever it is set.
  const transitSec = cfg.driveThroughSec > 0 ? cfg.driveThroughSec : (lane ? lane.transitSec : 0);
  // A couple of seconds over it and the car cannot have been standing still.
  // With no figure at all, fall back to a flat 25 s: below that nothing useful
  // has been done to a car even by a fast crew.
  const minServiceSec = transitSec > 0 ? transitSec + PIT_SERVICE_MARGIN_SEC : 25;
  const stationarySec = Math.max(0, +(pitSec - transitSec).toFixed(1));
  const long = pitSec >= minServiceSec;
  return {
    kind: !long ? 'driveThrough' : armed ? 'service' : 'unplanned',
    pitSec: +pitSec.toFixed(1),
    stationarySec,
    transitSec: +transitSec.toFixed(1),
    minServiceSec: +minServiceSec.toFixed(1)
  };
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

// ---------------------------------------------------------------------------
// Pit arrival estimate ("when does the car reach the pit box?")
// ---------------------------------------------------------------------------
// The crew's question when a neutralisation flies: how long until OUR car is
// at the pit entry if it boxes this lap? The car's position is reconstructed
// from its last timing-loop passing:
//
//   position(now) = crossing position
//                 + green speed × (time from that crossing to the FCY start)
//                 + FCY speed   × (time since the FCY start)
//
// — the car ran at its average green pace until the flag flew and at the
// regulated FCY / SC pace after it. The remaining distance to the pit entry
// at the current pace is the E.T.A.; half the pit lane at the pit speed limit
// is added on top for the box itself.
//
// Position sources, best first:
//   'tracker'  getraceresults t_i/t_p rows — last loop crossing, mm from S/F
//   'sector'   hand-entered sector distances (event settings) × the car's last
//              completed sector — from the wire's sector-end crossing stamp
//              (TeamStream) or the running lap's start + its sector times
//   'loop'     TeamStream <pass> loop crossings (positions from the session's
//              loop table; their unit is auto-detected against track length)
//   'lapclock' the "E<epoch µs>" running-lap state = the last S/F crossing
//
// A hand-entered pit entry point (pitInKm) beats the feed's pit-in loop as the
// distance the E.T.A. counts to on every source except the tracker (which
// carries real pit-loop positions).
//
// All timestamps live on the feed's server clock (µs); race.fcy.startMs is
// wall-clock and is mapped onto that clock via the snapshot's serverNowUs.
// Returns null when nothing usable is known (no feed, car in pit, red flag).
export function pitEta(car, race, timing, entry, rxMs = Date.now(), now = Date.now()) {
  if (!entry || entry.inPit) return null;
  const cfg = car.config;
  const lenMm = timing?.tracker?.lenMm > 0
    ? timing.tracker.lenMm
    : cfg.trackKm > 0 ? Math.round(cfg.trackKm * 1e6) : 0;
  if (!(lenMm > 0)) return null;
  if (timing?.serverNowUs == null) return null;
  const nowUs = timing.serverNowUs + (now - rxMs) * 1000;
  const norm = mm => ((mm % lenMm) + lenMm) % lenMm;

  // TeamStream loop positions come with no documented unit — recover the
  // scale by comparing the farthest loop with the track length (mm): a 4 km
  // track puts the last loop near 4e6 mm / 4e3 m, so the nearest power of
  // ten of the ratio is the factor. Refuses anything outside mm…m.
  const tsScale = (() => {
    const max = timing?.track?.maxLoopMm;
    if (!(max > 0)) return null;
    const s = Math.pow(10, Math.round(Math.log10(lenMm / max)));
    return s >= 1 && s <= 1000 ? s : null;
  })();

  // Hand-entered track geometry (event settings, km from the S/F line): where
  // each sector ends and where the pit entry sits. When set, these beat the
  // feed's loop table — measured meters over unit auto-detection. The list
  // stops at the first unset / non-ascending value; sectors past the list end
  // at the S/F line.
  const sectorEnds = [];
  for (const km of [cfg.s1EndKm, cfg.s2EndKm, cfg.s3EndKm]) {
    const mm = km > 0 ? Math.round(km * 1e6) : 0;
    if (!(mm > 0) || mm >= lenMm) break;
    if (sectorEnds.length && mm <= sectorEnds[sectorEnds.length - 1]) break;
    sectorEnds.push(mm);
  }
  const sectorEndMm = n => (n >= 1 && n <= sectorEnds.length ? sectorEnds[n - 1] : lenMm);
  const cfgPitMm = cfg.pitInKm > 0 && cfg.pitInKm * 1e6 < lenMm
    ? Math.round(cfg.pitInKm * 1e6) : null;

  // Last known position: where a timing loop last saw the car, and when.
  // targetMm is the pit entry in the same coordinate frame as the crossing.
  let cross = null;
  let targetMm = null;
  let source = null;
  const trk = timing?.tracker?.cars?.[entry.nr];
  if (trk && trk.tsUs > 0 && nowUs >= trk.tsUs) {
    if (trk.inPit) return null;
    cross = { mm: norm(trk.fromMm), us: trk.tsUs };
    source = 'tracker';
    // Tracker pit loops span negative → positive mm around S/F: the most
    // negative one is the pit entry. No pit loops → count to the line.
    const pits = (timing.tracker.loops || []).filter(l => l[1]).map(l => l[0]);
    targetMm = pits.length ? norm(Math.min(...pits)) : lenMm;
  }
  if (!cross && sectorEnds.length) {
    // Configured sector distances: the car was last seen completing sector N
    // at a known time — straight from the wire when the feed stamps sector-end
    // loop crossings (TeamStream), else reconstructed as the running lap's
    // start plus its completed sector times (board rows). Both candidates are
    // tried; the most recent one anchors the estimate.
    if (entry.sectNr >= 1 && entry.sectUs > 0 && nowUs >= entry.sectUs) {
      cross = { mm: norm(sectorEndMm(entry.sectNr)), us: entry.sectUs };
    }
    if (typeof entry.state === 'string' && entry.state[0] === 'E') {
      const lapUs = parseInt(entry.state.slice(1), 10);
      if (lapUs > 0 && nowUs >= lapUs) {
        let us = lapUs;
        let n = 0;
        for (const sUs of [entry.s1, entry.s2, entry.s3, entry.s4]) {
          if (!(sUs > 0) || us + sUs > nowUs) break;
          us += sUs;
          n++;
        }
        if (!cross || us > cross.us) cross = { mm: n ? norm(sectorEndMm(n)) : 0, us };
      }
    }
    if (cross) {
      source = 'sector';
      const pitIn = timing?.track?.pitInMm;
      targetMm = cfgPitMm ?? (pitIn != null && tsScale != null ? norm(pitIn * tsScale) : lenMm);
    }
  }
  if (!cross && entry.crossUs > 0 && entry.crossMm != null && tsScale != null) {
    cross = { mm: norm(entry.crossMm * tsScale), us: entry.crossUs };
    source = 'loop';
    const pitIn = timing?.track?.pitInMm;
    const sf = timing?.track?.sfMm;
    targetMm = cfgPitMm ?? (pitIn != null ? norm(pitIn * tsScale)
      : sf != null ? norm(sf * tsScale) : null);
  }
  if ((!cross || targetMm == null) && typeof entry.state === 'string' && entry.state[0] === 'E') {
    const us = parseInt(entry.state.slice(1), 10);
    if (us > 0 && nowUs >= us) {
      cross = { mm: 0, us };
      source = 'lapclock';
      targetMm = cfgPitMm ?? lenMm;
    }
  }
  if (!cross || targetMm == null) return null;

  // Speeds (mm/s). Green pace: the live rolling average of representative
  // green laps when there is one — exactly "the average speed under green" —
  // else the configured average for the car's track condition.
  const condition = raceCondition(race);
  if (condition.pace === 'stopped') return null;
  const neutral = condition.pace === 'sc' || condition.pace === 'fcy';
  const condKey = car.condition === 'wet' ? 'wet' : 'dry';
  const greenLapSec = car.state?.avgLapSecLive > 0
    ? car.state.avgLapSecLive
    : cfg.avgLapSec?.[condKey];
  if (!(greenLapSec > 0)) return null;
  const vGreen = lenMm / greenLapSec;
  let vNow = vGreen;
  if (neutral) {
    if (condition.pace === 'fcy' && cfg.fcySpeedKmh > 0) {
      vNow = (cfg.fcySpeedKmh * 1e6) / 3600; // fixed regulated speed
    } else if (condition.pace === 'sc' && cfg.scSpeedKmh > 0) {
      vNow = (cfg.scSpeedKmh * 1e6) / 3600; // Safety-Car train speed (event setting)
    } else {
      const slowLap = paceLapSec(car, condition.pace);
      if (slowLap > 0) vNow = lenMm / slowLap;
    }
  }

  // The neutralisation start, mapped onto the feed clock (startMs is stamped
  // on the pit wall's wall clock — the LAN PCs are assumed roughly in sync).
  const fcyStartUs = neutral && race?.fcy?.startMs
    ? nowUs - (now - race.fcy.startMs) * 1000
    : null;

  // Integrate the position: green pace up to the flag, current pace after.
  const greenUntilUs = fcyStartUs != null
    ? Math.min(Math.max(cross.us, fcyStartUs), nowUs)
    : nowUs;
  const travelledMm =
    vGreen * Math.max(0, (greenUntilUs - cross.us) / 1e6) +
    vNow * Math.max(0, (nowUs - greenUntilUs) / 1e6);
  const posMm = norm(cross.mm + travelledMm);

  const distMm = norm(targetMm - posMm);
  const etaEntrySec = distMm / vNow;
  // Entry → box: the box sits somewhere along the lane; half the lane at the
  // pit limit is the honest middle-of-the-road figure.
  const laneKm = cfg.pitLaneKm || 0;
  const laneKmh = cfg.pitSpeedKmh || 0;
  const toBoxSec = laneKm > 0 && laneKmh > 0 ? ((laneKm / 2) / laneKmh) * 3600 : null;

  return {
    etaEntrySec,
    toBoxSec,
    etaBoxSec: toBoxSec != null ? etaEntrySec + toBoxSec : null,
    distM: distMm / 1000,
    paceKmh: (vNow * 3600) / 1e6,
    source,
    neutral,
    crossAgeSec: (nowUs - cross.us) / 1e6,
    // More than a lap of dead reckoning without a fresh crossing: the feed
    // went quiet or the car is stopped/crawling — show it as an estimate at
    // best, never as a hard countdown.
    stale: travelledMm > lenMm * 1.15
  };
}

// ---------------------------------------------------------------------------
// Fuel strategy: the pit window
// ---------------------------------------------------------------------------
// The one fuel question that matters when a flag flies: does refuelling RIGHT
// NOW cost us anything versus refuelling at the perfect moment?
//
// The maths rests on an invariant: the liters that still have to be added at
// pit stops before the flag (fuel needed to finish − fuel on board) do not
// change while the car circulates — every lap burns from the tank and shrinks
// the need by the same amount. Total refuel time is therefore fixed; the only
// thing pitting early can waste is a whole extra pit-lane transit, by adding
// one more stop than the minimum. So:
//
//   stopsMin   = fewest fuel stops that can still reach the flag (pit with the
//                tank at the safety level, fill to the brim every time)
//   stopsIfNow = stops used when the car fills up this lap instead
//
// The FUEL WINDOW IS OPEN when both are equal: pitting now is time-neutral
// under green, and a straight gain under SC / FCY (the field circulates
// slowly, discounting the stop by gainSec). While the window is closed,
// pitting now burns one extra pit-lane loss.
//
// Everything is derived from carCalcs so the projection follows the live burn
// rate, the driver's fuel model and the current race condition.
export function fuelStrategy(car, race, now, calcs = carCalcs(car, race, now)) {
  const cfg = car.config;
  if (!calcs.clock.running) return null;
  const tank = cfg.tankLiters || 0;
  const usableTank = tank - (cfg.safetyFuelL || 0);
  const burn = calcs.burn;
  if (!(tank > 0) || !(usableTank > 0) || !(burn > 0)) return null;

  const EPS = 1e-6; // float noise must never conjure an extra stop
  const fuelNow = car.state.fuelLiters;
  const refuelLps = cfg.refuelLps || 2.5;
  const pitLossSec = cfg.pitLossSec || 0;

  // Race-to-the-flag fuel need on a GREEN basis, whatever is flying right now.
  // Projecting the rest of a race at the FCY burn rate would claim "no stop
  // needed" during every neutralisation and snap the window around each time
  // a flag flies; the honest assumption is that the race goes back to racing.
  // The neutralisation enters the verdict only as the discount on the stop.
  const greenInfo = burnDetail(car, car.condition, null, calcs.refLapSec);
  const greenBurn = greenInfo.burn > 0 ? greenInfo.burn : burn;
  const greenLapSec = greenInfo.source === 'curve' && calcs.refLapSec > 0
    ? calcs.refLapSec
    : (cfg.avgLapSec[car.condition] || calcs.lapMs / 1000);
  const fuelToEnd = Math.ceil(calcs.clock.remainingMs / (greenLapSec * 1000)) * greenBurn
    + calcs.finishMargin;
  const addNeededL = Math.max(0, fuelToEnd - fuelNow);

  // Time discount on a stop taken under the current neutralisation: rivals
  // lose (slow lap − green lap) every lap, the pitting car loses that anyway.
  const pace = calcs.condition.pace;
  const gainSec = neutralGainSec(car, pace);

  // Low-fuel warning thresholds. lapsToEmpty counts laps above the SAFETY
  // level, so "0 laps" still leaves the reserve. fuelWarnLaps = 0 disables.
  const warnLaps = cfg.fuelWarnLaps ?? 5;
  const lapsLeft = calcs.lapsToEmpty;
  const warn = {
    lapsLeft,
    msLeft: calcs.msToEmpty,
    warnLaps,
    level: warnLaps > 0 && lapsLeft <= 2 ? 'crit'
      : warnLaps > 0 && lapsLeft <= warnLaps ? 'warn' : 'ok'
  };

  if (addNeededL <= EPS) {
    // The tank already reaches the flag with the finish margin on board.
    return {
      noStopNeeded: true, windowOpen: false, verdict: 'noStop',
      fuelToEnd, addNeededL: 0, stopsMin: 0, stopsIfNow: 1,
      lapsToWindow: null, msToWindow: null, windowLapsLeft: null, windowMsLeft: null,
      fillTargetL: null, remainingPitTimeSec: 0,
      gainSec, extraStopSec: pitLossSec, netPitNowSec: pitLossSec - gainSec,
      warn
    };
  }

  const stopsMin = Math.max(1, Math.ceil(addNeededL / usableTank - EPS));
  // Pitting now = fill to the brim now, then run minimum stops on the rest.
  const stopsIfNow = 1 + Math.max(0, Math.ceil((fuelToEnd - tank) / usableTank - EPS));
  const windowOpen = stopsIfNow <= stopsMin;

  // Closed window: it opens once fuelToEnd drops to the level a fill-to-full
  // now could serve with stopsMin stops. fuelToEnd falls by one green burn per
  // green lap — per lap at the CURRENT pace that is scaled by how much slower
  // the current lap is (an FCY lap eats more race time than a green one).
  let lapsToWindow = null;
  let msToWindow = null;
  if (!windowOpen) {
    const dropPerLap = greenBurn * (calcs.lapMs / (greenLapSec * 1000));
    const openAtFuelToEnd = tank + (stopsMin - 1) * usableTank;
    lapsToWindow = Math.max(1, Math.ceil((fuelToEnd - openAtFuelToEnd) / dropPerLap - EPS));
    msToWindow = lapsToWindow * calcs.lapMs;
  }

  // Level to leave with when pitting now: full tank while more stops follow,
  // else just enough to finish plus one green lap in hand.
  const fillTargetL = Math.min(tank, Math.ceil(fuelToEnd + greenBurn));

  return {
    noStopNeeded: false,
    windowOpen,
    // The verdict a screen can act on without redoing the maths:
    //   pitNow — window open under SC/FCY, the stop is discounted: box.
    //   open   — window open under green: pitting now is time-neutral.
    //   wait   — window closed: pitting now adds a stop (+extraStopSec).
    verdict: windowOpen ? (gainSec > 0 ? 'pitNow' : 'open') : 'wait',
    fuelToEnd, addNeededL, stopsMin, stopsIfNow,
    lapsToWindow, msToWindow,
    // Open window: the stop must come before the tank reaches the safety level.
    windowLapsLeft: windowOpen ? calcs.lapsToEmpty : null,
    windowMsLeft: windowOpen ? calcs.msToEmpty : null,
    fillTargetL,
    // Fewest seconds the rest of the race must spend on fuel stops.
    remainingPitTimeSec: stopsMin * pitLossSec + addNeededL / refuelLps,
    gainSec,
    extraStopSec: pitLossSec,
    // Net time cost of filling up THIS lap versus the optimal plan
    // (negative = pitting now actually saves time).
    netPitNowSec: (windowOpen ? 0 : pitLossSec) - gainSec,
    warn
  };
}

// ---------------------------------------------------------------------------
// The recommended stop
// ---------------------------------------------------------------------------
// Everything the app already works out — the pit window, the binding limit,
// tyre and brake life, seat time and the drive-time rules — turned into ONE
// answer: when to box, what to take, who drives after it, and why. It is
// called once per situation (green, code 60 / FCY, safety car), so every
// screen can show all three before anything actually happens, and nobody has
// to build a stop under pressure.

// Seconds a stop is discounted by while the field circulates at a neutralised
// pace: rivals lose (slow lap − green lap) every lap whether they pit or not.
export function neutralGainSec(car, pace) {
  if (pace !== 'sc' && pace !== 'fcy') return 0;
  const cfg = car.config;
  const greenLapSec = cfg.avgLapSec[car.condition === 'wet' ? 'wet' : 'dry'] || 0;
  const fc = fcyCalc(car);
  const slowLapSec = pace === 'fcy' && fc ? fc.fcyLapSec : paceLapSec(car, pace);
  return greenLapSec > 0 && slowLapSec > greenLapSec ? slowLapSec - greenLapSec : 0;
}

// Who sits in the car after a stop taken now: a double-stint driver stays for
// their second stint, otherwise the eligible driver (night / rain / drive-time
// regulations permitting) with the least seat time takes over.
export function nextDriverCall(car, calcs, now) {
  const cur = car.drivers.find(d => d.id === car.currentDriverId) || null;
  const night = isNightAt(now);
  const wet = car.condition === 'wet';
  const fits = d => (!night || d.night) && (!wet || d.rain) &&
    (!calcs.reg?.enabled || calcs.reg.byDriver[d.id]?.eligible !== false);
  let pool = car.drivers.filter(fits);
  const forced = pool.length === 0;
  if (forced) pool = car.drivers.slice();

  // Consecutive stints the current driver has already run, incl. this one.
  let run = 1;
  for (let i = car.stintHistory.length - 1; i >= 0; i--) {
    if (car.stintHistory[i].driverId === car.currentDriverId) run++;
    else break;
  }
  if (cur && cur.doubleStint && run === 1 && pool.some(d => d.id === cur.id)) {
    return { change: false, driver: cur, why: 'double stint — same driver stays in' };
  }
  let cands = pool.filter(d => !cur || d.id !== cur.id);
  if (!cands.length) cands = pool;
  cands.sort((a, b) => (calcs.reg?.byDriver[a.id]?.totalMs || 0) - (calcs.reg?.byDriver[b.id]?.totalMs || 0));
  const pick = cands[0];
  return {
    change: !cur || pick.id !== cur.id,
    driver: pick,
    why: forced ? 'no eligible driver — least seat time' : 'least seat time of the eligible drivers'
  };
}

// One plan. `pace` is the situation it answers for: null = green, 'fcy' =
// code 60 / full course yellow, 'sc' = safety car. Everything else follows the
// live state, so the three plans differ exactly where the maths differs.
export function recommendedStop(car, race, now, opts = {}) {
  const cfg = car.config;
  const calcs = opts.calcs || carCalcs(car, race, now);
  const fs = opts.fs !== undefined ? opts.fs : fuelStrategy(car, race, now, calcs);
  const pace = opts.pace === undefined ? calcs.condition.pace : opts.pace;
  const neutral = pace === 'sc' || pace === 'fcy';
  const gainSec = neutralGainSec(car, pace);
  const pitLoss = cfg.pitLossSec || 0;
  const running = calcs.clock.running;
  const rem = calcs.clock.remainingMs;

  // How long the stint after this stop can run — the yardstick for "will this
  // component survive to the next stop, or does it have to be done now?".
  const stintMs = Math.min(
    Math.max(1, calcs.fullStintLaps) * calcs.lapMs,
    (cfg.maxStintMin || 60) * 60e3,
    rem > 0 ? rem : Infinity
  );

  // ---- fuel: a mode, not a moving number. FULL is what the crew can act on;
  // the exact litre figure only matters on the closing stops.
  const tank = cfg.tankLiters || 0;
  let fuel;
  if (!fs) {
    fuel = { mode: 'none', liters: 0, addL: 0, rigSec: 0, why: 'no fuel projection yet' };
  } else if (fs.noStopNeeded) {
    fuel = { mode: 'none', liters: 0, addL: 0, rigSec: 0, why: 'the tank already reaches the flag' };
  } else {
    const liters = Math.max(0, Math.min(tank, Math.ceil(fs.fillTargetL)));
    const mode = liters >= tank ? 'full' : 'toEnd';
    const addL = Math.max(0, Math.ceil(liters - car.state.fuelLiters));
    fuel = {
      mode, liters, addL,
      rigSec: Math.round(addL / (cfg.refuelLps || 2.5)),
      why: mode === 'full'
        ? 'more stops follow — nothing is gained by carrying less'
        : 'enough to reach the flag with the finish margin and a lap in hand'
    };
  }

  // ---- tyres: change when the set on the car cannot cover the stint that
  // would follow this stop, and never when it already reaches the flag.
  const reachFlag = calcs.msToTyres >= rem && rem > 0;
  const change = running && !reachFlag && calcs.msToTyres < stintMs;
  const fit = change ? stopTyreSet(car) : null;
  const tyres = {
    change: !!change,
    set: fit,
    setId: fit?.id || null,
    why: !running ? 'race not started'
      : reachFlag ? `${calcs.tyreLapsLeft} laps left — reaches the flag`
      : change ? (fit ? `${calcs.tyreLapsLeft} laps left, next stint ${Math.round(stintMs / calcs.lapMs)}`
                      : 'no set free — every spare is used or scrapped')
      : `${calcs.tyreLapsLeft} laps left — good for another stint`
  };

  // ---- driver
  const dc = nextDriverCall(car, calcs, now);
  const drvMs = Math.min(...calcs.limits.filter(l => l.key === 'driver' || l.key === 'reg').map(l => l.ms));
  const driver = {
    change: running && dc.change,
    id: dc.change ? dc.driver?.id || null : null,
    name: dc.driver?.name || '',
    why: !running ? 'race not started'
      : dc.change ? `${dc.why} · seat-time limit in ${fmtMinSec(drvMs)}`
      : dc.why
  };

  // ---- brakes: components that cannot survive another stint
  const brakes = [];
  for (const b of BRAKE_COMPONENTS) {
    const leftMs = calcs.brakes[b.id].leftH * 3600e3;
    if (leftMs >= rem && rem > 0) continue; // reaches the flag
    if (leftMs < stintMs) brakes.push(b.id);
  }

  // ---- when, and the call itself
  const warnCrit = fs?.warn?.level === 'crit' && !fs.noStopNeeded;
  const netSec = fs && !fs.noStopNeeded ? (fs.windowOpen ? 0 : pitLoss) - gainSec : 0;
  let verdict, head, sub, dueKey, dueMs, dueNote;

  if (!running) {
    verdict = 'none';
    head = calcs.clock.scheduled ? 'RACE NOT STARTED' : 'NO RACE CLOCK';
    sub = 'The plan starts working the moment the clock does.';
    dueKey = 'STARTS IN';
    dueMs = calcs.clock.msToStart || 0;
    dueNote = '';
  } else if (fs && fs.noStopNeeded && !tyres.change && !driver.change && !brakes.length) {
    verdict = 'noStop';
    head = 'NO STOP NEEDED';
    sub = 'Fuel, tyres, seat time and brakes all reach the flag.';
    dueKey = 'TO GO';
    dueMs = rem;
    dueNote = '';
  } else if (warnCrit) {
    verdict = 'boxNow';
    head = 'BOX THIS LAP';
    sub = `${fs.warn.lapsLeft} lap${fs.warn.lapsLeft === 1 ? '' : 's'} above the safety level. Nothing is gained by another lap.`;
    dueKey = 'FUEL LEFT';
    dueMs = calcs.msToEmpty;
    dueNote = 'low fuel';
  } else if (neutral && fs && !fs.noStopNeeded) {
    if (netSec <= 0) {
      verdict = 'boxNow';
      head = 'BOX NOW';
      sub = netSec <= -1
        ? `A stop under this neutralisation is discounted ${gainSec.toFixed(0)} s — it saves about ${Math.abs(netSec).toFixed(0)} s` +
          (fs.windowOpen ? '.' : ', even though it adds a stop later.')
        : 'The stop is effectively free at this pace.';
      dueKey = 'PIT ENTRY';
      dueMs = null;
      dueNote = fs.windowOpen ? 'window open' : 'adds one stop, still ahead';
    } else {
      verdict = 'stay';
      head = 'STAY OUT';
      sub = `Boxing now still costs ${netSec.toFixed(0)} s net — the window opens in ${fs.lapsToWindow} laps.`;
      dueKey = 'WINDOW IN';
      dueMs = fs.msToWindow;
      dueNote = `${fs.lapsToWindow} laps`;
    }
  } else if (fs && !fs.noStopNeeded && fs.windowOpen) {
    verdict = 'box';
    head = `BOX WITHIN ${fs.windowLapsLeft} LAPS`;
    sub = 'The window is open — the pit-lane loss is spent either way, so take everything that needs doing.';
    dueKey = 'LATEST';
    dueMs = calcs.msToEmpty;
    dueNote = `${fs.windowLapsLeft} laps of fuel`;
  } else if (fs && !fs.noStopNeeded) {
    verdict = 'stay';
    head = 'STAY OUT';
    sub = `Boxing now would add a whole extra stop (+${pitLoss} s). The fuel window opens in ${fs.lapsToWindow} laps.`;
    dueKey = 'BOX IN';
    dueMs = calcs.limit.ms;
    dueNote = `${calcs.limit.label.toLowerCase()} limited · window in ${fs.lapsToWindow} laps`;
  } else {
    verdict = 'plan';
    head = `NEXT STOP IN ${fmtMinSec(calcs.limit.ms)}`;
    sub = `${calcs.limit.label.toLowerCase()} runs out first.`;
    dueKey = 'BOX IN';
    dueMs = calcs.limit.ms;
    dueNote = `${calcs.limit.label.toLowerCase()} limited`;
  }

  // The safety car is the one call the app cannot finish on its own: the feed
  // carries no pit-lane-open flag, and a stop into a closed lane is a penalty.
  const ask = pace === 'sc' && verdict !== 'none' && verdict !== 'noStop'
    ? 'Is the pit lane open? Race control has to confirm before the car turns in.'
    : null;

  const svc = stopServiceTime(car, { fuelLiters: fuel.liters, tyres: tyres.change });
  return {
    pace: pace || null,
    verdict, head, sub, ask,
    dueKey, dueMs, dueNote,
    fuel, tyres, driver, brakes,
    stintMs,
    gainSec, netSec,
    est: { stationarySec: svc.totalSec, totalSec: svc.totalSec + pitLoss, addLiters: svc.addLiters },
    limit: { key: calcs.limit.key, label: calcs.limit.label, ms: calcs.limit.ms }
  };
}

// All three situations at once — what every screen actually wants.
export function recommendedStops(car, race, now, calcs = carCalcs(car, race, now)) {
  const fs = fuelStrategy(car, race, now, calcs);
  const live = calcs.condition.pace === 'sc' ? 'sc' : calcs.condition.pace === 'fcy' ? 'fcy' : 'green';
  return {
    live,
    atMs: now,
    green: recommendedStop(car, race, now, { calcs, fs, pace: null }),
    fcy: recommendedStop(car, race, now, { calcs, fs, pace: 'fcy' }),
    sc: recommendedStop(car, race, now, { calcs, fs, pace: 'sc' })
  };
}

// The stop as it would actually be executed: the app's answer for every line
// the engineer has not pinned, their value for the ones they have. Pins live on
// nextStop.pinned and survive until the stop is applied or cleared.
export function resolveStop(car, plan) {
  const pin = car.nextStop?.pinned || {};
  const tank = car.config.tankLiters || 0;

  const pf = pin.fuel || null;
  const fuelMode = pf?.mode || plan.fuel.mode;
  const fuelLiters = fuelMode === 'full' ? tank
    : fuelMode === 'none' ? 0
    : fuelMode === 'set' ? Math.max(0, Math.min(tank, +pf?.liters || 0))
    : plan.fuel.liters; // 'toEnd' stays live until the car turns in

  const tyres = pin.tyres == null ? plan.tyres.change : pin.tyres !== 'keep';
  const tyreSetId = pin.tyres && pin.tyres !== 'keep' && pin.tyres !== 'new'
    ? pin.tyres
    : (pin.tyres === 'new' ? null : (pin.tyres == null ? plan.tyres.setId : null));

  const driverChange = pin.driver == null
    ? (plan.driver.change ? plan.driver.id : null)
    : (pin.driver === 'stay' ? null : pin.driver);

  const brakeIds = pin.brakes == null ? plan.brakes : pin.brakes;
  const brakes = {};
  // Which numbered set each changed component gets: the one the engineer
  // picked, else whatever the app would take off the rack. A component that is
  // not being changed carries no set.
  const brakeSetIds = {};
  for (const b of BRAKE_COMPONENTS) {
    const change = brakeIds.includes(b.id);
    brakes[b.id] = change;
    const pinId = pin.brakeSets?.[b.id] || null;
    brakeSetIds[b.id] = change
      ? (pinId || stopBrakeSet(car, b.id, { brakeSetIds: {} })?.id || null)
      : null;
  }

  return {
    fuelLiters: Math.round(fuelLiters),
    fuelMode,
    tyres,
    tyreSetId,
    driverChange,
    ...brakes,
    brakeSetIds,
    notes: car.nextStop?.notes || '',
    status: car.nextStop?.status || 'draft'
  };
}

// What a plan hashes to, for the approval tick: an approval is for the plan the
// engineer read, so a material change to any line clears it. The fuel target is
// bucketed to 5 L — a live "to the end" figure drifting a litre is not news.
export function stopPlanHash(stop) {
  const fuel = stop.fuelMode === 'toEnd'
    ? 'end' + Math.round((stop.fuelLiters || 0) / 5)
    : (stop.fuelMode || '') + Math.round((stop.fuelLiters || 0) / 5);
  return [
    fuel,
    stop.tyres ? 'T' + (stop.tyreSetId || 'auto') : 't',
    stop.driverChange || '-',
    // The part number is part of the plan: swapping which set goes on is a
    // change the engineer has to have read.
    BRAKE_COMPONENTS.filter(b => stop[b.id])
      .map(b => b.id + ':' + (stop.brakeSetIds?.[b.id] || 'auto')).join('+') || '-'
  ].join('|');
}

// ---- stint planning ----

export const NIGHT_START_H = 21; // local time; 21:00 → 06:00 counts as night
export const NIGHT_END_H = 6;

export function isNightAt(ms) {
  const h = new Date(ms).getHours();
  return h >= NIGHT_START_H || h < NIGHT_END_H;
}

// Generate a full-race stint plan from the driver settings table.
// Rules: stint length = min(max stint time, a full tank at the driver's dry
// burn); drivers with night=false are not scheduled between NIGHT_START_H and
// NIGHT_END_H; doubleStint drivers run two stints back-to-back; seat time is
// balanced by always picking the eligible driver with the least planned time.
// If race.startMs is not set the plan assumes the race starts at assumedStartMs.
// `opts` lets replanFromNow continue a race in progress: generation starts at
// race-relative `fromMs`, seat-time balancing is seeded with `seedTotals`, and
// `prevDriverId`/`prevRun` carry the double-stint state of the running stint.
export function generatePlan(car, race, assumedStartMs, opts = {}) {
  const cfg = car.config;
  const startMs = race.startMs || assumedStartMs;
  const totalMs = race.durationH * 3600e3;
  const pitMs = (cfg.pitLossSec || 0) * 1000;
  const lapMs = ((cfg.avgLapSec && cfg.avgLapSec.dry) || 100) * 1000;
  const usable = Math.max(1, cfg.tankLiters - (cfg.safetyFuelL || 0));

  // Planning runs on the configured dry average lap, so the lap-time model
  // reads each driver's curve at that lap time.
  const planLapSec = (cfg.avgLapSec && cfg.avgLapSec.dry) || 100;
  const burnOf = d => {
    if (cfg.fuelModel === 'driver-laptime') {
      const c = burnAtLapTime(d.fuelCurve, planLapSec);
      if (c != null) return c;
    }
    return (d.fuelDry > 0 ? d.fuelDry : cfg.burnPerLap.dry) || 1;
  };
  const stintFor = d => {
    const fuelLaps = Math.max(1, Math.floor(usable / burnOf(d)));
    const timeLaps = Math.max(1, Math.floor(((cfg.maxStintMin || 60) * 60e3) / lapMs));
    const laps = Math.min(fuelLaps, timeLaps);
    return { ms: laps * lapMs, laps, fuelL: +(laps * burnOf(d)).toFixed(1) };
  };

  const totals = {};
  for (const d of car.drivers) totals[d.id] = opts.seedTotals?.[d.id] || 0;
  const stints = [];
  let t = Math.max(0, opts.fromMs || 0);
  let prev = opts.prevDriverId ? car.drivers.find(d => d.id === opts.prevDriverId) || null : null;
  let prevRun = prev ? opts.prevRun || 1 : 0;

  while (t < totalMs && stints.length < 200) {
    const night = isNightAt(startMs + t);
    let pool = car.drivers.filter(d => !night || d.night);
    const noNightCover = pool.length === 0;
    if (noNightCover) pool = car.drivers.slice();

    let pick = null;
    // Continue the same driver for the second half of a double stint.
    if (prev && prev.doubleStint && prevRun === 1 && pool.some(d => d.id === prev.id)) {
      pick = prev;
    } else {
      // Force a driver change after a stint (or a completed double).
      let cands = pool.filter(d => !prev || d.id !== prev.id);
      if (cands.length === 0) cands = pool;
      cands.sort((a, b) => totals[a.id] - totals[b.id]);
      pick = cands[0];
    }
    prevRun = prev && pick.id === prev.id ? prevRun + 1 : 1;
    prev = pick;

    const st = stintFor(pick);
    const endT = Math.min(t + st.ms, totalMs);
    const actualMs = endT - t;
    const actualLaps = Math.max(1, Math.round(actualMs / lapMs));
    stints.push({
      driverId: pick.id,
      fromMs: t,
      toMs: endT,
      laps: actualLaps,
      fuelL: +(actualLaps * burnOf(pick)).toFixed(1),
      night,
      noNightCover
    });
    totals[pick.id] += actualMs;
    t = endT + pitMs;
  }

  return {
    generatedMs: assumedStartMs,
    startMs,
    assumedStart: !race.startMs,
    stints,
    totals
  };
}

// Replan the rest of the race from the live state: driven stints stay as they
// actually happened, the running stint is projected to its limiting factor,
// and the remainder is generated with seat-time balancing seeded by the real
// totals. The result replaces car.plan wholesale.
export function replanFromNow(car, race, now) {
  const clock = raceClock(race, now);
  if (!clock.running) return generatePlan(car, race, now);
  const startMs = race.startMs;
  const stints = [];
  const totals = {};
  for (const d of car.drivers) totals[d.id] = 0;

  for (const h of car.stintHistory) {
    stints.push({
      driverId: h.driverId,
      fromMs: h.startMs - startMs,
      toMs: h.endMs - startMs,
      laps: h.laps,
      fuelL: h.fuelUsedL ?? null,
      night: isNightAt(h.startMs),
      actual: true
    });
    if (totals[h.driverId] != null) totals[h.driverId] += h.endMs - h.startMs;
  }

  let fromMs = now - startMs;
  let prevDriverId = null;
  let prevRun = 0;
  if (car.state.stintStartMs) {
    const calcs = carCalcs(car, race, now);
    const stopAt = Math.min(now + calcs.limit.ms, startMs + clock.totalMs);
    stints.push({
      driverId: car.currentDriverId,
      fromMs: car.state.stintStartMs - startMs,
      toMs: stopAt - startMs,
      laps: car.state.lapsThisStint + Math.max(0, Math.round(calcs.limit.ms / calcs.lapMs)),
      fuelL: null,
      night: isNightAt(car.state.stintStartMs),
      current: true
    });
    if (totals[car.currentDriverId] != null) {
      totals[car.currentDriverId] += stopAt - car.state.stintStartMs;
    }
    fromMs = stopAt - startMs + (car.config.pitLossSec || 0) * 1000;
    prevDriverId = car.currentDriverId;
    // How many consecutive stints (incl. the running one) the current driver
    // has done — feeds the double-stint continuation rule.
    prevRun = 1;
    for (let i = car.stintHistory.length - 1; i >= 0; i--) {
      if (car.stintHistory[i].driverId === car.currentDriverId) prevRun++;
      else break;
    }
  }

  const rest = generatePlan(car, race, now, { fromMs, seedTotals: totals, prevDriverId, prevRun });
  return {
    generatedMs: now,
    startMs,
    assumedStart: false,
    replanned: true,
    stints: [...stints, ...rest.stints],
    totals: rest.totals
  };
}

// Compare the shared stint plan with what actually happened, stint by stint
// (matched by index). Returns per-row actuals plus the headline drift: how far
// ahead (+) or behind (−) of the plan the car is running, from the end of the
// last completed stint.
export function planVsActual(car, race, now) {
  const plan = car.plan;
  if (!plan?.stints?.length || !race.startMs) return null;
  const startMs = race.startMs;
  const rows = plan.stints.map((s, i) => {
    const h = car.stintHistory[i];
    if (h) {
      return {
        planned: s,
        status: 'done',
        actualDriverId: h.driverId,
        actualFromMs: h.startMs - startMs,
        actualToMs: h.endMs - startMs,
        actualLaps: h.laps,
        driverMismatch: h.driverId !== s.driverId,
        deltaEndMs: (h.endMs - startMs) - s.toMs
      };
    }
    if (i === car.stintHistory.length && car.state.stintStartMs && raceClock(race, now).running) {
      return {
        planned: s,
        status: 'current',
        actualDriverId: car.currentDriverId,
        actualFromMs: car.state.stintStartMs - startMs,
        actualLaps: car.state.lapsThisStint,
        driverMismatch: car.currentDriverId !== s.driverId
      };
    }
    return { planned: s, status: 'future' };
  });
  const lastDone = [...rows].reverse().find(r => r.status === 'done');
  return {
    rows,
    completed: car.stintHistory.length,
    driftMs: lastDone ? lastDone.deltaEndMs : 0
  };
}

// Best / representative-average of a stint's lap times. The average uses the
// same outlier rule as the live reference lap, so in/out and traffic laps do
// not drag it.
export function stintStats(lapTimes) {
  const laps = (Array.isArray(lapTimes) ? lapTimes : []).filter(t => t > 0);
  if (!laps.length) return { n: 0, bestSec: null, avgSec: null };
  const sorted = [...laps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const clean = laps.filter(t => t <= median * LAP_OUTLIER_FACTOR);
  const use = clean.length ? clean : laps;
  return {
    n: laps.length,
    bestSec: sorted[0],
    avgSec: Math.round((use.reduce((a, b) => a + b, 0) / use.length) * 1000) / 1000
  };
}

// ---------------------------------------------------------------------------
// Learning from live data
// ---------------------------------------------------------------------------
// While the race runs, every representative green lap teaches the model what
// each driver actually does: lap pace per condition, and — whenever the
// engineer enters a real fuel reading — the true consumption over the laps
// since the previous known-good reading. car.learn holds the accumulators:
//   byDriver[driverId][cond] = { laps, secSum, bestSec }         (pace)
//   byDriver[driverId].burn[cond] = { laps, liters }             (consumption)
//   fuelRef = { ms, liters, laps, driverId, cond, dirty }        (burn anchor)

export function learnedOf(learn, driverId, cond) {
  const d = learn?.byDriver?.[driverId];
  const pace = d?.[cond];
  const burn = d?.burn?.[cond];
  return {
    laps: pace?.laps || 0,
    avgSec: pace?.laps ? Math.round((pace.secSum / pace.laps) * 1000) / 1000 : null,
    bestSec: pace?.bestSec ?? null,
    burnLaps: burn?.laps || 0,
    burnLPerLap: burn?.laps ? Math.round((burn.liters / burn.laps) * 100) / 100 : null
  };
}

// Fold one green lap into the pace accumulator. Outliers (in/out laps,
// traffic) are rejected against the car's rolling live average.
export function learnLapSample(car, lapSec) {
  if (!(lapSec > 0)) return false;
  const cond = car.condition === 'wet' ? 'wet' : car.condition === 'dry' ? 'dry' : null;
  if (!cond) return false;
  const ref = car.state.avgLapSecLive;
  if (ref > 0 && lapSec > ref * LAP_OUTLIER_FACTOR) return false;
  car.learn ??= { byDriver: {}, fuelRef: null };
  const d = (car.learn.byDriver[car.currentDriverId] ??= {});
  const p = (d[cond] ??= { laps: 0, secSum: 0, bestSec: null });
  p.laps++;
  p.secSum = +(p.secSum + lapSec).toFixed(3);
  if (p.bestSec == null || lapSec < p.bestSec) p.bestSec = lapSec;
  return true;
}

// Minimum laps between two fuel readings before the span teaches consumption —
// short spans amplify reading error into garbage L/lap figures.
export const LEARN_BURN_MIN_LAPS = 3;

// A trusted fuel reading arrived (correction or post-stop level): close the
// span since the previous anchor into a burn sample if it is clean, then
// re-anchor at the new reading.
export function learnFuelReading(car, liters, now) {
  car.learn ??= { byDriver: {}, fuelRef: null };
  const ref = car.learn.fuelRef;
  const cond = car.condition === 'wet' ? 'wet' : car.condition === 'dry' ? 'dry' : null;
  let sampled = false;
  if (
    ref && !ref.dirty && cond && ref.cond === cond &&
    ref.driverId === car.currentDriverId &&
    car.state.totalLaps - ref.laps >= LEARN_BURN_MIN_LAPS &&
    ref.liters - liters > 0
  ) {
    const d = (car.learn.byDriver[car.currentDriverId] ??= {});
    const b = ((d.burn ??= {})[cond] ??= { laps: 0, liters: 0 });
    b.laps += car.state.totalLaps - ref.laps;
    b.liters = +(b.liters + (ref.liters - liters)).toFixed(2);
    sampled = true;
  }
  car.learn.fuelRef = {
    ms: now,
    liters,
    laps: car.state.totalLaps,
    driverId: car.currentDriverId,
    cond,
    dirty: false
  };
  return sampled;
}

// Anything that makes the span since the anchor unrepresentative (pit lane,
// neutralisation, condition or driver change) poisons it.
export function dirtyFuelRef(car) {
  if (car.learn?.fuelRef) car.learn.fuelRef.dirty = true;
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

// Live timing lap/sector time in microseconds → "1:53.207"
export function fmtLapUs(us) {
  us = parseInt(us, 10);
  if (isNaN(us) || us <= 0 || us > 9e18) return '—';
  const totalMs = us / 1000;
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = Math.floor(totalMs % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// Gap/interval cells: actual numbers are µs (the engine's native unit — a
// magnitude guess would turn a 0.086 s gap into 86000 "seconds"); numeric
// strings are feed display text (plain seconds unless µs-sized); other text
// ("2 laps") passes through unchanged.
export function fmtGapUs(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (n <= 0) return '—';
  const sec = typeof v === 'number' || n >= 1e6 ? n / 1e6 : n;
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    return `+${m}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
  }
  return '+' + (sec < 1 ? sec.toFixed(3) : sec.toFixed(1));
}

export function fmtH(h) {
  let whole = Math.floor(h);
  let min = Math.round((h - whole) * 60);
  if (min === 60) { whole++; min = 0; }
  return `${whole}h${String(min).padStart(2, '0')}`;
}
