// Live timing for the pit wall PC. One upstream connection is made from the
// embedded server (never from the stations) and the decoded standings are
// rebroadcast to every station over the normal hub socket.
//
// Three upstream providers, all speaking to the same TimingEngine:
//   GrrRelay        getraceresults.com scoreboard — SignalR-ish WebSocket, the
//                   page URL is resolved to a timekeeper id first
//   AlKamelRelay    livetiming.alkamelsystems.com — Meteor DDP over WebSocket,
//                   the feed name is the URL path
//   TeamStreamRelay Time Service "Team Stream" direct feed — raw TCP with a
//                   <key> handshake; plain (port 12921, \r\n-terminated) or
//                   SSL/TLS (port 12922, length-prefixed + optional gzip)
//
// Ported from the pitmanager Python relays (livetiming*.py) and its browser
// decoders (livetiming.js / livetiming-alkamel.js), collapsed into one
// provider-agnostic model: a cell grid + column map per car row, from which
// unified entries {nr, pos, driver, lastUs, ...} and lap / pit events fall out.

import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── LZString (UTF16 variant) ─────────────────────────────────────────────────
// Vendored from lz-string 1.4.4 (MIT, © pieroxy) so the app stays free of
// runtime dependencies beyond `ws`. The getraceresults bootstrap frame is
// compressToUTF16 output with the +32 character offset.

function _lzCompress(uncompressed, bitsPerChar, getCharFromInt) {
  if (uncompressed == null) return '';
  let i, value;
  const context_dictionary = {};
  const context_dictionaryToCreate = {};
  let context_c = '';
  let context_wc = '';
  let context_w = '';
  let context_enlargeIn = 2;
  let context_dictSize = 3;
  let context_numBits = 2;
  const context_data = [];
  let context_data_val = 0;
  let context_data_position = 0;

  for (let ii = 0; ii < uncompressed.length; ii += 1) {
    context_c = uncompressed.charAt(ii);
    if (!Object.prototype.hasOwnProperty.call(context_dictionary, context_c)) {
      context_dictionary[context_c] = context_dictSize++;
      context_dictionaryToCreate[context_c] = true;
    }
    context_wc = context_w + context_c;
    if (Object.prototype.hasOwnProperty.call(context_dictionary, context_wc)) {
      context_w = context_wc;
    } else {
      if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
        if (context_w.charCodeAt(0) < 256) {
          for (i = 0; i < context_numBits; i++) {
            context_data_val = context_data_val << 1;
            if (context_data_position == bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else context_data_position++;
          }
          value = context_w.charCodeAt(0);
          for (i = 0; i < 8; i++) {
            context_data_val = (context_data_val << 1) | (value & 1);
            if (context_data_position == bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else context_data_position++;
            value = value >> 1;
          }
        } else {
          value = 1;
          for (i = 0; i < context_numBits; i++) {
            context_data_val = (context_data_val << 1) | value;
            if (context_data_position == bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else context_data_position++;
            value = 0;
          }
          value = context_w.charCodeAt(0);
          for (i = 0; i < 16; i++) {
            context_data_val = (context_data_val << 1) | (value & 1);
            if (context_data_position == bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else context_data_position++;
            value = value >> 1;
          }
        }
        context_enlargeIn--;
        if (context_enlargeIn == 0) {
          context_enlargeIn = Math.pow(2, context_numBits);
          context_numBits++;
        }
        delete context_dictionaryToCreate[context_w];
      } else {
        value = context_dictionary[context_w];
        for (i = 0; i < context_numBits; i++) {
          context_data_val = (context_data_val << 1) | (value & 1);
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else context_data_position++;
          value = value >> 1;
        }
      }
      context_enlargeIn--;
      if (context_enlargeIn == 0) {
        context_enlargeIn = Math.pow(2, context_numBits);
        context_numBits++;
      }
      context_dictionary[context_wc] = context_dictSize++;
      context_w = String(context_c);
    }
  }
  if (context_w !== '') {
    if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
      if (context_w.charCodeAt(0) < 256) {
        for (i = 0; i < context_numBits; i++) {
          context_data_val = context_data_val << 1;
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else context_data_position++;
        }
        value = context_w.charCodeAt(0);
        for (i = 0; i < 8; i++) {
          context_data_val = (context_data_val << 1) | (value & 1);
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else context_data_position++;
          value = value >> 1;
        }
      } else {
        value = 1;
        for (i = 0; i < context_numBits; i++) {
          context_data_val = (context_data_val << 1) | value;
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else context_data_position++;
          value = 0;
        }
        value = context_w.charCodeAt(0);
        for (i = 0; i < 16; i++) {
          context_data_val = (context_data_val << 1) | (value & 1);
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else context_data_position++;
          value = value >> 1;
        }
      }
      context_enlargeIn--;
      if (context_enlargeIn == 0) {
        context_enlargeIn = Math.pow(2, context_numBits);
        context_numBits++;
      }
      delete context_dictionaryToCreate[context_w];
    } else {
      value = context_dictionary[context_w];
      for (i = 0; i < context_numBits; i++) {
        context_data_val = (context_data_val << 1) | (value & 1);
        if (context_data_position == bitsPerChar - 1) {
          context_data_position = 0;
          context_data.push(getCharFromInt(context_data_val));
          context_data_val = 0;
        } else context_data_position++;
        value = value >> 1;
      }
    }
    context_enlargeIn--;
    if (context_enlargeIn == 0) {
      context_enlargeIn = Math.pow(2, context_numBits);
      context_numBits++;
    }
  }
  // Mark the end of the stream
  value = 2;
  for (i = 0; i < context_numBits; i++) {
    context_data_val = (context_data_val << 1) | (value & 1);
    if (context_data_position == bitsPerChar - 1) {
      context_data_position = 0;
      context_data.push(getCharFromInt(context_data_val));
      context_data_val = 0;
    } else context_data_position++;
    value = value >> 1;
  }
  while (true) {
    context_data_val = context_data_val << 1;
    if (context_data_position == bitsPerChar - 1) {
      context_data.push(getCharFromInt(context_data_val));
      break;
    } else context_data_position++;
  }
  return context_data.join('');
}

function _lzDecompress(length, resetValue, getNextValue) {
  const dictionary = [];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let entry = '';
  const result = [];
  let w, c;
  let bits, resb, maxpower, power;
  const data = { val: getNextValue(0), position: resetValue, index: 1 };

  for (let i = 0; i < 3; i += 1) dictionary[i] = i;

  bits = 0;
  maxpower = Math.pow(2, 2);
  power = 1;
  while (power != maxpower) {
    resb = data.val & data.position;
    data.position >>= 1;
    if (data.position == 0) {
      data.position = resetValue;
      data.val = getNextValue(data.index++);
    }
    bits |= (resb > 0 ? 1 : 0) * power;
    power <<= 1;
  }

  switch (bits) {
    case 0:
      bits = 0;
      maxpower = Math.pow(2, 8);
      power = 1;
      while (power != maxpower) {
        resb = data.val & data.position;
        data.position >>= 1;
        if (data.position == 0) {
          data.position = resetValue;
          data.val = getNextValue(data.index++);
        }
        bits |= (resb > 0 ? 1 : 0) * power;
        power <<= 1;
      }
      c = String.fromCharCode(bits);
      break;
    case 1:
      bits = 0;
      maxpower = Math.pow(2, 16);
      power = 1;
      while (power != maxpower) {
        resb = data.val & data.position;
        data.position >>= 1;
        if (data.position == 0) {
          data.position = resetValue;
          data.val = getNextValue(data.index++);
        }
        bits |= (resb > 0 ? 1 : 0) * power;
        power <<= 1;
      }
      c = String.fromCharCode(bits);
      break;
    case 2:
      return '';
  }
  dictionary[3] = c;
  w = c;
  result.push(c);
  while (true) {
    if (data.index > length) return '';
    bits = 0;
    maxpower = Math.pow(2, numBits);
    power = 1;
    while (power != maxpower) {
      resb = data.val & data.position;
      data.position >>= 1;
      if (data.position == 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index++);
      }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }

    switch ((c = bits)) {
      case 0:
        bits = 0;
        maxpower = Math.pow(2, 8);
        power = 1;
        while (power != maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position == 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb > 0 ? 1 : 0) * power;
          power <<= 1;
        }
        dictionary[dictSize++] = String.fromCharCode(bits);
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        bits = 0;
        maxpower = Math.pow(2, 16);
        power = 1;
        while (power != maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position == 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb > 0 ? 1 : 0) * power;
          power <<= 1;
        }
        dictionary[dictSize++] = String.fromCharCode(bits);
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join('');
    }

    if (enlargeIn == 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }

    if (dictionary[c]) {
      entry = dictionary[c];
    } else {
      if (c === dictSize) entry = w + w.charAt(0);
      else return null;
    }
    result.push(entry);

    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;

    if (enlargeIn == 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }
}

export function compressToUTF16(input) {
  if (input == null) return '';
  return _lzCompress(input, 15, a => String.fromCharCode(a + 32)) + ' ';
}

export function decompressFromUTF16(compressed) {
  if (compressed == null || compressed === '') return null;
  return _lzDecompress(compressed.length, 16384, i => compressed.charCodeAt(i) - 32);
}

// ── getraceresults bootstrap ─────────────────────────────────────────────────

// The '_' frame carries the whole board state: "OK<µs>" plain server time, or
// an LZ-compressed JSON array of frames, optionally suffixed "::<hex index>".
export function decodeBootstrap(payload) {
  if (typeof payload !== 'string') return [];
  if (payload.length > 2 && payload.startsWith('OK')) {
    const t = parseInt(payload.slice(2), 10);
    return isNaN(t) ? [] : [['s_t', t]];
  }
  let compressed = payload;
  let extraIndex = 0;
  const sep = compressed.lastIndexOf('::');
  if (sep !== -1) {
    const idx = parseInt(compressed.slice(sep + 2), 16);
    if (!isNaN(idx)) {
      extraIndex = idx;
      compressed = compressed.slice(0, sep);
    }
  }
  const decompressed = decompressFromUTF16(compressed);
  if (!decompressed) throw new Error('LZ decompression failed');
  const arr = JSON.parse(decompressed);
  if (!Array.isArray(arr)) throw new Error('Bootstrap is not an array');
  if (extraIndex > 0) arr.unshift(['s_i', extraIndex]);
  return arr;
}

// ── time parsing ─────────────────────────────────────────────────────────────

// Everything in the engine is microseconds (getraceresults native unit).
// Accepts µs/ms/s numbers (disambiguated by magnitude — lap times live between
// 20 s and 1000 s, so the ranges cannot collide) and "h:m:s.f" style strings.
export function parseTimeToUs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return numToUs(v);
  const s = String(v).trim();
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length >= 2 && parts.length <= 3 && parts.every(p => /^\d+(?:[.,]\d+)?$/.test(p))) {
    const nums = parts.map(p => parseFloat(p.replace(',', '.')));
    const sec = parts.length === 3
      ? nums[0] * 3600 + nums[1] * 60 + nums[2]
      : nums[0] * 60 + nums[1];
    return sec > 0 ? Math.round(sec * 1e6) : null;
  }
  const f = parseFloat(s.replace(',', '.'));
  return isNaN(f) ? null : numToUs(f);
}

function numToUs(v) {
  if (v <= 0 || v > 9e18) return null;
  if (v < 1000) return Math.round(v * 1e6); // seconds
  if (v < 1e6) return Math.round(v * 1000); // milliseconds
  return Math.round(v); // microseconds
}

// ── minimal XML (TeamStream messages) ────────────────────────────────────────
// Machine-generated feed: elements, text, self-closing tags and attributes.
//
// Attributes used to be parsed past and discarded (matching the pitmanager
// relay's ElementTree use). They are kept now because the same record can be
// exported either way: the Timing Data Protocol (v1.34) documents fields like
// Heat.Status that we have never seen as a child element, and an export that
// writes them as `<session status="GREEN">` would have been invisible. Child
// elements still win on a name collision, so nothing that already decoded can
// change value.

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isNaN(code) ? m : String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? m;
  });
}

// key="value" | key='value' | key=bare, in a start tag's attribute section.
const ATTR_RE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(s) {
  if (!s || !s.includes('=')) return null;
  let attrs = null;
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s)) !== null) {
    (attrs ??= {})[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function parseXmlFragment(text) {
  const root = { tag: '#root', children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].text += text.slice(i);
      break;
    }
    if (lt > i) stack[stack.length - 1].text += text.slice(i, lt);
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      stack[stack.length - 1].text += text.slice(lt + 9, end === -1 ? n : end);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = text.indexOf('>', lt);
    if (gt === -1) break; // truncated tag — wait for more data upstream
    let inner = text.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!inner) continue;
    if (inner[0] === '/') {
      const tag = inner.slice(1).trim();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === tag) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    const selfClose = inner.endsWith('/');
    if (selfClose) inner = inner.slice(0, -1).trim();
    const sp = inner.search(/[\s]/);
    const tag = sp === -1 ? inner : inner.slice(0, sp);
    if (!tag) continue;
    const el = { tag, children: [], text: '', attrs: sp === -1 ? null : parseAttrs(inner.slice(sp + 1)) };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root.children;
}

// Repeating session children that must always be arrays even with one element.
const TS_ALWAYS_LIST = new Set(['loop', 'section', 'speedtrap', 'enrollment', 'teammember']);

export function xmlToObj(el) {
  if (!el.children.length) {
    const text = decodeEntities(el.text);
    // A leaf whose content is in its attributes (`<loop id="111" pos="0"/>`)
    // rather than in child elements. Text still wins where there is any, so
    // `<text lang="en">RED FLAG</text>` stays the plain string its consumers
    // expect — only the previously useless empty string becomes an object.
    if (el.attrs && !text.trim()) return { ...el.attrs };
    return text;
  }
  const out = el.attrs ? { ...el.attrs } : {};
  // Names still held by an attribute. The first child element of that name
  // replaces it outright instead of being appended to it — a child element is
  // always the more specific value, and pairing the two into an array would
  // change what every existing consumer reads.
  const fromAttrs = el.attrs ? new Set(Object.keys(el.attrs)) : null;
  for (const child of el.children) {
    const val = xmlToObj(child);
    if (TS_ALWAYS_LIST.has(child.tag)) {
      if (!Array.isArray(out[child.tag])) out[child.tag] = [];
      out[child.tag].push(val);
    } else if (fromAttrs?.delete(child.tag)) {
      out[child.tag] = val;
    } else if (child.tag in out) {
      if (!Array.isArray(out[child.tag])) out[child.tag] = [out[child.tag]];
      out[child.tag].push(val);
    } else {
      out[child.tag] = val;
    }
  }
  return out;
}

// ── URL resolution ───────────────────────────────────────────────────────────

// Live timing page URL → connection parameters. Al Kamel needs only the URL
// path; getraceresults pages embed the timekeeper id in the page source.
export async function resolveTimingUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'Invalid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http/https live timing URLs are supported.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (host.endsWith('alkamelsystems.com')) {
    const feedName = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(feedName)) {
      return { error: 'Could not find a feed name in the Al Kamel URL (expected e.g. https://livetiming.alkamelsystems.com/yourseries).' };
    }
    return { provider: 'alkamel', feedName, eventName: feedName };
  }

  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  let html;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: baseUrl + '/'
      }
    });
    if (!resp.ok) return { error: `Failed to fetch page: ${resp.status}` };
    html = await resp.text();
  } catch (e) {
    return { error: 'Could not reach the page: ' + e.message };
  }

  const tid = html.match(/"tid"\s*:\s*"([a-f0-9]{32})"/);
  const dm = html.match(/"dm"\s*:\s*"(\d+)"/);
  const name = html.match(/"n"\s*:\s*"([^"]+)"/);
  if (!tid) return { error: 'Could not find a timekeeper ID on that page — is it a getraceresults or Al Kamel live timing URL?' };
  return {
    provider: 'getraceresults',
    timekeeperId: tid[1],
    tkdm: dm ? dm[1] : null,
    baseUrl,
    eventName: name ? name[1] : null
  };
}

// ── getraceresults relay ─────────────────────────────────────────────────────

