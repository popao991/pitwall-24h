// Captures screenshots of the pit wall and a car station with seeded race
// data, for visual verification. Run with:
//   npx electron test/screenshot.cjs <outputDir>
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || __dirname;
const appProtocol = require(path.join(root, 'app-protocol.cjs'));
appProtocol.registerScheme();
app.on('window-all-closed', () => {});

setTimeout(() => { console.log('GLOBAL TIMEOUT'); app.exit(2); }, 90000);

const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  appProtocol.installHandler(root);
  // Port 8485 so screenshots never touch a live app on the default port 8484.
  ipcMain.handle('start-server', async () => {
    const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'server.js')));
    return startServer({ dataFile: null, port: 8485 });
  });
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));

  const mkWin = () => new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });

  // Pit wall first: starts the server.
  const wall = mkWin();
  wall.webContents.on('console-message', (e, level, message, line, sourceId) =>
    console.log(`  [wall console ${level}] ${message} (${sourceId}:${line})`));
  await wall.loadURL('app://root/renderer/pitwall.html');
  await wall.webContents.executeJavaScript(
    "localStorage.setItem('serverPort','8485');" +
    "localStorage.setItem('serverIp','127.0.0.1');" +
    "localStorage.setItem('carId','1'); true"
  );
  await wait(1500);

  // Seed race data through the server like stations would.
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:8485');
  await new Promise(r => ws.on('open', r));
  const send = o => ws.send(JSON.stringify(o));
  send({ type: 'startRace' });
  send({ type: 'update', carId: '1', patch: { make: 'Porsche', model: '992 GT3 Cup' } });
  send({ type: 'update', carId: '2', patch: { make: 'BMW', model: 'M4 GT4' } });
  for (let i = 0; i < 18; i++) send({ type: 'lap', carId: '1', lapSec: 104.2 + Math.sin(i) });
  for (let i = 0; i < 15; i++) send({ type: 'lap', carId: '2', lapSec: 105.8 });
  for (let i = 0; i < 12; i++) send({ type: 'lap', carId: '3' });
  send({ type: 'update', carId: '2', patch: { nextStop: { fuelLiters: 78, tyres: true, driverChange: 'd3', status: 'sent', notes: 'clean windscreen' } } });
  send({ type: 'update', carId: '3', patch: { nextStop: { fuelLiters: 95, tyres: true, padsFront: true, padsRear: true, driverChange: 'd2', status: 'box', notes: 'check FL wheel nut' } } });
  send({ type: 'fcy', active: true });
  await wait(2500);

  await wall.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'pitwall.png'), img.toPNG()));
  console.log('captured pitwall.png');

  // Station for car 1.
  const station = mkWin();
  await station.loadURL('app://root/renderer/station.html');
  await wait(3000);
  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'station.png'), img.toPNG()));
  console.log('captured station.png');

  // Settings modals on both screens.
  const openSettings = "document.getElementById('settings-overlay').classList.remove('hidden'); true";
  await station.webContents.executeJavaScript(openSettings);
  await wait(500);
  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'station-settings.png'), img.toPNG()));
  console.log('captured station-settings.png');

  await wall.webContents.executeJavaScript(openSettings);
  await wait(500);
  await wall.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'pitwall-settings.png'), img.toPNG()));
  console.log('captured pitwall-settings.png');

  app.exit(0);
});
