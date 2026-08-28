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

// An axle is what the crew actually works on. Pads are bedded onto a disc:
// once they have run together they are a KIT, and a kit is what gets mounted,
// run and called for — which is why the plan asks for "FRONT KIT F2", not for
// four loose part groups. The four component pools above are still the parts
// (each has its own hours and its own life), the axle is how they are read.
export const BRAKE_AXLES = [
  { id: 'front', label: 'FRONT', short: 'F', discs: 'discsFront', pads: 'padsFront', prefix: 'F' },
  { id: 'rear', label: 'REAR', short: 'R', discs: 'discsRear', pads: 'padsRear', prefix: 'R' }
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

// Every non-green condition the race has seen, oldest first, as the server
// logged them: { id, fromMs, toMs, source }. A period still running has no
// toMs on the log; here it reads as running to `now` (open-ended when no
// `now` is given), so callers never meet a null end.
export function flagPeriods(race, now = Infinity) {
  return (race?.flagLog || [])
    .filter(p => p && p.fromMs > 0 && RACE_CONDITIONS[p.id])
    .map(p => ({ ...p, toMs: p.toMs ?? now, open: p.toMs == null }));
}

// Milliseconds of [fromMs, toMs] that fell under a red flag. The field stood
// still for them, so nothing that counts driving — the stint clock, seat
// time, brake hours — may count them.
export function heldMs(race, fromMs, toMs) {
  let held = 0;
  for (const p of flagPeriods(race)) {
    if (p.id !== 'red') continue;
    held += Math.max(0, Math.min(toMs, p.toMs) - Math.max(fromMs, p.fromMs));
  }
  return held;
}

// Time driven between two instants: the wall-clock span less the red flags.
export function drivenMs(race, fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  return toMs - fromMs - heldMs(race, fromMs, toMs);
}

// Event-level settings: values that are by nature the same for every car in
// the race (track properties and event regulations). They are edited on the
// pit wall only; the server mirrors them into every car's config so all
// strategy math keeps reading car.config.
export const EVENT_FIELDS = [
  'trackKm', 'fcySpeedKmh', 'scSpeedKmh', 'pitSpeedKmh', 'pitLaneKm', 'pitLossSec',
  'driveThroughSec', 'refuelLps', 'refuelDeadSec', 'maxStintMin',
  'pitEntryToPumpSec', 'pumpToExitSec', 'pumpToBoxSec', 'boxToExitSec',
  'pitEntryToBoxSec', 'minStopSec',
  's1EndKm', 's2EndKm', 's3EndKm', 'pitInKm',
  'reg6hMin', 'regTotalMin', 'regRestMin'
];

// The defaults are Zolder off its official track map — the circuit this app
// was built for — so a fresh race is already measuring the right lap. Every
// figure here is editable on the pit wall for any other track.
export function defaultEvent() {
  return {
    trackKm: 4.007,
    fcySpeedKmh: 60,
    scSpeedKmh: 0, // Safety-Car train speed; 0 = derive from the car's SC lap time
    pitSpeedKmh: 60,
    pitLaneKm: 0.411, // pit IN to pit OUT, official track map
    pitLossSec: 55,
    // Measured time to drive the pit lane without stopping. Timed at the track
    // it beats the figure derived from lane length and speed limit, and it is
    // what tells a drive-through from a stop. 0 = derive it.
    driveThroughSec: 0,
    refuelLps: 2.5,
    // Coupling and decoupling the rig: dead time that costs the same whether
    // the splash is 5 L or 70 L. Charged once per stop that takes fuel.
    refuelDeadSec: 0,
    maxStintMin: 65,
    // Pit lane broken into the legs a stop actually drives, all at the pit
    // speed limit (see pitSegments). The lane runs entry → rig → box → exit;
    // a fuel-only stop rejoins from the rig, a stop that also works on the car
    // carries on to the box. 0 = derive from the other legs.
    pitEntryToPumpSec: 0, // entry line → fuel rig
    pumpToExitSec: 0, // rig → exit line (0 = driveThrough − entryToPump)
    pumpToBoxSec: 0, // rig → working box
    boxToExitSec: 0, // box → exit line
    pitEntryToBoxSec: 0, // entry line → box, no fuel (0 = entryToPump + pumpToBox)
    // Series rulebooks sometimes set a minimum time between the pit-in and
    // pit-out lines. It is a floor on the whole visit, so work done inside it
    // is free. 0 = no such rule.
    minStopSec: 0,
    // Track geometry for the pit-arrival estimate, measured from the S/F line
    // (km). Sector ends place a car by its last completed sector; the pit
    // entry point is where the E.T.A. counts to. 0 = not set (feed geometry
    // or the S/F line is used instead). These are Zolder's own intermediates
    // off the official track map — Int 1 at 1376,4 m, Int 2 at 2864,6 m, with
    // the start line at offset 0 m. Sector 3 ends at the line itself, which is
    // what 0 means here.
    s1EndKm: 1.3764,
    s2EndKm: 2.8646,
    s3EndKm: 0,
    pitInKm: 0, // not on the official sheet — the E.T.A. counts to the S/F line
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
    // { from, to, ms, laps, pending } while the feed is held: `pending` means
    // the answer may still come by itself (see feedSessionAge) and the wall is
    // not asked yet.
    sessionAlert: null,
    // The last session the app rolled onto by itself — what was saved, and
    // where, so the wall can say so and put it back if it was wrong.
    sessionRolled: null // { from, to, ms, laps, backup }
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

// How far into the session the feed is showing is the race actually run? A
// session change is normally a question only the pit wall can answer — the
// next race of the weekend, or a laptop reconnecting into a session that has
// been running for hours look identical from here. But a session that has only
// now begun is not ambiguous: nothing on screen can belong to it, so there is
// nothing to weigh up and nothing to ask.
//
//   'fresh'   — the session clock has only just started (or has not started
//               at all) and no car has completed a lap: it starts here.
//   'running' — laps on the board, or the clock is well past the start: this
//               one has to be answered by hand.
//   'unknown' — the feed has not said yet. A session change wipes the board
//               and (on TeamStream) the whole session window with it, so the
//               first second after one carries no evidence either way.
export const SESSION_FRESH_MS = 120e3;

export function feedSessionAge(snap, freshMs = SESSION_FRESH_MS) {
  const s = snap?.session;
  if (!s) return 'unknown';
  // A completed lap outranks any clock: a board with laps on it has been
  // raced, whatever a session window says (or fails to say).
  for (const e of snap.entries || []) {
    if ((Number(e.laps) || 0) > 0) return 'running';
  }
  // Only positive evidence counts — an absent clock is not a young one.
  if (s.totalUs == null || s.remainUs == null) return 'unknown';
  const elapsedMs = Math.max(0, (s.totalUs - s.remainUs) / 1000);
  return elapsedMs <= freshMs ? 'fresh' : 'running';
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

// The three situations the app keeps a separate plan for, and the short name
// each one goes by on screen. They are three *different* work orders, not one
// order shown three ways: what the crew does under a code 60 (cheap stop, take
// everything) is rarely what they do under green.
export const PLAN_KEYS = ['green', 'fcy', 'sc'];
export const PLAN_LABEL = { green: 'GREEN', fcy: 'CODE 60', sc: 'SAFETY CAR' };

// Which of the three a pace belongs to. `recommendedStop` carries the pace it
// answered for (null = green), so a plan object always knows its own drawer.
export function planKeyOf(pace) {
  return pace === 'fcy' ? 'fcy' : pace === 'sc' ? 'sc' : 'green';
}

// The plan the stop actually follows: the one the engineer selected, else
// whatever is flying right now. Every screen resolves it the same way, so the
// card, the wall and the send button can never disagree about which of the
// three is the live work order.
export function activePlanKey(car, plans) {
  const picked = car?.nextStop?.plan;
  return PLAN_KEYS.includes(picked) ? picked : (plans?.live || 'green');
}

// The engineer's pinned lines for one situation. Empty = every line follows
// the app.
export function stopPins(car, key) {
  return car?.nextStop?.pins?.[key] || {};
}

// Which of the three situations this car puts a column up for on the wall.
// The green plan is the card's anchor and always shows — take that away and
// the crew has no planned stop to read. The safety car column never goes up:
// this series neutralises under Code 60, so a speculative SAFETY CAR column
// was width across the garage that never said anything the crew would act on.
// The plan itself stands, and the wall shows it the moment that flag is
// actually out. The code 60 column is the engineer's call — they can take it
// off the wall too, and only the column goes.
export function wallShowsPlan(car, key) {
  if (key === 'green') return true;
  if (key === 'sc') return false;
  return car?.wallPlans?.[key] !== false;
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
    // Which of the three situations the engineer is looking at, and the three
    // plans themselves. Each situation keeps its OWN pinned lines and its own
    // approval, so a code 60 plan can say "fill it full, four tyres, swap the
    // driver" while the green plan next to it says "splash and go" — and both
    // stand ready at the same time.
    plan: null, // null = follow whatever is flying; 'green' | 'fcy' | 'sc' = held by the engineer
    // per situation: { fuel: {mode,liters}, tyres: 'keep'|'new'|setId,
    //   driver: 'stay'|driverId, brakes: [ids], brakeSets: { compId: setId } }
    pins: { green: {}, fcy: {}, sc: {} },
    // per situation: { by, atMs, hash, stale }
    approvals: { green: null, fcy: null, sc: null }
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

export function newTyreSet(id, name, compound = 'slick') {
  return {
    id,
    name,
    // 'slick' or 'wet'. Two different stocks that happen to share a rack: the
    // rationing sums must never count a wet set toward dry running, and a wet
    // switch must never find the wets already spent on a dry whim.
    compound,
    laps: 0,
    km: 0,
    kmFcy: 0,
    used: false,
    scrapped: false,
    scrapReason: null
  };
}

/** Sets saved before compounds existed are slicks — that is what they were. */
export function tyreCompoundOf(set) {
  return set?.compound === 'wet' ? 'wet' : 'slick';
}

export function defaultTyreSets(count = 12) {
  return Array.from({ length: Math.max(1, count) },
    (_, i) => newTyreSet('t' + (i + 1), 'S' + (i + 1)));
}

// --- generating a batch of sets ---------------------------------------------
// A team arrives with an allocation, not with twelve sets called S1..S12: the
// rubber comes off the truck already marked ("S1_GVP", "24H-01", "R07"), and
// typing that in one row at a time at 23:00 is how a set ends up mislabelled.
// So sets are generated the way the allocation is written down — a naming
// pattern, a starting number and a count.
//
// [#] in the pattern is where the number goes; more hashes pad it with zeros
// ([###] -> 001), which is what the sticker says when the numbers come from a
// championship. A pattern with no [#] at all gets the number appended, so a
// crew that just types "GVP" still gets GVP1, GVP2... rather than a dozen sets
// with the same name.

export const TYRE_SET_PATTERN = 'S[#]';
export const SET_GEN_MAX = 50;
export const TYRE_SET_GEN_MAX = SET_GEN_MAX; // kept: the tyre form's own name

// The names a pattern writes. `subst` fills the tokens that are not the
// number — the brake rack uses [P] for the component's own prefix — and is
// applied first, so a substituted value can never eat the [#] that follows.
export function expandSetNames(pattern, fallback, start = 1, count = 1, subst = {}) {
  const n = Math.max(0, Math.min(SET_GEN_MAX, Math.round(+count || 0)));
  const from = Math.max(0, Math.round(+start || 0));
  let raw = String(pattern ?? '').trim() || fallback;
  for (const [token, value] of Object.entries(subst)) {
    raw = raw.split('[' + token + ']').join(value);
  }
  const numbered = /\[#+\]/.test(raw);
  const names = [];
  for (let i = 0; i < n; i++) {
    const nr = String(from + i);
    names.push(numbered
      ? raw.replace(/\[(#+)\]/g, (_, hashes) => nr.padStart(hashes.length, '0'))
      : raw + nr);
  }
  return names;
}

export function tyreSetNames(pattern = TYRE_SET_PATTERN, start = 1, count = 1) {
  return expandSetNames(pattern, TYRE_SET_PATTERN, start, count);
}

// Where a batch should start numbering: one past the highest number already in
// these names, so a generation continues the series on the rack instead of
// colliding with it. The last run of digits in a name is its number, which is
// what reads a suffixed label right — "S12_GVP" is set 12.
export function nextSetNumber(names) {
  const nums = (names || [])
    .map(n => String(n ?? '').match(/(\d+)(?!.*\d)/))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10))
    .filter(n => !isNaN(n));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

// The list a generation would leave behind, without touching the car: the sets
// that survive, then the new ones. `replaceUnused` sweeps out the sets nobody
// has run — the default S1..S12 the app seeds a car with, typically — while
// the set on the car, every used set and every scrapped one stay put: their
// mileage and their history are race data, not placeholders.
//
// New ids continue past the highest one ever handed out in this list, so a
// generated set can never inherit the id of a set that was just swept away
// (a stop still pointing at the old id would otherwise fit the wrong rubber).
// `duplicates` reports names that already exist among the survivors — the
// caller decides what to do about them; nothing here refuses.

export function generateTyreSets(car, opts = {}) {
  const {
    pattern = TYRE_SET_PATTERN, start = 1, count = 1, replaceUnused = false
  } = opts;
  return setTyreSetNames(car, tyreSetNames(pattern, start, count), { replaceUnused });
}

// The same list built from names given outright rather than from a pattern —
// what a car file carries, where the allocation was written down once and is
// being read back rather than described again. `skipExisting` is the
// difference between the two callers: a crew generating a batch wants a name
// clash reported and nothing dropped, while a file describing the rack means
// the same physical set — adding a second "S1" next to the one that has
// already run 180 km would be a second set that does not exist.
export function setTyreSetNames(car, names, { replaceUnused = false, skipExisting = false } = {}) {
  const existing = (car.tyreSets || []).map(t => ({ ...t }));
  const curId = car.state?.currentTyreSetId;
  // A file naming a set that is already on the rack is talking about that set,
  // so it survives the sweep with its own id — a stop, a plan or a warmer
  // pointing at it must not find itself pointing at nothing after a load.
  const named = skipExisting ? new Set(names) : new Set();
  const keep = replaceUnused
    ? existing.filter(t => t.used || t.scrapped || t.id === curId || named.has(t.name))
    : existing;
  const kept = new Set(keep.map(t => t.name));
  const duplicates = names.filter(n => kept.has(n));
  const add = skipExisting ? names.filter(n => !kept.has(n)) : names;
  let nextNr = existing.reduce(
    (mx, t) => Math.max(mx, parseInt(String(t.id).replace(/^t/, ''), 10) || 0), 0) + 1;
  const sets = keep.concat(add.map(name => newTyreSet('t' + nextNr++, name)));
  return { sets, names, duplicates, removed: existing.length - keep.length };
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

/**
 * Whether there is enough rubber in the garage to reach the flag.
 *
 * <p>Every other tyre figure in here is about the set on the car. This one is
 * about the stock: a 24 h race on a fixed allocation is a rationing problem,
 * and once the sums are tight a set binned with 200 km still in it is distance
 * the car cannot buy back. Nothing else in the app notices that, which is why a
 * stop under a caution can look free while quietly spending the allocation.
 *
 * <p>`deficitKm` is the distance that has no rubber behind it. While it is zero
 * the crew can fit tyres whenever it is quick to; once it is positive, life
 * thrown away has to be paid for somewhere.
 */
export function tyreBudget(car, race, now, calcs = carCalcs(car, race, now)) {
  const lifeKm = +car.config?.tyreLifeKm || 0;
  const trackKm = +car.config?.trackKm || 0;
  const lapMs = calcs?.lapMs || 0;
  if (!(lifeKm > 0) || !(trackKm > 0) || !(lapMs > 0)) return null;

  const remainingMs = Math.max(0, calcs.clock?.remainingMs || 0);
  const kmToRun = (remainingMs / lapMs) * trackKm;

  const fitted = currentTyreSet(car);
  const allUsable = usableTyreSets(car);
  // The ledger is per compound: the distance to the flag is run on whatever the
  // track demands right now, and only sets of that compound can cover it. The
  // other compound is insurance, not stock — it is counted, never budgeted.
  const activeCompound = car.condition === 'wet' ? 'wet' : 'slick';
  const sets = allUsable.filter(t => tyreCompoundOf(t) === activeCompound);
  const setsFreshOther = allUsable.filter(t =>
    tyreCompoundOf(t) !== activeCompound && !t.used && (!fitted || t.id !== fitted.id)).length;
  // The set on the car contributes only what is left in it; every other usable
  // set contributes whatever it has not already run.
  let kmAvailable = 0;
  let setsSpare = 0;
  for (const s of sets) {
    const left = Math.max(0, lifeKm - tyreSetMileage(s).km);
    kmAvailable += left;
    if (!fitted || s.id !== fitted.id) setsSpare++;
  }

  const deficitKm = Math.max(0, kmToRun - kmAvailable);
  // The fitted set only helps the ledger if it is the compound the track wants —
  // a slick on a car that needs wets covers none of the wet distance.
  const fittedCounts = fitted && tyreCompoundOf(fitted) === activeCompound;
  const fittedKmLeft = fittedCounts ? Math.max(0, lifeKm - tyreSetMileage(fitted).km) : 0;

  // The fresh-set ledger — the figure the crew actually rations by. kmAvailable
  // above counts part-worn sets on the shelf as still worth their remaining
  // life, which is true in principle; in practice a heat-cycled set is spent,
  // so what decides whether the team makes the flag is how many NEVER-USED
  // sets are left against how many the distance still needs.
  const setsFresh = sets.filter(t => !t.used && (!fitted || t.id !== fitted.id)).length;
  // Run the fitted set to the end of its life, then each fresh set to the end
  // of its own: the fewest fresh sets that still cover the distance.
  const setsNeededMin = Math.ceil(Math.max(0, kmToRun - fittedKmLeft) / lifeKm);
  // The same distance if a fresh set goes on right now instead — the extra it
  // costs is what an early change really spends.
  const setsNeededIfChangeNow = kmToRun > 0 ? 1 + Math.ceil(Math.max(0, kmToRun - lifeKm) / lifeKm) : 0;
  const setsMargin = setsFresh - setsNeededMin;
  const marginAfterChange = setsFresh - setsNeededIfChangeNow;

  return {
    kmToRun: +kmToRun.toFixed(1),
    kmAvailable: +kmAvailable.toFixed(1),
    deficitKm: +deficitKm.toFixed(1),
    setsSpare,
    setsUsable: sets.length,
    lifeKm,
    // Life left in the set currently fitted — what a tyre change right now bins.
    fittedKmLeft,
    short: deficitKm > 0,
    activeCompound,
    setsFresh,
    // Fresh sets of the OTHER compound — insurance, shown but never budgeted.
    setsFreshOther,
    setsNeededMin,
    setsNeededIfChangeNow,
    setsMargin,
    marginAfterChange,
    // Two different questions, two thresholds. affordEarlyChange is the
    // PROPOSAL policy: the app only suggests spending a set when at least one
    // fresh set stays in hand at the flag, so a puncture or a wet switch late
    // in the race does not find the shelf empty. changeForcesShort is the
    // PRICING fact: binning this life only costs an extra stop when it actually
    // pushes the ledger negative — a change the rounding absorbs forces
    // nothing, and penalising it would distort every comparison built on top.
    affordEarlyChange: marginAfterChange >= 1,
    changeForcesShort: marginAfterChange < 0 || deficitKm > 0
  };
}

// The set a stop with tyres would fit: the explicitly chosen one, else the
// first never-used set that is not already on the car. Scrapped sets are out
// of the pool — the app must never propose rubber the crew has binned.
export function stopTyreSet(car, stop = car.nextStop) {
  const sets = car.tyreSets || [];
  const chosen = sets.find(t => t.id === stop?.tyreSetId);
  if (chosen && !chosen.scrapped) return chosen;
  // The compound follows the track: a wet car gets wets. Only when the rack has
  // none of the right compound does it fall back to whatever fresh set exists —
  // wrong rubber beats no rubber, and the engineer sees the set it names.
  const want = car.condition === 'wet' ? 'wet' : 'slick';
  const fresh = sets.filter(t => !t.used && !t.scrapped && t.id !== car.state.currentTyreSetId);
  return fresh.find(t => tyreCompoundOf(t) === want) || fresh[0] || null;
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
    t.compound = t.compound === 'wet' ? 'wet' : 'slick';
    t.used = !!t.used || t.laps > 0 || t.km > 0;
    t.scrapped = !!t.scrapped;
    t.scrapReason = t.scrapped ? (t.scrapReason || null) : null;
  }
  const want = Math.max(1, Math.round(car.config.tyreSets) || sets.length);
  let nextNr = sets.length + 1;
  while (sets.length < want) {
    while (sets.some(t => t.id === 't' + nextNr)) nextNr++;
    sets.push(newTyreSet('t' + nextNr, 'S' + nextNr));
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
// Tyre warmers
// ---------------------------------------------------------------------------
// The rack says what rubber the team owns; the warmers say what is ready to go
// on the car right now. A warmer is a numbered box that holds at most one set
// out of that same rack, so the question the crew actually asks at 03:00 —
// "is the set we are calling for hot?" — has an answer on the screen.
//
// The invariants are what keep it honest, and they are all enforced in
// reconcileTyreWarmers rather than at every call site:
//   * a warmer holds a set that is really on the rack, or nothing;
//   * the same set is never in two warmers (there is only one of it);
//   * the set on the car is in no warmer (it is on the car);
//   * a scrapped set is in no warmer (it is in the bin).

export const TYRE_WARMER_MAX = 12;
export const TYRE_WARMER_DEFAULT = 0; // a team without warmers sees nothing to manage

export function newTyreWarmer(id, name) {
  return { id, name, setId: null };
}

// The list a count would leave behind. Growing appends numbered boxes; shrinking
// takes empty ones off the end first, so reducing the count never tips a set out
// of a warmer while an empty box next to it survives.
export function reconcileTyreWarmers(car) {
  if (!Array.isArray(car.tyreWarmers)) car.tyreWarmers = [];
  const warmers = car.tyreWarmers;
  // No count configured at all (an older saved state) leaves the list as it is.
  const raw = car.config?.tyreWarmers;
  const want = raw == null || raw === '' || !Number.isFinite(+raw)
    ? warmers.length
    : Math.max(0, Math.min(TYRE_WARMER_MAX, Math.round(+raw)));
  let nextNr = warmers.length + 1;
  while (warmers.length < want) {
    while (warmers.some(w => w.id === 'w' + nextNr)) nextNr++;
    warmers.push(newTyreWarmer('w' + nextNr, 'W' + nextNr));
  }
  while (warmers.length > want) {
    const empty = warmers.map((w, i) => [w, i]).reverse().find(([w]) => !w.setId);
    warmers.splice(empty ? empty[1] : warmers.length - 1, 1);
  }
  const sets = car.tyreSets || [];
  const onCar = car.state?.currentTyreSetId;
  const seen = new Set();
  for (const w of warmers) {
    w.name = String(w.name ?? '').trim() || String(w.id).toUpperCase();
    const set = sets.find(t => t.id === w.setId);
    if (!set || set.scrapped || set.id === onCar || seen.has(set.id)) w.setId = null;
    else seen.add(set.id);
  }
  if (car.config) car.config.tyreWarmers = warmers.length;
  return warmers;
}

// The warmer a set is sitting in, or null — what the picker and the stop card
// read to say whether the rubber being called for is hot.
export function warmerOfSet(car, setId) {
  if (!setId) return null;
  return (car.tyreWarmers || []).find(w => w.setId === setId) || null;
}

// Sets that may go into a warmer: on the rack, not binned, not on the car and
// not already in another box. `keepId` is the set this warmer holds now, which
// stays in its own list so the picker can show what it is looking at.
export function warmableTyreSets(car, keepId = null) {
  const taken = new Set((car.tyreWarmers || []).map(w => w.setId).filter(Boolean));
  return (car.tyreSets || []).filter(t =>
    !t.scrapped &&
    t.id !== car.state?.currentTyreSetId &&
    (t.id === keepId || !taken.has(t.id)));
}

// Put a set in a warmer, or empty it (setId = null). Returns whether anything
// moved. A set already in another box is moved rather than duplicated — the
// crew carried it across, they did not conjure a second one.
export function loadTyreWarmer(car, warmerId, setId) {
  reconcileTyreWarmers(car);
  const warmer = (car.tyreWarmers || []).find(w => w.id === warmerId);
  if (!warmer) return false;
  if (!setId) {
    if (!warmer.setId) return false;
    warmer.setId = null;
    return true;
  }
  const set = (car.tyreSets || []).find(t => t.id === setId);
  if (!set || set.scrapped || set.id === car.state?.currentTyreSetId) return false;
  for (const w of car.tyreWarmers) if (w.setId === set.id) w.setId = null;
  warmer.setId = set.id;
  return true;
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

// A disc set is the anchor a kit is named for: it is the part the pads are
// bedded onto, so the link lives on it (`padSetId`) and so does the kit's
// name. A pad set is linked from exactly one disc set, or from none.
export function isDiscComponent(comp) {
  return comp === 'discsFront' || comp === 'discsRear';
}

export function newBrakeSet(id, name, comp = null) {
  const set = { id, name, hours: 0, used: false, scrapped: false, scrapReason: null };
  if (isDiscComponent(comp)) { set.padSetId = null; set.kitName = null; }
  return set;
}

export function defaultBrakeSets(comp, count = DEFAULT_BRAKE_SET_COUNT[comp] || 4) {
  const pre = brakeComponent(comp)?.prefix || 'B';
  return Array.from({ length: Math.max(1, count) },
    (_, i) => newBrakeSet(pre.toLowerCase() + (i + 1), pre + (i + 1), comp));
}

// --- generating a rack ------------------------------------------------------
// The same idea as the tyre sets, with one token more: [P] is the component's
// own prefix — PF, PR, DF, DR — so a single pattern writes every pool the crew
// asks for and each one comes out named for what it is ([P][#] -> PF1, DR3),
// while [#]/[###] number and pad exactly as they do for tyres.

export const BRAKE_SET_PATTERN = '[P][#]';

export function brakeSetNames(comp, pattern = BRAKE_SET_PATTERN, start = 1, count = 1) {
  const pre = brakeComponent(comp)?.prefix || 'B';
  return expandSetNames(pattern, BRAKE_SET_PATTERN, start, count, { P: pre });
}

// What a generation would leave in each requested pool, without touching the
// car: one entry per component, shaped like generateTyreSets' result. The set
// on the car, every used set and every scrapped one survive `replaceUnused` —
// hours banked on a part are race data, not a placeholder.

export function generateBrakeSets(car, opts = {}) {
  const {
    comps = BRAKE_COMPONENTS.map(b => b.id),
    pattern = BRAKE_SET_PATTERN, start = 1, count = 1, replaceUnused = false
  } = opts;
  const out = {};
  for (const comp of comps) {
    out[comp] = setBrakeSetNames(car, comp, brakeSetNames(comp, pattern, start, count),
      { replaceUnused });
  }
  return out;
}

// One pool built from names given outright — the brake half of what a car
// file reads back (see setTyreSetNames).
export function setBrakeSetNames(car, comp, names, { replaceUnused = false, skipExisting = false } = {}) {
  const existing = brakeSetsOf(car, comp).map(t => ({ ...t }));
  const curId = car.state?.currentBrakeSetId?.[comp];
  // As on the tyre rack: a part number the file lists is a part the car has,
  // and it keeps its id (and whatever kit it is bedded into).
  const named = skipExisting ? new Set(names) : new Set();
  const keep = replaceUnused
    ? existing.filter(t => t.used || t.scrapped || t.id === curId || named.has(t.name))
    : existing;
  const kept = new Set(keep.map(t => t.name));
  const duplicates = names.filter(n => kept.has(n));
  const add = skipExisting ? names.filter(n => !kept.has(n)) : names;
  const pre = (brakeComponent(comp)?.prefix || 'B').toLowerCase();
  let nextNr = existing.reduce(
    (mx, t) => Math.max(mx, parseInt(String(t.id).replace(/^\D+/, ''), 10) || 0), 0) + 1;
  return {
    sets: keep.concat(add.map(name => newBrakeSet(pre + nextNr++, name, comp))),
    names, duplicates, removed: existing.length - keep.length
  };
}

// A full rack: every component's pool, with the set that is on the car at the
// start of the race already marked used.
export function defaultAllBrakeSets(counts = DEFAULT_BRAKE_SET_COUNT) {
  const out = {};
  for (const b of BRAKE_COMPONENTS) {
    out[b.id] = defaultBrakeSets(b.id, counts?.[b.id] ?? DEFAULT_BRAKE_SET_COUNT[b.id]);
    out[b.id][0].used = true;
  }
  // A fresh rack arrives kitted straight down the line — DF1 carries PF1 as
  // kit F1, DF2 carries PF2 as F2 — because that is how a crew lays parts out
  // for a race. Spare pads with no disc left to bed onto stay free.
  for (const a of BRAKE_AXLES) {
    const discs = out[a.discs] || [];
    const pads = out[a.pads] || [];
    discs.forEach((d, i) => {
      if (!pads[i]) return;
      d.padSetId = pads[i].id;
      d.kitName = a.prefix + (i + 1);
    });
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
      sets.push(newBrakeSet(pre.toLowerCase() + nextNr, pre + nextNr, b.id));
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
  reconcileBrakeKits(car);
  return car.brakeSets;
}

// ---------------------------------------------------------------------------
// Brake kits — a pad set bedded onto a disc set
// ---------------------------------------------------------------------------
// The crew does not fit "front pads" and "front discs"; it fits a kit. The
// link is one-to-one and lives on the disc set, so every reader can go from
// the number on the disc to the number on the pads that belong to it, and the
// stop card can say FRONT KIT F2 with DF2 + PF3 underneath as the parts to
// pull off the rack. Pads that are not bedded onto anything are free — they
// are what you link to a bare disc, and what a pads-only stop takes.

// Which axle a component pool belongs to.
export function axleOfComponent(comp) {
  return BRAKE_AXLES.find(a => a.discs === comp || a.pads === comp) || null;
}

export function brakeAxle(axleId) {
  return BRAKE_AXLES.find(a => a.id === axleId) || null;
}

// The kit a disc set anchors, or null when nothing is bedded onto it. Every
// reader gets both parts, the name, and whether this is the kit on the car —
// nobody should have to join three lists to render one row.
export function kitOfDiscSet(car, axleId, discSetId) {
  const a = brakeAxle(axleId);
  if (!a) return null;
  const disc = brakeSetsOf(car, a.discs).find(t => t.id === discSetId);
  if (!disc || !disc.padSetId) return null;
  const pad = brakeSetsOf(car, a.pads).find(t => t.id === disc.padSetId);
  if (!pad) return null;
  const cur = car?.state?.currentBrakeSetId || {};
  return {
    axle: a.id,
    name: disc.kitName || kitNameFor(car, a.id, disc),
    disc,
    pad,
    onCar: cur[a.discs] === disc.id && cur[a.pads] === pad.id,
    scrapped: !!disc.scrapped || !!pad.scrapped,
    used: !!disc.used || !!pad.used
  };
}

// Every kit on an axle, in rack order.
export function brakeKitsOf(car, axleId) {
  const a = brakeAxle(axleId);
  if (!a) return [];
  return brakeSetsOf(car, a.discs)
    .map(d => kitOfDiscSet(car, a.id, d.id))
    .filter(Boolean);
}

// The disc set a pad set is bedded onto, if any.
export function discSetOfPadSet(car, axleId, padSetId) {
  const a = brakeAxle(axleId);
  if (!a || !padSetId) return null;
  return brakeSetsOf(car, a.discs).find(t => t.padSetId === padSetId) || null;
}

// Pads with no disc under them: what the rack offers for linking, and what a
// pads-only stop fits onto the discs already on the car.
export function freePadSets(car, axleId, { includeScrapped = false } = {}) {
  const a = brakeAxle(axleId);
  if (!a) return [];
  const taken = new Set(brakeSetsOf(car, a.discs).map(t => t.padSetId).filter(Boolean));
  return brakeSetsOf(car, a.pads)
    .filter(t => !taken.has(t.id) && (includeScrapped || !t.scrapped));
}

// The kit currently on the car — the disc set fitted, with whatever is bedded
// onto it. Null while the pads on the car are not linked to those discs (a
// state the app only ever passes through mid-stop, since applying a stop
// re-marries what ends up on the car).
export function currentBrakeKit(car, axleId) {
  const a = brakeAxle(axleId);
  if (!a) return null;
  return kitOfDiscSet(car, a.id, car?.state?.currentBrakeSetId?.[a.discs]);
}

// The name a kit would carry: what it already has, else the next free number
// in the axle's series (F1, F2 … / R1, R2 …).
export function kitNameFor(car, axleId, disc = null) {
  if (disc?.kitName) return disc.kitName;
  const a = brakeAxle(axleId);
  if (!a) return '';
  const used = new Set(brakeSetsOf(car, a.discs).map(t => t.kitName).filter(Boolean));
  for (let n = 1; n <= 99; n++) {
    if (!used.has(a.prefix + n)) return a.prefix + n;
  }
  return a.prefix + '?';
}

// Bed a pad set onto a disc set. The link is one-to-one both ways, so the pads
// leave whatever disc they were on and the disc drops whatever it was carrying
// — two kits can never claim the same part. padSetId null just unlinks.
export function linkBrakeKit(car, axleId, discSetId, padSetId, name = null) {
  const a = brakeAxle(axleId);
  if (!a) return null;
  const discs = brakeSetsOf(car, a.discs);
  const disc = discs.find(t => t.id === discSetId);
  if (!disc) return null;
  if (!padSetId) {
    disc.padSetId = null;
    disc.kitName = null;
    return null;
  }
  const pad = brakeSetsOf(car, a.pads).find(t => t.id === padSetId);
  if (!pad) return null;
  for (const d of discs) {
    if (d !== disc && d.padSetId === pad.id) { d.padSetId = null; d.kitName = null; }
  }
  disc.padSetId = pad.id;
  disc.kitName = String(name || disc.kitName || kitNameFor(car, a.id)).slice(0, 12);
  return kitOfDiscSet(car, a.id, disc.id);
}

export function unlinkBrakeKit(car, axleId, discSetId) {
  const a = brakeAxle(axleId);
  if (!a) return null;
  // The kit on the car cannot be taken apart on paper while those two parts are
  // running together. The station hides the UNBED button on that row and the
  // server refuses the message, but the rule is a property of the rack, so it
  // holds here too — no other caller can leave the rack denying a marriage the
  // car is still driving on.
  const cur = car?.state?.currentBrakeSetId || {};
  const disc = brakeSetsOf(car, a.discs).find(t => t.id === discSetId);
  if (disc && cur[a.discs] === disc.id && cur[a.pads] === disc.padSetId) {
    return kitOfDiscSet(car, a.id, disc.id);
  }
  return linkBrakeKit(car, axleId, discSetId, null);
}

// What is on the car IS a kit, by definition — the pads fitted have run on the
// discs fitted. Called after every stop so the rack never claims a marriage
// the car has already broken.
export function syncBrakeKitToCar(car, axleId) {
  const a = brakeAxle(axleId);
  if (!a) return null;
  const cur = car?.state?.currentBrakeSetId || {};
  const discId = cur[a.discs];
  const padId = cur[a.pads];
  if (!discId || !padId) return null;
  const disc = brakeSetsOf(car, a.discs).find(t => t.id === discId);
  if (!disc || disc.padSetId === padId) return kitOfDiscSet(car, a.id, discId);
  // The pads carry their old kit name onto the discs they now live on only
  // when the discs have none of their own — a disc set keeps its identity.
  const oldName = discSetOfPadSet(car, a.id, padId)?.kitName || null;
  return linkBrakeKit(car, a.id, discId, padId, disc.kitName || oldName);
}

// Keep every link honest: a link only survives while both parts are still in
// the rack, no pad set is claimed twice, and a scrapped part is bedded onto
// nothing. A rack written before kits existed is married up here — the parts
// on the car first (they have run together, so they are a kit), then straight
// down the line for the spares.
export function reconcileBrakeKits(car) {
  const cur = car?.state?.currentBrakeSetId || {};
  for (const a of BRAKE_AXLES) {
    const discs = brakeSetsOf(car, a.discs);
    const pads = brakeSetsOf(car, a.pads);
    const padIds = new Set(pads.map(t => t.id));
    const claimed = new Set();
    let virgin = true; // nothing in this axle has ever been linked
    for (const d of discs) {
      if (d.padSetId != null || d.kitName != null) virgin = false;
      if (!('padSetId' in d)) d.padSetId = null;
      if (!('kitName' in d)) d.kitName = null;
      const pad = pads.find(t => t.id === d.padSetId);
      // A link to a part that is gone, scrapped or already spoken for is not
      // a kit — it is a leftover, and it goes.
      if (!d.padSetId || !padIds.has(d.padSetId) || claimed.has(d.padSetId) ||
          d.scrapped || pad?.scrapped) {
        d.padSetId = null;
        d.kitName = null;
        continue;
      }
      claimed.add(d.padSetId);
      d.kitName = String(d.kitName || '').trim().slice(0, 12) || kitNameFor(car, a.id);
    }
    if (!virgin) continue;
    const onDisc = discs.find(t => t.id === cur[a.discs]);
    const onPad = pads.find(t => t.id === cur[a.pads]);
    if (onDisc && onPad && !onDisc.scrapped && !onPad.scrapped) {
      onDisc.padSetId = onPad.id;
      onDisc.kitName = a.prefix + '1';
      claimed.add(onPad.id);
    }
    let n = onDisc?.padSetId ? 2 : 1;
    const free = pads.filter(t => !claimed.has(t.id) && !t.scrapped);
    for (const d of discs) {
      if (d.padSetId || d.scrapped) continue;
      const pad = free.shift();
      if (!pad) break;
      d.padSetId = pad.id;
      d.kitName = a.prefix + n++;
    }
  }
  return car?.brakeSets;
}

// The kit a stop changing a whole axle would fit. The engineer's pick wins;
// otherwise the app takes the first kit that is complete, never used and not
// on the car. With no made-up kit left it pairs the next free disc with the
// next free pad and says so (`formed`) — the crew grabbing both off the rack
// is a kit being made, and refusing to plan a stop over bookkeeping would be
// the wrong call at three in the morning.
export function stopBrakeKit(car, axleId, stop = car?.nextStop) {
  const a = brakeAxle(axleId);
  if (!a) return null;
  const cur = car?.state?.currentBrakeSetId || {};
  const pickedDiscId = stop?.brakeSetIds?.[a.discs] || null;
  if (pickedDiscId) {
    const kit = kitOfDiscSet(car, a.id, pickedDiscId);
    if (kit && !kit.scrapped) return { ...kit, formed: false };
    const disc = brakeSetsOf(car, a.discs).find(t => t.id === pickedDiscId && !t.scrapped);
    if (disc) {
      const pad = brakeSetsOf(car, a.pads).find(t => t.id === stop?.brakeSetIds?.[a.pads] && !t.scrapped) ||
        freePadSets(car, a.id).find(t => !t.used && t.id !== cur[a.pads]) ||
        freePadSets(car, a.id).find(t => t.id !== cur[a.pads]);
      if (pad) return { axle: a.id, name: kitNameFor(car, a.id, disc), disc, pad, onCar: false, formed: true };
    }
  }
  const ready = brakeKitsOf(car, a.id).find(k => !k.scrapped && !k.used && !k.onCar &&
    k.disc.id !== cur[a.discs] && k.pad.id !== cur[a.pads]);
  if (ready) return { ...ready, formed: false };
  const disc = brakeSetsOf(car, a.discs).find(t => !t.used && !t.scrapped && t.id !== cur[a.discs]);
  const pad = freePadSets(car, a.id).find(t => !t.used && t.id !== cur[a.pads]);
  if (disc && pad) {
    return { axle: a.id, name: kitNameFor(car, a.id, disc), disc, pad, onCar: false, formed: true };
  }
  // Nothing fresh: the least-worn kit still in the rack beats nothing at all.
  const worn = brakeKitsOf(car, a.id)
    .filter(k => !k.scrapped && !k.onCar && k.disc.id !== cur[a.discs])
    .sort((x, y) => (x.disc.hours + x.pad.hours) - (y.disc.hours + y.pad.hours))[0];
  return worn ? { ...worn, formed: false } : null;
}

// The pad set a pads-only stop fits — free pads bed onto the discs that are
// already on the car, so a set claimed by another kit is not offered.
export function stopPadSet(car, axleId, stop = car?.nextStop) {
  const a = brakeAxle(axleId);
  if (!a) return null;
  const cur = car?.state?.currentBrakeSetId || {};
  // The pads on the car are bedded to the discs on the car, so they are not
  // "free" — but every other unclaimed set in the pool is fair game.
  const usable = freePadSets(car, a.id).filter(t => t.id !== cur[a.pads]);
  const picked = brakeSetsOf(car, a.pads).find(t => t.id === stop?.brakeSetIds?.[a.pads]);
  if (picked && !picked.scrapped && picked.id !== cur[a.pads]) return picked;
  return usable.find(t => !t.used) ||
    usable.slice().sort((x, y) => x.hours - y.hours)[0] ||
    stopBrakeSet(car, a.pads, stop);
}

// The three things an axle can be asked for, and the component flags that say
// it. Discs never come off on their own: fresh discs need pads bedded to them,
// so a disc change IS a kit change. This pair of functions is the only place
// the two vocabularies meet — every screen speaks axles, the stop record and
// the history keep speaking components.
export const BRAKE_WORK = ['none', 'pads', 'kit'];

export function brakeAxleWork(compIds) {
  const ids = Array.isArray(compIds) ? compIds : [];
  const out = {};
  for (const a of BRAKE_AXLES) {
    out[a.id] = ids.includes(a.discs) ? 'kit' : ids.includes(a.pads) ? 'pads' : 'none';
  }
  return out;
}

export function brakeWorkComps(work) {
  const out = [];
  for (const a of BRAKE_AXLES) {
    const w = work?.[a.id];
    if (w === 'kit') out.push(a.pads, a.discs);
    else if (w === 'pads') out.push(a.pads);
  }
  return out;
}

// What one axle of a stop asks for, ready to print: the work, the kit name,
// and the two parts with the hours on them. Every card that has to say what
// the crew grabs goes through here, so the wall and the station cannot drift.
export function stopBrakeAxle(car, axleId, stop) {
  const a = brakeAxle(axleId);
  if (!a) return null;
  const work = stop?.[a.discs] ? 'kit' : stop?.[a.pads] ? 'pads' : 'none';
  if (work === 'none') return { axle: a.id, label: a.label, work, name: '', disc: null, pad: null, blocked: false };
  if (work === 'kit') {
    const kit = stopBrakeKit(car, a.id, stop) || stopBrakeKit(car, a.id, { brakeSetIds: {} });
    return {
      axle: a.id, label: a.label, work,
      name: kit?.name || '',
      disc: kit?.disc || null,
      pad: kit?.pad || null,
      formed: !!kit?.formed,
      blocked: !kit || !kit.disc || !kit.pad
    };
  }
  const pad = brakeSetsOf(car, a.pads).find(t => t.id === stop?.brakeSetIds?.[a.pads] && !t.scrapped) ||
    stopPadSet(car, a.id, stop);
  const disc = currentBrakeSet(car, a.discs);
  return {
    axle: a.id, label: a.label, work,
    name: disc?.kitName || '',
    disc, pad, formed: false,
    blocked: !pad
  };
}

// ---------------------------------------------------------------------------
// Re-stocking the racks for a new race
// ---------------------------------------------------------------------------
// A reset is a new race, not a new team — and the racks belong to the team. The
// crew books the allocation in by the numbers written on the rubber, marks
// which sets are wets and beds the pads onto the discs; none of that is race
// data, and re-seeding S1..S12 over it at the start of every session throws
// away work that was done in the garage, off a car file or over the rack page.
//
// So a reset re-stocks rather than rebuilds: the same sets, same ids, same
// names, same compounds, same kits — with everything the last race wrote on
// them (mileage, hours, which ones have run) wiped off. A set the crew binned
// stays binned: a flat-spotted tyre is not made round by a session change, and
// one tap on the rack page restores it if the shelf really did get restocked.
export function restockRacks(car) {
  const carry = (fresh, old) => {
    fresh.scrapped = !!old.scrapped;
    fresh.scrapReason = fresh.scrapped ? (old.scrapReason || null) : null;
    return fresh;
  };
  // The rubber.
  const tyres = (car.tyreSets || []).map(t => carry(newTyreSet(t.id, t.name, tyreCompoundOf(t)), t));
  car.tyreSets = tyres.length ? tyres : defaultTyreSets(car.config?.tyreSets || 12);
  const onCar = car.tyreSets.find(t => !t.scrapped) || car.tyreSets[0];
  onCar.used = true;
  onCar.scrapped = false;
  onCar.scrapReason = null;
  car.state.currentTyreSetId = onCar.id;

  // The brakes, kits and all: which pads sit on which discs is how the parts
  // are laid out on the shelf, not something the last race decided.
  const rack = {};
  for (const b of BRAKE_COMPONENTS) {
    const sets = brakeSetsOf(car, b.id).map(t => {
      const fresh = carry(newBrakeSet(t.id, t.name, b.id), t);
      if (isDiscComponent(b.id)) {
        fresh.padSetId = t.padSetId || null;
        fresh.kitName = t.kitName || null;
      }
      return fresh;
    });
    rack[b.id] = sets.length ? sets : defaultBrakeSets(b.id, car.config?.brakeSets?.[b.id]);
  }
  car.brakeSets = rack;
  car.state.currentBrakeSetId = {};
  // The car starts on a whole kit where the rack has one — fitting the first
  // disc and the first pad independently could put a marriage on the car that
  // the shelf says does not exist.
  for (const a of BRAKE_AXLES) {
    const kit = brakeKitsOf(car, a.id).find(k => !k.scrapped);
    const disc = kit?.disc || rack[a.discs].find(t => !t.scrapped) || rack[a.discs][0];
    const pad = kit?.pad || rack[a.pads].find(t => !t.scrapped) || rack[a.pads][0];
    for (const [comp, set] of [[a.discs, disc], [a.pads, pad]]) {
      set.used = true;
      set.scrapped = false;
      set.scrapReason = null;
      car.state.currentBrakeSetId[comp] = set.id;
    }
  }

  // The boxes stay — they are the garage's too — but a reset empties them,
  // since nothing on the rack is hot any more.
  for (const w of car.tyreWarmers || []) w.setId = null;

  reconcileTyreSets(car);
  reconcileTyreWarmers(car);
  reconcileBrakeSets(car);
  return car;
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

// Short driver tag for compact readouts: the entered abbreviation, else one
// derived from the name — first letter of the first name plus the first two
// of the last ("Roman Rusinov" → RRU); a single-word name gives its first
// three letters. The settings pane proposes the same derivation as the
// abbreviation field's placeholder.
export function driverAbbrev(d) {
  const ab = String(d?.abbrev || '').trim().toUpperCase();
  if (ab) return ab;
  const words = String(d?.name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return (words[0][0] + words[words.length - 1].slice(0, 2)).toUpperCase();
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

// The team's four entries. The cars are known long before the app is opened,
// so the slots carry their real race numbers from the first boot: slot 1 is
// #15, slot 2 #27, and so on. Numbers stay editable on the pit wall for the
// event where an entry is renumbered.
export const DEFAULT_CAR_NUMBERS = ['15', '27', '40', '92'];

// The number a slot starts life with. Falls back to the slot's own id so a
// fifth car, if one is ever added, still gets a number of its own.
export function defaultCarNumber(id) {
  return DEFAULT_CAR_NUMBERS[Number(id) - 1] ?? String(id);
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
    // Numbered boxes, each holding at most one of those sets. Empty until the
    // crew says how many they brought.
    tyreWarmers: [],
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
      // Deciding whether to take the neutralisation that is running, or gamble
      // on the next one. Like the track figures above these are Zolder's own:
      // 0.639 usable Code 60 per hour measured across 2019-2025, and the lap
      // time a litre of fuel and a kilometre on the tyres are each worth, off
      // the reference sheet. Editable per car on the NEXT PIT STOP card; 0 on
      // the rate means no view, and the plans are ranked without the gamble.
      cautionsPerHour: 0.639,
      tyreDegSecPerKm: 0.0087,
      fuelWeightSecPerL: 0.0079,
      // How long a usable neutralisation actually runs here. This is what
      // decides how much of the discount a stop collects: the credit accrues
      // only while the field is still crawling, so a caution that goes green
      // with the hose still in pays for part of the stop and no more. Zolder
      // 2019-2025: 7.1 min is the median Code 60 of 4 minutes or longer, and
      // roughly a quarter of them are short enough that a stop never pays.
      cautionMinutes: 7.1,
      // The crew's own points for a flag that is out. Everything above is a
      // model, and a model is only ever as right as the figures under it — a
      // crew that knows its car often just wants a number: under a
      // neutralisation, box from this fuel level, or from this far into the
      // stint, and take tyres from this one. With `on` set those points ARE
      // the answer under a flag; the ranking is bypassed, not blended, and it
      // is still shown so the crew can see what they overruled. Each point is
      // off at 0, and green is never touched — the fuel window and the limits
      // keep that call.
      flagRule: { on: false, fuelL: 0, stintMin: 0, tyreFuelL: 0, tyreStintMin: 0 },
      // Slack added to every stop the call prices, on top of the measured lane
      // and service times. Real stops are rarely textbook: an overshot box, a
      // sticky coupling, traffic in the lane. It is a robustness knob — wind it
      // up and see whether the call still stands when the stop goes wrong.
      //
      // Note which way it actually moves the answer, because it is the reverse
      // of what "make every stop dearer" sounds like: standing still in the
      // lane is discounted like every other second of a stop, so every plan
      // pays the slack at every stop it makes and only the one taken under the
      // flag gets it cheap. A sloppier stop therefore makes the flag worth
      // MORE, not less. It moves the CALL only; the pit-lane and ETA figures
      // elsewhere stay measured.
      pitSlackSec: 0,
      // Fuel burnt driving the pit lane itself, in litres. 0 derives it from
      // the neutralised burn across the lane's share of the lap, which is
      // right unless the lane is unusually long or short for the circuit.
      pitLaneFuelL: 0,
      tyreLifeLaps: 90,
      tyreSets: 12,
      // How many tyre warmers are in the garage (0 = the team runs without).
      tyreWarmers: TYRE_WARMER_DEFAULT,
      brakeLifeH: { padsFront: 8, padsRear: 10, discsFront: 14, discsRear: 16 },
      // How many numbered sets of each are in the rack.
      brakeSets: { ...DEFAULT_BRAKE_SET_COUNT },
      // The car's own average speed under green, in km/h — the yardstick every
      // pit-cost comparison is measured against. Set per car because it is a
      // property of this car's pace, not of the track. 0 = derive it from the
      // configured average lap for whatever condition the car is running.
      greenSpeedKmh: 0,
      maxStintMin: 65,
      pitLossSec: 55,
      driveThroughSec: 0, // event setting, mirrored here like the rest
      refuelLps: 2.5,
      refuelDeadSec: 0,
      pitEntryToPumpSec: 0,
      pumpToExitSec: 0,
      pumpToBoxSec: 0,
      boxToExitSec: 0,
      pitEntryToBoxSec: 0,
      minStopSec: 0,
      tyreChangeSec: 25,
      trackKm: 4.007,
      fcySpeedKmh: 60,
      scSpeedKmh: 0,
      s1EndKm: 1.3764,
      s2EndKm: 2.8646,
      s3EndKm: 0,
      pitInKm: 0,
      finishFuelL: 5,
      safetyFuelL: 3,
      fuelWarnL: 15, // low-fuel warning once this few liters remain above safety (0 = off)
      paceAvgLaps: PACE_WINDOW_DEFAULT // laps behind the pace card's rolling average
    },
    state: {
      stintStartMs: null,
      lapsThisStint: 0,
      totalLaps: 0,
      inPit: false,
      pitEnterMs: null,
      pitEnterFeed: false, // the entry stamp came from the feed, not from us
      // When the last pit visit was closed. The feed reports one visit from
      // three columns at once, and a car cannot re-enter the lane seconds
      // after leaving it — this is what keeps that one visit one visit.
      pitClosedMs: null,
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
      liveSeenMs: null,
      // ---- lap reconciliation across a feed outage --------------------------
      // The feed counts laps by event (a changed LAST cell), so laps run while
      // the link is down are simply never seen — and a reconnect rebuilds the
      // board from scratch, which is what keeps them from being replayed. The
      // lap NUMBER the feed publishes survives that, so it is kept here as the
      // anchor: `feedLaps` is the count last seen from the feed, `feedGap`
      // marks that the link has been interrupted since and owes a catch-up,
      // and `manualLaps` counts what the crew logged by hand in the meantime
      // so a lap can never be counted by both.
      feedLaps: null,
      feedGap: false,
      manualLaps: 0,
      // What the last reconciliation did: { laps, atMs } for laps recovered,
      // or { laps: 0, gap, atMs } when the discrepancy was too large to apply
      // blind and the crew has to answer it. A lap count that jumps must say
      // why it jumped.
      lapCatchUp: null,
      // The same anchor for STOPS. A pit visit that happens entirely inside a
      // feed outage is invisible to the events — but the board's own stop
      // counter carries on, so on reconnect it is ahead of the sheet by
      // exactly the stops nobody saw. When and how long they were cannot be
      // recovered, so they are never applied blind: `pitCatchUp` = { stops,
      // atMs } is the crew being told a stop is missing from the sheet.
      feedPits: null,
      pitCatchUp: null
    },
    nextStop: emptyStop(),
    // Which situation columns this car shows on the wall's grab list. The
    // code 60 column is up by default — the engineer takes it down when its
    // plan will never differ from the green one. The safety car column never
    // goes up (see wallShowsPlan).
    wallPlans: { green: true, fcy: true, sc: false },
    stintHistory: []
  };
}

// Label for the car pickers (start screen, station CONNECTION tab). The four
// entries are known by their race numbers — #15, #27, #40, #92 — so that is
// what the pickers say: the same identity the timing board and the pit wall
// cards use, with the team's own name appended once a car has been given one.
// A car whose number has been cleared falls back to the slot it connects as.
export function carPickLabel(id, car) {
  const nr = String(car?.number ?? '').trim();
  const head = nr ? `#${nr}` : `Car ${id}`;
  const name = String(car?.name || '').trim();
  if (name && name !== `Car #${nr}`) return `${head} — ${name}`;
  return head;
}

// Fuel the car should be sitting on when the race starts. A start figure of 0
// (or one over the tank) means "full tank", so a car that never touches the
// setting behaves exactly as it did before the setting existed.
export function startFuelOf(car) {
  const tank = Number(car?.config?.tankLiters) || 0;
  const start = Number(car?.config?.startFuelL) || 0;
  return start > 0 ? Math.min(start, tank) : tank;
}

// ---------------------------------------------------------------------------
// Car files
// ---------------------------------------------------------------------------
// Which settings belong to the CAR and which to the EVENT is the one thing
// everybody gets wrong in the settings pages: both are on screen, both look
// alike, and the difference only shows up when a number is changed on one
// station and silently ignored because the pit wall owns it. A car file is
// that line written down. It holds everything that IS this car — its fuel
// model, its pace, its wear figures, its drivers, its tyre and brake racks —
// and nothing that is the event (track length, pit lane, regulations: those
// are set once on the pit wall and mirrored into every car). Generate it once
// per car, keep it with the car, load it on any station or from the wall, and
// the car is set up in one action.
//
// The file is plain JSON, grouped and named the way the settings tabs are, so
// it can also be read — and filled in — in a text editor the week before the
// event by somebody who never opens the app.

export const CAR_FILE_KIND = 'pitwall-24h.car';
export const CAR_FILE_VERSION = 2; // v2 adds the tyre rack's compounds
export const CAR_FILE_EXT = 'pitcar.json';

// Printed into every file, so the thing explains itself when it is opened
// somewhere the app is not.
export const CAR_FILE_README =
  'PitWall 24H car file. Everything in here belongs to this one car and is applied to ' +
  'whichever car slot it is loaded into: car identity, fuel model, pace, wear figures, ' +
  'the driver table, the tyre rack (set numbers and which of them are wets), the ' +
  'brake rack with its kits, and how many tyre warmers the garage has. Event ' +
  'settings (track length, pit lane, ' +
  'refuelling rig, drive-time regulations) are deliberately NOT in this file — they are ' +
  'the same for every car and are set once on the pit wall. Values may be edited by hand; ' +
  'unknown fields are ignored and missing ones leave the car as it is. Loading never ' +
  'touches race data: laps, mileage, banked hours, seat time and the sets that have ' +
  'already run all stay.';

// The car's own config, grouped as the settings tabs group it. Every
// car-specific config key appears in exactly one group or in the racks below —
// the smoke test holds that true, so a setting added later cannot quietly fall
// out of the file.
export const CAR_FILE_GROUPS = [
  {
    key: 'fuel',
    label: 'Fuel',
    fields: ['fuelModel', 'tankLiters', 'startFuelL', 'burnPerLap',
      'finishFuelL', 'safetyFuelL', 'fuelWarnL']
  },
  {
    key: 'pace',
    label: 'Pace',
    fields: ['avgLapSec', 'greenSpeedKmh', 'paceAvgLaps']
  },
  {
    key: 'wear',
    label: 'Wear & pit',
    fields: ['tyreLifeKm', 'tyreLifeLaps', 'brakeLifeH', 'tyreChangeSec']
  },
  {
    key: 'caution',
    label: 'Neutralisation call',
    // What decides taking the Code 60 that is running over gambling on the next
    // one. They travel with the car: the two coefficients are the car's own
    // sensitivity to fuel and rubber, and the rate is how the crew reads the
    // event they are running.
    fields: ['cautionsPerHour', 'cautionMinutes', 'tyreDegSecPerKm', 'fuelWeightSecPerL',
      'pitSlackSec', 'pitLaneFuelL', 'flagRule']
  }
];

// Set counts are not loose numbers in a file: they travel with the names of
// the sets themselves, in tyreRack / brakeRack.
export const CAR_FILE_RACK_FIELDS = ['tyreSets', 'brakeSets', 'tyreWarmers'];

// Which driver fields describe the driver rather than what they have done.
// Seat time is race data and never travels in a file.
export const CAR_FILE_DRIVER_FIELDS = [
  'id', 'name', 'abbrev', 'timingName', 'doubleStint', 'night', 'rain',
  'fuelDry', 'fuelWet', 'fuelCurve'
];

// Every config key that belongs to the car and not to the event. Derived from
// the defaults, so the two lists can never drift apart.
export function carConfigFields() {
  return Object.keys(defaultCar('1', '1').config).filter(f => !EVENT_FIELDS.includes(f));
}

// A file name that says which car it is without being opened, and that sorts
// sensibly in a folder holding four of them.
export function carFileName(car) {
  const label = [car?.number ? '#' + car.number : '', car?.name || '']
    .map(s => String(s).trim()).filter(Boolean).join(' ');
  const slug = (label || 'car')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'car';
  return slug + '.' + CAR_FILE_EXT;
}

// Everything this car is, as a file. `savedMs` is passed in rather than read
// off the clock, so the same car always writes the same bytes in a test.
export function buildCarFile(car, { app = '', savedMs = Date.now() } = {}) {
  const cfg = car?.config || {};
  const file = {
    kind: CAR_FILE_KIND,
    version: CAR_FILE_VERSION,
    app: String(app || ''),
    savedMs,
    savedIso: new Date(savedMs).toISOString(),
    _readme: CAR_FILE_README,
    car: {
      name: String(car?.name ?? ''),
      number: String(car?.number ?? ''),
      make: String(car?.make ?? ''),
      model: String(car?.model ?? '')
    }
  };
  for (const g of CAR_FILE_GROUPS) {
    const out = {};
    for (const f of g.fields) {
      const v = cfg[f];
      out[f] = v && typeof v === 'object' ? { ...v } : v;
    }
    file[g.key] = out;
  }
  file.drivers = (car?.drivers || []).map(d => {
    const out = {};
    for (const f of CAR_FILE_DRIVER_FIELDS) {
      out[f] = f === 'fuelCurve' ? normalizeCurve(d?.fuelCurve) : d?.[f];
    }
    return out;
  });
  const tyres = car?.tyreSets || [];
  // Slicks and wets are two stocks sharing one rack, and which set is which is
  // written on the sticker, not decided by the race — so it travels with the
  // names. A file from before compounds existed carries none, and everything
  // in it is a slick, which is what those sets were.
  file.tyreRack = {
    count: tyres.length,
    names: tyres.map(t => String(t?.name ?? '')),
    compounds: tyres.map(t => tyreCompoundOf(t))
  };
  // The warmers are equipment, so how many there are and what they are called
  // travels with the car. What is in them right now is race data and does not.
  const warmers = car?.tyreWarmers || [];
  file.warmerRack = { count: warmers.length, names: warmers.map(w => String(w?.name ?? '')) };
  file.brakeRack = {};
  for (const b of BRAKE_COMPONENTS) {
    const sets = brakeSetsOf(car, b.id);
    file.brakeRack[b.id] = { count: sets.length, names: sets.map(t => String(t?.name ?? '')) };
  }
  // Which pads are bedded onto which discs travels with the rack, by the
  // numbers written on the parts — ids are this car's private business.
  file.brakeRack.kits = BRAKE_AXLES.flatMap(a => brakeKitsOf(car, a.id)
    .map(k => ({ axle: a.id, name: k.name, disc: k.disc.name, pad: k.pad.name })));
  return file;
}

// Is this a car file, and one this build understands? Text or object both go
// in — the renderer has a string off disk, the server has a parsed message.
// A file from a NEWER app still loads: unknown fields are ignored and the
// warning says so, which beats refusing a file that is 95% readable.
export function readCarFile(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      return { ok: false, error: 'that file is not JSON (' + e.message + ')' };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'that file does not contain a car setup' };
  }
  if (data.kind !== CAR_FILE_KIND) {
    return { ok: false, error: 'that is not a PitWall 24H car file (a race setup or a state backup, perhaps)' };
  }
  const version = Math.round(+data.version || 0);
  if (!(version >= 1)) return { ok: false, error: 'that car file has no version and cannot be read' };
  const warnings = [];
  if (version > CAR_FILE_VERSION) {
    warnings.push('written by a newer version of the app (file v' + version + ', this build reads v' +
      CAR_FILE_VERSION + ') — settings it does not know are ignored');
  }
  return { ok: true, file: data, warnings };
}

// Take a value out of a file in the shape of the default it replaces. A file
// is hand-editable, so "2,8", a true where a number belongs and a missing key
// are all normal input — none of them may corrupt a car.
function coerceSetting(def, v) {
  if (v === undefined || v === null) return undefined;
  if (typeof def === 'number') {
    const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
    return Number.isFinite(n) ? Math.max(0, n) : undefined;
  }
  if (typeof def === 'boolean') return !!v;
  if (typeof def === 'string') return typeof v === 'string' ? v : undefined;
  if (def && typeof def === 'object') {
    if (!v || typeof v !== 'object') return undefined;
    const out = { ...def };
    let any = false;
    for (const k of Object.keys(def)) {
      const sub = coerceSetting(def[k], v[k]);
      if (sub !== undefined) { out[k] = sub; any = true; }
    }
    return any ? out : undefined;
  }
  return undefined;
}

const FUEL_MODELS = ['driver-avg', 'driver-laptime'];

// A seat exactly as the app seeded it — "Driver 3", nothing typed, nothing
// banked, no flag touched. It carries no information about anybody.
function isPlaceholderDriver(d) {
  return /^Driver \d+$/.test(String(d?.name ?? '')) &&
    !(+d?.totalMs > 0) && !d?.abbrev && !d?.timingName &&
    !(+d?.fuelDry > 0) && !(+d?.fuelWet > 0) && !normalizeCurve(d?.fuelCurve).length &&
    d?.doubleStint !== false && d?.night !== false && d?.rain !== false;
}

// Load a file onto a car, in place. Only settings travel: laps, mileage,
// banked hours, seat time, the sets that have run and everything else the race
// has written stay exactly as they are — so a file can be loaded at 3 a.m. to
// correct a wrong tank size without costing the car its history.
export function applyCarFile(car, input, { identity = true } = {}) {
  const read = readCarFile(input);
  if (!read.ok) return { ok: false, error: read.error, applied: [], warnings: [] };
  const file = read.file;
  const warnings = [...read.warnings];
  const applied = [];
  const defCfg = defaultCar('1', '1').config;

  // Identity. The number is what live timing matches on and what heads the
  // car's column on the board, so a file that carries none must not blank it.
  if (identity && file.car && typeof file.car === 'object') {
    const nm = String(file.car.name ?? '').trim();
    const nr = String(file.car.number ?? '').trim();
    if (nr) car.number = nr;
    if (nm) car.name = nm;
    if (typeof file.car.make === 'string') car.make = file.car.make.trim();
    if (typeof file.car.model === 'string') car.model = file.car.model.trim();
    applied.push('car information');
  }

  // Config, group by group.
  car.config ??= { ...defCfg };
  for (const g of CAR_FILE_GROUPS) {
    const src = file[g.key];
    if (!src || typeof src !== 'object') continue;
    let hits = 0;
    for (const f of g.fields) {
      const v = coerceSetting(defCfg[f], src[f]);
      if (v === undefined) continue;
      car.config[f] = v;
      hits++;
    }
    if (hits) applied.push(g.label.toLowerCase());
  }
  // Files written while the low-fuel warning was set in laps: keep the same
  // warning point by pricing those laps at the car's dry burn. Same rule as
  // the state migration on the wall.
  if (file.fuel && typeof file.fuel === 'object' &&
      file.fuel.fuelWarnL === undefined && Number.isFinite(Number(file.fuel.fuelWarnLaps))) {
    car.config.fuelWarnL = Math.round(
      Number(file.fuel.fuelWarnLaps) * (car.config.burnPerLap?.dry || 2.8));
  }

  // The three a wrong file could make nonsense of.
  if (!FUEL_MODELS.includes(car.config.fuelModel)) car.config.fuelModel = 'driver-avg';
  if (!(car.config.tankLiters > 0)) car.config.tankLiters = defCfg.tankLiters;
  car.config.paceAvgLaps = Math.min(PACE_WINDOW_MAX,
    Math.max(PACE_WINDOW_MIN, Math.round(car.config.paceAvgLaps) || PACE_WINDOW_DEFAULT));

  // Drivers. The roster is positional — it is the seat, not the person: seat 1
  // keeps the seat time seat 1 has banked, so loading a file mid-race corrects
  // names and consumption figures without rewriting the race.
  //
  // A file only ever FILLS seats. The seats past the end of its list are not
  // in it, and what a file does not mention it leaves alone: the reserve who
  // joined on Friday is not struck off by the file written in October, and
  // seat time is never deleted by a settings file — removing a driver is the
  // driver table's job, with its own warning. The one seat that may go is one
  // still exactly as the app seeded it: it says nothing, and a phantom
  // "Driver 4" under a three-driver file is worse than no row.
  if (Array.isArray(file.drivers) && file.drivers.length) {
    const defDriver = defaultDriver(1);
    const had = Array.isArray(car.drivers) ? car.drivers : [];
    // An id is the seat's for life — stops and plans point at it. A seat the
    // car never had gets an id nobody on this car has ever carried: after a
    // remove and an add the ids are no longer 1..n, and "d5" for the fifth
    // seat could be the id the fourth already has, which would fold two
    // people into one everywhere a driver is looked up by id.
    const taken = new Set(had.map(d => d?.id).filter(Boolean));
    const seen = new Set();
    const freshId = () => {
      let n = 1;
      while (taken.has('d' + n)) n++;
      taken.add('d' + n);
      return 'd' + n;
    };
    const seatId = d => {
      let id = d?.id;
      if (!id || seen.has(id)) id = freshId();
      seen.add(id);
      return id;
    };
    const next = file.drivers.map((d, i) => {
      const base = had[i] || defaultDriver(i + 1);
      const out = { ...base };
      for (const f of CAR_FILE_DRIVER_FIELDS) {
        if (f === 'id') continue; // the seat keeps its id — stops and plans point at it
        if (f === 'fuelCurve') {
          if (Array.isArray(d?.fuelCurve)) out.fuelCurve = normalizeCurve(d.fuelCurve);
          continue;
        }
        const v = coerceSetting(defDriver[f], d?.[f]);
        if (v !== undefined) out[f] = v;
      }
      out.id = seatId(had[i]);
      out.totalMs = Math.max(0, +base.totalMs || 0);
      return out;
    });
    for (let i = file.drivers.length; i < had.length; i++) {
      const d = had[i];
      if (!d || (isPlaceholderDriver(d) && d.id !== car.currentDriverId)) continue;
      next.push({ ...d, id: seatId(d) });
    }
    car.drivers = next;
    if (!car.drivers.some(d => d.id === car.currentDriverId)) {
      car.currentDriverId = car.drivers[0].id;
    }
    applied.push('driver table');
  }

  // Racks. Only sets nobody has run are replaced — the set on the car, every
  // used set and every scrapped one survive with their mileage, exactly as
  // they do when the GENERATE SETS form is used.
  const rackNames = list => (Array.isArray(list) ? list : [])
    .map(n => String(n ?? '').trim())
    .filter(Boolean)
    .slice(0, SET_GEN_MAX);
  const tyreNames = rackNames(file.tyreRack?.names);
  if (tyreNames.length) {
    if ((file.tyreRack?.names || []).length > SET_GEN_MAX) {
      warnings.push('the file lists ' + file.tyreRack.names.length +
        ' tyre sets — only the first ' + SET_GEN_MAX + ' were taken');
    }
    const res = setTyreSetNames(car, tyreNames, { replaceUnused: true, skipExisting: true });
    car.tyreSets = res.sets;
    car.config.tyreSets = res.sets.length;
    // Compounds follow the name they were written next to, for the sets that
    // came out of the file and for the ones already on the rack under the same
    // name — the file is the crew's own note of which sets are the wets.
    const comps = Array.isArray(file.tyreRack.compounds) ? file.tyreRack.compounds : null;
    if (comps) {
      const byName = new Map();
      (file.tyreRack.names || []).forEach((n, i) => {
        const nm = String(n ?? '').trim();
        if (nm && !byName.has(nm)) byName.set(nm, comps[i] === 'wet' ? 'wet' : 'slick');
      });
      for (const t of car.tyreSets) {
        if (byName.has(t.name)) t.compound = byName.get(t.name);
      }
    }
    reconcileTyreSets(car);
    applied.push('tyre rack');
    // A name the file and the car share is the same physical set, so it stays
    // as it is. Only say so when that set carries mileage — on a fresh car the
    // placeholder it lands on is not news.
    const worn = res.sets.filter(t => res.duplicates.includes(t.name) && (t.km > 0 || t.laps > 0));
    if (worn.length) {
      warnings.push('sets the car has already run kept their mileage: ' +
        worn.map(t => t.name).join(', '));
    }
  }
  // Warmers. The file says how many boxes there are and what is written on
  // them; the rubber inside stays with whichever box survives the count.
  if (file.warmerRack && typeof file.warmerRack === 'object') {
    const names = rackNames(file.warmerRack.names);
    const count = Math.max(0, Math.min(TYRE_WARMER_MAX,
      Math.round(+file.warmerRack.count) || names.length));
    const had = car.tyreWarmers || [];
    car.tyreWarmers = Array.from({ length: count }, (_, i) => ({
      ...(had[i] || newTyreWarmer('w' + (i + 1), 'W' + (i + 1))),
      name: names[i] || had[i]?.name || 'W' + (i + 1)
    }));
    car.config.tyreWarmers = count;
    reconcileTyreWarmers(car);
    applied.push('tyre warmers');
  }
  let brakeHits = 0;
  for (const b of BRAKE_COMPONENTS) {
    const names = rackNames(file.brakeRack?.[b.id]?.names);
    if (!names.length) continue;
    const res = setBrakeSetNames(car, b.id, names, { replaceUnused: true, skipExisting: true });
    car.brakeSets ??= {};
    car.brakeSets[b.id] = res.sets;
    car.config.brakeSets ??= { ...DEFAULT_BRAKE_SET_COUNT };
    car.config.brakeSets[b.id] = res.sets.length;
    brakeHits++;
  }
  if (brakeHits) {
    reconcileBrakeSets(car);
    applied.push('brake rack');
    // Kits from the file are re-tied by part number. A file that names no kit
    // leaves the rack as reconcile married it up — never unlinked, since that
    // would silently break pairs the crew bedded in.
    const kits = Array.isArray(file.brakeRack?.kits) ? file.brakeRack.kits.slice(0, SET_GEN_MAX * 2) : [];
    const missed = [];
    for (const k of kits) {
      const a = brakeAxle(k?.axle);
      if (!a) continue;
      const disc = brakeSetsOf(car, a.discs).find(t => t.name === String(k.disc ?? '').trim());
      const pad = brakeSetsOf(car, a.pads).find(t => t.name === String(k.pad ?? '').trim());
      if (!disc || !pad) { missed.push(String(k.name || k.disc || '?')); continue; }
      linkBrakeKit(car, a.id, disc.id, pad.id, k.name);
    }
    if (missed.length) {
      warnings.push('kits the rack has no parts for were skipped: ' + missed.join(', '));
    }
    if (kits.length) reconcileBrakeKits(car);
  }

  return { ok: true, applied, warnings };
}

export function defaultState() {
  const cars = {};
  for (let i = 1; i <= 4; i++) cars[String(i)] = defaultCar(String(i), defaultCarNumber(String(i)));
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
//
// `driverId` is whose consumption to read: the driver in the car unless a
// caller is projecting a stint somebody else will drive.
export function burnDetail(car, cond = car.condition, pace = null, lapSec = null,
  driverId = car.currentDriverId) {
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
  const d = car.drivers.find(x => x.id === driverId);
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

// The pace card's own window: how many of the current driver's last laps the
// engineer wants averaged. Separate from LAP_AVG_WINDOW — that one feeds the
// fuel curve and is not the crew's to retune mid-race — but it starts at the
// same five laps, which is what a stint is normally read over.
export const PACE_WINDOW_DEFAULT = 5;
export const PACE_WINDOW_MIN = 1;
export const PACE_WINDOW_MAX = 30;

// A lap this far over the pace window's own average is not this driver's pace:
// an in or out lap, a lap behind a slower class, a full-course yellow, a spin.
// The card strikes those through and keeps them out of every figure it shows.
// 107% is the same margin the regulations use to separate a representative lap
// from one that was compromised, and it is tighter than the fuel model's 1.15
// on purpose: the fuel curve would rather average a scrappy lap than nothing.
export const PACE_OUTLIER_FACTOR = 1.07;

// How much further back than its own width the window may reach to replace
// struck laps — a five-lap average scans at most fifteen laps for five green
// ones, and settles for what it found rather than reading a stale stint.
export const PACE_WINDOW_REACH = 3;

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

// Where the running stint really began: never before the race did. A stint
// anchored ahead of the race start belongs to an earlier session — a state
// file carried over, or the clock re-anchored onto a session the old stint
// knew nothing about — and reading it raw is what turns a four hour race into
// a 154 hour seat time. Clamping is the honest reading: everything this race
// has seen of that stint happened after the flag.
export function stintStartOf(car, race) {
  const ms = car.state.stintStartMs;
  if (!ms) return null;
  return race?.startMs ? Math.max(ms, race.startMs) : ms;
}

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
  const raceStart = race?.startMs || 0;
  const addSpan = (id, from, to) => {
    const s = byDriver[id];
    // Seat time is time driven in THIS race; a span from a previous session
    // is not the driver's, however long the state file has been around.
    from = Math.max(from, raceStart);
    if (!s || !(to > from)) return;
    // Red-flag minutes are not seat time: the field stood still for them.
    s.totalMs += drivenMs(race, from, to);
    s.windowMs += drivenMs(race, Math.max(from, winStart), Math.min(to, now));
    if (s.lastEndMs == null || to > s.lastEndMs) s.lastEndMs = to;
  };
  for (const h of car.stintHistory) addSpan(h.driverId, h.startMs, h.endMs);
  if (clock.running && car.state.stintStartMs && byDriver[car.currentDriverId]) {
    addSpan(car.currentDriverId, stintStartOf(car, race), now);
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

  const stintStartMs = stintStartOf(car, race);
  // Seat time, not wall time: a red flag stops the field and the stint clock
  // with it. `stintHeld` is the UI's cue to say so, rather than leaving a
  // number that stopped moving to look like a stuck screen.
  const stintElapsedMs = clock.running && stintStartMs ? drivenMs(race, stintStartMs, now) : 0;
  const stintHeld = clock.running && !!stintStartMs && condition.id === 'red';

  // Fuel above the safety level is what strategy can actually spend; the
  // finish margin is what should still be on board at the flag.
  const safety = cfg.safetyFuelL || 0;
  const finishMargin = Math.max(cfg.finishFuelL || 0, safety);
  const usableFuel = Math.max(0, s.fuelLiters - safety);
  const lapsToEmpty = Math.floor(usableFuel / burn);
  const msToEmpty = lapsToEmpty * lapMs;
  // Unfloored twin of msToEmpty for countdowns: the tank drains continuously,
  // so a clock built on whole laps holds still and then jumps a lap at a time.
  const msToSafety = burn > 0 ? (usableFuel / burn) * lapMs : 0;

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
  // The same numbers read the way the crew works: per axle, under the name of
  // the kit that is on it. The axle is done when its first part is done.
  const brakeAxles = {};
  for (const a of BRAKE_AXLES) {
    const kit = currentBrakeKit(car, a.id);
    brakeAxles[a.id] = {
      axle: a.id,
      label: a.label,
      kit,
      name: kit?.name || '',
      discs: brakes[a.discs],
      pads: brakes[a.pads],
      leftH: Math.min(brakes[a.discs].leftH, brakes[a.pads].leftH),
      pct: Math.max(brakes[a.discs].pct, brakes[a.pads].pct)
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
    clock, stintStartMs, stintElapsedMs, stintHeld, burn, burnInfo, refLapSec, lapMs, fcyActive, condition,
    safety, finishMargin, usableFuel,
    lapsToEmpty, msToEmpty, msToSafety,
    tyreLifeLaps, tyreLapsLeft, msToTyres, tyreMileage, tyreKmRemaining,
    msDriverLeft,
    brakes, brakeAxles,
    limit, limits,
    reg,
    lapsRemainingRace, fuelToEnd, fullStintLaps,
    suggestedFuel
  };
}

// A full-tank stint for the driver the plan puts in for future stint `k`
// (0 = the stint after the one running), sized with that driver's own burn
// when they have one and the car's default when they do not — the same rule
// the live countdown follows. With no plan, or a plan row naming nobody the
// car has, the driver in the car now is assumed to carry on. Under a
// neutralisation every driver drains at the car's SC / FCY rate, exactly as
// carCalcs does for the running stint.
function futureStint(car, calcs, k) {
  const cfg = car.config;
  const row = car.plan?.stints?.[car.stintHistory.length + 1 + k];
  const driverId = row?.driverId && car.drivers.some(d => d.id === row.driverId)
    ? row.driverId : car.currentDriverId;
  // Only the driver in the car has a live lap time to read a curve at; anyone
  // else is read at the configured average, as the plan generator does.
  const lapSec = driverId === car.currentDriverId ? calcs.refLapSec : null;
  const burn = burnDetail(car, car.condition, calcs.condition.pace, lapSec, driverId).burn || calcs.burn;
  const laps = Math.floor(Math.max(0, cfg.tankLiters - calcs.safety) / burn);
  return { driverId, burn, laps, ms: Math.max(laps * calcs.lapMs, 10 * 60e3) };
}

// Stint blocks for the 24h timeline, in ms from the race start: past stints
// from history, the current stint projected to the limiting factor, then
// repeated full fuel stints until the end of the race — each sized for the
// driver the plan gives it. Between them the pit lane: a `lane` block from
// the entry to the release for every stop on the sheet (the stint's driving
// ends at the entry, not at the release), one growing towards NOW while the
// car is in the lane, and one the size of the pit-loss setting between the
// stints still to come. A red flag cuts whatever stint it fell in: the field
// stood still, so those minutes are a `red` block of their own and the stint
// resumes after it. Every block names its stint (`stint`), so a cut stint
// can still be labelled once.
export function projectStints(car, race, now) {
  const clock = raceClock(race, now);
  if (!clock.running) return [];
  const calcs = carCalcs(car, race, now);
  const start = race.startMs;
  const end = start + clock.totalMs;
  const reds = flagPeriods(race, now).filter(p => p.id === 'red');
  const blocks = [];

  // A driving block, cut into a red block wherever a red flag fell in it.
  const cut = b => {
    let from = b.from;
    for (const r of reds) {
      const a = Math.max(r.fromMs, from), z = Math.min(r.toMs, b.to);
      if (z <= a) continue;
      if (a > from) blocks.push({ ...b, from, to: a });
      blocks.push({ kind: 'red', from: a, to: z, stint: b.stint, open: r.open });
      from = z;
    }
    if (b.to > from) blocks.push({ ...b, from, to: b.to });
  };

  car.stintHistory.forEach((h, i) => {
    // What the visit took: the feed's lane time, else the planned figure the
    // sheet already prices an untimed stop at.
    const laneSec = h.pitSec != null ? h.pitSec : h.estStationarySec;
    const laneFrom = Math.max(h.startMs, h.endMs - (laneSec > 0 ? laneSec * 1000 : 0));
    cut({ from: h.startMs, to: laneFrom, kind: 'past', driverId: h.driverId, laps: h.laps ?? null, stint: i });
    blocks.push({
      kind: 'lane', from: laneFrom, to: h.endMs, stint: i, done: true,
      sec: laneSec > 0 ? laneSec : null,
      pitSec: h.pitSec ?? null, stationarySec: h.stationarySec ?? null,
      open: !!h.unplanned && !h.confirmed
    });
  });

  const s = car.state;
  if (s.stintStartMs) {
    const idx = car.stintHistory.length;
    const stopAt = Math.min(now + calcs.limit.ms, end);
    // Proposed laps for the running stint: laps banked plus what is left until
    // the limiting factor forces the stop (down to the safety level when fuel
    // is the limit). One figure for every piece of the stint on the timeline.
    const curLaps = s.lapsThisStint + Math.max(0, Math.round(calcs.limit.ms / calcs.lapMs));
    // In the lane right now: the driving ended at the entry, and the visit is
    // a block growing towards NOW until the release writes the stop.
    const laneFrom = s.inPit && s.pitEnterMs
      ? Math.min(Math.max(s.pitEnterMs, calcs.stintStartMs), now) : null;
    cut({ from: calcs.stintStartMs, to: laneFrom ?? now, kind: 'current', driverId: car.currentDriverId, laps: curLaps, stint: idx });
    if (laneFrom != null) {
      blocks.push({ kind: 'lane', from: laneFrom, to: now, stint: idx, done: false, live: true, sec: (now - laneFrom) / 1000 });
    }
    blocks.push({ from: now, to: stopAt, kind: 'projected', driverId: car.currentDriverId, laps: curLaps, stint: idx });

    // Future stints, fuel-limited full tanks at the planned driver's burn,
    // each behind a lane block the size of the pit loss. A stop with no stint
    // after it (the last one runs to the flag) is not drawn.
    const pitMs = (car.config.pitLossSec || 0) * 1000;
    let t = stopAt;
    let i = 0;
    while (t + pitMs < end && i < 60) {
      blocks.push({ kind: 'lane', from: t, to: t + pitMs, stint: idx + i, done: false, next: i === 0 });
      t += pitMs;
      const st = futureStint(car, calcs, i);
      const to = Math.min(t + st.ms, end);
      // The last stint is cut by the flag — show the laps it actually holds.
      blocks.push({ from: t, to, kind: 'future', driverId: null, stint: idx + i + 1,
        laps: Math.min(st.laps, Math.round((to - t) / calcs.lapMs)) });
      t = to;
      i++;
    }
  }
  return blocks.map(b => ({ ...b, from: b.from - start, to: b.to - start }));
}

// Projected pit stop times for one car, as absolute wall-clock ms: the end of
// the current stint (whatever runs out first), then repeated full stints to
// the end of the race, each as long as its planned driver's tank lasts. The
// first entry carries the limiting factor.
export function projectedStops(car, race, now, horizonMs = Infinity) {
  const clock = raceClock(race, now);
  if (!clock.running || !car.state.stintStartMs) return [];
  const calcs = carCalcs(car, race, now);
  const end = race.startMs + clock.totalMs;
  const stops = [];
  let t = now + calcs.limit.ms;
  let i = 0;
  while (t < end && t <= now + horizonMs && i < 60) {
    stops.push({ atMs: t, limit: i === 0 ? calcs.limit.key : 'fuel' });
    t += (car.config.pitLossSec || 0) * 1000 + futureStint(car, calcs, i).ms;
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

// ---------------------------------------------------------------------------
// Speeds — the yardsticks every pit-cost comparison is measured against
// ---------------------------------------------------------------------------
// The car's average speed under green (km/h). The configured figure wins; with
// none set it is derived from the average lap for the condition the car is
// running, so a car left untuned still gets a sane number.
export function greenSpeedKmh(car, cond = car.condition) {
  const cfg = car.config;
  if (cfg.greenSpeedKmh > 0) return cfg.greenSpeedKmh;
  const lapSec = cfg.avgLapSec?.[cond === 'wet' ? 'wet' : 'dry'] || 0;
  const trackKm = cfg.trackKm || 0;
  return lapSec > 0 && trackKm > 0 ? (trackKm / lapSec) * 3600 : 0;
}

// The speed the FIELD circulates at under a neutralisation (km/h). Code 60 /
// FCY is a regulated speed and is read as one; the Safety Car train has its own
// event setting, falling back to the car's SC lap time when it is not set.
// Returns 0 under green — nothing is neutralised, so there is no discount.
export function neutralSpeedKmh(car, pace) {
  const cfg = car.config;
  if (pace === 'fcy') return cfg.fcySpeedKmh || 0;
  if (pace !== 'sc') return 0;
  if (cfg.scSpeedKmh > 0) return cfg.scSpeedKmh;
  const trackKm = cfg.trackKm || 0;
  const lapSec = cfg.avgLapSec?.sc || 0;
  return lapSec > 0 && trackKm > 0 ? (trackKm / lapSec) * 3600 : 0;
}

// The pit lane as the legs a stop actually drives, all at the speed limit.
// Three measured figures are enough — the other two derive from them, so the
// engineer times entry→rig, rig→box and box→exit and the rest follows:
//
//   entry ──entryToPump──► RIG ──pumpToBox──► BOX ──boxToExit──► exit
//         └────────────── pumpToExit (rejoin from the rig) ─────┘
//         └────── entryToBox (straight past the rig, no fuel) ──┘
//
export function pitSegments(cfg) {
  const entryToPump = Math.max(0, cfg.pitEntryToPumpSec || 0);
  const pumpToBox = Math.max(0, cfg.pumpToBoxSec || 0);
  const driveThrough = Math.max(0, cfg.driveThroughSec || 0);
  // Every leg falls back to "whatever is left of the through-lane", so that a
  // lane with nothing measured still costs one full drive-through however the
  // stop is shaped. Deriving only some of them would make a tyre change look
  // like it SHORTENS the lane, which is how the marginal cost of box work went
  // to nearly zero on an unconfigured event.
  const boxToExit = cfg.boxToExitSec > 0
    ? cfg.boxToExitSec
    : Math.max(0, driveThrough - entryToPump - pumpToBox);
  // Rejoining from the rig: whatever is left of the through-lane after the
  // entry leg, unless it is measured separately (a rig off the through-path).
  const pumpToExit = cfg.pumpToExitSec > 0
    ? cfg.pumpToExitSec
    : Math.max(0, driveThrough - entryToPump);
  // A stop with no fuel still drives past the rig to reach the box.
  const entryToBox = cfg.pitEntryToBoxSec > 0
    ? cfg.pitEntryToBoxSec
    : entryToPump + pumpToBox;
  return { entryToPump, pumpToExit, pumpToBox, boxToExit, entryToBox, driveThrough };
}

// Seconds the rig is connected for a given fill: the flow itself plus the
// coupling dead time, which costs the same whether the splash is 5 L or 70 L.
// No liters, no rig, no dead time.
export function refuelTimeSec(cfg, addLiters) {
  if (!(addLiters > 0)) return 0;
  return addLiters / (cfg.refuelLps || 2.5) + Math.max(0, cfg.refuelDeadSec || 0);
}

// How long a stop occupies the pit lane, pit-in line to pit-out line: the legs
// it drives plus the work done standing still. The shape follows what is being
// done — a fuel-only stop rejoins from the rig, anything more carries on to the
// box — and a series minimum stop time is a floor on the whole visit.
//
// With no segments configured this is just the stationary work, which is what
// the app assumed before the lane was broken into legs.
export function pitLaneTimeSec(cfg, { refuelSec = 0, boxWorkSec = 0 } = {}) {
  const seg = pitSegments(cfg);
  const fuel = refuelSec > 0;
  const work = boxWorkSec > 0;
  let driveSec;
  if (fuel && work) driveSec = seg.entryToPump + seg.pumpToBox + seg.boxToExit;
  else if (fuel) driveSec = seg.entryToPump + seg.pumpToExit;
  else if (work) driveSec = seg.entryToBox + seg.boxToExit;
  else driveSec = seg.driveThrough;
  const workSec = refuelSec + boxWorkSec;
  const rawSec = driveSec + workSec;
  const minSec = Math.max(0, cfg.minStopSec || 0);
  return {
    driveSec, workSec, rawSec,
    // A minimum stop time makes everything under the floor free: the visit
    // takes the same time whether the crew stands idle or changes four tyres.
    heldSec: Math.max(0, minSec - rawSec),
    totalSec: Math.max(rawSec, minSec)
  };
}

// ---------------------------------------------------------------------------
// What a stop costs, and what a neutralisation discounts it by
// ---------------------------------------------------------------------------
// Measure against a rival who stays out. Over a pit visit of T seconds we cover
// the pit lane — a fixed distance d, whatever is flying — while the rival covers
// v × T of track at the field's speed v. Our track-position deficit is
// (v × T − d), and in green-equivalent seconds (distance is the invariant; the
// flag falls under green) that is (v × T − d) / vGreen. So:
//
//   lossGreen   = (vG × T − d) / vG
//   lossNeutral = (vN × T − d) / vG
//   gain        = lossGreen − lossNeutral = T × (1 − vN / vG)
//
// The lane distance cancels: the discount is simply the time spent in the lane
// scaled by how much slower the field is going. Every second in there is
// discounted equally, which is why a neutralisation is when to change tyres and
// swap drivers as well as refuel.
//
// One term sits outside T: braking off the racing line into the lane and
// rebuilding speed on exit. Under green that costs the slice of the configured
// pit loss the lane transit does not explain; at Code 60 the car is already at
// the limit, so it costs nothing. It scales with how far the field's speed sits
// above the pit lane limit.
//
// `pace` is null for green (gain 0), 'fcy' or 'sc' otherwise.
export function pitCostSec(car, pace, { refuelSec = 0, boxWorkSec = 0 } = {}) {
  const cfg = car.config;
  const vG = greenSpeedKmh(car);
  const lane = pitLaneTimeSec(cfg, { refuelSec, boxWorkSec });
  const T = lane.totalSec;
  const laneSec = (cfg.pitLaneKm || 0) > 0 && vG > 0
    ? ((cfg.pitLaneKm || 0) / vG) * 3600 // time the bypassed track would take at green pace
    : 0;

  // Entry/exit overhead: the part of the measured green pit loss that driving
  // the lane at the limit does not account for. Falls out of the figures the
  // engineer already enters, so it is never guessed at. The measured
  // drive-through wins over the one derived from lane length and speed limit.
  const derivedThrough = (cfg.pitLaneKm || 0) > 0 && (cfg.pitSpeedKmh || 0) > 0
    ? ((cfg.pitLaneKm || 0) / (cfg.pitSpeedKmh || 0)) * 3600
    : 0;
  const throughSec = (cfg.driveThroughSec || 0) > 0 ? cfg.driveThroughSec : derivedThrough;
  const deltaGreen = Math.max(0, (cfg.pitLossSec || 0) - Math.max(0, throughSec - laneSec));

  const lossGreen = T - laneSec + deltaGreen;
  const vN = neutralSpeedKmh(car, pace);
  if (!(vG > 0) || !(vN > 0) || vN >= vG) {
    return {
      pace: pace || null, vG, vN, T, lane,
      lossGreen, lossNeutral: lossGreen, gainSec: 0, deltaGreen, deltaNeutral: deltaGreen
    };
  }

  const vP = cfg.pitSpeedKmh || 0;
  // Already at (or below) the pit limit means no braking penalty at all.
  const span = vG - vP;
  const ratio = span > 0 ? Math.min(1, Math.max(0, (vN - vP) / span)) : 1;
  const deltaNeutral = deltaGreen * ratio;

  const lossNeutral = (vN * T) / vG - laneSec + deltaNeutral;
  return {
    pace: pace || null, vG, vN, T, lane,
    lossGreen, lossNeutral,
    gainSec: Math.max(0, lossGreen - lossNeutral),
    deltaGreen, deltaNeutral
  };
}

// Estimated stationary time for a planned stop, in seconds. The stop's fuel
// figure is the level to leave with, so liters added = target − on board
// (the on-board level freezes when the car enters the pit lane). Refuelling
// happens at the rig and tyre work at the box, so the two are sequential and
// the lane legs between them are counted too (see pitLaneTimeSec).
export function stopServiceTime(car, stop = car.nextStop) {
  const cfg = car.config;
  const target = Number(stop.fuelLiters) || 0;
  const addLiters = target > 0 ? Math.max(0, target - (car.state?.fuelLiters || 0)) : 0;
  const refuelSec = refuelTimeSec(cfg, addLiters);
  const tyreSec = stop.tyres ? (cfg.tyreChangeSec || 0) : 0;
  const lane = pitLaneTimeSec(cfg, { refuelSec, boxWorkSec: tyreSec });
  return {
    addLiters, refuelSec, tyreSec,
    // Time in the lane driving between the legs this stop uses, and time the
    // series minimum holds the car beyond the work it actually did.
    laneSec: lane.driveSec, heldSec: lane.heldSec,
    totalSec: lane.totalSec
  };
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
//   'unplanned'    — long enough to be a stop, but nothing was planned. The
//                    VISIT is still logged — it happened, and a sheet that
//                    quietly skips it shows one endless stint — but no service
//                    is applied with it: the fuel, the rubber and the seat stay
//                    as they were until the engineer says what was done.
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
  // A full tank's worth of fuel is the reference stop when nothing better is
  // known — this is the fallback panel, shown before a fuel projection exists.
  const refuelSec = refuelTimeSec(cfg, cfg.tankLiters || 0);
  const cost = pitCostSec(car, 'fcy', { refuelSec });
  return {
    cond,
    greenLapSec,
    greenSpeedKmh: greenSpeedKmh(car),
    fcyLapSec,
    // Per-lap time every car in the field drops under FCY. It is what the
    // neutralisation does to the race, NOT what pitting under it gains — the
    // field loses it whether it stops or not. Kept for display only.
    fcyLapDeltaSec: fcyLapSec - greenLapSec,
    // What the stop is actually discounted by, and what it nets out at.
    gainSec: cost.gainSec,
    stopSec: cost.T,
    netPitLossSec: cost.lossGreen - cost.gainSec
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
        // No sector time has completed yet: that is the lap clock talking, not
        // a sector fix. Leave it to the lap-clock source below — same position,
        // but the card then says which one it really is.
        if (n > 0 && (!cross || us > cross.us)) cross = { mm: norm(sectorEndMm(n)), us };
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
// Pit order: which of our cars reaches the box first
// ---------------------------------------------------------------------------
// One crew, four cars. The moment something happens — a flag drops, or a stop
// goes live — the question in the box stops being "is this car coming in" and
// becomes "which one do we take first". That answer is already in pitEta: the
// car with the shortest run left to the box is the car the crew sees first.
// Nothing new is measured here; the arrivals are simply put in order.
//
// A car joins the queue on exactly the terms its E.T.A. is shown on — it is in
// the pit lane, its stop is live (sent / box), or the race is neutralised and
// the E.T.A. therefore answers the crew's question. A car already in the lane
// is at the front by definition, and two of them keep the order they entered
// in. Cars with no usable position (no feed, no crossing yet) are left out: an
// order that guesses where a car is would be worse than no order at all.
//
// `etaOf(car)` hands over that car's pitEta (null when there is none), so the
// estimate is computed once per car and read here rather than made twice.
// Returns [] for fewer than two cars — a queue of one is not an order.
export function pitArrivalOrder(cars, etaOf, now = Date.now()) {
  const queue = [];
  for (const car of cars) {
    if (car.state.inPit) {
      // Negative seconds: already there, and the longest-standing car first.
      const waited = car.state.pitEnterMs ? (now - car.state.pitEnterMs) / 1000 : 0;
      queue.push({ carId: car.id, sec: -1 - waited, inPit: true, stale: false, eta: null });
      continue;
    }
    // The same gate the E.T.A. line uses: only under a neutralisation, or once
    // this car's stop is on its way to the crew.
    const eta = etaOf(car);
    if (!eta || !(eta.neutral || car.nextStop.status !== 'draft')) continue;
    queue.push({
      carId: car.id,
      sec: eta.etaBoxSec != null ? eta.etaBoxSec : eta.etaEntrySec,
      inPit: false,
      stale: eta.stale,
      eta
    });
  }
  if (queue.length < 2) return [];
  queue.sort((a, b) => a.sec - b.sec || String(a.carId).localeCompare(String(b.carId)));
  return queue.map((q, i) => ({ ...q, pos: i + 1, of: queue.length }));
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

  // Level to leave with when pitting now: full tank while more stops follow,
  // else just enough to finish plus one green lap in hand.
  const fillTargetL = Math.min(tank, Math.ceil(fuelToEnd + greenBurn));
  // FUEL ONLY: the rig time this stop would actually take. Box work is priced
  // separately by recommendedStop — the fuel window must answer the fuel
  // question on its own.
  const refuelNowSec = refuelTimeSec(cfg, Math.max(0, fillTargetL - fuelNow));

  // Time discount on a stop taken under the current neutralisation: the pit
  // visit costs the same seconds either way, but while the field crawls those
  // seconds buy the rivals far less track. See pitCostSec.
  const pace = calcs.condition.pace;
  const cost = pitCostSec(car, pace, { refuelSec: refuelNowSec });
  const gainSec = cost.gainSec;

  // The standing instruction for a flag that has not flown yet: how many liters
  // the car must need before a closed-window stop under each neutralisation
  // pays for the extra stop it buys. Fixed per track and pace, so both are
  // worked out whatever is flying right now — under green this is what tells
  // the crew in advance whether the next Code 60 is theirs to take.
  const breakEven = { fcy: fuelBreakEven(car, 'fcy'), sc: fuelBreakEven(car, 'sc') };

  // Low-fuel warning thresholds. The threshold is liters, because liters is
  // what the crew reads off the rig and types into CORRECT FUEL READING — a
  // lap figure moves under the car whenever the burn rate does. litersLeft
  // counts fuel above the SAFETY level, so "0 L" still leaves the reserve.
  // Amber at the configured level, red at half of it. fuelWarnL = 0 disables.
  const warnL = cfg.fuelWarnL ?? 15;
  const litersLeft = calcs.usableFuel;
  const lapsLeft = calcs.lapsToEmpty;
  const warn = {
    litersLeft,
    lapsLeft,
    msLeft: calcs.msToSafety,
    warnL,
    level: warnL > 0 && litersLeft <= warnL / 2 ? 'crit'
      : warnL > 0 && litersLeft <= warnL ? 'warn' : 'ok'
  };

  if (addNeededL <= EPS) {
    // The tank already reaches the flag with the finish margin on board.
    return {
      noStopNeeded: true, windowOpen: false, verdict: 'noStop',
      fuelToEnd, addNeededL: 0, stopsMin: 0, stopsIfNow: 1,
      lapsToWindow: null, msToWindow: null, windowLapsLeft: null, windowMsLeft: null,
      fillTargetL: null, remainingPitTimeSec: 0,
      gainSec, stopSec: cost.T, lossGreenSec: cost.lossGreen,
      extraStopSec: pitLossSec, netPitNowSec: pitLossSec - gainSec,
      breakEven, breakEvenMet: { fcy: false, sc: false },
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
    // Fewest seconds the rest of the race must spend on fuel stops: one pit
    // loss per stop, the liters that have to go in, and the rig dead time each
    // of those stops pays for coupling up.
    remainingPitTimeSec: stopsMin * (pitLossSec + Math.max(0, cfg.refuelDeadSec || 0))
      + addNeededL / refuelLps,
    gainSec,
    // How long this fuel-only stop occupies the lane, and what it costs under
    // green — the two figures the discount is built from.
    stopSec: cost.T,
    lossGreenSec: cost.lossGreen,
    // The pre-armed call: the fixed litre threshold per neutralisation, and
    // whether the fill this stop would take already clears it. With the window
    // open the threshold does not apply — the stop is free money either way.
    breakEven,
    breakEvenMet: {
      fcy: windowOpen || breakEvenMet(breakEven.fcy, fillTargetL - fuelNow),
      sc: windowOpen || breakEvenMet(breakEven.sc, fillTargetL - fuelNow)
    },
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
// pace. The discount is the time the stop occupies the pit lane scaled by how
// much slower the field is going, so it depends on what the stop actually does
// — see pitCostSec. `work` is the seconds of box work on top of the fuel.
export function neutralGainSec(car, pace, { refuelSec = 0, boxWorkSec = 0 } = {}) {
  if (pace !== 'sc' && pace !== 'fcy') return 0;
  return pitCostSec(car, pace, { refuelSec, boxWorkSec }).gainSec;
}

// ---------------------------------------------------------------------------
// The break-even fill: the one number the flag call turns on
// ---------------------------------------------------------------------------
// When the fuel window is already open, boxing under a neutralisation always
// wins — the stop was going to be made anyway and the discount is free money.
// The call that needs deciding is the other one: the window is CLOSED, so
// boxing now buys an extra stop later, and it is only worth it if the discount
// covers that whole extra pit loss.
//
//   gain     = T × k + (δgreen − δneutral),  k = 1 − vNeutral / vGreen
//   T        = laneDrive + refuelSec         (floored by any minimum stop time)
//   worth it ⟺ gain ≥ pitLoss
//   ⟺ refuelSec ≥ (pitLoss − Δδ) / k − laneDrive
//
// Nothing on the right-hand side moves during a race: it is all track geometry,
// pit-lane figures and two speeds. So the answer is a FIXED litre figure — take
// on at least this much and a stop under this neutralisation pays for itself,
// whatever lap it is and whatever the tank happens to read. That is what makes
// it usable as a standing instruction: "under Code 60 with a closed window, box
// only if we need 34 L or more."
//
// Does a fill of `addL` liters clear the threshold? 'always' clears on any
// stop, 'never' on none, otherwise it is the straight comparison.
export function breakEvenMet(be, addL) {
  if (!be) return false;
  if (be.rule === 'always') return true;
  if (be.rule === 'never') return false;
  return addL >= be.litersL;
}

// Returns null when the speeds are not known well enough to answer.
export function fuelBreakEven(car, pace) {
  const cfg = car.config;
  if (pace !== 'sc' && pace !== 'fcy') return null;
  const vG = greenSpeedKmh(car);
  const vN = neutralSpeedKmh(car, pace);
  if (!(vG > 0) || !(vN > 0) || vN >= vG) return null;

  const k = 1 - vN / vG;
  const pitLoss = cfg.pitLossSec || 0;
  const tank = cfg.tankLiters || 0;
  const lps = cfg.refuelLps || 2.5;
  const dead = Math.max(0, cfg.refuelDeadSec || 0);
  const seg = pitSegments(cfg);
  const laneDrive = seg.entryToPump + seg.pumpToExit;

  // The entry/exit overhead is the same on both sides of the comparison except
  // for how much of it the neutralisation cancels — price it through pitCostSec
  // so this never drifts from the model the verdict actually uses.
  const probe = pitCostSec(car, pace, { refuelSec: 0 });
  const deltaGain = probe.deltaGreen - probe.deltaNeutral;

  // Seconds in the lane the stop has to reach for the discount to cover an
  // extra pit loss, then the rig time and liters that get it there.
  const needSec = (pitLoss - deltaGain) / k;
  const needRigSec = needSec - laneDrive;
  const minStop = Math.max(0, cfg.minStopSec || 0);

  // A series minimum stop time is lane time the car spends anyway, so it counts
  // towards the threshold before a single litre goes in.
  const freeSec = Math.max(0, minStop - (laneDrive + dead));
  const litersRaw = (needRigSec - dead - freeSec) * lps;
  const liters = Math.max(0, litersRaw);

  return {
    pace, vG, vN,
    // Fraction of every pit-lane second the neutralisation hands back.
    discount: k,
    // Liters that must be needed before a closed-window stop pays for itself.
    litersL: liters,
    rigSec: Math.max(0, needRigSec),
    // Standing instruction shortcuts:
    //   'always' — even a splash pays (the lane time alone covers the loss)
    //   'never'  — the tank cannot hold enough to ever cover it
    //   'above'  — box when the fill needed is at or above litersL
    rule: litersRaw <= 0 ? 'always' : liters > tank ? 'never' : 'above',
    tankL: tank
  };
}

// ---------------------------------------------------------------------------
// Taking THIS caution, or waiting for the next one
// ---------------------------------------------------------------------------
// fuelBreakEven above answers "is the fill big enough to pay for the extra stop
// this buys" — a litre threshold off track geometry. It cannot answer the other
// half of the question: if we do not take this one, how likely is another before
// fuel forces us in at full green cost? That depends on how often cautions
// actually fall at this event, which is a measured number (Zolder 2019-2025:
// 0.639 usable Code 60 per hour) and the one input none of the maths above has.
//
// Cautions are treated as a Poisson process — they arrive independently at an
// average rate, so the chance of at least one inside a window of t hours is
// 1 - exp(-rate*t). That assumes a flat rate: no clustering, no night effect.
// probabilityOfCautionWithin is the single place to change if that stops being
// good enough.
//
// The answer is a BREAK-EVEN RATE: how frequent cautions would have to be
// before staying out beats taking the one that is running. Compare it against
// the event's real rate and the call falls out. It is deliberately not a
// function of how long the race has left — see the cycle averaging below.

const CAUTION_SIM_HOURS = 12;
const CAUTION_MAX_RATE = 5; // above this, waiting never pays — do not search further

export function probabilityOfCautionWithin(ratePerHour, windowSec) {
  if (!(ratePerHour > 0) || !(windowSec > 0)) return 0;
  return 1 - Math.exp(-ratePerHour * (windowSec / 3600));
}

// The four things that can be done at a stop under caution. Only the decision
// stop varies; every stop after it fills and fits tyres, which is the standing
// best call once the flag is gone.
const CAUTION_PLANS = [
  { key: 'stay', fuel: false, tyres: false, label: 'Stay out' },
  { key: 'fuel', fuel: true, tyres: false, label: 'Fuel only' },
  { key: 'tyres', fuel: false, tyres: true, label: 'Tyres only' },
  { key: 'both', fuel: true, tyres: true, label: 'Fuel + tyres' }
];

// Where the car is on the lap when the flag drops, as the share of a lap it
// still has to run before it reaches pit entry. A caution can fall anywhere,
// so with no position to go on the expectation is half a lap — and that half
// lap is what eats into the credit, because the discount only accrues while
// the field is still crawling when the car finally gets there.
const ENTRY_LAP_SHARE = 0.5;

// Everything the four simulations share: the car's own state and pace, and the
// shape of the neutralisation they are all being asked about. Built once so a
// sweep across a whole stint can vary fuel and rubber without rebuilding the
// figures that do not move.
function cautionAnchor(car, race, now, pace, calcs, base) {
  const cfg = car.config;
  const trackKm = base.trackKm;
  const laneKm = Math.max(0, Math.min(cfg.pitLaneKm || 0, trackKm));
  // A caution the crew has not measured still has to be something: fall back
  // to the Zolder median rather than to zero, which would say every flag is
  // over before the car reaches the lane.
  const cautionMin = cfg.cautionMinutes > 0 ? cfg.cautionMinutes : 7.1;
  const cautionBurn = (cfg.burnPerLap && cfg.burnPerLap[pace]) || base.burnPerLap;
  return {
    ...base,
    safety: cfg.safetyFuelL || 0,
    tyreLifeKm: cfg.tyreLifeKm || 0,
    cautionBurn,
    cautionEndSec: cautionMin * 60,
    vNeutralKmS: (neutralSpeedKmh(car, pace) || 0) / 3600,
    laneKm,
    slackSec: Math.max(0, cfg.pitSlackSec || 0),
    // Fuel burnt driving the lane itself. Derived from the neutralised burn
    // across the lane's share of a lap unless the crew has measured it, which
    // is right unless the lane is unusually long or short for the circuit.
    laneFuelL: cfg.pitLaneFuelL > 0
      ? cfg.pitLaneFuelL
      : (trackKm > 0 ? cautionBurn * (laneKm / trackKm) : 0)
  };
}

// One plan rolled forward far enough to cover many stint cycles. Returns the
// elapsed time at the end of each lap, plus which laps carried a stop.
function simulateCautionPlan(car, pace, plan, ratePerHour, anchor) {
  const cfg = car.config;
  const { refLapSec, fuel0, tyreKm0, trackKm, tank, safety, tyreLifeKm, burnPerLap,
    cautionEndSec, vNeutralKmS, laneKm, slackSec, laneFuelL, cautionBurn } = anchor;
  // Lap time relative to the car's own reference lap, so this can never drift
  // from the pace the car is actually running.
  const lapSec = (fuelL, tyreKm) => refLapSec
    + (cfg.fuelWeightSecPerL || 0) * (fuelL - fuel0)
    + (cfg.tyreDegSecPerKm || 0) * (tyreKm - tyreKm0);

  // Time to cover a distance starting at t0, with the neutralisation ending
  // part-way through it. This is what makes the caution a PERIOD rather than a
  // single slow lap: a long one keeps the whole field crawling for several
  // laps, a short one is over before the car has finished the one it is on.
  const coverSec = (distKm, t0, fuelL, tyreKm) => {
    const vGreen = trackKm / lapSec(fuelL, tyreKm); // km per second
    if (!(cautionEndSec > t0) || !(vNeutralKmS > 0)) return distKm / vGreen;
    const under = vNeutralKmS * (cautionEndSec - t0);
    if (under >= distKm) return distKm / vNeutralKmS;
    return (cautionEndSec - t0) + (distKm - under) / vGreen;
  };

  // Share of a lap starting at t0 that is run neutralised. Fuel blends on it:
  // a crawling car burns far less than a racing one, so billing a neutralised
  // lap at the green rate would have it drink more, not less.
  const shareOfLap = t0 => {
    if (!(cautionEndSec > t0) || !(vNeutralKmS > 0)) return 0;
    return Math.min(1, vNeutralKmS * (cautionEndSec - t0) / trackKm);
  };

  // What a stop costs when the neutralisation still has `leftSec` to run. The
  // credit is earned second by second while the field crawls, so a flag that
  // goes green with the hose still connected pays for part of the stop and no
  // more — and one that has already gone green pays for none of it.
  const stopLossSec = (refuelSec, boxWorkSec, leftSec) => {
    const c = pitCostSec(car, pace, { refuelSec, boxWorkSec: boxWorkSec + slackSec });
    if (!(c.T > 0) || !(leftSec > 0)) return c.lossGreen;
    const perSec = c.vG > 0 && c.vN > 0 ? 1 - c.vN / c.vG : 0;
    // Braking off the racing line is discounted in full or not at all: it is
    // paid once, at pit entry, and the flag is either out then or it is not.
    const gain = perSec * Math.min(c.T, leftSec) + (c.deltaGreen - c.deltaNeutral);
    return c.lossGreen - Math.max(0, gain);
  };

  const expectedStopSec = (windowSec, refuelSec, boxWorkSec) => {
    // A stop taken at a caution that falls later is timed to the flag, so the
    // whole neutralisation is there to be used — unlike this one, which has
    // already been running for as long as it took to reach pit entry.
    const neutral = stopLossSec(refuelSec, boxWorkSec, cautionEndSec);
    const green = stopLossSec(refuelSec, boxWorkSec, 0);
    const p = probabilityOfCautionWithin(ratePerHour, windowSec);
    return p * neutral + (1 - p) * green;
  };

  let fuel = fuel0;
  let tyreKm = tyreKm0;
  let t = 0;
  const laps = [];

  // Lap 0 — the decision lap: the flag is out and this plan says what to do
  // about it. Every plan drives the same lap; the ones that stop pay the loss
  // on top of it, discounted by whatever is left of the caution when the car
  // reaches pit entry.
  const onTrackShare = trackKm > 0 ? Math.max(0, 1 - laneKm / trackKm) : 1;
  const lapFuel0 = shareOfLap(0) * cautionBurn + (1 - shareOfLap(0)) * burnPerLap;
  const drive0 = coverSec(trackKm, 0, fuel, tyreKm);
  if (plan.fuel || plan.tyres) {
    const addL = plan.fuel ? Math.max(0, tank - fuel) : 0;
    const toEntrySec = coverSec(ENTRY_LAP_SHARE * trackKm, 0, fuel, tyreKm);
    t += drive0 + stopLossSec(
      plan.fuel ? refuelTimeSec(cfg, addL) : 0,
      plan.tyres ? (cfg.tyreChangeSec || 0) : 0,
      Math.max(0, cautionEndSec - toEntrySec));
    if (plan.fuel) fuel = tank; else fuel -= onTrackShare * lapFuel0 + laneFuelL;
    // Binning a set with life still in it is free while there is spare rubber
    // in the garage, and expensive once there is not: on a fixed allocation the
    // discarded kilometres come straight off the distance the car can still
    // cover on fresh tyres, and buying them back means another set it does not
    // have. Priced as the fraction of a set thrown away, valued at one stop —
    // which is what running out actually costs.
    if (plan.tyres) {
      if (anchor.scarcity > 0 && tyreKm > 0) {
        const wasted = Math.max(0, anchor.tyreLifeKm - tyreKm);
        t += (wasted / anchor.tyreLifeKm) * anchor.scarcity;
      }
      tyreKm = 0;
    }
  } else {
    t += drive0;
    fuel -= lapFuel0;
  }
  tyreKm += trackKm;
  laps.push({ t, stop: plan.fuel || plan.tyres });

  // Everything after runs on until fuel or rubber runs out — under whatever is
  // left of the neutralisation first, then green. Those later stops are priced
  // as an EXPECTED value: a caution may well be running by the time they come
  // due, and how likely that is is the thing being tested.
  let lastStopT = laps[0].stop ? t : 0;
  const horizon = CAUTION_SIM_HOURS * 3600;
  let guard = 0;
  while (t < horizon && guard++ < 2000) {
    const forced = fuel < safety || (tyreLifeKm > 0 && tyreKm >= tyreLifeKm);
    let d = coverSec(trackKm, t, fuel, tyreKm);
    const lapFuel = shareOfLap(t) * cautionBurn + (1 - shareOfLap(t)) * burnPerLap;
    let stopped = false;
    if (forced) {
      const addL = Math.max(0, tank - fuel);
      d += expectedStopSec(t - lastStopT, refuelTimeSec(cfg, addL), cfg.tyreChangeSec || 0);
      fuel = tank;
      tyreKm = 0;
      lastStopT = t;
      stopped = true;
    } else {
      fuel -= lapFuel;
    }
    tyreKm += trackKm;
    t += d;
    laps.push({ t, stop: stopped });
  }
  return laps;
}

// Mean elapsed time to reach each lap count, averaged over exactly one stop
// cycle. Comparing at a single lap count measures where each plan happens to
// sit in its own fuel cycle — worth a whole pit stop either way — rather than
// what the decision actually bought. A whole number of cycles cancels that
// oscillation; anything else leaves a residual that can flip close calls.
function cycleMeanTime(laps, cycleLaps, lapTarget) {
  const start = Math.max(1, lapTarget - cycleLaps + 1);
  let sum = 0;
  for (let n = start; n <= lapTarget; n++) sum += laps[n - 1].t;
  return sum / (lapTarget - start + 1);
}

function cautionGaps(car, pace, ratePerHour, anchor) {
  const sims = CAUTION_PLANS.map(p => simulateCautionPlan(car, pace, p, ratePerHour, anchor));
  const lapTarget = Math.max(1, Math.min(...sims.map(s => s.length)) - 1);
  // Every plan settles into the same stop rhythm, so any of them gives the cycle.
  let cycle = lapTarget;
  for (const s of sims) {
    let last = -1, prev = -1;
    for (let i = 0; i < Math.min(lapTarget, s.length); i++) {
      if (s[i].stop) { prev = last; last = i; }
    }
    if (prev >= 0 && last > prev) { cycle = last - prev; break; }
  }
  const means = sims.map(s => cycleMeanTime(s, cycle, lapTarget));
  const best = Math.min(...means);
  return CAUTION_PLANS.map((p, i) => ({ ...p, gapSec: means[i] - best }));
}

/**
 * The standing call for a neutralisation: take it, or wait for the next one.
 * `pace` is 'fcy' or 'sc'. Returns null when the car is not configured well
 * enough to answer (no tank, no lap time, no degradation figure).
 */
export function cautionCall(car, race, now, pace, calcs = carCalcs(car, race, now)) {
  const cfg = car.config;
  if (pace !== 'fcy' && pace !== 'sc') return null;
  const trackKm = cfg.trackKm || 0;
  const tank = cfg.tankLiters || 0;
  const refLapSec = (calcs.lapMs || 0) / 1000 || (cfg.avgLapSec && cfg.avgLapSec.dry) || 0;
  const burnPerLap = effectiveBurn(car, 'dry') || (cfg.burnPerLap && cfg.burnPerLap.dry) || 0;
  if (!(trackKm > 0) || !(tank > 0) || !(refLapSec > 0) || !(burnPerLap > 0)) return null;

  // What a wasted set is worth. Zero while the garage has rubber to spare, so
  // the call is unchanged for a team that is not rationing; once binning a
  // set's remaining life would actually push the ledger negative, it is the
  // cost of the extra stop the shortfall will force. (The card's proposal rule
  // is stricter — it also keeps a one-set reserve — but pricing follows the
  // sums, not the policy.)
  const budget = tyreBudget(car, race, now, calcs);
  const scarcity = budget && budget.changeForcesShort
    ? pitCostSec(car, null, {
        refuelSec: refuelTimeSec(cfg, cfg.tankLiters || 0),
        boxWorkSec: cfg.tyreChangeSec || 0
      }).lossGreen
    : 0;

  const anchor = cautionAnchor(car, race, now, pace, calcs, {
    refLapSec, burnPerLap, trackKm, tank, scarcity,
    fuel0: car.state.fuelLiters,
    // tyreSetMileage returns {km, kmFcy, kmGreen} — the total is what wears.
    tyreKm0: tyreSetMileage(currentTyreSet(car)).km || 0
  });

  // Staying out is behind while this is positive; it crosses zero at the rate
  // where waiting starts to pay.
  const margin = rate => {
    const gaps = cautionGaps(car, pace, rate, anchor);
    const stay = gaps.find(g => g.key === 'stay').gapSec;
    const bestStopper = Math.min(...gaps.filter(g => g.key !== 'stay').map(g => g.gapSec));
    return stay - bestStopper;
  };

  let breakEven = null; // null = staying out never wins below CAUTION_MAX_RATE
  if (margin(CAUTION_MAX_RATE) <= 0) {
    let lo = 0, hi = CAUTION_MAX_RATE;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (margin(mid) > 0) lo = mid; else hi = mid;
    }
    breakEven = (lo + hi) / 2;
  }

  const rate = cfg.cautionsPerHour || 0;
  const gaps = cautionGaps(car, pace, rate, anchor);
  const winner = gaps.reduce((a, b) => (b.gapSec < a.gapSec ? b : a));
  const runnerUp = Math.min(...gaps.filter(g => g.key !== winner.key).map(g => g.gapSec));
  return {
    pace,
    rate,
    breakEven,
    // Carried out so the card can say why fitting tyres has gone expensive.
    budget,
    // takeIt and the ranking are two readings of the same comparison, so it is
    // read straight off the ranking rather than off the break-even rate. The
    // bisection floors at 5/2^33 rather than a true zero, so a car with no rate
    // configured — the default — used to satisfy `rate <= breakEven` and say
    // TAKE IT above a list headed "Stay out".
    takeIt: winner.key !== 'stay',
    winner,
    plans: gaps,
    marginSec: runnerUp,
    // How decisive the call is, in the bands the study reads it in.
    band: cautionBand(runnerUp),
    // Where the car is in its stint, which is what the crossover below is
    // measured against.
    stintMin: stintMinutes(car, race, now)
  };
}

// ---------------------------------------------------------------------------
// When it starts to pay: the crossover, swept across the stint
// ---------------------------------------------------------------------------
// The call above answers "right now". The crew also needs the shape of it —
// a stop that is nominally ahead by half a second is a tie the arithmetic
// happened to break, and the useful question is which minute of a stint the
// advantage becomes real. Sweeping the stint answers both at once, and it is
// the same comparison at every point, so the graph and the verdict can never
// tell different stories.

// A winner has to beat the runner-up by more than this before it is a call
// rather than a coin flip. Everything under it reads as LINE BALL.
export const CAUTION_DECISIVE_SEC = 2;

// How decisive an advantage is, in plain words.
export const CAUTION_BANDS = [
  { at: 25, key: 'clear', label: 'clear' },
  { at: 10, key: 'worth', label: 'worth taking' },
  { at: CAUTION_DECISIVE_SEC, key: 'marginal', label: 'marginal' },
  { at: -Infinity, key: 'even', label: 'too close to call' }
];

export function cautionBand(sec) {
  return CAUTION_BANDS.find(b => sec >= b.at) || CAUTION_BANDS[CAUTION_BANDS.length - 1];
}

/** Minutes the current stint has been running, or 0 before it starts. */
export function stintMinutes(car, race, now) {
  const startMs = stintStartOf(car, race);
  return startMs > 0 && now > startMs ? drivenMs(race, startMs, now) / 60e3 : 0;
}

/**
 * The same call swept across a whole stint: at each minute, what each plan is
 * worth against staying out. Returns the series the graph draws, the minute
 * each plan starts to pay, and where the car sits on it right now.
 *
 * The sweep runs from the state the stint STARTED in — full tank or whatever
 * it left the lane with, and the rubber it went out on — so the minutes on the
 * axis are the ones on the stint clock in front of the crew.
 *
 * `stepMin` trades resolution for work: the default walks the stint in two
 * minute steps, which is four simulations a point.
 */
// The sweep is anchored on the state the STINT started in, so within a stint
// its answer does not move — only where the car sits on it does. That makes it
// worth keeping: a few dozen simulations would otherwise be rerun every second
// for every car, on both flags, to redraw the same curve.
const sweepCache = new Map();
const SWEEP_CACHE_MAX = 12;

function sweepCached(key, build) {
  if (sweepCache.has(key)) {
    const hit = sweepCache.get(key);
    // Re-insert so the least recently used entry is the one that falls off.
    sweepCache.delete(key);
    sweepCache.set(key, hit);
    return hit;
  }
  const built = build();
  sweepCache.set(key, built);
  if (sweepCache.size > SWEEP_CACHE_MAX) sweepCache.delete(sweepCache.keys().next().value);
  return built;
}

export function cautionSweep(car, race, now, pace, opts = {}) {
  const cfg = car.config;
  if (pace !== 'fcy' && pace !== 'sc') return null;
  const calcs = opts.calcs || carCalcs(car, race, now);
  const trackKm = cfg.trackKm || 0;
  const tank = cfg.tankLiters || 0;
  const refLapSec = (calcs.lapMs || 0) / 1000 || (cfg.avgLapSec && cfg.avgLapSec.dry) || 0;
  const burnPerLap = effectiveBurn(car, 'dry') || (cfg.burnPerLap && cfg.burnPerLap.dry) || 0;
  if (!(trackKm > 0) || !(tank > 0) || !(refLapSec > 0) || !(burnPerLap > 0)) return null;

  const stepMin = opts.stepMin > 0 ? opts.stepMin : 2;
  const rate = cfg.cautionsPerHour || 0;
  const safety = cfg.safetyFuelL || 0;
  const burnPerMin = burnPerLap * (60 / refLapSec);
  const kmPerMin = trackKm * (60 / refLapSec);

  // Where the stint began. The fuel it left the lane with when that is known,
  // a full tank when it is not; the rubber wound back by the distance run
  // since. Both are what the sweep's minute zero means.
  const fuelStart = car.state.stintFuelStartL > 0 ? car.state.stintFuelStartL : tank;
  const tyreKmNow = tyreSetMileage(currentTyreSet(car)).km || 0;
  const nowMin = stintMinutes(car, race, now);
  const tyreKmStart = Math.max(0, tyreKmNow - nowMin * kmPerMin);

  // The sweep runs to where fuel would force the car in anyway — past that
  // there is no decision left to make — capped by the stint the crew allows.
  const fuelEndMin = burnPerMin > 0 ? Math.max(0, (fuelStart - safety) / burnPerMin) : 0;
  const endMin = Math.max(stepMin, Math.min(fuelEndMin, (cfg.maxStintMin || 65) + 10));

  const budget = tyreBudget(car, race, now, calcs);
  const scarcity = budget && budget.changeForcesShort
    ? pitCostSec(car, null, {
      refuelSec: refuelTimeSec(cfg, tank),
      boxWorkSec: cfg.tyreChangeSec || 0
    }).lossGreen
    : 0;

  // Everything the curve's shape depends on, rounded so live pace wobble does
  // not invalidate it every tick. The car's position on the curve is not in
  // here — that is read fresh below.
  const key = [
    car.id, pace, rate, cfg.cautionMinutes, cfg.pitSlackSec, cfg.pitLaneFuelL,
    trackKm, tank, safety, cfg.tyreLifeKm, cfg.tyreChangeSec, cfg.refuelLps, cfg.refuelDeadSec,
    cfg.pitLossSec, cfg.minStopSec, cfg.driveThroughSec, cfg.pitLaneKm, cfg.pitSpeedKmh,
    cfg.pitEntryToPumpSec, cfg.pumpToExitSec, cfg.pumpToBoxSec, cfg.boxToExitSec, cfg.pitEntryToBoxSec,
    cfg.fcySpeedKmh, cfg.scSpeedKmh, cfg.greenSpeedKmh,
    cfg.tyreDegSecPerKm, cfg.fuelWeightSecPerL, stepMin, scarcity > 0 ? 1 : 0,
    refLapSec.toFixed(1), burnPerLap.toFixed(2), fuelStart.toFixed(0), tyreKmStart.toFixed(0)
  ].join('|');

  const built = sweepCached(key, () => buildSweepPoints());
  return {
    ...built,
    pace, rate, stepMin, endMin,
    // Where the car is on the curve right now — the one part that moves.
    nowMin,
    decisiveSec: CAUTION_DECISIVE_SEC
  };

  function buildSweepPoints() {
  const points = [];
  for (let min = 0; min <= endMin + 1e-9; min += stepMin) {
    const fuel = Math.max(safety, fuelStart - min * burnPerMin);
    const tyreKm = tyreKmStart + min * kmPerMin;
    const anchor = cautionAnchor(car, race, now, pace, calcs, {
      refLapSec, burnPerLap, trackKm, tank, scarcity, fuel0: fuel, tyreKm0: tyreKm
    });
    const gaps = cautionGaps(car, pace, rate, anchor);
    const stay = gaps.find(g => g.key === 'stay').gapSec;
    // Gain over staying out: positive means the stop is ahead. The gaps are
    // measured down from the best plan, so staying out's own gap IS the gain
    // of whichever plan is being read against it.
    const gainOf = key => stay - gaps.find(g => g.key === key).gapSec;
    points.push({
      min,
      fuelL: fuel,
      tyreKm,
      fuel: gainOf('fuel'),
      tyres: gainOf('tyres'),
      both: gainOf('both')
    });
  }

  // The first minute each plan's advantage becomes a decision rather than a
  // tie, interpolated between samples so a two-minute step does not round the
  // answer into the next one.
  const firstAbove = key => {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1][key];
      const b = points[i][key];
      if (b > CAUTION_DECISIVE_SEC && a <= CAUTION_DECISIVE_SEC) {
        const f = (CAUTION_DECISIVE_SEC - a) / (b - a);
        return points[i - 1].min + f * (points[i].min - points[i - 1].min);
      }
      if (i === 1 && a > CAUTION_DECISIVE_SEC) return points[0].min;
    }
    return null;
  };

  return {
    points,
    // Minute of the stint each plan starts to be worth taking, null if never.
    first: { fuel: firstAbove('fuel'), tyres: firstAbove('tyres'), both: firstAbove('both') }
  };
  }
}

// Who sits in the car after a stop taken now: a double-stint driver stays for
// their second stint, otherwise the eligible driver (night / rain / drive-time
// regulations permitting) with the least seat time takes over.
// The driver the stint plan puts in the car for the stint AFTER the one running.
// Returns null when there is no plan, or the plan has run out of stints.
// The plan row a stop taken now would start. The running stint sits at
// stintHistory.length; the stop being planned for ends it, so the stint that
// follows is the next row after that. Before the flag nothing is running and
// the plan starts at its first row. Everything that reads or writes "the next
// stint" goes through here, so the stop call and the plan edit it makes can
// never point at different rows.
export function plannedNextStintIndex(car, race, now) {
  return car.stintHistory.length + (raceClock(race, now).running ? 1 : 0);
}

export function plannedNextDriver(car, race, now) {
  const plan = car.plan;
  if (!plan?.stints?.length) return null;
  const st = plan.stints[plannedNextStintIndex(car, race, now)];
  if (!st) return null;
  return car.drivers.find(d => d.id === st.driverId) || null;
}

export function nextDriverCall(car, calcs, now, opts = {}) {
  const cur = car.drivers.find(d => d.id === car.currentDriverId) || null;
  const night = isNightAt(now);
  const wet = car.condition === 'wet';
  const stintMs = opts.stintMs || 0;
  const reg = calcs.reg;

  // Seat time a driver may still legally run, measured against the stint this
  // stop would START — not merely "has any time left". A driver eight minutes
  // from their limit is no use at the front of a sixty-minute stint, which is
  // the same test the tyres two blocks up already apply to themselves.
  const shortfallOf = d => {
    if (!reg?.enabled) return null;
    const s = reg.byDriver[d.id];
    if (!s) return null;
    if (s.eligible === false) return 0;
    if (s.driveLeftMs == null) return null;
    return s.driveLeftMs < stintMs ? s.driveLeftMs : null;
  };
  const canTake = d => shortfallOf(d) == null;

  const fits = d => (!night || d.night) && (!wet || d.rain) &&
    (!reg?.enabled || reg.byDriver[d.id]?.eligible !== false);

  // The stint plan is the crew's own running order — generated from the driver
  // table, then edited by hand through the race — so it decides who gets in,
  // not the balancing heuristic below. The heuristic is only the fallback for
  // a car with no plan, and the safety net when the plan names someone who
  // cannot legally finish the stint.
  const planned = opts.race ? plannedNextDriver(car, opts.race, now) : null;
  if (planned && canTake(planned)) {
    const change = !cur || planned.id !== cur.id;
    return {
      change,
      driver: planned,
      source: 'plan',
      why: change ? 'next in the stint plan' : 'stint plan keeps the same driver in'
    };
  }
  const planShortfall = planned ? shortfallOf(planned) : null;

  let pool = car.drivers.filter(fits);
  const forced = pool.length === 0;
  if (forced) pool = car.drivers.slice();

  // Consecutive stints the current driver has already run, incl. this one.
  let run = 1;
  for (let i = car.stintHistory.length - 1; i >= 0; i--) {
    if (car.stintHistory[i].driverId === car.currentDriverId) run++;
    else break;
  }
  if (cur && cur.doubleStint && run === 1 && pool.some(d => d.id === cur.id) && canTake(cur)) {
    return { change: false, driver: cur, source: 'auto', why: 'double stint — same driver stays in' };
  }
  let cands = pool.filter(d => !cur || d.id !== cur.id);
  if (!cands.length) cands = pool;
  // Anyone who can see the whole stint out comes first; within each group the
  // least seat time still wins, so the balancing is untouched.
  cands.sort((a, b) => (canTake(b) - canTake(a)) ||
    ((reg?.byDriver[a.id]?.totalMs || 0) - (reg?.byDriver[b.id]?.totalMs || 0)));
  const pick = cands[0];
  const pickShort = shortfallOf(pick);
  let why;
  if (planShortfall != null) {
    // The plan is editable and this is the engineer's cue to edit it.
    why = `${planned.name} is ${fmtMinSec(planShortfall)} from the drive limit — plan needs a change`;
  } else if (planned) {
    why = 'plan driver unavailable — least seat time';
  } else if (pickShort != null) {
    why = `no driver covers the stint — ${fmtMinSec(pickShort)} of drive time left`;
  } else {
    why = forced ? 'no eligible driver — least seat time' : 'least seat time of the eligible drivers';
  }
  return { change: !cur || pick.id !== cur.id, driver: pick, source: planned ? 'plan-override' : 'auto', why };
}

// The crew's own points for the flag that is out, or null when they are not
// being used. This is the bypass: the ranking in cautionRanking prices a stop
// out of caution rate, lap times and wear coefficients, and every one of those
// is an estimate. A crew that has run the car all season often knows the
// answer as a number — "under a Code 60, if we are under forty litres, we
// box" — and this lets them say exactly that.
//
// Two points can call the stop (a fuel level and a stint length) and two more
// call the tyres. Any point that is hit calls it, so a crew can set the fuel
// level alone and leave the clock at 0. The tyre points are only read once the
// stop itself is called: they say what to do while the car is in there, never
// whether to come in.
export function flagRuleCall(car, calcs) {
  const r = car.config?.flagRule;
  if (!r || !r.on) return null;

  const fuelL = car.state.fuelLiters;
  const stintMs = calcs.stintElapsedMs;
  const stintMin = stintMs / 60e3;

  const hits = [];
  if (r.fuelL > 0 && fuelL <= r.fuelL) hits.push(`${fuelL.toFixed(0)} L on board, at or under your ${r.fuelL} L`);
  if (r.stintMin > 0 && stintMin >= r.stintMin) hits.push(`${Math.floor(stintMin)} min into the stint, at or past your ${r.stintMin}`);
  const box = hits.length > 0;

  const tyreHits = [];
  if (r.tyreFuelL > 0 && fuelL <= r.tyreFuelL) tyreHits.push(`fuel is under your ${r.tyreFuelL} L tyre point`);
  if (r.tyreStintMin > 0 && stintMin >= r.tyreStintMin) tyreHits.push(`the stint is past your ${r.tyreStintMin} min tyre point`);

  // How long until the earliest point that is set comes up, so a stop the crew
  // has not reached yet still counts down like every other call on the card.
  const waits = [];
  if (r.fuelL > 0 && fuelL > r.fuelL && calcs.burn > 0 && calcs.lapMs > 0) {
    waits.push(((fuelL - r.fuelL) / calcs.burn) * calcs.lapMs);
  }
  if (r.stintMin > 0 && stintMin < r.stintMin) waits.push(r.stintMin * 60e3 - stintMs);
  const msToPoint = waits.length ? Math.min(...waits) : null;

  return {
    on: true,
    box,
    tyres: box && tyreHits.length > 0,
    // Nothing is set at all: the switch is on but every point is 0. Say so
    // rather than answering STAY OUT for a rule that was never written.
    empty: !(r.fuelL > 0 || r.stintMin > 0),
    why: box ? hits.join(' · ') : null,
    tyreWhy: tyreHits.length ? tyreHits.join(' · ') : null,
    msToPoint
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
  const pitLoss = cfg.pitLossSec || 0;
  const running = calcs.clock.running;
  const rem = calcs.clock.remainingMs;
  // The crew's own points, when they are using them. Only under a flag: green
  // is still the fuel window's call, and the limits still bind it.
  const ruleSet = neutral && running ? flagRuleCall(car, calcs) : null;
  // A switch turned on over an empty form is not a call. The maths keeps the
  // stop until at least one point is written; the settings panel says so.
  const rule = ruleSet && !ruleSet.empty ? ruleSet : null;

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
      rigSec: Math.round(refuelTimeSec(cfg, addL)),
      why: mode === 'full'
        ? 'more stops follow — nothing is gained by carrying less'
        : 'enough to reach the flag with the finish margin and a lap in hand'
    };
  }

  // ---- tyres: change when the set on the car cannot cover the stint that
  // would follow this stop, and never when it already reaches the flag.
  const reachFlag = calcs.msToTyres >= rem && rem > 0;
  const due = running && !reachFlag && calcs.msToTyres < stintMs;

  // A set that is not due can still be worth fitting under a neutralisation.
  // The life rule above only asks whether the rubber survives the next stint;
  // it never notices that the flag has just made the box work cheap. Fresh
  // rubber starts the coming stint however many kilometres younger, and stays
  // that much younger every lap of it — once that beats the discounted box
  // time, the change pays for itself.
  //
  // Two things hold it back. There has to be a set free, and the garage has to
  // be able to afford it: on a fixed allocation a set binned early is distance
  // that cannot be bought back, so while the stock is short the life rule
  // stands and the reason says so.
  let opportunity = false;
  let oppWhy = '';
  if (neutral && running && !due && !reachFlag && calcs.lapMs > 0) {
    const spare = stopTyreSet(car);
    const budget = tyreBudget(car, race, now, calcs);
    const kmOn = tyreSetMileage(currentTyreSet(car)).km;
    const lapsAhead = Math.max(0, Math.round(stintMs / calcs.lapMs));
    const gainSec = (cfg.tyreDegSecPerKm || 0) * kmOn * lapsAhead;
    const rig = refuelTimeSec(cfg, fuel.addL);
    const costSec = pitCostSec(car, pace, { refuelSec: rig, boxWorkSec: cfg.tyreChangeSec || 0 }).lossNeutral
      - pitCostSec(car, pace, { refuelSec: rig }).lossNeutral;
    if (gainSec > costSec && spare) {
      if (budget && !budget.affordEarlyChange) {
        // The gain is real but the shelf cannot pay for it: an early change
        // spends a fresh set the flag distance still needs.
        oppWhy = `worth ${Math.round(gainSec)} s under the flag, but that spends a fresh set — `
          + `${budget.setsFresh} left for ~${budget.setsNeededMin} the flag still needs. Keep the set`;
      } else {
        opportunity = true;
        oppWhy = `free under the flag — ${Math.round(gainSec)} s of wear for `
          + `${Math.round(costSec)} s of box time`
          + (budget ? ` · leaves ${budget.setsFresh - 1} fresh for ~${Math.max(0, budget.setsNeededIfChangeNow - 1)} needed` : '');
      }
    }
  }

  // A set that is due is still due whatever the crew's points say — running a
  // stint on rubber that cannot last it is not a call anybody makes on
  // purpose. Above that floor the points own the answer: they say what to do
  // while the car is in there, and the opportunity maths steps aside.
  const change = rule ? (due || (rule.box && rule.tyres)) : (due || opportunity);
  const fit = change ? stopTyreSet(car) : null;
  const ruleTyres = !!(rule && !due && change);
  const tyres = {
    change: !!change,
    set: fit,
    setId: fit?.id || null,
    // True when the rubber is not due and the flag is what makes it worth doing.
    opportunity: opportunity && !rule,
    // True when the crew's own point, not the maths, called for the set.
    byRule: ruleTyres,
    why: !running ? 'race not started'
      : reachFlag ? `${calcs.tyreLapsLeft} laps left — reaches the flag`
      : ruleTyres ? (fit ? `your call — ${rule.tyreWhy}` : 'no set free — every spare is used or scrapped')
      : rule && !due ? `${calcs.tyreLapsLeft} laps left — your tyre point is not reached`
      : opportunity ? (fit ? oppWhy : 'no set free — every spare is used or scrapped')
      : due ? (fit ? `${calcs.tyreLapsLeft} laps left, next stint ${Math.round(stintMs / calcs.lapMs)}`
                      : 'no set free — every spare is used or scrapped')
      : oppWhy || `${calcs.tyreLapsLeft} laps left — good for another stint`
  };

  // ---- driver
  const dc = nextDriverCall(car, calcs, now, { race, stintMs });
  const drvMs = Math.min(...calcs.limits.filter(l => l.key === 'driver' || l.key === 'reg').map(l => l.ms));
  const driver = {
    change: running && dc.change,
    id: dc.change ? dc.driver?.id || null : null,
    name: dc.driver?.name || '',
    why: !running ? 'race not started'
      : dc.change ? `${dc.why} · seat-time limit in ${fmtMinSec(drvMs)}`
      : dc.why
  };

  // ---- brakes: parts that cannot survive another stint, read by axle.
  // Discs that are done take their pads with them — a kit comes off as a kit,
  // and fresh discs would only chew through the old pads anyway.
  const brakes = [];
  const dueOf = comp => {
    const leftMs = calcs.brakes[comp].leftH * 3600e3;
    if (leftMs >= rem && rem > 0) return false; // reaches the flag
    return leftMs < stintMs;
  };
  for (const a of BRAKE_AXLES) {
    if (dueOf(a.discs)) brakes.push(a.pads, a.discs);
    else if (dueOf(a.pads)) brakes.push(a.pads);
  }

  // ---- what this stop costs, and what the neutralisation takes off it.
  // Priced twice: the fuel on its own, and the fuel with the box work bolted
  // on. The difference is what tyres and a driver actually cost on top — and
  // it is discounted by the same factor, which is why everything gets done at
  // once under a neutralisation.
  const refuelSec = refuelTimeSec(cfg, fuel.addL);
  const boxWorkSec = tyres.change ? (cfg.tyreChangeSec || 0) : 0;
  const costFuel = pitCostSec(car, pace, { refuelSec });
  const costFull = pitCostSec(car, pace, { refuelSec, boxWorkSec });
  const gainSec = costFull.gainSec;
  const work = {
    boxWorkSec,
    // Marginal cost of the box work on top of a fuel-only stop.
    greenSec: costFull.lossGreen - costFuel.lossGreen,
    nowSec: costFull.lossNeutral - costFuel.lossNeutral
  };

  // ---- is this flag worth taking at all, and for what work
  // The litre threshold below (netSec) answers the fuel-only half of it off
  // track geometry alone. This answers the whole of it: four plans rolled
  // forward over many stint cycles, priced for how long the flag actually
  // runs, what the box work earns on top of the fuel, and the gamble that
  // another caution falls before the tank forces the car in anyway.
  const cc = neutral && running ? cautionCall(car, race, now, pace, calcs) : null;
  const sweep = cc ? cautionSweep(car, race, now, pace, { calcs }) : null;
  // Deliberately not the whole call: this rides on every state broadcast, for
  // every car, on both flags. The tyre ledger behind it is already on the car
  // and the screens work it out for themselves, so only the answer travels.
  const caution = cc
    ? {
      pace: cc.pace,
      rate: cc.rate,
      breakEven: cc.breakEven,
      takeIt: cc.takeIt,
      winner: { key: cc.winner.key, label: cc.winner.label },
      plans: cc.plans.map(p => ({ key: p.key, label: p.label, gapSec: p.gapSec })),
      marginSec: cc.marginSec,
      band: cc.band.key,
      // The minute of the stint each option starts to be worth taking, and
      // whether the car has reached it yet. This is the answer the crew reads
      // off the card while the flag is out: not just "is it worth it now" but
      // "and if not now, when".
      first: sweep ? sweep.first : null,
      stintMin: sweep ? sweep.nowMin : cc.stintMin
    }
    : null;

  // What to say about an option that does not pay yet: when it starts to.
  const fromMin = key => {
    const at = caution?.first?.[key];
    if (at == null) return null;
    return at <= (caution.stintMin || 0) ? 'now' : `minute ${Math.round(at)}`;
  };

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
  } else if (rule && fs && !fs.noStopNeeded) {
    // The crew's own points, and nothing else. The ranking above still ran, so
    // the line can say what it was that got overruled — a bypass that hides
    // the maths is one nobody can check.
    const maths = caution ? (caution.takeIt ? 'the maths would box too' : 'the maths would stay out') : null;
    if (rule.box) {
      verdict = 'boxNow';
      head = rule.tyres ? 'BOX NOW · FUEL + TYRES' : 'BOX NOW';
      sub = `Your points: ${rule.why}.` + (maths ? ` For what it is worth, ${maths}.` : '');
      dueKey = 'PIT ENTRY';
      dueMs = null;
      dueNote = 'your own points';
    } else {
      verdict = 'stay';
      head = 'STAY OUT';
      sub = 'Your points are not reached yet, so this flag is not yours to take.'
        + (maths ? ` For what it is worth, ${maths}.` : '');
      dueKey = rule.msToPoint != null ? 'YOUR POINT IN' : 'YOUR POINTS';
      dueMs = rule.msToPoint;
      dueNote = rule.msToPoint != null ? 'if the flag is still out' : 'not reached';
    }
  } else if (neutral && fs && !fs.noStopNeeded) {
    // How far the winning plan is ahead of simply staying out — the number the
    // call turns on. The ranking's gaps are measured down from the best plan,
    // so staying out's own gap IS that advantage.
    const stayGap = caution ? caution.plans.find(p => p.key === 'stay').gapSec : 0;
    const lineBall = caution ? caution.marginSec < CAUTION_DECISIVE_SEC : false;
    const work = caution ? caution.winner.label.toUpperCase() : '';
    if (fs.windowOpen) {
      // The stop is due whatever happens, so the only question left is what to
      // do while the car is in there — and under a flag the answer is
      // everything, because the box work is discounted with the fuel.
      verdict = 'boxNow';
      head = caution && caution.takeIt ? `BOX NOW · ${work}` : 'BOX NOW';
      sub = `The window is open, so the pit-lane loss is spent either way — and the flag takes ${gainSec.toFixed(0)} s off it.`;
      dueKey = 'PIT ENTRY';
      dueMs = null;
      dueNote = 'window open';
    } else if (caution && caution.takeIt && !lineBall) {
      verdict = 'boxNow';
      head = `BOX NOW · ${work}`;
      sub = `${caution.winner.label} is ${stayGap.toFixed(0)} s up on staying out and `
        + `${caution.marginSec.toFixed(0)} s clear of the next plan — ${cc.band.label}. `
        + 'It adds a stop later and is still ahead.';
      dueKey = 'PIT ENTRY';
      dueMs = null;
      dueNote = 'adds one stop, still ahead';
    } else if (caution && caution.takeIt && lineBall) {
      // Nominally ahead, but by less than the inputs are worth. Calling it
      // either way would read as a decision the maths has not earned.
      verdict = 'stay';
      head = 'LINE BALL';
      sub = `${caution.winner.label} is ahead by ${stayGap.toFixed(0)} s but only `
        + `${caution.marginSec.toFixed(1)} s clear of the next plan — too close to call. `
        + 'Decide it on traffic, the driver and the crew.';
      dueKey = 'WINDOW IN';
      dueMs = fs.msToWindow;
      dueNote = `${fs.lapsToWindow} laps`;
    } else if (caution) {
      verdict = 'stay';
      head = 'STAY OUT';
      const fuelAt = fromMin('fuel');
      const bothAt = fromMin('both');
      const when = bothAt && bothAt !== 'now' ? `Fuel and tyres starts paying at ${bothAt}`
        : fuelAt && fuelAt !== 'now' ? `Fuel starts paying at ${fuelAt}`
        : null;
      sub = `Staying out is ${Math.abs(stayGap).toFixed(0)} s up on the best stop`
        + (caution.rate > 0 && caution.breakEven != null
          ? ` — cautions would have to fall at ${caution.breakEven.toFixed(2)}/h before that flips`
          : '')
        + '. ' + (when ? `${when} of the stint; the window opens in ${fs.lapsToWindow} laps.`
          : `The window opens in ${fs.lapsToWindow} laps.`);
      dueKey = 'WINDOW IN';
      dueMs = fs.msToWindow;
      dueNote = `${fs.lapsToWindow} laps`;
    } else if (netSec <= 0) {
      // No simulation available (the car is not configured for one) — fall
      // back to the litre threshold, which needs nothing but track geometry.
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
    // The four-plan ranking behind the call, with the minute of the stint each
    // option starts to pay. null under green, which discounts nothing.
    caution,
    gainSec, netSec, work,
    stopSec: costFull.T, lossGreenSec: costFull.lossGreen, lossNowSec: costFull.lossNeutral,
    est: { stationarySec: svc.totalSec, totalSec: svc.totalSec + pitLoss, addLiters: svc.addLiters },
    limit: { key: calcs.limit.key, label: calcs.limit.label, ms: calcs.limit.ms },
    // Set when the crew's own points answered this one, so every screen can
    // show whose call it was rather than passing it off as the model's.
    rule
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
// nextStop.pins, one drawer per situation, and survive until the stop is
// applied or cleared — so resolving the code 60 plan reads the code 60 pins
// and never the green ones.
export function resolveStop(car, plan) {
  const pin = stopPins(car, planKeyOf(plan?.pace));
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

  // Read the call by axle, so a pin naming discs alone still comes out as the
  // kit it has to be, and both halves of a kit come off the SAME kit rather
  // than each being answered on its own.
  const work = brakeAxleWork(pin.brakes == null ? plan.brakes : pin.brakes);
  const brakeIds = brakeWorkComps(work);
  const brakes = {};
  for (const b of BRAKE_COMPONENTS) brakes[b.id] = brakeIds.includes(b.id);
  // Which numbered set each changed component gets: the one the engineer
  // picked, else whatever the app would take off the rack. A component that is
  // not being changed carries no set.
  const brakeSetIds = { padsFront: null, padsRear: null, discsFront: null, discsRear: null };
  const pinned = { brakeSetIds: { ...(pin.brakeSets || {}) } };
  for (const a of BRAKE_AXLES) {
    if (work[a.id] === 'kit') {
      const kit = stopBrakeKit(car, a.id, pinned);
      brakeSetIds[a.discs] = kit?.disc?.id || null;
      brakeSetIds[a.pads] = kit?.pad?.id || null;
    } else if (work[a.id] === 'pads') {
      brakeSetIds[a.pads] = stopPadSet(car, a.id, pinned)?.id || null;
    }
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
// Rules: a stint is a tank of fuel — it runs until the usable fuel (tank less
// the safety litres) is burnt at the driver's dry burn, read as a time
// through the configured dry lap, and is only cut shorter by the max stint
// time. Nothing is rounded to whole laps: the sheet is a fuel budget, not a
// lap count. Drivers with night=false are not scheduled between NIGHT_START_H
// and NIGHT_END_H; doubleStint drivers run two stints back-to-back; seat time
// is balanced by always picking the eligible driver with the least planned time.
// If race.startMs is not set the plan assumes the race starts at assumedStartMs.
// `opts` lets replanFromNow continue a race in progress: generation starts at
// race-relative `fromMs`, seat-time balancing is seeded with `seedTotals`, and
// `prevDriverId`/`prevRun` carry the double-stint state of the running stint.
export const PLAN_STINT_CAP = 200;

// Why a stint plan cannot be built from this car and this race, in the terms
// the crew would use. Empty = it can be built. The panel shows this the moment
// it is opened and GENERATE reads the same list before it runs, so a refusal is
// never a button that simply does nothing.
export function planBlockers(car, race) {
  if (!car) return ['there is no car to plan for'];
  const out = [];
  if (!car.drivers?.length) {
    out.push('the driver table is empty — add the crew in SETTINGS → DRIVERS first');
  }
  if (!(race?.durationH > 0)) {
    out.push('the race has no length — set the duration on the pit wall');
  }
  return out;
}

export function generatePlan(car, race, assumedStartMs, opts = {}) {
  const cfg = car.config;
  const startMs = race.startMs || assumedStartMs;
  const totalMs = race.durationH * 3600e3;
  // Nobody to put in the car, or no race to plan across: hand back an empty
  // plan rather than throwing halfway down. The callers say why — this only
  // has to make sure a bad table cannot take the panel down with it.
  if (!car.drivers?.length || !(totalMs > 0)) {
    return { generatedMs: assumedStartMs, startMs, assumedStart: !race.startMs, stints: [], totals: {}, truncated: null };
  }
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
  // How long the usable fuel lasts this driver, in ms: litres over the burn
  // per lap is a lap count, times the lap time is a stint — but it is never
  // floored to whole laps, so the whole tank is spent and the fuel column is
  // the usable fuel, not a lap count times a burn. Never shorter than one lap
  // (a tank that is all safety fuel would otherwise plan zero-length stints).
  const fuelMsOf = d => Math.max(lapMs, (usable / burnOf(d)) * lapMs);
  const stintMs = d => Math.min(fuelMsOf(d), Math.max(lapMs, (cfg.maxStintMin || 60) * 60e3));
  // Litres burnt over a stretch of the stint: the burn per lap spread evenly
  // over the lap time.
  const fuelOver = (d, ms) => +((ms / lapMs) * burnOf(d)).toFixed(1);

  const totals = {};
  for (const d of car.drivers) totals[d.id] = opts.seedTotals?.[d.id] || 0;
  const stints = [];
  let t = Math.max(0, opts.fromMs || 0);
  let prev = opts.prevDriverId ? car.drivers.find(d => d.id === opts.prevDriverId) || null : null;
  let prevRun = prev ? opts.prevRun || 1 : 0;

  while (t < totalMs && stints.length < PLAN_STINT_CAP) {
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

    const endT = Math.min(t + stintMs(pick), totalMs);
    const actualMs = endT - t;
    stints.push({
      driverId: pick.id,
      fromMs: t,
      toMs: endT,
      fuelL: fuelOver(pick, actualMs),
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
    totals,
    // The generator gave up before the flag: at this stint length the race
    // needs more stints than any real plan has. That is always a setting
    // upstream — nearly always a tank that is all safety fuel — so the panel
    // says so instead of showing a plan that quietly ends hours early.
    truncated: t < totalMs ? { atMs: t, totalMs } : null
  };
}

// Seat-time totals read straight off the plan's rows. Every edit runs this, or
// the totals over the table contradict the table.
export function recountPlanTotals(car) {
  const plan = car.plan;
  if (!plan?.stints) return;
  const totals = {};
  for (const d of car.drivers) totals[d.id] = 0;
  for (const s of plan.stints) totals[s.driverId] = (totals[s.driverId] || 0) + (s.toMs - s.fromMs);
  plan.totals = totals;
}

// Move a driver up the running order to `index` — the way a stint sheet is
// reordered by hand, not the way a name is rubbed out. The driver is taken out
// of the stint they were next due in and inserted here; everyone in between
// slides one stint later. Nobody gains or loses a stint and the rest of the
// order keeps its shape, which is why this is an insert and not a swap: a swap
// would send whoever was next to the far end of the race, and an overwrite
// would quietly hand one driver two stints and another none.
// A driver with no later stint to give up is a genuine insert — the tail
// shifts and whoever held the last row loses it, which is why that case is
// reported back rather than done in silence.
// Stints already driven are history and are never touched.
// Returns null when nothing moved, else what the move did.
export function insertPlanDriver(car, index, driverId) {
  const stints = car.plan?.stints;
  if (!stints?.length) return null;
  if (!(index >= car.stintHistory.length && index < stints.length)) return null;
  if (!car.drivers.some(d => d.id === driverId)) return null;
  if (stints[index].driverId === driverId) return null;

  let from = -1;
  for (let i = index + 1; i < stints.length; i++) {
    if (stints[i].driverId === driverId) { from = i; break; }
  }
  const end = from === -1 ? stints.length - 1 : from;
  // Read before the shift overwrites it: with no later stint to give up, the
  // driver at the end of the plan is the one who pays for the insert.
  const displacedId = from === -1 ? stints[end].driverId : null;
  const replacedId = stints[index].driverId;
  for (let i = end; i > index; i--) stints[i].driverId = stints[i - 1].driverId;
  stints[index].driverId = driverId;
  recountPlanTotals(car);
  return { to: index, from: from === -1 ? null : from, replacedId, displacedId };
}

// Where the running order has stopped matching the driver table. The generator
// respects night cover and the double-stint flags, so a plan straight out of
// GENERATE is clean on those two and anything reported is the consequence of a
// hand edit — an inserted driver, a reassigned stint — or of a driver setting
// changing under a plan that was right when it was made.
// The drive-time limits are in here for a sharper reason: a stop call silently
// puts someone else in when the planned driver cannot legally see the stint out
// (see nextDriverCall), so a plan that busts them is a plan the race will not
// follow. They are read off the plan's own rows, which are race-relative, so
// this is a projection of the whole plan and not a reading of the clock.
// byStint[i] is what is wrong with row i; list is the same thing deduplicated
// for a summary, with index null on the crew-wide ones.
export function planDriverIssues(car) {
  const out = { byStint: [], list: [] };
  const stints = car.plan?.stints;
  if (!stints?.length) return out;
  out.byStint = stints.map(() => []);
  const drvOf = id => car.drivers.find(d => d.id === id) || null;
  const first = car.stintHistory.length; // history is not up for review
  const crew = [];

  // Night cover: a night stint on a driver who does not drive at night. A row
  // flagged noNightCover was generated with nobody available at all — a
  // different problem, already marked on the row itself.
  stints.forEach((s, i) => {
    if (i < first || !s.night || s.noNightCover) return;
    const d = drvOf(s.driverId);
    if (d && !d.night) out.byStint[i].push({ code: 'night', text: `${d.name} does not drive at night` });
  });

  // Consecutive stints. Runs are walked across the whole plan so a double that
  // starts in history is counted whole; only the rows still to run are marked.
  for (let i = 0; i < stints.length;) {
    let j = i;
    while (j + 1 < stints.length && stints[j + 1].driverId === stints[i].driverId) j++;
    const len = j - i + 1;
    const d = drvOf(stints[i].driverId);
    if (len > 1 && d) {
      const text = len > 2
        ? `${d.name} is down for ${len} stints back to back`
        : (!d.doubleStint ? `${d.name} is not down for double stints` : null);
      if (text) for (let k = Math.max(i, first); k <= j; k++) out.byStint[k].push({ code: len > 2 ? 'triple' : 'double', text });
    }
    i = j + 1;
  }

  const cfg = car.config;
  const maxTotalMs = (cfg.regTotalMin || 0) * 60e3;
  const max6hMs = (cfg.reg6hMin || 0) * 60e3;
  const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
  for (const d of car.drivers) {
    const spans = stints.filter(s => s.driverId === d.id);
    if (!spans.length) {
      if (car.drivers.length > 1) crew.push({ code: 'nostints', text: `${d.name} has no stints left in the plan` });
      continue;
    }
    if (maxTotalMs > 0) {
      const tot = spans.reduce((a, s) => a + (s.toMs - s.fromMs), 0);
      if (tot > maxTotalMs) {
        crew.push({ code: 'total', text: `${d.name} is planned for ${fmtClock(tot)} against a ${fmtClock(maxTotalMs)} total drive limit` });
      }
    }
    if (max6hMs > 0) {
      // The heaviest window always starts on a stint, so the starts are the
      // only candidates worth measuring.
      let worst = 0;
      for (const w of spans) {
        let sum = 0;
        for (const t of spans) sum += overlap(t.fromMs, t.toMs, w.fromMs, w.fromMs + REG_WINDOW_MS);
        if (sum > worst) worst = sum;
      }
      if (worst > max6hMs) {
        crew.push({ code: 'win6h', text: `${d.name} is planned for ${fmtClock(worst)} inside one 6 h window — the limit is ${fmtClock(max6hMs)}` });
      }
    }
  }

  // One entry per fault, carrying every stint it lands on: the same driver
  // flagged on six night stints is one thing wrong, but the summary still has
  // to say which six, or it points at the first and hides the rest.
  const seen = new Map();
  out.byStint.forEach((arr, i) => {
    for (const x of arr) {
      const had = seen.get(x.text);
      if (had) { had.indexes.push(i); continue; }
      const rec = { ...x, index: i, indexes: [i] };
      seen.set(x.text, rec);
      out.list.push(rec);
    }
  });
  for (const x of crew) {
    if (seen.has(x.text)) continue;
    seen.set(x.text, x);
    out.list.push({ ...x, index: null, indexes: [] });
  }
  return out;
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
    const stintFromMs = calcs.stintStartMs;
    const stopAt = Math.min(now + calcs.limit.ms, startMs + clock.totalMs);
    stints.push({
      driverId: car.currentDriverId,
      fromMs: stintFromMs - startMs,
      toMs: stopAt - startMs,
      laps: car.state.lapsThisStint + Math.max(0, Math.round(calcs.limit.ms / calcs.lapMs)),
      fuelL: null,
      night: isNightAt(stintFromMs),
      current: true
    });
    if (totals[car.currentDriverId] != null) {
      totals[car.currentDriverId] += stopAt - stintFromMs;
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
    totals: rest.totals,
    truncated: rest.truncated
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
        actualFromMs: stintStartOf(car, race) - startMs,
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
// Rolling pace window (the pace card)
// ---------------------------------------------------------------------------
// How many laps the card averages over, clamped to what the setting allows so
// a stray entry can never blank the card.
export function paceWindowLaps(car) {
  const n = Math.round(Number(car?.config?.paceAvgLaps));
  if (!(n >= PACE_WINDOW_MIN)) return PACE_WINDOW_DEFAULT;
  return Math.min(PACE_WINDOW_MAX, n);
}

// Every timed lap one driver has done this race, oldest first: their closed
// stints from the sheet plus the stint they are in right now. A driver who
// gets back in later keeps their earlier laps, so the window spans the change
// of car rather than restarting at the pit exit.
export function driverLapTimes(car, driverId) {
  const laps = [];
  for (const h of car.stintHistory || []) {
    if (h.driverId !== driverId) continue;
    for (const t of h.lapTimes || []) if (t > 0) laps.push(t);
  }
  if (car.currentDriverId === driverId) {
    for (const t of car.state?.stintLapSec || []) if (t > 0) laps.push(t);
  }
  return laps;
}

// Which laps of a list are representative pace. The cut is PACE_OUTLIER_FACTOR
// of the window average — but the average of what? A four-minute pit lap in the
// window lifts the mean so far that the cut clears every real lap and nothing
// is struck, so the reference is re-read from the laps that survive it until
// the set stops shrinking. A lap at or under the mean always survives, so the
// set can never empty.
function paceEligible(laps) {
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  let use = laps;
  for (;;) {
    const cutSec = mean(use) * PACE_OUTLIER_FACTOR;
    const keep = laps.map(t => t <= cutSec);
    const next = laps.filter((_, i) => keep[i]);
    if (next.length >= use.length) return { keep, cutSec };
    use = next;
  }
}

// The pace picture for one driver over their last `n` timed laps. A lap the
// crew cannot read pace from — an in or out lap, a lap behind a slower class,
// a full-course yellow, a spin — is struck through on the card and left out of
// every figure here, and the window reaches further back for an eligible lap to
// replace it, so `avgSec` is the mean of `n` real green laps whenever the
// driver has done that many. `laps` is everything the strip draws (struck laps
// included); `outliers` says which of them were struck.
export function paceWindowStats(car, driverId = car.currentDriverId, n = paceWindowLaps(car)) {
  const all = driverLapTimes(car, driverId);
  const base = { n, driverId, total: all.length };
  if (!all.length) {
    return {
      ...base, laps: [], outliers: [], avgSec: null, bestSec: null, worstSec: null,
      lastSec: null, lastRawSec: null, lastIsOut: false, counted: 0, ignored: 0, cutSec: null
    };
  }

  // Widen the slice from the newest lap backwards until it holds `n` eligible
  // laps. Eligibility moves with the slice — a wider window has a different
  // average, so a different cut — which is why it is re-read on every step
  // rather than fixed on the first pass. PACE_WINDOW_REACH bounds how far back
  // it will go: under a long neutralisation nothing is eligible, and a "last
  // five laps" average must not quietly become half an hour old.
  const reach = Math.min(all.length, n * PACE_WINDOW_REACH);
  let laps = [], keep = [], cutSec = 0;
  for (let take = Math.min(n, all.length); take <= reach; take++) {
    laps = all.slice(-take);
    ({ keep, cutSec } = paceEligible(laps));
    if (keep.reduce((c, k) => c + (k ? 1 : 0), 0) >= n) break;
  }

  const use = laps.filter((_, i) => keep[i]);
  const mean = a => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) / 1000;
  const sorted = [...use].sort((a, b) => a - b);
  return {
    ...base,
    laps,
    outliers: keep.map(k => !k),
    avgSec: mean(use),
    bestSec: sorted[0],
    worstSec: sorted[sorted.length - 1],
    // The lap the figures are read to, and the lap the car actually just did —
    // the same number unless the newest lap was struck.
    lastSec: use[use.length - 1],
    lastRawSec: laps[laps.length - 1],
    lastIsOut: !keep[keep.length - 1],
    counted: use.length,
    ignored: laps.length - use.length,
    cutSec: Math.round(cutSec * 1000) / 1000
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
//
// A NEGATIVE number is not a negative time: the vendor's "Time" type carries
// a difference in LAPS when it goes below zero (Timing Data Protocol v1.34,
// general data structure). Lapped cars are the normal case for that, and
// blanking the cell — what a plain sign test does — hides exactly the number
// a pit wall reads first.
export function fmtGapUs(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (n < 0) {
    const laps = Math.round(-n);
    return `${laps} lap${laps === 1 ? '' : 's'}`;
  }
  if (n === 0) return '—';
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
