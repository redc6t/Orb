'use strict';
// Builds a demo weekend so every panel has data:
//   BEERS 36h at Collie, team Mitsukitty, Lancer, 6 drivers + 2 engineers, practice done, race running for 6 h.
//   node tools/demo.js [--hours 6]   then   npm start   and   npm run sim
// Devices point at the local simulator (PLTD 127.0.0.1:8081, BTTM 127.0.0.1:8082).
const path = require('path');
const fs = require('fs');
const Store = require('../lib/store');
const D = require('../lib/defaults');
const R = require('../public/js/shared/reducer.js');
const E = require('../public/js/shared/engine.js');
const { generate } = require('./racegen');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const HOURS = +arg('hours', 6);
const DATA = process.env.PITWALL_DATA || path.join(__dirname, '..', 'data');
const store = new Store(DATA);

// Team Mitsukitty. Fuel operator = fire attendant + jerry can holder (refueller) + refueller assistant.
// Radio duty = Raceceiver relay, lap time duty = timing.
const FUEL = ['refueller', 'assistant', 'fire'];
const members = [
  { id: 'd1', name: 'Mal', driver: true, roles: ['driver', 'mechanic', 'refueller', 'assistant', 'cutoff', 'pump', 'fire', 'raceceiver', 'engineer', 'timing'] },   // owner: every role
  { id: 'd2', name: 'Tanna', driver: true, roles: ['driver', 'mechanic'].concat(FUEL, ['raceceiver', 'timing']) },
  { id: 'd3', name: 'Pat', driver: true, roles: ['driver', 'mechanic'].concat(FUEL, ['raceceiver', 'timing']) },
  { id: 'd4', name: 'Jared', driver: true, roles: ['driver', 'mechanic'].concat(FUEL, ['raceceiver', 'timing']) },
  { id: 'd5', name: 'Driver4', driver: true, roles: ['driver'].concat(FUEL) },
  { id: 'd6', name: 'Driver5', driver: true, roles: ['driver'].concat(FUEL) },
  { id: 'e1', name: 'Pietro', driver: false, roles: ['mechanic', 'timing', 'raceceiver', 'engineer'] },
  { id: 'e2', name: 'Rhys', driver: false, roles: ['mechanic', 'timing', 'raceceiver', 'engineer'] }
];
const now = Date.now();
const raceStart = now - HOURS * 3600e3;
const pracStart = raceStart - 3 * 3600e3;
const cfg = D.makeConfig({ id: 'demo-collie-36h', name: 'DEMO - BEERS 36h Collie', rulesId: 'beers-v4-2025-02', formatId: '36h', trackId: 'collie-motorplex',
  members, teamName: 'Mitsukitty', raceStart: new Date(raceStart).toISOString(), expectedLapS: 92 });
cfg.car.tanks.confirmed = true;
cfg.sessions[0].plannedStart = new Date(pracStart).toISOString();
cfg.sessions[1].plannedStart = new Date(pracStart + 90 * 60e3).toISOString();
cfg.crewPolicy.shiftH = 6;
cfg.devices = { pltd: { enabled: true, host: '127.0.0.1:8081' }, bttm: { enabled: true, host: '127.0.0.1:8082', pollMs: 1000 }, udp: { enabled: true, port: 47800 } };

// --- practice: 12 laps, a fuel check, then the race generated closed-loop by the engine
const events = [];
let seq = 0;
const push = (ts, type, payload, by) => { events.push({ seq: ++seq, ts: Math.round(ts), type, payload, by: by || 'engineer' }); };
push(pracStart - 600e3, 'note', { text: 'Demo weekend generated' });
push(pracStart, 'session.start', { sessionId: 'prac', startFuelL: 40, driverId: 'd1', tyreSetId: 'T1' });
let t = pracStart;
for (let i = 1; i <= 12; i++) { t += (93 + Math.random() * 3) * 1000; push(t, 'lap', { n: i, ms: Math.round((93 + Math.random() * 3) * 1000), pitted: false }, 'pltd'); }
push(t + 60e3, 'session.end', { sessionId: 'prac' });
push(t + 5 * 60e3, 'fuel.check', { litres: 34, weight: 0.5, note: 'after practice' });
push(t + 6 * 60e3, 'tyre.measure', { setId: 'T1', depths: [6.9, 6.9, 7.0, 7.0], note: 'after practice' });

