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
  // Sentinel peaks per lap from their own generator, so the race itself stays the same for a given seed
  const rt = rng((o.seed || 7) * 31 + 1);
  let stintLaps = 0;
  const peaks = sc => {
    stintLaps++;
    const heat = Math.min(1, stintLaps / 40), slow = sc ? 0.6 : 1, r = (a, b) => Math.round(a + rt() * b);
    const br = { fl: r(560, 60), fr: r(545, 60), rl: r(380, 50), rr: r(370, 50) }, ty = { fl: r(86, 6), fr: r(88, 6), rl: r(74, 5), rr: r(75, 5) };
    Object.keys(br).forEach(c => { br[c] = Math.round(br[c] * slow + 40 * heat); ty[c] = Math.round(ty[c] * (sc ? 0.85 : 1) + 6 * heat); });
    if (!sc && rt() < 0.012) br.fl = r(705, 40);   // the odd FL lock-up / brake spike
    return { br, ty };
  };
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
      emit(t, 'lap', { n: lap, ms: Math.round(ms + (pittedNext ? pittedNext : 0)), pitted: !!pittedNext, peaks: peaks(sc) }, 'agile');
      pittedNext = false;
      continue;
    }
    // in-lap: drive to pit entry (~80% of lap), then the stop
    const inMs = ms * 0.8;
    t += inMs; fuel -= o.trueLph * inMs / 3600e3;
    const lapStart = t - inMs;
    emit(t, 'carstate', { cs: 'PIT ENTRY' }, 'agile');
    t += 25e3; emit(t, 'carstate', { cs: 'PITS' }, 'agile');
    const space = cap - fuel;
    let add = 0;
    if (stopPlan.add > 0) {
      add = stopPlan.brim ? space : Math.min(stopPlan.add, space);
      t += 10e3; emit(t, 'carstate', { cs: 'FUELLING' }, 'agile');
      const fuelMs = Math.max(P.fuelMinMs + 15e3, (add / 25 + 1) * 60e3);
      t += fuelMs;
      fuel += add;
      emit(t, 'carstate', { cs: 'PITS' }, 'agile');
    } else {
      t += Math.max(P.mandMinMs + 10e3, 40e3);
    }
    const brim = stopPlan.brim || (add > 0 && add >= space - 0.5);
    emit(t, 'stop.service', { fuelAdded: Math.round(add * 10) / 10, brimmed: brim, capacityL: cap, driverIn: stopPlan.driverIn, cans: stopPlan.cans }, 'engineer');
    if (stopPlan.change) t += 30e3;
    t += 20e3; emit(t, 'carstate', { cs: 'PIT EXIT' }, 'agile');
    t += 3e3; emit(t, 'carstate', { cs: 'RUNNING' }, 'agile');
    // the rest of the lap after pit exit
    const rest = ms * 0.25; t += rest; fuel -= o.trueLph * rest / 3600e3; lap++;
    if (stopPlan.change) stintLaps = 0;
    emit(t, 'lap', { n: lap, ms: Math.round(t - lapStart), pitted: true, peaks: peaks(false) }, 'agile');
  }
  return { events, state: s, trueFuel: fuel, minTrueFuel: minTrue };
}
module.exports = { generate };
