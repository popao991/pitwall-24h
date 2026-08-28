// Can the hand-typed fuel figure in the plan card actually be typed?
//
// The plan lines are rebuilt from a key that carries their live text, and the
// notes underneath count down every second while a race runs — so before this
// was fixed the box was torn out from under the engineer's fingers a tick
// after they started typing. The check starts a race so the notes really do
// move, proves the lines are being rebuilt on the tick (an unfocused box is
// replaced), and only then types into one.
//
// Run with: npx electron test/typing-check.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');

const root = path.join(__dirname, '..');
const PORT = 8487;
const appProtocol = require(path.join(root, 'app-protocol.cjs'));
appProtocol.registerScheme();
app.on('window-all-closed', () => {});
setTimeout(() => { console.log('GLOBAL TIMEOUT'); app.exit(2); }, 120000);

app.whenReady().then(async () => {
  appProtocol.installHandler(root);
  const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'server.js')));
  startServer({ dataFile: null, port: PORT });
  ipcMain.handle('start-server', () => ({ port: PORT, ips: ['127.0.0.1'] }));
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));
  ipcMain.handle('list-backups', () => []);

  // The race has to be running, or none of the notes move and the rebuild the
  // fix is about never happens.
  await new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'wall' }));
      ws.send(JSON.stringify({ type: 'startRace' }));
      setTimeout(() => { ws.close(); res(); }, 400);
    });
    ws.on('error', e => { console.log('ws error', e.message); res(); });
  });

  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'preload.cjs') } });
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 3) console.log('[console]', msg); });

  await win.loadURL('app://root/renderer/index.html');
  await win.webContents.executeJavaScript(
    `localStorage.setItem('serverPort','${PORT}');localStorage.setItem('serverIp','127.0.0.1');localStorage.setItem('carId','1');true`);
  await win.loadURL('app://root/renderer/station.html');
  await new Promise(r => setTimeout(r, 3000));

  const out = await win.webContents.executeJavaScript(`(async () => {
    const log = [];
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const box = () => document.querySelector('#plan-lines input[data-fuelset]');
    const setBtn = document.querySelector('#plan-lines button[data-pin="fuel"][data-val="set"]');
    if (!setBtn) return { fail: 'no SET button — the plan lines never rendered' };
    setBtn.click();
    await wait(200);
    if (!box()) return { fail: 'SET pressed but no number box appeared' };

    // 1. the lines really are torn down and rebuilt while the race runs — an
    //    untouched box is replaced as soon as any live figure in them moves.
    //    On a real car, with seat-time counting down, that is every second;
    //    here it is however long the litres-to-add take to round over.
    box().dataset.mark = 'a';
    let churnMs = 0;
    while (churnMs < 30000 && box() && box().dataset.mark === 'a') {
      await wait(500); churnMs += 500;
    }
    const churn = !!box() && box().dataset.mark !== 'a';
    log.push(['the lines rebuild under an untouched box (after ' + (churnMs / 1000) + 's — this is what ate the typing)', churn]);

    // 2. with the box under the hand, it must survive that same rebuild
    const inp = box();
    inp.dataset.mark = 'typed-in';
    inp.focus();
    inp.value = '8';                       // as a person types: one digit,
    await wait(1200);                      // a tick passes,
    log.push(['after 1 tick · same box', box() && box().dataset.mark === 'typed-in']);
    log.push(['after 1 tick · still focused', document.activeElement === inp]);
    log.push(['after 1 tick · the digit is still there', box() && box().value === '8']);
    inp.value = '88';                      // then the second digit
    await wait(2400);
    log.push(['after 3 ticks · same box', box() && box().dataset.mark === 'typed-in']);
    log.push(['after 3 ticks · still focused', document.activeElement === inp]);
    log.push(['after 3 ticks · both digits kept', box() && box().value === '88']);

    // 3. the card stays honest while it is held — the live note keeps moving
    const noteA = document.querySelector('#plan-lines .pline .n').textContent;
    await wait(1100);
    const noteB = document.querySelector('#plan-lines .pline .n').textContent;

    // 4. let go: the figure goes into the plan and the lines rebuild
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.blur();
    await wait(1600);
    log.push(['on release · the plan took 88 L', /88 L/.test(document.querySelector('#plan-lines .pline .v').textContent)]);
    log.push(['on release · the lines rebuilt', box() && box().dataset.mark !== 'typed-in']);
    return { log, noteA, noteB };
  })()`);

  for (const [what, ok] of out.log || []) console.log(`${ok ? 'PASS' : 'FAIL'} - ${what}`);
  if (out.fail) console.log('FAIL -', out.fail);
  if (out.noteA) console.log(`  (note while held: "${out.noteA}" -> "${out.noteB}")`);
  const failed = !!out.fail || (out.log || []).some(([, ok]) => !ok);
  console.log(failed ? 'TYPING CHECK FAILED' : 'ALL PASS');
  app.exit(failed ? 1 : 0);
});
