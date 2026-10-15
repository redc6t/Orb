'use strict';
/* Mullaloo Motorsport Engineering Solutions - Pit Wall server
 * node server.js  ->  http://localhost:8080 (engineer)  |  http://<laptop-ip>:8080 (view-only devices)
 * Fully offline: no CDN, no cloud. Only dependency: ws.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const Store = require('./lib/store');
const D = require('./lib/defaults');
const E = require('./public/js/shared/engine.js');
const PltdAdapter = require('./lib/adapters/pltd');
const BttmAdapter = require('./lib/adapters/bttm');
const UdpAdapter = require('./lib/adapters/udp');
const BRAND = require('./public/js/brand.js');

const VERSION = require('./package.json').version;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.PITWALL_DATA || path.join(ROOT, 'data');
const store = new Store(DATA);
const PORT = +process.env.PORT || store.settings.port || 8080;

// ------------------------------------------------------------------ roles
let localIPs = new Set();
function refreshIPs() {
  const s = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) s.add(i.address);
  localIPs = s;
}
refreshIPs(); setInterval(refreshIPs, 30000);
function clientIP(req) { return String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''); }
// Only the host laptop (any of its own addresses) or explicitly listed hosts may change anything.
function isEngineer(req) { const ip = clientIP(req); if (process.env.PITWALL_ENGINEER === 'loopback') return ip === '127.0.0.1' || ip === '::1'; return localIPs.has(ip) || (store.settings.engineerHosts || []).includes(ip); }

// ------------------------------------------------------------------ actions
const ACTIONS = new Set(['setup.update', 'session.start', 'session.end', 'flag.set', 'carstate', 'lap', 'stop.service', 'fuel.check', 'fuel.refuel',
  'driver.set', 'driver.queue', 'crew.status', 'crew.shifts', 'crew.shiftsAll', 'crew.override', 'issue.add', 'issue.update', 'tyre.mount', 'tyre.unmount',
  'tyre.measure', 'tyre.status', 'pitmsg.send', 'penalty.add', 'note', 'alert.ack',
  'gate.ack', 'gate.cmd', 'stop.void', 'scenario.init', 'scenario.set', 'scenario.reset', 'scenario.activate']);

function broadcast(obj) { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1) c.send(s); }
function append(type, payload, by, src) {
  if (!store.eventId) return null;
  const e = store.append(type, payload, by, src);
  broadcast({ t: 'evt', e });
  return e;
}

// ------------------------------------------------------------------ adapters
const pltd = new PltdAdapter(), bttm = new BttmAdapter(), udp = new UdpAdapter();
function devices() { return { pltd: pltd.snapshot(), bttm: { status: bttm.status, host: bttm.host }, udp: udp.snapshot() }; }
function configureDevices() {
  const dv = (store.state && store.state.config.devices) || {};
  pltd.configure(dv.pltd); bttm.configure(dv.bttm); udp.configure(dv.udp);
}
const sessionActive = () => !!(store.state && store.state.activeSessionId);
[pltd, bttm, udp].forEach(a => a.on('status', () => broadcast({ t: 'devices', devices: devices() })));
pltd.on('lap', l => { if (sessionActive()) append('lap', l, 'pltd', 'pltd'); });
pltd.on('carstate', cs => { if (store.state && store.state.carState.current !== cs) append('carstate', { cs }, 'pltd', 'pltd'); });
pltd.on('carstate-initial', cs => { if (store.state && sessionActive() && store.state.carState.current !== cs && cs !== 'RUNNING') append('carstate', { cs }, 'pltd', 'pltd'); });
pltd.on('flagstate', f => {
  if (!store.state) return;
  if (pltd.flagSentAt && Date.now() - pltd.flagSentAt < 2500) return;   // echo of our own flag change, still settling
  const want = PltdAdapter.flagFromState(f), cur = store.state.flag.current;
  const same = (cur === 'DOUBLE YELLOW' && want === 'YELLOW') || (cur === 'FCY' && want === 'SC') || cur === want;
  if (!same && sessionActive()) append('flag.set', { flag: want }, 'pltd', 'pltd');
});
pltd.on('pitshown', id => append('pitmsg.shown', { id }, 'pltd', 'pltd'));
pltd.on('pitack', a => append('pitmsg.ack', a, 'pltd', 'pltd'));
pltd.on('note', t => append('note', { text: t }, 'pltd', 'pltd'));
pltd.on('info', info => broadcast({ t: 'devices', devices: devices() }));
pltd.on('map', m => broadcast({ t: 'map', map: m }));
const bttmIssueAt = {};
bttm.on('alarm', a => {
  if (!sessionActive()) return;
  append('bttm.alarm', a, 'bttm', 'bttm');
  const dv = store.state.config.devices || {};
  const key = a.kind + a.corner;
  if (a.level === 'crit' && (dv.bttm || {}).autoIssues !== false && Date.now() - (bttmIssueAt[key] || 0) > 600000) {
    bttmIssueAt[key] = Date.now();
    const what = { brake: 'brake temp', tyre: 'tyre temp', press: 'tyre pressure' }[a.kind];
    const unit = a.kind === 'press' ? ' psi' : ' C';
    append('issue.add', { cat: a.kind === 'brake' ? 'brakes' : 'tyres', sev: 'crit', corner: a.corner, nextStop: true, src: 'BTTM',
      text: a.corner.toUpperCase() + ' ' + what + ' ' + Math.round(a.value) + unit + ' (above BTTM top band)' }, 'bttm', 'bttm');
  }
});
udp.on('msg', (m, ip) => {
  if (!store.state) return;
  const by = 'udp:' + ip;
  switch (m.t) {
    case 'lap': if (sessionActive()) append('lap', { n: m.n, ms: m.ms, pitted: !!m.pitted }, by, 'udp'); break;
    case 'carstate': if (store.state.carState.current !== m.cs) append('carstate', { cs: m.cs }, by, 'udp'); break;
    case 'flag': if (store.state.flag.current !== m.flag) append('flag.set', { flag: m.flag }, by, 'udp'); break;
    case 'fuel': append('fuel.check', { litres: +m.litres, weight: m.weight != null ? m.weight : 1, note: 'udp' }, by, 'udp'); break;
    case 'impact': append('issue.add', { cat: 'impact', sev: (+m.g >= 4 ? 'crit' : 'warn'), nextStop: true, src: 'IMU',
      text: 'Impact ' + (+m.g).toFixed(1) + ' g' + (m.lat ? ' at ' + (+m.lat).toFixed(5) + ',' + (+m.lon).toFixed(5) : '') }, by, 'udp'); break;
    case 'issue': append('issue.add', { cat: m.cat || 'other', sev: m.sev || 'warn', text: m.text || '', nextStop: m.nextStop !== false, src: m.src || 'device' }, by, 'udp'); break;
    default: break;
  }
});
udp.on('note', t => append('note', { text: t }, 'system'));

// ------------------------------------------------------------------ alert logger (1 Hz)
let loggedAlerts = new Set();
function resetAlertKeys() { loggedAlerts = new Set((store.state ? store.state.alerts : []).map(a => a.key)); }
setInterval(() => {
  if (!store.state) return;
  try {
    const d = E.derive(store.state, Date.now());
    for (const a of d.alerts) if (!loggedAlerts.has(a.key)) { loggedAlerts.add(a.key); append('alert', a, 'engine'); }
    // Gates: geofence events are trusted automatically when nobody acknowledges them in time
    const now = Date.now();
    // geofence override: a step the car has physically moved past is applied from the plan
    if (sessionActive()) for (const g of E.pendingGates(store.state, d, now)) {
      for (const due of g.list.filter(x => x.state === 'due')) {
        if (due.id === 'fuel') append('stop.service', g.autoService, 'auto-gate');
        else if (due.id === 'driver') append('gate.ack', { stopId: g.stop.id, gate: 'driver', auto: true, driverIn: g.autoDriverIn }, 'auto-gate');
        else append('gate.ack', { stopId: g.stop.id, gate: due.id, auto: true, plan: due.id === 'pitin' ? g.planned : undefined }, 'auto-gate');
      }
    }
  } catch (e) { console.error('derive error', e); }
  broadcast({ t: 'tick', now: Date.now() });
}, 1000);
setInterval(() => broadcast({ t: 'live', pltd: pltd.snapshot(), bttm: bttm.snapshot() }), 250);

// ------------------------------------------------------------------ HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > (limit || 20e6)) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function meta(req) {
  return { version: VERSION, role: isEngineer(req) ? 'engineer' : 'viewer', rules: D.loadRules(), tracks: D.TRACKS, formats: D.FORMATS,
    cars: [D.LANCER].concat(store.listCars().filter(c => c.id !== D.LANCER.id)).map(c => store.listCars().find(x => x.id === c.id) || c),
    events: store.listEvents(), activeEventId: store.eventId, defaultConfig: defaultDraft(), serverTime: Date.now(), hostIPs: [...localIPs].filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1'), port: PORT };
}
function defaultDraft() {
  const members = [];
  for (let i = 1; i <= 5; i++) members.push({ id: 'm' + i, name: 'Driver ' + i, driver: true, roles: ['driver'] });
  members.push({ id: 'm6', name: 'Crew 1', driver: false, roles: ['mechanic', 'refueller'] });
  members.push({ id: 'm7', name: 'Crew 2', driver: false, roles: ['mechanic', 'assistant', 'cutoff', 'pump'] });
  members.push({ id: 'm8', name: 'Crew 3', driver: false, roles: ['fire', 'raceceiver'] });
  const start = new Date(); start.setDate(start.getDate() + ((5 - start.getDay() + 7) % 7 || 7)); start.setHours(10, 0, 0, 0);
  const c = D.makeConfig({ rulesId: 'beers-v4-2025-02', formatId: '36h', trackId: 'collie-motorplex', members, raceStart: start.toISOString(), teamName: '' });
  c.name = '';
  const lib = store.listCars().find(x => x.id === c.car.id); if (lib) c.car = lib;
  return c;
}
function logoFile() {
  for (const ext of ['png', 'svg', 'jpg']) { const f = path.join(DATA, 'branding', 'logo.' + ext); if (fs.existsSync(f)) return f; }
  return path.join(PUBLIC, 'assets', 'mullaloo-logo.png');
}
function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const eng = isEngineer(req);
  try {
    if (p === '/api/meta') return send(res, 200, meta(req));
    if (p === '/api/sim/stop') {   // read-only: lets the simulator follow the engineer's stop gates
      const st = store.state; if (!st) return send(res, 200, { open: false });
      const d = E.derive(st, Date.now()), g = d.gates;
      if (!g) return send(res, 200, { open: false, plannedAdd: d.nextStop ? d.nextStop.add : 0 });
      const svc = g.stop.service;
      return send(res, 200, { open: !g.stop.outTs, stopId: g.stop.id, plannedAdd: (g.planned || {}).add || 0, fuelDone: !!svc, fuelAdded: svc ? svc.fuelAdded : 0, pitOut: !!st.gates[g.stop.id + ':pitout'] });
    }
    if (p === '/branding/logo') { const f = logoFile(); return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)]); }
    if (p === '/api/export') {
      const id = url.searchParams.get('id') || store.eventId;
      if (!id) return send(res, 404, { error: 'no event' });
      const b = store.bundle(id);
      const name = String((b.config && b.config.name) || id).replace(/[^a-z0-9]+/gi, '_') + '.pitwall.json';
      return send(res, 200, JSON.stringify(b), 'application/json', { 'Content-Disposition': 'attachment; filename="' + name + '"' });
    }
    if (p === '/api/log.csv') {
      if (!store.eventId) return send(res, 404, { error: 'no event' });
      const start = store.state.sessions.race ? store.state.sessions.race.startTs : null;
      const rows = [['seq', 'iso_time', 'race_time_s', 'type', 'by', 'payload']].concat(store.events.map(e =>
        [e.seq, new Date(e.ts).toISOString(), start ? ((e.ts - start) / 1000).toFixed(1) : '', e.type, e.by || '', JSON.stringify(e.payload)]));
      return send(res, 200, rows.map(r => r.map(csvEscape).join(',')).join('\r\n'), 'text/csv', { 'Content-Disposition': 'attachment; filename="' + store.eventId + '_log.csv"' });
    }
    if (req.method === 'POST') {
      if (!eng) return send(res, 403, { error: 'View-only device: changes are only accepted from the pit wall laptop' });
      const body = await readBody(req);
      if (p === '/api/events') {
        if (!body.config || !body.config.rules) return send(res, 400, { error: 'config with rules required' });
        if (body.saveCar && body.config.car) store.saveCar(body.config.car);
        const id = store.create(body.config, []);
        if (body.shifts) store.append('crew.shiftsAll', { shifts: body.shifts }, 'engineer');
        resetAlertKeys(); configureDevices(); broadcast({ t: 'reset' });
        return send(res, 200, { id });
      }
      if (p === '/api/events/activate') { store.open(body.id); resetAlertKeys(); configureDevices(); broadcast({ t: 'reset' }); return send(res, 200, { ok: true }); }
      if (p === '/api/events/close') { store.close(); configureDevices(); broadcast({ t: 'reset' }); return send(res, 200, { ok: true }); }
      if (p === '/api/import') { const id = store.importBundle(body); resetAlertKeys(); configureDevices(); broadcast({ t: 'reset' }); return send(res, 200, { id }); }
      if (p === '/api/cars') { store.saveCar(body.car); return send(res, 200, { ok: true }); }
      if (p === '/api/branding/logo') {
        if (body.reset) {
          for (const e2 of ['png', 'svg', 'jpg']) { try { fs.unlinkSync(path.join(DATA, 'branding', 'logo.' + e2)); } catch (e) { /* none */ } }
          broadcast({ t: 'logo' }); return send(res, 200, { ok: true });
        }
        const m = /^data:image\/(png|svg\+xml|jpeg);base64,(.+)$/.exec(body.dataUrl || '');
        if (!m) return send(res, 400, { error: 'PNG, SVG or JPG data URL required' });
        const ext = { png: 'png', 'svg+xml': 'svg', jpeg: 'jpg' }[m[1]];
        for (const e2 of ['png', 'svg', 'jpg']) { try { fs.unlinkSync(path.join(DATA, 'branding', 'logo.' + e2)); } catch (e) { /* none */ } }
        fs.writeFileSync(path.join(DATA, 'branding', 'logo.' + ext), Buffer.from(m[2], 'base64'));
        broadcast({ t: 'logo' });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'unknown endpoint' });
    }
    // static
    let rel = p === '/' ? '/index.html' : p;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

