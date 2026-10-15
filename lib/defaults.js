'use strict';
// Library defaults: tracks, race formats, the Lancer car profile and a config factory.
const path = require('path');
const fs = require('fs');

const RULES_DIR = path.join(__dirname, '..', 'rules');
function loadRules() {
  const out = {};
  for (const f of fs.readdirSync(RULES_DIR)) if (f.endsWith('.json')) {
    const r = JSON.parse(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'));
    out[r.id] = r;
  }
  return out;
}

const COLLIE = JSON.parse(fs.readFileSync(path.join(__dirname, 'tracks', 'collie-long.json'), 'utf8'));
const TRACKS = [
  { id: 'collie-motorplex', name: 'Collie Motorplex (Long)', location: 'Powerhouse Rd, Collie, WA', lapLengthKm: COLLIE.lengthKm, pitLaneS: 60,
    layout: COLLIE.layout + ', ' + COLLIE.lengthKm + ' km, ' + COLLIE.turnsCount + ' turns, ' + COLLIE.direction, outline: COLLIE.outline, turns: COLLIE.turns, sf: COLLIE.sf, sfLine: COLLIE.sfLine, pit: COLLIE.pit, outlineSource: COLLIE.source },
  { id: 'wanneroo', name: 'Motormall Wanneroo Raceway', location: 'Neerabup, WA', lapLengthKm: null, pitLaneS: 60 }
];

const FORMATS = [
  { id: '7h', label: '7 hours', mode: 'time', durationMin: 420 },
  { id: '12h', label: '12 hours', mode: 'time', durationMin: 720 },
  { id: '24h', label: '24 hours', mode: 'time', durationMin: 1440 },
  { id: '36h', label: '36 hours', mode: 'time', durationMin: 2160 },
  { id: '1000km', label: '1000 km', mode: 'distance', distanceKm: 1000 },
  { id: 'custom-time', label: 'Custom (time)', mode: 'time', durationMin: 240 },
  { id: 'custom-laps', label: 'Custom (laps)', mode: 'laps', laps: 100 }
];

const LANCER = {
  id: 'mitsubishi-lancer-2l',
  make: 'Mitsubishi', model: 'Lancer ES/VR-X 2.0 NA', year: '2004-2005',
  tanks: { primaryL: 45, secondaryL: 30, unusableL: 0, secondaryFeeds: 'transfer to primary', confirmed: false },
  fuelProfiles: {
    'default': { greenLph: 18.75, scLph: 11.25 },
    'collie-motorplex': { greenLph: 18.75, scLph: 11.25, note: 'Collie validated baseline' },
    'wanneroo': { greenLph: 17.5, scLph: 10.5, note: 'Wanneroo 7h baseline' }
  },
  refuel: { methodId: 'jerry20', pourLpm: 25, handlingMin: 1 },
  driverChangeS: 30,
  notes: 'Tank sizes from the Wanneroo 7h campaign - confirm at event start.'
};

function uid(prefix) { return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 8); }

function makeConfig(o) {
  o = o || {};
  const rules = loadRules();
  const rulesProfile = rules[o.rulesId || 'beers-v4-2025-02'];
  const fmt = FORMATS.find(f => f.id === (o.formatId || '36h'));
  const track = Object.assign({}, TRACKS.find(t => t.id === (o.trackId || 'collie-motorplex')));
  const car = JSON.parse(JSON.stringify(o.car || LANCER));
  const raceStart = o.raceStart || new Date(Date.now() + 3600e3).toISOString();
  return {
    id: o.id || uid('evt'),
    createdTs: Date.now(),
    name: o.name || (fmt.label + ' - ' + track.name),
    date: o.date || raceStart.slice(0, 10),
    rulesId: rulesProfile.id,
    rules: rulesProfile,
    team: { name: o.teamName || 'Team name', carNumber: o.carNumber || '' },
    track,
    car,
    race: { format: fmt.id, mode: fmt.mode, durationMin: fmt.durationMin || null, distanceKm: fmt.distanceKm || null, laps: fmt.laps || null, expectedLapS: o.expectedLapS || 90 },
    sessions: o.sessions || [
      { id: 'prac', type: 'practice', name: 'Practice', plannedStart: null, durationMin: 60 },
      { id: 'quali', type: 'quali', name: 'Qualifying', plannedStart: null, durationMin: 20 },
      { id: 'race', type: 'race', name: 'Race', plannedStart: raceStart, durationMin: fmt.durationMin || null }
    ],
    members: o.members || [],
    driverOrder: o.driverOrder || (o.members || []).filter(m => m.driver).map(m => m.id),
    tyres: { newDepthMm: 7, minDepthMm: 1.6, sets: o.tyreSets || [1, 2, 3, 4].map(n => ({ id: 'T' + n, name: 'Set ' + n })), startSetId: 'T1' },
    crewPolicy: { dutyLimitH: 7, minDriverRestH: fmt.durationMin >= 1440 ? 2 : 0, prepAlertMin: [30, 15] },
    strategy: { reserveL: 10, startFuelL: null, fillToBrim: true, driverChangeMode: 'max-stint', stintSafetyMin: 3, rGreen: 1.05, rSlow: 1.35, scExpectMin: 6 },
    ui: { clock24: true },
    devices: {
      pltd: { enabled: true, host: '192.168.0.41' },
      bttm: { enabled: true, host: '192.168.0.40', pollMs: 1000 },
      udp: { enabled: true, port: 47800 }
    }
  };
}

module.exports = { COLLIE, loadRules, TRACKS, FORMATS, LANCER, makeConfig, uid };
