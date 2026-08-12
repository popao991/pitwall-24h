// Race-control messages: a strip under the top bar with the newest few
// messages, and a HISTORY overlay with the full timestamped session log.
// Shared by the pit wall and the stations — only how many lines the strip
// shows differs (the wall can afford more than a pit-lane laptop).
//
// The data is the timing snapshot's `rcLog`, built on the pit wall PC by the
// timing engine (TeamStream <smsg> / Al Kamel race_control) and rebroadcast
// with every snapshot, so every screen shows the identical log.

import { icon } from './icons.js';

const esc = s => String(s).replace(/</g, '&lt;');

// Visual class for a message so flag calls and penalties stand out.
export function rcClass(text) {
  const t = String(text).toLowerCase();
  if (/red flag/.test(t)) return 'red';
  if (/safety car|code ?60|full course yellow|\bfcy\b|yellow/.test(t)) return 'fcy';
  if (/green flag|track clear|restart/.test(t)) return 'green';
  if (/penal|drive.?through|stop.?and.?go|black flag|investigat|warning/.test(t)) return 'pen';
  return '';
}

const fmtTime = ms => new Date(ms).toLocaleTimeString([], { hour12: false });
// History rows carry the date once the log spans midnight — a 24 h race does.
function fmtWhen(ms) {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour12: false });
  return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString() + ' ' + t;
}

// Expects the page to carry the shared markup: #rc-strip (with #rc-lines and
// #btn-rc-history inside) and the #rc-overlay modal with #rc-history/#rc-count.
export function createRcPanel({ limit = 3 } = {}) {
  const $ = id => document.getElementById(id);
  const strip = $('rc-strip');
  const overlay = $('rc-overlay');
  let timing = null;
  let lastKey = '';
  let lastCount = -1;
  let flashTimer = null;

  $('btn-rc-history').addEventListener('click', () => {
    overlay.classList.remove('hidden');
    renderHistory();
  });
  $('btn-rc-close').addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });

  function renderStrip() {
    const live = timing?.conn === 'connected' || timing?.conn === 'replay';
    const log = live ? timing.rcLog || [] : [];
    if (!log.length) {
      strip.classList.add('hidden');
      lastKey = '';
      lastCount = -1; // a reconnect replays the history — don't flash for it
      return;
    }
    strip.classList.remove('hidden');

    // A genuinely new message (not the initial history load) flashes the
    // strip briefly so it registers from across the pit box.
    if (lastCount >= 0 && log.length > lastCount) {
      strip.classList.add('flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => strip.classList.remove('flash'), 3500);
    }
    lastCount = log.length;

    const recent = log.slice(-limit).reverse(); // newest on top
    const key = recent.map(m => m.ms + m.text).join('|');
    if (key === lastKey) return; // messages are rare — skip the DOM churn
    lastKey = key;
    document.getElementById('rc-lines').innerHTML = recent.map((m, i) => `
      <div class="rcline${i === 0 ? ' newest' : ''} ${rcClass(m.text)}">
        <span class="t num">${fmtTime(m.ms)}</span>
        <span class="txt">${esc(m.text)}</span>
      </div>`).join('');
    document.getElementById('btn-rc-history').innerHTML =
      icon('note') + ` HISTORY (${log.length})`;
    if (!overlay.classList.contains('hidden')) renderHistory();
  }

  function renderHistory() {
    const log = (timing?.rcLog || []).slice().reverse(); // newest first
    document.getElementById('rc-count').textContent = log.length
      ? `${log.length} message${log.length === 1 ? '' : 's'} this session — newest first, times are this PC's clock.`
      : 'No race control messages yet.';
    document.getElementById('rc-history').innerHTML = log.map(m => `
      <tr class="${rcClass(m.text)}">
        <td class="t num">${fmtWhen(m.ms)}</td>
        <td>${esc(m.text)}</td>
      </tr>`).join('');
  }

  return {
    update(t) {
      timing = t;
      renderStrip();
    }
  };
}
