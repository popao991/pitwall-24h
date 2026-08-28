// Visual check of the race timeline on a real station window: the night
// ribbon lands where 21:00–06:00 falls in the running race, projected blocks
// are hatched rather than merely faded, every pit stop is marked on the bar
// and priced above it, the NOW pill exists, and the legend explains its marks
// with glyphs. Everything here is asserted against the SVG the station
// actually drew, then captured for eyes.
//
// Run with:  npx electron test/timeline-check.cjs [outputDir]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || __dirname;
// Own userData per run: two checks sharing the default profile fight over the
// disk cache lock, and the loser dies at startup with nothing on stdout.
app.setPath('userData', path.join(require('node:os').tmpdir(), `pitwall-timeline-check-${process.pid}`));
const appProtocol = require(path.join(root, 'app-protocol.cjs'));
appProtocol.registerScheme();
app.on('window-all-closed', () => {});

setTimeout(() => { console.log('GLOBAL TIMEOUT'); app.exit(2); }, 120000);
const wait = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? '  (' + detail + ')' : ''}`);
};

app.whenReady().then(async () => {
  appProtocol.installHandler(root);
  // Only a pit wall window asks for the server, and this check opens none —
  // start it here or the station's websocket waits forever.
  // 8485-8487 smoke.mjs, 8488 plan-edit-check, 8489 brake-rack-check,
  // 8490 warmer-check, 8491 face-check — this one owns 8492.
  const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'server.js')));
  const info = startServer({ dataFile: null, port: 8492 });
  ipcMain.handle('start-server', () => ({ port: info.port, ips: info.ips }));
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));
  ipcMain.handle('list-backups', () => []);

  // Visible window: a hidden BrowserWindow can report a layout that never
  // happened, and clientWidth feeds the SVG geometry under test.
  const station = new BrowserWindow({
    show: true, width: 1600, height: 1000,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });
  const consoleErrors = [];
  station.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  await station.loadURL('app://root/renderer/station.html');
  await station.webContents.executeJavaScript(
    "localStorage.setItem('serverPort','8492');" +
    "localStorage.setItem('serverIp','127.0.0.1');" +
    // Pinned dark, so the night board is what the first capture shows whatever
    // hour the check is run at — on AUTO it would follow the sun and the two
    // captures could come out the same.
    "localStorage.setItem('themeMode','dark');" +
    "localStorage.setItem('carId','1'); true"
  );
  await station.webContents.reload();
  await wait(2500);
  const js = s => station.webContents.executeJavaScript(s);

  const WebSocket = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:8492');
  await new Promise(r => ws.on('open', r));
  let shared = null;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'state') shared = m.state;
  });
  const send = o => ws.send(JSON.stringify(o));
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (shared && fn()) return true;
      await wait(60);
    }
    return false;
  };

  // A running 24h race: the default duration spans a full night, which is
  // exactly what the ribbon has to find.
  send({ type: 'startRace' });
  for (let i = 0; i < 8; i++) send({ type: 'lap', carId: '1', lapSec: 104.5 });
  await until(() => shared.cars['1'].state.totalLaps >= 8);
  await wait(1600); // one render tick with the race on

  const svg = await js("document.getElementById('timeline').innerHTML");

  check('the hatch pattern is defined once', (svg.match(/id="tl-hatch"/g) || []).length === 1);
  check('projected blocks are hatched', /url\(#tl-hatch\)/.test(svg));
  check('the night ribbon is on the bar', /var\(--tl-night\)/.test(svg));
  check('NOW is a pill, not floating text', /rx="8\.5"/.test(svg) && />NOW<\/text>/.test(svg));
  const legend = ['driven', 'projected', 'in the pit lane · time above', 'night']
    .filter(w => svg.includes(`>${w}</text>`));
  check('the legend explains its marks', legend.length === 4, legend.join(', '));
  check('the old sentence legend is gone', !/solid = driven/.test(svg));

  // The ribbon must sit where the wall clock says night is: the first band
  // edge computed here has to match a 21:00 or 06:00 boundary (or the race
  // start, if it starts at night).
  const band = await js(`(() => {
    const svg = document.getElementById('timeline');
    const r = [...svg.querySelectorAll('rect')].find(n => (n.getAttribute('style') || '').includes('--tl-night'));
    if (!r) return null;
    return { x: +r.getAttribute('x'), w: +r.getAttribute('width'), W: svg.clientWidth };
  })()`);
  check('a night band has real width', band && band.w > 4 && band.x >= 0 && band.x <= band.W,
    band ? `x=${Math.round(band.x)} w=${Math.round(band.w)} of ${band.W}` : 'no band');

  // ---- the pit-stop lane -------------------------------------------------
  // Stops in the past are the whole point of the lane, and nothing a client
  // can send puts one there: a stop applies at the instant it is asked for.
  // So the stint sheet is written directly — two stops the feed timed (one of
  // them a long one) and a third the engineer applied by hand, which the feed
  // never saw and which can only be priced by what it was planned to take.
  //
  // Flags the same way: the race is given a safety car the second stop was
  // made under, a Code 60 later on, and a red flag that is still out — the
  // one condition the server is asked to call for real, so the log it keeps
  // and the clocks that stop with the field are exercised end to end.
  const t0 = Date.now() - 100 * 60e3;
  const drv = shared.cars['1'].drivers;
  send({ type: 'race', patch: { durationH: 4, startMs: t0 } });
  send({ type: 'fcy', mode: 'red' });
  const logged = await until(() => shared.race.flagLog?.some(p => p.id === 'red' && p.toMs == null));
  check('a red flag called by hand is logged as an open period', logged,
    JSON.stringify(shared.race.flagLog));
  send({ type: 'race', patch: { flagLog: [
    { id: 'sc', fromMs: t0 + 58 * 60e3, toMs: t0 + 66 * 60e3, source: 'feed' },
    { id: 'code60', fromMs: t0 + 75 * 60e3, toMs: t0 + 80 * 60e3, source: 'feed' },
    { id: 'red', fromMs: t0 + 94 * 60e3, toMs: null, source: 'manual' }
  ] } });
  send({ type: 'update', carId: '1', patch: {
    stintHistory: [
      { startMs: t0, endMs: t0 + 32 * 60e3, driverId: drv[0].id, laps: 18, pitSec: 68.4, stationarySec: 41.2, estStationarySec: 63 },
      { startMs: t0 + 32 * 60e3, endMs: t0 + 63 * 60e3, driverId: drv[1].id, laps: 17, pitSec: 152, stationarySec: 126, estStationarySec: 70 },
      { startMs: t0 + 63 * 60e3, endMs: t0 + 88 * 60e3, driverId: drv[0].id, laps: 14, pitSec: null, stationarySec: null, estStationarySec: 57 }
    ],
    // A tank that runs out before the flag, so the bar also carries stops
    // still to come — the ones priced as estimates rather than facts.
    state: { stintStartMs: t0 + 88 * 60e3, fuelLiters: 25 }
  } });
  await until(() => shared.cars['1'].stintHistory.length === 3 && shared.race.flagLog?.length === 3);
  await wait(1600); // one render tick with the stops on the sheet

  const readBar = `(() => {
    const svg = document.getElementById('timeline');
    const W = svg.clientWidth;
    const rects = [...svg.querySelectorAll('rect')];
    const well = rects.find(n => (n.getAttribute('style') || '').includes('--well'));
    const barTop = +well.getAttribute('y'), barBottom = barTop + +well.getAttribute('height');
    // Blocks ON the bar (inside its rows) are told from legend glyphs and
    // chips by where they sit; a legend glyph is below the bar, a chip above.
    const onBar = n => +n.getAttribute('y') > barTop && +n.getAttribute('y') < barBottom && n.parentNode.nodeName === 'g';
    const box = n => ({ x: +n.getAttribute('x'), w: +n.getAttribute('width'), y: +n.getAttribute('y'), h: +n.getAttribute('height') });
    return {
      W, barTop,
      lanes: rects.filter(n => onBar(n) && /--tl-lane|--amber/.test(n.getAttribute('style') || '')).map(box),
      reds: rects.filter(n => onBar(n) && /--red/.test(n.getAttribute('style') || '')).map(box),
      // The flag row: bands with their own corner radius, above the chips.
      flags: rects.filter(n => n.getAttribute('rx') === '3' && +n.getAttribute('y') < barTop).map(box),
      chips: [...svg.querySelectorAll('g > rect[rx="4"]')].map(box),
      texts: [...svg.querySelectorAll('g > text')].map(n => n.textContent),
      notes: [...svg.querySelectorAll('title')].map(n => n.textContent),
      held: !document.getElementById('stint-held').hidden,
      stint: document.getElementById('stint-time').textContent
    };
  })()`;
  const tl = await js(readBar);

  check('every stop is a block on the bar', tl.lanes.length >= 4, `${tl.lanes.length} lane blocks`);
  check('a one-minute stop is still visible on a four-hour bar', tl.lanes.every(l => l.w >= 6),
    tl.lanes.map(l => Math.round(l.w)).join(' '));
  check('the flag is not marked as a stop', !tl.lanes.some(l => l.x + l.w >= tl.W - 1),
    `rightmost ${Math.round(Math.max(...tl.lanes.map(l => l.x + l.w)))} of ${tl.W}`);
  check('a timed stop is priced above the bar', tl.texts.includes('68s'), tl.texts.join(' '));
  check('a long stop reads in minutes, not seconds', tl.texts.includes('2:32'));
  check('an untimed stop falls back to the planned figure', tl.texts.includes('57s'));
  check('stops still to come are marked as estimates', tl.texts.some(t => t.startsWith('~')),
    tl.texts.join(' '));
  const chipBottom = Math.max(...tl.chips.map(c => c.y + c.h), 0);
  check('the times sit above the bar', chipBottom > 0 && chipBottom <= tl.barTop,
    `chips end ${chipBottom}, bar starts ${tl.barTop}`);
  check('a block says what the stop cost on hover',
    tl.notes.some(n => /^Stop 1 · .*68\.4 s in the lane, 41\.2 s stationary$/.test(n)),
    tl.notes[0] || 'no notes');
  check('a hand-applied stop says the feed never timed it',
    tl.notes.some(n => /did not time this stop/.test(n)));

  // ---- flags on the bar --------------------------------------------------
  check('every flag period has a band in the flag row', tl.flags.length === 3, `${tl.flags.length} bands`);
  const flagBottom = Math.max(...tl.flags.map(f => f.y + f.h), 0);
  const chipTop = Math.min(...tl.chips.map(c => c.y), Infinity);
  check('the flag row sits above the stop chips', flagBottom <= chipTop, `flags end ${flagBottom}, chips start ${chipTop}`);
  check('a band is labelled with type and length', tl.texts.includes('SC 8m') && tl.texts.includes('RED 6m'),
    tl.texts.filter(t => /^(SC|FCY|RED) /.test(t)).join(', '));
  check('Code 60 is called FCY on the bar', tl.texts.includes('FCY 5m') && !tl.texts.some(t => /C60|CODE/.test(t)));
  check('a stop under the safety car says so on hover',
    tl.notes.some(n => /^Safety car · .* · 8m · from the feed · we stopped under it$/.test(n)),
    tl.notes.find(n => /^Safety car/.test(n)) || 'no note');
  check('the running red flag reads as still out',
    tl.notes.some(n => /^Red flag · .* – still out · 6m · called by hand$/.test(n)),
    tl.notes.find(n => /^Red flag ·/.test(n)) || 'no note');
  check('the running stint is cut into a red block', tl.reds.length === 1 && tl.reds[0].w > 4,
    JSON.stringify(tl.reds));
  check('the red block runs up to NOW', tl.reds.length === 1 &&
    Math.abs((tl.reds[0].x + tl.reds[0].w) - (100 / 240) * tl.W) < 4,
    tl.reds.length ? `ends ${Math.round(tl.reds[0].x + tl.reds[0].w)}, NOW at ${Math.round((100 / 240) * tl.W)}` : 'no block');

  // ---- the stint clock under red ------------------------------------------
  // The stint began 12 minutes ago and the red flag 6 minutes ago: the clock
  // holds at six minutes, says so, and does not move between two ticks.
  check('the stint clock stands still under red', tl.held && /^6:0\d$/.test(tl.stint), tl.stint);
  await wait(2200);
  const later = await js(readBar);
  check('two ticks later it has not moved', later.stint === tl.stint && later.held, `${tl.stint} → ${later.stint}`);
  send({ type: 'fcy', mode: 'auto' });
  await until(() => shared.race.flagLog.every(p => p.toMs > 0));
  check('back to green closes the period on the log', shared.race.flagLog[2].toMs > 0);
  await wait(2200);
  const moving = await js(readBar);
  check('and the stint clock runs again', !moving.held && moving.stint !== tl.stint, `${tl.stint} → ${moving.stint}`);
  const svgFlags = await js("document.getElementById('timeline').innerHTML");
  check('the legend explains the flags', svgFlags.includes('>SC · FCY</text>') && svgFlags.includes('>red flag · stint clock held</text>'));
  // Back under red for the pictures: a held clock is what the bar is for.
  send({ type: 'fcy', mode: 'red' });
  await until(() => shared.race.flagLog.some(p => p.id === 'red' && p.toMs == null));
  send({ type: 'race', patch: { flagLog: [
    { id: 'sc', fromMs: t0 + 58 * 60e3, toMs: t0 + 66 * 60e3, source: 'feed' },
    { id: 'code60', fromMs: t0 + 75 * 60e3, toMs: t0 + 80 * 60e3, source: 'feed' },
    { id: 'red', fromMs: t0 + 94 * 60e3, toMs: null, source: 'manual' }
  ] } });
  await wait(1600);

  await js("document.querySelector('.timeline-wrap').scrollIntoView(); true");
  await wait(400);
  // getBoundingClientRect is already in zoomed viewport px on this Chromium —
  // capturePage takes the same space, so no zoom correction.
  const rect = await js(`(() => {
    const r = document.querySelector('.timeline-wrap').getBoundingClientRect();
    return { x: Math.max(0, Math.floor(r.x) - 8), y: Math.max(0, Math.floor(r.y) - 8),
             width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 };
  })()`);
  // The panel must never be squashed to its header by a tight column: the
  // wrap's real (unzoomed) height has to hold the whole chart.
  const squash = await js(`(() => {
    const w = document.querySelector('.timeline-wrap');
    return { wrap: w.offsetHeight, svg: document.getElementById('timeline').clientHeight };
  })()`);
  check('the chart is not squashed out of the panel', squash.wrap >= squash.svg,
    `wrap ${squash.wrap} vs svg ${squash.svg}`);
  await station.webContents.capturePage(rect).then(img =>
    fs.writeFileSync(path.join(outDir, 'timeline.png'), img.toPNG()));
  console.log('   captured timeline.png');

  // Same chart in daylight: every colour is a theme var, so the light board
  // must stay readable without a single code path knowing about it.
  await js("document.body.classList.add('light'); true");
  await wait(1400); // one render tick under the new theme
  await station.webContents.capturePage(rect).then(img =>
    fs.writeFileSync(path.join(outDir, 'timeline-light.png'), img.toPNG()));
  console.log('   captured timeline-light.png');
  await js("document.body.classList.remove('light'); true");

  check('no console errors on the station', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('   ' + consoleErrors.join('\n   '));

  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASS');
  app.exit(failed.length ? 1 : 0);
});
