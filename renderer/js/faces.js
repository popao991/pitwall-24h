// Card faces — the same panel read a different way.
//
// A strategy card carries one headline reading, but the question behind it
// changes through a race: FUEL answers "how much is left" at hour 2 and "does
// the model still agree with the tank" at hour 14. Rather than grow every card
// until the screen is a wall of rows, a card can carry several faces and the
// engineer picks which one it shows.
//
// Two rules make this safe on a station:
//
//   1. The choice is LOCAL. It lives in this browser's store, never in the
//      shared race state — what a screen is looking at is not race truth, and
//      the engineer on the wall and the crew on the stand must be able to read
//      different faces of the same car at the same time.
//
//   2. A face swap must NEVER change the card's height. The station auto-fits
//      the whole page to the window (station.js autofit) by summing panel
//      heights, so a taller face would not merely reflow the column — it would
//      re-zoom the entire UI. So the panel is pinned to the height its FRONT
//      face last measured, and any face that overruns that scrolls inside it.
//
// Markup is declarative — no per-card wiring:
//
//   <div class="panel" id="card-pace" data-faces>
//     <h3>Pace</h3>
//     <div class="face" data-face="now" data-face-label="NOW">…</div>
//     <div class="face" data-face="sectors" data-face-label="SECTORS">…</div>
//   </div>
//
// The first .face is the front: it is what the card boots on, and it is the
// one whose height every other face is held to.

const STORE_PREFIX = 'cardFace:';

const cards = [];
let scopeKey = '';

function remembered(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: the choice just won't survive a reload */ }
}

// Which face is showing, and the tab that says so.
function paint(rec) {
  for (const f of rec.faces) f.classList.toggle('on', f.dataset.face === rec.active);
  for (const b of rec.strip.children) b.classList.toggle('on', b.dataset.face === rec.active);
}

const isFront = rec => rec.active === rec.faces[0].dataset.face;

// The front face's height, in layout px. Read only while the front is actually
// showing and the station is on screen — a hidden panel measures 0, and pinning
// a card to 0 would collapse it the moment the scoreboard tab was open.
function measureFront(rec) {
  if (!isFront(rec) || rec.panel.classList.contains('expanded')) return;
  rec.panel.style.height = '';
  const h = rec.panel.offsetHeight;
  if (h > 0) rec.frontH = h;
}

function settle(rec) {
  if (rec.want !== rec.active) {
    // Leaving the front: take its height with us, or there is nothing to hold
    // the next face to.
    measureFront(rec);
    rec.active = rec.want;
    paint(rec);
  }
  rec.panel.style.height =
    isFront(rec) || !rec.frontH || rec.panel.classList.contains('expanded')
      ? '' : rec.frontH + 'px';
}

let onFaceChange = () => {};

function choose(rec, faceId) {
  rec.want = faceId;
  remember(rec.key, faceId);
  settle(rec);
  // A face that has just come up may never have been drawn — the renderers run
  // on state and feed pushes, and with the feed off nothing is coming.
  onFaceChange(rec.panel.id, faceId);
}

// Build the tab strip for every [data-faces] panel under `root`. `scope`
// separates one car's remembered choices from another's on a PC that has run
// more than one station.
export function initFaces(root = document, { scope = '', onChange = null } = {}) {
  scopeKey = scope;
  if (onChange) onFaceChange = onChange;
  for (const panel of root.querySelectorAll('[data-faces]')) {
    const faces = [...panel.querySelectorAll(':scope > .face')];
    const head = panel.querySelector(':scope > h3');
    // One face is a card that was never converted — leave it exactly as it is
    // rather than hang a pointless single tab on it.
    if (faces.length < 2 || !head) continue;

    // The header becomes a flex row, which would otherwise break a title like
    // "Pace - <span>Driver 1</span>" into two independently-wrapping items.
    // Gather the title into one item first; leave any button (the tyre card's
    // warmers, for one) where it is, as its own item.
    const title = document.createElement('span');
    title.className = 'cardtitle';
    for (const node of [...head.childNodes]) {
      if (node.nodeType === 1 && node.tagName === 'BUTTON') continue;
      title.appendChild(node);
    }
    head.prepend(title);

    const strip = document.createElement('div');
    strip.className = 'facetabs';
    const rec = {
      panel, faces, strip,
      key: STORE_PREFIX + scope + ':' + panel.id,
      frontH: 0,
      active: faces[0].dataset.face,
      want: faces[0].dataset.face
    };
    for (const f of faces) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.face = f.dataset.face;
      b.textContent = f.dataset.faceLabel || f.dataset.face;
      if (f.dataset.faceTitle) b.title = f.dataset.faceTitle;
      b.addEventListener('click', () => choose(rec, f.dataset.face));
      strip.appendChild(b);
    }
    head.appendChild(strip);
    panel.classList.add('faced');
    cards.push(rec);
    paint(rec);
    // The card boots on its front face whatever was remembered: the front has
    // to be measured once before anything can be pinned to it. The remembered
    // face goes on at the first afterRender(), by which time there is a height.
    rec.want = remembered(rec.key) && faces.some(f => f.dataset.face === remembered(rec.key))
      ? remembered(rec.key) : rec.active;
  }
}