export class GrrRelay {
  constructor({ timekeeperId, tkdm = null, groups = 'w', baseUrl = 'https://livetiming.getraceresults.com' }, handlers = {}) {
    this.timekeeperId = timekeeperId;
    this.tkdm = tkdm;
    this.groups = groups;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.h = handlers;
    this.connectionToken = null;
    this.messageId = null;
    this.groupsToken = null;
    this.initialDataReceived = false;
    this.pendingBeforeInit = [];
    this.cookies = new Map();
    this.ws = null;
    this.running = false;
  }

  _baseParams() {
    const p = { clientProtocol: '1.5', _tk: this.timekeeperId, _gr: this.groups };
    if (this.tkdm != null) p._tkdm = String(this.tkdm);
    return p;
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _collectCookies(resp) {
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const kv = line.split(';')[0];
      const eq = kv.indexOf('=');
      if (eq > 0) this.cookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }

  _headers() {
    const h = {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: this.baseUrl + '/'
    };
    const c = this._cookieHeader();
    if (c) h.Cookie = c;
    return h;
  }

  async _negotiate() {
    const p = new URLSearchParams({ ...this._baseParams(), _: String(Date.now()) });
    const resp = await fetch(`${this.baseUrl}/lt/negotiate?${p}`, { headers: this._headers() });
    if (!resp.ok) throw new Error(`Negotiate failed: ${resp.status}`);
    this._collectCookies(resp);
    const data = await resp.json();
    this.connectionToken = data.ConnectionToken;
  }

  async _startRequest() {
    const p = new URLSearchParams({
      transport: 'webSockets',
      ...this._baseParams(),
      connectionToken: this.connectionToken
    });
    if (this.messageId) p.set('messageId', this.messageId);
    if (this.groupsToken) p.set('groupsToken', this.groupsToken);
    p.set('_', String(Date.now()));
    try {
      const resp = await fetch(`${this.baseUrl}/lt/start?${p}`, { headers: this._headers() });
      if (!resp.ok) this.h.onLog?.(`Start returned ${resp.status} (non-fatal)`);
      else await resp.text();
    } catch (e) {
      this.h.onLog?.('Start request failed (non-fatal): ' + e.message);
    }
  }

  _wsUrl() {
    const scheme = this.baseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const p = new URLSearchParams({
      transport: 'webSockets',
      ...this._baseParams(),
      connectionToken: this.connectionToken,
      tid: '1'
    });
    if (this.messageId) p.set('messageId', this.messageId);
    if (this.groupsToken) p.set('groupsToken', this.groupsToken);
    return `${scheme}/lt/connect?${p}`;
  }

  async start() {
    this.running = true;
    this.h.onStatus?.('connecting');
    await this._negotiate();
    if (!this.running) return;

    const headers = {
      'User-Agent': BROWSER_UA,
      Origin: this.baseUrl,
      'Accept-Language': 'en-US,en;q=0.9'
    };
    const c = this._cookieHeader();
    if (c) headers.Cookie = c;

    this.ws = new WebSocket(this._wsUrl(), { headers });
    this.ws.on('open', () => {
      if (!this.running) return;
      this.h.onStatus?.('connected');
      this._startRequest();
      this.ws.send(`_:${JSON.stringify(this.groups)}`); // subscribe groups
    });
    this.ws.on('message', data => this._handleMessage(String(data)));
    this.ws.on('error', e => this.h.onError?.(e.message));
    this.ws.on('close', () => {
      if (this.running) this.h.onStatus?.('disconnected');
      this.running = false;
    });
  }

  _handleMessage(raw) {
    let env;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    if (Array.isArray(env) && env.length === 2) {
      this._processFrame(env);
    } else if (env && typeof env === 'object') {
      if ('C' in env) this.messageId = env.C;
      if ('G' in env) this.groupsToken = env.G;
      for (const msg of env.M || []) {
        if (Array.isArray(msg) && msg.length === 2) this._processFrame(msg);
      }
    }
  }

  _processFrame(frame) {
    const [handle, payload] = frame;

    // The server announces a board/session change by telling clients to
    // reload. Reconnecting re-resolves the page (fresh tkdm) and pulls a
    // clean bootstrap — the service's retry path does all of that.
    if (handle === '$_Reload') {
      this.h.onLog?.('feed requested a reload (session change) — reconnecting');
      this.reload();
      return;
    }

    if (handle === '_') {
      try {
        const decoded = decodeBootstrap(payload);
        this.initialDataReceived = true;
        for (const df of decoded) this._processFrame(df);
        while (this.pendingBeforeInit.length) this._processFrame(this.pendingBeforeInit.shift());
      } catch (e) {
        this.h.onError?.('Bootstrap error: ' + e.message);
      }
      return;
    }
    // Queue non-server-time frames until the bootstrap has arrived, so cell
    // deltas never land on an empty grid.
    if (!this.initialDataReceived && handle !== '$_Reload' && !handle.startsWith('s')) {
      this.pendingBeforeInit.push(frame);
      return;
    }
    this.h.onFrame?.({ handle, payload, ts: Date.now() });
  }

  // Drop the resume tokens and close: the service's retry re-negotiates and
  // the server replays the whole board from scratch, headers included. This is
  // the same path the server's own $_Reload takes, and the only way back to a
  // known column layout when a screen changed without one.
  reload() {
    this.initialDataReceived = false;
    this.messageId = null;
    this.groupsToken = null;
    try {
      this.ws?.close();
    } catch {}
  }

  stop() {
    this.running = false;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}

// ── Al Kamel relay (Meteor DDP) ──────────────────────────────────────────────

const AK_HOST = 'livetiming.alkamelsystems.com';

// publication name → (collection name, frame handle)
const AK_DATA_SUBS = {
  standings: ['standings', 'ak_standings'],
  entry: ['session_entry', 'ak_entry'],
  sessionStatus: ['session_status', 'ak_status'],
  trackInfo: ['track_info', 'ak_track'],
  sessionClasses: ['session_classes', 'ak_classes'],
  raceControl: ['race_control', 'ak_rc']
};
const AK_COLL_TO_HANDLE = Object.fromEntries(Object.values(AK_DATA_SUBS));

function oidValue(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.$value || v._str || null;
  return null;
}

export class AlKamelRelay {
  constructor({ feedName, sessionId = null }, handlers = {}) {
    this.feedName = feedName;
    this.requestedSessionId = sessionId;
    this.h = handlers;
    this.sessionsMeta = {};
    this.sessionRefs = {};
    this.selectedSession = null;
    this.sessionInfoReady = false;
    this.ws = null;
    this.running = false;
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  _emit(handle, payload) {
    this.h.onFrame?.({ handle, payload, ts: Date.now() });
  }

  start() {
    this.running = true;
    this.h.onStatus?.('connecting');
    this.ws = new WebSocket(`wss://${AK_HOST}/websocket`, {
      headers: { 'User-Agent': BROWSER_UA, Origin: `https://${AK_HOST}` }
    });
    this.ws.on('open', () => {
      this._send({ msg: 'connect', version: '1', support: ['1', 'pre2', 'pre1'] });
    });
    this.ws.on('message', data => {
      let ddp;
      try {
        ddp = JSON.parse(String(data));
      } catch {
        return;
      }
      if (ddp && typeof ddp === 'object') this._handleDdp(ddp);
    });
    this.ws.on('error', e => this.h.onError?.(e.message));
    this.ws.on('close', () => {
      if (this.running) this.h.onStatus?.('disconnected');
      this.running = false;
    });
  }

  _pickSession() {
    if (this.requestedSessionId) return this.requestedSessionId;
    const metas = Object.values(this.sessionsMeta);
    if (!metas.length) return null;
    const open = metas.filter(m => !m.closed);
    const pool = open.length ? open : metas;
    return pool.reduce((a, b) => ((b.date || 0) > (a.date || 0) ? b : a)).id;
  }

  _sendSessionList() {
    const sessions = Object.values(this.sessionsMeta).sort((a, b) => (a.date || 0) - (b.date || 0));
    this._emit('ak_sessions', { sessions, selected: this.selectedSession });
  }

  selectSession(sessionId) {
    if (!sessionId || sessionId === this.selectedSession) return;
    if (this.selectedSession) {
      for (const pub of Object.keys(AK_DATA_SUBS)) this._send({ msg: 'unsub', id: `ak-${pub}` });
    }
    this.selectedSession = sessionId;
    this.requestedSessionId = sessionId;
    const ref = this.sessionRefs[sessionId] || { $type: 'oid', $value: sessionId };
    for (const pub of Object.keys(AK_DATA_SUBS)) {
      this._send({ msg: 'sub', id: `ak-${pub}`, name: pub, params: [ref] });
    }
    this._emit('ak_selected', { session: sessionId, meta: this.sessionsMeta[sessionId] || {} });
    this._sendSessionList();
  }

  _maybeAutoselect() {
    const best = this._pickSession();
    // Before the initial sessionInfo batch completes, only honor an explicit
    // request — otherwise the first doc to arrive wins regardless of date.
    if (!this.sessionInfoReady && best !== this.requestedSessionId) return;
    if (best) this.selectSession(best);
  }

  _handleDdp(msg) {
    const t = msg.msg;

    if (t === 'connected') {
      this.h.onStatus?.('connected');
      this._send({ msg: 'sub', id: 'ak-feed', name: 'livetimingFeed', params: [this.feedName] });
      return;
    }
    if (t === 'ping') {
      const pong = { msg: 'pong' };
      if ('id' in msg) pong.id = msg.id;
      this._send(pong);
      return;
    }
    if (t === 'ready') {
      if ((msg.subs || []).includes('ak-sessioninfo')) {
        this.sessionInfoReady = true;
        this._maybeAutoselect();
      }
      return;
    }
    if (t === 'nosub') {
      this.h.onError?.(`Feed '${this.feedName}' not found (subscription rejected).`);
      return;
    }
    if (t !== 'added' && t !== 'changed') return;

    const coll = msg.collection;
    const fields = msg.fields || {};

    if (coll === 'feeds') {
      this._emit('ak_feeds', {
        name: fields.name,
        running: fields.running,
        noSessionMsg: fields.noSessionMsg
      });
      const sessions = fields.sessions;
      if (Array.isArray(sessions) && sessions.length) {
        for (const s of sessions) {
          const sid = oidValue(s);
          if (sid) this.sessionRefs[sid] = s;
        }
        this._send({ msg: 'sub', id: 'ak-sessioninfo', name: 'sessionInfo', params: [sessions] });
      }
      return;
    }

    if (coll === 'session_info' || coll === 'sessionInfo') {
      const sid = oidValue(fields.session);
      const info = fields.info || {};
      if (sid) {
        this.sessionsMeta[sid] = {
          id: sid,
          name: info.name || '',
          champ: info.champName || '',
          closed: info.closed === true,
          date: info.date || 0
        };
        this.sessionRefs[sid] ??= fields.session;
        this._sendSessionList();
        this._maybeAutoselect();
      }
      return;
    }

    const handle = AK_COLL_TO_HANDLE[coll];
    if (handle) {
      // Only forward docs for the selected session (broad feeds publish more).
      const docSid = oidValue(fields.session);
      if (docSid && this.selectedSession && docSid !== this.selectedSession) return;
      this._emit(handle, fields);
    }
  }

  stop() {
    this.running = false;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}

// ── TeamStream relay (direct TCP / SSL) ──────────────────────────────────────
// Spec: "Team Stream service" v1.21, Time Service B.V. First client command is
// <key>…</key> (wrong key ⇒ "AUTH DENIED" + disconnect, right key ⇒ silence),
// then <all/> replays the session, passings and messages. Plain TCP messages
// end in \r\n; SSL messages carry a 4-byte little-endian length prefix and may
// be gzip-compressed (magic 0x1f 0x8b).

export const TS_PLAIN_PORT = 12921;
export const TS_SSL_PORT = 12922;

// Known Team Stream port pairs (plain, SSL). 12921/12922 is the spec default;
// getraceresults.com serves the same feed on 12961/12962 (verified live). When
// the entered port is a known one, it decides plain vs TLS — a TLS handshake
// against a plain port just hangs, which reads as "the key doesn't work".
const TS_PLAIN_PORTS = new Set([12921, 12961]);
const TS_SSL_PORTS = new Set([12922, 12962]);
export function tsPortImpliesSsl(port) {
  if (TS_PLAIN_PORTS.has(port)) return false;
  if (TS_SSL_PORTS.has(port)) return true;
  return null; // unknown port — trust the configured checkbox
}
const TS_STREAM_LIMIT = 32 * 1024 * 1024;
const TS_READ_TIMEOUT = 120e3; // server sends <time> every 30 s

export class TeamStreamRelay {
  constructor({ host, key, port = null, ssl = true, allowSelfSigned = false }, handlers = {}) {
    this.host = host;
    this.key = key;
    this.ssl = !!ssl;
    this.port = port || (this.ssl ? TS_SSL_PORT : TS_PLAIN_PORT);
    this.allowSelfSigned = !!allowSelfSigned;
    this.h = handlers;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.gotAnyMessage = false;
    this.running = false;
    this.readTimer = null;
  }

  start() {
    this.running = true;
    this.h.onStatus?.('connecting');

    const onConnect = () => {
      if (!this.running) return;
      this.sock.write(`<key>${this.key}</key>`);
      this.sock.write('<all/>');
      this._armReadTimeout();
    };

    try {
      this.sock = this.ssl
        ? tls.connect({ host: this.host, port: this.port, rejectUnauthorized: !this.allowSelfSigned }, onConnect)
        : net.connect({ host: this.host, port: this.port }, onConnect);
    } catch (e) {
      this.h.onError?.('TeamStream connect failed: ' + e.message);
      this.h.onStatus?.('disconnected');
      return;
    }

    this.sock.setTimeout(15e3, () => {
      if (!this.gotAnyMessage) {
        this.h.onError?.(`Could not reach ${this.host}:${this.port} (connect timeout).`);
        this.sock.destroy();
      }
    });

    this.sock.on('data', chunk => {
      this._armReadTimeout();
      this.buf = Buffer.concat([this.buf, chunk]);
      try {
        this._drainBuffer();
      } catch (e) {
        this.h.onError?.('TeamStream error: ' + e.message);
        this.sock.destroy();
      }
    });
    this.sock.on('error', e => {
      const cert = /certificate|CERT|self.signed/i.test(e.message);
      this.h.onError?.(
        'TeamStream ' + (cert
          ? 'TLS certificate rejected — enable "accept self-signed certificate" if the timekeeper uses one. (' + e.message + ')'
          : 'error: ' + e.message)
      );
    });
    this.sock.on('close', () => {
      clearTimeout(this.readTimer);
      if (this.running) {
        if (!this.gotAnyMessage) {
          this.h.onLog?.('TeamStream closed the connection — no active session, or the key was rejected.');
        }
        this.h.onStatus?.('disconnected');
      }
      this.running = false;
    });
  }

  _armReadTimeout() {
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      this.h.onLog?.(`No data from TeamStream for ${TS_READ_TIMEOUT / 1000}s — reconnecting.`);
      this.sock?.destroy();
    }, TS_READ_TIMEOUT);
  }

  _drainBuffer() {
    if (!this.ssl) {
      // plain: \r\n-terminated UTF-8 messages
      let idx;
      while ((idx = this.buf.indexOf('\r\n')) !== -1) {
        const text = this.buf.subarray(0, idx).toString('utf8');
        this.buf = this.buf.subarray(idx + 2);
        this._processMessage(text);
      }
      return;
    }
    // SSL: 4-byte little-endian length prefix, payload possibly gzipped
    while (this.buf.length >= 4) {
      const length = this.buf.readUInt32LE(0);
      if (length > TS_STREAM_LIMIT) throw new Error(`message too large: ${length} bytes`);
      if (this.buf.length < 4 + length) return;
      let body = this.buf.subarray(4, 4 + length);
      this.buf = this.buf.subarray(4 + length);
      if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
      this._processMessage(body.toString('utf8'));
    }
  }

  _processMessage(text) {
    text = text.trim();
    if (!text) return;
    // Raw tap before ANY interpretation: the element decoder silently drops
    // top-level bare text and anything unparseable, so consumers of onRaw see
    // the wire truth the replay files can't show.
    this.h.onRaw?.(text);
    if (!this.gotAnyMessage && text.includes('AUTH DENIED') && !text.includes('<')) {
      this.h.onError?.('AUTH DENIED — the TeamStream key was rejected.');
      this.running = false;
      this.sock?.destroy();
      return;
    }
    if (!this.gotAnyMessage) {
      this.gotAnyMessage = true;
      // Only now is the key implicitly accepted — 'connected' on the bare TCP
      // connect would reset the reconnect backoff on every auth failure.
      this.h.onStatus?.('connected');
    }
    const elements = parseXmlFragment(text);
    this._processElements(elements);
  }

  _processElements(elements) {
    // Passings are batched into one frame per upstream message — the reply to
    // <all/> can contain thousands.
    const passes = [];
    const mpasses = [];
    for (const el of elements) {
      if (el.tag === 'pass') passes.push(xmlToObj(el));
      else if (el.tag === 'mpass') mpasses.push(xmlToObj(el));
      else if (el.tag === 'file') this._processElements(el.children);
      else this.h.onFrame?.({ handle: 'ts_' + el.tag, payload: xmlToObj(el), ts: Date.now() });
    }
    if (passes.length) this.h.onFrame?.({ handle: 'ts_pass', payload: { passes }, ts: Date.now() });
    if (mpasses.length) this.h.onFrame?.({ handle: 'ts_mpass', payload: { passes: mpasses }, ts: Date.now() });
  }

  stop() {
    this.running = false;
    clearTimeout(this.readTimer);
    try {
      this.sock?.destroy();
    } catch {}
    this.sock = null;
  }
}

// ── TimingEngine — provider-agnostic scoreboard model ────────────────────────
// A cell grid (row → col → value) plus a column map, exactly like the
// getraceresults board. Al Kamel and TeamStream documents are written into the
// same grid under fixed synthetic layouts, so lap/pit detection and the
// snapshot builder are provider-independent.

// getraceresults vendor field ids (h.n) → canonical keys. Stable across events,
// unlike the display captions each organizer configures freely.
const GRR_FIELD_IDS = {
  position: 'pos', startnumber: 'nr', state: 'state',
  currentdriver: 'driver', teamname: 'team',
  nationality: 'nat', country: 'nat',
  car: 'car', class: 'cls', subclass: 'scls',
  position_in_class: 'pic', positioninclass: 'pic',
  hole: 'gap', diff: 'diff',
  lastroundtime: 'last', fastestroundtime: 'best',
  // "IN LAP" / "2nd TIME" / "2nd LAP" — the lap the best was set on and the
  // second-best time, published on qualifying boards (verified at Assen).
  fastestroundnumber: 'bestlap',
  '2ndfastestroundtime': 'best2', '2ndfastestroundnumber': 'best2lap',
  marker: 'marker',
  pitstops: 'pit',
  currentdriverstinttime: 'stint', pittime: 'lpit',
  sectionmarker: 'smarker', laps: 'laps', rounds: 'laps'
};

// Caption aliases for auto-detection (normalized: lowercase, punctuation→space)
const COL_NAMES = {
  pos: ['pos', 'position', 'p', 'place', 'rank'],
  nr: ['nr', 'no', 'num', 'car nr', 'car no', 'car #', 'car#', 'number', '#', 'start nr', 'startnumber'],
  state: ['state', 'eta', 'e t a', 'status', 'time to go'],
  driver: ['driver', 'drv', 'name', 'driver name', 'driver in car', 'current driver', 'pilot'],
  nat: ['nat', 'nationality', 'country', 'flag'],
  team: ['team', 'entrant', 'team name', 'competitor'],
  car: ['car', 'vehicle', 'make', 'model'],
  pic: ['pic', 'class pos', 'p c', 'pos in class', 'position in class'],
  cls: ['cls', 'class', 'cat', 'category', 'group'],
  scls: ['s cls', 'subclass', 'sub class', 's cat', 'sub cat'],
  pit: ['pit', 'pits', 'in pit', 'pit stops', 'pitstops', 'stops', '# pit', '# pits'],
  gap: ['gap', 'gap to leader', 'behind'],
  diff: ['diff', 'interval', 'int', 'gap to next'],
  last: ['last', 'last lap', 'laptime', 'lap time', 'last time', 'last lap time'],
  best: ['best', 'best lap', 'best time', 'fastest', 'fastest lap', 'best lap time', 'best laptime'],
  bestlap: ['in lap', 'best lap nr', 'best in lap', 'fl lap'],
  best2: ['2nd time', '2nd best', 'second time', 'second best', '2nd best time'],
  best2lap: ['2nd lap', 'second lap', '2nd in lap'],
  laps: ['laps', 'lap', 'rounds', 'tours'],
  stint: ['stint', 'stint time', 'time in car', 'driver stint'],
  lpit: ['l pit', 'lpit', 'last pit', 'pit time', 'time in pit'],
  smarker: ['s', 'section', 'section marker', 'sect marker']
};
const COL_ALIAS_MAP = new Map();
for (const [key, aliases] of Object.entries(COL_NAMES)) {
  for (const a of aliases) COL_ALIAS_MAP.set(a, key);
}

const GRR_COL_DEFAULT = {
  pos: 0, nr: 2, state: 3, driver: 4, nat: 5, team: 6, car: 8, pic: 9,
  cls: 10, scls: 11, pit: 12, gap: 13, diff: 14, last: 15, best: 16,
  s1: 20, s2: 21, s3: 22, s4: 23
};

// Fixed synthetic layouts for the non-grid providers.
const AK_COLMAP = {
  pos: 0, nr: 1, state: 2, driver: 3, team: 4, car: 5, cls: 6,
  pic: 7, pit: 8, last: 9, best: 10, s1: 11, s2: 12, s3: 13, s4: 14, laps: 15
};
const TS_COLMAP = {
  pos: 0, nr: 1, state: 2, driver: 3, nat: 4, team: 5, car: 6, cls: 7,
  scls: 8, pic: 9, pit: 10, gap: 11, diff: 12, last: 13, best: 14,
  bestlap: 15, best2: 16, best2lap: 17, s1: 18, s2: 19, s3: 20, s4: 21,
  laps: 22, stint: 23, lpit: 24, smarker: 25
};

// Al Kamel currentFlag → getraceresults heat flag enum (see TIMING_FLAGS in
// shared/model.js: 2 red, 3 SC, 4 code60, 5 finish, 6 green, 7 FCY).
const AK_FLAG_MAP = { GF: 6, YF: 7, FCY: 7, RF: 2, SC: 3, C60: 4, CODE60: 4, CHK: 5 };

// Heat data `Status` (Timing Data Protocol v1.34, DataID 5) → the same flag
// enum. The TeamStream <session> element serializes that Heat record, so a
// timekeeper who exports Status hands the direct socket the one thing it
// otherwise lacks: an EXPLICIT flag, no text parsing (see applyWatchFlag).
// Only these documented values are honoured — ACTIVE means "this is the
// current heat" and says nothing about the track, and anything unrecognised
// leaves the flag alone.
//
// Note the protocol has no SAFETY CAR state: an SC period is published as
// YELLOW, so the public board watch stays the finer-grained source and keeps
// outranking this (applyWatchFlag runs over the finished snapshot).
const TS_STATUS_FLAGS = {
  GREEN: 6, YELLOW: 7, RED: 2, CODE60: 4, FINISH: 5, COMPLETED: 5
};

// Heat data `HeatType`: Q=qualification, R=Race, RLY=Rally. The timekeeper's
// own answer to race-vs-qualifying, which beats guessing from the session
// name — a race called "Course 1", "Wedstrijd" or "Manche 2" defeats the
// keyword test that has to stand in for it.
const TS_HEAT_TYPE_RACE = { R: true, RLY: true, Q: false };

// A protocol Boolean: 1 or 0 on the wire, absent while still at its default.
// null = "the feed did not say", which is not the same as false.
function tsBool(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return null;
}

// Read a field by any of several lowercase names, case-insensitively: the
// protocol documents "Status"/"AllowFastest", the wire we captured is all
// lowercase, and the same value can arrive as an element or an attribute.
function tsGet(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of names) {
    const v = obj[n];
    if (v != null && typeof v !== 'object') return v;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v == null || typeof v === 'object') continue;
    const lk = k.toLowerCase();
    for (const n of names) if (lk === n) return v;
  }
  return undefined;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
}

