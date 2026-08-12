// Tiny WebSocket client with auto-reconnect. The server broadcasts the full
// state after every change; messages sent while offline are queued.

export function connect({ url, onState, onStatus, onTiming, onMessage }) {
  let ws = null;
  let alive = false;
  let queue = [];

  function open() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      alive = true;
      onStatus?.(true);
      for (const m of queue) ws.send(m);
      queue = [];
    };
    ws.onclose = () => {
      if (alive) onStatus?.(false);
      alive = false;
      setTimeout(open, 1500);
    };
    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'state') onState(m.state);
      else if (m.type === 'timing') onTiming?.(m.timing);
      else onMessage?.(m);
    };
  }
  open();

  return {
    send(obj) {
      const s = JSON.stringify(obj);
      if (alive && ws.readyState === 1) ws.send(s);
      else queue.push(s);
    }
  };
}
