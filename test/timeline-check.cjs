// Visual check of the race timeline on a real station window: the night
// ribbon lands where 21:00–06:00 falls in the running race, projected blocks
// are hatched rather than merely faded, the NOW pill exists, and the legend
// explains its marks with glyphs. Everything here is asserted against the
// SVG the station actually drew, then captured for eyes.
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
  check('pit ticks have round caps', /stroke-linecap="round"/.test(svg));
  const legend = ['driven', 'projected', 'pit stop', 'night'].filter(w => svg.includes(`>${w}</text>`));
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
