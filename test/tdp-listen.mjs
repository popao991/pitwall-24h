// Timing Data Protocol listener — a diagnostic, not part of the app.
//
// The RSTime "Timing Data Protocol" (v1.34) inverts the direction the app's
// live timing is built around: instead of dialling the timekeeper, we listen
// and THEY connect to us. Nothing in server/livetiming.js can accept that, so
// this stands in until there is a real decoder — and it is what proves the
// network path works at all.
//
// It answers two questions no amount of reading the PDF can:
//   1. does a connection actually arrive (router forwards + firewall)?
//   2. which records and FIELDS does this server really send? The document
//      marks several interesting ones "(To be implemented)", so the field
//      census printed on exit is the thing worth having before writing a
//      parser against any of it.
//
// Zero dependencies beyond Node built-ins — copy this one file to whichever
// machine is receiving and run it there.
//
//   node tdp-listen.mjs [port] [--quiet]
//
// Ctrl+C prints the census. Raw bytes are also written to tdp-raw-<stamp>.log
// next to the script, one JSON-encoded line per chunk with a wall-clock stamp
// (same shape as the app's TeamStream raw capture) so a session can be
// replayed into a decoder later.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const port = parseInt(args.find(a => /^\d+$/.test(a)) ?? '', 10) || 12910;

// DataID → record name, from the protocol's own record list. 13 was removed
// (Push2Pass) and 14 skips it, so the gap is expected, not a typo.
const RECORDS = {
  0: 'protocol version', 1: 'equipe', 2: 'enrollment', 3: 'driver',
  4: 'time', 5: 'heat', 6: 'lap', 7: 'intermediate', 8: 'startgrid',
  9: 'result', 10: 'rc message', 11: 'weather', 12: 'loop',
  14: 'pre-announce laps', 15: 'light beam', 16: 'pitstop/stint', 17: 'tyre'
};

// Fields worth shouting about the moment they appear: each one replaces
// something the app currently has to reconstruct or cannot see at all.
const NOTABLE = new Map([
  ['status', 'explicit flag state — the thing the TeamStream socket lacks'],
  ['timestarted', 'official race start, no start-trigger heuristic needed'],
  ['clockhaltedduration', 'red-flag stoppage time — correct clock across a red'],
  ['racetimeclockhalted', 'race time while stopped'],
  ['state', 'per-car state incl. in-pit / outlap / missing'],
  ['standingtime', 'time the car actually stood still, not just lane time'],
  ['pitindriverid', 'official driver change'],
  ['pitoutdriverid', 'official driver change'],
  ['allowfastest', 'which loops may score a best lap'],
  ['istankin', 'refuel zone loop'],
  ['airtemperature', 'weather'],
  ['tracktemperature', 'weather']
]);
for (let n = 1; n <= 5; n++) {
  NOTABLE.set(`totalstinttimedriver${n}`, `official seat time for driver ${n}`);
}

const seen = new Map(); // DataID → {count, fields:Set}
const shouted = new Set();
let conns = 0;
let bytes = 0;
let lines = 0;

const here = path.dirname(fileURLToPath(import.meta.url));
const d = new Date();
const p = n => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
const rawPath = path.join(here, `tdp-raw-${stamp}.log`);
let rawFd = null;
function raw(text) {
  try {
    rawFd ??= fs.openSync(rawPath, 'a');
    fs.writeSync(rawFd, Date.now() + '\t' + JSON.stringify(text) + '\n');
  } catch { /* capture is best-effort; never take the listener down with it */ }
}

// Field names only. Values are skipped deliberately — a quoted string may
// contain commas and '=', and guessing at that is exactly the parser this
// tool exists to avoid writing before there is real data to write it against.
function fieldNames(line) {
  const names = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const eq = line.indexOf('=', i);
    if (eq === -1) break;
    names.push(line.slice(i, eq).trim());
    i = eq + 1;
    if (line[i] === '"') {
      // quoted value: commas inside it are data, not separators
      const close = line.indexOf('"', i + 1);
      i = close === -1 ? n : close + 1;
      const comma = line.indexOf(',', i);
      i = comma === -1 ? n : comma + 1;
    } else {
      const comma = line.indexOf(',', i);
      i = comma === -1 ? n : comma + 1;
    }
  }
  return names;
}