function sectorKey(n) {
  const m = n.match(/^(?:s|sec|sect|sector|split)\s*([1-9])$/);
  return m && +m[1] <= 4 ? `s${m[1]}` : null;
}

function keyFromName(name) {
  const n = norm(name);
  if (!n) return null;
  return COL_ALIAS_MAP.get(n) || sectorKey(n);
}

// TeamStream field-name aliases inside <pass>/<enrollment> elements. The exact
// tag names vary per timekeeper config, so first key present wins.
const TS_FIELD_ALIASES = {
  nr: ['no', 'nr', 'startnumber', 'number', 'kart', 'car'],
  last: ['laptime', 'lap_time', 'roundtime', 'lt'],
  best: ['bestlaptime', 'besttime', 'fastestlap', 'best'],
  laps: ['lap', 'laps', 'lapcount', 'round', 'rounds'],
  pos: ['pos', 'position'],
  driver: ['driver', 'drivername', 'name'],
  team: ['team', 'teamname'],
  cls: ['class', 'cls', 'category']
};

function tsField(obj, key) {
  for (const alias of TS_FIELD_ALIASES[key]) {
    const v = obj[alias];
    if (v != null && v !== '' && typeof v !== 'object') return v;
  }
  return null;
}

// Everything we consume off <session> and its <loop> children. Whatever a real
// timekeeper sends beyond these is logged once (_tsNote) — the Timing Data
// Protocol defines plenty on the records these serialize (Heat Status and
// HeatType, the Loop booleans AllowFastest / IsCountAsLap / IsTankIn, Lap
// State) and this is how a live session tells us which of them actually
// arrive, instead of another capture-and-grep round afterwards.
const TS_SESSION_KNOWN = new Set([
  'event', 'group', 'name', 'sessionname', 'session', 'laps', 'start', 'end',
  'mode', 'type', 'heattype', 'sessiontype', 'status', 'state'
]);
const TS_LOOP_KNOWN = new Set([
  'id', 'name', 'pos', 'pit', 'func', 'allowfastest', 'allowfast'
]);

// TeamStream datetimes ("01.08.2026 10:30:00", local track time) → µs on the
// same 2000-epoch local clock the `ms` pass field uses. Computed with UTC
// arithmetic so the host machine's time zone can't skew it.
const TS_EPOCH_MS = Date.UTC(2000, 0, 1);
export function parseTsDateUs(s) {
  const m = String(s || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const ms = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) - TS_EPOCH_MS;
  return ms > 0 ? ms * 1000 : null;
}

