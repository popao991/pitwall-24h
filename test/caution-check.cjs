// Visual check of the neutralisation call on a real station window: the three
// figures the model needs and had nowhere to live (how long a caution runs,
// the slack on a stop, the fuel burnt in the lane) are editable on the card,
// the card says WHEN each kind of stop starts to pay, and the graph behind the
// cog draws the whole comparison across the stint. Everything is asserted
// against what the station actually drew, then captured for eyes.
//
// Run with:  npx electron test/caution-check.cjs [outputDir]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || __dirname;
app.setPath('userData', path.join(require('node:os').tmpdir(), `pitwall-caution-check-${process.pid}`));
const appProtocol = require(path.join(root, 'app-protocol.cjs'));
appProtocol.registerScheme();
app.on('window-all-closed', () => {});

setTimeout(() => { console.log('GLOBAL TIMEOUT'); app.exit(2); }, 120000);
const wait = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? '  (' + detail + ')' : ''}`);
};

app.whenReady().then(async () => {
  appProtocol.installHandler(root);
  // 8485-8487 smoke.mjs, 8488 plan-edit-check, 8489 brake-rack-check,
  // 8490 warmer-check, 8491 face-check, 8492 timeline-check — this owns 8493.
  const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'server.js')));
  const info = startServer({ dataFile: null, port: 8493 });
  ipcMain.handle('start-server', () => ({ port: info.port, ips: info.ips }));
  ipcMain.handle('get-version', () => ({ version: 'test', packaged: false }));
  ipcMain.handle('check-updates', () => ({ status: 'dev', message: 'test mode' }));
  ipcMain.handle('list-backups', () => []);

  const station = new BrowserWindow({
    show: true, width: 1600, height: 1100,
    webPreferences: { preload: path.join(root, 'preload.cjs') }
  });
  const consoleErrors = [];
  station.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  await station.loadURL('app://root/renderer/station.html');
  await station.webContents.executeJavaScript(
    "localStorage.setItem('serverPort','8493');" +
    "localStorage.setItem('serverIp','127.0.0.1');" +
    "localStorage.setItem('carId','1'); true"
  );
  await station.webContents.reload();
  await wait(2500);
  const js = s => station.webContents.executeJavaScript(s);

  const WebSocket = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:8493');
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

  // A car well into a stint on part-worn rubber: the state where the call is
  // actually interesting, rather than the two ends where it is obvious.
  send({ type: 'startRace' });
  check('the race clock is running', await until(() => shared.race.startMs > 0));
  send({
    type: 'update',
    carId: '1',
    patch: {
      config: { cautionsPerHour: 0.639, cautionMinutes: 7.1, pitSlackSec: 0, pitLaneFuelL: 0 },
      state: { fuelLiters: 55, stintFuelStartL: 100 }
    }
  });
  for (let i = 0; i < 20; i++) send({ type: 'lap', carId: '1', lapSec: 104.5 });
  await until(() => shared.cars['1'].state.totalLaps >= 20);
  await wait(1600);

  // Toggling blind goes out of step the moment one click lands on a hidden
  // element; say which state is wanted instead.
  const cog = async open => {
    await js(`(() => {
      const p = document.getElementById('caution-cfg');
      if (p.hasAttribute('hidden') === ${!open}) return true;
      document.getElementById('btn-caution-cfg').click();
      return true;
    })()`);
    await wait(900);
    return js("!document.getElementById('caution-cfg').hasAttribute('hidden')");
  };

  // ---- the figures that had nowhere to live are on the card
  check('the cog opens the figures behind the call', await cog(true));

  const fields = await js(`(() => {
    const out = {};
    for (const k of ['cautionMinutes', 'pitSlackSec', 'pitLaneFuelL', 'cautionsPerHour']) {
      const el = document.querySelector('#caution-cfg input[data-cpath="' + k + '"]');
      out[k] = el ? { value: el.value, title: (el.closest('label') || {}).title || '' } : null;
    }
    return out;
  })()`);
  check('caution length is editable on the card', fields.cautionMinutes?.value === '7.1');
  check('stop slack is editable on the card', fields.pitSlackSec?.value === '0');
  check('pit lane fuel is editable on the card', fields.pitLaneFuelL?.value === '0');
  check('each new figure explains itself',
    ['cautionMinutes', 'pitSlackSec', 'pitLaneFuelL'].every(k => (fields[k]?.title || '').length > 60));

  // ---- the card says when each kind of stop starts to pay
  const outText = await js("document.getElementById('caution-out').textContent");
  check('the card says when fuel only starts to pay', /fuel only pays/.test(outText), outText.slice(0, 0));
  check('the card says when fuel + tyres starts to pay', /fuel \+ tyres pays/.test(outText));
  check('the card shows where the stint clock is', /stint clock/.test(outText));

  // ---- the graph
  const g = await js(`(() => {
    const box = document.getElementById('caution-graph');
    const svg = box.querySelector('svg');
    return {
      html: box.innerHTML,
      lines: svg ? svg.querySelectorAll('path.ccline').length : 0,
      zero: svg ? svg.querySelectorAll('line.cczero').length : 0,
      band: svg ? svg.querySelectorAll('rect.ccband').length : 0,
      now: svg ? svg.querySelectorAll('line.ccnow').length : 0,
      dots: svg ? svg.querySelectorAll('circle.ccdot').length : 0,
      labels: [...(svg ? svg.querySelectorAll('text.cclab') : [])].map(n => n.textContent),
      keys: [...box.querySelectorAll('.cckey span')].map(n => n.textContent),
      paceTabs: box.querySelectorAll('button[data-ccpace]').length,
      w: svg ? svg.clientWidth : 0, h: svg ? svg.clientHeight : 0
    };
  })()`);
  check('the graph draws one line per option', g.lines === 3, `${g.lines} lines`);
  check('the break-even line is on it', g.zero === 1);
  check('the too-close-to-call band is shaded', g.band === 1);
  check('the car\'s own position is marked', g.now === 1 && g.dots === 3, `now=${g.now} dots=${g.dots}`);
  // Emitted top to bottom so labels that would collide can be nudged apart —
  // the order on screen follows the lines, not the series list.
  check('every line is labelled at its end, not by colour alone',
    g.labels.length === 3 &&
    ['Fuel only', 'Tyres only', 'Fuel + tyres'].every(l => g.labels.includes(l)),
    g.labels.join(', '));
  check('the legend says when each option starts to pay',
    g.keys.length === 3 && g.keys.every(k => /from min|paying now|never this stint/.test(k)),
    g.keys.join(' · '));
  check('both flags can be drawn', g.paceTabs === 2);
  check('the graph has real size in the panel', g.w > 200 && g.h > 90, `${g.w}x${g.h}`);
  check('series colours come from theme tokens, never hardcoded hex',
    /stroke="var\(--cc-/.test(g.html) && !/stroke="#/.test(g.html));

  // The numbers behind the picture, for anyone who cannot read it off colour.
  await js("document.querySelector('#caution-graph button[data-cctable]').click(); true");
  await wait(400);
  const rows = await js("document.querySelectorAll('#caution-graph table.cctable tbody tr').length");
  check('the numbers can be read as a table', rows >= 5, `${rows} rows`);
  await js("document.querySelector('#caution-graph button[data-cctable]').click(); true");
  await wait(300);

  // Asking the chart about a minute other than the one the car is on.
  const tip = await js(`(() => {
    const svg = document.querySelector('#caution-graph svg');
    const hit = svg.querySelector('.cchit');
    const r = svg.getBoundingClientRect();
    hit.dispatchEvent(new PointerEvent('pointermove', {
      clientX: r.left + r.width * 0.6, clientY: r.top + r.height * 0.5, bubbles: true }));
    const t = svg.querySelector('.cctip');
    return { shown: !t.hasAttribute('hidden'), text: t.textContent };
  })()`);
  check('hovering reads out any minute of the stint', tip.shown && /min \d+/.test(tip.text),
    tip.text.trim().slice(0, 60));

  // ---- the proposed stop itself carries the answer
  await cog(false);
  await js("document.querySelector('#plan-tabs button[data-plan=\"fcy\"]').click(); true");
  await wait(1400);
  const plan = await js(`({
    head: document.getElementById('plan-head').textContent,
    sub: document.getElementById('plan-sub').textContent
  })`);
  check('the proposed Code 60 stop names the work it is worth doing',
    /BOX NOW · (FUEL ONLY|FUEL \+ TYRES|TYRES ONLY)|STAY OUT|LINE BALL/.test(plan.head), plan.head);
  check('and says how it got there',
    /up on staying out|starts paying|window is open|too close to call|clear of the next plan/.test(plan.sub),
    plan.sub.slice(0, 90));

  // ---- captures
  check('the race is still running at capture time', shared.race.startMs > 0,
    `startMs ${shared.race.startMs}`);
  check('the panel is open at capture time', await cog(true));

  // The graph itself, measured fresh each time and clamped to the window: the
  // whole cfg panel is taller than the viewport, and a rect that runs off it
  // captures nothing at all.
  const shoot = async file => {
    await js("document.getElementById('caution-graph').scrollIntoView({block:'center'}); true");
    await wait(500);
    const r = await js(`(() => {
      const b = document.getElementById('caution-graph').getBoundingClientRect();
      const x = Math.max(0, Math.floor(b.x) - 10), y = Math.max(0, Math.floor(b.y) - 10);
      return { x, y,
        width: Math.min(Math.ceil(b.width) + 20, window.innerWidth - x),
        height: Math.min(Math.ceil(b.height) + 20, window.innerHeight - y) };
    })()`);
    const img = await station.webContents.capturePage(r);
    const png = img.toPNG();
    fs.writeFileSync(path.join(outDir, file), png);
    console.log(`   captured ${file} (${r.width}x${r.height}, ${png.length} bytes)`);
    return png.length;
  };

  check('the dark capture has pixels in it', await shoot('caution-graph.png') > 2000);

  await js("document.body.classList.add('light'); true");
  await wait(1400);
  // Every colour on the chart is a theme token, so daylight must repaint it
  // without a single line of chart code knowing the theme exists.
  const themed = await js(`(() => {
    const s = getComputedStyle(document.body);
    return {
      cls: document.body.className,
      fuel: s.getPropertyValue('--cc-fuel').trim(),
      panel: getComputedStyle(document.querySelector('.planner')).backgroundColor
    };
  })()`);
  check('daylight repaints the card', /light/.test(themed.cls), themed.cls);
  check('daylight repaints the series colours', themed.fuel === '#0b7dc9', themed.fuel);
  // A chart drawn on a surface that stayed dark would pass every colour check
  // and still be unreadable.
  check('daylight repaints the surface under it',
    themed.panel === 'rgb(248, 250, 252)', themed.panel);
  check('the light capture has pixels in it', await shoot('caution-graph-light.png') > 2000);
  await js("document.body.classList.remove('light'); true");

  // ---- the bypass on the same panel: the crew's own points for a flag.
  // Left until after the captures, because turning it on changes the answer
  // the card is showing and the screenshots above are of the ranking.
  await cog(true);
  const rOff = await js("document.getElementById('flagrule-out').textContent");
  check('the points say so while they are off', /the ranking above is making the call/.test(rOff),
    rOff.trim().slice(0, 50));

  // A fuel point no tank could be above: whatever this car is carrying, it is
  // under it, so the stop is called and the wording can be read back.
  await js(`(() => {
    const box = document.getElementById('flagrule-on');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const f = document.querySelector('input[data-cpath="flagRule.fuelL"]');
    f.value = '999';
    f.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await wait(1400);
  const rOn = await js("document.getElementById('flagrule-out').textContent");
  check('a point the car is already past reads as a stop', /BOX/.test(rOn), rOn.trim().slice(0, 60));

  await cog(false);
  // The tabs toggle: the Code 60 tab was already held above, and clicking it
  // again would drop the card back onto the live plan — which is green here.
  await js(`(() => {
    const b = document.querySelector('#plan-tabs button[data-plan="fcy"]');
    if (!b.classList.contains('on')) b.click();
    return true;
  })()`);
  await wait(1400);
  const ruled = await js(`({
    head: document.getElementById('plan-head').textContent,
    sub: document.getElementById('plan-sub').textContent
  })`);
  check('and the Code 60 stop is answered off them, not the ranking',
    /BOX NOW/.test(ruled.head) && /Your points/.test(ruled.sub), ruled.sub.slice(0, 70));

  check('no console errors on the station', consoleErrors.length === 0);
  if (consoleErrors.length) console.log('   ' + consoleErrors.join('\n   '));

  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASS');
  app.exit(failed.length ? 1 : 0);
});
