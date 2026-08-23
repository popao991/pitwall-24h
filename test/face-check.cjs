// End-to-end check of the card faces and the ⤢ focus overlay on a real station
// window. The mechanism has one invariant that matters more than anything it
// shows: a face swap must NOT change the card's height. The station auto-fits
// the whole page by summing panel heights, so a face that grew the card would
// re-zoom the entire UI under the engineer's hands — at night, mid-stint.
//
// So this drives the real tabs with real clicks and measures the real layout.
//
// Run with:  npx electron test/face-check.cjs [outputDir]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || __dirname;
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
  ipcMain.handle('start-server', async () => {
    const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'server.js')));
    // 8485-8487 smoke.mjs, 8488 plan-edit-check, 8489 brake-rack-check,
    // 8490 warmer-check — never collide with a harness already using one.
    const info = startServer({ dataFile: null, port: 8491 });
    return { port: info.port, ips: info.ips };
  });
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));
  ipcMain.handle('list-backups', () => []);

  // Visible windows: a hidden BrowserWindow can report a layout that never
  // happened, and every assertion here is a measurement.
  const mkWin = () => new BrowserWindow({
    show: true, width: 1600, height: 1000,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });

  const wall = mkWin();
  await wall.loadURL('app://root/renderer/pitwall.html');
  await wall.webContents.executeJavaScript(
    "localStorage.setItem('serverPort','8491');" +
    "localStorage.setItem('serverIp','127.0.0.1');" +
    "localStorage.setItem('carId','1');" +
    // Start from a clean slate: a face remembered by an earlier run would make
    // the "boots on the front face" assertion pass or fail at random.
    "Object.keys(localStorage).filter(k => k.startsWith('cardFace:')).forEach(k => localStorage.removeItem(k)); true"
  );
  await wait(1500);

  const WebSocket = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:8491');
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

  // A race with laps on it, so the PACE card has something to draw.
  send({ type: 'startRace' });
  for (let i = 0; i < 12; i++) send({ type: 'lap', carId: '1', lapSec: 104.2 + (i % 3) * 0.4 });
  await until(() => shared.cars['1'].state.totalLaps >= 12);

  const station = mkWin();
  const consoleErrors = [];
  station.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  await station.loadURL('app://root/renderer/station.html');
  await wait(3000);
  const js = s => station.webContents.executeJavaScript(s);

  // ---- the strip is built from the markup ---------------------------------

  const tabs = await js(`(() => {
    const s = document.querySelector('#card-pace .facetabs');
    return s ? [...s.children].map(b => b.textContent) : null;
  })()`);
  check('the pace card grew a face strip', Array.isArray(tabs) && tabs.length === 2,
    tabs ? tabs.join(' / ') : 'no strip');

  const bootFace = await js(
    "document.querySelector('#card-pace .face.on')?.dataset.face || null");
  check('it boots on the front face', bootFace === 'now', String(bootFace));

  // ---- the invariant: a face swap must not move the card -------------------

  const before = await js(`(() => {
    const p = document.getElementById('card-pace');
    const row = p.parentElement;
    return {
      card: p.offsetHeight,
      row: row.offsetHeight,
      col: p.closest('.col').offsetHeight,
      zoom: Number(document.body.style.zoom) || 1
    };
  })()`);

  await js(`[...document.querySelectorAll('#card-pace .facetabs button')]
    .find(b => b.dataset.face === 'sectors').click(); true`);
  await wait(700);

  const after = await js(`(() => {
    const p = document.getElementById('card-pace');
    const row = p.parentElement;
    return {
      face: p.querySelector('.face.on')?.dataset.face,
      card: p.offsetHeight,
      row: row.offsetHeight,
      col: p.closest('.col').offsetHeight,
      zoom: Number(document.body.style.zoom) || 1,
      pinned: p.style.height
    };
  })()`);

  check('the tab swapped the face', after.face === 'sectors', String(after.face));
  check('the card kept its height', after.card === before.card,
    `${before.card} -> ${after.card}`);
  check('the gauge row kept its height', after.row === before.row,
    `${before.row} -> ${after.row}`);
  check('the column kept its height', after.col === before.col,
    `${before.col} -> ${after.col}`);
  check('the page did not re-zoom', after.zoom === before.zoom,
    `${before.zoom} -> ${after.zoom}`);
  check('the card is pinned to a real height', /^\d+px$/.test(after.pinned), after.pinned);

  // The sectors face has to say something even with no feed connected — an
  // empty card is indistinguishable from a broken one at 3am.
  const sectText = await js(
    "document.querySelector('#card-pace .face[data-face=\"sectors\"]').innerText.replace(/\\s+/g,' ').trim()");
  check('the sectors face explains itself with the feed off',
    /live timing is off/i.test(sectText), sectText.slice(0, 60));

  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'face-sectors.png'), img.toPNG()));
  console.log('   captured face-sectors.png');

  // ---- and back --------------------------------------------------------

  await js(`[...document.querySelectorAll('#card-pace .facetabs button')]
    .find(b => b.dataset.face === 'now').click(); true`);
  await wait(700);
  const back = await js(`(() => {
    const p = document.getElementById('card-pace');
    return { face: p.querySelector('.face.on')?.dataset.face, card: p.offsetHeight, pinned: p.style.height };
  })()`);
  check('the front face comes back', back.face === 'now', String(back.face));
  check('the front face is not left pinned', back.pinned === '', `"${back.pinned}"`);
  check('the card is the same height it started', back.card === before.card,
    `${before.card} -> ${back.card}`);

  // ---- the choice is this screen's own, and it survives a reload ----------

  await js(`[...document.querySelectorAll('#card-pace .facetabs button')]
    .find(b => b.dataset.face === 'sectors').click(); true`);
  await wait(400);
  const stored = await js("localStorage.getItem('cardFace:1:card-pace')");
  check('the choice is remembered locally', stored === 'sectors', String(stored));

  const pushed = await until(() => JSON.stringify(shared).includes('card-pace'), 800);
  check('the choice never reaches the shared state', !pushed);

  await station.webContents.reload();
  await wait(3000);
  const afterReload = await js(
    "document.querySelector('#card-pace .face.on')?.dataset.face || null");
  check('the remembered face comes back after a reload', afterReload === 'sectors',
    String(afterReload));

  // ---- ⤢ focus ------------------------------------------------------------

  const colBefore = await js(
    "document.getElementById('card-pace').closest('.col').offsetHeight");
  await js("document.querySelector('#card-pace .facezoom').click(); true");
  await wait(600);
  const zoomed = await js(`(() => {
    const p = document.getElementById('card-pace');
    return {
      inBox: p.parentElement.id === 'focus-box',
      overlayUp: !document.getElementById('focus-overlay').classList.contains('hidden'),
      expanded: p.classList.contains('expanded'),
      ph: !!document.querySelector('.focus-ph'),
      phH: document.querySelector('.focus-ph')?.offsetHeight || 0
    };
  })()`);
  check('⤢ moves the card into the overlay', zoomed.inBox && zoomed.overlayUp && zoomed.expanded);
  check('a placeholder holds its place in the column', zoomed.ph && zoomed.phH > 0,
    zoomed.phH + 'px');

  const colDuring = await js(
    "document.querySelector('.focus-ph').closest('.col').offsetHeight");
  check('the column behind is undisturbed', colDuring === colBefore,
    `${colBefore} -> ${colDuring}`);

  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'face-expanded.png'), img.toPNG()));
  console.log('   captured face-expanded.png');

  // Esc puts it back where it came from.
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
  await wait(600);
  const home = await js(`(() => {
    const p = document.getElementById('card-pace');
    return {
      parent: p.parentElement.className,
      overlayUp: !document.getElementById('focus-overlay').classList.contains('hidden'),
      ph: !!document.querySelector('.focus-ph'),
      col: p.closest('.col').offsetHeight
    };
  })()`);
  check('Esc brings the card home', /gaugerow/.test(home.parent) && !home.overlayUp && !home.ph,
    home.parent);
  check('the column is the height it was before ⤢', home.col === colBefore,
    `${colBefore} -> ${home.col}`);

  check('no console errors on the station', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('   ' + consoleErrors.join('\n   '));

  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASS');
  app.exit(failed.length ? 1 : 0);
});
