// End-to-end check of the brake rack board (SETTINGS -> WEAR & PIT).
// Boots the server, seeds a race, opens the rack on a real station window and
// drives it the way a mouse would: read the two axle columns, unfold a part's
// editor by clicking its line, rename the part, and assert the change reaches
// the shared state on the pit wall.
//
// Run with:  npx electron test/brake-rack-check.cjs [outputDir]
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
    const info = startServer({ dataFile: null, port: 8489 }); // 8485-8488 are taken by the other checks
    return { port: info.port, ips: info.ips };
  });
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));
  ipcMain.handle('list-backups', () => []);

  const mkWin = () => new BrowserWindow({
    show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });

  const wall = mkWin();
  await wall.loadURL('app://root/renderer/pitwall.html');
  await wall.webContents.executeJavaScript(
    "localStorage.setItem('serverPort','8489');" +
    "localStorage.setItem('serverIp','127.0.0.1');" +
    "localStorage.setItem('carId','1'); true"
  );
  await wait(1500);

  const WebSocket = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:8489');
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
  // A hidden window's compositor sits on the last frame it drew, so capturePage
  // hands back the page as it was BEFORE the modal opened unless it is nudged:
  // invalidate, let two animation frames go by, then shoot.
  const shoot = async (name) => {
    station.webContents.invalidate();
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await wait(400);
    const img = await station.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
    console.log(`   captured ${name}`);
  };

  // Open the rack the way the crew does.
  await js("document.getElementById('btn-settings').click(); true");
  await wait(300);
  await js("document.querySelector('.tabbar button[data-tab=\"wear\"]').click(); true");
  await wait(600);
  // The pane is painted by the station's own render loop, so wait for the board
  // rather than for a fixed number of milliseconds.
  const drawn = await (async () => {
    for (let i = 0; i < 60; i++) {
      if (await js("document.querySelectorAll('#brakeset-list .brack-axle').length > 0")) return true;
      await wait(200);
    }
    return false;
  })();
  check('the rack paints when the pane is opened', drawn);
  if (!drawn) {
    console.log('   DEBUG conn:', await js("document.getElementById('conn').textContent"));
    console.log('   DEBUG carId:', await js("localStorage.getItem('carId')"));
    console.log('   DEBUG list:', await js("document.getElementById('brakeset-list').innerHTML.slice(0,200)"));
    console.log('   DEBUG pane hidden:', await js("document.querySelector('section[data-pane=\"wear\"]').hidden"));
    console.log('   DEBUG errors:', JSON.stringify(consoleErrors.slice(0, 5)));
  }
  await js("document.getElementById('brakeset-list').scrollIntoView({block:'center'}); true");
  await wait(400);

  const shape = await js(`(() => {
    const w = document.getElementById('brakeset-list');
    return {
      cols: w.querySelectorAll('.brack-axle').length,
      tags: [...w.querySelectorAll('.brack-tag')].map(t => t.firstChild.textContent.trim()),
      kits: w.querySelectorAll('.brack-kit').length,
      rows: w.querySelectorAll('.brack-row').length,
      bars: w.querySelectorAll('.brack-bar i').length,
      partBoxes: w.querySelectorAll('input[data-bset-name], input[data-bset-hours]').length,
      kitNames: w.querySelectorAll('input[data-kitname]').length,
    };
  })()`);
  console.log('   board:', JSON.stringify(shape));
  check('the rack draws two axle columns', shape.cols === 2);
  check('front is the first column, rear the second',
    shape.tags[0] === 'FRONT' && shape.tags.includes('REAR'));
  check('every part is a line with a life bar', shape.rows > 0 && shape.bars === shape.rows);
  // The whole point of the redesign: nothing but the kit-name chips is a box
  // until a line is clicked.
  check('a resting rack shows no per-part input boxes', shape.partBoxes === 0);
  check('each made-up kit still carries its name chip', shape.kitNames > 0);

  await shoot('brake-rack.png');

  // Click a line: the editor folds out under it.
  const clicked = await js(`(() => {
    const rows = document.querySelectorAll('#brakeset-list .brack-row');
    // the first never-used part, so SCRAP and the bin are both live
    const row = [...rows].find(r => r.querySelector('.brack-pill.new')) || rows[1];
    const no = row.querySelector('.brack-name').firstChild.textContent.trim();
    row.click();
    return no;
  })()`);
  await wait(300);
  // Opening redraws the board, so the editor is looked for afterwards — under
  // the line carrying the number that was clicked, not under a stale node.
  const opened = await js(`(() => {
    const row = [...document.querySelectorAll('#brakeset-list .brack-row')]
      .find(r => r.classList.contains('open'));
    if (!row) return false;
    return row.querySelector('.brack-name').firstChild.textContent.trim() === ${JSON.stringify(clicked)}
      && !!row.nextElementSibling && row.nextElementSibling.classList.contains('brack-edit');
  })()`);
  check(`clicking ${clicked} unfolds its editor under that line`, opened);
  await shoot('brake-rack-edit.png');

  const only = await js("document.querySelectorAll('#brakeset-list .brack-edit').length");
  check('only one editor is open at a time', only === 1);

  // Rename through the box and prove it reaches the pit wall.
  const target = 'ZZ9';
  await js(`(() => {
    const inp = document.querySelector('#brakeset-list .brack-edit input[data-bset-name]');
    inp.value = '${target}';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const landed = await until(() => Object.values(shared.cars['1'].brakeSets || {})
    .some(pool => pool.some(t => t.name === target)));
  check('a renamed part reaches the shared rack', landed);

  // And the board redraws with the new number on the line.
  await wait(700);
  const onBoard = await js(
    "[...document.querySelectorAll('#brakeset-list .brack-name')].some(n => n.textContent.includes('" + target + "'))");
  check('the board redraws with the new number', onBoard);

  // A part with hours on it must read as worn from across the box: type the
  // life away in the open editor and the bar has to change colour with it.
  await js(`(() => {
    const inp = document.querySelector('#brakeset-list .brack-edit input[data-bset-hours]');
    inp.value = '13';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await wait(900);
  const worn = await js(`(() => {
    const row = [...document.querySelectorAll('#brakeset-list .brack-row')]
      .find(r => r.querySelector('.brack-name').firstChild.textContent.trim() === ${JSON.stringify(target)});
    if (!row) return null;
    return { bar: row.querySelector('.brack-bar').className, left: row.querySelector('.brack-left').textContent };
  })()`);
  console.log('   worn part reads:', JSON.stringify(worn));
  check('a nearly-spent part turns its bar red', !!worn && /crit/.test(worn.bar) && worn.left === '7%');

  // A measured wear figure: the LEFT % box writes the hours through the
  // part's life, so the crew types what the gauge reads, not arithmetic.
  // The open part is a front disc set (life 14 h), so 50% left is 7 h.
  await js(`(() => {
    const inp = document.querySelector('#brakeset-list .brack-edit input[data-bset-left]');
    inp.value = '50';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const halfLife = await until(() => Object.values(shared.cars['1'].brakeSets || {})
    .some(pool => pool.some(t => t.name === target && Math.abs(t.hours - 7) < 0.01)));
  check('typing LEFT % writes the matching hours on the part', halfLife);
  await wait(700);
  const halfRow = await js(`(() => {
    const row = [...document.querySelectorAll('#brakeset-list .brack-row')]
      .find(r => r.querySelector('.brack-name').firstChild.textContent.trim() === ${JSON.stringify(target)});
    return row ? row.querySelector('.brack-left').textContent : null;
  })()`);
  check('the board reads 50% left after the correction', halfRow === '50%');

  // The part on the car takes a correction too: its hours box re-seeds the
  // live counter, so the brake panel reads the measured figure and ticks on.
  const onCarNo = await js(`(() => {
    const row = document.querySelector('#brakeset-list .brack-row.oncar');
    const no = row.querySelector('.brack-name').firstChild.textContent.trim();
    row.click();
    return no;
  })()`);
  await wait(400);
  const onCarBox = await js(
    "!!document.querySelector('#brakeset-list .brack-edit input[data-bset-hours]:not([disabled])')");
  check('the on-car part offers a live hours box', onCarBox);
  await shoot('brake-rack-wear.png');
  await js(`(() => {
    const inp = document.querySelector('#brakeset-list .brack-edit input[data-bset-hours]');
    inp.value = '5';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const reseeded = await until(() => {
    const car = shared.cars['1'];
    return Object.entries(car.brakeSets).some(([comp, pool]) =>
      pool.some(t => t.name === onCarNo && t.id === car.state.currentBrakeSetId[comp] &&
        Math.abs((car.state.brakeUsedH[comp] || 0) - 5) < 0.1));
  });
  check('a measured figure on the car re-seeds the live counter', reseeded);
  // Fold the editor back up so the kit checks below start from a resting board.
  await js("document.querySelector('#brakeset-list .brack-row.open').click(); true");
  await wait(400);

  // Making and breaking a kit is what this board is FOR, and both halves now
  // live on the box head and in the folded-out editor — so drive them there.
  // A full rack has every disc set bedded already, so free one first.
  const kitsFull = await js("document.querySelectorAll('#brakeset-list input[data-kitname]').length");
  await js(`(() => {
    const unbeds = document.querySelectorAll('#brakeset-list .brack-axle:first-child [data-act="unlink"]');
    unbeds[unbeds.length - 1].click();
    return true;
  })()`);
  await wait(900);
  const kitsAfterUnbed = await js("document.querySelectorAll('#brakeset-list input[data-kitname]').length");
  check('UNBED on a kit head breaks the pair', kitsAfterUnbed === kitsFull - 1);

  await js("document.querySelector('#brakeset-list .brack-kit.loose .brack-row').click(); true");
  await wait(400);
  const bedBtn = await js(
    "!!document.querySelector('#brakeset-list .brack-kit.loose .brack-edit [data-act=\"bed\"]:not([disabled])')");
  check('a free pad set offers BED ONTO in its editor', bedBtn);
  await js(`(() => {
    document.querySelector('#brakeset-list .brack-kit.loose .brack-edit [data-act="bed"]').click();
    return true;
  })()`);
  await wait(400);
  const picks = await js(
    "document.querySelectorAll('#brakeset-list .brack-kit.loose .brack-ask [data-pick]').length");
  check('it offers the bare disc sets to bed onto', picks > 0);
  await js("document.querySelector('#brakeset-list .brack-kit.loose .brack-ask [data-pick]').click(); true");
  await wait(900);
  const kitsRebedded = await js("document.querySelectorAll('#brakeset-list input[data-kitname]').length");
  check('bedding a pad set back on makes the kit again', kitsRebedded === kitsFull);

  // The same board in daylight — a station in a sunlit pit box runs the light
  // theme, and every colour on this board is a variable so it has to follow.
  await js("document.body.classList.add('light'); true");
  await wait(400);
  await shoot('brake-rack-light.png');
  await js("document.body.classList.remove('light'); true");

  check('no console errors on the station', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('   ' + consoleErrors.join('\n   '));

  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASS');
  app.exit(failed.length ? 1 : 0);
});
