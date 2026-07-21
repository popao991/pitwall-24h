// UI smoke test: loads every renderer page in a hidden window and fails if
// any page logs a console error. Run with: npx electron test/ui-check.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const appProtocol = require(path.join(root, 'app-protocol.cjs'));
appProtocol.registerScheme();

const errors = [];

// Without this, Electron quits as soon as the first test window is destroyed.
app.on('window-all-closed', () => {});

setTimeout(() => {
  console.log('GLOBAL TIMEOUT');
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : '(no errors captured)');
  app.exit(2);
}, 60000);

app.whenReady().then(async () => {
  appProtocol.installHandler(root);

  // Port 8485 so tests never touch a live app on the default port 8484.
  ipcMain.handle('start-server', async () => {
    const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'server.js')));
    return startServer({ dataFile: null, port: 8485 });
  });

  for (const page of ['index.html', 'pitwall.html', 'station.html']) {
    console.log('loading', page, '...');
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(root, 'preload.cjs') }
    });
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      if (level >= 3 || /error/i.test(message)) {
        console.log(`  [console ${level}] ${message} (${sourceId}:${line})`);
        errors.push(`${page}: ${message}`);
      }
    });
    win.webContents.on('did-fail-load', (e, code, desc, url) => {
      errors.push(`${page}: did-fail-load ${code} ${desc} ${url}`);
    });
    win.webContents.on('preload-error', (e, p, err) => {
      errors.push(`${page}: preload-error ${err.message}`);
    });
    win.webContents.on('render-process-gone', (e, details) => {
      errors.push(`${page}: render process gone ${details.reason}`);
    });

    const result = await Promise.race([
      win.loadURL('app://root/renderer/' + page).then(() => 'ok', err => {
        errors.push(`${page}: loadURL rejected ${err.message}`);
        return 'rejected';
      }),
      new Promise(r => setTimeout(() => r('LOAD TIMEOUT'), 15000))
    ]);
    console.log('loaded', page, '->', result);
    if (page === 'index.html') {
      // Point the station/pitwall pages at the test server port.
      await win.webContents.executeJavaScript(
        "localStorage.setItem('serverPort','8485');" +
        "localStorage.setItem('serverIp','127.0.0.1');" +
        "localStorage.setItem('carId','1'); true"
      );
    }
    await new Promise(r => setTimeout(r, 2500));
    win.destroy();
  }

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'UI OK - no console errors');
  app.exit(errors.length ? 1 : 0);
});
