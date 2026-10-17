/* Mullaloo Motorsport Engineering - Orb
 * Shared reducer. Every state change is an event in an append-only log;
 * state = reduce(config, events). The server and every browser run this
 * exact file, so live view, replay and what-if can never disagree.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrbReducer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PIT_STATES = ['PIT ENTRY', 'PITS', 'FUELLING'];

  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }

  // Device rename (2.2.9): PLTD -> Agile, BTTM -> Sentinel. Weekends saved before it use the old
  // keys; these shims map them on load so old config.json / events.jsonl files keep working.
  var OLD_DEVICE = { pltd: 'agile', bttm: 'sentinel' };
  var OLD_SRC = { pltd: 'agile', 'pltd-est': 'agile-est', bttm: 'sentinel', BTTM: 'Sentinel' };
  function migrateDevices(dv) {
    if (!dv || typeof dv !== 'object') return dv;
    Object.keys(OLD_DEVICE).forEach(function (o) {
      var n = OLD_DEVICE[o];
      if (dv[o] !== undefined) { if (dv[n] === undefined) dv[n] = dv[o]; delete dv[o]; }
    });
    return dv;
  }
  function migrateConfig(cfg) { if (cfg && cfg.devices) migrateDevices(cfg.devices); return cfg; }
  function migrateEvent(e) {
    if (!e) return e;
    if (OLD_SRC[e.src]) e.src = OLD_SRC[e.src];
    if (e.type === 'bttm.alarm') e.type = 'sentinel.alarm';
    var p = e.payload;
    if (p) {
      if (OLD_SRC[p.src]) p.src = OLD_SRC[p.src];
      if (p.patch && p.patch.devices) migrateDevices(p.patch.devices);
    }
    return e;
  }

  function merge(target, patch) {
    Object.keys(patch || {}).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        merge(target[k], v);
      } else {
        target[k] = clone(v);
      }
    });
    return target;
  }

  function initialState(config) {
    var cfg = clone(config);
    var tyreSets = {};
    ((cfg.tyres && cfg.tyres.sets) || []).forEach(function (t) {
      tyreSets[t.id] = { id: t.id, name: t.name, status: 'new', fitted: [], measures: [] };
    });
    return {
      config: cfg,
      seq: 0,
      lastTs: null,
      sessions: {},                 // id -> {startTs, endTs, startFuelL}
      activeSessionId: null,
      flag: { current: 'GREEN', since: null, history: [] },
      carState: { current: 'UNKNOWN', since: null, history: [] },
      laps: [],
      stops: [],
      openStopId: null,
      fuel: { anchors: [], refuels: [], checks: [] },
      drivers: { activeId: null, stintStartTs: null, stints: [], queue: clone(cfg.driverOrder || []), pendingIn: null },
      crew: { status: {}, shifts: {}, overrides: {} },
      issues: [],
      tyres: { mounted: null, sets: tyreSets },
      pitmsgs: [],
      alerts: [],
      notes: [],
      penalties: [],
      sentinelAlarms: [],
      acks: {},
      gates: {},                     // 'P3:entry' -> {ts, by:'human'|'auto'}
      scenarios: { active: 'A', plans: {}, order: [] }
    };
  }

  function activeSession(s) { return s.activeSessionId ? s.sessions[s.activeSessionId] : null; }

  function openStop(s, ts, src) {
    var st = { id: 'P' + (s.stops.length + 1), sessionId: s.activeSessionId, inTs: ts, outTs: null,
      fuelInTs: null, fuelOutTs: null, statInTs: null, statOutTs: null, src: src || null,
      driverOut: s.drivers.activeId, service: null, penalty: null };
    s.stops.push(st);
    s.openStopId = st.id;
    return st;
  }

  function findStop(s, id) {
    for (var i = s.stops.length - 1; i >= 0; i--) if (s.stops[i].id === id) return s.stops[i];
    return null;
  }

  function startStint(s, driverId, ts) {
    var d = s.drivers;
    if (d.activeId && d.stints.length && d.stints[d.stints.length - 1].endTs == null) {
      d.stints[d.stints.length - 1].endTs = ts;
    }
    d.activeId = driverId;
    d.stintStartTs = ts;
    if (driverId) d.stints.push({ driverId: driverId, startTs: ts, endTs: null, sessionId: s.activeSessionId });
  }

  // Time behind the wheel: outgoing driver stops when the car stops, incoming starts when it leaves the box.
  function driverSwap(s, st, driverIn) {
    var d = s.drivers;
    var outEnd = st.statInTs || st.inTs;
    if (d.stints.length && d.stints[d.stints.length - 1].endTs == null) d.stints[d.stints.length - 1].endTs = outEnd;
    d.activeId = null;
    startStint(s, driverIn, st.statOutTs || st.outTs);
  }

  function closeStop(s, st, ts) {
    st.outTs = ts;
    if (st.statInTs && !st.statOutTs) st.statOutTs = ts;
    if (st.fuelInTs && !st.fuelOutTs) st.fuelOutTs = ts;
    s.openStopId = null;
    if (s.drivers.pendingIn) {
      if (s.drivers.pendingIn !== s.drivers.activeId) driverSwap(s, st, s.drivers.pendingIn);
      s.drivers.pendingIn = null;
    }
  }

  function tyreUnmount(s, ts) {
    var m = s.tyres.mounted;
    if (!m || !s.tyres.sets[m]) return;
    var set = s.tyres.sets[m];
    var last = set.fitted[set.fitted.length - 1];
    if (last && last.offTs == null) last.offTs = ts;
    set.status = 'used';
    s.tyres.mounted = null;
  }

  function tyreMount(s, setId, ts) {
    if (!s.tyres.sets[setId]) return;
    tyreUnmount(s, ts);
    var set = s.tyres.sets[setId];
    set.fitted.push({ onTs: ts, offTs: null });
    set.status = 'fitted';
    s.tyres.mounted = setId;
  }

  function apply(s, e) {
    var p = e.payload || {};
    var ts = e.ts;
    s.seq = e.seq;
    s.lastTs = ts;
    switch (e.type) {
      case 'setup.update': {
        merge(s.config, p.patch || {});
        if (p.patch && p.patch.driverOrder) s.drivers.queue = clone(p.patch.driverOrder);
        if (p.patch && p.patch.tyres && p.patch.tyres.sets) {
          p.patch.tyres.sets.forEach(function (t) {
            if (!s.tyres.sets[t.id]) s.tyres.sets[t.id] = { id: t.id, name: t.name, status: 'new', fitted: [], measures: [] };
            else s.tyres.sets[t.id].name = t.name;
          });
        }
        break;
      }
      case 'session.start': {
        s.sessions[p.sessionId] = { startTs: ts, endTs: null, startFuelL: p.startFuelL };
        s.activeSessionId = p.sessionId;
        if (p.startFuelL != null) s.fuel.anchors.push({ ts: ts, before: p.startFuelL, after: p.startFuelL, kind: 'start', w: 1, sessionId: p.sessionId });
        startStint(s, p.driverId || s.drivers.queue[0] || null, ts);
        if (p.tyreSetId) tyreMount(s, p.tyreSetId, ts);
        s.flag.current = 'GREEN'; s.flag.since = ts; s.flag.history.push({ flag: 'GREEN', ts: ts });
        break;
      }
      case 'session.end': {
        var ss = s.sessions[p.sessionId];
        if (ss) ss.endTs = ts;
        var d = s.drivers;
        if (d.stints.length && d.stints[d.stints.length - 1].endTs == null) d.stints[d.stints.length - 1].endTs = ts;
        if (s.openStopId) closeStop(s, findStop(s, s.openStopId), ts);
        if (s.activeSessionId === p.sessionId) s.activeSessionId = null;
        d.activeId = null; d.stintStartTs = null;
        break;
      }
      case 'flag.set': {
        if (p.flag && p.flag !== s.flag.current) {
          s.flag.current = p.flag; s.flag.since = ts;
          s.flag.history.push({ flag: p.flag, ts: ts, src: e.src || null });
        }
        break;
      }
      case 'carstate': {
        var cs = p.cs, prev = s.carState.current;
        if (cs === prev) break;
        s.carState.current = cs; s.carState.since = ts;
        s.carState.history.push({ cs: cs, ts: ts, src: e.src || null });
        if (!s.activeSessionId) break;
        var st = s.openStopId ? findStop(s, s.openStopId) : null;
        if (PIT_STATES.indexOf(cs) >= 0 && !st) st = openStop(s, ts, e.src);
        if (st) {
          // geofence side of the stop handshake: only states reported by the car (Agile / UDP), not engineer overrides
          if (e.src === 'agile' || e.src === 'udp') {
            var geo = st.geo || (st.geo = {});
            if (PIT_STATES.indexOf(cs) >= 0 && !geo.entry) geo.entry = ts;     // any pit state proves the car is in the lane
            if (cs === 'FUELLING' && !geo.fuelIn) geo.fuelIn = ts;
            if (prev === 'FUELLING' && cs !== 'FUELLING' && geo.fuelIn && !geo.fuelOut) geo.fuelOut = ts;
            if ((cs === 'PIT EXIT' || cs === 'RUNNING') && !geo.exit) geo.exit = ts;
          }
          if ((cs === 'PITS' || cs === 'FUELLING') && !st.statInTs) st.statInTs = ts;
          if (cs === 'FUELLING' && !st.fuelInTs) st.fuelInTs = ts;
          if (prev === 'FUELLING' && cs !== 'FUELLING' && !st.fuelOutTs) st.fuelOutTs = ts;
          if (cs === 'PIT EXIT' || cs === 'RUNNING') {
            if (st.statInTs && !st.statOutTs) st.statOutTs = ts;
            closeStop(s, st, ts);
          }
        }
        break;
      }
      case 'lap': {
        s.laps.push({ n: p.n, ms: p.ms, ts: ts, pitted: !!p.pitted, delta: p.delta, src: e.src || null,
          sessionId: s.activeSessionId, driverId: s.drivers.activeId, flag: s.flag.current, tyreSetId: s.tyres.mounted, peaks: p.peaks || null });
        break;
      }
      case 'stop.service': {
        var stp = p.stopId ? findStop(s, p.stopId) : (s.openStopId ? findStop(s, s.openStopId) : s.stops[s.stops.length - 1]);
        if (!stp) break;
        if (stp.service) {
          s.fuel.anchors = s.fuel.anchors.filter(function (a) { return a.stopId !== stp.id; });
          s.fuel.refuels = s.fuel.refuels.filter(function (r) { return r.stopId !== stp.id; });
        }
        stp.service = clone(p);
        stp.service.ts = ts;
        var refTs = stp.fuelInTs || ts;
        if (p.fuelAdded > 0) {
          if (p.brimmed) {
            var cap = p.capacityL;
            s.fuel.anchors.push({ ts: refTs, before: Math.max(0, cap - p.fuelAdded), after: cap, kind: 'brim', w: 1, sessionId: stp.sessionId, stopId: stp.id });
          } else if (p.fuelBeforeL != null) {
            s.fuel.anchors.push({ ts: refTs, before: p.fuelBeforeL, after: p.fuelBeforeL + p.fuelAdded, kind: 'check+refuel', w: 0.5, sessionId: stp.sessionId, stopId: stp.id });
          } else {
            s.fuel.refuels.push({ ts: refTs, litres: p.fuelAdded, stopId: stp.id, sessionId: stp.sessionId });
          }
        } else if (p.fuelBeforeL != null) {
          s.fuel.anchors.push({ ts: refTs, before: p.fuelBeforeL, after: p.fuelBeforeL, kind: 'check', w: 0.5, sessionId: stp.sessionId, stopId: stp.id });
        }
        if (p.penalty) stp.penalty = p.penalty;
        if (p.driverIn && p.driverIn !== s.drivers.activeId) {
          if (stp.outTs) driverSwap(s, stp, p.driverIn);
          else s.drivers.pendingIn = p.driverIn;
        }
        if (p.tyreOn) {
          if (p.tyreOffDepths && s.tyres.mounted) s.tyres.sets[s.tyres.mounted].measures.push({ ts: ts, depths: p.tyreOffDepths });
          tyreMount(s, p.tyreOn, stp.outTs || ts);
        }
        (p.issuesFixed || []).forEach(function (id) {
          s.issues.forEach(function (it) { if (it.id === id) { it.status = 'fixed'; it.closedTs = ts; it.log.push({ ts: ts, note: 'Fixed at stop ' + stp.id }); } });
        });
        break;
      }
      case 'fuel.check': {
        s.fuel.anchors.push({ ts: ts, before: p.litres, after: p.litres, kind: 'check', w: p.weight != null ? p.weight : 0.5, sessionId: s.activeSessionId, note: p.note });
        break;
      }
      case 'fuel.refuel': {
        s.fuel.refuels.push({ ts: ts, litres: p.litres, sessionId: s.activeSessionId, note: p.note });
        break;
      }
      case 'driver.set': {
        startStint(s, p.driverId, ts);
        break;
      }
      case 'driver.queue': {
        s.drivers.queue = clone(p.order || []);
        break;
      }
      case 'crew.status': {
        if (p.status === 'auto') delete s.crew.status[p.memberId];
        else s.crew.status[p.memberId] = { status: p.status, reason: p.reason || '', since: ts };
        break;
      }
      case 'crew.shifts': {
        s.crew.shifts[p.memberId] = clone(p.blocks || []);
        break;
      }
      case 'crew.shiftsAll': {
        s.crew.shifts = clone(p.shifts || {});
        break;
      }
      case 'crew.override': {
        s.crew.overrides[p.memberId] = { untilTs: p.untilTs, reason: p.reason || 'contingency', ts: ts };
        break;
      }
      case 'issue.add': {
        s.issues.push({ id: 'I' + e.seq, ts: ts, cat: p.cat || 'other', sev: p.sev || 'warn', text: p.text || '',
          src: p.src || 'manual', corner: p.corner || null, nextStop: !!p.nextStop, status: 'open', closedTs: null,
          log: [{ ts: ts, note: 'Logged' + (p.src && p.src !== 'manual' ? ' by ' + p.src : '') }] });
        break;
      }
      case 'issue.update': {
        s.issues.forEach(function (it) {
          if (it.id !== p.id) return;
          if (p.status) { it.status = p.status; if (p.status === 'fixed' || p.status === 'closed') it.closedTs = ts; }
          if (p.nextStop != null) it.nextStop = !!p.nextStop;
          if (p.sev) it.sev = p.sev;
          it.log.push({ ts: ts, note: p.note || ('Status ' + (p.status || (p.nextStop ? 'flagged for next stop' : 'updated'))) });
        });
        break;
      }
      case 'tyre.mount': tyreMount(s, p.setId, ts); break;
      case 'tyre.unmount': tyreUnmount(s, ts); break;
      case 'tyre.measure': {
        var set = s.tyres.sets[p.setId];
        if (set) set.measures.push({ ts: ts, depths: p.depths, note: p.note || '' });
        break;
      }
      case 'tyre.status': {
        if (s.tyres.sets[p.setId]) s.tyres.sets[p.setId].status = p.status;
        break;
      }
      case 'pitmsg.send': {
        s.pitmsgs.push({ ts: ts, text: p.text, pri: p.pri || 0, kind: p.kind || 'msg', on: p.on, deviceId: null, ack: null, by: e.by });
        break;
      }
      case 'pitmsg.shown': {
        for (var i = s.pitmsgs.length - 1; i >= 0; i--) if (s.pitmsgs[i].kind === 'msg' && s.pitmsgs[i].deviceId == null) { s.pitmsgs[i].deviceId = p.id; break; }
        break;
      }
      case 'pitmsg.ack': {
        s.pitmsgs.forEach(function (m) { if (m.deviceId === p.id) m.ack = { by: p.by, ts: ts }; });
        break;
      }
      case 'stint.extend': {
        // engineer keeps the car out past the called stop; the planner pins the stop at untilTs until the car next pits
        s.stintExt = { ts: ts, untilTs: p.untilTs, laps: p.laps || 1, add: p.add || 0, driverIn: p.driverIn || null, stopK: p.stopK || null };
        break;
      }
      case 'penalty.add': {
        s.penalties.push({ ts: ts, kind: p.kind, minutes: p.minutes || 0, driverId: p.driverId || s.drivers.activeId, reason: p.reason || '', blackFlag: !!p.blackFlag });
        break;
      }
      case 'note': s.notes.push({ ts: ts, text: p.text, by: e.by }); break;
      case 'alert': s.alerts.push({ ts: ts, key: p.key, level: p.level, text: p.text, group: p.group || null }); break;
      case 'alert.ack': s.acks[p.key] = { ts: ts, by: e.by }; break;
      case 'gate.ack': {
        s.gates[p.stopId + ':' + p.gate] = { ts: ts, by: p.auto ? 'auto' : 'human', note: p.note || '', plan: p.plan ? clone(p.plan) : null, driverIn: p.driverIn || null };
        if (p.gate === 'fuelon' && !p.auto) {
          // FUEL ON from the engineer: the crew is pouring. If the fuel-zone geofence has not fired, the fuelling clock starts now.
          var fs = findStop(s, p.stopId);
          if (fs && !fs.outTs && !fs.fuelInTs) { fs.fuelInTs = ts; if (!fs.statInTs) fs.statInTs = ts; }
        }
        if (p.gate === 'driver' && p.driverIn && p.driverIn !== s.drivers.activeId) {
          var gs = findStop(s, p.stopId);
          if (gs && !gs.voided) { if (gs.outTs) driverSwap(s, gs, p.driverIn); else s.drivers.pendingIn = p.driverIn; }
        }
        break;
      }
      case 'stop.void': {
        var vs = findStop(s, p.stopId);
        if (vs) {
          vs.voided = true; vs.voidReason = p.reason || 'not a stop';
          if (!vs.outTs) { vs.outTs = ts; if (s.openStopId === vs.id) s.openStopId = null; }
          s.fuel.anchors = s.fuel.anchors.filter(function (a) { return a.stopId !== vs.id; });
          s.fuel.refuels = s.fuel.refuels.filter(function (r) { return r.stopId !== vs.id; });
          s.drivers.pendingIn = null;
        }
        break;
      }
      case 'scenario.init': {
        (p.plans || []).forEach(function (pl) {
          if (s.scenarios.plans[pl.id]) return;
          s.scenarios.plans[pl.id] = { id: pl.id, name: pl.name, desc: pl.desc, orig: clone(pl.def), cur: clone(pl.def), createdTs: ts };
          s.scenarios.order.push(pl.id);
        });
        break;
      }
      case 'scenario.set': { var sp = s.scenarios.plans[p.id]; if (sp) sp.cur = clone(p.def); break; }
      case 'scenario.reset': { var rp = s.scenarios.plans[p.id]; if (rp) rp.cur = clone(rp.orig); break; }
      case 'scenario.activate': { if (s.scenarios.plans[p.id] || p.id === 'A') s.scenarios.active = p.id; break; }
      case 'sentinel.alarm': s.sentinelAlarms.push({ ts: ts, corner: p.corner, kind: p.kind, value: p.value, level: p.level }); break;
      default: break;
    }
    return s;
  }

  function reduce(config, events, uptoTs) {
    var s = initialState(config);
    for (var i = 0; i < events.length; i++) {
      if (uptoTs != null && events[i].ts > uptoTs) break;
      apply(s, events[i]);
    }
    return s;
  }

  return { initialState: initialState, apply: apply, reduce: reduce, merge: merge, clone: clone, migrateConfig: migrateConfig, migrateEvent: migrateEvent, PIT_STATES: PIT_STATES, activeSession: activeSession };
});
