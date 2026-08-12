// Race-condition presentation, shared by the pit wall and the car stations so
// every screen in the garage shows the identical state at the identical time.
//
// The design rule this file encodes: GREEN IS SILENT. A 24-hour race spends
// most of its life under green, so styling it would train everyone to ignore
// the bar. Everything else tints the whole top bar, and only the conditions
// that change a pit decision *right now* (FCY / SC / Code 60) also flash.
// The words in the condition block always carry the meaning on their own —
// colour and motion are reinforcement, never the sole signal.

import { icon } from './icons.js';
import { raceCondition } from '../../shared/model.js';

const COND_ICON = {
  fcy: 'flag',
  code60: 'flag',
  sc: 'safetycar',
  red: 'redflag',
  finish: 'chequered',
  green: 'flag'
};

// Where the condition came from, in the fewest words that still remove doubt
// about whether a human or the feed put the race here.
function sourceLabel(cond) {
  if (cond.overridden) return cond.id === 'green' ? 'FORCED GREEN' : 'MANUAL';
  if (cond.source === 'feed') return 'TIMING FEED';
  if (cond.source === 'manual') return 'MANUAL';
  return '';
}

function fmtElapsed(ms) {
  if (!(ms > 0)) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// Paint a top bar for the current condition. `barEl` is the .topbar element and
// `blockEl` the .condblock inside it. Returns the resolved condition so callers
// can reuse it without resolving twice.
export function renderConditionBar(barEl, blockEl, state, now = Date.now()) {
  const cond = raceCondition(state.race);
  const fcy = state.race?.fcy || {};

  if (barEl) {
    for (const c of ['fcy', 'code60', 'sc', 'red', 'finish', 'green']) {
      barEl.classList.toggle('cond-' + c, cond.id === c);
    }
    // Green carries no class at all — nothing to strip, nothing to notice.
    barEl.classList.remove('cond-green');
  }

  if (blockEl) {
    if (cond.id === 'green') {
      blockEl.innerHTML = '';
    } else {
      const src = sourceLabel(cond);
      // Only neutralisations have a meaningful running time.
      const elapsed = (cond.pace === 'sc' || cond.pace === 'fcy') && fcy.startMs
        ? fmtElapsed(now - fcy.startMs) : '';
      blockEl.innerHTML = [
        icon(COND_ICON[cond.id] || 'flag'),
        `<span class="lab">${cond.label}</span>`,
        elapsed ? `<span class="elapsed">${elapsed}</span>` : '',
        src ? `<span class="src">${src}</span>` : ''
      ].join('');
    }
  }
  return cond;
}

// The manual race-condition controls: one start/stop toggle per condition a
// human may call. Every press goes to the server, and the server broadcasts
// the result, so any station starting or stopping a condition flips every
// screen in the garage at once — crowd-sourced intervention for the moments
// the crew sees the boards before the timing feed reacts. Code 60 rides on
// the FCY button: same pace family, and a fourth button would crowd the bar.
const MANUAL_CONDITIONS = [
  { id: 'fcy', short: 'FCY', icon: 'flag', covers: ['fcy', 'code60'],
    start: 'Full course yellow for everyone: all four cars switch to the FCY burn rate on every screen.' },
  { id: 'sc', short: 'SC', icon: 'safetycar', covers: ['sc'],
    start: 'Safety car for everyone: all four cars switch to the SC burn rate on every screen.' },
  { id: 'red', short: 'RED', icon: 'redflag', covers: ['red'],
    start: 'Red flag for everyone: the field stops and fuel burn pauses on every screen.' }
];

// Build the buttons once; `sendMode` ships the chosen override to the server.
// What each press means is recomputed on every render (dataset.mode below).
export function initConditionControls(rowEl, sendMode) {
  if (!rowEl) return;
  for (const mc of MANUAL_CONDITIONS) {
    const b = document.createElement('button');
    b.className = 'condbtn c-' + mc.id;
    b.dataset.cond = mc.id;
    b.addEventListener('click', () => { if (b.dataset.mode) sendMode(b.dataset.mode); });
    rowEl.appendChild(b);
  }
}

export function renderConditionControls(rowEl, state, { compact = false } = {}) {
  if (!rowEl || !state) return;
  const cond = raceCondition(state.race);
  const fcy = state.race?.fcy || {};
  // Forced green: the release lives on the button of the flag being held back
  // (FCY as the fallback when the feed dropped or the flag maps to no button).
  const heldId = fcy.mode === 'green' && cond.overridden
    ? (MANUAL_CONDITIONS.find(m => m.covers.includes(cond.feedId))?.id || 'fcy')
    : null;

  for (const b of rowEl.querySelectorAll('button[data-cond]')) {
    const mc = MANUAL_CONDITIONS.find(m => m.id === b.dataset.cond);
    const active = mc.covers.includes(cond.id);
    // A red flag the FEED reports cannot be overridden away (the field is
    // genuinely stopped) — the button states the fact instead of lying.
    const feedRed = cond.id === 'red' && cond.source === 'feed';
    let label;
    let mode;
    let cls = 'condbtn c-' + mc.id;
    let title;
    if (heldId === mc.id) {
      // Three buttons share the row, so the label stays short — the tooltip
      // carries the full story.
      label = 'FORCED GREEN';
      mode = 'auto';
      cls += ' forced-green';
      title = 'Holding green against the feed. Press to follow the feed again.';
    } else if (active) {
      const short = cond.id === 'code60' ? 'CODE 60' : mc.short;
      label = `END ${short}`;
      // Ending a condition the feed still reports must hold green against
      // it; ending one somebody here forced simply returns to the feed.
      mode = feedRed ? '' : (cond.feedId && cond.feedId !== 'green' ? 'green' : 'auto');
      cls += ' on' + (cond.source === 'feed' ? ' from-feed' : '');
      title = feedRed
        ? 'Reported by the timing feed — clears when the feed does.'
        : (cond.source === 'feed'
          ? 'Detected from the timing feed. Press to override back to green — on every screen.'
          : 'Called manually. Press to end it — on every screen.');
    } else {
      label = compact ? mc.short : `START ${mc.short}`;
      mode = mc.id;
      title = mc.start;
    }
    b.dataset.mode = mode;
    b.disabled = mode === '';
    b.className = cls;
    b.title = title;
    b.innerHTML = icon(mc.icon) + ` <span>${label}</span>`;
  }
}
