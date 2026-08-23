// Layout check for the stop-lifecycle controls on a narrow station window.
// The #stop-actions container used to carry the .actions class, which is a
// flex ROW — so the "Service running" note and the button rows the JS injects
// as stacked blocks were laid out side by side instead, stretched to one
// giant equal height. This drives a real stop to IN PIT through the UI and
// asserts the note sits ABOVE the buttons and nothing is stretched tall.
//
// Run with:  npx electron test/stop-actions-check.cjs [outputDir]
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
    const info = startServer({ dataFile: null, port: 8492 }); // 8485-8491 belong to the other checks
    return { port: info.port, ips: info.ips };
  });
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));
  ipcMain.handle('list-backups', () => []);

  // The wall starts the server; the station under test is deliberately NARROW —
  // the width where the row-not-stack bug showed up.
  const wall = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });
  await wall.loadURL('app://root/renderer/pitwall.html');
  await wall.webContents.executeJavaScript(
    "localStorage.setItem('serverPort','8492');" +
    "localStorage.setItem('serverIp','127.0.0.1');" +
    "localStorage.setItem('carId','1'); true"
  );
  await wait(1500);

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

  send({ type: 'startRace' });
  for (let i = 0; i < 12; i++) send({ type: 'lap', carId: '1', lapSec: 104.2 });
  await until(() => shared.cars['1'].state.totalLaps >= 12);

  const station = new BrowserWindow({
    show: false, width: 420, height: 1100,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });
  const consoleErrors = [];
  station.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  await station.loadURL('app://root/renderer/station.html');
  await wait(3000);
  const js = s => station.webContents.executeJavaScript(s);

  // Walk the real lifecycle with the real buttons: SEND → BOX → CAR IN PIT.
  const act = a => js(`(() => {
    const b = document.querySelector('#stop-actions [data-act="${a}"]');
    if (b) b.click();
    return !!b;
  })()`);
  check('SEND is on screen', await act('send'));
  await until(() => shared.cars['1'].stop?.status === 'sent');
  await wait(400);
  check('BOX BOX is on screen', await act('box'));
  await until(() => shared.cars['1'].stop?.status === 'box');
  await wait(400);
  // No live feed in this harness, so the manual CAR IN PIT LANE button must be there.
  check('CAR IN PIT LANE is on screen', await act('inpit'));
  const arrived = await until(() => shared.cars['1'].state.inPit);
  check('the car is marked in the pit lane', arrived);
  await wait(600);

  // The geometry the bug broke: the note must sit fully ABOVE the button row,
  // and neither may be stretched to the other's height.
  const geo = await js(`(() => {
    const box = document.getElementById('stop-actions');
    const note = box.querySelector('.feedstate');
    const row = box.querySelector('.actions');
    const done = box.querySelector('[data-act="done"]');
    const ontrack = box.querySelector('[data-act="ontrack"]');
    if (!note || !row || !done || !ontrack) return null;
    const r = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
    return { note: r(note), row: r(row), done: r(done), ontrack: r(ontrack) };
  })()`);
  check('note and both buttons are rendered', !!geo);
  if (geo) {
    console.log(`   note ${Math.round(geo.note.height)}px tall, buttons ${Math.round(geo.done.height)}px / ${Math.round(geo.ontrack.height)}px`);
    check('the note sits above the buttons, not beside them', geo.row.top >= geo.note.bottom);
    // One dashed line of 12px text: side by side it stretched past 200px.
    check('the note is a slim line', geo.note.height < 80);
    check('the buttons are buttons, not banners', geo.done.height < 120 && geo.ontrack.height < 120);
  }

  await js("document.getElementById('stop-actions').scrollIntoView({block:'center'}); true");
  station.showInactive();
  await wait(1200);
  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'stop-actions-inpit.png'), img.toPNG()));
  station.hide();
  console.log('   captured stop-actions-inpit.png');

  check('no console errors on the station', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('   ' + consoleErrors.join('\n   '));

  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASS');
  app.exit(failed.length ? 1 : 0);
});