// µs on the 2000-epoch local track clock → "HH:MM:SS" for log lines.
function fmtTsUs(us) {
  const d = new Date(TS_EPOCH_MS + us / 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// Race-control messages kept for the history view. A busy 24 h race produces
// a few hundred; the cap only guards against a pathological feed.
const RC_LOG_MAX = 200;

// How long to let a board publish cells under an unverified column layout
// before asking for a fresh bootstrap again. Long enough that a reconnect gets
// to finish (negotiate + bootstrap is a couple of seconds) and short enough
// that a screen change never costs a whole session of standings.
const COL_REFRESH_MS = 20e3;

export class TimingEngine {
  constructor({ onEvent, onLog } = {}) {
    this.onEvent = onEvent || (() => {});
    this.onLog = onLog || (() => {});
    this.reset();
  }

  reset() {
    this.provider = null;
    this.grid = {}; // row → {col → value}
    this.colMap = { ...GRR_COL_DEFAULT };
    this.colMapped = null; // Set of keys actually detected (null = defaults)
    // A detected layout belongs to ONE board. When the timekeeper switches
    // screens (a session change), it describes a board we are no longer
    // looking at and nothing may be read through it until a header frame
    // re-describes the new one — see _ci.
    this.colStale = false;
    this.colStaleAskedMs = 0;
    this.heat = {}; // n, f (flag enum), lt/r/h clock fields, _sampleMs
    this.serverTimeUs = null;
    this.serverTimeSampleMs = 0;
    this.rowByNr = new Map(); // synthetic layouts: car nr → stable row index
    this.akEntry = {}; // Al Kamel entry list cache (nr → meta)
    this.sessions = []; // Al Kamel session picker
    this.selectedSession = null;
    this.trkLoops = []; // tracker timing loops: [distMm, isPit, flag]
    this.trkCars = {}; // nr → {fromMm, toMm, seg, speedMmS, inPit, tsUs}

    // TeamStream scoreboard state. The feed is passing-level (one message per
    // timing-loop crossing), so positions in class, sector times, pit stops,
    // gaps and the E.T.A. state all have to be reconstructed here. Times on
    // the wire are µs since 2000-01-01 **local track time** (`ms` field × 1000
    // — verified identical to the getraceresults web clock at Assen).
    this.tsLoops = new Map(); // loopid → {name, posMm, pit, func}
    this.tsSectEnd = new Map(); // loopid → sector nr it completes (1-based)
    this.tsSectStart = new Map(); // loopid → sector nr it begins
    this.tsSfLoop = null; // start/finish loop id (func SFAL)
    this.tsSessStartUs = null; // effective session start/end on the 2000-epoch clock
    this.tsSessEndUs = null;
    this.tsSchedStartUs = null; // scheduled window straight from <session>
    this.tsSchedEndUs = null;
    this.tsGreenUs = null; // when the clock really started ("Green Flag" smsg)
    this.tsStartTrigUs = null; // race start trigger (field's lap-0 S/F crossing)
    this.tsFinishInferred = false; // heat.f=5 came from the clock, not race control
    this.tsStatusFlag = null; // flag from an explicit <session> Status, if exported
    this.tsNoted = new Set(); // feed fields already reported by _tsNote
    this.tsGroup = null; // raw <session> group/name — matches flag smsg branding
    this.tsName = null;
    this.tsRace = false; // race (gaps on track) vs qualifying (gaps on best)
    this.tsCars = new Map(); // nr → per-car reconstruction state
    this.tsPassIndex = new Map(); // enr id → {nr, lap} for <mpass> corrections
    this.tsRc = null; // latest active race-control message {text, endUs}
    this.tsPendingMsgs = []; // smsg queued until the clock can date them
    this.rcLog = []; // race-control message history, oldest first: {ms, text}
    this.rcSeen = new Set(); // dedupes <all/> replays and re-sent documents
  }

  // One race-control message into the history log. `ms` is this PC's wall
  // clock (what every screen displays); `key` identifies the message across
  // reconnects — TeamStream replays the whole session history on every
  // <all/>, and Al Kamel re-sends the full document on each change, so
  // without the key the log would fill with duplicates.
  _rcAdd(text, ms, key) {
    const k = key || text;
    if (this.rcSeen.has(k)) return;
    this.rcSeen.add(k);
    this.rcLog.push({ ms: Math.round(ms), text });
    // History can arrive out of order (live message first, then the replay
    // of older ones) — keep the log in time order for display.
    this.rcLog.sort((a, b) => a.ms - b.ms);
    if (this.rcLog.length > RC_LOG_MAX) this.rcLog.splice(0, this.rcLog.length - RC_LOG_MAX);
  }

  // Column index for a canonical key. Once a board's real layout is known
  // (`colMapped`), the keys it does *not* publish have no column at all —
  // falling back to the default index would read whatever unrelated field
  // happens to sit there. A board without a class-position column would show
  // column 9's unset-best sentinel (9223372036854775807) under PIC, its LAPS
  // column under TEAM, and its section marker under INT.
  //
  // A layout that outlived its board is worse than no layout at all: the new
  // screen's cells get read through the old screen's column numbers, and every
  // value lands one field over — the state token under TEAM, the best time
  // under S1, class position under LAPS. Blank beats wrong on a pit wall, so
  // nothing resolves until a header frame describes the board we are on.
  _ci(key) {
    if (this.colStale) return undefined;
    if (this.colMapped) return this.colMapped.has(key) ? this.colMap[key] : undefined;
    return this.colMap[key] ?? GRR_COL_DEFAULT[key];
  }

  _rowFor(nr) {
    const key = String(nr).trim();
    if (!this.rowByNr.has(key)) this.rowByNr.set(key, this.rowByNr.size);
    return this.rowByNr.get(key);
  }

  _nrOfRow(row) {
    return String(this.grid[row]?.[this._ci('nr')] ?? '').trim();
  }

  // Write one cell; when the value changed, push [row, colKey, val, prev].
  _setCell(row, colKey, val, changes) {
    if (val === undefined || val === null) return;
    const col = this._ci(colKey);
    if (col === undefined) return;
    this.grid[row] ??= {};
    const prev = this.grid[row][col];
    if (String(prev) === String(val)) return;
    this.grid[row][col] = val;
    changes.push([row, colKey, val, prev]);
  }

  // ── event detection ────────────────────────────────────────────────────────
  // A changed LAST cell with a previous value = a completed lap; a STATE cell
  // toggling the "In Pit" convention = pit entry/exit. `silent` suppresses
  // events for baseline loads (bootstrap init, TeamStream <all/> history).

  _processChanges(changes, { silent = false } = {}) {
    if (silent) return;
    for (const [row, colKey, val, prev] of changes) {
      if (prev === undefined) continue; // first sighting is baseline, not a change
      const nr = this._nrOfRow(row);
      if (!nr) continue;

      if (colKey === 'last') {
        const lapUs = parseTimeToUs(val);
        if (lapUs) this.onEvent({ type: 'lap', nr, lapUs, lapSec: lapUs / 1e6 });
      } else if (colKey === 'state') {
        const wasPit = isInPitState(prev);
        const nowPit = isInPitState(val);
        if (!wasPit && nowPit) this.onEvent({ type: 'pitIn', nr });
        else if (wasPit && !nowPit) this.onEvent({ type: 'pitOut', nr });
      }
    }
  }

  // ── frame dispatch ─────────────────────────────────────────────────────────

  applyFrame(frame) {
    const { handle, payload, ts } = frame;
    try {
      if (handle.startsWith('ak_')) return this._akFrame(handle, payload, ts);
      if (handle.startsWith('ts_')) return this._tsFrame(handle, payload);
      if (handle === 'r_i') return this._grrInit(payload);
      if (handle === 'r_c') return this._grrCells(payload);
      if (handle === 'h_i' || handle === 'h_h') return this._grrHeat(payload);
      if (handle === 't_i' || handle === 't_p') return this._grrTracker(handle, payload);
      // s_i is the reconnect message index from the "::<hex>" bootstrap
      // suffix, not a clock — only s_t carries server time (µs).
      if (handle === 's_t') {
        const t = typeof payload === 'number' ? payload : parseInt(payload, 10);
        if (!isNaN(t) && t > 0) {
          this.serverTimeUs = t;
          this.serverTimeSampleMs = Date.now();
          // The bootstrap's heat frame can decode before its s_t frame: a heat
          // sampled just before this server-time tick belongs to the same
          // board snapshot, so anchor it to the server clock retroactively.
          if (this.heat._sampleServerUs == null && this.heat.r != null &&
              this.heat._sampleMs && Date.now() - this.heat._sampleMs < 10e3) {
            this.heat._sampleServerUs = t;
          }
        }
      }
    } catch (e) {
      this.onLog(`frame ${handle} error: ${e.message}`);
    }
  }

  // ── getraceresults ─────────────────────────────────────────────────────────

  _grrInit(payload) {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!data) return;
    // r_i is a complete board snapshot — start from a clean grid so rows of a
    // previous session (a bigger field, other cars) can't survive underneath.
    this.grid = {};
    this.rowByNr = new Map();
    if (data.l?.h) this._buildColMap(data.l.h);
    else if (this.colStale) {
      this.onLog('board snapshot carried no column headers — standings stay held until the layout is known');
    }

    for (const d of [data.l?.d, data.d, data.l?.r, data.r]) {
      if (d && this._parseInitData(d)) break;
    }
    // Columnar format: values stored per header entry h[col].d = [row values]
    if (Array.isArray(data.l?.h)) {
      for (let col = 0; col < data.l.h.length; col++) {
        const hdr = data.l.h[col];
        if (Array.isArray(hdr?.d)) {
          for (let row = 0; row < hdr.d.length; row++) {
            this.grid[row] ??= {};
            this.grid[row][col] = hdr.d[row];
          }
        }
      }
    }
    this.onLog(`board loaded: ${Object.keys(this.grid).length} entries`);
  }

  _parseInitData(d) {
    if (Array.isArray(d)) {
      if (!d.length) return false;
      if (Array.isArray(d[0]) && d[0].length >= 3 && typeof d[0][0] === 'number') {
        for (const cell of d) {
          if (!Array.isArray(cell) || cell.length < 3) continue;
          const [r, c, v] = cell;
          this.grid[r] ??= {};
          this.grid[r][c] = v;
        }
        return true;
      }
      if (Array.isArray(d[0])) {
        d.forEach((row, ri) => {
          if (!Array.isArray(row)) return;
          this.grid[ri] ??= {};
          row.forEach((val, ci) => (this.grid[ri][ci] = val));
        });
        return true;
      }
      if (typeof d[0] === 'object') {
        d.forEach((rowObj, ri) => {
          this.grid[ri] ??= {};
          for (const [col, val] of Object.entries(rowObj)) this.grid[ri][parseInt(col, 10)] = val;
        });
        return true;
      }
      return false;
    }
    if (d && typeof d === 'object') {
      for (const [ri, rowData] of Object.entries(d)) {
        const row = parseInt(ri, 10);
        this.grid[row] ??= {};
        if (Array.isArray(rowData)) rowData.forEach((val, ci) => (this.grid[row][ci] = val));
        else if (rowData && typeof rowData === 'object') {
          for (const [col, val] of Object.entries(rowData)) this.grid[row][parseInt(col, 10)] = val;
        }
      }
      return true;
    }
    return false;
  }

  _buildColMap(headers) {
    const newMap = {};
    const claim = (key, idx) => {
      if (key && !(key in newMap)) newMap[key] = idx;
    };
    // Endurance layouts carry a CurrentDriver column; then 'name' = team.
    const hasCurrentDriver = headers.some(h => h && norm(h.n) === 'currentdriver');

    // Pass 1: vendor field ids — deterministic schema regardless of captions
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (!h || !h.n) continue;
      const nid = norm(h.n).replace(/\s+/g, '');
      if (nid === 'sectortimes') {
        const p = parseInt(h.p, 10);
        if (p >= 1 && p <= 4) claim(`s${p}`, i);
        continue;
      }
      if (nid === 'name') {
        claim(hasCurrentDriver ? 'team' : 'driver', i);
        continue;
      }
      claim(GRR_FIELD_IDS[nid], i);
    }
    // Pass 2: display captions fill anything the id pass didn't cover
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (!h || Object.values(newMap).includes(i)) continue;
      claim(keyFromName(h.c || h.caption || h.label || h.title || h.name || ''), i);
    }

    // Whatever comes out of this pass describes the board in front of us now.
    this.colStale = false;
    if (Object.keys(newMap).length >= 3) {
      this.colMap = { ...GRR_COL_DEFAULT, ...newMap };
      this.colMapped = new Set(Object.keys(newMap));
      this.onLog('columns detected: ' + Object.keys(newMap).map(k => `${k}:${newMap[k]}`).join(', '));
    } else {
      // Really fall back — a layout detected for a *previous* session must not
      // outlive it and get applied to this board's cells.
      this.colMap = { ...GRR_COL_DEFAULT };
      this.colMapped = null;
      this.onLog(`column auto-detect matched only ${Object.keys(newMap).length} columns — using defaults`);
    }
  }

  _grrCells(payload) {
    if (!Array.isArray(payload)) return;
    // Cells keep landing in the grid by raw column number while the layout is
    // unverified — they cost nothing and the next init reloads the board
    // anyway — but a board that is demonstrably live under a layout we cannot
    // read needs a fresh bootstrap, not a wait. Ask for one; the reconnect
    // re-negotiates and replays the whole board with its headers.
    if (this.colStale && Date.now() - this.colStaleAskedMs > COL_REFRESH_MS) {
      this.colStaleAskedMs = Date.now();
      this.onLog('board is publishing cells but its column layout is unverified — asking for a fresh bootstrap');
      this.onEvent({ type: 'refresh', reason: 'column layout unverified' });
    }
    // Only columns the board actually described get a key. A default index for
    // a column this board does not publish points at an unrelated field, and
    // attributing its changes would fire laps and pit stops that never
    // happened.
    const colToKey = {};
    for (const key of Object.keys(this.colMap)) {
      const col = this._ci(key);
      if (col !== undefined) colToKey[col] = key;
    }
    const changes = [];
    for (const cell of payload) {
      if (!Array.isArray(cell) || cell.length < 3) continue;
      const [r, c, v] = cell;
      if (r < 0 || c < 0) continue;
      this.grid[r] ??= {};
      const prev = this.grid[r][c];
      if (String(prev) === String(v)) continue;
      this.grid[r][c] = v;
      const key = colToKey[c];
      if (key) changes.push([r, key, v, prev]);
    }
    this._processChanges(changes);
  }

  _grrHeat(payload) {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!data || typeof data !== 'object') return;
    const prevName = this.heat.n;
    if (data.r !== undefined) {
      this.heat._sampleMs = Date.now();
      // `q` is the server timestamp at which `r` (elapsed) was sampled — the
      // feed publishes r ~10-20 s behind its own clock (q consistently lags
      // s_t), so elapsed must be computed as r + (serverNow − q). Anchoring to
      // receive time instead bakes that lag into the countdown permanently.
      const q = typeof data.q === 'number' ? data.q : parseInt(data.q, 10);
      this.heat._sampleServerUs = isFinite(q) && q > 0 ? q : this._serverNowUs();
    }
    Object.assign(this.heat, data);
    if (data.n && prevName && data.n !== prevName) {
      this.onLog(`session changed: "${prevName}" → "${data.n}"`);
      // A new session means a new board — never leave the previous session's
      // standings underneath the incoming one. The next init/deltas repopulate.
      this.grid = {};
      this.rowByNr = new Map();
      // …and never leave its COLUMNS underneath either. A timekeeper who
      // changes screens between sessions (a qualifying board, a screen check)
      // publishes a different set of columns in a different order, and the
      // deltas that follow carry no headers. Reading them through the old
      // screen's map is how the scoreboard ends up with the E.T.A. token in
      // the team column. Hold everything until a header frame arrives.
      this.colStale = true;
      this.onEvent({ type: 'session', name: data.n, prevName });
    }
  }

  // ── getraceresults tracker (dead-reckoning positions) ──────────────────────
  // t_i init: { l: [[distMm, isPit, flag], …] timing loops, d: [car rows] }.
  // t_p update: [car rows]. A car row is
  //   [idx, nr, fromMm, toMm, segment, speedMmPerS, inPit, tsµs]
  // — the car crossed the loop at fromMm at server time ts, travelling at
  // speed toward the next loop at toMm. Positions between crossings are
  // extrapolated (pos = from + speed·Δt, clamped at to) by the display.

  _grrTracker(handle, payload) {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!data) return;
    let rows = data;
    if (handle === 't_i') {
      if (Array.isArray(data.l)) {
        this.trkLoops = data.l
          .filter(l => Array.isArray(l) && l.length >= 2)
          .map(l => [parseInt(l[0], 10) || 0, !!l[1], parseInt(l[2], 10) || 0]);
      }
      rows = data.d;
    }
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 8) continue;
      const nr = String(row[1]).trim();
      if (!nr) continue;
      this.trkCars[nr] = {
        fromMm: parseInt(row[2], 10) || 0,
        toMm: parseInt(row[3], 10) || 0,
        seg: parseInt(row[4], 10) || 0,
        speedMmS: Number(row[5]) || 0,
        inPit: !!row[6],
        tsUs: parseInt(row[7], 10) || 0
      };
    }
  }

  // ── Al Kamel (units are ms → converted to µs on write) ─────────────────────

  _akFrame(handle, payload, ts) {
    this.provider = 'alkamel';
    if (this.colMap !== AK_COLMAP) {
      this.colMap = AK_COLMAP;
      this.colMapped = new Set(Object.keys(AK_COLMAP));
    }
    // A fixed synthetic layout is never stale: it describes the writer,
    // not a board that can change shape underneath us.
    this.colStale = false;
    if (ts) {
      this.serverTimeUs = ts * 1000;
      this.serverTimeSampleMs = Date.now();
    }

    if (handle === 'ak_standings') return this._akStandings(payload);
    if (handle === 'ak_entry') return this._akEntryDoc(payload);
    if (handle === 'ak_status') return this._akStatus(payload, ts);
    if (handle === 'ak_rc') return this._akRc(payload);
    if (handle === 'ak_sessions') {
      this.sessions = payload?.sessions || [];
      this.selectedSession = payload?.selected || null;
      return;
    }
    if (handle === 'ak_selected') {
      const sid = payload?.session;
      if (sid && this.selectedSession && this.selectedSession !== sid) {
        // session switch: the standings that follow belong to a fresh session
        this.grid = {};
        this.rowByNr = new Map();
        this.heat = { n: this.heat.n };
      }
      this.selectedSession = sid || this.selectedSession;
      const meta = payload?.meta || {};
      if (meta.name) this.heat.n = meta.champ ? `${meta.champ} — ${meta.name}` : meta.name;
      return;
    }
    if (handle === 'ak_feeds' && payload?.running === false) {
      this.onLog(`feed "${payload.name || ''}" is not currently running`);
    }
  }

  // Al Kamel race_control documents. The exact field layout varies per series
  // configuration, so the extractor is deliberately shape-tolerant: any string
  // under a text-ish key is a message, any epoch-ish number next to it is its
  // time (falling back to receipt time). `changed` docs re-send the whole
  // message list — _rcAdd's key dedupes them.
  _akRc(payload) {
    const visit = v => {
      if (!v) return;
      if (typeof v === 'string') {
        const t = v.trim();
        if (t) this._rcAdd(t, Date.now(), t);
        return;
      }
      if (Array.isArray(v)) {
        for (const x of v) visit(x);
        return;
      }
      if (typeof v !== 'object') return;
      const text = [v.text, v.message, v.msg, v.description]
        .find(x => typeof x === 'string' && x.trim());
      if (text) {
        const raw = [v.timestamp, v.time, v.date, v.ms].find(x => typeof x === 'number' && x > 0);
        const ms = raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : null; // epoch ms vs s
        this._rcAdd(text.trim(), ms ?? Date.now(), `${raw ?? ''}|${v.id ?? ''}|${text.trim()}`);
        return;
      }
      for (const k of ['messages', 'log', 'entries', 'raceControl', 'list']) {
        if (v[k]) visit(v[k]);
      }
    };
    visit(payload);
  }

  // row.data: "pos;carNum;status;classPos;lapNum;pitCount;speed;lapStartEpochMs;trackState;totalLaps;"
  _akStandings(payload) {
    const rows = payload?.standings?.standings;
    if (!rows || typeof rows !== 'object') return;
    const changes = [];
    for (const row of Object.values(rows)) {
      if (!row || typeof row !== 'object' || typeof row.data !== 'string') continue;
      const p = row.data.split(';');
      if (!p[1]) continue;
      const d = {
        pos: parseInt(p[0], 10) || 0,
        carNr: p[1],
        status: p[2] || '',
        classPos: parseInt(p[3], 10) || 0,
        pitCount: parseInt(p[5], 10) || 0,
        lapStartMs: parseInt(p[7], 10) || 0,
        trackState: p[8] || '',
        totalLaps: parseInt(p[9], 10) || 0
      };
      const r = this._rowFor(d.carNr);
      const entry = this.akEntry[String(d.carNr).trim()];

      this._setCell(r, 'nr', d.carNr, changes);
      this._setCell(r, 'pos', d.pos, changes);
      this._setCell(r, 'state', akStateVal(d, row), changes);
      this._setCell(r, 'pic', d.classPos || '', changes);
      this._setCell(r, 'pit', d.pitCount, changes);
      if (d.totalLaps) this._setCell(r, 'laps', d.totalLaps, changes);

      const driver = row.driverName || row.driver || row.currentDriver || entry?.name;
      if (driver) this._setCell(r, 'driver', driver, changes);
      const team = row.team || row.teamName || entry?.team;
      if (team) this._setCell(r, 'team', team, changes);
      if (entry?.vehicle) this._setCell(r, 'car', entry.vehicle, changes);
      const cls = row.class || row.carClass || entry?.class;
      if (cls) this._setCell(r, 'cls', cls, changes);

      if (row.lastLapTime > 0) this._setCell(r, 'last', row.lastLapTime * 1000, changes);
      if (row.bestLapTime > 0) this._setCell(r, 'best', row.bestLapTime * 1000, changes);

      // currentSectors: groups of 6 — "sectorNr;ms;isSectorBest;isPB;isOB;isSet;"
      if (typeof row.currentSectors === 'string' && row.currentSectors.trim()) {
        const sp = row.currentSectors.split(';');
        for (let i = 0; i + 5 < sp.length; i += 6) {
          const snr = parseInt(sp[i], 10);
          const ms = parseInt(sp[i + 1], 10);
          if (snr >= 1 && snr <= 4 && sp[i + 5] === 'true' && ms > 0) {
            this._setCell(r, `s${snr}`, ms * 1000, changes);
          }
        }
      }
    }
    this._processChanges(changes);
  }

  _akEntryDoc(payload) {
    const entry = payload?.entry;
    if (!entry || typeof entry !== 'object') return;
    const changes = [];
    for (const [carNr, e] of Object.entries(entry)) {
      if (!e || typeof e !== 'object') continue;
      this.akEntry[String(carNr).trim()] = e;
      const r = this._rowFor(carNr);
      this._setCell(r, 'nr', carNr, changes);
      if (e.name) this._setCell(r, 'driver', e.name, changes);
      if (e.team) this._setCell(r, 'team', e.team, changes);
      if (e.vehicle) this._setCell(r, 'car', e.vehicle, changes);
      if (e.class) this._setCell(r, 'cls', e.class, changes);
    }
    this._processChanges(changes, { silent: true }); // entry list is metadata
  }

  _akStatus(payload, frameTs) {
    const s = payload?.status;
    if (!s || typeof s !== 'object') return;
    const flag = AK_FLAG_MAP[String(s.currentFlag || '').toUpperCase()];
    if (flag !== undefined) this.heat.f = flag;
    else if (s.isFinished) this.heat.f = 5;

    const frozen = s.isSessionRunning === false || (s.stopTime || 0) > 0;
    if (s.finalTime > 0 && s.finalType !== 'BY_LAPS' && s.startTime > 0) {
      const nowSec = (frameTs || Date.now()) / 1000;
      const refSec = (s.stopTime || 0) > 0 ? s.stopTime : nowSec;
      const elapsed = Math.max(0, refSec - s.startTime - (s.stoppedSeconds || 0));
      this.heat.lt = s.finalTime * 1e6;
      this.heat.r = elapsed * 1e6;
      this.heat.h = frozen;
      this.heat._sampleMs = Date.now();
    } else {
      this.heat.h = frozen;
    }
  }

  // ── TeamStream ─────────────────────────────────────────────────────────────

  _tsFrame(handle, payload) {
    this.provider = 'teamstream';
    if (this.colMap !== TS_COLMAP) {
      this.colMap = TS_COLMAP;
      this.colMapped = new Set(Object.keys(TS_COLMAP));
    }
    // A fixed synthetic layout is never stale: it describes the writer,
    // not a board that can change shape underneath us.
    this.colStale = false;

    if (handle === 'ts_session') return this._tsSession(payload);
    if (handle === 'ts_pass' || handle === 'ts_mpass') return this._tsPasses(handle === 'ts_mpass', payload);
    if (handle === 'ts_smsg') return this._tsSmsg(payload);
    if (handle === 'ts_time') {
      // Wall-clock keep-alive ("08:58:53" UTC). Once passes have anchored the
      // 2000-epoch clock (or a session window exists to anchor it) this must
      // not clobber it — the units don't match.
      if (this.serverTimeUs != null || this.tsSessEndUs != null) return;
      const us = parseTimeToUs(typeof payload === 'object' ? payload.time ?? payload.t : payload);
      if (us) {
        this.serverTimeUs = us;
        this.serverTimeSampleMs = Date.now();
      }
      return;
    }
    if (handle === 'ts_remaining') {
      // Fallback for timekeepers that announce remaining time instead of a
      // session window; the window (start/end in <session>) is authoritative.
      if (this.tsSessEndUs != null) return;
      const us = parseTimeToUs(typeof payload === 'object' ? payload.time ?? payload.remaining ?? payload.t : payload);
      if (us != null) {
        this.heat.lt = us;
        this.heat.r = 0;
        this.heat.h = false;
        this.heat._sampleMs = Date.now();
        // lt is the remaining time at the sample, not the session length —
        // elapsed/total cannot be derived from it.
        this.heat._remainOnly = true;
      }
      return;
    }
    if (handle === 'ts_brk') {
      // brk = intermission/red period marker: freeze the clock
      this.heat.h = true;
    }
  }

  _tsCar(nr) {
    const key = String(nr).trim();
    let c = this.tsCars.get(key);
    if (!c) {
      c = {
        members: new Map(), // teammember nr → "First Last"
        lapUs: new Map(), // lap → lap time µs (CANCELLED ones excluded)
        sfMsByLap: new Map(), // lap → ms of the S/F crossing that ended it
        curLap: 0,
        lapsDone: 0, // completed laps (cancelled laps still count)
        lastSfMs: 0, // ms of the latest S/F crossing — the scoring tiebreak
        lastCross: null, // last on-track loop crossing {mm, us} (pit E.T.A.)
        lastSect: null, // last sector-end crossing {sect, us} (pit E.T.A. with configured sector distances)
        wirePos: null, // last per-pass pos from the feed (tiebreak only)
        inPit: false,
        pitEntryCounted: false, // this visit already logged on the entry loop
        outLap: false,
        pitInMs: 0,
        pitCount: 0,
        finished: false
      };
      this.tsCars.set(key, c);
    }
    return c;
  }

  // Report scalar fields a real feed sends that we do not consume — once each,
  // to the connection log. Protocol archaeology without a capture-and-grep
  // round: the records these elements serialize carry a lot more than the
  // export we have seen (Heat Status/HeatType, the Loop booleans, Lap State),
  // and this says which of it a given timekeeper actually publishes.
  _tsNote(kind, obj, known) {
    if (!obj || typeof obj !== 'object' || this.tsNoted.size > 200) return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v == null || typeof v === 'object') continue;
      if (known.has(k.toLowerCase())) continue;
      const tag = kind + '.' + k;
      if (this.tsNoted.has(tag)) continue;
      this.tsNoted.add(tag);
      this.onLog(`feed sends an unused <${kind}> field: ${k}="${String(v).slice(0, 40)}"`);
    }
  }

  _tsSession(payload) {
    if (!payload || typeof payload !== 'object') return;
    const name = [payload.group, payload.name || payload.sessionname || payload.session]
      .filter(v => typeof v === 'string' && v).join(' — ') || null;
    const prevName = this.heat.n;
    if (name && prevName && name !== prevName) {
      // next session on the same connection: the board starts over
      this.onLog(`session changed: "${prevName}" → "${name}"`);
      this.grid = {};
      this.rowByNr = new Map();
      this.tsCars = new Map();
      this.tsPassIndex = new Map();
      this.heat = {};
      this.tsSessStartUs = null;
      this.tsSessEndUs = null;
      this.tsSchedStartUs = null;
      this.tsSchedEndUs = null;
      this.tsGreenUs = null;
      this.tsStartTrigUs = null;
      this.tsFinishInferred = false;
      this.tsStatusFlag = null;
      this.tsRc = null;
      this.tsPendingMsgs = [];
      this.rcLog = [];
      this.rcSeen = new Set();
      this.onEvent({ type: 'session', name, prevName });
    }
    if (name) this.heat.n = name;
    if (typeof payload.group === 'string' && payload.group) this.tsGroup = payload.group;
    const rawName = payload.name || payload.sessionname || payload.session;
    if (typeof rawName === 'string' && rawName) this.tsName = rawName;

    // Session window on the 2000-epoch clock drives remaining/elapsed + the
    // green/finish flag inference (the feed has no explicit flag element).
    // Only the SCHEDULED window: when a session runs late, the feed never
    // updates it — _tsApplyWindow shifts it onto the green-flag anchor.
    const startUs = parseTsDateUs(payload.start);
    const endUs = parseTsDateUs(payload.end);
    if (startUs != null && endUs != null && endUs > startUs) {
      this.tsSchedStartUs = startUs;
      this.tsSchedEndUs = endUs;
      this._tsApplyWindow();
    }
    // Race vs qualifying decides the whole scoring model (order by laps at the
    // line vs by best lap) and which clock anchor applies, so prefer the
    // feed's own HeatType over the keyword test whenever it is exported.
    const heatType = String(tsGet(payload, 'type', 'heattype', 'sessiontype') ?? '').trim().toUpperCase();
    const typedRace = TS_HEAT_TYPE_RACE[heatType];
    const lapsPlanned = parseInt(payload.laps, 10) || 0;
    this.tsRace = typedRace != null
      ? typedRace
      : lapsPlanned > 0 || /race|heat|final|endur/i.test(String(payload.name || ''));

    // Explicit Heat Status — the only flag source on this socket that is not
    // an inference. Race-control text still never touches the flag.
    const status = String(tsGet(payload, 'status', 'state') ?? '')
      .trim().toUpperCase().replace(/[\s_-]+/g, '');
    if (status) {
      const f = TS_STATUS_FLAGS[status];
      if (f != null) {
        if (this.tsStatusFlag !== f) {
          this.onLog(`session status: ${status} — flag from the feed, not inferred`);
        }
        this.tsStatusFlag = f;
        this.heat.f = f;
        this.tsFinishInferred = false;
      } else if (status !== 'ACTIVE' && !this.tsNoted.has('status:' + status)) {
        this.tsNoted.add('status:' + status);
        this.onLog(`session status "${status}" is not a known flag state — ignored`);
      }
    }
    this._tsNote('session', payload, TS_SESSION_KNOWN);

    // Timing loops and the sections they delimit → sector columns. A loop can
    // both complete one sector and begin the next (Int1 ends S1, starts S2).
    if (Array.isArray(payload.loop) && payload.loop.length) {
      this.tsLoops = new Map();
      this.tsSfLoop = null;
      for (const l of payload.loop) {
        if (!l || typeof l !== 'object') continue;
        const id = String(l.id ?? '').trim();
        if (!id) continue;
        const func = String(l.func || '').toUpperCase();
        this.tsLoops.set(id, {
          name: String(l.name || ''),
          posMm: parseInt(l.pos, 10) || 0,
          pit: String(l.pit).trim() === '1',
          func,
          // Loop Data `AllowFastest` (DataID 12): whether a lap ending on this
          // loop may score a best time at all. That is exactly the rule the
          // pit-lane test in _tsPasses has to approximate, straight from the
          // timekeeper. null when not exported — then the test stands.
          allowFastest: tsBool(tsGet(l, 'allowfastest', 'allowfast'))
        });
        this._tsNote('loop', l, TS_LOOP_KNOWN);
        if (func.startsWith('SF')) this.tsSfLoop = id;
      }
    }
    if (Array.isArray(payload.section) && payload.section.length) {
      this.tsSectEnd = new Map();
      this.tsSectStart = new Map();
      payload.section.forEach((s, i) => {
        const n = i + 1;
        if (!s || typeof s !== 'object' || n > 4) return;
        if (s.endloopid != null) this.tsSectEnd.set(String(s.endloopid).trim(), n);
        if (s.startloopid != null) this.tsSectStart.set(String(s.startloopid).trim(), n);
      });
    }

    const changes = [];
    for (const en of payload.enrollment || []) {
      if (!en || typeof en !== 'object') continue;
      const nr = tsField(en, 'nr');
      if (nr == null) continue;
      const r = this._rowFor(nr);
      const car = this._tsCar(nr);
      this._setCell(r, 'nr', String(nr).trim(), changes);
      const team = tsField(en, 'team') || en.entrant;
      if (team) this._setCell(r, 'team', team, changes);
      const cls = tsField(en, 'cls');
      if (cls) this._setCell(r, 'cls', cls, changes);
      if (en.div) this._setCell(r, 'scls', en.div, changes);
      if (en.nat) this._setCell(r, 'nat', en.nat, changes);
      const vehicle = en.man || en.vehicle;
      if (vehicle) this._setCell(r, 'car', vehicle, changes);

      // Team members keyed by their member nr — the <pass> dnr field says who
      // is driving. Display convention is "First Last" (matches the web board).
      car.members = new Map();
      (en.teammember || []).forEach((m, i) => {
        if (!m || typeof m !== 'object') return;
        const full = [m.first, m.name].filter(Boolean).join(' ');
        if (full) car.members.set(String(m.nr ?? '').trim() || String(i + 1), full);
      });
      const self = [en.first, en.name].filter(Boolean).join(' ');
      const drv = car.members.size === 1
        ? [...car.members.values()][0]
        : self || tsField(en, 'driver') || [...car.members.values()].join(' / ');
      if (drv) this._setCell(r, 'driver', drv, changes);
    }
    this._processChanges(changes, { silent: true }); // entry list is metadata
  }

  // One <pass> = one timing-loop crossing:
  //   nr, lap, pos/cpos/scpos (overall/class/subclass), laptime (S/F only),
  //   inttime (time for the section this loop completes), speed, status
  //   ("CANCELLED" = lap time disallowed), ms (2000-epoch ms, local),
  //   loopid, dnr (which team member is driving), enr (unique passing id).
  // <mpass> re-sends an earlier passing (same enr) as a correction.
  _tsPasses(isCorrection, payload) {
    const passes = payload?.passes || [];
    // The reply to <all/> replays the whole passing history in one message —
    // load it silently so it cannot fire hundreds of phantom lap events.
    const silent = passes.length > 3;
    const changes = [];
    for (const pass of passes) {
      if (!pass || typeof pass !== 'object') continue;
      if (isCorrection) {
        this._tsCorrection(pass, changes);
        continue;
      }
      const nr = tsField(pass, 'nr');
      if (nr == null || String(nr).trim() === '') continue;
      // The feed also reports non-car transponders (flag-station units with
      // numbers like "⚐-4") — the web board hides them and so do we.
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(String(nr).trim())) continue;
      const r = this._rowFor(nr);
      const car = this._tsCar(nr);
      this._setCell(r, 'nr', String(nr).trim(), changes);

      const ms = parseInt(pass.ms, 10) || 0;
      if (ms > 0) this._tsClock(ms * 1000);
      const loopId = String(pass.loopid ?? '').trim();
      const loop = this.tsLoops.get(loopId);
      // Every on-track loop crossing pins the car to a known position at a
      // known time — the anchor the pit-arrival estimate dead-reckons from.
      if (loop && !loop.pit && ms > 0) {
        car.lastCross = { mm: loop.posMm, us: ms * 1000 };
      }
      const cancelled = String(pass.status || '').toUpperCase().includes('CANCEL');
      const lap = parseInt(tsField(pass, 'laps'), 10);
      const lapUs = parseTimeToUs(tsField(pass, 'last'));

      // A race's official clock starts at the start trigger: the field's S/F
      // crossing that opens lap 1 (lap counter still 0). Not the "Green Flag"
      // message — that is posted when the cars are released to the grid and
      // can precede the start by many minutes (verified at Assen: green smsg
      // 16:15:01, field crossed S/F at 16:27:30, and the official countdown
      // ran to 16:47:30 = crossing + scheduled duration; in the other races
      // that day green and crossing agreed within 2 s). The <all/> replay
      // carries the full pass history, so a mid-race join recovers the
      // anchor. The leash rejects pre-start S/F crossings at circuits where
      // the grid sits beyond the line (cars reach the grid well before the
      // start; races don't start more than a few minutes early).
      if (this.tsRace && lap === 0 && ms > 0 && loop && !loop.pit && loopId === this.tsSfLoop &&
          this.tsSchedStartUs != null && this.tsSchedEndUs != null) {
        const us = ms * 1000;
        if (us >= this.tsSchedStartUs - 5 * 60e6 && us <= this.tsSchedEndUs + 3 * 3600e6 &&
            (this.tsStartTrigUs == null || us < this.tsStartTrigUs)) {
          this.tsStartTrigUs = us;
          this.onLog(`race started at ${fmtTsUs(us)} — clock anchored to the start trigger`);
          this._tsApplyWindow();
        }
      }
      if (pass.enr) {
        this.tsPassIndex.set(String(pass.enr).trim(), { nr: String(nr).trim(), lap: isNaN(lap) ? null : lap });
        if (this.tsPassIndex.size > 20000) {
          for (const k of this.tsPassIndex.keys()) {
            if (this.tsPassIndex.size <= 10000) break;
            this.tsPassIndex.delete(k);
          }
        }
      }

      // The per-pass pos/cpos are only correct at the moment of that crossing
      // and go stale immediately (a pitted car keeps its old position for the
      // whole stop, duplicating it once others pass; some timekeepers send
      // 999 for unclassified cars). They are kept as a tiebreak only — the
      // displayed order is recomputed in _tsOrder from what actually scores.
      const pos = parseInt(tsField(pass, 'pos'), 10);
      if (!isNaN(pos) && pos > 0) car.wirePos = pos;
      if (!isNaN(lap) && lap > 0) {
        car.curLap = lap;
        this._setCell(r, 'laps', lap, changes);
      }
      const drv = car.members.get(String(pass.dnr ?? '').trim());
      if (drv) this._setCell(r, 'driver', drv, changes);

      // Sector columns: this loop completes one section (inttime) and clears
      // the one it begins, mirroring how the web board fills as the lap runs.
      const endSect = this.tsSectEnd.get(loopId);
      const intUs = parseTimeToUs(pass.inttime);
      if (endSect && intUs) this._setCell(r, `s${endSect}`, intUs, changes);
      // The sector boundary itself is a known track position — with sector
      // distances configured on the pit wall it anchors the pit E.T.A.
      if (endSect && ms > 0 && !loop?.pit) car.lastSect = { sect: endSect, us: ms * 1000 };
      const startSect = this.tsSectStart.get(loopId);
      if (startSect) this._setCell(r, `s${startSect}`, '', changes);
      if (endSect || startSect) {
        this._setCell(r, 'smarker', 'I'.repeat(Math.min(startSect || (endSect % 4) + 1, 4)), changes);
      }

      const wasOutLap = car.outLap;
      if (loop?.pit) this._tsPitLoop(r, car, loop, ms, changes);

      if (lapUs) {
        // A lap time marks an S/F crossing: the previous lap is complete and a
        // new one starts now — which is exactly what the E.T.A. state needs.
        this._setCell(r, 'last', lapUs, changes);
        // A lap that touched the pit lane never scores a best: completed on
        // the pit S/F loop (in-laps, drive-throughs) or begun at the pit exit
        // (out-laps — lap 1 runs from the Pit Out crossing and is not even a
        // full lap). The official board excludes them the same way (verified
        // at Assen: a 5:23 pit-lane "lap" left the web board's BEST blank).
        //
        // AllowFastest, where the loop table exports it, replaces the
        // pit-lane guess for the loop the lap ENDED on. It cannot replace the
        // out-lap test: that is a property of where the lap began, which no
        // per-loop flag can express.
        const loopScores = loop?.allowFastest ?? !loop?.pit;
        if (!cancelled && !isNaN(lap) && loopScores && !wasOutLap) {
          car.lapUs.set(lap, lapUs);
          if (car.lapUs.size > 200) car.lapUs.delete(Math.min(...car.lapUs.keys()));
          this._tsBest(r, car, changes);
        }
        if (!isNaN(lap) && lap > car.lapsDone) car.lapsDone = lap;
        if (!isNaN(lap) && ms > 0) {
          car.sfMsByLap.set(lap, ms);
          if (car.sfMsByLap.size > 200) car.sfMsByLap.delete(Math.min(...car.sfMsByLap.keys()));
          if (ms > car.lastSfMs) car.lastSfMs = ms;
        }
        car.outLap = false;
        if (!car.inPit && this.tsSessEndUs != null && ms > 0 && ms * 1000 >= this.tsSessEndUs) {
          car.finished = true;
          this._setCell(r, 'state', 'SFinish', changes);
        } else if (!car.inPit && ms > 0) {
          this._setCell(r, 'state', 'E' + ms * 1000, changes);
        }
        if (this.tsRace) {
          // Order first: the gap targets (leader, car ahead) must come from
          // the freshly scored order, not the previous crossing's.
          this._tsOrder(changes);
          this._tsRaceGaps(r, car, lap, ms, changes);
        }
      } else if (!car.inPit && !car.outLap && !car.finished && loop && !loop.pit && ms > 0) {
        // Mid-lap crossing: keep the E.T.A. base at the lap start (no change),
        // but a car seen on track again after the flag cannot stay "Finish".
        if (String(this.grid[r]?.[this._ci('state')] ?? '')[0] !== 'E') {
          this._setCell(r, 'state', 'E' + ms * 1000, changes);
        }
      }
    }
    this._tsOrder(changes); // new cars / wire-pos updates without an S/F crossing
    if (!this.tsRace) this._tsQualiGaps(changes);
    this._processChanges(changes, { silent });
    // Race-control history stashed before the clock was anchored can now be
    // dated (and the stale ones dropped).
    if (this.tsPendingMsgs.length && this.serverTimeUs != null) {
      const pending = this.tsPendingMsgs;
      this.tsPendingMsgs = [];
      for (const m of pending) this._tsSmsg(m);
    }
  }

  // Pit-lane loop crossing: func I = pit entry, SO = pit exit; anything else
  // just confirms the car is still in the lane.
  _tsPitLoop(r, car, loop, ms, changes) {
    if (loop.func === 'I' || (!car.inPit && loop.func !== 'SO')) {
      if (!car.inPit) {
        car.inPit = true;
        car.pitInMs = ms;
        // Tracks without a dedicated entry loop: the first in-lane read is
        // the stop.
        if (!this._tsHasPitEntryLoop()) {
          car.pitCount++;
          this._setCell(r, 'pit', car.pitCount, changes);
        }
        this._setCell(r, 'state', 'SIn Pit', changes);
        if (ms > 0) this._setCell(r, 'lpit', 'E' + ms * 1000, changes); // running
      }
      // #PIT counts crossings of the pit-entry loop itself (func I), once
      // per visit (lane loops double-read the same transponder). The lane
      // reads other loops first — PL1/PL2 sit before Pit In at Assen — and a
      // drive-through read only deeper in the lane never reaches the entry
      // loop, so it is in the pit but not a stop: matches the official board.
      if (loop.func === 'I' && !car.pitEntryCounted) {
        car.pitEntryCounted = true;
        car.pitCount++;
        this._setCell(r, 'pit', car.pitCount, changes);
      }
    }
    if (loop.func === 'SO') {
      if (car.inPit && car.pitInMs > 0 && ms > car.pitInMs) {
        this._setCell(r, 'lpit', 'L' + (ms - car.pitInMs) * 1000, changes); // frozen
      }
      car.inPit = false;
      car.pitEntryCounted = false;
      car.outLap = true;
      this._setCell(r, 'state', 'SOutLap', changes);
      if (ms > 0) this._setCell(r, 'stint', 'E' + ms * 1000, changes);
    }
  }

  // Best / 2nd best (+ the laps they were set on) from the surviving lap set —
  // recomputed in full so a cancelled lap can take a best away again.
  _tsBest(r, car, changes) {
    let b = null, b2 = null;
    for (const [lap, us] of car.lapUs) {
      if (!b || us < b.us || (us === b.us && lap < b.lap)) {
        b2 = b;
        b = { lap, us };
      } else if (!b2 || us < b2.us) {
        b2 = { lap, us };
      }
    }
    this._setCell(r, 'best', b ? b.us : '', changes);
    this._setCell(r, 'bestlap', b ? b.lap : '', changes);
    this._setCell(r, 'best2', b2 ? b2.us : '', changes);
    this._setCell(r, 'best2lap', b2 ? b2.lap : '', changes);
  }

  // Running order recomputed from what actually scores, exactly like the web
  // board: race order is laps completed then the time they were completed;
  // qualifying order is best lap. Position in class falls out of the same
  // order. The per-pass wire position is only a tiebreak for cars that have
  // not scored yet (pre-start grid order).
  _tsOrder(changes) {
    const cars = [];
    for (const [nr, car] of this.tsCars) {
      const row = this.rowByNr.get(nr);
      if (row == null) continue;
      let bestUs = null;
      if (!this.tsRace) {
        for (const us of car.lapUs.values()) if (bestUs == null || us < bestUs) bestUs = us;
      }
      cars.push({ row, car, bestUs });
    }
    cars.sort((a, b) => {
      if (this.tsRace) {
        if (a.car.lapsDone !== b.car.lapsDone) return b.car.lapsDone - a.car.lapsDone;
        const at = a.car.lastSfMs || Infinity;
        const bt = b.car.lastSfMs || Infinity;
        if (at !== bt) return at - bt;
      } else if (a.bestUs !== b.bestUs) {
        return (a.bestUs ?? Infinity) - (b.bestUs ?? Infinity);
      }
      const ap = a.car.wirePos ?? Infinity;
      const bp = b.car.wirePos ?? Infinity;
      return ap === bp ? 0 : ap - bp; // stable sort keeps enrollment order last
    });
    const picByCls = new Map();
    cars.forEach((c, i) => {
      this._setCell(c.row, 'pos', i + 1, changes);
      const cls = String(this.grid[c.row]?.[this._ci('cls')] ?? '');
      const pic = (picByCls.get(cls) || 0) + 1;
      picByCls.set(cls, pic);
      this._setCell(c.row, 'pic', pic, changes);
      // A car a lap or more down (pitted, slow) only crosses the line rarely —
      // keep its laps-down gap current as the leader keeps lapping, instead of
      // leaving the time gap from its last crossing on the board.
      if (this.tsRace && i > 0) {
        const down = cars[0].car.lapsDone - c.car.lapsDone;
        if (down >= 1) this._setCell(c.row, 'gap', `${down} lap${down > 1 ? 's' : ''}`, changes);
      }
    });
  }

  // Qualifying gaps: deltas on best lap — GAP to the overall best, DIFF to the
  // car one classification spot ahead (what the web board shows).
  _tsQualiGaps(changes) {
    const order = [];
    for (const [nr, car] of this.tsCars) {
      const row = this.rowByNr.get(nr);
      const best = parseInt(this.grid[row]?.[this._ci('best')], 10);
      if (row != null && best > 0) order.push({ row, best });
    }
    order.sort((a, b) => a.best - b.best);
    for (let i = 0; i < order.length; i++) {
      this._setCell(order[i].row, 'gap', i === 0 ? '' : order[i].best - order[0].best, changes);
      this._setCell(order[i].row, 'diff', i === 0 ? '' : order[i].best - order[i - 1].best, changes);
    }
  }

  // Race gaps at the line: same-lap crossing-time delta to the leader (GAP)
  // and to the car one position ahead (DIFF); full laps down otherwise.
  _tsRaceGaps(r, car, lap, ms, changes) {
    const posOf = row => parseInt(this.grid[row]?.[this._ci('pos')], 10);
    const myPos = posOf(r);
    if (!myPos) return;
    const against = (targetPos) => {
      for (const [nr, other] of this.tsCars) {
        const row = this.rowByNr.get(nr);
        if (row == null || posOf(row) !== targetPos) continue;
        const lapsDown = other.curLap - lap;
        if (lapsDown >= 1) return `${lapsDown} lap${lapsDown > 1 ? 's' : ''}`;
        const at = other.sfMsByLap.get(lap);
        if (at != null && ms >= at) return (ms - at) * 1000;
        return null;
      }
      return null;
    };
    if (myPos === 1) {
      this._setCell(r, 'gap', '', changes);
      this._setCell(r, 'diff', '', changes);
      return;
    }
    const gap = against(1);
    if (gap != null) this._setCell(r, 'gap', gap, changes);
    const diff = against(myPos - 1);
    if (diff != null) this._setCell(r, 'diff', diff, changes);
  }

  // <mpass>: a correction for a passing we may have already applied. The only
  // observed live use is CANCELLED (lap time disallowed for track limits) —
  // drop that lap from the car's best set and recompute.
  _tsCorrection(pass, changes) {
    const cancelled = String(pass.status || '').toUpperCase().includes('CANCEL');
    if (!cancelled) return;
    const ref = pass.enr != null ? this.tsPassIndex.get(String(pass.enr).trim()) : null;
    const nr = ref?.nr ?? (tsField(pass, 'nr') != null ? String(tsField(pass, 'nr')).trim() : null);
    if (!nr || !this.tsCars.has(nr)) return;
    const car = this.tsCars.get(nr);
    const lap = ref?.lap ?? parseInt(tsField(pass, 'laps'), 10);
    if (lap == null || isNaN(lap) || !car.lapUs.has(lap)) return;
    car.lapUs.delete(lap);
    const r = this._rowFor(nr);
    this._tsBest(r, car, changes);
    this.onLog(`lap ${lap} of #${nr} cancelled by race control`);
  }

  _tsHasPitEntryLoop() {
    for (const l of this.tsLoops.values()) {
      if (l.pit && l.func === 'I') return true;
    }
    return false;
  }

  // Effective session window. The <session> element only carries the
  // SCHEDULED window and is never updated when a session runs late. The real
  // start comes from elsewhere: quali/practice clocks start on the "Green
  // Flag - <group> - <name>" screen message (verified at Assen: a quali
  // scheduled 14:50–15:05 went green at 14:57:01 and the official countdown
  // ran to 15:12:01 = green + scheduled duration); race clocks start on the
  // start trigger — the field's lap-0 S/F crossing — because the race green
  // message can be posted minutes early, when the cars are released to the
  // grid (see _tsPasses). Anchor on whichever applies when known.
  _tsApplyWindow() {
    if (this.tsSchedStartUs == null || this.tsSchedEndUs == null) return;
    const anchorUs = this.tsRace ? this.tsStartTrigUs : this.tsGreenUs;
    const startUs = anchorUs ?? this.tsSchedStartUs;
    const endUs = startUs + (this.tsSchedEndUs - this.tsSchedStartUs);
    const prevEndUs = this.tsSessEndUs;
    this.tsSessStartUs = startUs;
    this.tsSessEndUs = endUs;
    // Joining mid-session, the green anchor arrives from the <all/> replay
    // after the passings have already walked the clock past the stale
    // scheduled end — roll the wrongly inferred finish back.
    if (prevEndUs != null && endUs > prevEndUs) this._tsUnfinish();
  }

  _tsUnfinish() {
    const nowUs = this._serverNowUs();
    if (nowUs == null || nowUs >= this.tsSessEndUs) return;
    if (this.heat.f === 5 && this.tsFinishInferred) {
      this.heat.f = nowUs >= this.tsSessStartUs ? 6 : null;
      this.tsFinishInferred = false;
      this.onLog('session end moved later — finish rolled back');
    }
    const changes = [];
    for (const [nr, car] of this.tsCars) {
      if (!car.finished) continue;
      car.finished = false;
      const r = this.rowByNr.get(nr);
      if (r == null) continue;
      if (String(this.grid[r]?.[this._ci('state')] ?? '') === 'SFinish') {
        this._setCell(r, 'state', !car.inPit && car.lastSfMs > 0 ? 'E' + car.lastSfMs * 1000 : '', changes);
      }
    }
    this._processChanges(changes, { silent: true });
  }

  // Advance the shared clock and everything hanging off it: session remaining
  // time and the green → finish flag inference from the session window.
  _tsClock(serverUs) {
    if (this.serverTimeUs == null || serverUs > this.serverTimeUs) {
      this.serverTimeUs = serverUs;
      this.serverTimeSampleMs = Date.now();
    }
    if (this.tsSessStartUs == null || this.tsSessEndUs == null) return;
    this.heat.lt = this.tsSessEndUs - this.tsSessStartUs;
    this.heat.r = Math.max(0, serverUs - this.tsSessStartUs);
    this.heat.h = false;
    this.heat._sampleMs = Date.now();
    this.heat._sampleServerUs = serverUs;
    delete this.heat._remainOnly;
    // An explicit Heat Status outranks anything the window can imply: a race
    // held under red past its scheduled end is still red, not finished.
    if (this.tsStatusFlag != null) {
      this.heat.f = this.tsStatusFlag;
      return;
    }
    if (serverUs >= this.tsSessEndUs) {
      if (this.heat.f !== 5) {
        this.onLog('session time elapsed — finish');
        this.heat.f = 5;
        this.tsFinishInferred = true;
      }
    } else if (serverUs >= this.tsSessStartUs && this.heat.f == null) {
      this.heat.f = 6; // running and no other flag information: green
    }
  }

  // Does a flag screen message name the current session? The texts follow
  // "<Colour> Flag - <group> - <session name>"; with no <session> seen yet
  // there is nothing to compare against, so treat the message as ours.
  _tsMsgIsThisSession(t) {
    const suffix = [this.tsGroup, this.tsName].filter(Boolean).join(' - ').toLowerCase();
    return !suffix || t.includes(suffix);
  }

  // Race-control messages are DISPLAY-ONLY: banner + history log. They never
  // drive the flag enum — that comes exclusively from explicit flag data (the
  // public web board's h-frame `f` via the main URL connection or the flag
  // check URL, or Al Kamel's currentFlag). Text parsing produced wrong flags
  // in live races (phantom FCY from an INFO text; an SC that ended silently
  // with no End/Green message ever posted, Assen Interserie-F1 R2). The one
  // exception is the CLOCK: the green message anchors a late quali start.
  _tsSmsg(payload) {
    if (!payload || typeof payload !== 'object') return;
    const text = String(payload.text || '').trim();
    if (!text) return;
    const now = this._serverNowUs();
    if (now == null) {
      // Can't tell live from replayed history yet — queue until a pass has
      // anchored the clock, then re-evaluate. Ring buffer keeping the NEWEST:
      // the <all/> replay can carry a whole weekend of messages (1000+ seen
      // at Assen) and the recent ones matter — they hold the green-flag
      // clock anchor and the visible history.
      this.tsPendingMsgs.push(payload);
      if (this.tsPendingMsgs.length > 500) this.tsPendingMsgs.shift();
      return;
    }
    const endUs = parseTsDateUs(payload.end);
    // Every message goes into the history log — the <all/> replay included,
    // which is exactly what makes the log complete after a (re)connect. The
    // message's own start date is mapped onto this PC's wall clock through
    // the current feed-clock offset.
    const startUs = parseTsDateUs(payload.start);
    const wallMs = Date.now() - (startUs != null ? (now - startUs) / 1000 : 0);
    this._rcAdd(text, wallMs, `${payload.start || ''}|${payload.id || ''}|${text}`);
    const t = text.toLowerCase();

    // "Green Flag - <group> - <name>" for the current session is the real
    // clock start of a quali/practice — honored even from the <all/> replay
    // (the message itself expires a minute after the start, long before a
    // mid-session join sees it). The first green wins: a restart after a red
    // must not re-arm the clock (the countdown keeps running under red on
    // these boards). Races ignore it — their green can be posted when the
    // cars are released to the grid, minutes before the start; the race
    // clock anchors on the start trigger instead (see _tsPasses).
    if (startUs != null && /^green flag\b/.test(t) && this._tsMsgIsThisSession(t) &&
        this.tsSchedStartUs != null && this.tsSchedEndUs != null &&
        startUs >= this.tsSchedStartUs - 3 * 3600e6 && startUs <= this.tsSchedEndUs + 3 * 3600e6) {
      if (this.tsGreenUs == null || startUs < this.tsGreenUs) {
        this.tsGreenUs = startUs;
        if (!this.tsRace) {
          this.onLog(`session went green at ${payload.start} — clock anchored`);
          this._tsApplyWindow();
        }
      }
    }

    // The banner shows only messages whose window is genuinely open (a flag
    // posts with a zero-length window and sparse re-sends walk the end
    // forward; the closing archive re-send has a closed window already in
    // the past — see the capture notes above). No text drives the flag.
    if (endUs == null) return;
    if (endUs >= now) this.tsRc = { text, endUs };
  }

  // ── snapshot for broadcast ─────────────────────────────────────────────────

  // Current upstream server time, extrapolated from the last s_t sample.
  _serverNowUs(nowMs = Date.now()) {
    if (this.serverTimeUs == null) return null;
    return this.serverTimeUs + (nowMs - this.serverTimeSampleMs) * 1000;
  }

  remainingUs(nowMs = Date.now()) {
    // TeamStream session window: remaining is the official clock against the
    // absolute window end, clamped to the window — exact across the start
    // (pre-start loop crossings, cars driving to the grid, must not start the
    // countdown early) and across the finish.
    if (this.tsSessStartUs != null && this.tsSessEndUs != null) {
      const nowUs = this._serverNowUs(nowMs);
      if (nowUs != null) {
        return Math.max(0, this.tsSessEndUs - Math.max(nowUs, this.tsSessStartUs));
      }
    }
    const { lt, r, h, _sampleMs, _sampleServerUs } = this.heat;
    if (lt == null || r == null) return null;
    let elapsed = r;
    if (!h) {
      // Prefer the server-clock anchor: it is immune to bootstrap staleness,
      // network latency and local clock drift. Local receipt time is the
      // fallback for providers without a server clock (Al Kamel, TeamStream).
      const serverNow = _sampleServerUs != null ? this._serverNowUs(nowMs) : null;
      if (serverNow != null && serverNow >= _sampleServerUs) {
        elapsed += serverNow - _sampleServerUs;
      } else if (_sampleMs) {
        elapsed += (nowMs - _sampleMs) * 1000;
      }
    }
    return Math.max(0, lt - elapsed);
  }

  // Elapsed session time on the feed's own clock; null while the session has
  // not started (or the feed cannot tell). TeamStream is exact — the official
  // clock against the session window, so the start is recognised the moment
  // the window opens, not at the first loop crossing after it. The other
  // providers report elapsed in the heat frame; `r` still at 0 means the
  // session has not been released (the between-sample extrapolation must not
  // invent an elapsed time pre-start).
  sessionElapsedUs(nowMs = Date.now()) {
    if (this.tsSessStartUs != null && this.tsSessEndUs != null) {
      const nowUs = this._serverNowUs(nowMs);
      if (nowUs == null || nowUs < this.tsSessStartUs) return null;
      return Math.min(nowUs, this.tsSessEndUs) - this.tsSessStartUs;
    }
    const { lt, r } = this.heat;
    if (this.heat._remainOnly || !(r > 0)) return null;
    const rem = this.remainingUs(nowMs);
    return lt != null && rem != null ? Math.max(0, lt - rem) : r;
  }

  // Session length in µs, when the feed actually knows it. getraceresults and
  // Al Kamel publish it outright; for TeamStream it falls out of the session
  // window (end − start), which is known from the <session> message — before
  // the first pass anchors the clock, so the length is available pre-start.
  // Only a remaining-time-only announcement (ts_remaining) can't give one.
  totalUs() {
    if (!this.heat._remainOnly && this.heat.lt != null) return this.heat.lt;
    if (this.tsSessStartUs != null && this.tsSessEndUs != null) {
      return this.tsSessEndUs - this.tsSessStartUs;
    }
    return null;
  }

  _tsTrack() {
    let pitInMm = null;
    let maxLoopMm = 0;
    for (const l of this.tsLoops.values()) {
      if (l.func === 'I' && pitInMm == null) pitInMm = l.posMm;
      if (!l.pit && l.posMm > maxLoopMm) maxLoopMm = l.posMm;
    }
    const sfMm = this.tsSfLoop ? this.tsLoops.get(this.tsSfLoop)?.posMm ?? null : null;
    return { pitInMm, sfMm, maxLoopMm: maxLoopMm || null };
  }

  snapshot() {
    const nowMs = Date.now();
    const entries = [];
    for (const [row, cells] of Object.entries(this.grid)) {
      const nr = this._nrOfRow(row);
      if (!nr) continue;
      // The vendor writes Long.MAX_VALUE (9223372036854775807) into numeric
      // fields it has no value for yet — an unset best time, a class position
      // on a board without classes. That is an empty cell, not data.
      //
      // Int32.MAX_VALUE is the other half of the same convention (Timing Data
      // Protocol v1.34, appendix 1: the default for Pos, PIC, PID, GridPos,
      // Points — and for FastLap, where it would otherwise pass every sanity
      // check and display as a plausible 35:47.483 best lap).
      const cell = key => {
        const v = cells[this._ci(key)];
        if (v == null || v === '') return v;
        const n = Math.abs(Number(v));
        return n > 9e18 || n === 2147483647 ? undefined : v;
      };
      const num = key => {
        const v = parseInt(cell(key), 10);
        return isNaN(v) ? null : v;
      };
      const str = key => {
        const v = cell(key);
        return v == null || v === '' ? null : String(v);
      };
      const timeUs = key => {
        const v = parseInt(cell(key), 10);
        return v > 0 && v < 9e18 ? v : null;
      };
      const state = str('state');
      const tsCar = this.tsCars.get(nr);
      const lastCross = tsCar?.lastCross || null;
      const lastSect = tsCar?.lastSect || null;
      entries.push({
        nr,
        // TeamStream: last on-track loop crossing (position in the session's
        // loop-table unit + feed-clock µs) — feeds the pit-arrival estimate.
        crossMm: lastCross ? lastCross.mm : null,
        crossUs: lastCross ? lastCross.us : null,
        // Last sector-end crossing — position by configured sector distance.
        sectNr: lastSect ? lastSect.sect : null,
        sectUs: lastSect ? lastSect.us : null,
        pos: num('pos'),
        pic: num('pic') ?? str('pic'),
        cls: str('cls'),
        driver: str('driver'),
        team: str('team'),
        car: str('car'),
        pits: num('pit'),
        laps: num('laps'),
        gap: cell('gap') ?? null,
        diff: cell('diff') ?? null,
        lastUs: timeUs('last'),
        bestUs: timeUs('best'),
        bestLap: num('bestlap'),
        best2Us: timeUs('best2'),
        best2Lap: num('best2lap'),
        nat: str('nat'),
        smarker: str('smarker'),
        s1: parseTimeToUs(cell('s1')),
        s2: parseTimeToUs(cell('s2')),
        s3: parseTimeToUs(cell('s3')),
        s4: parseTimeToUs(cell('s4')),
        lpit: cell('lpit') ?? null,
        stint: cell('stint') ?? null,
        state,
        inPit: isInPitState(state)
      });
    }
    entries.sort((a, b) => (a.pos ?? 9999) - (b.pos ?? 9999));
    const remainUs = this.remainingUs(nowMs);
    const totalUs = this.totalUs();
    return {
      provider: this.provider,
      // Upstream wall clock (µs epoch) — lets stations tick E.T.A. countdowns
      // from the "E<epoch>" running-lap states between broadcasts.
      serverNowUs: this._serverNowUs(nowMs),
      // Track-position feed: length in mm comes from the heat frame's `c`
      // field (verified against the demo feed — it matches the t_p loop
      // distances); loops and car rows come from t_i / t_p.
      tracker: Object.keys(this.trkCars).length
        ? {
            lenMm: parseInt(this.heat.c, 10) > 0 ? parseInt(this.heat.c, 10) : null,
            loops: this.trkLoops,
            cars: this.trkCars
          }
        : null,
      // TeamStream loop geometry: where the pit entry (func I) and S/F loops
      // sit, plus the farthest on-track loop so the consumer can auto-detect
      // the position unit against the track length.
      track: this.tsLoops.size ? this._tsTrack() : null,
      session: {
        name: this.heat.n || null,
        flag: this.heat.f ?? null,
        remainUs,
        totalUs,
        elapsedUs: totalUs != null && remainUs != null ? Math.max(0, totalUs - remainUs) : null,
        frozen: !!this.heat.h,
        // Latest still-active race-control message (TeamStream smsg) — pit
        // walls care about penalties and local yellows the flag can't carry.
        rc: this.tsRc && (this._serverNowUs(nowMs) ?? 0) < this.tsRc.endUs ? this.tsRc.text : null
      },
      // Full race-control message history (capped at RC_LOG_MAX), oldest
      // first, stamped on this PC's wall clock — the strips show the tail,
      // the history overlay shows everything.
      rcLog: this.rcLog,
      sessions: this.sessions.length
        ? { list: this.sessions, selected: this.selectedSession }
        : null,
      entries
    };
  }
}

