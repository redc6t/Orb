'use strict';
// Fake PLTD + BTTM on this machine so the Pit Wall can be exercised without the car. Track: Collie Motorplex long circuit.
//   node tools/simulate.js [--lap 92] [--fuelmin 8] [--pltd 8081] [--bttm 8082] [--startLap N]
// Point the weekend devices at PLTD 127.0.0.1:8081 and BTTM 127.0.0.1:8082 (the demo does this).
// The simulated driver obeys the pit board: any message containing BOX pits at the end of the lap.
// Raising SAFETY CAR / YELLOW / RED from the Pit Wall slows the car (flags mirror to the PLTD).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
let demo = {}; try { demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'demo.json'), 'utf8')); } catch (e) { /* no demo */ }
const LAP_S = +arg('lap', demo.lapS || 92), FUEL_MIN = +arg('fuelmin', demo.fuelMin || 8);
const PLTD_PORT = +arg('pltd', 8081), BTTM_PORT = +arg('bttm', 8082);

// ------------------------------------------------------------------ car model
const car = { lap: +arg('startLap', demo.startLap || 0), lapStart: Date.now(), cs: 'RUNNING', boxReq: false, pit: null, flags: { yellow: false, sc: false, red: false },
  best: null, lastLap: { n: 0, ms: 0, delta: 0, promoted: false }, curLapMs: LAP_S * 1000, lapHadPit: false };
// pace: flags slow the car at once (not from the next lap); SAVE FUEL / PUSH change the driver's pace until the next stop
car.pace = 0;
function slowFactor() { return car.flags.red ? 2.5 : (car.flags.sc ? 1.6 : (car.flags.yellow ? 1.35 : 1)); }
function newLapTarget() { return (LAP_S + car.pace + (Math.random() - 0.5) * 2.2) * 1000 * slowFactor(); }
// change the current lap's pace without moving the car: keep the lap fraction, rescale the rest of the lap
function repace() {
  if (car.pit) return;
  const now = Date.now(), f = (now - car.posStart) / car.curLapMs, nl = newLapTarget();
  car.posStart = now - f * nl; car.curLapMs = nl;
}
// lap timing runs from the real start/finish crossing (lapStart); the position runs on its own clock (posStart)
function lapDone(now, pitLap) {
  car.lap++;
  const ms = now - car.lapStart;
  if (!pitLap && (car.best == null || ms < car.best)) car.best = ms;
  car.lastLap = { n: car.lap, ms: Math.round(ms), delta: car.best ? Math.round(ms - car.best) : 0, promoted: false };
  console.log(new Date().toLocaleTimeString(), 'lap', car.lap, (ms / 1000).toFixed(1) + 's', pitLap ? '(pit lap - S/F crossed in the pit lane)' : '');
  car.lapStart = now; car.lapHadPit = false;
}

car.curLapMs = newLapTarget(); car.posStart = Date.now();

let wss, msgId = 1;
function wsAll(o) { if (!wss) return; const s = JSON.stringify(o); for (const c of wss.clients) if (c.readyState === 1) c.send(s); }
function setCs(cs) { if (car.cs !== cs) { car.cs = cs; console.log(new Date().toLocaleTimeString(), 'car state', cs); } }

