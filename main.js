import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const appProtocol = require('./app-protocol.cjs');

// A second copy of the app on the SAME PC (a station beside the pit wall —
// demos, test days) must not share the first copy's Chromium profile
// directory: two instances on one profile fight over the localStorage
// database that holds the role, theme and connection target. Point the
// extra copy at its own folder:  PITWALL_USER_DATA=<dir> npm start
if (process.env.PITWALL_USER_DATA) {
  app.setPath('userData', process.env.PITWALL_USER_DATA);
}

appProtocol.registerScheme();

let serverInfo = null;
let win = null;

// ---- auto-update from GitHub releases (installed builds only) ----

// electron-updater's HttpError message carries the whole response header block,
// which is useless on a pit wall and unreadable on the launcher. Keep the first
// line and translate the one failure that actually happens in the field: the
// releases feed 404s when the repo is private or has no published release yet.
function updateErrorText(e) {
  const raw = String(e?.message || e || 'unknown error');
  if (/404/.test(raw) && /releases\.atom|Cannot find/i.test(raw)) {
    return 'No published release found — check the GitHub repo is public and a release exists.';
  }
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
}

function setupUpdater() {
  if (!app.isPackaged) return null;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', info => {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'info',
        title: 'Update ready',
        message: `PitWall 24H ${info.version} has been downloaded.`,
        detail: 'Restart now to install, or it installs automatically when the app closes. ' +
          'Do not restart the pit wall PC mid-race unless a station has the race covered.',
        buttons: ['Restart now', 'Later'],
        defaultId: 1,
        cancelId: 1
      });
      if (choice === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.on('error', e => console.error('[updater]', updateErrorText(e)));
    // quiet check a few seconds after launch
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
    return autoUpdater;
  } catch (e) {
    console.error('[updater] unavailable:', e.message);
    return null;
  }
}

app.whenReady().then(() => {
  appProtocol.installHandler(__dirname);
  const updater = setupUpdater();

  ipcMain.handle('get-version', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged
  }));

  ipcMain.handle('check-updates', async () => {
    if (!app.isPackaged) return { status: 'dev', message: 'Running from source — update with git pull.' };
    if (!updater) return { status: 'error', message: 'Updater not available in this build.' };
    try {
      const result = await updater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      if (latest && latest !== app.getVersion()) {
        return { status: 'downloading', message: `Version ${latest} found — downloading in the background…` };
      }
      return { status: 'uptodate', message: `You are on the latest version (${app.getVersion()}).` };
    } catch (e) {
      return { status: 'error', message: 'Update check failed: ' + updateErrorText(e) };
    }
  });

  // The pit wall page asks for this; car stations never call it.
  ipcMain.handle('start-server', async () => {
    if (!serverInfo) {
      const { startServer } = await import('./server/server.js');
      serverInfo = startServer({
        dataFile: path.join(app.getPath('userData'), 'pitwall-state.json'),
        backupDir: path.join(app.getPath('userData'), 'backups'),
        replayDir: path.join(app.getPath('userData'), 'replays'),
        // Headroom for a held port — a second copy of the app, or an orphaned
        // test server: walk to the next free port rather than boot a wall
        // whose own server never came up.
        portTries: 10
      });
    }
    // The bind is asynchronous. Wait for it, so a failure reaches the wall as
    // an error instead of a "listening" announcement over a dead socket — and
    // so the port shown is the one actually bound, not the one asked for.
    const port = await serverInfo.listening;
    return { port, ips: serverInfo.ips };
  });

  // ---- car files ----
  // A car file is prepared, carried and loaded as a file on disk, so the two
  // dialogs live here rather than in the page: a renderer served over app://
  // cannot write to the user's own folders, and a car file is something people
  // e-mail each other in the week before the event.
  ipcMain.handle('save-car-file', async (_e, { suggestedName, data } = {}) => {
    const res = await dialog.showSaveDialog(win, {
      title: 'Save car file',
      defaultPath: path.join(app.getPath('documents'), String(suggestedName || 'car.pitcar.json')),
      filters: [{ name: 'PitWall car file', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      await fs.promises.writeFile(res.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      return { ok: true, path: res.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('open-car-file', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Load car file',
      properties: ['openFile'],
      filters: [{ name: 'PitWall car file', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }]
    });
    const file = res.filePaths?.[0];
    if (res.canceled || !file) return { ok: false, canceled: true };
    try {
      return { ok: true, path: file, name: path.basename(file), text: await fs.promises.readFile(file, 'utf8') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('list-backups', () => (serverInfo ? serverInfo.listBackups() : []));
  ipcMain.handle('backup-now', () => {
    if (!serverInfo) return { ok: false, error: 'server not running' };
    const file = serverInfo.writeBackup();
    return file ? { ok: true, file } : { ok: false, error: 'backup could not be written' };
  });
  ipcMain.handle('restore-backup', (_e, name) =>
    serverInfo ? serverInfo.restoreBackup(String(name)) : { ok: false, error: 'server not running' });

  win = new BrowserWindow({
    width: 1500,
    height: 950,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  win.loadURL('app://root/renderer/index.html');
});

app.on('window-all-closed', () => app.quit());
