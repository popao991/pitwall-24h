// End-to-end check of the start-lights splash on the real launcher window.
// The splash has two duties: run the five-light sequence once when the app
// starts, and get out of the way — instantly on any later visit to the
// launcher (coming back from a station), and entirely under reduced motion.
// A splash that replays on every "back to role selection" would cost the crew
// 3 seconds each time; one that never disappears would brick the launcher.
//
// Run with:  npx electron test/boot-check.cjs [outputDir]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || __dirname;
const appProtocol = require(path.join(root, 'app-protocol.cjs'));
appProtocol.registerScheme();
app.on('window-all-closed', () => {});

setTimeout(() => { console.log('GLOBAL TIMEOUT'); app.exit(2); }, 60000);
const wait = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? '  (' + detail + ')' : ''}`);
};

app.whenReady().then(async () => {
  appProtocol.installHandler(root);
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));

  // Visible window: the splash is a measurement of what is on screen.
  const win = new BrowserWindow({
    show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  await win.loadURL('app://root/renderer/index.html');
  const js = s => win.webContents.executeJavaScript(s);

  // ---- first launch: the sequence plays ------------------------------------

  const early = await js(`(() => {
    const s = document.getElementById('startup');
    return {
      up: !!s && !s.classList.contains('out'),
      lights: s ? s.querySelectorAll('.slight').length : 0,
      booting: document.documentElement.classList.contains('booting')
    };
  })()`);
  check('the splash is up at launch', early.up);
  check('the gantry has five lights', early.lights === 5, String(early.lights));
  check('the launcher entrance is held back', early.booting);

  // Mid-sequence: some lights on, not yet all five out.
  await wait(1200);
  const mid = await js(
    "document.querySelectorAll('#startup .slight.on').length");
  check('the lights come on one by one', mid >= 2 && mid < 5, mid + ' lit at 1.2s');
  await win.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'boot-lights.png'), img.toPNG()));
  console.log('   captured boot-lights.png');

  // All five before the hold ends (out fires at 2.4s at the earliest).
  await wait(1000);
  const allOn = await js(`(() => {
    const s = document.getElementById('startup');
    return {
      lit: document.querySelectorAll('#startup .slight.on').length,
      out: !s || s.classList.contains('out')
    };
  })()`);
  if (!allOn.out) check('all five reds are on before the hold', allOn.lit === 5, String(allOn.lit));
  else console.log('   (lights-out already fired at 2.2s — five-light count not observable)');

  // Lights out: splash gone, entrance released, picker on screen.
  await wait(2500);
  const after = await js(`(() => ({
    splash: !!document.getElementById('startup'),
    booting: document.documentElement.classList.contains('booting'),
    pickerVisible: (() => {
      const h = document.querySelector('.picker h1');
      return h && getComputedStyle(h).opacity === '1';
    })(),
    shown: sessionStorage.getItem('bootShown')
  }))()`);
  check('the splash removes itself after lights-out', !after.splash);
  check('the launcher entrance is released', !after.booting);
  check('the picker is on screen', after.pickerVisible);
  check('the run is remembered for this session', after.shown === '1', String(after.shown));
  await win.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'boot-picker.png'), img.toPNG()));
  console.log('   captured boot-picker.png');

  // ---- back to the launcher in the same run: no replay ---------------------

  await win.webContents.reload();
  await wait(400);
  const again = await js(`(() => ({
    splash: !!document.getElementById('startup'),
    booting: document.documentElement.classList.contains('booting'),
    pickerVisible: (() => {
      const h = document.querySelector('.picker h1');
      return h && getComputedStyle(h).opacity === '1';
    })()
  }))()`);
  check('a return to the launcher skips the splash', !again.splash && !again.booting);
  await wait(700);
  const pickerBack = await js(
    "getComputedStyle(document.querySelector('.picker h1')).opacity === '1'");
  check('the picker appears straight away', pickerBack);

  check('no console errors on the launcher', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('   ' + consoleErrors.join('\n   '));

  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASS');
  app.exit(failed.length ? 1 : 0);
});