// ------------------------------------------------------------------ WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const role = isEngineer(req) ? 'engineer' : 'viewer';
  ws.send(JSON.stringify({ t: 'init', role, meta: meta(req), eventId: store.eventId, config0: store.config0, events: store.events, devices: devices(), map: pltd.map, now: Date.now() }));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.t !== 'action') return;
    if (role !== 'engineer') return ws.send(JSON.stringify({ t: 'error', msg: 'View-only device - changes are made on the pit wall laptop' }));
    if (!store.eventId) return ws.send(JSON.stringify({ t: 'error', msg: 'No active race weekend' }));
    if (!ACTIONS.has(m.type)) return ws.send(JSON.stringify({ t: 'error', msg: 'Unknown action ' + m.type }));
    const p = m.payload || {};
    if (m.type === 'gate.cmd') return gateCmd(p, ws);
    if (m.type === 'pitmsg.send') {
      p.text = String(p.text || '').toUpperCase().slice(0, 16);
      if (!p.text) return;
      const ok = p.kind === 'flag' ? pltd.send({ t: 'pitflag', name: p.text, on: !!p.on }) : pltd.pitMessage(p.text, p.pri);
      p.delivered = ok;
      if (!ok) ws.send(JSON.stringify({ t: 'error', msg: 'PLTD not connected - message logged but not delivered' }));
    }
    append(m.type, p, 'engineer');
    if (m.type === 'flag.set') pltd.setFlag(p.flag);
    if (m.type === 'setup.update' && p.patch && p.patch.devices) configureDevices();
    if (m.type === 'setup.update' && p.saveCar && store.state.config.car) store.saveCar(store.state.config.car);
  });
});

