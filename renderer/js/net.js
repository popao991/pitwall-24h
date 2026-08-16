// Tiny WebSocket client with auto-reconnect. The server broadcasts the full
// state after every change; messages sent while offline are queued.

// A station's link can die without the socket ever closing — a WiFi drop or a
// sleeping access point leaves the browser reporting OPEN while every send
// disappears into a dead pipe. The page would keep showing CONNECTED and every
// setting typed into it would be quietly undone by the next broadcast that
// never came. The server heartbeats, so silence on the wire is the tell: after
// this long with nothing heard at all, the socket is treated as gone.
const STALE_MS = 12000;
const RETRY_MS = 1500;

export function connect({ url, onState, onStatus, onTiming, onMessage }) {
  let ws = null;
  let alive = false;
  let queue = [];
  let lastRxMs = 0;
  let retryTimer = null;

  // Give up on the current socket and line up a fresh one. Both the browser's
  // own close/error and the silence watchdog come through here, so a socket is
  // only ever abandoned once: its handlers are detached first, and a late event
  // from the dead socket can no longer reconnect us a second time.
  function fail() {
    const dead = ws;
    ws = null;
    if (dead) {
      dead.onopen = dead.onclose = dead.onerror = dead.onmessage = null;
      try { dead.close(); } catch { /* already gone */ }
    }
    if (alive) onStatus?.(false);
    alive = false;
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; open(); }, RETRY_MS);
    }
  }

  function open() {
    ws = new WebSocket(url);
    lastRxMs = Date.now();
    ws.onopen = () => {
      alive = true;
      lastRxMs = Date.now();
      onStatus?.(true);
      for (const m of queue) ws.send(m);
      queue = [];
    };
    ws.onclose = () => fail();
    ws.onerror = () => fail();
    ws.onmessage = ev => {
      lastRxMs = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      // The heartbeat carries nothing: having arrived at all is the message.
      if (m.type === 'ping') return;
      if (m.type === 'state') onState(m.state);
      else if (m.type === 'timing') onTiming?.(m.timing);
      else onMessage?.(m);
    };
  }
  open();

  // Watchdog: nothing heard for STALE_MS means the link is gone whatever the
  // socket claims. Covers a connect that never completes as well as one that
  // dies mid-race — in both cases sends start queueing and the page says so.
  setInterval(() => {
    if (!ws || Date.now() - lastRxMs < STALE_MS) return;
    if (ws.readyState === 0 || ws.readyState === 1) fail();
  }, 2000);

  return {
    send(obj) {
      const s = JSON.stringify(obj);
      if (alive && ws && ws.readyState === 1) ws.send(s);
      else queue.push(s);
    }
  };
}
