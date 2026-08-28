// End-to-end check of the stint plan panel when it CANNOT build a plan.
// Every one of these used to be a button that did nothing and a panel that sat
// blank, which is what "I can't generate a plan" looks like from the garage:
//   · no link to the pit wall (the documented way to work ahead of the event)
//   · a link, but an empty driver table
//   · a race with no length
//   · settings that make the stints so short the plan cannot reach the flag
// The panel has to say which, and the buttons have to say it too.
//
// Run with:  npx electron test/plan-blocked-check.cjs [outputDir]
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
const check = (name, ok, note) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${note ? '  (' + note + ')' : ''}`);
};

// Port 8490: 8485-8489 belong to the other suites, never collide with them.
const PORT = 8490;

app.whenReady().then(async () => {
  appProtocol.installHandler(root);
  let server = null;
  ipcMain.handle('start-server', async () => ({ port: PORT, ips: ['127.0.0.1'] }));
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));
  ipcMain.handle('list-backups', () => []);

  const station = new BrowserWindow({
    show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });
  const consoleErrors = [];
  station.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  await station.loadURL('app://root/renderer/station.html');
  await station.webContents.executeJavaScript(
    `localStorage.setItem('serverPort','${PORT}');` +
    "localStorage.setItem('serverIp','127.0.0.1');" +
    "localStorage.setItem('carId','1'); true");
  await station.reload();
  await wait(3000);
  const js = s => station.webContents.executeJavaScript(s);

  // A real alert() is a native modal that would hold the run open. Record what
  // it says instead — the message IS the thing under test.
  await js(`window.__said = []; window.alert = m => window.__said.push(String(m)); true`);
  const said = () => js("window.__said.join(' | ')");
  const clear = () => js("window.__said = []; true");
  const body = () => js("document.getElementById('plan-out').innerText.replace(/\\s+/g,' ').trim()");

  // ---- 1. no pit wall at all ------------------------------------------------
  await js("document.getElementById('btn-plan').click(); true");
  await wait(600);
  const noLink = await body();
  console.log(`   with no wall: "${noLink.slice(0, 110)}…"`);
  check('the panel says why it is empty instead of being empty',
    /no link to the pit wall/i.test(noLink));
  check('and says where a plan actually lives', /lives on the pit wall/i.test(noLink));

  await clear();
  await js("document.getElementById('btn-plan-generate').click(); true");
  await wait(300);
  const genSaid = await said();
  check('GENERATE says why it will not run', /no link to the pit wall/i.test(genSaid));
  await clear();
  await js("document.getElementById('btn-plan-replan').click(); true");
  await wait(300);
  check('REPLAN says why it will not run', /no link to the pit wall/i.test(await said()));
  // A queued patch would land on the wall the moment it answered and overwrite
  // whatever plan was already there — the refusal has to be a real stop.
  check('and neither queues a plan for when the wall answers',
    (await js("document.getElementById('plan-duration').value")) === '');

  // ---- 2. the wall comes up under an open panel -----------------------------
  const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'server.js')));
  server = startServer({ dataFile: null, port: PORT });
  await server.listening;
  await wait(4000);
  const filled = await js(`(() => ({
    dur: document.getElementById('plan-duration').value,
    body: document.getElementById('plan-out').innerText.replace(/\\s+/g,' ').trim()
  }))()`);
  console.log(`   after the wall answered: duration="${filled.dur}" body="${filled.body.slice(0, 80)}…"`);
  check('the open panel fills its timeline once the wall answers', filled.dur === '24', filled.dur);
  check('and stops saying there is no link', !/no link to the pit wall/i.test(filled.body));

  // Our own link, to drive the shared state directly.
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
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
  await until(() => !!shared.cars['1']);

  // ---- 3. a link, but nobody in the driver table ----------------------------
  send({ type: 'update', carId: '1', patch: { drivers: [] } });
  await until(() => shared.cars['1'].drivers.length === 0);
  await wait(800);
  const noCrew = await body();
  console.log(`   with no crew: "${noCrew.slice(0, 110)}…"`);
  check('an empty driver table is named, not left as "press GENERATE"',
    /driver table is empty/i.test(noCrew) && !/press GENERATE/i.test(noCrew));
  await clear();
  await js("document.getElementById('btn-plan-generate').click(); true");
  await wait(500);
  check('GENERATE refuses an empty driver table by name',
    /driver table is empty/i.test(await said()));
  // The old code threw here and the click died silently.
  check('and it does not throw doing it', consoleErrors.length === 0,
    consoleErrors.join(' | '));
  check('nothing was written to the shared plan',
    !shared.cars['1'].plan?.stints?.length);

  // ---- 4. the crew is back: it builds --------------------------------------
  const { defaultCar } = await import(pathToFileURL(path.join(root, 'shared', 'model.js')));
  send({ type: 'update', carId: '1', patch: { drivers: defaultCar('1', 1).drivers } });
  await until(() => shared.cars['1'].drivers.length === 4);
  await wait(600);
  await clear();
  await js("document.getElementById('btn-plan-generate').click(); true");
  const built = await until(() => shared.cars['1'].plan?.stints?.length > 2);
  check('with a crew and a race length it builds', built,
    String(shared.cars['1'].plan?.stints?.length));
  check('and says nothing while doing it', (await said()) === '');

  // ---- 5. a plan that cannot reach the flag --------------------------------
  // Safety fuel equal to the tank leaves nothing usable, so every stint comes
  // out one lap long and the plan runs out of rows hours before the flag. It
  // used to be handed over looking like a finished plan.
  send({ type: 'update', carId: '1', patch: {
    config: { safetyFuelL: shared.cars['1'].config.tankLiters }
  } });
  await until(() => shared.cars['1'].config.safetyFuelL === shared.cars['1'].config.tankLiters);
  await wait(400);
  await js("document.getElementById('btn-plan-generate').click(); true");
  await until(() => !!shared.cars['1'].plan?.truncated);
  await wait(800);
  const cut = await body();
  console.log(`   truncated: "${cut.slice(0, 130)}…"`);
  check('a plan that stops short of the flag says so', /stops at .* of /i.test(cut));
  check('and points at the settings that caused it', /safety fuel/i.test(cut));

  station.showInactive();
  await wait(1200);
  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'plan-blocked.png'), img.toPNG()));
  station.hide();
  console.log('   captured plan-blocked.png');

  check('no console errors on the station', consoleErrors.length === 0,
    consoleErrors.join(' | '));

  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASS');
  app.exit(failed.length ? 1 : 0);
});