function tick() {
  const now = Date.now(), fr = (now - car.posStart) / car.curLapMs;
  if (car.pit) {
    // the simulated crew follows the Pit Wall: start pouring on FUEL ON, fuel only if planned or recorded, stop fuelling when the engineer
    // presses FUEL STOP COMPLETED, leave when he presses PIT OUT; untouched stops use default timings
    const p = car.pit, t = now - p.t0, gs = pitStatus || {};
    if (p.phase === 'entry') { setCs('PIT ENTRY'); p.laneIdx = LANE_BOX * Math.min(1, t / 25000); if (t >= 25000) { p.phase = 'box'; p.at = now; } }
    else if (p.phase === 'box') {
      setCs('PITS');
      if (now - p.at >= 10000 || (gs.fuelOn && now - p.at >= 3000)) {
        const fuel = gs.fuelOn || (p.forceNoFuel ? false : (gs.fuelDone ? gs.fuelAdded > 0 : (gs.plannedAdd > 0)));
        if (fuel) { p.phase = 'fuel'; p.at = now; p.fuel = true; } else { p.phase = 'post'; p.at = now; p.fuel = false; }
        console.log(new Date().toLocaleTimeString(), fuel ? 'crew fuels the car' : 'no fuel this stop');
      }
    } else if (p.phase === 'fuel') {
      setCs('FUELLING');
      if (now - p.at >= p.fuelMs || gs.fuelDone) { p.phase = 'post'; p.at = now; p.fuelDone = true; }
    } else if (p.phase === 'post') {
      setCs('PITS'); p.fuelDone = true;
      if (gs.pitOut || now - p.at >= (p.fuel ? 10000 : 60000)) { p.phase = 'exit'; p.at = now; p.exitAt = t; p.exitFrom = p.fuel ? LANE_FUEL : LANE_BOX; }
    } else if (p.phase === 'exit') {
      setCs('PIT EXIT');
      p.laneIdx = p.exitFrom + (LANE.length - 1 - p.exitFrom) * Math.min(1, (now - p.at) / 15000);
      if (now - p.at >= 15000) {
        // rejoin at the pit-exit point; the position clock continues from there (no jump, no extra lap)
        setCs('RUNNING'); car.pit = null; car.pace = 0;
        if (!p.sfDone) lapDone(now, true);
        car.curLapMs = newLapTarget(); car.posStart = now - F_EXIT * car.curLapMs;
        return;
      }
    }
    // the pit lane passes the start/finish line: the lap is completed there, in the middle of the stop
    if (!p.sfDone && p.laneIdx != null && p.laneIdx >= LANE_SF && (p.phase === 'entry' || p.phase === 'exit')) { p.sfDone = true; lapDone(now, true); }
    else if (!p.sfDone && LANE_SF <= LANE_BOX && p.phase !== 'entry' && p.phase !== 'exit') { p.sfDone = true; lapDone(now, true); }
  } else if (car.boxReq && fr > F_ENTRY && now - car.boxReqAt > 20000) {
    car.boxReq = false; car.lapHadPit = true;
    car.pit = { t0: now, phase: 'entry', fuelMs: (FUEL_MIN * 60 + 20) * 1000, forceNoFuel: car.wantFuel === false, laneIdx: 0 };
  }
  if (!car.pit && fr >= 1) { lapDone(now, false); car.posStart = now; car.curLapMs = newLapTarget(); }
  const elNow = Date.now() - car.lapStart, frNow = (Date.now() - car.posStart) / car.curLapMs;
  const spd = car.pit ? (car.cs === 'PIT ENTRY' || car.cs === 'PIT EXIT' ? 58 : 0) : (120 + 40 * Math.sin(elNow / 9000)) / slowFactor();
  wsAll({ t: 'live', d: Math.round((Math.random() - 0.5) * 400 + car.pace * 600), v: true, tl: !car.pit, bs: 0, sec: 1 + Math.floor(frNow * 9) % 9,
    lap: car.lap, el: elNow, est: Math.round(car.curLapMs), spd: Math.max(0, spd), cs: car.cs, pit: car.lapHadPit || !!car.pit, br: 2000 });
}

