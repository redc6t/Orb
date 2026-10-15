'use strict';
const D = require('../lib/defaults');
const E = require('../public/js/shared/engine.js');
const { generate } = require('./racegen');
const fmt = ms => { const m = Math.round(ms / 60000); return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'); };

function members(n) {
  const names = ['Pete', 'Alex', 'Sam', 'Jordan', 'Chris', 'Robin', 'Kim', 'Lee', 'Max', 'Jess'];
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: 'd' + (i + 1), name: names[i], driver: true, roles: ['driver'] });
  out.push({ id: 'c1', name: 'Mech One', driver: false, roles: ['mechanic', 'refueller'] });
  out.push({ id: 'c2', name: 'Mech Two', driver: false, roles: ['mechanic', 'assistant', 'cutoff', 'pump'] });
  out.push({ id: 'c3', name: 'Fire Fi', driver: false, roles: ['fire', 'raceceiver'] });
  return out;
}

function run(label, rulesId, formatId, simH, nDrivers) {
  const start = Date.now() - simH * 3600e3;
  const cfg = D.makeConfig({ rulesId, formatId, trackId: 'collie-motorplex', members: members(nDrivers), raceStart: new Date(start).toISOString(), teamName: 'Test' });
  const pre = E.derive(require('../public/js/shared/reducer.js').initialState(cfg), start - 1000);
  console.log('\n=== ' + label + ' PRE-RACE plan: ' + pre.plan.stops.length + ' stops, ' + pre.plan.fuelStops + ' fuel stops, finish fuel ' + pre.plan.finishFuelL.toFixed(1) + ' L');
  pre.plan.stops.slice(0, 8).forEach(x => console.log('  stop', x.k, '@', fmt(x.ts - start), x.type, 'add', x.add, 'arr', x.fuelArr.toFixed(1), 'stat', Math.round(x.statMs / 1000) + 's', x.change ? (x.driverOut + '->' + x.driverIn) : '', x.window ? 'win ' + fmt(x.window.openTs - start) + '-' + fmt(x.window.closeTs - start) : ''));
  if (pre.plan.warnings.length) console.log('  WARN', pre.plan.warnings);
  const t0 = Date.now();
  const g = generate(cfg, { startTs: start, untilTs: Date.now(), seed: 3 });
  const d = E.derive(g.state, Date.now());
  console.log('  sim ' + simH + 'h: events', g.events.length, 'laps', d.laps.length, 'stops', d.stops.list.length, 'counted', d.stops.counted, '| gen+derive ms', Date.now() - t0);
  console.log('  fuel est', d.fuel.nowL.toFixed(1), 'true', g.trueFuel.toFixed(1), '| model G', d.fuel.model.G.toFixed(2), 'S', d.fuel.model.S.toFixed(2), 'nCal', d.fuel.model.nCal, 'refLap', (d.refLap.ms / 1000).toFixed(1));
  console.log('  call', d.call.title, '-', d.call.detail, '| remaining stops', d.plan.stops.length, 'finish fuel', d.plan.finishFuelL.toFixed(1));
  console.log('  stops:', d.stops.list.map(x => x.id + ':' + x.type + ':' + Math.round(x.laneMs / 1000) + 's' + (x.added ? ':' + x.added + 'L' : '') + (x.fuelOk === false ? ':SHORT' : '')).join(' '));
  console.log('  alerts now:', d.alerts.map(a => a.level + ' ' + a.text).slice(0, 4));
  const dt = Date.now(); for (let i = 0; i < 5; i++) E.derive(g.state, Date.now()); console.log('  derive avg ms', ((Date.now() - dt) / 5).toFixed(1));
}
run('BEERS 36h', 'beers-v4-2025-02', '36h', 30, 6);
run('B4B 7h', 'b4b-2026-03', '7h', 7.2, 4);
// compliance checks on a generated race
(function () {
  const start = Date.now() - 36 * 3600e3;
  for (const [rid, fid] of [['beers-v4-2025-02', '36h'], ['b4b-2026-03', '7h']]) {
    const cfg = D.makeConfig({ rulesId: rid, formatId: fid, members: members(rid.startsWith('b4b') ? 4 : 6), raceStart: new Date(start).toISOString() });
    const g = generate(cfg, { startTs: start, untilTs: start + cfg.race.durationMin * 60e3, seed: 11 });
    const d = E.derive(g.state, start + cfg.race.durationMin * 60e3 - 1000);
    const maxStint = Math.max(...g.state.drivers.stints.map(x => (x.endTs || d.now) - x.startTs)) / 60000;
    const minTrue = g.minTrueFuel;
    console.log('\n## FULL ' + fid + ' ' + rid + ': stops ' + d.stops.list.length + ' (fuel ' + d.stops.list.filter(x => x.added).length + '), counted ' + d.stops.counted + '/' + d.stops.required +
      ', max stint ' + maxStint.toFixed(1) + ' min, fuel est ' + d.fuel.nowL.toFixed(1) + ' true ' + g.trueFuel.toFixed(1) + ', min true ' + minTrue.toFixed(1) + ', G ' + d.fuel.model.G.toFixed(2) + ' S ' + d.fuel.model.S.toFixed(2) + ' nCal ' + d.fuel.model.nCal +
      ', short fuel stops ' + d.stops.list.filter(x => x.fuelOk === false).length + ', laps ' + d.laps.length);
  }
})();