const g = generate(cfg, { startTs: raceStart, untilTs: now - 20e3, baseLapS: 92, trueLph: 19.6, seed: 5, scEveryH: 2.5 });
let raceEvents = g.events;
// renumber after practice
for (const e of raceEvents) { e.seq = ++seq; e.by = e.by === 'sim' ? 'engineer' : e.by; events.push(e); }

// --- sprinkle realistic manual events into the race
const s = R.reduce(cfg, events);
const at = h => raceStart + h * 3600e3;
const extra = [
  [at(0.6), 'pitmsg.send', { text: 'PUSH', pri: 1, delivered: true }],
  [at(1.4), 'issue.add', { cat: 'brakes', sev: 'warn', text: 'Driver reports long brake pedal into T1', nextStop: true, src: 'manual' }],
  [at(2.2), 'crew.status', { memberId: 'e2', status: 'resting', reason: 'Rhys off the wall for a 2 h break' }],
  [at(2.9), 'issue.add', { cat: 'body', sev: 'info', text: 'Rear bumper tape lifting', nextStop: false, src: 'manual' }],
  [at(3.3), 'penalty.add', { kind: 'Black flag warning', minutes: 0, driverId: s.drivers.stints.length > 2 ? s.drivers.stints[2].driverId : 'd3', reason: 'Two wheels off at T4', blackFlag: true }],
  [at(4.2), 'crew.status', { memberId: 'e2', status: 'auto', reason: '' }],
  [at(4.8), 'issue.add', { cat: 'engine', sev: 'warn', text: 'Check oil level at next fuel stop', nextStop: true, src: 'manual' }]
];
extra.forEach(x => { if (x[0] < now) push(x[0], x[1], x[2]); });
events.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
events.forEach((e, i) => { e.seq = i + 1; });

// --- crew shifts: the same draft as the Generate schedule button on the Team tab (6 h crew groups)
const shifts = E.draftShifts(R.reduce(cfg, events), now, 6);
events.unshift({ seq: 0, ts: pracStart - 900e3, type: 'crew.shiftsAll', payload: { shifts }, by: 'engineer' });
events.forEach((e, i) => { e.seq = i + 1; });

// Plans A-F, anchored to the demo's "now"
{
  const s3 = R.reduce(cfg, events);
  events.push({ seq: events.length + 1, ts: now - 5000, type: 'scenario.init', payload: { plans: E.scenarioTemplates(s3, now - 5000) }, by: 'engineer' });
}

// replace previous demo
const dir = path.join(DATA, 'events', cfg.id);
if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
store.create(cfg, events);
const final = R.reduce(cfg, events);
const lastLap = final.laps.filter(l => l.sessionId === 'race').slice(-1)[0];
fs.writeFileSync(path.join(DATA, 'demo.json'), JSON.stringify({ startLap: lastLap ? lastLap.n : 0, lapS: 92, fuelMin: 8 }, null, 2));
const dd = E.derive(final, now);
console.log('Demo weekend created: ' + cfg.name);
console.log('  events ' + events.length + ', race laps ' + (lastLap ? lastLap.n : 0) + ', stops ' + dd.stops.list.length + ', fuel est ' + dd.fuel.nowL.toFixed(1) + ' L, learned ' + dd.fuel.model.G.toFixed(2) + ' L/h');
console.log('  call: ' + dd.call.title + ' - ' + dd.call.detail);
console.log('Next: npm start   (then in a second window)   npm run sim');