// ------------------------------------------------------------------ simulated track: Collie Motorplex long circuit (2.55 km, anti-clockwise)
// Outline traced from the official layout diagram (lib/tracks/collie-long.json). The pit lane position is simulated:
// a lane on the infield side of the start/finish straight.
const COLLIE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'tracks', 'collie-long.json'), 'utf8'));
const TRACK = COLLIE.outline;                    // [lat, lon], evenly spaced, index 0 = start/finish, racing direction
const LAT0 = TRACK.reduce((a, p) => a + p[0], 0) / TRACK.length, LON0 = TRACK.reduce((a, p) => a + p[1], 0) / TRACK.length;
const MLAT = 1 / 111320, MLON = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const at = f => TRACK[Math.floor(((f % 1) + 1) % 1 * TRACK.length)];
// offset a track point towards the infield by m metres (perpendicular to the local direction)
function inward(f, m) {
  const p = at(f), q = at(f + 0.004);
  let ex = (q[1] - p[1]) / MLON, ny = (q[0] - p[0]) / MLAT; const l = Math.hypot(ex, ny) || 1; ex /= l; ny /= l;
  let nx = -ny, nn = ex;                                              // left normal
  const toC = [(LON0 - p[1]) / MLON, (LAT0 - p[0]) / MLAT];
  if (nx * toC[0] + nn * toC[1] < 0) { nx = -nx; nn = -nn; }          // make it point to the infield
  return [p[0] + nn * m * MLAT, p[1] + nx * m * MLON];
}
// pit geometry from the team mark-ups on satellite imagery (lib/tracks/collie-long.json)
const PIT = COLLIE.pit;
const LANE = PIT.lane;                                     // ordered pit entry -> pit exit
const cen = poly => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
const PITS_C = cen(PIT.pits), FUEL_C = cen(PIT.fuel);
const nearIdx = (arr, q) => { let b = 0, bd = Infinity; arr.forEach((p, i) => { const d = (p[0] - q[0]) ** 2 + ((p[1] - q[1]) * Math.cos(LAT0 * Math.PI / 180)) ** 2; if (d < bd) { bd = d; b = i; } }); return b; };
const LANE_BOX = nearIdx(LANE, PITS_C), LANE_FUEL = nearIdx(LANE, FUEL_C), LANE_SF = nearIdx(LANE, COLLIE.sf);
const F_ENTRY = nearIdx(TRACK, cen(PIT.entry)) / TRACK.length, F_EXIT = nearIdx(TRACK, cen(PIT.exit)) / TRACK.length;
const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
const alongLane = (i0, i1, f) => { const x = i0 + (i1 - i0) * Math.max(0, Math.min(1, f)); const i = Math.floor(x); return lerp(LANE[Math.min(i, LANE.length - 1)], LANE[Math.min(i + 1, LANE.length - 1)], x - i); };
const ZONES = [
  { type: 0, label: 'Pit entry', colour: '#FFA500', v: PIT.entry },
  { type: 1, label: 'Pit exit', colour: '#FFD54F', v: PIT.exit },
  { type: 2, label: 'Pits', colour: '#4fc3f7', v: PIT.pits },
  { type: 3, label: 'Fuel area', colour: '#CE93D8', v: PIT.fuel }
].map(z => ({ type: z.type, label: z.label, colour: z.colour, vertices: z.v.map(v => ({ lat: v[0], lon: v[1] })) }));
function carPos() {
  if (car.pit) {
    const p = car.pit, t = Date.now() - p.t0;
    if (car.cs === 'PIT ENTRY') return alongLane(0, LANE_BOX, t / 25000);              // entry line -> pits
    if (car.cs === 'PITS' && (p.phase === 'box' || (p.phase === 'post' && !p.fuel))) return PITS_C;   // in the pits area
    if (car.cs === 'FUELLING') return FUEL_C;                                           // in the fuel area
    if (car.cs === 'PITS') return LANE[LANE_FUEL];                                      // leaving the fuel area
    if (car.cs === 'PIT EXIT') return alongLane(p.exitFrom != null ? p.exitFrom : LANE_FUEL, LANE.length - 1, (t - (p.exitAt || t)) / 15000);
  }
  return at((Date.now() - car.posStart) / car.curLapMs);
}

// ------------------------------------------------------------------ fake PLTD
const pltd = http.createServer((req, res) => {
  if (req.url.startsWith('/refpath')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(TRACK.map(p => ({ lat: +p[0].toFixed(6), lon: +p[1].toFixed(6) })))); }
  if (req.url.startsWith('/geozones')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ zones: ZONES })); }
  if (req.url.startsWith('/sf/get')) { const p = COLLIE.sf; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ valid: true, lat: p[0], lon: p[1] })); }
  if (req.url.startsWith('/data')) {
    const p = carPos();
    const NSEC = 26, cur = Math.min(NSEC - 1, Math.max(0, Math.floor((Date.now() - car.posStart) / car.curLapMs * NSEC)));
    if (!car.secDelta || car.secLap !== car.lap) { car.secLap = car.lap; car.secDelta = Array.from({ length: NSEC }, () => Math.round((Math.random() - 0.55) * 160)); }
    const sectors = car.secDelta.map((dm, i) => ({ completed: i < cur && !car.pit, delta_ms: dm, cur_time_ms: 0, colour: i < cur && !car.pit ? (dm < -60 ? 3 : dm < 0 ? 1 : 2) : 0 }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ sector_count: NSEC, current_sector: cur, sectors, last_sectors: [], lat: p[0], lon: p[1], gnss_sats: 17, gnss_pdop: 1.1, lap_number: car.lap, lap_elapsed_ms: Date.now() - car.lapStart, best_lap_ms: car.best || 0, car_state: car.cs, speed_kph: 0,
      synth: { lap_m: Math.round(COLLIE.lengthKm * 1000) }, geo_active: 'Collie Motorplex Long (sim)', lap_pitted: car.lapHadPit, last_lap: { n: car.lastLap.n, ms: car.lastLap.ms, delta: car.lastLap.delta, promoted: false, sc: 9 } }));
  }
  if (req.url.startsWith('/pitstate')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(Object.assign({ t: 'flagstate' }, car.flags))); }
  res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('PLTD simulator');
});
wss = new WebSocketServer({ server: pltd, path: '/ws' });
wss.on('connection', ws => {
  console.log('PLTD sim: Pit Wall connected');
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.t === 'pitstate') ws.send(JSON.stringify(Object.assign({ t: 'flagstate' }, car.flags)));
    if (m.t === 'pitflag') {
      const k = /RED/.test(m.name) ? 'red' : /SAFETY/.test(m.name) ? 'sc' : 'yellow';
      car.flags[k] = !!m.on; console.log('flag', m.name, m.on ? 'ON' : 'OFF'); repace();
      wsAll(Object.assign({ t: 'flagstate' }, car.flags));
    }
    if (m.t === 'pitmsg') {
      const id = msgId++;
      console.log('pit board:', m.text);
      wsAll({ t: 'pitshown', id });
      // a repeated BOX keeps the first request's timer, so resending never pushes the stop back a lap
      if (/BOX/.test(m.text)) { if (!car.boxReq) car.boxReqAt = Date.now(); car.boxReq = true; car.wantFuel = !/NO FUEL|DRIVER/.test(m.text); }
      if (/SAVE/.test(m.text)) { car.pace = 1.8; repace(); console.log('driver saves fuel (+1.8 s/lap)'); }
      if (/PUSH/.test(m.text)) { car.pace = -0.6; repace(); console.log('driver pushes (-0.6 s/lap)'); }
      if (/STAY OUT|NORMAL/.test(m.text) && car.pace > 0) { car.pace = 0; repace(); }
      setTimeout(() => wsAll({ t: 'pitack', id, by: 'driver' }), 1500 + Math.random() * 2000);
    }
  });
});
pltd.listen(PLTD_PORT, '127.0.0.1', () => console.log('PLTD sim  ws://127.0.0.1:' + PLTD_PORT + '/ws  (lap ' + LAP_S + ' s, fuel stop ' + FUEL_MIN + ' min, starting lap ' + car.lap + ')'));
setInterval(tick, 100);
let pitStatus = null;
const PITWALL = arg('pitwall', 'http://127.0.0.1:' + (process.env.PORT || 8080));
setInterval(() => {
  if (!car.pit && !car.boxReq) { pitStatus = null; return; }
  http.get(PITWALL + '/api/sim/stop', r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { pitStatus = JSON.parse(b); } catch (e) { /* ignore */ } }); }).on('error', () => {});
}, 1000);