// Call once per full render pass, before the page re-fits: re-measures the
// front face (its content moves every second) and holds every other face to it.
export function facesAfterRender() {
  for (const rec of cards) {
    measureFront(rec);
    settle(rec);
  }
}

// Which face a card is showing — so a renderer can skip the work behind a face
// nobody is looking at.
export function activeFace(panelId) {
  const rec = cards.find(r => r.panel.id === panelId);
  return rec ? rec.active : null;
}

// ---- focus / expand -------------------------------------------------------
// Any panel marked data-expand gets a ⤢ in its header that throws it up over
// the grid at full size. It is the same panel — moved, not copied — so every
// renderer keeps updating it by id while it is up there. A placeholder of the
// same height stands in the column so the auto-fit sees no change and the page
// does not re-zoom behind the overlay.

let focusOverlay = null;
let focusBox = null;
let focused = null;
let closing = null; // pending finish while the overlay's out-fade plays

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// `instant` skips the out-fade. It must stay available: showView() hides the
// whole station right after closeFocus(), and a panel still floating in the
// overlay 150ms later would come home into a hidden grid mid-swap.
function collapse(instant = false) {
  // A close already fading out is flushed first, so a rapid re-expand never
  // finds the previous panel still sitting in the focus box.
  if (closing) { clearTimeout(closing.timer); const f = closing.finish; closing = null; f(); }
  if (!focused) return;
  const panel = focused;
  focused = null;
  const finish = () => {
    closing = null;
    panel.classList.remove('expanded');
    panel.__ph.replaceWith(panel);
    panel.__ph = null;
    focusOverlay.classList.remove('closing');
    focusOverlay.classList.add('hidden');
    facesAfterRender();
  };
  if (instant || reducedMotion()) return finish();
  focusOverlay.classList.add('closing');
  closing = { finish, timer: setTimeout(finish, 160) };
}

function expand(panel) {
  collapse(true);
  const ph = document.createElement('div');
  ph.className = 'focus-ph';
  ph.style.height = panel.offsetHeight + 'px';
  panel.after(ph);
  panel.__ph = ph;
  panel.style.height = '';
  panel.classList.add('expanded');
  focusBox.appendChild(panel);
  focusOverlay.classList.remove('hidden');
  focused = panel;
}

export function initExpand(root = document, { overlayId = 'focus-overlay', boxId = 'focus-box' } = {}) {
  focusOverlay = document.getElementById(overlayId);
  focusBox = document.getElementById(boxId);
  if (!focusOverlay || !focusBox) return;

  focusOverlay.addEventListener('click', e => { if (e.target === focusOverlay) collapse(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && focused) collapse(); });

  for (const panel of root.querySelectorAll('[data-expand]')) {
    const head = panel.querySelector(':scope > h3');
    if (!head) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'facezoom';
    b.title = 'Show this card full size';
    b.textContent = '⤢';
    b.addEventListener('click', () => (focused === panel ? collapse() : expand(panel)));
    head.appendChild(b);
    panel.classList.add('expandable');
  }
}

// The expanded card has to come home before the station is hidden behind
// another view, or it is left floating over the scoreboard — so no out-fade
// here: the caller hides the whole view in the same breath.
export function closeFocus() { collapse(true); }

export { scopeKey as facesScope };
