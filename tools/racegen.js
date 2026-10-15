'use strict';
// Closed-loop synthetic race: the generated "team" obeys the engine's calls,
// so this both feeds the demo and exercises the planner end to end.
const R = require('../public/js/shared/reducer.js');
const E = require('../public/js/shared/engine.js');

function rng(seed) { let x = seed || 1; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }

function generate(config, opts) {
  const o = Object.assign({ startTs: Date.now() - 3 * 3600e3, untilTs: Date.now(), baseLapS: 92, trueLph: 19.6, seed: 7, scEveryH: 2.2 }, opts);
  const rnd = rng(o.seed);
  const events = [];
  let seq = 0;
  const s = R.initialState(config);
  const P = E.params(s);
  const emit = (ts, type, payload, src) => { const e = { seq: ++seq, ts: Math.round(ts), type, payload: payload || {}, by: src || 'sim', src: src || null }; events.push(e); R.apply(s, e); return e; };
  const cap = P.capacity;
  let minTrue = cap;
  let t = o.startTs, fuel = cap, lap = 0, pittedNext = false, scUntil = 0, nextSc = o.startTs + o.scEveryH * 3600e3 * (0.6 + rnd() * 0.6);
  emit(t, 'session.start', { sessionId: 'race', startFuelL: cap, driverId: s.drivers.queue[0], tyreSetId: config.tyres.startSetId });
  // a few prior crew shift drafts are created by the UI; here only race events
  while (t < o.untilTs) {
    minTrue = Math.min(minTrue, fuel);
    if (t > nextSc && !scUntil) { scUntil = t + (5 + rnd() * 6) * 60e3; emit(t, 'flag.set', { flag: 'SC' }, 'engineer'); }
    if (scUntil && t > scUntil) { scUntil = 0; nextSc = t + o.scEveryH * 3600e3 * (0.6 + rnd() * 0.8); emit(t, 'flag.set', { flag: 'GREEN' }, 'engineer'); }
    const d = E.derive(s, t);
    const box = (['box', 'opp'].includes(d.call.code) || (d.call.code === 'notify')) && d.nextStop;
    const sc = !!scUntil;
    let ms = (o.baseLapS + (rnd() - 0.5) * 2.2 - Math.min(2, lap * 0.01)) * 1000 * (sc ? 1.55 : 1);
    if (pittedNext) ms += 0; // pit time is accounted below on the lap that contains it
    const stopPlan = box ? d.nextStop : null;
    if (!stopPlan) {
      t += ms; fuel -= (sc ? o.trueLph * 0.6 : o.trueLph) * ms / 3600e3; lap++;
      emit(t, 'lap', { n: lap, ms: Math.round(ms + (pittedNext ? pittedNext : 0)), pitted: !!pittedNext }, 'pltd');
      pittedNext = false;
      continue;
    }
    // in-lap: drive to pit entry (~80% of lap), then the stop
    const inMs = ms * 0.8;
    t += inMs; fuel -= o.trueLph * inMs / 3600e3;
    const lapStart = t - inMs;
    emit(t, 'carstate', { cs: 'PIT ENTRY' }, 'pltd');
    t += 25e3; emit(t, 'carstate', { cs: 'PITS' }, 'pltd');
    const space = cap - fuel;
    let add = 0;
    if (stopPlan.add > 0) {
      add = stopPlan.brim ? space : Math.min(stopPlan.add, space);
      t += 10e3; emit(t, 'carstate', { cs: 'FUELLING' }, 'pltd');
      const fuelMs = Math.max(P.fuelMinMs + 15e3, (add / 25 + 1) * 60e3);
      t += fuelMs;
      fuel += add;
      emit(t, 'carstate', { cs: 'PITS' }, 'pltd');
    } else {
      t += Math.max(P.mandMinMs + 10e3, 40e3);
    }
    const brim = stopPlan.brim || (add > 0 && add >= space - 0.5);
    emit(t, 'stop.service', { fuelAdded: Math.round(add * 10) / 10, brimmed: brim, capacityL: cap, driverIn: stopPlan.driverIn, cans: stopPlan.cans }, 'engineer');
    if (stopPlan.change) t += 30e3;
    t += 20e3; emit(t, 'carstate', { cs: 'PIT EXIT' }, 'pltd');
    t += 3e3; emit(t, 'carstate', { cs: 'RUNNING' }, 'pltd');
    // the rest of the lap after pit exit
    const rest = ms * 0.25; t += rest; fuel -= o.trueLph * rest / 3600e3; lap++;
    emit(t, 'lap', { n: lap, ms: Math.round(t - lapStart), pitted: true }, 'pltd');
  }
  return { events, state: s, trueFuel: fuel, minTrueFuel: minTrue };
}
module.exports = { generate };