// ------------------------------------------------------------------ gate buttons (the engineer is the gate controller)
// With the PLTD connected the geofences drive the car state and the buttons confirm the steps.
// With the PLTD offline the buttons also set the car state, so the stop timers still work.
function gateCmd(p, ws) {
  const st = store.state, pltdOn = pltd.snapshot().status === 'connected';
  if (!st.activeSessionId) return ws.send(JSON.stringify({ t: 'error', msg: 'No session running' }));
  if (p.gate === 'pitin') {
    if (!st.openStopId) append('carstate', { cs: 'PIT ENTRY' }, 'engineer', 'manual');
    const g = E.derive(store.state, Date.now()).gates;
    if (g && !store.state.gates[g.stop.id + ':pitin']) append('gate.ack', { stopId: g.stop.id, gate: 'pitin', plan: g.planned }, 'engineer');
  } else if (p.gate === 'driver') {
    append('gate.ack', { stopId: p.stopId, gate: 'driver', driverIn: p.driverIn || null }, 'engineer');
  } else if (p.gate === 'fuelstart') {
    if (st.carState.current !== 'FUELLING') append('carstate', { cs: 'FUELLING' }, 'engineer', 'manual');
  } else if (p.gate === 'fuel') {
    append('stop.service', Object.assign({}, p.service || {}, { stopId: p.stopId }), 'engineer');
    if (!pltdOn && store.state.carState.current === 'FUELLING') append('carstate', { cs: 'PITS' }, 'engineer', 'manual');
  } else if (p.gate === 'pitout') {
    append('gate.ack', { stopId: p.stopId, gate: 'pitout' }, 'engineer');
    if ((!pltdOn || p.force) && store.state.openStopId) append('carstate', { cs: 'PIT EXIT' }, 'engineer', 'manual');
  }
}

// ------------------------------------------------------------------ boot
if (store.settings.lastEventId) {
  try { store.open(store.settings.lastEventId); console.log('Resumed race weekend: ' + store.config0.name + ' (' + store.events.length + ' events)'); }
  catch (e) { console.warn('Could not resume last event: ' + e.message); store.close(); }
}
resetAlertKeys(); configureDevices();
server.listen(PORT, '0.0.0.0', () => {
  const ips = [...localIPs].filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1');
  console.log('\n  ' + BRAND.product + ' v' + VERSION + ' - ' + BRAND.line);
  console.log('  Engineer (this laptop):  http://localhost:' + PORT);
  ips.forEach(ip => console.log('  View-only devices:       http://' + ip + ':' + PORT));
  console.log('  Data folder:             ' + DATA + '\n');
});