// ------------------------------------------------------------------ fake BTTM
const bt = { brake: [320, 330, 210, 220], tyre: [78, 80, 66, 68], spikeUntil: 0, nextSpike: Date.now() + (6 + Math.random() * 10) * 60000 };
function bttmTick() {
  const moving = !car.pit;
  for (let i = 0; i < 4; i++) {
    const tgtB = moving ? (i < 2 ? 420 : 280) + 140 * Math.sin(Date.now() / 7000 + i) : 120;
    bt.brake[i] += (tgtB - bt.brake[i]) * 0.15 + (Math.random() - 0.5) * 8;
    const tgtT = moving ? (i < 2 ? 84 : 72) : 55;
    bt.tyre[i] += (tgtT - bt.tyre[i]) * 0.05 + (Math.random() - 0.5);
  }
  if (Date.now() > bt.nextSpike && moving) { bt.spikeUntil = Date.now() + 8000; bt.nextSpike = Date.now() + (15 + Math.random() * 20) * 60000; console.log('BTTM sim: FL brake spike'); }
  if (Date.now() < bt.spikeUntil) bt.brake[0] = 735 + Math.random() * 20;
}
setInterval(bttmTick, 500);
const bttm = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url.startsWith('/config')) return res.end(JSON.stringify({ br_t1: 100, br_t2: 300, br_t3: 500, br_t4: 700, ty_t1: 40, ty_t2: 70, ty_t3: 100, ty_t4: 130, pr_t1: 20, pr_t2: 26, pr_t3: 29, pr_t4: 32 }));
  const c = ['fl', 'fr', 'rl', 'rr'], o = { sats: 14, speed: '120.0', lat: '-33.36', lon: '116.15', tpms_trusted: true };
  c.forEach((k, i) => {
    o['br_' + k + '_temp'] = bt.brake[i].toFixed(1); o['ti_' + k + '_temp'] = bt.tyre[i].toFixed(1);
    o['tp_' + k + '_psi'] = (28.5 + (bt.tyre[i] - 70) * 0.06 + (Math.random() - 0.5) * 0.2).toFixed(1); o['tp_' + k + '_tc'] = Math.round(bt.tyre[i] - 20);
  });
  res.end(JSON.stringify(o));
});
bttm.listen(BTTM_PORT, '127.0.0.1', () => console.log('BTTM sim  http://127.0.0.1:' + BTTM_PORT + '/data'));
