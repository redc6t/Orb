/* Mullaloo Motorsport Engineering Solutions - Pit Wall
 * Strategy engine. Pure function of (state, now, whatIf). No I/O.
 * Units: time in ms (absolute epoch unless named *Ms durations), fuel in litres, rates in L/h.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PWEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN = 60000, HOUR = 3600000;
  var SLOW_FLAGS = { 'YELLOW': 1, 'DOUBLE YELLOW': 1, 'SC': 1, 'FCY': 1 };
  var DUTY = { available: 1, driving: 1, flag: 1 };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function median(a) { if (!a.length) return null; var b = a.slice().sort(function (x, y) { return x - y; }); var m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
  function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }
  function num(v, d) { return (v === null || v === undefined || v === '' || isNaN(+v)) ? d : +v; }

  /* ---------------------------------------------------------------- config */
  function params(s) {
    var c = s.config || {}, car = c.car || {}, r = c.rules || {}, st = c.strategy || {};
    var tanks = car.tanks || {};
    var capacity = num(tanks.primaryL, 45) + num(tanks.secondaryL, 0) - num(tanks.unusableL, 0);
    var trackId = (c.track && c.track.id) || 'default';
    var fp = (car.fuelProfiles && (car.fuelProfiles[trackId] || car.fuelProfiles['default'])) || {};
    var method = null;
    ((r.fuel && r.fuel.methods) || []).forEach(function (m) { if (m.id === (car.refuel && car.refuel.methodId)) method = m; });
    if (!method && r.fuel && r.fuel.methods) method = r.fuel.methods[0];
    var maxPerStop = r.fuel && r.fuel.maxPerStopL != null ? r.fuel.maxPerStopL : (method ? method.maxStoredL : 999);
    if (method && method.maxStoredL != null) maxPerStop = Math.min(maxPerStop, method.maxStoredL);
    return {
      capacity: capacity,
      reserve: num(st.reserveL, 10),
      G0: num(fp.greenLph, 18), S0: num(fp.scLph, num(fp.greenLph, 18) * 0.6),
      rGreen: num(st.rGreen, 1.05), rSlow: num(st.rSlow, 1.35),
      maxPerStop: maxPerStop,
      method: method,
      pourLpm: num(car.refuel && car.refuel.pourLpm, 25),
      fuelHandlingMin: num(car.refuel && car.refuel.handlingMin, 1),
      fuelMinMs: num(r.fuel && r.fuel.minFuelStopMin, 5) * MIN,
      mandCount: num(r.stops && r.stops.mandatoryCount, 0),
      mandMinMs: num(r.stops && r.stops.mandatoryMinMin, 0) * MIN,
      nonFuelMinMs: num(r.stops && r.stops.nonFuelMinMin, 0) * MIN,
      maxStintMs: num(st.maxStintMin, num(r.drivers && r.drivers.maxStintMin, 120)) * MIN,
      stintSafetyMs: num(st.stintSafetyMin, 3) * MIN,
      pitLaneMs: num(c.track && c.track.pitLaneS, 60) * 1000,
      driverChangeMs: num(car.driverChangeS, 30) * 1000,
      refuelAllowed: (r.fuel && r.fuel.refuelAllowed) || { GREEN: true },
      swapDuringFuel: !!(r.fuel && r.fuel.driverSwapDuringFuel),
      changeMode: st.driverChangeMode || 'max-stint',
      fillToBrim: st.fillToBrim !== false,
      scExpectMs: num(st.scExpectMin, 6) * MIN,
      dutyLimitMs: num(c.crewPolicy && c.crewPolicy.dutyLimitH, 7) * HOUR,
      minRestMs: num(c.crewPolicy && c.crewPolicy.minDriverRestH, 0) * HOUR,
      prepMins: (c.crewPolicy && c.crewPolicy.prepAlertMin) || [30, 15],
      expectedLapMs: num(c.race && c.race.expectedLapS, 90) * 1000,
      lapKm: num(c.track && c.track.lapLengthKm, null),
      stopsOnRed: !!(r.clock && r.clock.stopsOnRed),
      fuelTiming: (r.fuel && r.fuel.timingBasis) || 'zone',
      newDepth: num(c.tyres && c.tyres.newDepthMm, 7), minDepth: num(c.tyres && c.tyres.minDepthMm, 1.6)
    };
  }

  /* ------------------------------------------------------------- sessions */
  function sessionDef(s, id) {
    var list = (s.config && s.config.sessions) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function currentSessionId(s) {
    if (s.activeSessionId) return s.activeSessionId;
    var list = (s.config && s.config.sessions) || [];
    for (var i = 0; i < list.length; i++) if (!s.sessions[list[i].id]) return list[i].id;      // next not started
    return list.length ? list[list.length - 1].id : null;
  }

  function redPausedMs(s, t0, t1) {
    var h = s.flag.history, sum = 0;
    for (var i = 0; i < h.length; i++) {
      if (h[i].flag !== 'RED') continue;
      var end = i + 1 < h.length ? h[i + 1].ts : t1;
      sum += overlap(h[i].ts, end, t0, t1);
    }
    return sum;
  }

  function raceSessionId(s) {
    var list = (s.config && s.config.sessions) || [];
    for (var i = 0; i < list.length; i++) if (list[i].type === 'race') return list[i].id;
    return null;
  }

  function sessionInfo(s, now, P, forceId) {
    var id = forceId || currentSessionId(s);
    var def = sessionDef(s, id) || { id: id, type: 'race', name: 'Race', durationMin: 420 };
    var live = s.sessions[id];
    var race = s.config.race || {};
    var isRace = def.type === 'race';
    var plannedStart = def.plannedStart ? Date.parse(def.plannedStart) : null;
    var startTs = live ? live.startTs : (plannedStart || now);
    var endTs = live ? live.endTs : null;
    var tnow = endTs || now;
    var paused = live && P.stopsOnRed ? redPausedMs(s, startTs, tnow) : 0;
    var elapsed = live ? Math.max(0, tnow - startTs - paused) : 0;
    var mode = isRace ? (race.mode || 'time') : 'time';
    var durationMs = (isRace ? num(race.durationMin, def.durationMin || 420) : num(def.durationMin, 60)) * MIN;
    return { id: id, def: def, type: def.type, name: def.name, isRace: isRace, mode: mode,
      started: !!live, finished: !!(live && live.endTs), running: !!(live && !live.endTs),
      startTs: startTs, plannedStart: plannedStart, elapsedMs: elapsed, pausedMs: paused, durationMs: durationMs,
      distanceKm: num(race.distanceKm, null), totalLaps: num(race.laps, null) };
  }

  /* ------------------------------------------------------- laps & pace */
  function sessionLaps(s, sid) { return s.laps.filter(function (l) { return l.sessionId === sid; }); }

  function refLapMs(laps, P) {
    var clean = laps.filter(function (l) { return !l.pitted && l.flag === 'GREEN' && l.ms > 10000; }).map(function (l) { return l.ms; });
    if (clean.length < 2) return { ms: P.expectedLapMs, src: 'setup' };
    var m = median(clean);
    var f = clean.filter(function (x) { return x > 0.85 * m && x < 1.3 * m; }).slice(-15);
    return { ms: median(f) || m, src: 'live' };
  }

  function beta(r, P) { return clamp((r - P.rGreen) / (P.rSlow - P.rGreen), 0, 1); }

  function classifyLap(l, ref, P) {
    if (l.pitted) return 'pit';
    var r = l.ms / ref;
    if (SLOW_FLAGS[l.flag] || r > P.rSlow) return 'sc';
    if (r > P.rGreen) return 'slow';
    if (r < 0.985) return 'push';
    return 'green';
  }

  /* ------------------------------------------------- burn integration */
  function stationaryIntervals(s, now) {
    var out = [];
    s.stops.forEach(function (st) { if (st.statInTs && !st.voided) out.push([st.statInTs, st.statOutTs || now]); });
    return out;
  }
  function statOverlap(stat, a, b) { var sum = 0; for (var i = 0; i < stat.length; i++) sum += overlap(stat[i][0], stat[i][1], a, b); return sum; }

  function flagAt(s, t) {
    var h = s.flag.history, f = 'GREEN', since = null;
    for (var i = 0; i < h.length; i++) { if (h[i].ts <= t) { f = h[i].flag; since = h[i].ts; } else break; }
    return { flag: f, since: since };
  }

  // Build classified time segments for every session, so burn over any window is a sum.
  function buildSegments(s, now, P, refBySession) {
    var segs = [];
    var stat = stationaryIntervals(s, now);
    Object.keys(s.sessions).forEach(function (sid) {
      var ses = s.sessions[sid];
      var end = ses.endTs || now;
      var ref = refBySession[sid] || P.expectedLapMs;
      var cursor = ses.startTs;
      var laps = sessionLaps(s, sid).sort(function (a, b) { return a.ts - b.ts; });
      var pushFlagSegs = function (a, b) {
        if (b <= a) return;
        var h = s.flag.history, cur = flagAt(s, a), t = a;
        for (var i = 0; i < h.length; i++) {
          if (h[i].ts <= a) continue;
          if (h[i].ts >= b) break;
          segs.push(mkFlagSeg(t, h[i].ts, cur));
          cur = { flag: h[i].flag, since: h[i].ts }; t = h[i].ts;
        }
        segs.push(mkFlagSeg(t, b, cur));
      };
      var mkFlagSeg = function (a, b, f) {
        var zeroFrom = f.flag === 'RED' ? (f.since || a) + 2 * MIN : Infinity;
        return { t0: a, t1: b, beta: f.flag === 'GREEN' ? 0 : 1, zeroFrom: zeroFrom, kind: 'gap' };
      };
      laps.forEach(function (l) {
        var ls = Math.max(cursor, l.ts - l.ms), le = Math.min(l.ts, end);
        if (le <= ls) return;
        if (ls > cursor) pushFlagSegs(cursor, ls);
        var moving = (le - ls) - statOverlap(stat, ls, le);
        var b = moving > 0 ? beta(moving / ref, P) : 1;
        segs.push({ t0: ls, t1: le, beta: b, zeroFrom: Infinity, kind: 'lap' });
        cursor = le;
      });
      pushFlagSegs(cursor, end);
    });
    segs.sort(function (a, b) { return a.t0 - b.t0; });
    return { segs: segs, stat: stat };
  }

  function burnHours(B, a, b) {
    var g = 0, sl = 0;
    if (b <= a) return { g: 0, s: 0 };
    for (var i = 0; i < B.segs.length; i++) {
      var sg = B.segs[i];
      if (sg.t1 <= a) continue;
      if (sg.t0 >= b) break;
      var x0 = Math.max(a, sg.t0), x1 = Math.min(b, sg.t1);
      if (sg.zeroFrom < x1) x1 = Math.max(x0, sg.zeroFrom);
      var mv = (x1 - x0) - statOverlap(B.stat, x0, x1);
      if (mv <= 0) continue;
      g += (1 - sg.beta) * mv / HOUR; sl += sg.beta * mv / HOUR;
    }
    return { g: g, s: sl };
  }

  /* --------------------------------------------- fuel model + learning */
  function calibrationPeriods(s, B) {
    var A = s.fuel.anchors.slice().sort(function (a, b) { return a.ts - b.ts; });
    var out = [];
    for (var i = 1; i < A.length; i++) {
      var a = A[i - 1], b = A[i];
      if (a.sessionId !== b.sessionId) continue;
      var added = 0;
      s.fuel.refuels.forEach(function (r) { if (r.ts > a.ts && r.ts <= b.ts) added += r.litres; });
      var M = a.after + added - b.before;
      var h = burnHours(B, a.ts, b.ts);
      if (h.g + h.s < 0.15 || M <= 0) continue;
      out.push({ t0: a.ts, t1: b.ts, M: M, g: h.g, s: h.s, w: Math.min(a.w, b.w), kind: b.kind, stopId: b.stopId || null });
    }
    return out;
  }

  function fit(periods, P) {
    var lam = 0.6;
    var a11 = lam, a12 = 0, a22 = lam, b1 = lam * P.G0, b2 = lam * P.S0;
    periods.forEach(function (p) {
      a11 += p.w * p.g * p.g; a12 += p.w * p.g * p.s; a22 += p.w * p.s * p.s;
      b1 += p.w * p.M * p.g; b2 += p.w * p.M * p.s;
    });
    var det = a11 * a22 - a12 * a12;
    var G = (b1 * a22 - b2 * a12) / det, S = (a11 * b2 - a12 * b1) / det;
    G = clamp(G, 0.6 * P.G0, 1.6 * P.G0);
    S = clamp(S, 0.4 * P.S0, Math.min(1.6 * P.S0, G));
    return { G: G, S: S };
  }

  function fuelModel(s, now, P, B) {
    var periods = calibrationPeriods(s, B);
    var m = fit(periods, P);
    var dev = null;
    if (periods.length) {
      var prior = fit(periods.slice(0, -1), P), last = periods[periods.length - 1];
      var pred = prior.G * last.g + prior.S * last.s;
      dev = { pct: (last.M - pred) / pred * 100, measured: last.M, predicted: pred, ts: last.t1, stopId: last.stopId };
    }
    var A = s.fuel.anchors.filter(function (a) { return a.ts <= now; }).sort(function (a, b) { return a.ts - b.ts; });
    var anchor = A[A.length - 1] || null;
    var nowL = null, sinceL = 0, unc = null;
    if (anchor) {
      var added = 0;
      s.fuel.refuels.forEach(function (r) { if (r.ts > anchor.ts && r.ts <= now) added += r.litres; });
      var h = burnHours(B, anchor.ts, now);
      sinceL = m.G * h.g + m.S * h.s;
      nowL = anchor.after + added - sinceL;
      var pctU = Math.max(0.03, 0.09 - 0.015 * Math.min(periods.length, 4));
      unc = sinceL * pctU + (anchor.kind === 'check' ? 3 : 0);
    }
    return { G: m.G, S: m.S, G0: P.G0, S0: P.S0, nCal: periods.length, periods: periods, deviation: dev,
      anchor: anchor, nowL: nowL, burnedSinceAnchorL: sinceL, uncertaintyL: unc };
  }

  /* --------------------------------------------------------- crew */
  function memberById(s, id) {
    var ms = (s.config && s.config.members) || [];
    for (var i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i];
    return null;
  }
  function memberName(s, id) { var m = memberById(s, id); return m ? m.name : (id || '-'); }

  function shiftAt(s, id, t) {
    var bl = s.crew.shifts[id] || [];
    for (var i = 0; i < bl.length; i++) if (bl[i].startTs <= t && t < bl[i].endTs) return bl[i];
    return null;
  }

  // when this member last handed the car over at a pit stop (null if they did not)
  function steppedOutTs(s, id) {
    var d = s.drivers, i, st;
    if (d.activeId === id) {
      // driver change confirmed while the stop is still open: he is already out of the car
      if (!s.openStopId || !d.pendingIn || d.pendingIn === id) return null;
      for (i = s.stops.length - 1; i >= 0; i--) if (s.stops[i].id === s.openStopId) return s.stops[i].statInTs || s.stops[i].inTs;
      return null;
    }
    var last = null; d.stints.forEach(function (x) { if (x.driverId === id && x.endTs != null) last = x; });
    if (!last) return null;
    for (i = s.stops.length - 1; i >= 0; i--) {
      st = s.stops[i];
      if (!st.voided && st.driverOut === id && (st.statInTs || st.inTs) === last.endTs) return last.endTs;
    }
    return null;
  }

  function memberStatus(s, m, now, carOnTrack) {
    var ov = s.crew.status[m.id];
    var st = 'available', reason = '', src = 'default';
    var sh = shiftAt(s, m.id, now);
    if (sh) { st = sh.kind === 'duty' ? 'available' : sh.kind; reason = sh.note || ''; src = 'shift'; }
    if (ov && (!sh || ov.since >= sh.startTs)) { st = ov.status; reason = ov.reason; src = 'manual'; }
    // stepped out of the car at a stop: straight to rest, until a later shift block or a manual status
    var outTs = steppedOutTs(s, m.id);
    if (outTs != null && outTs <= now && !(ov && ov.since >= outTs) && !(sh && sh.startTs > outTs)) { st = 'resting'; reason = 'stepped out of the car'; src = 'car'; }
    if (s.drivers.activeId === m.id && carOnTrack) { st = 'driving'; src = 'car'; }
    return { status: st, reason: reason, src: src };
  }

  function dutyStart(s, m, now, firstStart) {
    var cands = [firstStart || now];
    var ov = s.crew.status[m.id];
    if (ov && DUTY[ov.status] && ov.since <= now) cands.push(ov.since);
    (s.crew.shifts[m.id] || []).forEach(function (b) { if ((b.kind === 'resting' || b.kind === 'sleeping' || b.kind === 'offline') && b.endTs <= now) cands.push(b.endTs); });
    // rest periods logged as manual status changes
    return Math.max.apply(null, cands.filter(function (x) { return x <= now; }));
  }

  /* ------------------------------------------------------- planner */
  function makeRate(P, model, whatIf, now, flagNow) {
    var G = model.G, S = model.S;
    if (whatIf && whatIf.lapDeltaS) {
      var r = 1 + (whatIf.lapDeltaS * 1000) / (whatIf.refLapMs || P.expectedLapMs);
      var b = beta(r, P);
      G = G * (1 - b) + S * b;
    }
    if (whatIf && whatIf.greenMult) G = G * whatIf.greenMult;
    var windows = [];
    if (SLOW_FLAGS[flagNow]) windows.push([now, now + P.scExpectMs, S]);
    ((whatIf && whatIf.scWindows) || []).forEach(function (w) { windows.push([w[0], w[1], S]); });
    ((whatIf && whatIf.redWindows) || []).forEach(function (w) { windows.push([w[0], w[1], 0]); });
    if (whatIf && whatIf.scMin > 0) {
      var scRate = whatIf.scPct != null ? model.G * (1 - whatIf.scPct / 100) : S;
      windows.push([now, now + whatIf.scMin * MIN, scRate]);
    }
    function rateAt(t) { for (var i = windows.length - 1; i >= 0; i--) if (t >= windows[i][0] && t < windows[i][1]) return windows[i][2]; return G; }
    function burn(t0, t1) {
      if (t1 <= t0) return 0;
      var pts = [t0, t1];
      windows.forEach(function (w) { if (w[0] > t0 && w[0] < t1) pts.push(w[0]); if (w[1] > t0 && w[1] < t1) pts.push(w[1]); });
      pts.sort(function (a, b) { return a - b; });
      var L = 0;
      for (var i = 1; i < pts.length; i++) L += rateAt((pts[i - 1] + pts[i]) / 2) * (pts[i] - pts[i - 1]) / HOUR;
      return L;
    }
    function timeToBurn(t0, litres) {
      if (litres <= 0) return t0;
      var t = t0, left = litres;
      for (var guard = 0; guard < 50; guard++) {
        var next = Infinity;
        windows.forEach(function (w) { if (w[0] > t && w[0] < next) next = w[0]; if (w[1] > t && w[1] < next) next = w[1]; });
        var r = rateAt(t + 1);
        var dt = left / r * HOUR;
        if (t + dt <= next) return t + dt;
        left -= r * (next - t) / HOUR; t = next;
      }
      return t;
    }
    return { G: G, burn: burn, timeToBurn: timeToBurn, rateAt: rateAt };
  }

  function stationaryFor(P, add, driverChange, needCount) {
    if (add > 0) {
      var fuelMs = Math.max(P.fuelMinMs, (add / P.pourLpm + P.fuelHandlingMin) * MIN);
      var swap = driverChange && !P.swapDuringFuel ? P.driverChangeMs : 0;
      return Math.max(fuelMs + swap, needCount ? P.mandMinMs : 0);
    }
    var base = driverChange ? P.driverChangeMs : 20000;
    return Math.max(base, needCount ? Math.max(P.mandMinMs, P.nonFuelMinMs) : 0);
  }

  function nextDriver(s, P, fromId, atTs, used, now, excl) {
    var q = (s.drivers.queue || []).filter(function (id) { var m = memberById(s, id); return m && !(excl && excl.indexOf(id) >= 0); });
    if (!q.length) return fromId;
    var idx = q.indexOf(fromId);
    for (var k = 1; k <= q.length; k++) {
      var cand = q[(idx + k + q.length) % q.length];
      if (cand === fromId && q.length > 1) continue;
      var ov = s.crew.status[cand];
      if (ov && (ov.status === 'unavailable' || ov.status === 'offline') && atTs - now < 4 * HOUR) continue;
      var lastEnd = used[cand];
      if (P.minRestMs && lastEnd && atTs - lastEnd < P.minRestMs) continue;
      return cand;
    }
    return q[(idx + 1) % q.length];
  }

  // Scenario rule: box under a Safety Car. If a stop is due within 45 min of a SC starting, take it under the SC
  // (field slowed, fewer laps lost) and let everything after it re-plan.
  function plan(s, now, P, model, sess, refMs, whatIf, stopsInfo, curFuel) {
    var scw = (whatIf && whatIf.scWindows) || [];
    if (!scw.length || (whatIf && whatIf.boxUnderSc === false) || (whatIf && whatIf._scPass)) return planCore(s, now, P, model, sess, refMs, whatIf, stopsInfo, curFuel);
    var first = planCore(s, now, P, model, sess, refMs, Object.assign({}, whatIf, { _scPass: true }), stopsInfo, curFuel);
    var extra = [];
    scw.forEach(function (w) {
      if (w[0] < now + 2 * MIN) return;
      var inside = first.stops.some(function (x) { return x.ts >= w[0] && x.ts <= w[1]; });
      if (inside) return;
      var cand = first.stops.filter(function (x) { return !x.event && !x.pinned && x.ts > w[1] && x.ts - w[0] <= 45 * MIN; })[0];
      if (cand) extra.push({ ts: Math.min(w[1] - MIN, w[0] + 3 * MIN), statMs: 0, kind: 'undersc', label: 'Under Safety Car', fuel: cand.add > 0 ? true : null, driverIn: cand.change ? cand.driverIn : undefined });
    });
    if (!extra.length) return first;
    var res = planCore(s, now, P, model, sess, refMs, Object.assign({}, whatIf, { _scPass: true, scPins: extra }), stopsInfo, curFuel);
    return res;
  }

  function planCore(s, now, P, model, sess, refMs, whatIf, stopsInfo, curFuel) {
    var T0 = sess.startTs, startNow = sess.started ? now : T0;
    var R = makeRate(P, model, Object.assign({ refLapMs: refMs }, whatIf || {}), startNow, sess.running ? s.flag.current : 'GREEN');
    var avgStopMs = P.pitLaneMs + Math.max(P.fuelMinMs * 0.5, P.mandMinMs, P.driverChangeMs);
    var lapsDone = sess.started ? sessionLaps(s, sess.id).length : 0;
    var raceEndTs;
    if (sess.mode === 'time') raceEndTs = T0 + sess.durationMs + sess.pausedMs;
    else {
      var totLaps = sess.mode === 'laps' ? sess.totalLaps : Math.ceil(sess.distanceKm / (P.lapKm || 2));
      raceEndTs = startNow + Math.max(0, totLaps - lapsDone) * refMs;   // driving time only, stops added below
    }
    var warnings = [];
    var fuel = curFuel != null ? curFuel : P.capacity;
    var driver = s.drivers.activeId || (s.drivers.queue || [])[0] || null;
    var stintStart = sess.running && s.drivers.stintStartTs ? s.drivers.stintStartTs : startNow;
    var t = startNow;
    if (sess.running && s.openStopId) t = Math.max(t, now);
    var mandLeft = Math.max(0, P.mandCount - stopsInfo.counted);
    var inPit = sess.running && !!s.openStopId;   // the stop in progress IS the next stop
    var openStop = null; if (inPit) s.stops.forEach(function (x) { if (x.id === s.openStopId) openStop = x; });
    var inPitServiced = !!(openStop && openStop.service);   // fuel already recorded for this stop: it is history, not a plan
    var used = {};
    s.drivers.stints.forEach(function (st) { if (st.endTs) used[st.driverId] = Math.max(used[st.driverId] || 0, st.endTs); });
    var excl = (whatIf && whatIf.excludeDrivers) || [];

    var stints = [], stops = [];
    var extraLoss = 0, chosen = null;
    var maxAdd = Math.max(1, Math.min(P.maxPerStop, P.capacity - P.reserve));
    var stintMax = P.maxStintMs - P.stintSafetyMs;

    // Build one candidate: S stops, F of them fuel stops, fuel stops spread by stint count,
    // stint lengths water-filled under fuel range and driver limits, then simulated exactly.
    function waterFill(total, caps) {
      var n = caps.length, out = new Array(n).fill(0), left = total, open = [];
      for (var i = 0; i < n; i++) open.push(i);
      for (var it = 0; it < 30 && left > 1 && open.length; it++) {
        var share = left / open.length, next = [];
        open.forEach(function (i) { var room = caps[i] - out[i]; var g = Math.min(room, share); out[i] += g; left -= g; if (caps[i] - out[i] > 1) next.push(i); });
        open = next;
      }
      return left > 1000 ? null : out;
    }

    function build(endTs, S, F, ml0, p0) {
      var n = S + 1;
      var isFuel = new Array(S).fill(false);
      if (F > 0) {
        if (p0 > S - F) return null;
        isFuel[p0] = true;
        var restN = S - 1 - p0;
        for (var j = 1; j < F; j++) {
          var idx = p0 + Math.round(j * (restN + 1) / F);
          idx = Math.min(S - 1, Math.max(p0 + 1, idx));
          while (idx < S && isFuel[idx]) idx++;
          if (idx >= S) return null;
          isFuel[idx] = true;
        }
      }
      var estStat = [], cost = 0;
      for (var k = 0; k < S; k++) {
        var st = stationaryFor(P, isFuel[k] ? maxAdd * 0.8 : 0, true, k < ml0);
        estStat.push(st); cost += P.pitLaneMs + st;
      }
      var Rem = endTs - t, D = Rem - cost;
      if (D <= 0) return null;
      var spans = [], cur = [];
      for (var i = 0; i < n; i++) { cur.push(i); if (i === n - 1 || isFuel[i]) { spans.push(cur); cur = []; } }
      var half = P.pitLaneMs / 2;
      var stintCaps = []; for (i = 0; i < n; i++) stintCaps.push(i === 0 && inPit ? 0 : (i === 0 ? Math.max(0, stintMax - (t - stintStart)) : stintMax - half) - (i === n - 1 ? -half : half));
      var spanCaps = spans.map(function (sp, si) {
        var fuelL = si === 0 ? Math.max(0, fuel - P.reserve) : Math.min(P.capacity - P.reserve, maxAdd);
        var fuelMs = fuelL / R.G * HOUR;
        var drv = 0; sp.forEach(function (i) { drv += stintCaps[i]; });
        return Math.min(fuelMs, drv);
      });
      var spanLen = waterFill(D, spanCaps);
      if (!spanLen) return null;
      var lens = new Array(n).fill(0);
      for (var si = 0; si < spans.length; si++) {
        var w = waterFill(spanLen[si], spans[si].map(function (i) { return stintCaps[i]; }));
        if (!w) return null;
        spans[si].forEach(function (i, q) { lens[i] = w[q]; });
      }
      // exact simulation
      var tt = t, f = fuel, d = driver, ss = stintStart, ml = ml0, loss = 0, sts = [], sps = [], ok = true, warn = null;
      var usedL = Object.assign({}, used);
      for (i = 0; i < n; i++) {
        var last = i === n - 1;
        var end = last ? endTs : tt + lens[i];
        if (!(i === 0 && inPit) && end + (last ? 0 : P.pitLaneMs / 2) - ss > P.maxStintMs + 1000) { ok = false; warn = 'stint over limit'; }
        var fArr = f - R.burn(tt, end);
        if (fArr < P.reserve - 0.5) { ok = false; warn = 'fuel below reserve'; }
        sts.push({ driverId: d, startTs: ss, fromTs: tt, endTs: end, fuelStart: f, fuelEnd: fArr, final: last });
        if (last) break;
        var Sleft = S - 1 - i;
        var toFinish = R.burn(end, endTs - Sleft * (P.pitLaneMs + 60000)) + P.reserve - fArr;
        var add = 0;
        if (isFuel[i] && toFinish > 0.5) add = Math.max(0, Math.round(Math.min(maxAdd, P.capacity - fArr, P.fillToBrim ? Infinity : toFinish) * 2) / 2);
        if (i === 0 && inPitServiced) add = 0;
        var nextLen = lens[i + 1] || 0;
        var nd = d, contAfter = (end - ss) + nextLen;
        if (P.changeMode === 'every-stop' || contAfter > P.maxStintMs - P.stintSafetyMs || (P.changeMode === 'fuel-stops' && add > 0)) nd = nextDriver(s, P, d, end, usedL, now, excl);
        if (nd === d && add === 0 && !(ml > 0)) nd = nextDriver(s, P, d, end, usedL, now, excl);
        if (i === 0 && inPit && s.drivers.pendingIn) nd = s.drivers.pendingIn;
        var change = nd !== d, counts = ml > 0;
        var stat = stationaryFor(P, add, change, counts);
        var window = null;
        var brim = add > 0 && add >= P.capacity - fArr - 0.5;
        sps.push({ k: sps.length + 1, ts: end, fuelArr: fArr, add: add, brim: brim, cans: P.method && P.method.canL ? Math.ceil(add / P.method.canL) : null,
          driverOut: d, driverIn: nd, change: change, statMs: stat, laneMs: P.pitLaneMs, counts: counts && stat >= P.mandMinMs,
          type: add > 0 ? 'fuel' : (change ? 'driver' : (counts ? 'mandatory' : 'service')), window: window,
          _from: tt, _f: f, _ss: ss, _Sleft: Sleft });
        if (change) { usedL[d] = end; ss = end + P.pitLaneMs / 2 + stat; }
        loss += P.pitLaneMs + stat;
        tt = end + P.pitLaneMs + stat; f = fArr + add; d = nd;
        if (counts) ml--;
      }
      if (ml > 0) { ok = false; warn = 'mandatory stops short'; }
      var minArr = Infinity; sps.forEach(function (x) { minArr = Math.min(minArr, x.fuelArr); });
      return { ok: ok, warn: warn, cost: loss, minArr: minArr, endTs: endTs, usedEnd: usedL, mlEnd: ml, S: S, F: sps.filter(function (x) { return x.add > 0; }).length, stints: sts, stops: sps };
    }

    function addWindows(c) {
      var fuelIdx = []; c.stops.forEach(function (x, i) { if (x.add > 0) fuelIdx.push(i); });
      fuelIdx.forEach(function (i, q) {
        var x = c.stops[i], tt0 = x._from, f0 = x._f;
        var closeTs = Math.min(R.timeToBurn(tt0, Math.max(0, f0 - P.reserve)), x._ss + P.maxStintMs - P.pitLaneMs / 2);
        var lastFuel = q === fuelIdx.length - 1, openTs = closeTs;
        var upto = lastFuel ? c.stops.length : fuelIdx[q + 1], loss = 0;
        for (var k2 = i; k2 < upto; k2++) loss += c.stops[k2].laneMs + c.stops[k2].statMs;
        var reachTs = lastFuel ? c.endTs : c.stops[fuelIdx[q + 1]].ts;
        for (var y = tt0; y <= closeTs; y += MIN) {
          var fx = f0 - R.burn(tt0, y);
          var need = Math.min(maxAdd, R.burn(y, reachTs - loss) + P.reserve - fx);
          if (P.capacity - fx >= need - 0.01) { openTs = y; break; }
        }
        x.window = { openTs: Math.min(openTs, x.ts), closeTs: Math.max(x.ts, closeTs) };
      });
    }

    // ---- search from the current state (t, fuel, driver, stintStart, used) to endTs
    function search(endTs, ml) {
      var Rem = endTs - t, ch = null;
      if (Rem <= 0) return null;
      var needToFinish = R.burn(t, endTs) + P.reserve - fuel;
      var Fmin = needToFinish > 0 ? Math.ceil(needToFinish / maxAdd) : 0;
      var Smin = Math.max(Fmin, ml, inPit ? 1 : 0, Math.max(0, Math.ceil((Rem + (t - stintStart)) / stintMax) - 1));
      for (var S = Smin; S <= Smin + 8; S++) {
        for (var F = Fmin; F <= Math.min(S, Fmin + 3); F++) {
          for (var p0 = 0; p0 <= (F ? S - F : 0); p0++) {
            var c = build(endTs, S, F, ml, p0);
            if (!c || !c.ok) continue;
            if (!ch || c.cost < ch.cost - 1000 || (Math.abs(c.cost - ch.cost) <= 1000 && (c.F < ch.F || (c.F === ch.F && c.minArr > ch.minArr)))) ch = c;
          }
        }
        if (ch && S > ch.S + 2) break;
      }
      if (!ch && Smin > 0) {
        var fb = build(endTs, Math.max(Smin, 1), Math.max(1, Math.min(Smin, Fmin)), ml, 0) || build(endTs, Smin + 1, Smin + 1, ml, 0);
        if (fb) { ch = fb; warnings.push('No fully compliant plan found (' + fb.warn + ') - showing closest'); }
      }
      return ch;
    }
    // take the stops of a searched segment and move the state to the start of its last stint
    function adopt(c) {
      if (!c || !c.stops.length) return;
      addWindows(c);
      var last = c.stints[c.stints.length - 1];
      stints = stints.concat(c.stints.slice(0, -1)); stops = stops.concat(c.stops);
      t = last.fromTs; fuel = last.fuelStart; driver = last.driverId; stintStart = last.startTs; used = c.usedEnd; mandLeft = c.mlEnd;
      extraLoss += c.cost;
    }

    // ---- fixed points: stops pinned by dragging in a scenario, and scenario events that force a stop (repair, sin bin)
    var fixed = [];
    ((whatIf && whatIf.pins) || []).forEach(function (pn) { fixed.push({ ts: pn.ts, kind: 'pin', fuel: pn.fuel, add: pn.add, driverIn: pn.driverIn, chain: true }); });
    ((whatIf && whatIf.extraStops) || []).forEach(function (x) { fixed.push({ ts: x.ts, kind: x.kind || 'repair', statMs: x.statMs, label: x.label, fuel: null, chain: false }); });
    ((whatIf && whatIf.scPins) || []).forEach(function (x) { fixed.push({ ts: x.ts, kind: 'pin', fuel: x.fuel, driverIn: x.driverIn, chain: false, label: x.label, undersc: true }); });
    fixed = fixed.filter(function (x) { return x.ts > t + 60000 && x.ts < raceEndTs - 120000; }).sort(function (a, b) { return a.ts - b.ts; });
    function applyFixed(fp, nextFixed) {
      var fArr = fuel - R.burn(t, fp.ts);
      if (fp.ts - t > 60000) {
        if (fArr < P.reserve - 0.5) warnings.push((fp.kind === 'pin' ? 'Moved stop' : fp.label || 'Event stop') + ' at ' + new Date(fp.ts).toTimeString().slice(0, 5) + ' arrives with ' + fArr.toFixed(1) + ' L (below reserve)');
        if (fp.ts - stintStart > P.maxStintMs + 1000) warnings.push('Stint of ' + memberName(s, driver) + ' ending ' + new Date(fp.ts).toTimeString().slice(0, 5) + ' is ' + Math.round((fp.ts - stintStart) / MIN) + ' min (over the ' + Math.round(P.maxStintMs / MIN) + ' min limit)');
        stints.push({ driverId: driver, startTs: stintStart, fromTs: t, endTs: fp.ts, fuelStart: fuel, fuelEnd: fArr });
      }
      var add = 0;
      // litres set on the Fuel Plan tab: that amount (capped by the tank and the per-stop limit); everything after re-plans around it
      if (fp.add != null && fp.add > 0) add = Math.max(0, Math.round(Math.min(fp.add, maxAdd, P.capacity - fArr) * 2) / 2);
      else if (fp.fuel === true || (fp.fuel == null && fArr < P.capacity * 0.6)) add = Math.max(0, Math.round(Math.min(maxAdd, P.capacity - fArr) * 2) / 2);
      if (fp.ts <= t + 60000 && inPitServiced) add = 0;
      var nd = driver;
      if (fp.driverIn) nd = fp.driverIn;
      else if (fp.driverIn === undefined || fp.kind !== 'pin') {
        var contAfter = (fp.ts - stintStart) + Math.min(nextFixed - fp.ts, stintMax);
        if (P.changeMode === 'every-stop' || contAfter > stintMax || (P.changeMode === 'fuel-stops' && add > 0)) nd = nextDriver(s, P, driver, fp.ts, used, now, excl);
      }
      var change = nd !== driver, counts = mandLeft > 0 && fp.kind !== 'sinbin';
      var stat = stationaryFor(P, add, change, counts);
      if (fp.statMs) stat = Math.max(stat, fp.statMs);
      stops.push({ k: 0, ts: fp.ts, fuelArr: fArr, add: add, brim: add > 0 && add >= P.capacity - fArr - 0.5, cans: P.method && P.method.canL ? Math.ceil(add / P.method.canL) : null,
        driverOut: driver, driverIn: nd, change: change, statMs: stat, laneMs: P.pitLaneMs, counts: counts && stat >= P.mandMinMs,
        type: fp.kind === 'pin' ? (add > 0 ? 'fuel' : (change ? 'driver' : (counts ? 'mandatory' : 'service'))) : fp.kind, label: fp.label || null, window: null, pinned: fp.kind === 'pin' && !fp.undersc, undersc: !!fp.undersc, event: fp.kind !== 'pin', litresSet: fp.add != null && fp.add > 0 ? fp.add : null });
      if (change) { used[driver] = fp.ts; stintStart = fp.ts + P.pitLaneMs / 2 + stat; }
      extraLoss += P.pitLaneMs + stat;
      t = fp.ts + P.pitLaneMs + stat; fuel = fArr + add; driver = nd;
      if (counts && stat >= P.mandMinMs) mandLeft--;
      inPit = false;
    }
    // a pin at or before now while the car is in the pits = the stop in progress: apply it as pinned
    if (inPit) {
      var curPin = ((whatIf && whatIf.pins) || []).filter(function (x) { return x.ts <= t + 60000; }).pop();
      if (curPin) applyFixed({ ts: t, kind: 'pin', fuel: curPin.fuel, add: curPin.add, driverIn: curPin.driverIn, chain: true },fixed.length ? fixed[0].ts : raceEndTs);
    }
    fixed.forEach(function (fp, i) {
      // the stop in progress (car in the pits) is always planned first; free stops are searched only in front of event stops
      if ((inPit || !fp.chain) && fp.ts - t > 10 * MIN) { adopt(search(fp.ts - 30000, 0)); inPit = false; }
      if (fp.ts <= t + 60000) return;
      applyFixed(fp, fixed[i + 1] ? fixed[i + 1].ts : raceEndTs);
    });

    // ---- final segment to the flag
    var endTs = raceEndTs + (sess.mode === 'time' ? 0 : extraLoss);
    var fin = search(endTs, mandLeft);
    if (fin) { addWindows(fin); stints = stints.concat(fin.stints); stops = stops.concat(fin.stops); extraLoss += fin.cost; }
    else stints.push({ driverId: driver, startTs: stintStart, fromTs: t, endTs: endTs, fuelStart: fuel, fuelEnd: fuel - R.burn(t, endTs), final: true });
    stops.forEach(function (x, i) { x.k = i + 1; });
    var last = stints[stints.length - 1];
    var finishFuel = last ? last.fuelEnd : fuel;
    if (finishFuel < P.reserve - 0.5) warnings.push('Projected finish fuel ' + finishFuel.toFixed(1) + ' L is below the ' + P.reserve + ' L reserve');
    stops.forEach(function (st) { if (st.fuelArr < P.reserve - 0.5) warnings.push('Stop ' + st.k + ' arrives with ' + st.fuelArr.toFixed(1) + ' L (below reserve)'); });
    var endFinal = sess.mode === 'time' ? raceEndTs : raceEndTs + extraLoss;
    var events = [];
    ((whatIf && whatIf.scWindows) || []).forEach(function (w) { events.push({ kind: 'sc', from: w[0], to: w[1] }); });
    ((whatIf && whatIf.redWindows) || []).forEach(function (w) { events.push({ kind: 'red', from: w[0], to: w[1] }); });
    ((whatIf && whatIf.extraStops) || []).forEach(function (x) { events.push({ kind: x.kind || 'repair', from: x.ts, to: x.ts + x.statMs, label: x.label }); });
    return { stints: stints, stops: stops, events: events, stationaryMs: extraLoss, finishFuelL: finishFuel, raceEndTs: endFinal, warnings: warnings, greenRate: R.G,
      fuelStops: stops.filter(function (x) { return x.add > 0; }).length, rate: R };
  }

  /* ---------------------------------------------------------- stops */
  function stopsInfo(s, sess, P, now) {
    var list = s.stops.filter(function (st) { return st.sessionId === sess.id && !st.voided; }).map(function (st) {
      var laneMs = (st.outTs || now) - st.inTs;
      var fuelMs = st.fuelInTs ? (st.fuelOutTs || now) - st.fuelInTs : null;
      var added = st.service && st.service.fuelAdded > 0 ? st.service.fuelAdded : 0;
      var counts = !!st.outTs && laneMs >= P.mandMinMs && !(st.service && st.service.penalty);
      var fuelBasis = P.fuelTiming === 'zone' && fuelMs != null ? fuelMs : laneMs;
      var fuelOk = added > 0 ? fuelBasis >= P.fuelMinMs : null;
      var type = st.service && st.service.penalty ? 'penalty' : (added > 0 ? 'fuel' : (st.service && st.service.driverIn && st.service.driverIn !== st.driverOut ? 'driver' : 'stop'));
      return { id: st.id, inTs: st.inTs, outTs: st.outTs, laneMs: laneMs, fuelMs: fuelMs, added: added, counts: counts, fuelOk: fuelOk, type: type,
        open: !st.outTs, serviced: !!st.service, driverOut: st.driverOut, driverIn: st.service ? st.service.driverIn : null, raw: st };
    });
    var counted = list.filter(function (x) { return x.counts; }).length;
    return { list: list, counted: counted, required: P.mandCount, open: list.filter(function (x) { return x.open; })[0] || null };
  }

  /* ---------------------------------------------------------- tyres */
  function tyresView(s, now, P) {
    var out = [];
    Object.keys(s.tyres.sets).forEach(function (id) {
      var t = s.tyres.sets[id];
      var onMs = 0;
      var inSess = function (a, b) { var sum = 0; Object.keys(s.sessions).forEach(function (k) { var x = s.sessions[k]; sum += overlap(a, b, x.startTs, x.endTs || now); }); return sum; };
      t.fitted.forEach(function (f) { onMs += inSess(f.onTs, f.offTs || now); });
      var laps = s.laps.filter(function (l) { return l.tyreSetId === id; }).length;
      var last = t.measures[t.measures.length - 1];
      var minD = last ? Math.min.apply(null, last.depths.filter(function (x) { return x != null && !isNaN(x); })) : P.newDepth;
      var life = clamp((minD - P.minDepth) / (P.newDepth - P.minDepth), 0, 1);
      var rate = null, hoursLeft = null;
      if (last) {
        var onAtMeasure = 0;
        t.fitted.forEach(function (f) { onAtMeasure += inSess(f.onTs, Math.min(f.offTs || now, last.ts)); });
        if (onAtMeasure > 10 * MIN && P.newDepth - minD > 0.05) {
          rate = (P.newDepth - minD) / (onAtMeasure / HOUR);
          hoursLeft = Math.max(0, (minD - P.minDepth) / rate - Math.max(0, onMs - onAtMeasure) / HOUR);
        }
      }
      out.push({ id: id, name: t.name, status: t.status, mounted: s.tyres.mounted === id, onMs: onMs, laps: laps,
        last: last || null, minDepth: minD, lifePct: Math.round(life * 100), wearMmH: rate, hoursLeft: hoursLeft });
    });
    return out;
  }

  /* ---------------------------------------------------------- crew view */
  function crewView(s, now, P, carOnTrack, firstStart) {
    var ms = (s.config && s.config.members) || [];
    return ms.map(function (m) {
      var st = memberStatus(s, m, now, carOnTrack);
      var duty = DUTY[st.status] ? now - dutyStart(s, m, now, firstStart) : 0;
      var ov = s.crew.overrides[m.id];
      var overridden = ov && ov.untilTs > now;
      var driverStint = s.drivers.stints.filter(function (x) { return x.driverId === m.id; });
      var driveMs = 0; driverStint.forEach(function (x) { driveMs += (x.endTs || now) - x.startTs; });
      return { id: m.id, name: m.name, roles: m.roles || [], driver: !!m.driver, status: st.status, reason: st.reason, src: st.src,
        dutyMs: duty, needsRest: duty > P.dutyLimitMs && !overridden && firstStart && now > firstStart, overridden: !!overridden, driveMs: driveMs };
    });
  }

  // Only members TAGGED with a role are assigned to it, and only while their status is Available.
  // Untagged available people are offered as suggestions, never assigned silently.
  // Golden rule at a fuel stop: the outgoing driver steps out and goes to rest - never on the refuel crew.
  // The incoming driver enters the fuel zone as Refueller Assistant, supervising only (hands off).
  // Pouring and the extinguisher go to the other available members tagged for them.
  function refuelCrew(s, P, crew, outId, inId) {
    var roles = (P.method && P.method.roles) || [];
    var taken = {}, assign = [], issues = [], byKey = {};
    var eligible = function (c) { return !taken[c.id] && c.status === 'available' && c.id !== outId && c.id !== inId; };
    var rank = function (c) { return c.driver ? 1 : 0; };
    var sup = inId && inId !== outId ? roles.filter(function (r) { return r.key === 'assistant'; })[0] : null;
    if (sup) {
      var ic = crew.filter(function (c) { return c.id === inId; })[0];
      taken[inId] = 1;
      byKey[sup.key] = { key: sup.key, label: sup.label, memberId: inId, name: ic ? ic.name : memberName(s, inId), supervise: true, suggest: [] };
    }
    // assign the most constrained roles first so a flexible person is not used up early
    var order = roles.filter(function (r) { return r !== sup; }).map(function (r, i) { return { r: r, i: i, n: crew.filter(function (c) { return c.roles.indexOf(r.key) >= 0 && eligible(c); }).length }; })
      .sort(function (a, b) { return a.n - b.n || a.i - b.i; });
    order.forEach(function (o) {
      var r = o.r;
      var cands = crew.filter(function (c) { return c.roles.indexOf(r.key) >= 0 && eligible(c); }).sort(function (a, b) { return rank(a) - rank(b); });
      var pick = cands[0] || null;
      if (pick) taken[pick.id] = 1;
      byKey[r.key] = { key: r.key, label: r.label, memberId: pick ? pick.id : null, name: pick ? pick.name : null, suggest: [] };
    });
    roles.forEach(function (r) {
      var a = byKey[r.key];
      if (!a.memberId) {
        var tagged = crew.filter(function (c) { return c.roles.indexOf(r.key) >= 0; });
        a.reason = !tagged.length ? 'nobody tagged "' + r.key + '"' : 'tagged crew unavailable or barred (' + tagged.map(function (c) { return c.name + ': ' + (c.status !== 'available' ? c.status : 'in/out driver'); }).join(', ') + ')';
        var sg = crew.filter(function (c) { return eligible(c); }).sort(function (x, y) { return rank(x) - rank(y); }).slice(0, 3);
        a.suggest = sg.map(function (c) { return c.name; }); a.suggestIds = sg.map(function (c) { return c.id; });
        a.taggedIds = crew.filter(function (c) { return c.roles.indexOf(r.key) >= 0 && !taken[c.id] && c.id !== outId && c.id !== inId && ['resting', 'sleeping', 'offline', 'flag'].indexOf(c.status) >= 0; }).map(function (c) { return c.id; });
        issues.push('No ' + r.label + ': ' + a.reason);
      }
      assign.push(a);
    });
    return { assign: assign, issues: issues };
  }

  /* --------------------------------------------------------- derive */
  function fuelTrace(s, now, P, B, model, sess, pl) {
    var past = [], future = [];
    if (sess.started) {
      var t0 = sess.startTs, t1 = Math.min(now, sess.finished ? s.sessions[sess.id].endTs : now);
      var step = Math.max(2 * MIN, (t1 - t0) / 240);
      var A = s.fuel.anchors.filter(function (a) { return a.sessionId === sess.id; }).sort(function (a, b) { return a.ts - b.ts; });
      var at = function (t) {
        var a = null; for (var i = 0; i < A.length; i++) if (A[i].ts <= t) a = A[i];
        if (!a) return null;
        var add = 0; s.fuel.refuels.forEach(function (r) { if (r.ts > a.ts && r.ts <= t) add += r.litres; });
        var h = burnHours(B, a.ts, t);
        return a.after + add - model.G * h.g - model.S * h.s;
      };
      var pts = [];
      for (var t = t0; t < t1; t += step) pts.push(t);
      A.forEach(function (a) { pts.push(a.ts - 1, a.ts); });
      s.fuel.refuels.forEach(function (r) { if (r.sessionId === sess.id) pts.push(r.ts - 1, r.ts); });
      pts.push(t1);
      pts.filter(function (x) { return x >= t0 && x <= t1; }).sort(function (a, b) { return a - b; }).forEach(function (x) {
        var v = at(x); if (v != null) past.push([x, v]);
      });
    }
    if (pl) pl.stints.forEach(function (st) { future.push([st.fromTs, st.fuelStart]); future.push([st.endTs, st.fuelEnd]); });
    return { past: past, future: future };
  }

  /* ------------------------------------------------- scenarios (Plans A-F) */
  function defToWhatIf(def) {
    if (!def) return null;
    var ev = def.events || [];
    return {
      lapDeltaS: def.lapDeltaS || 0,
      excludeDrivers: (def.excludeDrivers || []).slice(),
      scWindows: ev.filter(function (e) { return e.kind === 'sc'; }).map(function (e) { return [e.from, e.to]; }),
      redWindows: ev.filter(function (e) { return e.kind === 'red'; }).map(function (e) { return [e.from, e.to]; }),
      extraStops: ev.filter(function (e) { return e.kind === 'repair' || e.kind === 'sinbin'; }).map(function (e) { return { ts: e.from, statMs: e.to - e.from, kind: e.kind, label: e.label }; }),
      pins: (def.pins || []).slice()
    };
  }
  function activeScenario(s) {
    var sc = s.scenarios; if (!sc || !sc.active) return null;
    var pl = sc.plans[sc.active]; return pl ? pl : null;
  }
  function mergeWhatIf(a, b) {
    if (!a) return b || null; if (!b) return a;
    var o = Object.assign({}, a, b);
    ['scWindows', 'redWindows', 'extraStops', 'excludeDrivers'].forEach(function (k) { o[k] = (a[k] || []).concat(b[k] || []); });
    o.pins = b.pins && b.pins.length ? b.pins : a.pins;
    o.lapDeltaS = (a.lapDeltaS || 0) + (b.lapDeltaS || 0);
    return o;
  }
  // Default Plans A-F, anchored to the moment they are created (times are absolute after that)
  function scenarioTemplates(s, now) {
    var d = derive(s, now, { noScenario: true });
    var rs = d.raceSession, t0 = rs.started ? now : rs.startTs, end = d.plan ? d.plan.raceEndTs : t0 + rs.durationMs;
    var R = Math.max(30 * MIN, end - t0);
    var at = function (f, minMin) { return Math.round((t0 + Math.max((minMin || 0) * MIN, f * R)) / MIN) * MIN; };
    var ev = function (id, kind, from, durMin, label) { return { id: id, kind: kind, from: from, to: from + durMin * MIN, label: label }; };
    var od = d.onDeck;
    var base = function (o) { return Object.assign({ lapDeltaS: 0, excludeDrivers: [], events: [], pins: [] }, o); };
    return [
      { id: 'A', name: 'Clean race', desc: 'No incidents. The plan as it stands.', def: base({}) },
      { id: 'B', name: 'Safety car', desc: 'One 20 min Safety Car around the middle of what is left.', def: base({ events: [ev('B1', 'sc', at(0.4), 20, 'Safety car')] }) },
      { id: 'C', name: 'Early SC + sin bin', desc: 'A 15 min Safety Car soon, then a 15 min sin bin penalty.', def: base({ events: [ev('C1', 'sc', at(0.08, 20), 15, 'Safety car'), ev('C2', 'sinbin', at(0.25), 15, 'Sin bin')] }) },
      { id: 'D', name: 'Mechanical', desc: 'An unplanned 25 min repair stop.', def: base({ events: [ev('D1', 'repair', at(0.3), 25, 'Repair')] }) },
      { id: 'E', name: 'Chaos', desc: '30 min red flag, then two 15 min Safety Cars.', def: base({ events: [ev('E1', 'red', at(0.2), 30, 'Red flag'), ev('E2', 'sc', at(0.5), 15, 'Safety car'), ev('E3', 'sc', at(0.75), 15, 'Safety car')] }) },
      { id: 'F', name: 'Driver down', desc: (od ? memberName(s, od) : 'The up-next driver') + ' unavailable for the rest of the race.', def: base({ excludeDrivers: od ? [od] : [] }) }
    ];
  }

  /* ------------------------------------------------- pit stop gates (geofence + human acknowledge) */
  var GATE_S = {};
  function gates(s, d, now) {
    var sess = d.session;
    if (!sess.running) return null;
    var st = null;
    for (var i = s.stops.length - 1; i >= 0; i--) { var x = s.stops[i]; if (x.sessionId === sess.id && !x.voided) { st = x; break; } }
    if (!st) return null;
    if (st.outTs && now - st.outTs > 3 * MIN) return null;           // only the stop in progress or one that just ended
    return gatesFor(s, d, now, st, null);
  }
  // every stop that still has an unconfirmed gate (server side: nothing is ever left unapplied)
  function pendingGates(s, d, now) {
    var out = [], sess = d.session;
    if (!sess.running) return out;
    var list = s.stops.filter(function (x) { return x.sessionId === sess.id && !x.voided && (!x.outTs || now - x.outTs < 10 * MIN); });
    list.forEach(function (st, i) {
      var later = list[i + 1] || null;
      var g = gatesFor(s, d, now, st, later);
      if (g) out.push(g);
    });
    return out;
  }
  // Gates: every step of a stop has up to two signals and is a HANDSHAKE when both agree:
  //   GEO = a PLTD geofence saw the car do it, ENG = the engineer confirmed it on the pit wall.
  //   Pit in            GEO pit-entry geofence        ENG PIT IN                (car is in the pit lane)
  //   Driver change     no geofence                   ENG DRIVER CHANGE DONE
  //   Fuelling started  GEO car in the fuel zone      ENG FUEL ON               (crew pouring; starts the fuelling clock if the geofence missed it)
  //   Fuel completed    GEO car left the fuel zone    ENG FUEL STOP COMPLETED   (litres + cans recorded)
  //   Pit out           GEO pit-exit geofence         ENG PIT OUT               (car is leaving the pit lane)
  // No timers. A step the engineer has not confirmed is applied from the plan ("AUTO") only when the geofences show
  // the car has physically moved past it.
  function gatesFor(s, d, now, st, later) {
    var key = function (g) { return st.id + ':' + g; };
    var pin = s.gates[key('pitin')];
    var snap = pin && pin.plan ? pin.plan : null;
    var planned = snap || (d.nextStop ? { add: d.nextStop.add, brim: d.nextStop.brim, driverIn: d.nextStop.driverIn, change: d.nextStop.change, type: d.nextStop.type, cans: d.nextStop.cans } : null);
    var geo = st.geo || {};
    var gone = st.outTs || (later && later.inTs) || null;            // the car is out of this stop
    var leftFuel = st.fuelOutTs || gone;                             // the car has left the fuel bay
    var svc = st.service, recNoFuel = !!(svc && !(svc.fuelAdded > 0));
    var fuelOnSkip = !st.fuelInTs && (recNoFuel || !(planned && planned.add > 0));
    var steps = [
      { id: 'pitin', label: 'Pit in', hasGeo: true, geoTs: geo.entry || null, overrideAt: st.fuelInTs || leftFuel },
      { id: 'driver', label: 'Driver change', hasGeo: false, geoTs: null, overrideAt: leftFuel },
      { id: 'fuelon', label: 'Fuelling started', hasGeo: true, geoTs: geo.fuelIn || null, overrideAt: leftFuel, skip: fuelOnSkip },
      { id: 'fuel', label: 'Fuel completed', hasGeo: !recNoFuel, geoTs: recNoFuel ? null : (geo.fuelOut || null), overrideAt: leftFuel },
      { id: 'pitout', label: 'Pit out', hasGeo: true, geoTs: geo.exit || null, overrideAt: gone }
    ];
    steps.forEach(function (g) {
      var ack = g.id === 'fuel' ? (svc ? { by: svc.auto ? 'auto' : 'human', ts: svc.ts } : null) : s.gates[key(g.id)];
      g.state = g.skip ? 'skip' : ack ? 'done' : (g.overrideAt ? 'due' : 'open');      // due = the geofence has overtaken it, the server applies it now
      g.by = ack ? ack.by : null; g.ackTs = ack ? ack.ts : null;
      g.engTs = ack && ack.by === 'human' ? ack.ts : null;
      // hs = handshake (both signals), ok = engineer on a step with no geofence, eng = engineer waiting for the geofence,
      // geo = geofence waiting for the engineer, auto = applied from the plan
      g.mode = g.skip ? 'skip' : g.by === 'auto' ? 'auto' : g.engTs ? (!g.hasGeo ? 'ok' : g.geoTs ? 'hs' : 'eng') : (g.geoTs ? 'geo' : 'none');
      if (g.id === 'driver' && ack && s.gates[key('driver')]) g.driverIn = s.gates[key('driver')].driverIn || null;
    });
    var allDone = steps.every(function (g) { return g.state === 'done' || g.state === 'skip'; });
    if (allDone && st.outTs && now - st.outTs > 3 * MIN) return null;
    if (later && allDone) return null;
    var complete = allDone && !!st.outTs;
    var noFuel = !!(st.service && !(st.service.fuelAdded > 0));
    var stuckInFuel = noFuel && s.carState.current === 'FUELLING' && !st.outTs;
    var current = steps.filter(function (g) { return g.state !== 'done' && g.state !== 'skip'; })[0] || null;
    var drvAck = s.gates[key('driver')];
    var auto = { stopId: st.id, auto: true, fuelAdded: st.fuelInTs && planned ? (planned.add || 0) : 0, brimmed: false, capacityL: d.P.capacity };
    var autoDriver = planned && planned.change ? planned.driverIn : null;
    return { stop: st, list: steps, current: current, planned: planned, autoService: auto, autoDriverIn: autoDriver, driverAck: drvAck || null, done: complete, allSteps: allDone, noFuel: noFuel, stuckInFuel: stuckInFuel };
  }

  /* ------------------------------------------- fuel plan: the running plan's fuel stops, with crew, cans and stop timings */
  function canSplit(add, canL) {
    if (!(add > 0) || !canL) return { n: 0, full: 0, partL: 0 };
    var full = Math.floor(add / canL + 1e-6), part = Math.round((add - full * canL) * 10) / 10;
    return { n: full + (part > 0 ? 1 : 0), full: full, partL: part };
  }
  // who else attends a fuel stop besides the refuel crew: first available tagged member, non-drivers first, never the refuel
  // crew or the in/out driver. The pit-wall roles (engineer, radio, timing) may fall on one person; the mechanic is someone else.
  var SUPPORT_ROLES = [['engineer', 'Pit wall engineer', 1], ['raceceiver', 'Radio (Raceceiver relay)', 1], ['timing', 'Lap timing', 1], ['mechanic', 'Mechanic (driver change, checks)', 0]];
  function supportCrew(crew, rc, outId, inId) {
    var taken = {}, wall = {}; rc.assign.forEach(function (a) { if (a.memberId) taken[a.memberId] = 1; });
    return SUPPORT_ROLES.map(function (r) {
      var cands = crew.filter(function (x) { return x.status === 'available' && x.roles.indexOf(r[0]) >= 0 && !taken[x.id] && x.id !== outId && x.id !== inId; })
        .sort(function (a, b) { return (a.driver ? 1 : 0) - (b.driver ? 1 : 0); });
      var c = cands.filter(function (x) { return !wall[x.id]; })[0] || (r[2] ? cands[0] : null) || null;
      if (c) { if (r[2]) wall[c.id] = 1; else taken[c.id] = 1; }
      return { key: r[0], label: r[1], memberId: c ? c.id : null, name: c ? c.name : null };
    });
  }
  function fuelPlan(s, d) {
    var P = d.P, canL = (P.method && P.method.canL) || 20, first = firstSessionStart(s);
    var out = d.stops.list.filter(function (x) { return x.added > 0; }).map(function (x) {
      return { done: !x.open, live: x.open, id: x.id, ts: x.inTs, add: x.added, cans: canSplit(x.added, canL), driverOut: x.driverOut, driverIn: x.driverIn, change: !!(x.driverIn && x.driverIn !== x.driverOut), fuelMs: x.fuelMs };
    });
    var refLap = d.refLap.ms;
    (d.plan ? d.plan.stops : []).forEach(function (x) {
      if (!(x.add > 0)) return;
      var isNext = d.nextFuel && x.k === d.nextFuel.k;
      var crew = isNext ? d.crew : crewView(s, x.ts, P, false, first);
      var rc = isNext && d.refuelCrew ? d.refuelCrew : refuelCrew(s, P, crew, x.driverOut, x.driverIn);
      var half = x.laneMs / 2, fuelMs = Math.max(P.fuelMinMs, (x.add / P.pourLpm + P.fuelHandlingMin) * MIN);
      var swap = x.change && !P.swapDuringFuel ? P.driverChangeMs : 0;
      var inBox = x.ts + half;
      out.push({ done: false, live: !!(d.inPits && x.k === 1), k: x.k, ts: x.ts, add: x.add, brim: x.brim, litresSet: x.litresSet || null, pinned: !!x.pinned, event: !!x.event,
        fuelArr: x.fuelArr, fuelAfter: x.fuelArr + x.add, window: x.window, cans: canSplit(x.add, canL), overStore: P.method && P.method.maxStoredL != null && x.add > P.method.maxStoredL,
        driverOut: x.driverOut, driverIn: x.driverIn, change: x.change, statMs: x.statMs, fuelMs: fuelMs, refuel: rc, support: supportCrew(crew, rc, x.driverOut, x.change ? x.driverIn : null),
        times: { prep: x.ts - 5 * MIN, notify: x.ts - refLap, pitIn: x.ts, swap: inBox, fuelOn: inBox + swap, fuelOff: inBox + swap + fuelMs, pitOut: x.ts + x.laneMs + x.statMs } });
    });
    out.sort(function (a, b) { return a.ts - b.ts; });
    out.forEach(function (x, i) { x.n = i + 1; });
    return { stops: out, canL: canL, method: P.method, maxPerStop: P.maxPerStop, maxAdd: Math.max(1, Math.min(P.maxPerStop, P.capacity - P.reserve)), capacity: P.capacity };
  }

  function derive(s, now, whatIf, opts) {
    if (!(whatIf && whatIf.noScenario)) { var asc = activeScenario(s); if (asc) whatIf = mergeWhatIf(defToWhatIf(asc.cur), whatIf); }
    var P = params(s);
    var cur = sessionInfo(s, now, P);
    var sess = cur.isRace ? cur : sessionInfo(s, now, P, raceSessionId(s) || cur.id);
    var laps = sessionLaps(s, cur.id);
    var refBy = {};
    Object.keys(s.sessions).forEach(function (sid) { refBy[sid] = refLapMs(sessionLaps(s, sid), P).ms; });
    var ref = refLapMs(laps, P);
    var B = buildSegments(s, now, P, refBy);
    var model = fuelModel(s, now, P, B);
    var cs = s.carState.current;
    var inPits = !!s.openStopId || ['PIT ENTRY', 'PITS', 'FUELLING'].indexOf(cs) >= 0;
    var carOnTrack = cur.running && !inPits;
    var curFuel = sess.started ? model.nowL : num(s.config.strategy && s.config.strategy.startFuelL, P.capacity);
    var liveFuel = cur.started ? model.nowL : curFuel;
    if (curFuel == null) curFuel = P.capacity;
    var SI = stopsInfo(s, sess, P, now);
    var pl = sess.isRace ? plan(s, now, P, model, sess, ref.ms, whatIf, SI, curFuel) : null;

    var lastLap = laps[laps.length - 1] || null;
    var lapAt = function (t) { if (!lastLap) return Math.max(1, Math.ceil((t - sess.startTs) / ref.ms)); return lastLap.n + Math.max(1, Math.ceil((t - lastLap.ts) / ref.ms)); };
    var classified = laps.map(function (l) { return { n: l.n, ms: l.ms, ts: l.ts, cls: classifyLap(l, ref.ms, P), driverId: l.driverId, flag: l.flag, pitted: l.pitted, delta: l.delta }; });
    var counts = { push: 0, green: 0, slow: 0, sc: 0, pit: 0 };
    classified.forEach(function (l) { counts[l.cls]++; });
    var best = null; laps.forEach(function (l) { if (!l.pitted && (best == null || l.ms < best)) best = l.ms; });

    var lapL = model.G * ref.ms / HOUR;
    var usable = (liveFuel == null ? P.capacity : liveFuel) - P.reserve;
    var fuel = { nowL: liveFuel == null ? P.capacity : liveFuel, planStartL: curFuel, model: model, lapL: lapL, lapsToReserve: usable / lapL, msToReserve: usable / model.G * HOUR,
      reserve: P.reserve, capacity: P.capacity, uncertaintyL: model.uncertaintyL };

    var openSt = null; if (s.openStopId) s.stops.forEach(function (x) { if (x.id === s.openStopId) openSt = x; });
    var stintEnd = openSt ? (openSt.statInTs || openSt.inTs) : now;          // car stopped: the outgoing driver's time stops
    var stintMs = cur.running && s.drivers.stintStartTs ? Math.max(0, stintEnd - s.drivers.stintStartTs) : 0;
    var stint = { driverId: s.drivers.activeId, name: memberName(s, s.drivers.activeId), elapsedMs: stintMs, maxMs: P.maxStintMs, remainingMs: P.maxStintMs - stintMs, frozen: !!openSt };
    if (openSt && s.drivers.pendingIn && s.drivers.pendingIn !== s.drivers.activeId) {
      // driver change confirmed during the stop: the new driver is in the car, his clock starts at pit out
      stint.outgoing = { driverId: s.drivers.activeId, name: stint.name, elapsedMs: stintMs };
      stint.driverId = s.drivers.pendingIn; stint.name = memberName(s, s.drivers.pendingIn);
      stint.elapsedMs = 0; stint.remainingMs = P.maxStintMs; stint.waiting = true;
    }

    var crew = crewView(s, now, P, carOnTrack, firstSessionStart(s));
    var nextStop = pl && pl.stops.length ? pl.stops[0] : null;
    var nextFuel = pl ? pl.stops.filter(function (x) { return x.add > 0; })[0] || null : null;
    var onDeck = nextStop ? nextStop.driverIn : null;
    if (!onDeck || onDeck === s.drivers.activeId) onDeck = nextDriver(s, P, s.drivers.activeId, now + HOUR, {}, now, whatIf && whatIf.excludeDrivers);
    var rc = nextFuel ? refuelCrew(s, P, crew, nextFuel.driverOut, nextFuel.driverIn) : null;

    var call = makeCall(s, now, P, cur, pl, nextStop, nextFuel, fuel, stint, ref.ms, inPits, SI);
    var save = saveToDrop(P, pl, curFuel, now, sess, ref.ms, SI);
    var tyres = tyresView(s, now, P);
    var issues = s.issues.filter(function (i) { return i.status === 'open' || i.status === 'next-stop'; });

    var d = { now: now, P: P, session: cur, raceSession: sess, refLap: ref, laps: classified, lapCounts: counts, bestLapMs: best, lastLap: lastLap,
      lapAt: lapAt, fuel: fuel, stint: stint, onDeck: onDeck, crew: crew, plan: pl, nextStop: nextStop, nextFuel: nextFuel,
      refuelCrew: rc, stops: SI, call: call, saveToDrop: save, tyres: tyres, issues: issues, inPits: inPits, carOnTrack: carOnTrack,
      driverStats: driverStats(s, cur, now) };
    d.alerts = alerts(s, d, P);
    if (opts && opts.trace) d.trace = fuelTrace(s, now, P, B, model, sess, pl);
    d.gates = gates(s, d, now);
    d.scenarioId = (s.scenarios && s.scenarios.active) || 'A';
    return d;
  }

  function firstSessionStart(s) {
    var t = null;
    Object.keys(s.sessions).forEach(function (k) { var x = s.sessions[k].startTs; if (t == null || x < t) t = x; });
    return t;
  }

  function driverStats(s, sess, now) {
    var out = {};
    ((s.config && s.config.members) || []).filter(function (m) { return m.driver; }).forEach(function (m) {
      out[m.id] = { id: m.id, name: m.name, driveMs: 0, laps: 0, best: null, stints: 0, lastEndTs: null };
    });
    s.drivers.stints.forEach(function (st) {
      if (st.sessionId !== sess.id || !out[st.driverId]) return;
      var o = out[st.driverId];
      o.driveMs += (st.endTs || now) - st.startTs; o.stints++;
      if (st.endTs) o.lastEndTs = Math.max(o.lastEndTs || 0, st.endTs);
    });
    s.laps.forEach(function (l) {
      if (l.sessionId !== sess.id || !out[l.driverId]) return;
      var o = out[l.driverId]; o.laps++;
      if (!l.pitted && (o.best == null || l.ms < o.best)) o.best = l.ms;
    });
    return out;
  }

  function makeCall(s, now, P, sess, pl, nextStop, nextFuel, fuel, stint, ref, inPits, SI) {
    if (!sess.isRace) return { code: 'session', level: 'info', title: sess.name.toUpperCase(), detail: sess.running ? 'Session running' : 'Not started' };
    if (!sess.started) return { code: 'pre', level: 'info', title: 'PRE-RACE', detail: 'Plan built from planned start' };
    if (sess.finished) return { code: 'done', level: 'info', title: 'CHEQUERED', detail: 'Race finished' };
    if (inPits) return { code: 'pits', level: 'info', title: 'IN PITS', detail: 'Service the car - stop timer running' };
    var flag = s.flag.current;
    if (flag === 'RED') return { code: 'red', level: 'crit', title: 'RED FLAG', detail: 'Pit lane, engine off' + (P.refuelAllowed.RED ? '' : ' - no refuelling') };
    var lapsTo = function (ts) { return (ts - now) / ref; };
    if (fuel.nowL - P.reserve <= fuel.lapL * 1.2) return { code: 'box', level: 'crit', title: 'BOX THIS LAP', detail: 'Fuel at reserve (' + fuel.nowL.toFixed(1) + ' L)' };
    if (stint.remainingMs <= ref * 1.2) return { code: 'box', level: 'crit', title: 'BOX THIS LAP', detail: 'Driver at stint limit' };
    var refuelOpen = !!P.refuelAllowed[flag];
    if (SLOW_FLAGS[flag] && nextStop) {
      var soon = nextStop.ts - now < 0.4 * (nextStop.ts - (s.drivers.stintStartTs || now)) || (nextStop.window && now >= nextStop.window.openTs);
      if (soon && (nextStop.add === 0 || refuelOpen)) return { code: 'opp', level: 'warn', title: 'BOX NOW (' + flag + ')', detail: 'Stop under caution loses less time - planned stop is near' };
      if (soon && nextStop.add > 0 && !refuelOpen) return { code: 'hold', level: 'warn', title: 'STAY OUT', detail: 'Refuelling closed under ' + flag };
    }
    if (nextStop) {
      var l = lapsTo(nextStop.ts), lapsLeft = Math.floor(l), mins = (nextStop.ts - now) / MIN;
      var hh = function (t) { var x = new Date(t); return ('0' + x.getHours()).slice(-2) + ':' + ('0' + x.getMinutes()).slice(-2); };
      var what = (nextStop.add ? 'fuel stop, ' + (nextStop.brim ? 'brim ' : '') + nextStop.add + ' L' : nextStop.type + ' stop') + (nextStop.change ? ', ' + memberName(s, nextStop.driverIn) + ' in' : '');
      if (mins <= 5 || l <= 1) {
        // last lap of the allocated stint: the engineer tells the driver (pit board), the geofences take it from there
        if (lapsLeft <= 0) {
          var sent = null; for (var i = s.pitmsgs.length - 1; i >= 0; i--) { var pm = s.pitmsgs[i]; if (/BOX/.test(pm.text || '') && now - pm.ts < 3 * ref) { sent = pm; break; } }
          if (sent) return { code: 'notify', level: 'warn', title: 'BOX THIS LAP', detail: 'BOX BOX sent ' + hh(sent.ts) + (sent.ack ? ' - driver acknowledged' : ' - waiting for the driver to acknowledge') + ' | stop ' + nextStop.k + ': ' + what, sent: true };
          return { code: 'notify', level: 'warn', title: 'NOTIFY DRIVER: BOX BOX', detail: 'Stop ' + nextStop.k + ' at the end of this lap (' + what + ') - send BOX BOX on the pit board', sent: false, stopK: nextStop.k };
        }
        return { code: 'boxin', level: 'warn', title: 'BOX IN ' + lapsLeft + ' LAP' + (lapsLeft > 1 ? 'S' : ''), detail: 'Stop ' + nextStop.k + ' at ~' + hh(nextStop.ts) + ' (' + what + ')' };
      }
      if (nextStop.window && now >= nextStop.window.openTs) return { code: 'window', level: 'warn', title: 'WINDOW OPEN', detail: 'Fuel window closes in ' + Math.round((nextStop.window.closeTs - now) / MIN) + ' min' };
      return { code: 'stay', level: 'ok', title: 'STAY OUT', detail: 'Next stop in ' + Math.round((nextStop.ts - now) / MIN) + ' min (~' + Math.ceil(l) + ' laps)' };
    }
    return { code: 'stay', level: 'ok', title: 'STAY OUT', detail: 'No further stops required' };
  }

  function saveToDrop(P, pl, fuelNow, now, sess, ref, SI) {
    if (!pl || !pl.fuelStops) return null;
    var F = pl.fuelStops, endTs = pl.raceEndTs, t0 = sess.started ? now : sess.startTs;
    var plannedLoss = 0; pl.stops.forEach(function (x) { plannedLoss += x.laneMs + x.statMs; });
    var driveH = Math.max(0.01, (endTs - t0 - plannedLoss) / HOUR);
    var maxAdd = Math.min(P.maxPerStop, P.capacity - P.reserve);
    var avail = fuelNow + (F - 1) * maxAdd;
    var Greq = (avail - P.reserve) / driveH;
    var perLap = (pl.greenRate - Greq) * ref / HOUR;
    var pct = (pl.greenRate - Greq) / pl.greenRate * 100;
    var timeGain = (P.fuelMinMs - Math.max(P.mandMinMs, P.nonFuelMinMs)) / 1000;
    var mandatoryHolds = SI.required - SI.counted >= pl.stops.length;
    return { fuelStops: F, perLapL: perLap, pct: pct, feasible: pct > 0 && pct <= 15, timeGainS: Math.max(0, timeGain), stopCountHeldByRules: mandatoryHolds };
  }

  function alerts(s, d, P) {
    var out = [], now = d.now, sess = d.session;
    var add = function (key, level, text, group) { out.push({ key: key, level: level, text: text, group: group || null }); };
    if (!sess.running) return out;
    var hhmm = function (t) { var x = new Date(t); return ('0' + x.getHours()).slice(-2) + ':' + ('0' + x.getMinutes()).slice(-2); };
    // fuel
    if (d.fuel.nowL <= P.reserve) add('fuel:reserve:' + (d.fuel.model.anchor ? d.fuel.model.anchor.ts : 0), 'crit', 'Fuel at reserve: ' + d.fuel.nowL.toFixed(1) + ' L estimated', 'fuel');
    if (d.plan && d.plan.warnings.length) add('plan:risk:' + Math.floor(now / (15 * MIN)), 'crit', d.plan.warnings[0], 'fuel');
    var dev = d.fuel.model.deviation;
    if (dev && Math.abs(dev.pct) >= 10) add('model:dev:' + dev.ts, dev.pct > 0 ? 'crit' : 'warn', 'Consumption ' + (dev.pct > 0 ? '+' : '') + dev.pct.toFixed(0) + '% vs model over last stint (' + dev.measured.toFixed(1) + ' L vs ' + dev.predicted.toFixed(1) + ' L). Plan updated.', 'fuel');
    // call
    if (d.call.code === 'box') add('call:box:' + (d.nextStop ? d.nextStop.k + ':' + Math.round(d.nextStop.ts / (5 * MIN)) : now), d.call.level, d.call.title + ' - ' + d.call.detail, 'call');
    if (d.call.code === 'opp') add('call:opp:' + s.flag.since, 'warn', d.call.title + ' - ' + d.call.detail, 'call');
    if (d.call.code === 'notify' && !d.call.sent && d.nextStop) add('call:notify:' + d.nextStop.k + ':' + Math.round(d.nextStop.ts / (10 * MIN)), 'warn', 'Notify driver to BOX BOX - stop ' + d.nextStop.k + ' at the end of this lap', 'call');
    // fuel window
    var nf = d.inPits ? null : d.nextFuel;
    if (nf && nf.window) {
      var wk = Math.round(nf.window.closeTs / (10 * MIN));
      if (now >= nf.window.openTs) add('window:open:' + wk, 'warn', 'Fuel window OPEN - closes ' + hhmm(nf.window.closeTs) + ' (lap ~' + d.lapAt(nf.window.closeTs) + ')', 'fuel');
      if (nf.window.closeTs - now <= 5 * MIN && nf.window.closeTs > now) add('window:close5:' + wk, 'crit', 'Fuel window closes in 5 min', 'fuel');
      if (nf.ts - now <= 5 * MIN && nf.ts > now && d.refuelCrew) {
        var names = d.refuelCrew.assign.map(function (a) { return a.label + ': ' + (a.name || 'UNASSIGNED'); }).join(', ');
        add('refuel:summon:' + Math.round(nf.ts / (10 * MIN)), d.refuelCrew.issues.length ? 'crit' : 'warn', 'Refuel crew to the fuel bay - ' + names + '. ' + nf.add + ' L (' + (nf.cans || '-') + ' cans).', 'crew');
      }
      if (!P.refuelAllowed[s.flag.current] && nf.ts - now < 10 * MIN) add('refuel:closed:' + s.flag.since, 'warn', 'Refuelling CLOSED under ' + s.flag.current + ' - fuel stop due in ' + Math.max(0, Math.round((nf.ts - now) / MIN)) + ' min', 'fuel');
    }
    // stint limits
    var st = d.stint;
    if (st.driverId && !d.inPits) {
      var sk = st.driverId + ':' + s.drivers.stintStartTs;
      [[30, 'info'], [15, 'warn'], [5, 'crit']].forEach(function (x) {
        if (st.remainingMs <= x[0] * MIN && st.remainingMs > (x[0] - 5) * MIN) add('stint:' + x[0] + ':' + sk, x[1], st.name + ' reaches the ' + Math.round(P.maxStintMs / MIN) + ' min stint limit in ' + x[0] + ' min', 'driver');
      });
      if (st.remainingMs <= 0) add('stint:max:' + sk, 'crit', st.name + ' is OVER the max stint time', 'driver');
    }
    // next driver prep
    var ns = d.plan && d.plan.stops.filter(function (x) { return x.change; })[0];
    if (ns) {
      P.prepMins.forEach(function (m) {
        var left = ns.ts - now;
        if (left <= m * MIN && left > (m - 5) * MIN) add('prep:' + m + ':' + ns.driverIn + ':' + Math.round(ns.ts / (10 * MIN)), m <= 15 ? 'warn' : 'info',
          'Prepare ' + memberName(s, ns.driverIn) + ': in the car at ~' + hhmm(ns.ts) + ' (' + m + ' min). Kit on, hydrate, get in the zone.', 'driver');
      });
    }
    // crew duty
    d.crew.forEach(function (c) {
      if (c.needsRest && c.status !== 'driving') add('crew:rest:' + c.id + ':' + Math.floor(c.dutyMs / HOUR), 'warn', c.name + ' on duty ' + (c.dutyMs / HOUR).toFixed(1) + ' h - rest required (override available)', 'crew');
    });
    if (s.config.rules && s.config.rules.crew && s.config.rules.crew.raceceiverRequired) {
      var rc = d.crew.filter(function (c) { return c.roles.indexOf('raceceiver') >= 0 && c.status === 'available'; });
      if (!rc.length) add('raceceiver:gap:' + Math.floor(now / (30 * MIN)), 'crit', 'No Raceceiver relay on duty - a dedicated crew member is required at all times', 'crew');
    }
    // open stop
    var os = d.stops.open;
    if (os) {
      var nx = s.issues.filter(function (i) { return i.nextStop && (i.status === 'open' || i.status === 'next-stop'); });
      if (nx.length) add('stop:issues:' + os.id, 'warn', 'Check at this stop: ' + nx.map(function (i) { return i.text; }).join('; '), 'car');
    }
    d.stops.list.forEach(function (x) {
      if (!x.outTs) return;
      if (x.fuelOk === false) add('stop:fuelshort:' + x.id, 'crit', 'Stop ' + x.id + ' fuel time under the ' + Math.round(P.fuelMinMs / MIN) + ' min minimum', 'stop');
      if (P.mandMinMs && !x.counts && x.laneMs > 30000 && d.stops.counted < P.mandCount) add('stop:short:' + x.id, 'warn', 'Stop ' + x.id + ' (' + Math.round(x.laneMs / 1000) + ' s) does NOT count toward the ' + P.mandCount + ' mandatory stops', 'stop');
    });
    return out;
  }

  /* ---------------------------------------------------- shift draft */
  // Draft: drivers on duty around their planned stints and resting in long gaps;
  // other crew split into two alternating groups (role-balanced) for races >= 12 h.
  function draftShifts(s, now, shiftH) {
    var d = derive(s, now);
    var rs = d.raceSession, t0 = rs.startTs, t1 = d.plan ? d.plan.raceEndTs : t0 + rs.durationMs;
    var out = {};
    var members = s.config.members || [];
    members.filter(function (m) { return m.driver; }).forEach(function (m) {
      var stints = s.drivers.stints.filter(function (x) { return x.driverId === m.id && x.sessionId === rs.id; }).map(function (x) { return [x.startTs, x.endTs || now]; })
        .concat((d.plan ? d.plan.stints : []).filter(function (x) { return x.driverId === m.id; }).map(function (x) { return [x.fromTs, x.endTs]; })).sort(function (a, b) { return a[0] - b[0]; });
      // a driver stepping out of the car goes straight to rest from pit-in until he gets ready for his next stint
      var blocks = [], cur = t0 - HOUR, drove = false;
      stints.forEach(function (st) {
        var dutyFrom = st[0] - 45 * MIN, gap = dutyFrom - cur, kind = gap >= 5 * HOUR ? 'sleeping' : 'resting';
        if (drove && gap > 0) blocks.push({ startTs: cur, endTs: dutyFrom, kind: kind, note: 'stepped out - ' + (kind === 'sleeping' ? 'sleep' : 'rest') });
        else if (!drove && gap >= 3 * HOUR) blocks.push({ startTs: cur + 30 * MIN, endTs: dutyFrom - 15 * MIN, kind: kind, note: kind === 'sleeping' ? 'sleep' : 'rest' });
        blocks.push({ startTs: Math.max(cur, dutyFrom), endTs: st[1], kind: 'duty', note: 'stint' });
        cur = st[1]; drove = true;
      });
      if (drove ? t1 > cur : t1 - cur >= 3 * HOUR) blocks.push({ startTs: drove ? cur : cur + 30 * MIN, endTs: drove ? t1 + 30 * MIN : t1 - HOUR, kind: 'resting', note: drove ? 'stepped out - rest' : 'rest' });
      out[m.id] = blocks.filter(function (b) { return b.endTs > b.startTs; });
    });
    var crew = members.filter(function (m) { return !m.driver; });
    var long = (t1 - t0) >= 12 * HOUR;
    var groups = [[], []];
    crew.slice().sort(function (a, b) { return (a.roles || []).join().localeCompare((b.roles || []).join()); }).forEach(function (m, i) { groups[i % 2].push(m); });
    crew.forEach(function (m) {
      if (!long) { out[m.id] = [{ startTs: t0 - HOUR, endTs: t1 + 30 * MIN, kind: 'duty', note: '' }]; return; }
      var g = groups[0].indexOf(m) >= 0 ? 0 : 1, blocks = [], t = t0 - HOUR, k = 0;
      while (t < t1) {
        var end = Math.min(t1 + 30 * MIN, t + (shiftH || 6) * HOUR);
        blocks.push({ startTs: t, endTs: end, kind: (k % 2 === g) ? 'duty' : 'resting', note: 'Group ' + (g ? 'B' : 'A') });
        t = end; k++;
      }
      out[m.id] = blocks;
    });
    // every planned fuel stop: the refuel crew (outgoing driver resting, incoming supervising, the other two
    // fuel-tagged people pouring and on the extinguisher) is on duty from 5 min before pit-in to pit-out
    var kindAt = function (id, t) { var b = (out[id] || []).filter(function (x) { return x.startTs <= t && t < x.endTs; })[0]; return b ? b.kind : 'duty'; };
    (d.plan ? d.plan.stops : []).filter(function (x) { return x.add > 0 && !x.event; }).forEach(function (x) {
      var a = x.ts - 5 * MIN, b = x.ts + x.laneMs + x.statMs, inId = x.change ? x.driverIn : x.driverOut;
      var crew = members.map(function (m) { var k = kindAt(m.id, x.ts); return { id: m.id, name: m.name, roles: m.roles || [], driver: !!m.driver, status: k === 'duty' ? 'available' : k }; });
      var rc = refuelCrew(s, d.P, crew, x.driverOut, inId), used = {};
      rc.assign.forEach(function (r) { if (r.memberId) used[r.memberId] = 1; });
      // a role nobody on duty can fill: call in a tagged member who is resting (then sleeping)
      rc.assign.forEach(function (r) {
        if (r.memberId) return;
        var c = crew.filter(function (c) { return c.roles.indexOf(r.key) >= 0 && !used[c.id] && c.id !== x.driverOut && c.id !== inId && (c.status === 'resting' || c.status === 'sleeping'); })
          .sort(function (p, q) { return (p.status === 'sleeping') - (q.status === 'sleeping'); })[0];
        if (c) { r.memberId = c.id; used[c.id] = 1; }
      });
      rc.assign.forEach(function (r) {
        if (!r.memberId || r.supervise) return;
        var bl = out[r.memberId] || [], add = [];
        // carve the fuel duty out of any rest that overlaps it
        bl = bl.reduce(function (acc, y) {
          if (y.kind === 'duty' || y.endTs <= a || y.startTs >= b) { acc.push(y); return acc; }
          if (y.startTs < a) acc.push({ startTs: y.startTs, endTs: a, kind: y.kind, note: y.note });
          add.push({ startTs: Math.max(a, y.startTs), endTs: Math.min(b, y.endTs), kind: 'duty', note: 'fuel crew - ' + r.label });
          if (y.endTs > b) acc.push({ startTs: b, endTs: y.endTs, kind: y.kind, note: y.note });
          return acc;
        }, []);
        out[r.memberId] = bl.concat(add).sort(function (p, q) { return p.startTs - q.startTs; });
      });
    });
    return out;
  }

  return { derive: derive, draftShifts: draftShifts, fuelPlan: fuelPlan, canSplit: canSplit, scenarioTemplates: scenarioTemplates, defToWhatIf: defToWhatIf, gates: gates, pendingGates: pendingGates, GATE_S: GATE_S, params: params, memberName: memberName, memberById: memberById, MIN: MIN, HOUR: HOUR, refuelCrew: refuelCrew, classifyLap: classifyLap };
});
