// End-to-end check of the tyre warmers on the station's tyre card. Boots the
// server, seeds a race, opens the warmer popover from the icon in the card's
// heading exactly as a mouse would, sets how many warmers the garage has, puts
// a set in one, and asserts each move reaches the shared state.
//
// The renderer is an ES module, so its `state` is not reachable from the page
// scope — shared state is read over this harness's own WebSocket instead, which
// is also the honest test: it proves the change really left the station.
//
// Run with:  npx electron test/warmer-check.cjs [outputDir]
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
const check = (name, ok) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
};

app.whenReady().then(async () => {
  appProtocol.installHandler(root);
  ipcMain.handle('start-server', async () => {
    const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'server.js')));
    const info = startServer({ dataFile: null, port: 8490 }); // 8485-8489 belong to the other checks
    return { port: info.port, ips: info.ips }; // only cloneable fields cross IPC
  });
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));
  ipcMain.handle('list-backups', () => []);

  // Visible windows: capturePage on a hidden one hands back the last painted
  // frame, which would quietly screenshot the card before the popover opened.
  const mkWin = (show = false) => new BrowserWindow({
    show, width: 1500, height: 1000,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });

  // The pit wall window starts the server.
  const wall = mkWin();
  await wall.loadURL('app://root/renderer/pitwall.html');
  await wall.webContents.executeJavaScript(
    "localStorage.setItem('serverPort','8490');" +
    "localStorage.setItem('serverIp','127.0.0.1');" +
    "localStorage.setItem('carId','1'); true"
  );
  await wait(1500);

  // Our own connection, so shared state can be read independently of any window.
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:8490');
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
  const warmers = () => shared.cars['1'].tyreWarmers || [];

  send({ type: 'startRace' });
  for (let i = 0; i < 20; i++) send({ type: 'lap', carId: '1', lapSec: 104.2 });
  await until(() => shared.cars['1'].state.totalLaps >= 20);

  const station = mkWin(true);
  const consoleErrors = [];
  station.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  await station.loadURL('app://root/renderer/station.html');
  await wait(3000);
  const js = s => station.webContents.executeJavaScript(s);

  // The icon is in the tyre card's heading, and it says nothing is set up yet.
  const badge0 = await js("document.getElementById('warmer-badge').textContent");
  check('the tyre card carries a warmer button', badge0 === '—');
  check('the popover starts closed',
    await js("document.getElementById('warmer-pop').classList.contains('hidden')"));

  // Open it the way a mouse does.
  await js("document.getElementById('btn-warmers').click(); true");
  await wait(400);
  check('clicking the icon opens the warmers',
    !(await js("document.getElementById('warmer-pop').classList.contains('hidden')")));

  // No warmers yet, so the box says how to set them up rather than showing rows.
  const emptyText = await js("document.getElementById('warmer-pop').innerText.replace(/\\s+/g,' ')");
  check('an unset garage is told what to press', /No warmers/i.test(emptyText));

  // Press + four times: four boxes, and the app knows it.
  for (let i = 0; i < 4; i++) {
    await js("document.querySelector('#warmer-pop [data-act=\"more\"]').click(); true");
    await wait(220);
  }
  const grew = await until(() => warmers().length === 4);
  check('pressing + sets how many warmers the garage has', grew);
  const rows = await js("document.querySelectorAll('#warmer-pop .wrow').length");
  check('every warmer gets a row', rows === 4);

  // Put a set in the first one, through its own picker.
  const chosen = await js(`(() => {
    const sel = document.querySelector('#warmer-pop select[data-warmer]');
    const opt = [...sel.options].find(o => o.value);
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.value;
  })()`);
  const loaded = await until(() => warmers()[0].setId === chosen);
  check('a set picked in a warmer reaches the shared state', loaded);
  await wait(500);
  check('the badge counts what is hot',
    (await js("document.getElementById('warmer-badge').textContent")) === '1/4');

  // The set that is in a box is no longer offered by the others.
  const offeredElsewhere = await js(`(() => {
    const sels = [...document.querySelectorAll('#warmer-pop select[data-warmer]')].slice(1);
    return sels.some(s => [...s.options].some(o => o.value === '${chosen}'));
  })()`);
  check('a set already in a warmer is not offered to the others', offeredElsewhere === false);

  // The set on the car is never in the list at all.
  const onCar = shared.cars['1'].state.currentTyreSetId;
  const offersFitted = await js(`(() => {
    const sels = [...document.querySelectorAll('#warmer-pop select[data-warmer]')];
    return sels.some(s => [...s.options].some(o => o.value === '${onCar}'));
  })()`);
  check('the set on the car is never offered', offersFitted === false);

  station.show();
  station.focus();
  await wait(800);
  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'tyre-warmers.png'), img.toPNG()));
  console.log('   captured tyre-warmers.png');

  // Taking it out again, from the row's own button.
  await js("document.querySelector('#warmer-pop [data-empty]').click(); true");
  const emptied = await until(() => warmers()[0].setId === null);
  check('the X takes the rubber back out', emptied);

  // Clicking off the card closes it.
  await js("document.body.click(); true");
  await wait(300);
  check('clicking away closes the warmers',
    await js("document.getElementById('warmer-pop').classList.contains('hidden')"));

  // A second station sees the same boxes — the warmers are shared, not local.
  const station2 = mkWin();
  await station2.loadURL('app://root/renderer/station.html');
  await wait(2500);
  const badge2 = await station2.webContents.executeJavaScript(
    "document.getElementById('warmer-badge').textContent");
  check('a second station sees the same warmers', badge2 === '0/4');

  check('no console errors on the station', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('   ' + consoleErrors.join('\n   '));

  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASS');
  app.exit(failed.length ? 1 : 0);
});