// STATE cell conventions (getraceresults, mirrored by the Al Kamel mapper):
// "S<label>" pit/status states, "E<epoch µs>" running-lap timestamp.
function isInPitState(val) {
  if (typeof val !== 'string' || val[0] !== 'S') return false;
  const label = val.slice(1).trim();
  return label === 'In Pit' || label.includes('Pit') && !label.includes('Out');
}

function akStateVal(d, row) {
  const st = (d.status || '').toUpperCase();
  const ts = (d.trackState || '').toUpperCase();
  if (row && row.isCheckered) return 'SFinish';
  if (ts === 'BOX' || st === 'IN_PIT') return 'SIn Pit';
  if (ts === 'OUT_LAP' || st === 'PIT_OUT') return 'SOutLap';
  if (st === 'RETIRED' || st === 'DNF' || st === 'STOPPED') {
    return 'S' + st.charAt(0) + st.slice(1).toLowerCase();
  }
  if (d.lapStartMs > 0 && (!row || row.isRunning !== false)) return 'E' + d.lapStartMs * 1000;
  return '';
}

// ── Replay recording ─────────────────────────────────────────────────────────
// Every decoded frame of a live connection is appended to a per-session JSONL
// file, so any session can be reopened later and re-simulated through the same
// engine (scrolled, fast-forwarded). One file = one session: the recorder is
// rotated when a session change is detected, so a new session can never spill
// into the previous session's replay.
//
// File format (one JSON value per line):
//   {"type":"meta","v":1,"startedMs":…,"src":"…"}    first line
//   {"type":"session","name":"…"}                    whenever the name (re)appears
//   [relMs, handle, payload]                         one line per frame

