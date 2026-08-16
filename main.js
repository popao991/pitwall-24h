import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const appProtocol = require('./app-protocol.cjs');

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
        replayDir: path.join(app.getPath('userData'), 'replays')
      });
    }
    return { port: serverInfo.port, ips: serverInfo.ips };
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
