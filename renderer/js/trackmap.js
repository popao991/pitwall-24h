// Live track map ("tracker") view — car dots moving around an SVG circuit,
// like the getraceresults tracker screen. Shared by the pit wall and the
// stations; both mount it into a container and feed it timing snapshots.
//
// Positions come from two sources, best first:
//  1. The tracker feed (timing.tracker, decoded from t_i/t_p frames): the car
//     crossed the loop at fromMm at server time ts travelling at speed mm/s —
//     dead-reckon pos = from + speed·Δt and clamp at the segment end until
//     the next crossing. This is exactly what the vendor tracker renders.
//  2. Lap-clock fallback: the "E<epoch µs>" running state plus the car's last
//     lap time give a lap fraction. Coarser (uniform speed), but it works on
//     feeds without tracker data (Al Kamel) and keeps the map alive.
//
// The circuit outline is ours, not vendor data: centerline + pit lane traced
// from Zolder.svg (Inkscape layer1 coordinates, drawing order = race
// direction). Start/finish sits at sfFrac of the path length; a per-track
// calibration (offset slider + flip) is persisted locally for fine-tuning.

import { fmtGapUs, ourTimingNrs } from '../../shared/model.js';
import { icon } from './icons.js';

export const TRACKS = {
  zolder: {
    id: 'zolder',
    name: 'Circuit Zolder',
    lengthM: 4007,
    sfFrac: 0.88314, // fraction of loop path length at the start/finish line
    dir: 1, // +1: path drawing order matches race direction (clockwise)
    // Sector boundaries as lap fractions, off the circuit's official track map:
    // Int 1 at 1376,4 m and Int 2 at 2864,6 m of 4007 m, with the start line at
    // offset 0 m — so S1 = 1.3764 km, S2 = 1.4882 km, S3 = 1.1424 km. A tracker
    // feed's own timing-loop distances, or a dragged calibration, still win:
    // this is what the map draws before either exists.
    sectorFracs: [0.34350, 0.71490],
    loopD: 'm 1648.4978,1400.4881 c -38.5287,-17.3983 -78.7147,-33.9749 -118.1689,-48.0943 -8.8663,-3.173 -23.3529,-4.1503 -28.8376,-3.2321 -6.576,1.4351 -18.8431,12.996 -29.3665,31.8643 -3.0586,7.1789 -4.8732,13.0578 -10.5627,30.9682 -6.4709,18.1663 -14.0519,44.2311 -46.8878,144.8904 -5.4063,15.468 -17.0927,32.2832 -30.1708,41.9039 -11.2261,8.2583 -29.3767,13.4956 -42.742,11.7331 -12.0564,-1.5898 -23.6825,-12.9335 -33.523,-21.79 -18.0954,-16.2858 -38.7573,-32.9469 -50.2847,-53.637 -10.2627,-18.4202 -15.5184,-42.6234 -15.0854,-63.6938 0.4051,-19.716 9.0639,-40.2117 17.5997,-58.6654 20.7969,-44.9609 43.6232,-90.4358 70.3984,-131.5782 7.586,-11.6565 20.0232,-22.27 32.685,-26.8184 16.1122,-5.7879 36.3308,-7.238 53.637,-4.1904 27.1119,4.7744 53.2396,17.988 79.6173,27.6565 122.2413,44.8065 260.7168,101.8854 383.1214,141.9073 9.1735,2.9994 6.9476,-10.8673 12.3803,-16.1046 14.1225,-0.2621 34.9202,-2.4044 52.8696,-2.6053 39.0815,-1.0978 78.4546,-3.9686 117.3308,-7.5427 44.5184,-4.0929 101.2484,-17.1513 144.0785,-39.036 6.1672,-3.1512 27.0528,-19.0923 36.9462,-29.6863 25.6877,-27.5068 43.1516,-62.5444 66.2081,-92.1885 2.3652,-3.0409 7.136,-8.1471 10.8242,-8.1686 3.9754,-0.023 12.4199,7.8773 17.0038,6.6639 4.9143,-1.3009 9.3942,-10.2525 13.0255,-14.2066 8.9399,-9.7345 12.6579,-20.9344 22.7696,-28.3939 6.9292,-5.1117 17.5149,-7.1032 26.0511,-4.7155 31.4122,8.7866 66.1498,19.2352 93.0266,37.0876 11.3954,7.5692 21.4827,23.1098 21.79,36.8754 1.0895,48.8108 -21.3599,100.9743 -17.5996,150.8539 5.7379,76.1113 25.5871,157.5047 45.3269,227.5026 2.9017,10.2893 -4.8365,26.3494 -18.0133,22.4566 -32.5037,-9.6025 -59.3793,-17.8132 -90.1694,-27.1066 -13.6265,-4.1129 -28.5175,-0.1289 -41.9039,-4.9526 -108.0654,-38.9405 -204.9291,-67.3748 -300.8697,-107.2738 -45.6703,-18.993 -51.6637,-19.8423 -59.9134,3.1663 -6.0244,16.8023 -28.5588,27.558 -41.3569,21.2363 -20.014,-9.886 -223.4563,-89.901 -341.2344,-143.0857 z',
    // Pit lane, drawn entry → exit (entry after the last corner, exit past T1).
    pitD: 'm 2111.1919,1525.5686 c -11.2845,-4.6424 -50.0146,-21.2349 -58.2494,-23.7806 -11.8041,-3.6491 -65.7889,-27.6364 -81.9201,-31.8326 -8.2638,-2.1496 -38.753,22.2751 -47.0587,21.1917 -11.4545,-1.4941 -11.17,1.4534 -44.4521,-11.9738 -33.3743,-13.4643 -259.4006,-105.4529 -377.1021,-153.7334 l -41.4997,-18.0419 c 0,0 -14.8422,-1.6998 -21.8695,-1.151 -7.0273,0.5488 -14.3507,1.9522 -19.9511,4.2204 -5.6004,2.2682 -9.5591,5.0565 -13.4286,8.4408 -3.8695,3.3843 -7.1589,7.0207 -9.5919,11.5103 -2.433,4.4896 -3.4244,8.5526 -4.6041,14.9633 -1.1797,6.4107 -1.5432,15.7137 -1.5347,23.4042 0.01,7.6905 1.4708,22.1252 1.5347,22.6368 0.064,0.5116 0.2558,2.0463 0.3837,3.0694 0.1279,0.3837 0.3043,0.7544 0.3836,1.151 0.1774,0.8868 0.3197,2.2381 0.3837,2.6857 0.064,0.4476 10.269,46.608 13.8123,63.6901 3.5433,17.0821 6.0512,28.6241 7.6735,38.7512 1.6223,10.1271 2.2941,14.4341 2.6857,21.8694 0.3916,7.4353 -0.3836,22.6368 -0.3836,22.6368'
  }
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const esc = s => String(s).replace(/</g, '&lt;');

export function createTracker(container, { track = TRACKS.zolder } = {}) {
  // ---- calibration (per track, this screen only) ----
  const calKey = 'trk-cal-' + track.id;
  let cal = { off: 0, flip: false };
  try {
    cal = { ...cal, ...JSON.parse(localStorage.getItem(calKey) || '{}') };
  } catch {}
  const saveCal = () => localStorage.setItem(calKey, JSON.stringify(cal));

  // ---- DOM ----
  container.innerHTML = '';
  const wrap = el('div', 'trkwrap');
  const mapBox = el('div', 'trkmap');
  const svg = svgEl('svg', { role: 'img', 'aria-label': 'Live track map, ' + track.name });
  const gTrack = svgEl('g');
  const loopPath = svgEl('path', { d: track.loopD, class: 'trk-loop' });
  const pitPath = svgEl('path', { d: track.pitD, class: 'trk-pit' });
  const gSectors = svgEl('g');
  const gLoops = svgEl('g');
  const gCars = svgEl('g');
  gTrack.append(pitPath, loopPath);
  svg.append(gTrack, gSectors, gLoops, gCars);
  const hint = el('div', 'trkhint');
  mapBox.append(svg, hint);

  const rail = el('div', 'trkrail');
  rail.innerHTML = `<div class="hd"><span>POS</span><span>CAR</span><span class="g">GAP</span></div>`;
  const rows = el('div', 'rows');
  rail.appendChild(rows);

  const foot = el('div', 'trkfoot');
  foot.innerHTML = `
    <span class="lab">${track.name.toUpperCase()}</span>
    <span class="dragnote">drag the S/F line or a sector dot on the map to calibrate</span>
    <span class="spacer"></span>
    <span class="lab">S/F</span>
    <input type="range" min="-5000" max="5000" step="2" value="${cal.off}" data-t="off"
           title="Slide the start/finish anchor around the track (drag the white line on the map for the same thing)">
    <button data-t="flip" class="${cal.flip ? 'on' : ''}" title="Reverse the running direction on the map">
      ${icon('refresh')} FLIP</button>
    <button data-t="reset" title="Clear the local calibration (S/F offset, direction, sector boundaries)">
      ${icon('x')} RESET</button>`;
  const offSlider = foot.querySelector('[data-t="off"]');
  offSlider.addEventListener('input', e => {
    cal.off = +e.target.value;
    saveCal();
    drawStatic();
  });
  foot.querySelector('[data-t="flip"]').addEventListener('click', e => {
    cal.flip = !cal.flip;
    e.currentTarget.classList.toggle('on', cal.flip);
    saveCal();
    drawStatic();
  });
  foot.querySelector('[data-t="reset"]').addEventListener('click', () => {
    cal = { off: 0, flip: false, sec: null };
    saveCal();
    offSlider.value = 0;
    foot.querySelector('[data-t="flip"]').classList.remove('on');
    drawStatic();
  });

  wrap.append(mapBox, rail);
  container.append(wrap, foot);

  // ---- geometry ----
  // getTotalLength needs a rendered path; lengths are computed lazily on the
  // first frame after the view becomes visible.
  let loopTotal = 0;
  let pitTotal = 0;
  const dirNow = () => (cal.flip ? -track.dir : track.dir);
  const sfLen = () => (track.sfFrac + cal.off / 10000) * loopTotal;

  function loopXY(frac) {
    let l = sfLen() + dirNow() * frac * loopTotal;
    l = ((l % loopTotal) + loopTotal) % loopTotal;
    return loopPath.getPointAtLength(l);
  }
  function pitXY(frac) {
    return pitPath.getPointAtLength(Math.max(0, Math.min(1, frac)) * pitTotal);
  }

  function ensureGeometry() {
    if (loopTotal) return true;
    if (!svg.isConnected || !mapBox.offsetParent) return false;
    try {
      loopTotal = loopPath.getTotalLength();
      pitTotal = pitPath.getTotalLength();
    } catch {
      return false;
    }
    if (!loopTotal) return false;
    drawStatic();
    return true;
  }

  // Sector boundaries as lap fractions: the tracker feed's timing loops when
  // it has them, else the dragged calibration, else the track defaults.
  function boundsFromFeed() {
    const lenMm = lenMmNow();
    return (timing?.tracker?.loops || [])
      .filter(l => !l[1] && l[0] > 0 && l[0] < lenMm)
      .map(l => l[0] / lenMm)
      .sort((a, b) => a - b);
  }
  function sectorBoundFracs() {
    const fromFeed = boundsFromFeed();
    return fromFeed.length ? fromFeed : cal.sec || track.sectorFracs || [];
  }

  // Static overlay: sector colouring + badges, boundary dots, S/F tick.
  let loopsKey = '';
  function drawStatic() {
    if (!loopTotal) return;
    gSectors.innerHTML = '';
    gLoops.innerHTML = '';

    const bounds = sectorBoundFracs();
    const edges = [0, ...bounds, 1];
    const bb = loopPath.getBBox();
    const cx = bb.x + bb.width / 2;
    const cy = bb.y + bb.height / 2;

    for (let i = 0; i < edges.length - 1; i++) {
      // Colour the [edges[i], edges[i+1]] lap range: map both ends onto the
      // path, then draw the forward run between them with a dash window
      // (split in two when the range crosses the path seam).
      const a = ((sfLen() + dirNow() * edges[i] * loopTotal) % loopTotal + loopTotal) % loopTotal;
      const b = ((sfLen() + dirNow() * edges[i + 1] * loopTotal) % loopTotal + loopTotal) % loopTotal;
      const [start, end] = dirNow() > 0 ? [a, b] : [b, a];
      const ranges = end > start ? [[start, end]] : [[start, loopTotal], [0, end]];
      for (const [r0, r1] of ranges) {
        if (r1 - r0 < 1) continue;
        gSectors.appendChild(svgEl('path', {
          d: track.loopD,
          class: `trk-sector s${i % 4}`,
          'stroke-dasharray': `0 ${r0} ${r1 - r0} ${loopTotal + 1}`
        }));
      }
      // sector badge at the sector midpoint, pushed away from the map centre
      const mid = (edges[i] + edges[i + 1]) / 2;
      const p = loopXY(mid);
      const away = Math.hypot(p.x - cx, p.y - cy) || 1;
      const bx = p.x + ((p.x - cx) / away) * 84;
      const by = p.y + ((p.y - cy) / away) * 84;
      const badge = svgEl('g', { class: `trk-sbadge s${i % 4}`, transform: `translate(${bx},${by})` });
      badge.appendChild(svgEl('rect', { x: -30, y: -17, width: 60, height: 34, rx: 6 }));
      const t = svgEl('text');
      t.textContent = 'S' + (i + 1);
      badge.appendChild(t);
      gSectors.appendChild(badge);
    }

    // Boundary dots double as drag handles when the boundaries are local
    // (feed timing loops are data, not calibration — those stay fixed).
    const draggable = !boundsFromFeed().length;
    bounds.forEach((f, i) => {
      const p = loopXY(f);
      gLoops.appendChild(svgEl('circle', { class: 'trk-loopdot', cx: p.x, cy: p.y, r: 7 }));
      if (draggable) {
        gLoops.appendChild(svgEl('circle', {
          class: 'trk-handle', 'data-bound': i, cx: p.x, cy: p.y, r: 24
        }));
      }
    });

    const p0 = loopXY(0);
    const pB = loopXY(0.994);
    const ang = Math.atan2(p0.y - pB.y, p0.x - pB.x) + Math.PI / 2;
    const nx = Math.cos(ang) * 22;
    const ny = Math.sin(ang) * 22;
    gLoops.appendChild(svgEl('line', {
      class: 'trk-sf', x1: p0.x - nx, y1: p0.y - ny, x2: p0.x + nx, y2: p0.y + ny
    }));
    gLoops.appendChild(svgEl('circle', {
      class: 'trk-handle', 'data-sf': '1', cx: p0.x, cy: p0.y, r: 26
    }));

    // fit the view around track + badges
    const tb = gTrack.getBBox();
    const sb = gSectors.getBBox();
    const x0 = Math.min(tb.x, sb.x);
    const y0 = Math.min(tb.y, sb.y);
    const x1 = Math.max(tb.x + tb.width, sb.x + sb.width);
    const y1 = Math.max(tb.y + tb.height, sb.y + sb.height);
    const pad = 30;
    svg.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
  }

  // ---- drag calibration (S/F line and sector boundary dots) ----
  let loopSamples = null;
  function nearestLoopLen(x, y) {
    if (!loopSamples) {
      loopSamples = [];
      const n = 800;
      for (let i = 0; i < n; i++) {
        const l = (i / n) * loopTotal;
        const p = loopPath.getPointAtLength(l);
        loopSamples.push([l, p.x, p.y]);
      }
    }
    let best = 0;
    let bestD = Infinity;
    for (const [l, px, py] of loopSamples) {
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }

  function svgPointOf(e) {
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return pt;
  }

  let drag = null; // { sf: true } | { bound: index }
  svg.addEventListener('pointerdown', e => {
    const h = e.target.closest?.('.trk-handle');
    if (!h || !loopTotal) return;
    drag = h.dataset.sf ? { sf: true } : { bound: +h.dataset.bound };
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const pt = svgPointOf(e);
    if (!pt) return;
    const L = nearestLoopLen(pt.x, pt.y);
    if (drag.sf) {
      // move the whole reference frame: S/F snaps to the pointer
      let d = L / loopTotal - track.sfFrac;
      d = ((d + 0.5) % 1 + 1) % 1 - 0.5;
      cal.off = Math.round(d * 10000);
      offSlider.value = Math.max(-5000, Math.min(5000, cal.off));
    } else {
      // move one sector boundary, keeping order and a minimum sector size
      const sec = [...(cal.sec || sectorBoundFracs())];
      if (!sec.length) return;
      let f = (dirNow() * (L - sfLen())) / loopTotal;
      f = ((f % 1) + 1) % 1;
      const i = drag.bound;
      const lo = i > 0 ? sec[i - 1] + 0.02 : 0.02;
      const hi = i < sec.length - 1 ? sec[i + 1] - 0.02 : 0.98;
      sec[i] = Math.max(lo, Math.min(hi, f));
      cal.sec = sec;
    }
    drawStatic();
  });
  const endDrag = e => {
    if (!drag) return;
    drag = null;
    try {
      svg.releasePointerCapture(e.pointerId);
    } catch {}
    saveCal();
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  // ---- data + per-car display state ----
  let state = null;
  let timing = null;
  let rxMs = 0;
  let selectedNr = null;
  const cars = new Map(); // nr → {g, txt, dispMm (smoothed), inPit, seen}

  function serverNowUs() {
    return timing?.serverNowUs != null
      ? timing.serverNowUs + (Date.now() - rxMs) * 1000
      : null;
  }

  const ourNrs = () => ourTimingNrs(state);

  function lenMmNow() {
    return timing?.tracker?.lenMm ||
      (state?.event?.trackKm > 0 ? Math.round(state.event.trackKm * 1e6) : track.lengthM * 1000);
  }

  // Position of one timing entry, in track mm (or pit lane fraction).
  // Returns null when nothing usable is known.
  function positionOf(e, nowUs, lenMm) {
    const trk = timing?.tracker?.cars?.[e.nr];
    if (trk && nowUs != null && trk.tsUs > 0) {
      const dt = Math.max(0, (nowUs - trk.tsUs) / 1e6);
      let d = trk.fromMm + trk.speedMmS * dt;
      // Clamp at the segment end until the next loop crossing — the honest
      // dead-reckoning the feed supports (the vendor tracker does the same).
      if (trk.speedMmS >= 0 ? d > trk.toMm : d < trk.toMm) d = trk.toMm;
      if (trk.inPit) {
        const pits = (timing?.tracker?.loops || []).filter(l => l[1]).map(l => l[0]);
        const pitFrom = pits.length ? Math.min(...pits) : -40000;
        const pitTo = pits.length ? Math.max(...pits) : 360000;
        return { pit: true, frac: (d - pitFrom) / Math.max(1, pitTo - pitFrom) };
      }
      return { pit: false, mm: ((d % lenMm) + lenMm) % lenMm };
    }
    // Fallback: lap clock. "E<epoch µs>" = start of the running lap; the last
    // (or best) lap time scales it to a lap fraction at uniform speed.
    if (e.inPit) return { pit: true, frac: 0.5 };
    const st = typeof e.state === 'string' && e.state[0] === 'E' ? parseInt(e.state.slice(1), 10) : NaN;
    const refUs = e.lastUs || e.bestUs;
    if (!isNaN(st) && st > 0 && refUs > 0 && nowUs != null) {
      const frac = (nowUs - st) / refUs;
      if (frac >= -0.05) return { pit: false, mm: Math.min(0.999, Math.max(0, frac)) * lenMm };
    }
    return null;
  }

  function carGlyph(nr, ours) {
    const g = svgEl('g', { class: 'trk-car' + (ours ? ' ours' : '') });
    g.appendChild(svgEl('circle', { class: 'ring', r: 27 }));
    g.appendChild(svgEl('circle', { class: 'body', r: 20 }));
    const t = svgEl('text');
    t.textContent = nr;
    g.appendChild(t);
    g.addEventListener('click', () => select(nr));
    return g;
  }

  function select(nr) {
    selectedNr = selectedNr === nr ? null : nr;
    renderRail();
  }

  // ---- render loop ----
  let raf = 0;
  let lastFrameMs = 0;
  let lastRailMs = 0;
  let visible = false;

  function frame(nowMs) {
    raf = visible ? requestAnimationFrame(frame) : 0;
    if (!ensureGeometry()) return;
    const dt = Math.min(0.1, (nowMs - lastFrameMs) / 1000) || 0.016;
    lastFrameMs = nowMs;

    const entries = timing?.conn === 'connected' || timing?.conn === 'replay' ? timing.entries || [] : [];
    const nowUs = serverNowUs();
    const lenMm = lenMmNow();
    const ours = ourNrs();

    hint.textContent = !entries.length
      ? 'No live timing — connect a feed in SETTINGS → LIVE TIMING'
      : !timing?.tracker && !entries.some(e => typeof e.state === 'string' && e.state[0] === 'E')
        ? 'Feed has no position data — cars appear once lap clocks arrive'
        : '';

    const seen = new Set();
    for (const e of entries) {
      const pos = positionOf(e, nowUs, lenMm);
      if (!pos) continue;
      seen.add(e.nr);
      let c = cars.get(e.nr);
      if (!c) {
        c = { g: carGlyph(e.nr, ours.has(e.nr)), dispMm: null };
        cars.set(e.nr, c);
        gCars.appendChild(c.g);
      }
      c.g.classList.toggle('ours', ours.has(e.nr));
      c.g.classList.toggle('selected', selectedNr === e.nr);
      c.g.classList.toggle('inpit', !!pos.pit);
      let pt;
      if (pos.pit) {
        pt = pitXY(pos.frac);
        c.dispMm = null; // snap on pit transitions
      } else {
        if (c.dispMm == null) c.dispMm = pos.mm;
        // ease the shortest way around the lap (~150 ms), snap on big jumps
        let d = ((pos.mm - c.dispMm + lenMm * 1.5) % lenMm) - lenMm / 2;
        if (Math.abs(d) > 250000) c.dispMm = pos.mm;
        else c.dispMm = (((c.dispMm + d * Math.min(1, dt * 7)) % lenMm) + lenMm) % lenMm;
        pt = loopXY(c.dispMm / lenMm);
      }
      c.g.setAttribute('transform', `translate(${pt.x},${pt.y})`);
    }
    for (const [nr, c] of cars) {
      if (!seen.has(nr)) {
        c.g.remove();
        cars.delete(nr);
      }
    }

    if (nowMs - lastRailMs > 500) {
      lastRailMs = nowMs;
      renderRail();
      // sector overlay refreshes when the tracker loop config changes
      const key = JSON.stringify([timing?.tracker?.loops, lenMm]);
      if (key !== loopsKey) {
        loopsKey = key;
        drawStatic();
      }
    }
  }

  function renderRail() {
    const entries = timing?.conn === 'connected' || timing?.conn === 'replay' ? (timing.entries || []) : [];
    const ours = ourNrs();
    rows.innerHTML = entries.map(e => {
      const trk = timing?.tracker?.cars?.[e.nr];
      const seg = trk?.seg ?? -1;
      const chip = e.inPit || trk?.inPit
        ? '<span class="chip pit">PIT</span>'
        : trk
          ? `<span class="chip s${Math.max(0, seg) % 4}">S${Math.max(0, seg) + 1}</span>`
          : '';
      return `<div class="row${ours.has(e.nr) ? ' ours' : ''}${selectedNr === e.nr ? ' sel' : ''}"
        data-nr="${esc(e.nr)}">
        <span class="pos num">${e.pos ?? '—'}</span>
        <span class="nr num">${esc(e.nr)}</span>
        <span class="drv">${esc(e.driver || e.team || '')}</span>
        ${chip}
        <span class="gap num">${e.pos === 1 ? 'LEADER' : esc(fmtGapUs(e.gap))}</span>
      </div>`;
    }).join('');
  }
  rows.addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (row) select(row.dataset.nr);
  });

  return {
    setData(newState, newTiming, newRxMs) {
      state = newState ?? state;
      if (newTiming) {
        timing = newTiming;
        rxMs = newRxMs ?? Date.now();
      }
    },
    show() {
      if (visible) return;
      visible = true;
      lastFrameMs = 0;
      raf = requestAnimationFrame(frame);
    },
    hide() {
      visible = false;
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