export function createTimingRecorder({ dir, onLog = () => {} } = {}) {
  let fd = null;
  let file = null;
  let startedMs = 0;
  let frames = 0;
  let src = '';

  // Synchronous appends on an open fd: at feed rates (a few lines per second)
  // the cost is negligible, and a crash can lose at most one torn tail line —
  // which readReplayFile skips.
  function write(line) {
    if (fd == null) return;
    try {
      fs.writeSync(fd, line + '\n');
    } catch (e) {
      onLog('replay write failed: ' + e.message);
    }
  }

  function open(label = '') {
    if (!dir) return;
    close();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      file = path.join(dir, `replay-${stamp}.jsonl`);
      // Two sessions can change within a second (rotate + reconnect) — never
      // append two sessions into one file.
      for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `replay-${stamp}-${n}.jsonl`);
      fd = fs.openSync(file, 'a');
      startedMs = Date.now();
      frames = 0;
      src = label;
      write(JSON.stringify({ type: 'meta', v: 1, startedMs, src: label }));
    } catch (e) {
      onLog('replay recording unavailable: ' + e.message);
      fd = null;
      file = null;
    }
  }

  function close() {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
      if (frames === 0 && file) {
        // nothing was received — don't leave empty files behind
        try {
          fs.unlinkSync(file);
        } catch {}
      } else if (file) {
        onLog(`replay saved: ${path.basename(file)} (${frames} frames)`);
      }
    }
    fd = null;
    file = null;
    frames = 0;
  }

  return {
    open,
    close,
    // New connection: reuse a file that never got data, otherwise start fresh.
    rotate(label) {
      if (fd != null && frames === 0) return;
      open(label ?? src);
    },
    frame(f) {
      if (fd == null) return;
      frames++;
      write(JSON.stringify([Math.max(0, (f.ts || Date.now()) - startedMs), f.handle, f.payload]));
    },
    session(name) {
      if (fd != null && name) write(JSON.stringify({ type: 'session', name }));
    },
    get active() {
      return fd != null;
    },
    get frames() {
      return frames;
    }
  };
}

