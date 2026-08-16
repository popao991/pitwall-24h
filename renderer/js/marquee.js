// Lines that scroll when they carry more than fits.
//
// The verdict band answers "what now?" in one line, but the answer is not
// always the same length — a low-fuel warning stacked in front of a window
// call runs past the card. Clipping a centred line hides both ends, and an
// ellipsis hides the part that says how much fuel to put in. Such a line
// loops its content instead. Every marquee on the page travels at the same
// pixels per second, so four cards scrolling at once read as one board
// rather than four unrelated tickers.

const SPEED_PX_S = 45; // travel speed, shared by every line on the page
const SLACK_PX = 2;    // sub-pixel overflow is not overflow

const lines = new Set();

// A line can be measured before it has a box — hidden behind display:none, or
// laid out in the same frame it was filled. The observer catches it when it
// gets one, and re-measures whenever the card is resized.
const ro = typeof ResizeObserver === 'function'
  ? new ResizeObserver(entries => { for (const e of entries) measure(e.target); })
  : null;

// Fill el with html, scrolling it if it does not fit. Cheap to call on every
// render tick: unchanged markup is left alone, so a running scroll is not
// restarted every second.
export function setMarquee(el, html) {
  if (!el) return;
  // Re-asserted every call: callers rewrite className to restyle a line, and
  // that must not quietly stop a scroll that is already running.
  el.classList.add('marquee');
  if (el.__mqHtml === html) {
    el.classList.toggle('mq-on', !!el.__mqOn);
    return;
  }
  el.__mqHtml = html;
  el.innerHTML = `<span class="mq-track"><span class="mq-item">${html}</span></span>`;
  if (!lines.has(el)) {
    lines.add(el);
    ro?.observe(el);
  }
  measure(el);
}

function measure(el) {
  const track = el.querySelector('.mq-track');
  const item = track?.firstElementChild;
  if (!item) return;
  const room = el.clientWidth;
  const need = item.getBoundingClientRect().width;
  if (!room || !need) return; // no box yet — the observer comes back to it
  if (need - room > SLACK_PX) {
    if (track.children.length < 2) {
      const copy = item.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      track.appendChild(copy);
    }
    // One cycle carries the text exactly onto where its repeat sits now, so
    // the loop is seamless whatever gap the stylesheet puts between them.
    const shift = track.lastElementChild.getBoundingClientRect().left -
                  item.getBoundingClientRect().left;
    if (shift <= 0) return;
    el.style.setProperty('--mq-shift', `-${shift.toFixed(1)}px`);
    el.style.setProperty('--mq-dur', `${(shift / SPEED_PX_S).toFixed(2)}s`);
    el.__mqOn = true;
    el.classList.add('mq-on');
  } else {
    el.__mqOn = false;
    el.classList.remove('mq-on');
    while (track.children.length > 1) track.lastElementChild.remove();
  }
}

window.addEventListener('resize', () => { for (const el of lines) measure(el); });
