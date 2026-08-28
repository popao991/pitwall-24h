// End-to-end check of the editable stint plan. Boots the server, seeds a race,
// opens the PLAN panel on a real station window, edits a stint driver through
// the UI exactly as a mouse would, and asserts the change reaches the shared
// state on the pit wall and comes back into the table.
//
// The renderer is an ES module, so its `state` is not reachable from the page
// scope — shared state is read over this harness's own WebSocket instead, which
// is also the honest test: it proves the edit really left the station.
//
// Run with:  npx electron test/plan-edit-check.cjs [outputDir]
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
    const info = startServer({ dataFile: null, port: 8488 }); // 8485-8487 belong to smoke.mjs — never collide with it
    return { port: info.port, ips: info.ips }; // only cloneable fields cross IPC
  });
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));
  ipcMain.handle('list-backups', () => []);

  const mkWin = () => new BrowserWindow({
    show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });

  // The pit wall window starts the server.
  const wall = mkWin();
  await wall.loadURL('app://root/renderer/pitwall.html');
  await wall.webContents.executeJavaScript(
    "localStorage.setItem('serverPort','8488');" +
    "localStorage.setItem('serverIp','127.0.0.1');" +
    "localStorage.setItem('carId','1'); true"
  );
  await wait(1500);

  // Our own connection, so shared state can be read independently of any window.
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:8488');
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
  send({ type: 'update', carId: '1', patch: { make: 'Porsche', model: '992 GT3 Cup' } });
  for (let i = 0; i < 20; i++) send({ type: 'lap', carId: '1', lapSec: 104.2 });
  await until(() => shared.cars['1'].state.totalLaps >= 20);

  const station = mkWin();
  const consoleErrors = [];
  station.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  await station.loadURL('app://root/renderer/station.html');
  await wait(3000);
  const js = s => station.webContents.executeJavaScript(s);

  // Drive the real buttons: open the panel, generate the plan.
  await js("document.getElementById('btn-plan').click(); true");
  await wait(400);
  await js("document.getElementById('btn-plan-generate').click(); true");
  const generated = await until(() => shared.cars['1'].plan?.stints?.length > 2);
  check('a plan was generated from the station', generated);

  const planLen = shared.cars['1'].plan.stints.length;
  const selCount = await js("document.querySelectorAll('#plan-out select.plan-drv').length");
  check('future stints render a driver select', selCount > 0);
  // Nothing has been driven yet, so every stint is still the crew's to change.
  check('every not-yet-driven stint is editable', selCount === planLen);

  // The whole point: the stop recommendation must read the driver off the plan,
  // not off the balancing heuristic. Check the model against the REAL shared
  // state first, so a failure says plainly which side is at fault.
  const { recommendedStops } = await import(pathToFileURL(path.join(root, 'shared', 'model.js')));
  const recs = recommendedStops(shared.cars['1'], shared.race, Date.now());
  console.log(`   model says: "${recs.green.driver.why}"`);
  check('the model reads the driver off the plan', /stint plan/i.test(recs.green.driver.why));

  // Then the rendered row. Scope the match to the DRIVER row itself — matching
  // the whole page would also hit the "STINT PLAN" heading of the panel.
  const rowText = await (async () => {
    for (let i = 0; i < 40; i++) {
      const t = await js(`(() => {
        const el = [...document.querySelectorAll('*')].find(
          e => e.children.length === 0 && e.textContent.trim() === 'DRIVER');
        const row = el && el.closest('div');
        return row ? row.parentElement.innerText.replace(/\\s+/g, ' ').trim() : '';
      })()`);
      if (/stint plan/i.test(t)) return t;
      await wait(200);
      if (i === 39) return t;
    }
    return '';
  })();
  console.log(`   DRIVER row reads: "${rowText}"`);
  check('the DRIVER row shows the plan as the reason', /stint plan/i.test(rowText));

  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'plan-driver-row.png'), img.toPNG()));
  console.log('   captured plan-driver-row.png');

  // Now the plan panel itself, with the selects on screen.
  await js("document.getElementById('plan-overlay')?.classList.remove('hidden'); true");
  await wait(600);
  await js("document.getElementById('plan-out').scrollIntoView({block:'center'}); true");
  await wait(300);
  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'plan-edit.png'), img.toPNG()));
  console.log('   captured plan-edit.png');

  // Edit the LAST stint through the UI: set the value and fire `change`, which
  // is exactly what picking from the dropdown does.
  const before = shared.cars['1'].plan.stints[planLen - 1].driverId;
  const target = await js(`(() => {
    const sels = document.querySelectorAll('#plan-out select.plan-drv');
    const sel = sels[sels.length - 1];
    const other = [...sel.options].map(o => o.value).find(v => v !== sel.value);
    sel.value = other;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return other;
  })()`);
  const landed = await until(() => shared.cars['1'].plan.stints[planLen - 1].driverId === target);
  check('the edit reaches the shared plan on the pit wall', landed && target !== before);

  // The totals under the table are read off the plan, so they must move with it.
  const p = shared.cars['1'].plan;
  const sum = Object.values(p.totals).reduce((a, b) => a + b, 0);
  const span = p.stints.reduce((a, s) => a + (s.toMs - s.fromMs), 0);
  check('seat-time totals still add up after the edit', Math.abs(sum - span) < 1);

  // And it must survive the re-render rather than snapping back.
  await wait(600);
  const shown = await js(`(() => {
    const sels = document.querySelectorAll('#plan-out select.plan-drv');
    return sels[sels.length - 1].value;
  })()`);
  check('the table redraws showing the new driver', shown === target);

  // A second station must see the same running order — the plan is shared.
  const station2 = mkWin();
  await station2.loadURL('app://root/renderer/station.html');
  await wait(2500);
  await station2.webContents.executeJavaScript("document.getElementById('btn-plan').click(); true");
  await wait(800);
  const shown2 = await station2.webContents.executeJavaScript(`(() => {
    const sels = document.querySelectorAll('#plan-out select.plan-drv');
    return sels.length ? sels[sels.length - 1].value : null;
  })()`);
  check('a second station sees the same edited plan', shown2 === target);

  // ---- the other direction: the GREEN card writes the running order ----
  // A driver called for by hand on the stop card is moved up the stint plan and
  // the order behind them slides one stint back, so every row after the stop
  // still says who gets in and when. Driven through the real button.
  await js("document.getElementById('btn-plan-close').click(); true");
  await wait(600);
  const { plannedNextStintIndex } = await import(pathToFileURL(path.join(root, 'shared', 'model.js')));
  const at = plannedNextStintIndex(shared.cars['1'], shared.race, Date.now());
  const orderBefore = shared.cars['1'].plan.stints.map(s => s.driverId);
  // Someone the plan does not already have in that seat and who is due later.
  const moveUp = orderBefore.slice(at + 1).find(id => id !== orderBefore[at]);
  const wasAt = orderBefore.indexOf(moveUp, at + 1);
  const clicked = await js(`(() => {
    const b = document.querySelector('#plan-lines button[data-pin="driver"][data-val="${moveUp}"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('the DRIVER line offers the other drivers as buttons', clicked);
  const moved = await until(() => shared.cars['1'].plan.stints[at].driverId === moveUp);
  const orderAfter = shared.cars['1'].plan.stints.map(s => s.driverId);
  console.log(`   stints ${at + 1}-${wasAt + 1}: ${orderBefore.slice(at, wasAt + 1).join(',')} -> ${orderAfter.slice(at, wasAt + 1).join(',')}`);
  check('a driver pinned on GREEN is moved up the stint plan', moved);
  check('the order behind the insert slides one stint back',
    orderAfter.slice(at + 1, wasAt + 1).join(',') === orderBefore.slice(at, wasAt).join(','));
  check('nothing outside the moved run is touched',
    orderAfter.slice(0, at).join(',') === orderBefore.slice(0, at).join(',') &&
    orderAfter.slice(wasAt + 1).join(',') === orderBefore.slice(wasAt + 1).join(','));
  const tally = o => JSON.stringify(Object.entries(
    o.reduce((a, id) => (a[id] = (a[id] || 0) + 1, a), {})).sort());
  check('nobody gains or loses a stint', tally(orderAfter) === tally(orderBefore));
  check('the pin is stored against the green plan only',
    shared.cars['1'].nextStop.pins.green.driver === moveUp &&
    !shared.cars['1'].nextStop.pins.sc.driver);

  // The line the call was made on says what it did to the plan.
  const drvRow = await js(`(() => {
    const el = [...document.querySelectorAll('#plan-lines .k')].find(
      e => e.textContent.trim() === 'DRIVER');
    return el ? el.closest('.pline').innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  console.log(`   DRIVER row now reads: "${drvRow}"`);
  check('the DRIVER line says the stint plan was written', /stint plan/i.test(drvRow));

  // The open plan table has to redraw on the new order, which carries no new
  // timestamp for the render key to notice.
  await js("document.getElementById('btn-plan').click(); true");
  await wait(900);
  const tableAt = await js(`(() => {
    const sels = document.querySelectorAll('#plan-out select.plan-drv');
    return sels[${at}] ? sels[${at}].value : null;
  })()`);
  check('the plan table redraws on the moved order', tableAt === moveUp);
  // A window made with show:false never repaints, so capturePage would hand
  // back a stale frame — show it without stealing focus just long enough.
  station.showInactive();
  await wait(1200);
  await js("document.getElementById('plan-out').scrollIntoView({block:'start'}); true");
  await wait(400);
  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'plan-insert.png'), img.toPNG()));
  station.hide();
  console.log('   captured plan-insert.png');

  // ---- the neutralisation-call fields, edited on the card itself ----
  // Close the plan panel first so the card is on screen.
  await js("document.getElementById('btn-plan-close').click(); true");
  await wait(800);
  await js("document.getElementById('btn-caution-cfg').click(); true");
  await wait(500);
  const cfgOpen = await js(`(() => {
    const p = document.getElementById('caution-cfg');
    return !p.hasAttribute('hidden') &&
      document.querySelectorAll('#caution-cfg input[data-cpath]').length;
  })()`);
  // Six figures the call reads, plus the three the simulation needs and had
  // nowhere else to live: how long a caution runs, the slack on a stop, and
  // the fuel burnt in the lane — and the four points a crew can answer a flag
  // off instead of the ranking.
  check('the cog flips the card to the caution inputs', cfgOpen === 13, `${cfgOpen} inputs`);

  // The card must arrive with the measured figures already in it, not zeros —
  // a blank card reads as broken and there is nothing to seed them from at the
  // track. Read before anything is typed.
  const seeded = await js(`(() => {
    const v = k => +document.querySelector('#caution-cfg input[data-cpath="' + k + '"]').value;
    return {
      rate: v('cautionsPerHour'), deg: v('tyreDegSecPerKm'), fw: v('fuelWeightSecPerL'),
      dry: v('avgLapSec.dry'), fcy: v('avgLapSec.fcy'), sc: v('avgLapSec.sc')
    };
  })()`);
  console.log('   seeded: ' + JSON.stringify(seeded));
  check('the fields open on the measured defaults, not zeros',
    seeded.rate === 0.639 && seeded.deg === 0.0087 && seeded.fw === 0.0079 &&
    seeded.dry > 0 && seeded.fcy > 0 && seeded.sc > 0);

  // Lap time is nested config (avgLapSec.dry) — the patch has to reach the leaf.
  await js(`(() => {
    const el = document.querySelector('#caution-cfg input[data-cpath="avgLapSec.sc"]');
    el.value = 150; el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const nested = await until(() => shared.cars['1'].config.avgLapSec.sc === 150, 6000);
  check('a nested lap-time field patches through', nested);
  check('and it did not flatten the rest of avgLapSec',
    shared.cars['1'].config.avgLapSec.dry > 0 && shared.cars['1'].config.avgLapSec.fcy > 0);

  // Type the Zolder figures in, exactly as the engineer would.
  await js(`(() => {
    const set = (k, v) => {
      const el = document.querySelector('#caution-cfg input[data-cpath="' + k + '"]');
      el.value = v; el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('cautionsPerHour', 0.639);
    set('tyreDegSecPerKm', 0.0087);
    set('fuelWeightSecPerL', 0.0079);
    return true;
  })()`);
  const saved = await until(() => {
    const c = shared.cars['1'].config;
    return c.cautionsPerHour === 0.639 && c.tyreDegSecPerKm === 0.0087 && c.fuelWeightSecPerL === 0.0079;
  }, 6000);
  check('the figures land on the car as per-car settings', saved);

  // With the inputs set the card must answer for both flags.
  const verdict = await (async () => {
    for (let i = 0; i < 40; i++) {
      const t = await js("document.getElementById('caution-out').innerText.replace(/\s+/g,' ').trim()");
      if (/CODE 60/.test(t) && /break-even/.test(t)) return t;
      await wait(200);
    }
    return await js("document.getElementById('caution-out').innerText");
  })();
  console.log('   card says: "' + verdict + '"');
  check('the card answers for Code 60 and Safety Car',
    /CODE 60/.test(verdict) && /SAFETY CAR/.test(verdict) && /break-even/.test(verdict));

  // A window created with show:false does not repaint, so capturePage returns a
  // stale frame. Show it without stealing focus just long enough to paint.
  station.showInactive();
  await wait(1500);
  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'caution-card.png'), img.toPNG()));
  station.hide();
  console.log('   captured caution-card.png');

  // ---- the other half: an order that no longer matches the driver table ----
  // Driver 2 is taken off doubles, then the plan is bent to give them two
  // stints back to back — a thing the generator can never write for itself, so
  // everything the panel says about it is the consequence of the hand edit.
  send({ type: 'update', carId: '1', patch: {
    drivers: shared.cars['1'].drivers.map((d, i) =>
      i === 1 ? { ...d, night: false, doubleStint: false } : d)
  } });
  await until(() => shared.cars['1'].drivers[1].doubleStint === false);
  const d2 = shared.cars['1'].drivers[1].id;
  const d1 = shared.cars['1'].drivers[0].id;
  const pair = shared.cars['1'].plan.stints.length - 2;
  // Exactly two in a row: the stint before the pair is handed to someone else,
  // or a stray third would make this a triple and read as a different fault.
  send({ type: 'planStint', carId: '1', index: pair - 1, driverId: d1 });
  send({ type: 'planStint', carId: '1', index: pair, driverId: d2 });
  send({ type: 'planStint', carId: '1', index: pair + 1, driverId: d2 });
  await until(() => shared.cars['1'].plan.stints[pair].driverId === d2 &&
    shared.cars['1'].plan.stints[pair + 1].driverId === d2);

  await js("document.getElementById('btn-plan').click(); true");
  await wait(900);
  const warned = await js(`(() => {
    const strip = document.querySelector('#plan-out .planwarn');
    const rows = document.querySelectorAll('#plan-out tr.offplan');
    return { strip: strip ? strip.innerText.replace(/\\s+/g, ' ').trim() : null, rows: rows.length };
  })()`);
  console.log(`   plan warning: "${warned.strip}" on ${warned.rows} rows`);
  check('a hand-edited order says what it broke',
    !!warned.strip && /double/i.test(warned.strip));
  check('and it names every stint the fault lands on, not just the first',
    /stints \d+(, \d+)+/.test(warned.strip));
  check('and the rows themselves are flagged', warned.rows >= 2);

  // The stop card carries the same news, sized to the stop: a fault ten stints
  // away is counted, not spelled out, so the busiest screen stays readable.
  await js("document.getElementById('btn-plan-close').click(); true");
  await wait(700);
  const drvRow2 = await js(`(() => {
    const el = [...document.querySelectorAll('#plan-lines .k')].find(
      e => e.textContent.trim() === 'DRIVER');
    return el ? el.closest('.pline').innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  console.log(`   DRIVER row with a broken plan: "${drvRow2}"`);
  check('the stop card says the running order is broken further down',
    /later stints? no longer match/i.test(drvRow2));
  await js("document.getElementById('btn-plan').click(); true");
  await wait(700);

  // Put both settings back, and the panel has to go quiet again — a warning
  // that sticks once shown is worse than none. The order is untouched: it is
  // the driver table that has moved back under it.
  send({ type: 'update', carId: '1', patch: {
    drivers: shared.cars['1'].drivers.map((d, i) =>
      i === 1 ? { ...d, night: true, doubleStint: true } : d)
  } });
  await until(() => shared.cars['1'].drivers[1].doubleStint === true &&
    shared.cars['1'].drivers[1].night === true);
  // The panel is left open on purpose: the order has not moved, only the table
  // it is measured against, and the plan has to notice that on its own.
  await wait(1200);
  const quiet = await js("document.querySelectorAll('#plan-out .planwarn').length");
  const quietRows = await js("document.querySelectorAll('#plan-out tr.offplan').length");
  check('putting the setting back clears the warning with the panel still open',
    quiet === 0 && quietRows === 0);

  // Bend it again for the picture, then paint: a window made with show:false
  // never repaints, so capturePage would hand back a stale frame.
  send({ type: 'update', carId: '1', patch: {
    drivers: shared.cars['1'].drivers.map((d, i) =>
      i === 1 ? { ...d, night: false, doubleStint: false } : d)
  } });
  await until(() => shared.cars['1'].drivers[1].doubleStint === false);
  station.showInactive();
  await wait(1200);
  await js("document.getElementById('plan-out').scrollIntoView({block:'start'}); true");
  await wait(400);
  await station.webContents.capturePage().then(img =>
    fs.writeFileSync(path.join(outDir, 'plan-warning.png'), img.toPNG()));
  station.hide();
  console.log('   captured plan-warning.png');

  check('no console errors on the station', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('   ' + consoleErrors.join('\n   '));

  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASS');
  app.exit(failed.length ? 1 : 0);
});