// Parse a replay file into { meta, name, durMs, frames:[[relMs,handle,payload]] }.
export function readReplayFile(fullPath) {
  const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
  let meta = null;
  let name = null;
  const frames = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue; // torn tail line from a crash — the rest of the file is fine
    }
    if (Array.isArray(v) && v.length >= 3) frames.push(v);
    else if (v && v.type === 'meta') meta = v;
    else if (v && v.type === 'session' && v.name) name = v.name;
  }
  return {
    meta: meta || { startedMs: 0, src: '' },
    name,
    durMs: frames.length ? frames[frames.length - 1][0] : 0,
    frames
  };
}

const REPLAY_NAME_RE = /^replay-[\d-]+\.jsonl$/;

export function listReplayFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => REPLAY_NAME_RE.test(f))
    .map(f => {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        // Cheap label scan: meta + first session name from the head (the name
        // can sit behind a large bootstrap frame), duration from the tail.
        const fd = fs.openSync(full, 'r');
        const head = Buffer.alloc(Math.min(128 * 1024, st.size));
        fs.readSync(fd, head, 0, head.length, 0);
        const tailLen = Math.min(8192, st.size);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
        fs.closeSync(fd);
        let src = '';
        let session = null;
        for (const line of head.toString('utf8').split('\n')) {
          if (line.length > 4096 || (src && session)) continue;
          try {
            const v = JSON.parse(line);
            if (v?.type === 'meta') src = v.src || '';
            else if (v?.type === 'session' && v.name && !session) session = v.name;
          } catch {}
        }
        let durMs = 0;
        for (const line of tail.toString('utf8').split('\n')) {
          try {
            const v = JSON.parse(line);
            if (Array.isArray(v)) durMs = Math.max(durMs, v[0] || 0);
            else if (v?.type === 'session' && v.name && !session) session = v.name;
          } catch {}
        }
        return { name: f, ms: st.mtimeMs, bytes: st.size, session, src, durMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.ms - a.ms);
}

// ── TimingService — lifecycle + reconnect, used by server.js ─────────────────

const RETRY_START_MS = 5000;
const RETRY_MAX_MS = 30000;

// The public web board's explicit heat flag (see TIMING_FLAGS in
// shared/model.js) is THE flag source on a direct TeamStream connection —
// the socket itself carries no flag element and race-control messages are
// display-only, so without this watch the engine only knows green/finish
// from the session window. Applied only while the watch is demonstrably
// alive, and only for real flag states (pre-start 0/1/-1 boards say
// nothing about the track).
export function applyWatchFlag(session, watch, nowMs = Date.now()) {
  if (!session || !watch) return session;
  if (watch.conn !== 'connected' || nowMs - (watch.lastFrameMs || 0) > 120e3) return session;
  if (!(watch.flag >= 2 && watch.flag <= 7)) return session;
  return { ...session, flag: watch.flag, flagSrc: 'board' };
}

const WATCH_FLAG_NAMES = { 2: 'RED FLAG', 3: 'SAFETY CAR', 4: 'CODE 60', 5: 'FINISH', 6: 'GREEN', 7: 'FCY' };

export function createTimingService({ onEvent, onLog, replayDir = null } = {}) {
  const log = onLog || (m => console.log('[timing]', m));

  let replay = null; // active replay: {file, name, frames, idx, posMs, durMs, playing, speed}
  let replayTimer = null;
  const recorder = createTimingRecorder({ dir: replayDir, onLog: log });
  let recordedName = null;

  const engine = new TimingEngine({
    onEvent: ev => {
      // Replays are simulations: they must never write laps/pits into the
      // live race state.
      if (replay) return;
      // The engine cannot read the board it is being sent and wants it
      // re-described from the top. Not a race event — it never leaves here.
      if (ev.type === 'refresh') {
        if (relay?.reload) {
          log(`reconnecting the feed: ${ev.reason}`);
          relay.reload();
        }
        return;
      }
      // One session = one replay file. The engine detects the change (web
      // heat rename or a new TeamStream session message) before any frame of
      // the new session has produced standings — rotating here means the new
      // session's frames land in a fresh file, never spilling into the old.
      if (ev.type === 'session') {
        recorder.rotate();
        recorder.session(ev.name);
        recordedName = ev.name;
      }
      onEvent?.(ev);
    },
    onLog: log
  });

  let relay = null;
  let cfg = null;
  let wanted = false;
  let conn = 'off'; // off | resolving | connecting | connected | retrying | error | replay
  let lastError = null;
  let eventName = null;
  let retryTimer = null;
  let retryDelay = RETRY_START_MS;
  let authFailed = false;

  function stopRelay() {
    if (relay) {
      try {
        relay.stop();
      } catch {}
      relay = null;
    }
    rawClose();
  }

  // Raw wire capture: every complete TeamStream message exactly as received
  // (post-TLS, post-gunzip, before parsing), one JSON-encoded line with a
  // wall-clock stamp. The replay files only keep what the parser understood —
  // this is the ground truth for protocol archaeology (e.g. hunting a flag
  // packet the element decoder might be blind to). One file per connection.
  let rawFd = null;
  function rawWrite(text) {
    if (!replayDir) return;
    if (rawFd == null) {
      try {
        fs.mkdirSync(replayDir, { recursive: true });
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        rawFd = fs.openSync(path.join(replayDir, `raw-${stamp}.log`), 'a');
        log(`raw wire capture: raw-${stamp}.log`);
      } catch (e) {
        log('raw capture unavailable: ' + e.message);
        rawFd = false; // don't retry on every message
      }
    }
    if (typeof rawFd !== 'number') return;
    try {
      fs.writeSync(rawFd, Date.now() + '\t' + JSON.stringify(text) + '\n');
    } catch {}
  }
  function rawClose() {
    if (typeof rawFd === 'number') {
      try {
        fs.closeSync(rawFd);
      } catch {}
    }
    rawFd = null;
  }

  const handlers = {
    onRaw: rawWrite,
    onFrame: f => {
      engine.applyFrame(f);
      // Record after applying: a session-change frame rotates the recorder
      // first (via the engine event above), so the frame that announces the
      // new session is the first line of the new file.
      recorder.frame(f);
      if (engine.heat.n && engine.heat.n !== recordedName) {
        recordedName = engine.heat.n;
        recorder.session(recordedName);
      }
    },
    onStatus: st => {
      if (st === 'connected') {
        retryDelay = RETRY_START_MS;
        conn = 'connected';
        lastError = null;
      } else if (st === 'disconnected') {
        scheduleRetry();
      } else if (st === 'connecting') {
        if (conn !== 'connected') conn = 'connecting';
      }
    },
    onError: msg => {
      lastError = msg;
      if (/AUTH DENIED|rejected/i.test(msg)) authFailed = true;
      log(msg);
    },
    onLog: log
  };

  function scheduleRetry() {
    if (!wanted || authFailed) {
      conn = wanted ? 'error' : 'off';
      return;
    }
    conn = 'retrying';
    clearTimeout(retryTimer);
    log(`upstream lost — retrying in ${Math.round(retryDelay / 1000)}s`);
    retryTimer = setTimeout(open, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  // ── flag watch ─────────────────────────────────────────────────────────────
  // A second, read-only connection to the event's PUBLIC web board. That feed
  // carries the explicit flag state the TeamStream socket lacks — it is
  // literally the coloured flag box on livetiming.getraceresults.com — and it
  // is the ONLY source of SC/FCY/Code 60/red on a direct TeamStream
  // connection (applyWatchFlag): the engine itself only knows green/finish
  // from the session window. Everything else on it is ignored.
  const watch = { conn: 'off', url: null, flag: null, name: null, lastFrameMs: 0, error: null };
  let watchRelay = null;
  let watchWanted = false;
  let watchTimer = null;
  let watchDelay = RETRY_START_MS;

  function watchStop() {
    try {
      watchRelay?.stop();
    } catch {}
    watchRelay = null;
  }

  function watchRetry() {
    if (!watchWanted) {
      watch.conn = 'off';
      return;
    }
    watch.conn = 'retrying';
    clearTimeout(watchTimer);
    watchTimer = setTimeout(watchOpen, watchDelay);
    watchDelay = Math.min(watchDelay * 2, RETRY_MAX_MS);
  }

  function watchFrame({ handle, payload }) {
    if (handle !== 'h_i' && handle !== 'h_h') return;
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!data || typeof data !== 'object') return;
    if (data.n != null) watch.name = String(data.n);
    const f = parseInt(data.f, 10);
    if (!isNaN(f) && watch.flag !== f) {
      watch.flag = f;
      log(`flag watch: board shows ${WATCH_FLAG_NAMES[f] || 'flag ' + f}`);
    }
  }

  async function watchOpen() {
    watchStop();
    try {
      watch.conn = 'resolving';
      const r = await resolveTimingUrl(String(watch.url || '').trim());
      if (!watchWanted) return;
      if (r.error) throw new Error(r.error);
      if (r.provider !== 'getraceresults') {
        throw new Error('the flag check needs a getraceresults page URL');
      }
      watchRelay = new GrrRelay(
        { timekeeperId: r.timekeeperId, tkdm: r.tkdm, baseUrl: r.baseUrl },
        {
          onFrame: f => {
            watch.lastFrameMs = Date.now();
            try {
              watchFrame(f);
            } catch {}
          },
          onStatus: st => {
            if (st === 'connected') {
              watch.conn = 'connected';
              watchDelay = RETRY_START_MS;
              watch.error = null;
              log('flag check connected — the web board flag is the authority');
            } else if (st === 'disconnected') {
              watchRetry();
            } else if (st === 'connecting' && watch.conn !== 'connected') {
              watch.conn = 'connecting';
            }
          },
          onError: m => {
            watch.error = m;
          },
          onLog: m => log('flag check: ' + m)
        }
      );
      watch.conn = 'connecting';
      await watchRelay.start();
    } catch (e) {
      watch.error = e.message;
      log('flag check failed: ' + e.message);
      watchRetry();
    }
  }

  async function open() {
    stopRelay();
    engine.reset();
    // One file per connection too — reconnects reuse it while it's empty.
    recorder.rotate(cfg.mode === 'teamstream' ? String(cfg.host || '') : String(cfg.url || ''));
    recordedName = null;
    try {
      if (cfg.mode === 'teamstream') {
        const host = String(cfg.host || '').trim();
        const key = String(cfg.key || '').trim();
        if (!host) throw new Error('TeamStream host is required.');
        if (!key) throw new Error('TeamStream key is required.');
        const port = parseInt(cfg.port, 10);
        eventName = host;
        engine.provider = 'teamstream';
        let ssl = cfg.ssl !== false;
        const implied = tsPortImpliesSsl(port);
        if (implied != null && implied !== ssl) {
          log(`port ${port} is the ${implied ? 'SSL' : 'plain'} Team Stream port — ${implied ? 'enabling' : 'disabling'} TLS`);
          ssl = implied;
        }
        relay = new TeamStreamRelay(
          {
            host,
            key,
            port: port >= 1 && port <= 65535 ? port : null,
            ssl,
            allowSelfSigned: !!cfg.allowSelfSigned
          },
          handlers
        );
        conn = 'connecting';
        relay.start();
      } else {
        conn = 'resolving';
        const r = await resolveTimingUrl(String(cfg.url || '').trim());
        if (!wanted) return;
        if (r.error) throw new Error(r.error);
        eventName = r.eventName || null;
        engine.provider = r.provider;
        if (r.provider === 'alkamel') {
          relay = new AlKamelRelay({ feedName: r.feedName, sessionId: cfg.sessionId || null }, handlers);
        } else {
          relay = new GrrRelay(
            { timekeeperId: r.timekeeperId, tkdm: r.tkdm, baseUrl: r.baseUrl },
            handlers
          );
        }
        conn = 'connecting';
        await relay.start();
      }
    } catch (e) {
      lastError = e.message;
      log('connect failed: ' + e.message);
      scheduleRetry();
    }
  }

  // ── replay playback ────────────────────────────────────────────────────────
  // A replay re-simulates recorded frames through the same engine. The
  // engine's server clock is advanced manually at the playback speed so
  // E.T.A. columns and the session countdown behave exactly like live —
  // frozen on pause, fast on fast-forward.

  function replayAnchorClocks() {
    const now = Date.now();
    engine.serverTimeSampleMs = now;
    if (engine.heat._sampleMs) engine.heat._sampleMs = now;
  }

  function replayApplyTo(t) {
    t = Math.min(t, replay.durMs);
    while (replay.idx < replay.frames.length && replay.frames[replay.idx][0] <= t) {
      const [rel, handle, payload] = replay.frames[replay.idx++];
      try {
        engine.applyFrame({ handle, payload, ts: (replay.meta.startedMs || 0) + rel });
      } catch {}
    }
    replay.posMs = t;
    replayAnchorClocks();
  }

  function replayStop() {
    clearInterval(replayTimer);
    replayTimer = null;
    if (replay) {
      replay = null;
      engine.reset();
      conn = 'off';
    }
  }

  return {
    async connect(cfgIn) {
      replayStop();
      cfg = { ...cfgIn };
      wanted = true;
      authFailed = false;
      retryDelay = RETRY_START_MS;
      clearTimeout(retryTimer);
      await open();
    },
    disconnect() {
      wanted = false;
      clearTimeout(retryTimer);
      stopRelay();
      recorder.close();
      recordedName = null;
      engine.reset();
      conn = 'off';
      lastError = null;
      eventName = null;
    },
    flagWatchConnect(url) {
      const u = String(url || '').trim();
      if (!u) return this.flagWatchDisconnect();
      if (watchWanted && watch.url === u && (watch.conn === 'connected' || watch.conn === 'connecting')) return;
      watch.url = u;
      watchWanted = true;
      watchDelay = RETRY_START_MS;
      clearTimeout(watchTimer);
      watchOpen();
    },
    flagWatchDisconnect() {
      watchWanted = false;
      clearTimeout(watchTimer);
      watchStop();
      Object.assign(watch, { conn: 'off', url: null, flag: null, name: null, error: null });
    },
    // test seam: feed a board frame into the watch without a network connection
    _flagWatchTest(frame) {
      watch.conn = 'connected';
      watch.lastFrameMs = Date.now();
      watchFrame(frame);
    },
    selectSession(sessionId) {
      if (cfg) cfg.sessionId = sessionId;
      relay?.selectSession?.(sessionId);
    },

    listReplays() {
      return listReplayFiles(replayDir);
    },
    replayOpen(name) {
      const base = path.basename(String(name || ''));
      if (!replayDir || !REPLAY_NAME_RE.test(base)) return { ok: false, error: 'invalid replay name' };
      // A replay takes over the timing channel — the live feed is stopped
      // (and its recording closed) first.
      this.disconnect();
      let data;
      try {
        data = readReplayFile(path.join(replayDir, base));
      } catch (e) {
        return { ok: false, error: e.message };
      }
      if (!data.frames.length) return { ok: false, error: 'replay file holds no frames' };
      replay = {
        file: base,
        name: data.name,
        meta: data.meta,
        frames: data.frames,
        durMs: data.durMs,
        idx: 0,
        posMs: 0,
        playing: false,
        speed: 1,
        lastMs: Date.now()
      };
      conn = 'replay';
      replayApplyTo(0); // load the board (session/bootstrap frames sit at t≈0)
      replayTimer = setInterval(() => {
        if (!replay) return;
        const now = Date.now();
        const dt = now - replay.lastMs;
        replay.lastMs = now;
        if (!replay.playing) {
          replayAnchorClocks(); // paused: the clocks must not drain
          return;
        }
        const adv = dt * replay.speed;
        if (engine.serverTimeUs != null) {
          engine.serverTimeUs += adv * 1000;
          engine.serverTimeSampleMs = now;
        }
        replayApplyTo(replay.posMs + adv);
        if (replay.idx >= replay.frames.length && replay.posMs >= replay.durMs) {
          replay.playing = false;
        }
      }, 250);
      log(`replay opened: ${base} (${data.frames.length} frames, ${Math.round(data.durMs / 1000)}s)`);
      return { ok: true };
    },
    replayControl({ op, value } = {}) {
      if (!replay) return { ok: false, error: 'no replay open' };
      if (op === 'play') replay.playing = replay.posMs < replay.durMs;
      else if (op === 'pause') replay.playing = false;
      else if (op === 'speed') {
        const s = Number(value);
        if (isFinite(s) && s > 0) replay.speed = Math.min(600, Math.max(0.25, s));
      } else if (op === 'seek') {
        const t = Math.min(replay.durMs, Math.max(0, Number(value) || 0));
        if (t < replay.posMs) {
          // rewinding: rebuild the board from the start of the file
          engine.reset();
          replay.idx = 0;
        }
        replayApplyTo(t);
      } else if (op === 'close') replayStop();
      return { ok: true };
    },

    snapshot() {
      if (replay) {
        return {
          conn: 'replay',
          lastError: null,
          eventName: replay.meta.src || null,
          replay: {
            file: replay.file,
            name: replay.name,
            durMs: replay.durMs,
            posMs: Math.round(replay.posMs),
            playing: replay.playing,
            speed: replay.speed
          },
          ...engine.snapshot()
        };
      }
      if (conn === 'off') return { conn: 'off' };
      const s = engine.snapshot();
      // The board flag watch outranks everything the engine inferred.
      s.session = applyWatchFlag(s.session, watch);
      if (watch.conn !== 'off') {
        s.flagWatch = { conn: watch.conn, url: watch.url, flag: watch.flag, name: watch.name, error: watch.error };
      }
      return { conn, lastError, eventName, ...s };
    },
    get flagWatch() {
      return { ...watch };
    },
    get engine() {
      return engine;
    }
  };
}