function record(line) {
  lines++;
  const names = fieldNames(line);
  if (!names.length) return;
  const idMatch = line.match(/^\s*DataID\s*=\s*(\d+)/i);
  const id = idMatch ? parseInt(idMatch[1], 10) : -1;
  let rec = seen.get(id);
  if (!rec) seen.set(id, (rec = { count: 0, fields: new Set() }));
  rec.count++;
  for (const name of names) {
    rec.fields.add(name);
    const key = name.toLowerCase();
    const why = NOTABLE.get(key);
    if (why && !shouted.has(key)) {
      shouted.add(key);
      console.log(`\n  >> ${name} is being sent — ${why}\n`);
    }
  }
}

// Printed when a connection ends and again on exit. Not only on Ctrl+C: the
// interesting run is the one where the timekeeper connects, sends a burst and
// drops, and that census should be on screen without having to stop the
// listener — which would also miss their reconnect.
function census(why) {
  console.log(`\n──── census (${why}) ────`);
  console.log(`${conns} connection(s), ${bytes} bytes, ${lines} record line(s)`);
  if (!seen.size) {
    console.log('No records parsed. Either nothing arrived (forward not through,');
    console.log('or the server has not been told to dial this address:port), or');
    console.log('what arrived was not DataID lines — check the raw capture.');
  }
  for (const [id, rec] of [...seen].sort((a, b) => a[0] - b[0])) {
    const name = id === -1 ? 'unrecognised (no DataID)' : RECORDS[id] || 'undocumented';
    console.log(`\nDataID ${id} — ${name}  (${rec.count})`);
    console.log('  ' + [...rec.fields].join(', '));
  }
  console.log(`\nRaw capture: ${rawPath}\n`);
}

const server = net.createServer(sock => {
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  conns++;
  console.log(`[${new Date().toLocaleTimeString()}] CONNECTED from ${peer}`);
  raw(`--- connection from ${peer} ---`);

  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    raw(chunk);
    buf += chunk;
    // Records are CR/LF terminated; tolerate a bare LF from anything
    // hand-testing the port.
    let idx;
    while ((idx = buf.search(/\r?\n/)) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === '\r' ? 2 : 1));
      if (!line.trim() || line.startsWith('//')) continue; // // = comment line
      record(line);
      if (!quiet) console.log('  ' + (line.length > 200 ? line.slice(0, 200) + ' …' : line));
    }
    if (buf.length > 4 * 1024 * 1024) buf = ''; // never grow without bound
  });
  sock.on('error', e => console.log(`[${peer}] socket error: ${e.message}`));
  sock.on('close', () => {
    console.log(`[${new Date().toLocaleTimeString()}] ${peer} disconnected`);
    census('after ' + peer);
  });
});

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE'
    ? `Port ${port} is already in use on this machine — pick another and forward that one instead.`
    : `Listener failed: ${e.message}`);
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Listening on 0.0.0.0:${port} — waiting for the timekeeper to connect.`);
  console.log(`Raw capture: ${rawPath}`);
  // Which LAN address to point the UDR7's port forward at. Getting this wrong
  // is indistinguishable from a broken router rule.
  const lan = Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) => (addrs || [])
      .filter(a => a.family === 'IPv4' && !a.internal)
      .map(a => `${name} ${a.address}`));
  if (lan.length) console.log(`Forward the port to this machine at: ${lan.join(' | ')}`);
  console.log('The census prints when a connection ends, and again on Ctrl+C.\n');
});

function bye() {
  census('exit');
  try { if (rawFd != null) fs.closeSync(rawFd); } catch {}
  process.exit(0);
}
// SIGBREAK too: on Windows a plain Ctrl+C is not always delivered as SIGINT
// depending on how the process was started, and Ctrl+Break is the reliable one.
process.on('SIGINT', bye);
process.on('SIGBREAK', bye);
