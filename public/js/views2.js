/* Orb views.
   Hierarchy (ISA-101 style): Race = overview (L1) | Plan, Team, Car = areas (L2) | detail in-place (L3) | Log = diagnostics (L4).
   Rule: every datum has one home. The status bar carries lap, car state, flag and clocks; nothing below repeats them. */
(function () {
  'use strict';
  var U = window.U, E = window.OrbEngine;
  var V = {}, esc = U.esc, MIN = 60000, HOUR = 3600000;

  function name(ctx, id) { return id ? E.memberName(ctx.s, id) : '-'; }
  function dis(ctx) { return ctx.eng ? '' : ' disabled'; }
  function card(title, body, hint, cls) { return '<div class="card ' + (cls || '') + '"><h3><span>' + title + '</span>' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</h3>' + body + '</div>'; }
  function pct(v, max) { return Math.max(0, Math.min(100, v / max * 100)); }
  function stopType(t) { return { fuel: 'Fuel stop', driver: 'Driver change', mandatory: 'Mandatory stop', service: 'Service stop', penalty: 'Penalty', stop: 'Stop', red: 'Red flag (parked)' }[t] || t; }
  V.CS_COLOUR = { 'RUNNING': '#00C846', 'PIT ENTRY': '#FFA500', 'PITS': '#4fc3f7', 'FUELLING': '#CE93D8', 'PIT EXIT': '#FFD54F' };
  V.csClass = function (cs) { return 'cs cs-' + String(cs || 'UNKNOWN').replace(/\s/g, ''); };

  // analog gauge: o = {label, tip, val, unit, sub, fill(0-100), cls, marks:[{at,cls,title}], band:[a,b], win:[a,b], now, foot:[left,right]}
  function gauge(o) {
    var h = '<div class="gauge"' + (o.tip ? ' data-tip="' + o.tip + '"' : '') + '><div class="top"><span class="lbl">' + o.label + '</span><span class="val">' + o.val + (o.unit ? ' <small>' + o.unit + '</small>' : '') + '</span></div><div class="track">';
    if (o.win) h += '<div class="win" style="left:' + o.win[0] + '%;width:' + Math.max(0.6, o.win[1] - o.win[0]) + '%"></div>';
    if (o.fill != null) h += '<div class="fill ' + (o.cls || '') + '" style="width:' + o.fill.toFixed(1) + '%"></div>';
    if (o.band) h += '<div class="unc" style="left:' + o.band[0] + '%;width:' + Math.max(0, o.band[1] - o.band[0]) + '%"></div>';
    (o.marks || []).forEach(function (m) { h += '<div class="mark ' + (m.cls || '') + '" style="left:' + m.at + '%" title="' + esc(m.title || '') + '"></div>'; });
    if (o.now != null) h += '<div class="now" style="left:' + o.now + '%"></div>';
    h += '</div>' + (o.foot ? '<div class="foot"><span>' + o.foot[0] + '</span><span>' + (o.foot[1] || '') + '</span></div>' : '') + '</div>';
    return h;
  }
  // icon = status, refined for available people: jerry can if on the next refuel crew, spanner for mechanics in the garage
  function iconKey(ctx, c) {
    if (!c) return 'offline';
    if (c.status !== 'available') return c.status;
    var rc = ctx.d.refuelCrew;
    if (rc && rc.assign.some(function (a) { return a.memberId === c.id; })) return 'refuel';
    if ((c.roles || []).indexOf('mechanic') >= 0) return 'mechanic';
    return 'available';
  }
  V.iconKey = iconKey;
  function fixBtn(ctx) { return ctx.eng ? ' <button class="btn sm danger" data-act="crewfix">FIX</button>' : ''; }
  function crewLines(rc, ctx) {
    return '<div class="crew-line">' + rc.assign.map(function (a) {
      return '<span class="r">' + esc(a.label.replace(' (9 kg foam)', '')) + '</span><span>' + (a.name ? '<b>' + esc(a.name) + '</b>' : '<b class="crit-t">UNASSIGNED</b>' + (ctx ? fixBtn(ctx) : '') + ' <span class="tiny muted">' + esc(a.reason || '') + (a.suggest && a.suggest.length ? ' - available: ' + esc(a.suggest.join(', ')) : '') + '</span>') + '</span>';
    }).join('') + '</div>';
  }
  function pitTarget(d) { var os = d.stops.open, last = d.stops.list[d.stops.list.length - 1]; return os || (last && !last.serviced ? last : null); }
  function plannedFor(d, target) { return d.nextStop && target && Math.abs(d.nextStop.ts - target.inTs) < 20 * MIN ? d.nextStop : (d.plan && d.plan.stops[0]); }

  /* ================================================================== RACE (overview) */
  V.race = function (ctx) {
    var d = ctx.d, colB = [];
    var target = pitTarget(d);
    if (d.gates || stopDue(d)) colB.push(panelGate(ctx));
    if (ctx.eng && d.gates) {
      var fs = d.gates.list.filter(function (x) { return x.id === 'fuel'; })[0], pi = d.gates.list[0];
      if (pi.state === 'done' && (fs.state !== 'done' || ctx.svcFix === d.gates.stop.id)) colB.push(panelGateFuel(ctx));
    }
    if (target) colB.push(panelPitTimers(ctx, target));
    else if (!d.gates || d.gates.done) colB.push(panelNext(ctx));
    var colC = [panelMap(ctx)];
    if (ctx.eng) colC.push(panelControl(ctx));
    colC.push(panelFeed(ctx));
    var colA = [panelNow(ctx), panelTelemetry(ctx)];
    return { layout: 'race', cols: [colA, colB, colC] };
  };

  // NOW: the call, fuel, active driver, on deck, garage
  function panelNow(ctx) {
    var d = ctx.d, s = ctx.s, c = d.call, f = d.fuel, m = f.model, st = d.stint, P = d.P;
    var x = ctx.eng && c.code === 'notify' && c.extend;
    var extBtn = x ? '<button class="btn ext-lap" data-act="extendlap"' + (x.ok ? ' title="Keep the driver out one more lap - the stop and every plan move one lap later"' : ' disabled title="Cannot extend: ' + esc(x.why) + '"') + '><span class="n">+1</span><span class="u">lap</span></button>' : '';
    var h = '<div class="call ' + c.level + '">' + extBtn + '<div class="title">' + esc(c.title) + '</div><div class="detail">' + esc(c.detail) + '</div>' +
      (ctx.eng && c.code === 'notify' && !c.sent ? '<div class="row" style="margin-top:8px"><button class="btn primary" data-act="pitmsg" data-text="BOX BOX">Send BOX BOX to the driver</button></div>' : '') + '</div>';
    // fuel gauge: level vs capacity, reserve mark, uncertainty band, planned arrival at next fuel stop
    var cap = f.capacity, lvl = Math.max(0, f.nowL), unc = f.uncertaintyL || 0;
    var low = f.nowL - f.reserve <= f.lapL * 3, warnL = f.nowL - f.reserve <= f.lapL * 8;
    var marks = [{ at: pct(f.reserve, cap), title: 'Reserve ' + f.reserve + ' L' }];
    if (d.nextFuel) marks.push({ at: pct(d.nextFuel.fuelArr, cap), cls: 'plan', title: 'Planned arrival at stop ' + d.nextFuel.k + ': ' + U.L(d.nextFuel.fuelArr) + ' L' });
    h += gauge({ label: 'Fuel on board', tip: 'kpi:Fuel on board', val: U.L(lvl), unit: 'L' + (unc ? ' &plusmn;' + U.L(unc) : ''), fill: pct(lvl, cap), cls: low ? 'crit' : warnL ? 'warn' : 'fuelc',
      band: unc ? [pct(lvl - unc, cap), pct(lvl + unc, cap)] : null, marks: marks,
      foot: [U.L(f.lapsToReserve, 0) + ' laps / ' + U.mins(f.msToReserve) + ' to reserve', U.L(m.G, 2) + ' L/h ' + (m.nCal ? 'learned (' + m.nCal + ')' : 'baseline')] });
    if (ctx.eng && d.session.running) h += '<div class="row" style="margin-top:6px"><button class="btn sm" data-act="gauge">Log gauge reading</button></div>';
    // drivers
    h += '<div class="sep"></div><span class="lbl">' + (st.waiting ? 'In the car - timer starts at pit out' : 'Driving now') + '</span><div class="drv-now" style="margin-top:4px"><span class="cdot" style="background:' + U.driverColour(s, st.driverId) + '"></span><span class="name">' + esc(st.name || '-') + '</span><span class="spacer"></span>' +
      (st.outgoing ? '<span class="small muted">' + esc(st.outgoing.name) + ' out after ' + U.dur(st.outgoing.elapsedMs, true) + '</span>' : (st.frozen ? '<span class="small muted">stint paused in the pits</span>' : '')) + '</div>';
    var rem = st.remainingMs, scls = rem < 5 * MIN ? 'crit' : rem < 15 * MIN ? 'warn' : '';
    h += gauge({ label: 'Stint', tip: 'kpi:Stint', val: U.dur(st.elapsedMs, true), unit: '/ ' + U.dur(st.maxMs, true), fill: pct(st.elapsedMs, st.maxMs), cls: scls,
      marks: [{ at: pct(st.maxMs - 15 * MIN, st.maxMs), title: '15 min warning' }], foot: [U.dur(Math.max(0, rem), true) + ' left', ''] });
    var crew = {}; d.crew.forEach(function (x) { crew[x.id] = x; });
    var od = d.onDeck, ns = d.plan && d.plan.stops.filter(function (x) { return x.change; })[0];
    var q = (s.drivers.queue || []).filter(function (id) { return id !== s.drivers.activeId && id !== od; });
    if (od) h += '<div class="sep"></div><span class="lbl">Up next</span><div class="row" style="margin-top:4px">' + U.presence(iconKey(ctx, crew[od])) + '<span class="cdot" style="background:' + U.driverColour(s, od) + '"></span><b style="font-size:1.1em">' + esc(name(ctx, od)) + '</b><span class="spacer"></span><span class="small muted">' + (ns ? 'in the car ~' + U.clock(ns.ts) + ' (' + U.mins(ns.ts - d.now) + ')' : '') + '</span></div>';
    if (q.length) h += '<div class="chipline">' + q.map(function (id) {
      var tag = ctx.eng ? 'button data-act="makeondeck" data-id="' + id + '" title="Make up next"' : 'span';
      return '<' + tag + ' class="pchip">' + U.presence(iconKey(ctx, crew[id])) + esc(U.short(name(ctx, id))) + '</' + tag.split(' ')[0] + '>';
    }).join('') + '</div><div class="tiny muted" style="margin-top:4px">In the garage, rotation order' + (ctx.eng ? ' - click a name to make them up next' : '') + '</div>';
    return { id: 'now', html: card('Now', h) };
  }

  function panelNext(ctx) {
    var d = ctx.d, s = ctx.s, ns = d.nextStop, P = d.P;
    var manual = ctx.eng && d.session.running && !(ctx.devices.agile && ctx.devices.agile.status === 'connected') ? manualStates(ctx) : '';
    if (!ns) return { id: 'next', html: card('Next stop', '<div class="muted">No further stops planned.</div>' + manual) };
    var total = d.plan.stops.length, si = d.stops;
    var h = '<div class="ns-head"><span class="what ' + (ns.add ? 'purple-t' : '') + '">' + stopType(ns.type) + '</span><span class="when">' + U.clock(ns.ts) + '</span></div>' +
      '<div class="row small muted"><span>in ' + U.mins(ns.ts - d.now) + ', lap ~' + d.lapAt(ns.ts) + '</span><span class="spacer"></span><span>' + total + ' stop' + (total > 1 ? 's' : '') + ' to go, ' + d.plan.fuelStops + ' fuel' + (si.required ? ' | mandatory ' + si.counted + '/' + si.required : '') + '</span></div>';
    h += '<div class="facts">' +
      '<div class="fact" data-tip="kpi:Fuel"><span class="lbl">Fuel</span><div class="v">' + (ns.add ? (ns.brim ? 'Brim ' : '') + ns.add + ' L' : 'none') + '</div><div class="s">' + (ns.add ? ns.cans + ' x ' + (P.method ? P.method.canL : '-') + ' L cans' : 'arrive ' + U.L(ns.fuelArr) + ' L') + '</div></div>' +
      '<div class="fact" data-tip="kpi:Driver"><span class="lbl">Driver</span><div class="v">' + (ns.change ? esc(U.short(name(ctx, ns.driverIn))) : 'stays') + '</div><div class="s">' + (ns.change ? esc(name(ctx, ns.driverOut)) + ' out' : esc(name(ctx, ns.driverOut))) + '</div></div>' +
      '<div class="fact" data-tip="kpi:Stationary"><span class="lbl">Stationary</span><div class="v">' + U.mins(ns.statMs) + '</div><div class="s">' + (ns.counts ? 'counts as mandatory' : '&nbsp;') + '</div></div></div>';
    if (ns.window) {
      var a = Math.min(ns.window.openTs, d.now), b = Math.max(ns.window.closeTs, ns.ts) + 2 * MIN, span = b - a;
      var x = function (t) { return pct(t - a, span); };
      h += gauge({ label: 'Fuel window', tip: 'kpi:Window', val: U.clock(ns.window.openTs) + '-' + U.clock(ns.window.closeTs), win: [x(ns.window.openTs), x(ns.window.closeTs)],
        marks: [{ at: x(ns.ts), cls: 'plan', title: 'Planned ' + U.clock(ns.ts) }], now: x(d.now), foot: ['laps ' + d.lapAt(ns.window.openTs) + '-' + d.lapAt(ns.window.closeTs), d.now >= ns.window.openTs ? '<span class="warn-t">open</span>' : 'opens in ' + U.mins(ns.window.openTs - d.now)] });
    }
    if (ns.add && d.refuelCrew) h += '<div class="sep"></div><span class="lbl">Refuel crew (' + esc(P.method ? P.method.label : '') + ')</span>' + crewLines(d.refuelCrew, ctx);
    return { id: 'next', html: card('Next stop', h + manual, 'stop ' + ns.k) };
  }

  function manualStates(ctx) {
    var cs = ctx.s.carState.current;
    var agileOn = ctx.devices.agile && ctx.devices.agile.status === 'connected';
    return '<div class="sep"></div><span class="lbl">Manual car state ' + (agileOn ? '(override if a geofence is missed)' : '(Agile offline)') + '</span><div class="seg" style="margin-top:4px">' + [['PIT ENTRY', 'Pit in'], ['FUELLING', 'Fuel on'], ['PITS', 'Fuel off'], ['PIT EXIT', 'Pit out'], ['RUNNING', 'Running']].map(function (b) {
      return '<button class="btn sm' + (cs === b[0] ? ' active' : '') + '" data-act="carstate" data-cs="' + b[0] + '">' + b[1] + '</button>';
    }).join('') + '</div>' + (ctx.d.session.running ? ' <button class="btn sm" data-act="manuallap" style="margin-top:6px">Manual lap (S/F now)</button>' : '');
  }

  function panelPitTimers(ctx, t) {
    var d = ctx.d, P = d.P, s = ctx.s;
    var lane = (t.outTs || d.now) - t.inTs, fuelMs = t.fuelMs, ps = (d.gates && d.gates.stop.id === t.id && d.gates.planned) || plannedFor(d, t);
    var svc = t.raw && t.raw.service, gdr = d.gates && d.gates.driverAck;
    var h = '<div class="ns-head"><span class="what">Pit stop ' + t.id + '</span><span class="when">' + (t.open ? 'IN PROGRESS' : 'DONE') + '</span></div>';
    if (ps) h += '<div class="small muted">Planned at pit in: ' + stopType(ps.type) + (ps.add ? ', ' + (ps.brim ? 'brim ' : '') + ps.add + ' L' : ', no fuel') + (ps.change ? ', ' + esc(name(ctx, ps.driverIn)) + ' in' : '') + '</div>';
    if (svc || gdr) h += '<div class="small">Recorded: ' + (svc ? (svc.fuelAdded > 0 ? svc.fuelAdded + ' L' + (svc.brimmed ? ' brim' : '') : 'no fuel') : 'fuel not yet') + (gdr ? ', ' + (gdr.driverIn ? esc(name(ctx, gdr.driverIn)) + ' in' : 'no driver change') : '') + '</div>';
    if (svc && !(svc.fuelAdded > 0)) h += '<div class="note" style="margin-top:8px">No fuel recorded for this stop: the fuelling minimum does not apply and the fuel-bay geofence is ignored.</div>';
    else if (P.fuelMinMs) h += gauge({ label: 'Fuelling vs ' + Math.round(P.fuelMinMs / MIN) + ' min minimum', tip: 'kpi:Fuelling', val: fuelMs != null ? U.dur(fuelMs) : '-', fill: fuelMs != null ? pct(fuelMs, P.fuelMinMs) : 0, cls: fuelMs != null && fuelMs < P.fuelMinMs ? 'warn' : '',
      foot: [fuelMs == null ? 'not started' : fuelMs >= P.fuelMinMs ? '<span class="ok-t">minimum met</span>' : U.dur(P.fuelMinMs - fuelMs) + ' to go', ''] });
    h += gauge({ label: P.mandMinMs ? 'Pit lane vs ' + Math.round(P.mandMinMs / MIN) + ' min mandatory' : 'Pit lane', tip: 'kpi:In pit lane', val: U.dur(lane), fill: P.mandMinMs ? pct(lane, P.mandMinMs) : 100, cls: P.mandMinMs && lane < P.mandMinMs ? 'warn' : '',
      foot: [P.mandMinMs ? (lane >= P.mandMinMs ? '<span class="ok-t">counts</span>' : U.dur(P.mandMinMs - lane) + ' to count') : 'no minimum for this stop', ''] });
    if (!P.refuelAllowed[s.flag.current]) h += '<div class="note warn" style="margin-top:8px">Refuelling CLOSED under ' + esc(s.flag.current) + '</div>';
    var nx = s.issues.filter(function (i) { return i.nextStop && (i.status === 'open' || i.status === 'next-stop'); });
    if (nx.length) h += '<div class="sep"></div><span class="lbl">Check at this stop</span><ul class="rules" style="margin-top:4px">' + nx.map(function (i) { return '<li>' + esc(i.text) + '</li>'; }).join('') + '</ul>';
    if (ps && ps.add && d.refuelCrew) h += '<div class="sep"></div><span class="lbl">Refuel crew</span>' + crewLines(d.refuelCrew, ctx);
    if (ctx.eng) h += '<details style="margin-top:8px"><summary>Override car state (geofence missed)</summary>' + manualStates(ctx) + '</details>';
    return { id: 'pittimers', html: card('Pit lane', h, U.clock(t.inTs, true)) };
  }

  /* ---- stop gates: each step is a handshake between the Agile geofence (GEO) and the engineer (ENG);
     a step the engineer has not confirmed is applied from the plan (AUTO) only once the car has moved past it */
  var STEP_NAME = { pitin: 'Pit in', driver: 'Driver change', fuelon: 'Fuelling started', fuel: 'Fuel completed', pitout: 'Pit out' };
  var STEP_GEO = { pitin: 'pit-entry geofence (car in the pit lane)', fuelon: 'fuel-zone geofence (car in the fuel bay)', fuel: 'car left the fuel bay', pitout: 'pit-exit geofence (car leaving the pit lane)' };
  var STEP_ENG = { pitin: 'PIT IN', driver: 'DRIVER CHANGE DONE', fuelon: 'FUEL ON', fuel: 'FUEL STOP COMPLETED', pitout: 'PIT OUT' };
  V.STEP_GEO = STEP_GEO; V.STEP_ENG = STEP_ENG;
  // the two signals of one step, as chips
  function hsMarks(x, agileOn) {
    var geo = !x.hasGeo ? '<span class="hs na" title="No geofence for this step - the engineer confirms it">GEO n/a</span>'
      : x.geoTs ? '<span class="hs on" title="' + esc('Geofence: ' + STEP_GEO[x.id]) + '">GEO ' + U.clock(x.geoTs, true) + '</span>'
        : '<span class="hs ' + (agileOn ? 'wait' : 'off') + '" title="' + esc('Geofence: ' + STEP_GEO[x.id]) + '">GEO ' + (agileOn ? '...' : 'offline') + '</span>';
    var eng = x.engTs ? '<span class="hs on" title="Confirmed by the engineer">ENG ' + U.clock(x.engTs, true) + '</span>'
      : x.by === 'auto' ? '<span class="hs auto" title="Applied from the plan because the car moved past this step">AUTO ' + U.clock(x.ackTs, true) + '</span>'
        : '<span class="hs wait" title="' + esc('Engineer: ' + STEP_ENG[x.id]) + '">ENG ...</span>';
    return '<span class="hs-marks">' + geo + eng + '</span>';
  }
  function hsStatus(x, agileOn) {
    if (x.mode === 'eng' && !agileOn) return '<span class="ok-t">CONFIRMED (Agile offline)</span>';
    return { hs: '<span class="ok-t">HANDSHAKE</span>', ok: '<span class="ok-t">CONFIRMED</span>', eng: '<span class="info-t">waiting for the geofence</span>',
      geo: '<span class="warn-t">geofence seen - confirm it</span>', auto: '<span class="muted">AUTO from the plan</span>', skip: '<span class="muted">not needed - no fuel</span>', none: '' }[x.mode] || '';
  }
  V.hsMarks = hsMarks; V.hsStatus = hsStatus;
  function stopDue(d) { return d.session.running && d.nextStop && ['box', 'boxin', 'notify', 'opp'].indexOf(d.call.code) >= 0; }
  function panelGate(ctx) {
    var d = ctx.d, g = d.gates, s = ctx.s, P = d.P, agileOn = ctx.devices.agile && ctx.devices.agile.status === 'connected';
    if (!g) {     // a stop is due but the car is not in yet: the engineer can open it by hand
      var ns = d.nextStop;
      var h0 = '<div class="small">Stop ' + ns.k + ' ' + stopType(ns.type) + ' due ' + U.clock(ns.ts) + (ns.add ? ', ' + (ns.brim ? 'brim ' : '') + ns.add + ' L' : '') + (ns.change ? ', ' + esc(name(ctx, ns.driverOut)) + ' out / ' + esc(name(ctx, ns.driverIn)) + ' in' : '') + '.</div>' +
        '<div class="tiny muted" style="margin-top:4px">The Agile pit-entry geofence opens the stop by itself' + (agileOn ? '' : ' (Agile offline: press Pit in when the car enters the pit lane)') + '.</div>';
      if (ctx.eng) h0 += '<div class="row" style="margin-top:8px"><button class="btn primary" data-act="gatecmd" data-gate="pitin">PIT IN</button></div>';
      return { id: 'gate', html: card('Stop gates', h0, 'engineer controls each step'), form: true };
    }
    var st = g.stop, pl = g.planned || {};
    var h = '<div class="small">Stop ' + st.id + ' opened by the ' + (st.src === 'manual' ? 'engineer' : 'pit-entry geofence') + ' at ' + U.clock(st.inTs, true) + '. Planned: ' + stopType(pl.type || 'stop') + (pl.add ? ', ' + (pl.brim ? 'brim ' : '') + pl.add + ' L (' + (pl.cans || '-') + ' cans)' : ', no fuel') + (pl.change ? ', ' + esc(name(ctx, pl.driverIn)) + ' in' : '') + '.</div>';
    h += '<div class="hsrows">' + g.list.map(function (x) { return gateRow(ctx, g, x, agileOn); }).join('') + '</div>';
    if (g.done) h += '<div class="small ok-t" style="margin-top:6px">Stop ' + st.id + ' complete - the car has left the pit lane.</div>';
    else if (g.allSteps) h += '<div class="small warn-t" style="margin-top:6px">All steps confirmed - waiting for the pit-exit geofence.</div>';
    if (g.stuckInFuel) h += '<div class="note warn" style="margin-top:6px">No fuel was recorded, but Agile still shows the car in the fuel bay. The stop closes when the car crosses the pit exit; if it has already left and the geofence missed it, use <b>Override car state</b> in the Pit lane card.</div>';
    if (ctx.eng && g.list[0].state !== 'done') h += '<div class="row" style="margin-top:8px"><button class="btn danger sm" data-act="stopvoid" data-stop="' + st.id + '">Not a stop (false trigger)</button></div>';
    h += '<div class="tiny muted" style="margin-top:6px">Each step has two signals: <b>GEO</b> = the Agile geofence saw the car do it, <b>ENG</b> = you confirmed it. Both = <span class="ok-t">HANDSHAKE</span>. ' +
      'PIT IN / PIT OUT: the car is in / leaving the pit lane. FUEL ON: the crew has started pouring (starts the fuelling clock if the geofence missed it). FUEL STOP COMPLETED: pouring finished, litres recorded. ' +
      'A step you have not confirmed is applied from the plan (AUTO) only once the car has moved past it.</div>';
    return { id: 'gate', html: card('Stop ' + st.id + ' handshake', h, 'GEO = geofence, ENG = engineer'), form: true };
  }

  // one handshake row: step name, GEO/ENG chips, status and the engineer's control for that step
  function gateRow(ctx, g, x, agileOn) {
    var s = ctx.s, st = g.stop, pl = g.planned || {}, done = x.state === 'done';
    var ctl = '';
    if (x.id === 'driver') {
      if (done) ctl = '<span class="' + (x.by === 'auto' ? 'muted' : 'ok-t') + '">' + (g.driverAck && g.driverAck.driverIn ? esc(name(ctx, g.driverAck.driverIn)) + ' in' : 'no change') + '</span>';
      else if (ctx.eng) {
        var defIn = pl.change ? pl.driverIn : s.drivers.activeId;
        ctl = '<select id="gt-driver">' + (s.config.members || []).filter(function (m) { return m.driver; }).map(function (m) { return '<option value="' + m.id + '"' + (m.id === defIn ? ' selected' : '') + '>' + esc(m.name) + (m.id === s.drivers.activeId ? ' (stays)' : '') + '</option>'; }).join('') + '</select><button class="btn sm primary" data-act="gatedriver" data-stop="' + st.id + '">DRIVER CHANGE DONE</button>';
      } else ctl = '<span class="muted">' + (pl.change ? esc(name(ctx, pl.driverIn)) + ' planned' : 'no change planned') + '</span>';
    } else if (x.id === 'fuel') {
      if (done) ctl = '<span class="' + (x.by === 'auto' ? 'muted' : 'ok-t') + '">' + (st.service && st.service.fuelAdded ? st.service.fuelAdded + ' L' + (st.service.brimmed ? ' brim' : '') : 'no fuel') + '</span>' + (ctx.eng && x.by === 'auto' && ctx.svcFix !== st.id ? ' <button class="btn sm" data-act="svcfix" data-stop="' + st.id + '">Correct it</button>' : '');
      else ctl = '<span class="muted small">' + (st.fuelInTs ? 'fuelling since ' + U.clock(st.fuelInTs, true) + ' - ' : '') + 'record litres in the Fuel stop card</span>';
    } else if (x.id === 'pitout' && done) ctl = '<span class="muted small">' + (st.outTs ? 'out ' + U.clock(st.outTs, true) : 'car still in the lane') + '</span>';
    else if (x.id === 'fuelon' && x.state === 'skip') ctl = '';
    else if (!done && x.engTs == null && ctx.eng) ctl = '<button class="btn sm' + (x.mode === 'geo' || (g.current && g.current.id === x.id) ? ' primary' : '') + '" data-act="gatecmd" data-gate="' + x.id + '" data-stop="' + st.id + '">' + STEP_ENG[x.id] + '</button>';
    else if (x.id === 'fuelon' && done) ctl = '<span class="muted small">' + (st.fuelInTs ? 'clock from ' + U.clock(st.fuelInTs, true) : '') + '</span>';
    var cls = 'hsrow m-' + x.mode + (g.current && g.current.id === x.id ? ' cur' : '');
    return '<div class="' + cls + '"><span class="hs-n">' + STEP_NAME[x.id] + '</span>' + (x.state === 'skip' ? '<span class="hs-marks"></span>' : hsMarks(x, agileOn)) + '<span class="hs-st">' + hsStatus(x, agileOn) + '</span><span class="hs-ctl">' + ctl + '</span></div>';
  }

  function panelGateFuel(ctx) {
    var d = ctx.d, s = ctx.s, P = d.P, g = d.gates, st = g.stop, pl = g.planned || {}, agileOn = ctx.devices.agile && ctx.devices.agile.status === 'connected';
    var sets = Object.keys(s.tyres.sets).map(function (k) { return s.tyres.sets[k]; });
    var nx = s.issues.filter(function (i) { return i.nextStop && (i.status === 'open' || i.status === 'next-stop'); });
    var prev = ctx.svcFix === st.id && st.service ? st.service : null;
    var litres = prev ? prev.fuelAdded : (pl.add || '');
    var h = '<div class="small muted" style="margin-bottom:8px">' + (st.fuelInTs ? 'Fuelling since ' + U.clock(st.fuelInTs, true) + ' (minimum ' + Math.round(P.fuelMinMs / MIN) + ' min - timer in the centre column).' : 'Fill this in while the crew fuels; nothing is applied until you press the button.') + '</div>' +
      '<div class="fgrid"><label class="f">Fuel added (L)<input id="ps-fuel" type="number" step="0.5" min="0" value="' + litres + '"></label>' +
      '<label class="f">Cans of ' + (P.method ? P.method.canL : 20) + ' L<input id="ps-cans" type="number" step="1" min="0" value="' + (prev ? (prev.cans || '') : (pl.cans || '')) + '"></label>' +
      '<label class="f">Gauge before (L)<input id="ps-before" type="number" step="0.5" min="0" placeholder="optional"></label></div>' +
      '<div class="row" style="margin-top:8px"><label class="chk"><input id="ps-brim" type="checkbox"' + ((prev ? prev.brimmed : pl.brim) ? ' checked' : '') + '> Filled to brim (calibrates the fuel model)</label></div>' +
      '<details style="margin-top:6px"><summary>Tyres, penalty</summary><div class="fgrid" style="margin-top:6px">' +
      '<label class="f">Tyres fitted<select id="ps-tyre"><option value="">No change</option>' + sets.filter(function (x) { return x.id !== s.tyres.mounted && x.status !== 'scrapped'; }).map(function (x) { return '<option value="' + x.id + '">' + esc(x.name) + '</option>'; }).join('') + '</select></label>' +
      '<label class="f">Penalty served<select id="ps-pen"><option value="">None</option><option>Drive through</option><option>Stop and go</option><option>Sin bin</option></select></label></div>' +
      '<div class="row small muted" style="margin-top:6px">Removed set tread (mm): ' + ['FL', 'FR', 'RL', 'RR'].map(function (c) { return c + ' <input id="ps-d-' + c + '" type="number" step="0.1" style="width:58px">'; }).join(' ') + '</div></details>';
    if (nx.length) h += '<div style="margin-top:8px"><span class="lbl">Fixed at this stop</span>' + nx.map(function (i) { return '<div><label class="chk"><input type="checkbox" class="ps-fix" value="' + i.id + '"> ' + esc(i.text) + '</label></div>'; }).join('') + '</div>';
    h += '<div class="row" style="margin-top:10px">' + (!st.fuelInTs && !s.gates[st.id + ':fuelon'] && !prev ? '<button class="btn" data-act="gatecmd" data-gate="fuelon" data-stop="' + st.id + '">FUEL ON</button>' : '') +
      '<button class="btn primary" data-act="gatefuel" data-stop="' + st.id + '">' + (prev ? 'SAVE CORRECTION' : 'FUEL STOP COMPLETED') + '</button>' + (prev ? '' : '<button class="btn sm" data-act="gatefuel" data-stop="' + st.id + '" data-nofuel="1">No fuel this stop</button>') + '</div>';
    return { id: 'gatefuel', html: card(prev ? 'Correct stop ' + st.id + ' fuel' : 'Fuel stop ' + st.id, h, 'pre-fill now, confirm when fuelling ends'), form: true };
  }

  function panelPitForm(ctx, t) {
    var d = ctx.d, s = ctx.s, P = d.P, ps = plannedFor(d, t);
    var drivers = (s.config.members || []).filter(function (m) { return m.driver; });
    var defIn = ps && ps.change ? ps.driverIn : s.drivers.activeId;
    var sets = Object.keys(s.tyres.sets).map(function (k) { return s.tyres.sets[k]; });
    var nx = s.issues.filter(function (i) { return i.nextStop && (i.status === 'open' || i.status === 'next-stop'); });
    var h = '<div class="fgrid">' +
      '<label class="f">Fuel added (L)<input id="ps-fuel" type="number" step="0.5" min="0" value="' + (ps && ps.add || '') + '"></label>' +
      '<label class="f">Cans of ' + (P.method ? P.method.canL : 20) + ' L<input id="ps-cans" type="number" step="1" min="0" value="' + (ps && ps.cans || '') + '"></label>' +
      '<label class="f">Driver in<select id="ps-driver">' + drivers.map(function (m) { return '<option value="' + m.id + '"' + (m.id === defIn ? ' selected' : '') + '>' + esc(m.name) + (m.id === s.drivers.activeId ? ' (stays)' : '') + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="row" style="margin-top:8px"><label class="chk"><input id="ps-brim" type="checkbox"' + (ps && ps.brim ? ' checked' : '') + '> Filled to brim</label></div>' +
      '<details style="margin-top:6px"><summary>More: gauge before, tyres, penalty</summary><div class="fgrid" style="margin-top:6px">' +
      '<label class="f">Gauge before (L)<input id="ps-before" type="number" step="0.5" min="0" placeholder="optional"></label>' +
      '<label class="f">Tyres fitted<select id="ps-tyre"><option value="">No change</option>' + sets.filter(function (x) { return x.id !== s.tyres.mounted && x.status !== 'scrapped'; }).map(function (x) { return '<option value="' + x.id + '">' + esc(x.name) + '</option>'; }).join('') + '</select></label>' +
      '<label class="f">Penalty served<select id="ps-pen"><option value="">None</option><option>Drive through</option><option>Stop and go</option><option>Sin bin</option></select></label></div>' +
      '<div class="row small muted" style="margin-top:6px">Removed set tread (mm): ' + ['FL', 'FR', 'RL', 'RR'].map(function (c) { return c + ' <input id="ps-d-' + c + '" type="number" step="0.1" style="width:58px">'; }).join(' ') + '</div></details>';
    if (nx.length) h += '<div style="margin-top:8px"><span class="lbl">Fixed at this stop</span>' + nx.map(function (i) { return '<div><label class="chk"><input type="checkbox" class="ps-fix" value="' + i.id + '"> ' + esc(i.text) + '</label></div>'; }).join('') + '</div>';
    h += '<div class="row" style="margin-top:10px"><button class="btn primary" data-act="service" data-stop="' + t.id + '">Log stop ' + t.id + '</button></div>';
    return { id: 'pitform', html: card('Log stop ' + t.id, h), form: true };
  }

  /* map (stable html, the dot is moved by app.js) */
  function zoneColour(c) { if (typeof c === 'number') return '#' + ('000000' + (c >>> 0).toString(16)).slice(-6); return c || '#888'; }
  /* The Track card is wide and short. A track that is long north-south would be drawn small, so the map is turned
     (clockwise by rot degrees, screen convention) to fill the card. Both the schematic and the satellite view use it. */
  var MAP_W = 400, MAP_H = 220, MAP_PAD = 24;
  function screenXY(pts) {   // metres, x right (east), y down (south), around the points' centre
    var la = 0, lo = 0; pts.forEach(function (p) { la += p[0]; lo += p[1]; }); la /= pts.length; lo /= pts.length;
    var k = Math.cos(la * Math.PI / 180) * 111320;
    return { la: la, lo: lo, k: k, f: function (lat, lon) { return [(lon - lo) * k, (la - lat) * 111320]; } };
  }
  function rotXY(q, rot) { var a = rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [q[0] * c - q[1] * s, q[0] * s + q[1] * c]; }
  function fitScale(xy, rot, W, H) {
    var x0 = 1e18, x1 = -1e18, y0 = 1e18, y1 = -1e18;
    xy.forEach(function (q) { var r = rotXY(q, rot); x0 = Math.min(x0, r[0]); x1 = Math.max(x1, r[0]); y0 = Math.min(y0, r[1]); y1 = Math.max(y1, r[1]); });
    return { sc: Math.min(W / Math.max(1e-6, x1 - x0), H / Math.max(1e-6, y1 - y0)), x0: x0, x1: x1, y0: y0, y1: y1 };
  }
  // the turn (whole degrees, -90..90) that draws the track biggest in the card; 0 unless it gains at least 15%
  V.bestRotation = function (pts) {
    if (pts.length < 3) return 0;
    var S = screenXY(pts), xy = pts.map(function (p) { return S.f(p[0], p[1]); }), W = MAP_W - 2 * MAP_PAD, H = MAP_H - 2 * MAP_PAD;
    var s0 = fitScale(xy, 0, W, H).sc, best = 0, bs = s0;
    for (var r = -90; r < 90; r++) { var s = fitScale(xy, r, W, H).sc; if (s > bs * 1.03 || (s > bs * 0.97 && Math.abs(r) < Math.abs(best) && s >= bs)) { best = r; bs = s; } }
    return bs >= s0 * 1.15 ? best : 0;
  };
  V.mapProjection = function (pts, rot) {
    if (!pts.length) return null;
    rot = rot || 0;
    var S = screenXY(pts), xy = pts.map(function (p) { return S.f(p[0], p[1]); });
    var W = MAP_W, H = MAP_H, b = fitScale(xy, rot, W - 2 * MAP_PAD, H - 2 * MAP_PAD), sc = b.sc;
    var ox = (W - (b.x1 - b.x0) * sc) / 2 - b.x0 * sc, oy = (H - (b.y1 - b.y0) * sc) / 2 - b.y0 * sc;
    return { W: W, H: H, rot: rot, f: function (lat, lon) { var r = rotXY(S.f(lat, lon), rot); return [ox + r[0] * sc, oy + r[1] * sc]; } };
  };
  // distance (m) from a point to a closed path, measured to the segments (so a sparse path is not penalised)
  function distToPath(q, path) {
    var k = Math.cos(q[0] * Math.PI / 180), M = 111320, best = Infinity;
    for (var i = 0; i < path.length; i++) {
      var a = path[i], b = path[(i + 1) % path.length];
      var ax = (a[1] - q[1]) * M * k, ay = (a[0] - q[0]) * M, bx = (b[1] - q[1]) * M * k, by = (b[0] - q[0]) * M;
      var ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey, t = l2 ? Math.max(0, Math.min(1, -(ax * ex + ay * ey) / l2)) : 0;
      var px = ax + ex * t, py = ay + ey * t, d = px * px + py * py;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
  /* Preset-to-Agile alignment. The preset outline's shape and orientation are true but its GPS anchor is approximate,
     so once Agile's reference lap arrives, fit a pure shift (iterative closest point, translation only) of the preset
     onto it. Returns the shift in metres (dx east, dy north) and degrees, the fit residuals, and ok when the shapes agree. */
  V.alignPreset = function (preset, path) {
    if (!preset || preset.length < 10 || !path || path.length < 10) return null;
    var lat0 = path[0][0], lon0 = path[0][1], M = 111320, k = Math.cos(lat0 * Math.PI / 180);
    var xy = function (p) { return [(p[1] - lon0) * M * k, (p[0] - lat0) * M]; };
    var P = path.map(xy), Q = [], step = Math.max(1, Math.floor(preset.length / 120)), i, j;
    for (i = 0; i < preset.length; i += step) Q.push(xy(preset[i]));
    // closest point on Agile's path (segments) to (x, y)
    var nearest = function (x, y) {
      var bd = Infinity, bx = 0, by = 0;
      for (j = 0; j < P.length; j++) {
        var a = P[j], b = P[(j + 1) % P.length], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
        var t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)) : 0;
        var px = a[0] + ex * t, py = a[1] + ey * t, d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < bd) { bd = d; bx = px; by = py; }
      }
      return [bx, by, Math.sqrt(bd)];
    };
    // start from the centroid difference, then refine
    var cen = function (A) { var sx = 0, sy = 0; A.forEach(function (p) { sx += p[0]; sy += p[1]; }); return [sx / A.length, sy / A.length]; };
    var cp = cen(P), cq = cen(Q), dx = cp[0] - cq[0], dy = cp[1] - cq[1], res = [];
    for (var it = 0; it < 30; it++) {
      var sx = 0, sy = 0; res = [];
      Q.forEach(function (q) { var n = nearest(q[0] + dx, q[1] + dy); sx += n[0] - (q[0] + dx); sy += n[1] - (q[1] + dy); res.push(n[2]); });
      sx /= Q.length; sy /= Q.length; dx += sx; dy += sy;
      if (Math.sqrt(sx * sx + sy * sy) < 0.02) break;
    }
    res = Q.map(function (q) { return nearest(q[0] + dx, q[1] + dy)[2]; }).sort(function (a, b) { return a - b; });
    var med = res[Math.floor(res.length / 2)], p90 = res[Math.floor(res.length * 0.9)], dist = Math.sqrt(dx * dx + dy * dy);
    return { dx: dx, dy: dy, dist: dist, dLat: dy / M, dLon: dx / (M * k), fit: med, p90: p90, ok: p90 < 20 && dist < 500 };
  };
  var alignCache = { key: '', val: null };
  function alignFor(tr, path) {
    var key = (tr.id || tr.name || '') + '|' + tr.outline.length + '|' + path.length + '|' + path[0].join() + '|' + path[path.length - 1].join();
    if (alignCache.key !== key) { alignCache.key = key; alignCache.val = V.alignPreset(tr.outline, path); }
    return alignCache.val;
  }
  function compass(dx, dy) { return ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][Math.round(((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360 / 45) % 8]; }
  // Map geometry shared by the schematic (SVG) and satellite views: the circuit, geofences, preset overlays and S/F
  // A weekend keeps a copy of its track preset from the day it was created. The geometry (outline, turns, pits, S/F)
  // is reference data, so a known preset is always drawn from the current track file, not from that copy.
  V.trackPresets = [];
  V.trackGeometry = function (tr) {
    tr = tr || {};
    var pre = (V.trackPresets || []).filter(function (t) { return t.id === tr.id && t.outline && t.outline.length; })[0];
    if (!pre) return tr;
    var out = {}; for (var k in tr) out[k] = tr[k];
    ['outline', 'turns', 'sf', 'sfLine', 'pit', 'layout'].forEach(function (k) { out[k] = pre[k]; });
    return out;
  };
  function mapGeometry(ctx) {
    var m = ctx.map, hist = ctx.posHist || [], tr = V.trackGeometry(ctx.s.config.track);
    // source of the outline: the Agile reference lap if it has one, otherwise the track preset (e.g. Collie long circuit)
    var src = m && m.path.length ? 'agile' : (tr.outline && tr.outline.length ? 'preset' : 'trail');
    var path = src === 'agile' ? m.path : src === 'preset' ? tr.outline : [];
    var zones = (m ? m.zones : []).map(function (z) { return { c: zoneColour(z.colour), label: z.label || '', v: z.v }; });
    // on Agile's lap, shift the preset overlays (turns, pits, S/F) by the fitted offset when the shapes agree
    var al = src === 'agile' && tr.outline && tr.outline.length ? alignFor(tr, path) : null;
    var S = al && al.ok ? function (p) { return [p[0] + al.dLat, p[1] + al.dLon]; } : function (p) { return p; };
    var SA = function (arr) { return arr.map(S); };
    var near = function (q) { return path.length ? distToPath(q, path) : Infinity; };
    var pg = tr.pit ? { lane: SA(tr.pit.lane), pits: SA(tr.pit.pits), fuel: SA(tr.pit.fuel), entry: SA(tr.pit.entry), exit: SA(tr.pit.exit) } : null;
    // preset pit geometry is used only when its lane ends sit on the drawn circuit; its areas only when Agile has no geofences
    var pitOk = !!(pg && path.length && near(pg.lane[0]) < 60 && near(pg.lane[pg.lane.length - 1]) < 60);
    var pit = pitOk ? { lane: pg.lane, areas: !zones.length, pits: pg.pits, fuel: pg.fuel, entry: pg.entry, exit: pg.exit } : null;
    var trSf = tr.sf ? S(tr.sf) : null, sfLine = tr.sfLine && path.length ? SA(tr.sfLine) : null;
    if (src === 'agile') {
      if (trSf && near(trSf) > 40) trSf = null;
      if (sfLine && near([(sfLine[0][0] + sfLine[1][0]) / 2, (sfLine[0][1] + sfLine[1][1]) / 2]) > 40) sfLine = null;
    }
    var sf = (m && m.sf) || trSf || null;
    // turn numbers: only where the (shifted) preset turn sits on the drawn outline
    var turns = (tr.turns && path.length ? tr.turns : []).map(function (t) { return { n: t.n, p: S([t.lat, t.lon]) }; }).filter(function (t) { return near(t.p) <= 40; });
    var pts = path.slice();
    zones.forEach(function (z) { pts = pts.concat(z.v); });
    if (sf) pts.push(sf);
    if (pit) pts = pts.concat(pit.pits, pit.fuel);
    var trail = hist.map(function (p) { return [p.lat, p.lon]; });
    if (src === 'trail') pts = pts.concat(trail);
    // turned to fill the card, unless this browser chose north-up; a live trail alone is never turned (it would keep swinging)
    var rot = V.mapNorthUp || src === 'trail' ? 0 : V.bestRotation(pts);
    var sig = [src, path.length, path[0] || '', path[path.length - 1] || '', zones.length, sf || '', pit ? 1 : 0, turns.length, al ? al.dLat.toFixed(7) + ',' + al.dLon.toFixed(7) : '', rot].join('|');
    return { src: src, tr: tr, path: path, zones: zones, pit: pit, sfLine: sfLine, sf: sf, turns: turns, pts: pts, al: al, sig: sig, trail: trail, rot: rot };
  }
  V.mapGeometry = mapGeometry;
  function schematicSvg(g) {
    var pr = V.mapProjection(g.pts, g.rot); window.PWMapProj = pr;
    var poly = function (arr) { return arr.map(function (p) { var q = pr.f(p[0], p[1]); return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' '); };
    var svg = '<svg viewBox="0 0 ' + pr.W + ' ' + pr.H + '" class="minimap" role="img" aria-label="Track map">';
    g.zones.forEach(function (z) {
      if (z.v.length >= 3) svg += '<polygon points="' + poly(z.v) + '" fill="' + z.c + '" fill-opacity="0.15" stroke="' + z.c + '" stroke-opacity="0.7"><title>' + esc(z.label) + '</title></polygon>';
      else if (z.v.length === 2) svg += '<polyline points="' + poly(z.v) + '" stroke="' + z.c + '" stroke-width="3"><title>' + esc(z.label) + '</title></polyline>';
    });
    // pit geometry from the track preset (pit lane, pits area, fuel area, entry/exit lines)
    if (g.pit) {
      if (g.pit.areas) {
        svg += '<polygon points="' + poly(g.pit.pits) + '" fill="#4fc3f7" fill-opacity="0.18" stroke="#4fc3f7" stroke-opacity="0.8"><title>Pits</title></polygon>';
        svg += '<polygon points="' + poly(g.pit.fuel) + '" fill="#CE93D8" fill-opacity="0.22" stroke="#CE93D8" stroke-opacity="0.9"><title>Fuel area</title></polygon>';
        svg += '<polyline points="' + poly(g.pit.entry) + '" stroke="#FFA500" stroke-width="3"><title>Pit entry</title></polyline><polyline points="' + poly(g.pit.exit) + '" stroke="#FFD54F" stroke-width="3"><title>Pit exit</title></polyline>';
      }
      svg += '<polyline points="' + poly(g.pit.lane) + '" fill="none" stroke="#8a6fc0" stroke-width="2" stroke-dasharray="4 3"><title>Pit lane</title></polyline>';
    }
    if (g.sfLine) svg += '<polyline points="' + poly(g.sfLine) + '" stroke="#fff" stroke-width="2"><title>Start / finish line</title></polyline>';
    if (g.path.length) { var loop = poly(g.path.concat([g.path[0]])); svg += '<polyline points="' + loop + '" fill="none" stroke="#2c2f34" stroke-width="9" stroke-linejoin="round"/><polyline points="' + loop + '" fill="none" stroke="#6a6f78" stroke-width="2" stroke-linejoin="round"/>'; }
    if (g.turns.length) {
      var cxy = pr.f(g.pts.reduce(function (a, p) { return a + p[0]; }, 0) / g.pts.length, g.pts.reduce(function (a, p) { return a + p[1]; }, 0) / g.pts.length);
      g.turns.forEach(function (t) {
        var q = pr.f(t.p[0], t.p[1]), dx = q[0] - cxy[0], dy = q[1] - cxy[1], dl = Math.sqrt(dx * dx + dy * dy) || 1;
        var lx = q[0] + dx / dl * 13, ly = q[1] + dy / dl * 13;
        svg += '<text x="' + lx.toFixed(1) + '" y="' + (ly + 3).toFixed(1) + '" text-anchor="middle" class="turn">' + esc(t.n) + '</text>';
      });
    }
    if (g.sf) { var q2 = pr.f(g.sf[0], g.sf[1]); svg += '<rect x="' + (q2[0] - 4) + '" y="' + (q2[1] - 4) + '" width="8" height="8" fill="#fff"><title>Start / finish</title></rect>'; }
    svg += V.northArrow(g.rot, 'svg');
    return svg + '<polyline id="mm-trail" points="" fill="none" stroke="#9aa0aa" stroke-opacity="0.5" stroke-width="3" stroke-linecap="round"/><circle id="mm-car" cx="-20" cy="-20" r="7" fill="#00C846" stroke="#000" stroke-width="2"/></svg>';
  }
  // north arrow: turned with the map, so you can always tell which way is north (clicking it toggles North up)
  V.northArrow = function (rot, kind) {
    var g = '<g transform="rotate(' + rot + ')"><path d="M0,-10 L5,4 L0,1 L-5,4 Z" fill="#e4e4e4" stroke="#000" stroke-width="1"/></g><text x="0" y="' + (rot === 0 ? 16 : 17) + '" text-anchor="middle" class="turn">N</text>';
    if (kind === 'svg') return '<g class="north" transform="translate(16,16)"><title>' + (rot ? 'North (map turned ' + Math.abs(rot) + '° to fit)' : 'North') + '</title>' + g + '</g>';
    return '<svg viewBox="-12 -12 24 32" width="22" height="29" class="minimap-n">' + g + '</svg>';
  };
  V.mapNorthUp = false;      // per browser, set by app.js
  V.mapMode = 'schematic';   // per browser, set by app.js
  function panelMap(ctx) {
    if (ctx.replay) return { id: 'map', html: card('Track', '<div class="muted small">Live only - positions are not stored in the race log.</div>') };
    var g = mapGeometry(ctx), tr = g.tr, Sat = window.OrbSat;
    var wantSat = V.mapMode === 'satellite', satDown = wantSat ? (!window.L || !Sat ? 'nolib' : Sat.unavailable()) : false;
    var useSat = wantSat && !satDown;
    var modeSw = '<span class="seg mapmode"><button class="btn sm' + (wantSat ? '' : ' active') + '" data-act="mapmode" data-mode="schematic">Schematic</button><button class="btn sm' + (wantSat ? ' active' : '') + '" data-act="mapmode" data-mode="satellite">Satellite</button></span>';
    modeSw += '<button class="btn sm mapnorth' + (V.mapNorthUp ? ' active' : '') + '" data-act="mapnorth" title="' + (V.mapNorthUp ? 'North is up. Press to turn the map to fill the card.' : 'The map is turned to fill the card. Press for north up.') + '">North up</button>';
    var hint = (g.src === 'agile' ? 'Agile reference lap' : g.src === 'preset' ? esc(tr.name || 'track') + ' layout' : 'live trail') + ' ' + modeSw;
    if (g.pts.length < 3 && !(useSat && g.trail.length)) { window.PWMapGeo = null; return { id: 'map', html: card('Track', '<div class="muted small">Waiting for Agile position. The outline appears once Agile has recorded its reference lap.</div>', modeSw) }; }
    var foot = g.src === 'preset' ? '<div class="tiny muted">' + esc(tr.layout || '') + '. Replaced by the Agile reference lap once recorded.</div>' : '';
    var al = g.al;
    if (al) {
      window.PWPresetAlign = al;
      foot = '<div class="tiny muted" id="mm-align">' + (al.ok
        ? esc(tr.name || 'Preset') + ' preset ' + (al.dist < 1 ? 'matches the Agile lap' : 'aligned to the Agile lap: shifted ' + Math.round(al.dist) + ' m ' + compass(al.dx, al.dy)) + ', shapes agree within ' + Math.max(1, Math.round(al.p90)) + ' m.'
        : esc(tr.name || 'Preset') + ' preset does not match the Agile lap (' + (al.dist >= 500 ? Math.round(al.dist) + ' m away' : 'shapes differ by up to ' + Math.round(al.p90) + ' m') + '): preset turns, pits and S/F hidden.') + '</div>';
    }
    if (satDown) foot += '<div class="tiny warn-t" id="mm-satdown">' + (satDown === 'nolib' ? 'The satellite view could not load its map library: showing the schematic.' : 'No satellite imagery here (no internet and this area is not downloaded): showing the schematic. Retrying every minute; download the track in Setup before the weekend.') + '</div>';
    var body;
    if (useSat) { window.PWMapGeo = g; window.PWMapProj = null; body = '<div id="mm-sat" class="satholder" role="img" aria-label="Satellite track map"></div>'; }
    else { window.PWMapGeo = null; body = schematicSvg(g); }
    return { id: 'map', html: card('Track', body + '<div class="tiny muted" id="mm-info" style="margin-top:4px">-</div>' + foot, hint) };
  }

  function panelTelemetry(ctx) {
    var d = ctx.d, pl = ctx.live.agile || {}, lv = pl.live || {}, b = ctx.live.sentinel || {}, bl = b.live;
    var h = '<div class="strip">' +
      '<div><span class="lbl">Last</span><span class="v">' + U.lap(d.lastLap && d.lastLap.ms) + '</span></div>' +
      '<div><span class="lbl">Best</span><span class="v">' + U.lap(d.bestLapMs) + '</span></div>' +
      '<div data-tip="kpi:Ref pace"><span class="lbl">Ref pace</span><span class="v">' + U.lap(d.refLap.ms) + '</span></div>' +
      '<div data-tip="kpi:Delta"><span class="lbl">Delta</span><span class="v' + (lv.v && lv.d > 500 ? ' warn-t' : '') + '">' + (lv.v ? (lv.d > 0 ? '+' : '') + (lv.d / 1000).toFixed(2) : '-') + '</span></div>' +
      '<div><span class="lbl">Speed</span><span class="v">' + (lv.spd != null ? Math.round(lv.spd) : '-') + '</span></div></div>';
    // micro-sectors from Agile (count set by its recon lap): green faster, red slower, purple best, grey not yet run
    var sx = pl.sectors;
    if (sx && sx.n) {
      var cells = '';
      for (var i = 0; i < sx.n; i++) {
        var c = sx.cells[i] || { c: 0 }, col = ['#2c2f34', '#00C846', '#E03030', '#8B5CF6'][c.c] || '#2c2f34';
        cells += '<span class="msec' + (i === sx.cur ? ' cur' : '') + '" style="background:' + col + '" title="' + esc('Micro-sector ' + (i + 1) + (c.done ? ': ' + (c.d > 0 ? '+' : '') + (c.d / 1000).toFixed(2) + ' s' : '')) + '"></span>';
      }
      var sum = 0, n = 0; sx.cells.forEach(function (c) { if (c.done) { sum += c.d; n++; } });
      h += '<div class="sep"></div><div class="row tiny muted" style="margin-bottom:4px"><span>Micro-sectors</span><span class="spacer"></span><span>' + (sx.cur != null ? 'sector ' + (sx.cur + 1) + ' of ' + sx.n : sx.n + ' sectors') + (n ? ' | this lap ' + (sum > 0 ? '+' : '') + (sum / 1000).toFixed(2) + ' s' : '') + '</span></div><div class="msecs">' + cells + '</div>';
    } else h += '<div class="tiny muted" style="margin-top:6px">Micro-sectors appear once Agile has its recon lap.</div>';
    if (bl) {
      var t = bl.thresh || {};
      var cls = function (v, th) { if (v == null || !th) return ''; return v > th[3] ? 'over' : v > th[2] ? 'hot' : v <= th[0] ? 'cold' : ''; };
      var corner = function (c) {
        return '<div class="corner"><span class="cn">' + c.toUpperCase() + '</span>' +
          '<span class="t ' + cls(bl.brake[c], t.br) + '" title="Brake">' + (bl.brake[c] == null ? '---' : Math.round(bl.brake[c])) + '<small>B</small></span>' +
          '<span class="t ' + cls(bl.tyre[c], t.ty) + '" title="Tyre">' + (bl.tyre[c] == null ? '---' : Math.round(bl.tyre[c])) + '<small>T</small></span>' +
          '<span class="t" title="TPMS">' + (bl.press[c] == null ? '--' : bl.press[c].toFixed(1)) + '<small>psi</small></span></div>';
      };
      h += '<div class="sep"></div><div class="corners">' + ['fl', 'fr', 'rl', 'rr'].map(corner).join('') + '</div>';
      var age = Date.now() - bl.ts;
      h += '<div class="tiny muted" style="margin-top:4px">Brake / tyre C. Grey = in range, amber = red band, flashing red = over the top band.' + (age > 3000 ? ' <span class="warn-t">Sentinel data ' + Math.round(age / 1000) + ' s old</span>' : '') + '</div>';
    } else h += '<div class="tiny muted" style="margin-top:8px">Sentinel ' + esc(b.status || 'disabled') + '</div>';
    return { id: 'telemetry', html: card('Car feed summary', h, 'Agile timing, Sentinel corners') };
  }

  function panelControl(ctx) {
    var s = ctx.s, d = ctx.d, rules = s.config.rules || {}, sessions = s.config.sessions || [], active = s.activeSessionId;
    if (!active) {
      var nextS = sessions.filter(function (x) { return !s.sessions[x.id]; })[0] || sessions[sessions.length - 1];
      var h = '<div class="fgrid"><label class="f">Session<select id="ss-id">' + sessions.map(function (x) { return '<option value="' + x.id + '"' + (nextS && x.id === nextS.id ? ' selected' : '') + '>' + esc(x.name) + (s.sessions[x.id] ? ' (run)' : '') + '</option>'; }).join('') + '</select></label>' +
        '<label class="f">Start fuel (L)<input id="ss-fuel" type="number" step="0.5" value="' + d.P.capacity + '"></label>' +
        '<label class="f">Driver<select id="ss-driver">' + (s.drivers.queue || []).map(function (id) { return '<option value="' + id + '">' + esc(name(ctx, id)) + '</option>'; }).join('') + '</select></label>' +
        '<label class="f">Tyre set<select id="ss-tyre">' + Object.keys(s.tyres.sets).map(function (k) { return '<option value="' + k + '"' + (k === (s.tyres.mounted || s.config.tyres.startSetId) ? ' selected' : '') + '>' + esc(s.tyres.sets[k].name) + '</option>'; }).join('') + '</select></label></div>' +
        '<div class="row" style="margin-top:10px"><button class="btn go" data-act="startsession">Green flag - start session</button></div>';
      return { id: 'control', html: card('Session control', h), form: true };
    }
    var sc = ctx.s.scenarios || {}, ap = sc.active || 'A', apl = sc.plans && sc.plans[ap];
    var h2 = '<div class="ctl-group"><div class="ctl-head"><span class="tag strat">STRATEGY</span> Track status - changes fuel burn, refuelling rules and the call; shown on the dash</div><div class="row"><div class="seg">' + (rules.flags || ['GREEN', 'YELLOW', 'SC', 'RED']).map(function (f) {
      return '<button class="btn sm f-' + f.split(' ')[0] + (s.flag.current === f ? ' active' : '') + '" data-act="flag" data-flag="' + f + '">' + f + '</button>';
    }).join('') + '</div><span class="spacer"></span><button class="btn danger sm" data-act="endsession">Chequered</button></div>' +
      '<div class="row small" style="margin-top:6px"><span class="muted">Scenario running:</span> <b>' + ap + (apl ? ' - ' + esc(apl.name) : ' - Clean race') + '</b> <a href="#" data-act="gotab" data-tab="plans" class="info-t">change</a></div></div>';
    var presets = ['BOX BOX', 'BOX NEXT LAP', 'STAY OUT', 'PUSH', 'SAVE FUEL'];
    h2 += '<div class="ctl-group"><div class="ctl-head"><span class="tag msg">MESSAGE</span> Pit board - text to the driver only. No effect on the plan; stops start from the geofences.</div><div class="row">' + presets.map(function (p) { return '<button class="btn sm" data-act="pitmsg" data-text="' + p + '">' + p + '</button>'; }).join('') + '</div>' +
      '<div class="row" style="margin-top:6px"><input id="pm-text" maxlength="16" placeholder="Pit board text (16)" style="flex:1;text-transform:uppercase"><label class="chk"><input id="pm-pri" type="checkbox"> Priority</label><button class="btn sm" data-act="pitmsgcustom">Send</button></div></div>';
    return { id: 'control', html: card('Race control', h2), form: true };
  }

  // FEED: attention (unacknowledged alerts + next-stop jobs) then the recent race story
  var FEED_TYPES = { 'alert': 1, 'flag.set': 1, 'stop.service': 1, 'pitmsg.send': 1, 'pitmsg.ack': 1, 'issue.add': 1, 'penalty.add': 1, 'crew.status': 1, 'driver.set': 1, 'session.start': 1, 'session.end': 1, 'note': 1, 'gate.ack': 1, 'stop.void': 1, 'scenario.activate': 1 };
  // what changes the strategy timeline, what is only a message
  V.effectOf = function (e) {
    if ({ 'flag.set': 1, 'stop.service': 1, 'gate.ack': 1, 'stop.void': 1, 'driver.set': 1, 'driver.queue': 1, 'scenario.activate': 1, 'scenario.set': 1, 'scenario.reset': 1, 'scenario.undo': 1, 'scenario.redo': 1, 'scenario.clone': 1, 'scenario.remove': 1, 'session.start': 1, 'session.end': 1, 'fuel.check': 1, 'fuel.refuel': 1, 'stock.add': 1, 'stock.count': 1, 'carstate': 1, 'lap': 1, 'setup.update': 1 }[e.type]) return 'strat';
    if (e.type === 'pitmsg.send' || e.type === 'pitmsg.ack' || e.type === 'pitmsg.shown') return 'msg';
    return 'info';
  };
  function panelFeed(ctx) {
    var s = ctx.s, d = ctx.d, now = d.now;
    var inAttention = function (a) { return a.level !== 'info' && !s.acks[a.key] && now - a.ts < 45 * MIN && a.key.indexOf('stop:issues') !== 0; };
    var unack = s.alerts.filter(inAttention).slice(-6).reverse();
    var jobs = s.issues.filter(function (i) { return i.nextStop && (i.status === 'open' || i.status === 'next-stop'); });
    var others = s.issues.filter(function (i) { return !i.nextStop && i.status === 'open'; }).length;
    var h = '';
    unack.forEach(function (a) {
      h += '<div class="attn unack ' + a.level + '"><span class="t">' + U.clock(a.ts) + '</span><span style="flex:1">' + esc(a.text) + '</span>' + (ctx.eng ? '<button class="btn sm" data-act="ack" data-key="' + esc(a.key) + '">Ack</button>' : '') + '</div>';
    });
    jobs.forEach(function (i) {
      h += '<div class="attn task"><span class="tag next">next stop</span><span style="flex:1">' + esc(i.text) + ' <span class="tiny muted">' + esc(i.cat) + (i.src !== 'manual' ? ', ' + esc(i.src) : '') + '</span></span>' + (ctx.eng ? '<button class="btn sm go" data-act="issue" data-id="' + i.id + '" data-op="fixed">Fixed</button>' : '') + '</div>';
    });
    if (!h) h = '<div class="small muted" style="padding:4px 0 8px">Nothing needs attention.</div>';
    if (others) h += '<div class="tiny muted" style="margin:2px 0 8px">' + others + ' other open car item' + (others > 1 ? 's' : '') + ' on the Car tab</div>';
    if (ctx.eng) h += '<div class="row" style="margin:6px 0 10px"><input id="qi-text" placeholder="Log a car issue for the next stop" style="flex:1"><select id="qi-cat">' + ['brakes', 'tyres', 'engine', 'gearbox', 'suspension', 'body', 'impact', 'electrical', 'fuel', 'cooling', 'driver', 'other'].map(function (c) { return '<option>' + c + '</option>'; }).join('') + '</select><button class="btn sm" data-act="addissue" data-p="qi">Log</button></div>';
    var ev = ctx.events.filter(function (e) {
      if (!FEED_TYPES[e.type]) return false;
      if (e.type === 'alert') { var a = { key: e.payload.key, level: e.payload.level, ts: e.ts }; if (inAttention(a) || a.key.indexOf('stop:issues') === 0) return false; }
      return true;
    }).slice(-40).reverse();
    h += '<span class="lbl">Race history</span><div class="feed" style="margin-top:4px">' + ev.map(function (e) {
      var lvl = e.type === 'alert' ? e.payload.level : (e.type === 'flag.set' && e.payload.flag !== 'GREEN' ? 'warn' : '');
      var ef = V.effectOf(e);
      return '<div class="fl ' + (lvl === 'info' ? '' : lvl) + '"><span class="t">' + U.clock(e.ts) + '</span><span>' + (ef !== 'info' ? '<span class="tag ' + ef + '">' + (ef === 'strat' ? 'STRATEGY' : 'MESSAGE') + '</span> ' : '') + esc(V.summarise(ctx, e)) + '</span></div>';
    }).join('') + '</div>';
    return { id: 'feed', html: card('Attention & feed', h, unack.length ? '<span class="warn-t">' + unack.length + ' unacknowledged</span>' : ''), form: true };
  }

  /* ================================================================== PLAN */
  V.plan = function (ctx) {
    return { layout: 'plan-grid', cols: [[panelStints(ctx), panelLaps(ctx)], [panelTrace(ctx), panelModel(ctx), panelWhatIf(ctx), panelRules(ctx)]] };
  };

  function panelStints(ctx) {
    var d = ctx.d, s = ctx.s, pl = d.plan, rs = d.raceSession;
    if (!pl) return { id: 'stints', html: card('Stint table', '<div class="muted">No race session configured</div>') };
    var P = d.P, base = rs.startTs, rows = '';
    var lapsIn = function (a, b) { return s.laps.filter(function (l) { return l.sessionId === rs.id && l.ts > a && l.ts <= b; }).length; };
    var stintRow = function (cls, n, drv, from, to, laps, fuel, note, extra) {
      return '<tr class="' + cls + '"><td class="num">' + n + '</td><td><span class="cdot" style="background:' + U.driverColour(s, drv) + '"></span> ' + esc(name(ctx, drv)) + (note ? ' <span class="tag">' + note + '</span>' : '') + (extra || '') + '</td>' +
        '<td class="num">' + U.clock(from) + '</td><td class="num">' + U.clock(to) + '</td><td class="num">' + U.dur(from - base, true) + '</td><td class="num">' + U.mins(to - from) + '</td><td class="num">' + laps + '</td><td class="num">' + fuel + '</td></tr>';
    };
    var n = 0, open = ctx.debrief || {};
    if (rs.started) {
      var actual = s.drivers.stints.filter(function (x) { return x.sessionId === rs.id && x.endTs; });
      var stops = d.stops.list.filter(function (x) { return !x.open; });
      var items = actual.map(function (x) { return { t: x.startTs, k: 'stint', x: x }; }).concat(stops.map(function (x) { return { t: x.inTs, k: 'stop', x: x }; })).sort(function (a, b) { return a.t - b.t; });
      items.forEach(function (it) {
        if (it.k === 'stint') {
          n++;
          var key = String(it.x.startTs), on = !!open[key];
          var tog = ' <button class="dbtog" data-act="debrief" data-k="' + key + '" aria-expanded="' + on + '">' + (on ? '&minus;' : '+') + ' auto-gen debrief</button>';
          rows += stintRow('past', n, it.x.driverId, it.x.startTs, it.x.endTs, lapsIn(it.x.startTs, it.x.endTs), '-', 'done', tog);
          if (on) rows += '<tr class="dbrow"><td></td><td colspan="7"><div class="debrief">' + stintDebrief(ctx, it.x, n, stops) + '</div></td></tr>';
        }
        else {
          var x = it.x;
          rows += '<tr class="stoprow past"><td></td><td colspan="7">' + x.id + ' ' + stopType(x.type) + ' at ' + U.clock(x.inTs) + ' - lane ' + U.dur(x.laneMs) + (x.fuelMs != null ? ', fuel ' + U.dur(x.fuelMs) : '') + (x.added ? ', ' + x.added + ' L' : '') +
            (x.driverIn && x.driverIn !== x.driverOut ? ', ' + esc(U.short(name(ctx, x.driverOut))) + ' &rarr; ' + esc(U.short(name(ctx, x.driverIn))) : '') +
            (P.mandCount ? (x.counts ? ' <span class="ok-t">counts</span>' : ' <span class="warn-t">does not count</span>') : '') + (x.fuelOk === false ? ' <span class="crit-t">fuel time short</span>' : '') + (x.serviced ? '' : ' <span class="warn-t">not logged</span>') + '</td></tr>';
        }
      });
    }
    pl.stints.forEach(function (st, i) {
      n++;
      var current = i === 0 && rs.running;
      rows += stintRow(current ? 'current' : '', n, st.driverId, current ? st.startTs : st.fromTs, st.endTs, Math.round((st.endTs - st.fromTs) / d.refLap.ms) + (current ? ' left' : ''), U.L(st.fuelStart) + ' &rarr; ' + U.L(st.fuelEnd), current ? 'now' : '');
      var stop = pl.stops[i];
      if (stop) rows += '<tr class="stoprow"><td></td><td colspan="7"><b class="' + (stop.add ? 'purple-t' : '') + '">Stop ' + stop.k + ' ' + stopType(stop.type) + '</b> ' + U.clock(stop.ts) + ' (lap ~' + d.lapAt(stop.ts) + ') - ' + U.mins(stop.statMs) + ' stationary' +
        (stop.add ? ', ' + (stop.brim ? 'brim ' : '') + stop.add + ' L (' + stop.cans + ' cans)' : '') + (stop.change ? ', ' + esc(U.short(name(ctx, stop.driverOut))) + ' &rarr; ' + esc(U.short(name(ctx, stop.driverIn))) : '') +
        (stop.window ? ', window ' + U.clock(stop.window.openTs) + '-' + U.clock(stop.window.closeTs) : '') + (stop.counts ? ', counts' : '') + '</td></tr>';
    });
    var si = d.stops;
    var chips = [['Stops to go', pl.stops.length + ' (' + pl.fuelStops + ' fuel)'], ['Finish fuel', U.L(pl.finishFuelL) + ' L'], ['Flag', U.dayClock(pl.raceEndTs)], ['Green burn', U.L(pl.greenRate, 2) + ' L/h']];
    if (si.required) chips.push(['Mandatory', si.counted + ' / ' + si.required]);
    var dr = ctx.drop;
    if (dr && pl.fuelStops) chips.push(['Drop one fuel stop', dr.none ? 'needs &gt;15% less fuel' : 'save ' + dr.pct.toFixed(0) + '% (' + U.L(dr.perLapL, 3) + ' L/lap)']);
    var head = '<div class="chips-sum">' + chips.map(function (c) { return '<div class="sumchip"><span class="lbl">' + c[0] + '</span><span class="v">' + c[1] + '</span></div>'; }).join('') + (ctx.whatIfOn ? '<div class="sumchip"><span class="lbl">Scenario</span><span class="v warn-t">what-if</span></div>' : '') + '</div>';
    if (pl.warnings.length) head += '<div class="note warn" style="margin-bottom:8px">' + pl.warnings.map(esc).join('<br>') + '</div>';
    return { id: 'stints', html: card('Stint table', head + '<div class="scroll tall"><table><thead><tr><th class="num">#</th><th>Driver</th><th class="num">From</th><th class="num">To</th><th class="num">Race t</th><th class="num">Length</th><th class="num">Laps</th><th class="num">Fuel L</th></tr></thead><tbody>' + rows + '</tbody></table></div>', 'done, now and plan in one table') };
  }

  /* stint debrief: what the engineer watching it would tell you, built from laps, flags, issues, Sentinel peaks and the stop that ended it */
  var FLAG_WORDS = { SC: ['Safety Car', 'Safety Cars'], FCY: ['Full Course Yellow', 'Full Course Yellows'], RED: ['red flag', 'red flags'], YELLOW: ['local yellow', 'local yellows'], 'DOUBLE YELLOW': ['double yellow', 'double yellows'] };
  var CORNER = ['fl', 'fr', 'rl', 'rr'];
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function numWord(n) { return ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][n] || String(n); }
  function avg(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }
  function secs(ms) { return (ms / 1000).toFixed(1) + ' s'; }
  function stintDebrief(ctx, st, n, stops) {
    var s = ctx.s, d = ctx.d, a = st.startTs, b = st.endTs, who = esc(name(ctx, st.driverId)), first = esc(U.short(name(ctx, st.driverId)));
    var inside = function (ts) { return ts > a && ts <= b; };
    var cls = {}; d.laps.forEach(function (l) { cls[l.ts] = l.cls; });
    var laps = s.laps.filter(function (l) { return l.sessionId === st.sessionId && inside(l.ts); }).map(function (l) {
      return { n: l.n, ms: l.ms, peaks: l.peaks, cls: cls[l.ts] || (l.pitted ? 'pit' : l.flag !== 'GREEN' ? 'sc' : 'green') };
    });
    var p = [];

    // opening line
    p.push(who + ' was in the car for ' + U.mins(b - a) + ' (' + U.clock(a) + ' to ' + U.clock(b) + '), stint ' + n + ', ' + plural(laps.length, 'lap') + ' on the board.');

    // pace
    var clean = laps.filter(function (l) { return l.cls === 'green' || l.cls === 'push' || l.cls === 'slow'; });
    var timed = laps.filter(function (l) { return l.cls !== 'pit'; });
    if (clean.length) {
      var av = avg(clean.map(function (l) { return l.ms; }));
      var best = timed.reduce(function (m, l) { return !m || l.ms < m.ms ? l : m; }, null);
      var worst = clean.reduce(function (m, l) { return !m || l.ms > m.ms ? l : m; }, null);
      var core = clean.filter(function (l) { return l.cls !== 'slow'; }).map(function (l) { return l.ms; });
      var sd = core.length > 3 ? Math.sqrt(avg(core.map(function (x) { var dv = x - avg(core); return dv * dv; }))) : null;
      var t = 'On green-flag running the average was <b>' + U.lap(av) + '</b>, best lap a <b>' + U.lap(best.ms) + '</b> on lap ' + best.n + ' and the worst a <b>' + U.lap(worst.ms) + '</b> on lap ' + worst.n + '.';
      if (sd != null) t += sd < 600 ? ' Very consistent, laps within about &plusmn;' + secs(sd) + ' of each other.' : sd < 1200 ? ' Reasonably tidy, about &plusmn;' + secs(sd) + ' lap to lap.' : ' Pace was up and down, about &plusmn;' + secs(sd) + ' lap to lap, so traffic or a scruffy patch in there.';
      if (core.length >= 12) {
        var k = Math.min(5, Math.floor(core.length / 3)), early = avg(core.slice(0, k)), late = avg(core.slice(-k)), dl = late - early;
        t += Math.abs(dl) < 300 ? ' Pace held from start to finish, no real drop-off.' : dl > 0 ? ' The last few laps were ' + secs(dl) + ' slower than the opening ones, tyres or fatigue starting to show.' : ' Got quicker as it went on, the last few laps ' + secs(-dl) + ' up on the opening ones.';
      }
      var bestEver = d.bestLapMs;
      if (bestEver && best.ms === bestEver) t += ' That ' + U.lap(best.ms) + ' is still the fastest lap of the race.';
      p.push(t);
    } else if (laps.length) p.push('No clean green-flag laps to judge pace on in this one.');

    // flags
    var hist = s.flag.history, fl = {}, flagMs = 0;
    hist.forEach(function (h, i) {
      if (h.flag === 'GREEN') return;
      var from = h.ts, to = i + 1 < hist.length ? hist[i + 1].ts : (b > ctx.now ? ctx.now : b);
      var ov = Math.min(to, b) - Math.max(from, a);
      if (ov <= 0) return;
      var f = fl[h.flag] || (fl[h.flag] = { n: 0, ms: 0 }); f.n++; f.ms += ov; flagMs += ov;
    });
    var scLaps = laps.filter(function (l) { return l.cls === 'sc'; }).length, keys = Object.keys(fl);
    if (keys.length) {
      p.push('Flags: ' + keys.map(function (f) { var w = FLAG_WORDS[f] || [f.toLowerCase(), f.toLowerCase() + 's']; return numWord(fl[f].n) + ' ' + (fl[f].n === 1 ? w[0] : w[1]) + ' (' + U.mins(fl[f].ms) + ')'; }).join(', ') +
        ', ' + U.mins(flagMs) + ' neutralised in all' + (scLaps ? ' and ' + plural(scLaps, 'lap') + ' run behind it' : '') + '.');
    } else p.push('Green all the way, no Safety Cars or flags in this stint.');

    // incidents
    var issues = s.issues.filter(function (x) { return inside(x.ts) && x.src !== 'Sentinel'; });
    var pens = s.penalties.filter(function (x) { return inside(x.ts); });
    var alarms = {}; s.sentinelAlarms.filter(function (x) { return inside(x.ts); }).forEach(function (x) {
      var k = x.corner + ' ' + x.kind, m = alarms[k] || (alarms[k] = { n: 0, max: 0, crit: false }); m.n++; m.max = Math.max(m.max, x.value || 0); m.crit = m.crit || x.level === 'crit';
    });
    var msgs = s.pitmsgs.filter(function (x) { return inside(x.ts); }).length;
    var inc = [];
    issues.forEach(function (x) { inc.push(esc(x.text || x.cat) + ' <span class="tiny muted">(' + esc(x.cat) + ', ' + U.clock(x.ts) + ')</span>'); });
    pens.forEach(function (x) { inc.push('<span class="warn-t">' + esc(x.kind) + '</span>' + (x.reason ? ': ' + esc(x.reason) : '') + ' <span class="tiny muted">(' + U.clock(x.ts) + ')</span>'); });
    Object.keys(alarms).forEach(function (k) { var m = alarms[k]; inc.push('Sentinel ' + k.toUpperCase() + ' alarm' + (m.n > 1 ? ' x' + m.n : '') + ', up to ' + Math.round(m.max) + (k.indexOf('press') >= 0 ? ' psi' : '&deg;C') + (m.crit ? ' <span class="crit-t">critical</span>' : '')); });
    if (inc.length) p.push('Incidents, ' + inc.length + ' logged: ' + inc.join('; ') + '.');
    else p.push('Nothing logged against the car or the driver, a clean stint.');
    if (msgs) p.push((msgs === 1 ? 'One pit board message' : msgs + ' pit board messages') + ' went out to ' + first + ' during the run.');

    // Sentinel peaks per corner
    var th = (ctx.live && ctx.live.sentinel && ctx.live.sentinel.live && ctx.live.sentinel.live.thresh) || { br: [100, 300, 500, 700], ty: [40, 70, 100, 130] };
    var peak = { br: {}, ty: {} };
    laps.forEach(function (l) {
      if (!l.peaks) return;
      ['br', 'ty'].forEach(function (k) { CORNER.forEach(function (c) { var v = l.peaks[k] && l.peaks[k][c]; if (v != null && (!peak[k][c] || v > peak[k][c].v)) peak[k][c] = { v: v, lap: l.n }; }); });
    });
    var temps = function (k, what) {
      var have = CORNER.filter(function (c) { return peak[k][c]; });
      if (!have.length) return '';
      var hot = have.reduce(function (m, c) { return !m || peak[k][c].v > peak[k][m].v ? c : m; }, null);
      var t = th[k], band = function (v) { return v > t[3] ? 'crit-t' : v > t[2] ? 'warn-t' : ''; };
      var line = what + ' peaked at ' + have.map(function (c) { var v = peak[k][c].v, bc = band(v); return c.toUpperCase() + ' <b' + (bc ? ' class="' + bc + '"' : '') + '>' + v + '&deg;C</b>'; }).join(', ') +
        ', hottest ' + hot.toUpperCase() + ' on lap ' + peak[k][hot].lap + '.';
      var hv = peak[k][hot].v;
      if (hv > t[3]) line += ' That is over the top band, have a look at the ' + (k === 'br' ? 'pads and discs' : 'tyre') + ' on that corner.';
      else if (hv > t[2]) line += ' Into the warning band but not critical.';
      else line += ' All inside the working window.';
      var f = ['fl', 'fr'].filter(function (c) { return peak[k][c]; }), r = ['rl', 'rr'].filter(function (c) { return peak[k][c]; });
      if (k === 'br' && f.length && r.length) {
        var bias = avg(f.map(function (c) { return peak.br[c].v; })) - avg(r.map(function (c) { return peak.br[c].v; }));
        if (bias > 250) line += ' Fronts doing most of the work, about ' + Math.round(bias) + '&deg; hotter than the rears.';
      }
      return line;
    };
    var tb = temps('br', 'Brakes'), tt = temps('ty', 'Tyres');
    if (tb || tt) p.push([tb, tt].filter(Boolean).join(' '));
    else p.push('No Sentinel temperatures recorded for this stint.');

    // how it ended
    var stop = stops.filter(function (x) { return x.inTs <= b + 5000 && x.inTs >= b - 10 * MIN; }).pop();
    if (stop) {
      p.push('Boxed at ' + U.clock(stop.inTs) + ' for stop ' + stop.id + ' (' + stopType(stop.type).toLowerCase() + '): ' + U.dur(stop.laneMs) + ' in the lane' + (stop.added ? ', ' + stop.added + ' L in' : '') +
        (stop.driverIn && stop.driverIn !== stop.driverOut ? ', handed over to ' + esc(name(ctx, stop.driverIn)) : ', ' + first + ' stayed in') + '.');
    }
    return p.map(function (x) { return '<p>' + x + '</p>'; }).join('');
  }

  function panelLaps(ctx) {
    var d = ctx.d, rows = d.laps.slice(-60).reverse().map(function (l) {
      return '<tr><td class="num">' + l.n + '</td><td class="num">' + U.lap(l.ms) + '</td><td><span class="lc lc-' + l.cls + '"></span> ' + l.cls + '</td><td>' + esc(U.short(name(ctx, l.driverId))) + '</td><td class="small muted">' + esc(l.flag) + '</td><td class="num small muted">' + U.clock(l.ts) + '</td></tr>';
    }).join('');
    var c = d.lapCounts;
    var body = '<details><summary>Lap history (' + d.laps.length + ' laps: push ' + c.push + ', green ' + c.green + ', slow ' + c.slow + ', SC ' + c.sc + ', pit ' + c.pit + ')</summary><div class="scroll" style="max-height:360px;overflow-y:auto;margin-top:6px"><table><thead><tr><th class="num">Lap</th><th class="num">Time</th><th>Class</th><th>Driver</th><th>Flag</th><th class="num">At</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';
    return { id: 'laps', html: card('Laps', body, 'classes feed the fuel model'), form: true };
  }

  function panelTrace(ctx) {
    var d = ctx.d, tr = d.trace, rs = d.raceSession;
    if (!tr || !d.plan) return { id: 'trace', html: card('Fuel trace', '<div class="muted">-</div>') };
    var t0 = rs.startTs, t1 = d.plan.raceEndTs, W = 600, H = 180, pad = 26, cap = d.P.capacity;
    var x = function (t) { return pad + (t - t0) / (t1 - t0) * (W - pad - 6); };
    var y = function (v) { return 8 + (1 - Math.max(0, v) / cap) * (H - 28); };
    var path = function (pts) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join(' '); };
    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    [0, 0.5, 1].forEach(function (f) { var v = cap * f; svg += '<line x1="' + pad + '" x2="' + (W - 6) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#26282c"/><text x="2" y="' + (y(v) + 3) + '">' + Math.round(v) + '</text>'; });
    svg += '<line x1="' + pad + '" x2="' + (W - 6) + '" y1="' + y(d.P.reserve) + '" y2="' + y(d.P.reserve) + '" stroke="#E03030" stroke-dasharray="4 3"/>';
    var hours = (t1 - t0) / HOUR, step = hours > 20 ? 4 : hours > 8 ? 2 : 1;
    for (var h = 0; h <= hours; h += step) svg += '<text x="' + x(t0 + h * HOUR) + '" y="' + (H - 3) + '" text-anchor="middle">' + h + 'h</text>';
    if (tr.past.length) svg += '<path d="' + path(tr.past) + '" fill="none" stroke="#c9ccd2" stroke-width="2"/>';
    if (tr.future.length) svg += '<path d="' + path(tr.future) + '" fill="none" stroke="#CE93D8" stroke-width="2" stroke-dasharray="5 4"/>';
    if (rs.started) svg += '<line x1="' + x(d.now) + '" x2="' + x(d.now) + '" y1="4" y2="' + (H - 16) + '" stroke="#fff"/>';
    return { id: 'trace', html: card('Fuel trace', svg + '</svg><div class="tiny muted">Solid: estimate so far. Dashed: plan. Red: ' + d.P.reserve + ' L reserve.</div>') };
  }

  function panelModel(ctx) {
    var d = ctx.d, m = d.fuel.model;
    var rows = m.periods.slice(-6).reverse().map(function (p) {
      var pred = m.G * p.g + m.S * p.s;
      return '<tr><td class="num">' + U.clock(p.t1) + '</td><td>' + esc(p.kind) + '</td><td class="num">' + U.L(p.M) + '</td><td class="num">' + U.L(pred) + '</td><td class="num">' + U.L((p.g + p.s), 2) + ' h</td></tr>';
    }).join('');
    var body = '<div class="row"><div><span class="lbl">Green</span><b class="mono" style="font-size:1.2em">' + U.L(m.G, 2) + '</b> <span class="small muted">L/h (baseline ' + U.L(m.G0, 2) + ')</span></div><span class="spacer"></span><div><span class="lbl">Safety car</span><b class="mono" style="font-size:1.2em">' + U.L(m.S, 2) + '</b> <span class="small muted">L/h</span></div></div>';
    if (m.deviation && Math.abs(m.deviation.pct) >= 5) body += '<div class="note ' + (Math.abs(m.deviation.pct) >= 10 ? 'warn' : '') + '" style="margin-top:8px">Last measured stint: ' + U.L(m.deviation.measured) + ' L vs ' + U.L(m.deviation.predicted) + ' L predicted (' + (m.deviation.pct > 0 ? '+' : '') + m.deviation.pct.toFixed(0) + '%).</div>';
    body += rows ? '<table style="margin-top:8px"><thead><tr><th class="num">At</th><th>Measured by</th><th class="num">Used L</th><th class="num">Model L</th><th class="num">Span</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="small muted" style="margin-top:8px">No measurements yet. Brim fills and gauge readings calibrate the model.</div>';
    if (ctx.eng) body += '<div class="row" style="margin-top:8px">' + (d.session.running ? '<button class="btn sm" data-act="gauge">Log gauge reading</button>' : '') + (m.nCal ? '<button class="btn sm" data-act="savemodel">Save learned burn to this car</button>' : '') + '</div>';
    return { id: 'model', html: card('Fuel model', body, m.nCal ? m.nCal + ' measured stint' + (m.nCal > 1 ? 's' : '') : 'baseline') };
  }

  function panelWhatIf(ctx) {
    var w = ctx.whatIf || {}, b = ctx.base, d = ctx.d, cmp = '';
    if (ctx.whatIfOn && b && b.plan && d.plan) {
      var r = function (l, a, c) { return '<tr><td>' + l + '</td><td class="num">' + a + '</td><td class="num">' + c + '</td></tr>'; };
      cmp = '<table style="margin-top:8px"><thead><tr><th></th><th class="num">Live plan</th><th class="num">What-if</th></tr></thead><tbody>' + r('Stops', b.plan.stops.length, d.plan.stops.length) + r('Fuel stops', b.plan.fuelStops, d.plan.fuelStops) +
        r('Finish fuel', U.L(b.plan.finishFuelL) + ' L', U.L(d.plan.finishFuelL) + ' L') + r('Next stop', b.nextStop ? U.clock(b.nextStop.ts) : '-', d.nextStop ? U.clock(d.nextStop.ts) : '-') + '</tbody></table>';
    }
    var body = '<div class="fgrid"><label class="f">Lap time change (s)<input id="wi-lap" type="number" step="0.5" value="' + (w.lapDeltaS || 0) + '"></label>' +
      '<label class="f">Safety car (min)<input id="wi-sc" type="number" step="1" min="0" value="' + (w.scMin || 0) + '"></label>' +
      '<label class="f">SC saving (%)<input id="wi-scpct" type="number" step="5" value="' + (w.scPct != null ? w.scPct : 40) + '"></label>' +
      '<label class="f">Green burn (%)<input id="wi-gm" type="number" step="1" value="' + (w.greenMult ? Math.round((w.greenMult - 1) * 100) : 0) + '"></label></div>' +
      '<div class="row" style="margin-top:8px"><button class="btn primary sm" data-act="whatif">Run</button><button class="btn sm" data-act="whatifclear">Clear</button><span class="tiny muted">This screen only - the table and timeline show the scenario while it is active</span></div>' + cmp;
    return { id: 'whatif', html: card('What-if', body), form: true };
  }

  function panelRules(ctx) {
    var r = ctx.s.config.rules || {};
    return { id: 'rules', html: card('Regulations', '<details><summary>' + esc((r.organiser || '').split(' (')[0]) + ' - ' + esc(r.version) + '</summary><ul class="rules" style="margin-top:6px">' + (r.notes || []).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></details>'), form: true };
  }

  /* ================================================================== FUEL PLAN
     One timeline with only the fuel stops of the plan being run; click a stop for its detail: who attends and in which role,
     litres, jerry cans to bring, and the stop step by step with its GEO / ENG handshakes. Changing the litres of a stop
     re-plans every later stop (previewed before it is applied). */
  V.fuelSelected = function (ctx) {
    var list = ctx.fp ? ctx.fp.stops : [];
    if (!list.length) return null;
    if (ctx.fuelSel != null) {
      var best = null, bd = 20 * MIN;
      list.forEach(function (x) { var dd = Math.abs(x.ts - ctx.fuelSel); if (dd < bd) { bd = dd; best = x; } });
      if (best) return best;
    }
    return list.filter(function (x) { return x.live; })[0] || list.filter(function (x) { return !x.done; })[0] || list[list.length - 1];
  };
  V.fuel = function (ctx) {
    var d = ctx.d;
    if (!d.plan || !ctx.fp) return { layout: 'single', cols: [[{ id: 'fpnone', html: card('Fuel plan', '<div class="muted">No race session configured.</div>') }, panelStock(ctx)]] };
    var sel = V.fuelSelected(ctx);
    return { layout: 'plan-grid', top: [panelFuelTimeline(ctx, sel), panelStock(ctx)], cols: [[panelFuelSteps(ctx, sel)], [panelFuelStop(ctx, sel), panelFuelCascade(ctx, sel)]] };
  };

  /* Fuel stock at the track: what was brought, what has been poured, what is left against what is still needed. */
  function panelStock(ctx) {
    var k = ctx.d.stock, st = ctx.s.stock || { adds: [], counts: [] };
    if (!k) return { id: 'fpstock', html: card('Fuel stock at the track', '<div class="muted">No stock data.</div>') };
    var cans = function (L) { return (L / k.canL).toFixed(1) + ' cans'; };
    var spareCls = k.level === 'crit' ? 'crit-t' : k.level === 'warn' ? 'warn-t' : 'ok-t';
    var chips = [
      ['Brought', U.L(k.broughtL, 0) + ' L' + (k.set ? '' : ' <span class="tiny warn-t">suggested, not set</span>')],
      ['Poured into the car', U.L(k.poured, 0) + ' L'],
      ['Bought at the track', U.L(k.added, 0) + ' L'],
      ['Left at the track', U.L(k.leftL, 0) + ' L <span class="tiny muted">' + cans(k.leftL) + '</span>'],
      ['Still needed to finish', U.L(k.needL, 0) + ' L <span class="tiny muted">' + cans(k.needL) + '</span>'],
      [k.marginL < 0 ? 'SHORT' : 'Spare', '<span class="' + spareCls + '">' + (k.marginL < 0 ? '-' : '+') + U.L(Math.abs(k.marginL), 0) + ' L</span> <span class="tiny muted">' + cans(Math.abs(k.marginL)) + '</span>']
    ];
    var h = '<div class="chips-sum">' + chips.map(function (c) { return '<div class="sumchip"><span class="lbl">' + c[0] + '</span><span class="v">' + c[1] + '</span></div>'; }).join('') + '</div>';
    var parts = k.sessions.map(function (x) { return esc(x.name) + ' ' + U.L(x.litres, 0) + ' L' + (x.running ? ' (running)' : ''); });
    h += '<div class="small muted" style="margin-top:6px">Still needed = burn left ' + U.L(k.burnL, 0) + ' L' + (parts.length ? ' (' + parts.join(', ') + ')' : '') +
      ' + ' + U.L(k.reserveL, 0) + ' L reserve - ' + U.L(k.inCarL, 0) + ' L in the car. The race follows the live plan, so expected Safety Cars count; other sessions assume green flag.' +
      (k.count ? ' Stock recounted at ' + U.clock(k.count.ts) + ': ' + U.L(k.count.litres, 0) + ' L.' : '') + '</div>';
    if (k.marginL < 0) h += '<div class="note crit-t" style="margin-top:6px"><b>Not enough fuel at the track to finish.</b> Buy ' + U.L(-k.marginL, 0) + ' L (' + Math.ceil(-k.marginL / k.canL) + ' x ' + k.canL + ' L cans) or change the plan.</div>';
    var moves = k.pours.map(function (x) { return { ts: x.ts, txt: 'Poured ' + U.L(x.litres) + ' L' + (x.stopId ? ' at stop ' + x.stopId : ' (fill outside a stop)') + (x.note ? ' - ' + esc(x.note) : ''), d: -x.litres }; })
      .concat(st.adds.map(function (a) { return { ts: a.ts, txt: 'Bought ' + U.L(a.litres) + ' L' + (a.note ? ' - ' + esc(a.note) : ''), d: a.litres }; }))
      .concat(st.counts.map(function (c) { return { ts: c.ts, txt: 'Recounted: ' + U.L(c.litres) + ' L at the track' + (c.note ? ' - ' + esc(c.note) : ''), d: null }; }))
      .filter(function (m) { return m.ts <= ctx.d.now; })
      .sort(function (a, b) { return b.ts - a.ts; }).slice(0, 8);
    if (moves.length) h += '<table style="margin-top:8px"><thead><tr><th class="num">Time</th><th>Movement</th><th class="num">Stock</th></tr></thead><tbody>' + moves.map(function (m) {
      return '<tr><td class="num">' + U.clock(m.ts) + '</td><td>' + m.txt + '</td><td class="num">' + (m.d == null ? '=' : (m.d > 0 ? '+' : '') + U.L(m.d)) + '</td></tr>'; }).join('') + '</tbody></table>';
    if (ctx.eng) h += '<div class="row" style="margin-top:10px"><button class="btn sm" data-act="stockfill">Log a fill outside a stop</button><button class="btn sm" data-act="stockadd">Fuel bought</button><button class="btn sm" data-act="stockcount">Recount stock</button><span class="spacer"></span><span class="tiny muted">Pit stop litres come off the stock on their own. Set what you brought on Setup.</span></div>';
    return { id: 'fpstock', html: card('Fuel stock at the track', h, 'every pour comes off the stock') };
  }

  function fpLabel(ctx, x) { return 'F' + x.n + ' ' + U.clock(x.ts); }
  function panelFuelTimeline(ctx, sel) {
    var d = ctx.d, s = ctx.s, fp = ctx.fp, rs = d.raceSession, pl = d.plan;
    var t0 = rs.startTs, t1 = pl.raceEndTs, span = Math.max(1, t1 - t0);
    var x = function (t) { return Math.max(0, Math.min(100, (t - t0) / span * 100)); };
    var sc = s.scenarios || {}, ap = sc.active || 'A', apl = sc.plans && sc.plans[ap];
    var todo = fp.stops.filter(function (f) { return !f.done; }), done = fp.stops.filter(function (f) { return f.done; });
    var litres = 0, cans = 0; todo.forEach(function (f) { litres += f.add; cans += f.cans.n; });
    var chips = [['Fuel stops', done.length + ' done, ' + todo.length + ' to go'], ['Litres to go', U.L(litres, 0) + ' L'], ['Jerry cans to go', cans + ' x ' + fp.canL + ' L'], ['Finish fuel', U.L(pl.finishFuelL) + ' L'], ['Running', 'Scenario ' + ap + (apl ? ' - ' + esc(apl.name) : '')]];
    var h = '<div class="chips-sum">' + chips.map(function (c) { return '<div class="sumchip"><span class="lbl">' + c[0] + '</span><span class="v">' + c[1] + '</span></div>'; }).join('') + '</div>';
    // labels in up to three tiers so neighbouring stops never overlap
    var lastX = [-100, -100, -100], b = '<div class="fptl">';
    b += '<div class="fp-track"></div>';
    if (rs.started) b += '<div class="fp-past" style="width:' + x(d.now) + '%"></div>';
    todo.forEach(function (f) { if (f.window) b += '<div class="fp-win" style="left:' + x(f.window.openTs) + '%;width:' + Math.max(0.4, x(f.window.closeTs) - x(f.window.openTs)) + '%" title="' + esc('Fuel window F' + f.n + ': ' + U.clock(f.window.openTs) + '-' + U.clock(f.window.closeTs)) + '"></div>'; });
    fp.stops.forEach(function (f) {
      var px = x(f.ts), tier = 0;
      while (tier < 3 && px - lastX[tier] < 7.5) tier++;
      if (tier > 2) tier = (f.n - 1) % 3;
      lastX[tier] = px;
      var isSel = sel && sel.ts === f.ts, st = f.done ? 'done' : f.live ? 'live' : 'plan';
      var al = px < 4 ? ' al' : px > 96 ? ' ar' : '';
      var line2 = f.add + ' L' + (f.done ? '' : ' &middot; ' + f.cans.n + (f.cans.n === 1 ? ' can' : ' cans')) + (f.change && f.driverIn ? ' &middot; ' + esc(U.short(name(ctx, f.driverIn))) + ' in' : '');
      var tip = (f.done ? 'Done: ' : f.live ? 'In progress: ' : 'Planned: ') + 'fuel stop F' + f.n + ' at ' + U.clock(f.ts) + ', ' + f.add + ' L' + (f.change ? ', ' + name(ctx, f.driverOut) + ' to ' + name(ctx, f.driverIn) : '') + ' - click for the detail';
      b += '<div class="fp-lead ' + st + '" style="left:' + px + '%;top:' + (tier * 30 + 28) + 'px;height:' + (96 - tier * 30 - 28) + 'px"></div>';
      b += '<button class="fp-lbl ' + st + (isSel ? ' sel' : '') + (f.litresSet ? ' set' : '') + al + '" data-act="fpsel" data-ts="' + f.ts + '" style="left:' + px + '%;top:' + (tier * 30) + 'px" title="' + esc(tip) + '"><b>' + fpLabel(ctx, f) + '</b><span>' + line2 + '</span></button>';
      b += '<button class="fp-mk ' + st + (isSel ? ' sel' : '') + '" data-act="fpsel" data-ts="' + f.ts + '" style="left:' + px + '%" title="' + esc(tip) + '"></button>';
    });
    // preview of a litres change: where the later fuel stops would move to
    var pv = ctx.fpPreview;
    if (pv && pv.plan) pv.plan.stops.filter(function (f) { return f.add > 0 && f.ts > pv.fromTs + 1000; }).forEach(function (f) { b += '<div class="fp-ghost" style="left:' + x(f.ts) + '%" title="' + esc('With the new litres: fuel stop at ' + U.clock(f.ts) + ', ' + f.add + ' L') + '"></div>'; });
    if (rs.started) b += '<div class="fp-now" style="left:' + x(d.now) + '%"></div>';
    var hours = span / HOUR, step = hours > 24 ? 3 : hours > 12 ? 2 : 1;
    for (var hh = 0; hh <= hours; hh += step) b += '<span class="fp-tick" style="left:' + x(t0 + hh * HOUR) + '%">' + U.clock(t0 + hh * HOUR) + '</span>';
    b += '</div>';
    var legend = '<div class="row tiny muted" style="margin-top:4px"><span><i class="lg fp-l-done"></i> done</span><span><i class="lg fp-l-plan"></i> planned</span><span><i class="lg fp-l-live"></i> in progress</span><span><i class="lg fp-l-set"></i> litres set by you</span><span><i class="lg fp-l-win"></i> fuel window</span>' + (pv ? '<span><i class="lg fp-l-ghost"></i> preview of your change</span>' : '') + '<span class="spacer"></span>Only fuel stops are shown. Driver-only stops are on Race Plan.</div>';
    return { id: 'fptl', html: card('Fuel stops - the plan being run', h + '<div class="scroll"><div style="min-width:880px">' + b + '</div></div>' + legend, 'click a stop for its detail') };
  }

  function whoList(ctx, rows) {
    return '<div class="fp-who">' + rows.map(function (r) { return '<span class="r">' + esc(r[0]) + '</span><span>' + (r[1] ? '<b>' + esc(r[1]) + '</b>' : r[3] ? '<span class="muted">none free</span>' : '<b class="crit-t">UNASSIGNED</b>' + (r[2] ? ' <span class="tiny muted">' + esc(r[2]) + '</span>' : '')) + '</span>'; }).join('') + '</div>';
  }
  function cansText(c, canL) { return c.n ? c.n + ' x ' + canL + ' L can' + (c.n > 1 ? 's' : '') + (c.partL > 0 ? ' (' + c.full + ' full + 1 with ' + U.L(c.partL) + ' L)' : ' (all full)') : 'none'; }

  function panelFuelStop(ctx, f) {
    var d = ctx.d, fp = ctx.fp;
    if (!f) return { id: 'fpstop', html: card('Fuel stop', '<div class="muted">No fuel stops in this plan.</div>') };
    var h = '';
    if (f.done || (f.live && f.id)) {
      h += '<div class="facts"><div class="fact"><span class="lbl">Added</span><div class="v">' + f.add + ' L</div><div class="s">' + esc(f.id) + (f.live ? ' in progress' : ' done') + '</div></div>' +
        '<div class="fact"><span class="lbl">Cans</span><div class="v">' + f.cans.n + '</div><div class="s">' + fp.canL + ' L cans</div></div>' +
        '<div class="fact"><span class="lbl">Fuelling</span><div class="v">' + (f.fuelMs != null ? U.dur(f.fuelMs) : '-') + '</div><div class="s">' + (f.change ? esc(U.short(name(ctx, f.driverOut))) + ' &rarr; ' + esc(U.short(name(ctx, f.driverIn))) : 'no driver change') + '</div></div></div>';
      return { id: 'fpstop', html: card('Fuel stop F' + f.n + ' - ' + U.clock(f.ts), h, f.live ? 'in progress' : 'done') };
    }
    h += '<div class="facts">' +
      '<div class="fact"><span class="lbl">Arrive with</span><div class="v">' + U.L(f.fuelArr) + ' L</div><div class="s">lap ~' + d.lapAt(f.ts) + ', in ' + U.mins(f.ts - d.now) + '</div></div>' +
      '<div class="fact"><span class="lbl">Inject</span><div class="v purple-t">' + (f.brim ? 'Brim ' : '') + f.add + ' L</div><div class="s">' + (f.litresSet ? 'set by you' : 'from the planner') + ', leave with ' + U.L(f.fuelAfter) + ' L</div></div>' +
      '<div class="fact"><span class="lbl">Bring</span><div class="v">' + f.cans.n + (f.cans.n === 1 ? ' can' : ' cans') + '</div><div class="s">' + esc(cansText(f.cans, fp.canL)) + '</div></div></div>';
    if (f.overStore) h += '<div class="note warn" style="margin-top:8px">' + f.add + ' L is more than the ' + fp.method.maxStoredL + ' L the fuel area may hold for ' + esc(fp.method.label) + '.</div>';
    if (f.window) h += '<div class="small muted" style="margin-top:6px">Fuel window ' + U.clock(f.window.openTs) + '-' + U.clock(f.window.closeTs) + ' (laps ' + d.lapAt(f.window.openTs) + '-' + d.lapAt(f.window.closeTs) + '). Stationary ~' + U.mins(f.statMs) + '.</div>';
    var rc = f.refuel;
    h += '<div class="sep"></div><span class="lbl">Refuel crew (' + esc(fp.method ? fp.method.label : '') + ')</span>' + whoList(ctx, rc.assign.map(function (a) { return [a.label.replace(' (9 kg foam)', ''), a.name, a.reason]; }));
    var drv = f.change ? [['Driver out', name(ctx, f.driverOut)], ['Driver in', name(ctx, f.driverIn)]] : [['Driver (stays in)', name(ctx, f.driverOut)]];
    h += '<span class="lbl" style="margin-top:8px">Also at this stop</span>' + whoList(ctx, drv.concat(f.support.map(function (a) { return [a.label, a.name, '', true]; })));
    h += '<div class="tiny muted" style="margin-top:4px">Crew is forecast from the shift plan at ' + U.clock(f.ts) + '; the next fuel stop uses who is available right now.</div>';
    // litres editor: future stops only (not the stop in progress, not event stops)
    var editable = ctx.eng && !f.live && !f.event && f.ts > d.now + 2 * MIN;
    if (editable) {
      var cur = ctx.fuelEdit && ctx.fuelEdit.ts === f.ts ? ctx.fuelEdit.litres : f.add;
      var maxL = Math.min(fp.maxAdd, Math.round((fp.capacity - f.fuelArr) * 2) / 2);
      h += '<div class="sep"></div><span class="lbl">Change the litres for F' + f.n + '</span><div class="row" style="margin-top:6px"><button class="btn sm" data-act="fpstep" data-d="-5">-5</button><input id="fp-l" data-ts="' + f.ts + '" type="number" step="0.5" min="0" max="' + maxL + '" value="' + cur + '" style="width:90px"><button class="btn sm" data-act="fpstep" data-d="5">+5</button><button class="btn sm" data-act="fpbrim" data-l="' + maxL + '">Brim (' + maxL + ' L)</button><span class="tiny muted">L</span></div>' +
        '<div class="row" style="margin-top:8px"><button class="btn primary sm" data-act="fpapply" data-ts="' + f.ts + '">Apply to the running plan</button>' + (f.litresSet ? '<button class="btn sm" data-act="fpauto" data-ts="' + f.ts + '">Back to planner litres</button>' : '') + (ctx.fuelEdit ? '<button class="btn sm" data-act="fpcancel">Cancel</button>' : '') + '</div>' +
        '<div class="tiny muted" style="margin-top:4px">Less fuel brings the next fuel stop closer, more fuel pushes it later; every later stop re-plans. The preview below shows the effect before you apply it. Applied to Scenario ' + ((ctx.s.scenarios && ctx.s.scenarios.active) || 'A') + ' (Reset on Scenarios undoes it).</div>';
    }
    return { id: 'fpstop', html: card('Fuel stop F' + f.n + ' - ' + U.clock(f.ts), h, f.litresSet ? '<span class="purple-t">litres set by you</span>' : 'planned'), form: true };
  }

  // what a litres change does to the rest of the race, before it is applied
  function panelFuelCascade(ctx, f) {
    var pv = ctx.fpPreview, d = ctx.d;
    if (!pv || !f || f.done || f.live) return { id: 'fpcascade', html: '' };
    if (!pv.plan) return { id: 'fpcascade', html: card('Effect of the change', '<div class="muted small">Working...</div>') };
    var after = function (pl) { return pl.stops.filter(function (x) { return x.add > 0 && x.ts > pv.fromTs + 1000; }); };
    var a = after(d.plan), b = after(pv.plan), n = Math.max(a.length, b.length), rows = '';
    for (var i = 0; i < Math.min(n, 8); i++) {
      var x = a[i], y = b[i], dt = x && y ? Math.round((y.ts - x.ts) / MIN) : null;
      rows += '<tr><td class="num">' + (i + 1) + '</td><td class="num">' + (x ? U.clock(x.ts) + ' &middot; ' + x.add + ' L' : '-') + '</td><td class="num">' + (y ? U.clock(y.ts) + ' &middot; ' + y.add + ' L' : '<span class="ok-t">removed</span>') + '</td><td class="num ' + (dt < 0 ? 'warn-t' : dt > 0 ? 'ok-t' : '') + '">' + (dt == null ? (x ? '' : '<span class="warn-t">new</span>') : (dt > 0 ? '+' : '') + dt + ' min') + '</td></tr>';
    }
    var sum = [['Fuel stops', d.plan.fuelStops + ' &rarr; ' + pv.plan.fuelStops], ['Stops', d.plan.stops.length + ' &rarr; ' + pv.plan.stops.length], ['Stationary', U.mins(d.plan.stationaryMs) + ' &rarr; ' + U.mins(pv.plan.stationaryMs)], ['Finish fuel', U.L(d.plan.finishFuelL) + ' &rarr; ' + U.L(pv.plan.finishFuelL) + ' L']];
    var h = '<div class="small">F' + f.n + ': ' + f.add + ' L &rarr; <b class="purple-t">' + pv.litres + ' L</b></div><div class="chips-sum" style="margin-top:6px">' + sum.map(function (c) { return '<div class="sumchip"><span class="lbl">' + c[0] + '</span><span class="v">' + c[1] + '</span></div>'; }).join('') + '</div>' +
      '<table><thead><tr><th class="num">Next fuel stops</th><th class="num">Now</th><th class="num">With the change</th><th class="num">Moves</th></tr></thead><tbody>' + rows + '</tbody></table>';
    if (pv.plan.warnings.length) h += '<div class="note warn" style="margin-top:8px">' + pv.plan.warnings.slice(0, 3).map(esc).join('<br>') + '</div>';
    return { id: 'fpcascade', html: card('Effect of the change', h, 'preview - nothing applied yet', 'gatecard') };
  }

  // the stop step by step: when, who, what - and for the stop in progress, the live GEO / ENG handshake of each step
  function panelFuelSteps(ctx, f) {
    var d = ctx.d, fp = ctx.fp, agileOn = ctx.devices.agile && ctx.devices.agile.status === 'connected';
    if (!f) return { id: 'fpsteps', html: card('Stop procedure', '<div class="muted">-</div>') };
    if (f.done) return { id: 'fpsteps', html: card('Stop procedure', '<div class="small muted">F' + f.n + ' is done (' + esc(f.id) + '). Pick a planned stop on the timeline to see its procedure and crew.</div>') };
    var g = d.gates && f.live ? d.gates : null, gs = {};
    if (g) g.list.forEach(function (x) { gs[x.id] = x; });
    var rc = f.refuel || { assign: [] };
    var fuelCrew = rc.assign.map(function (a) { return [a.label.replace(' (9 kg foam)', '').replace('Vehicle ', '') + (a.supervise ? ' (supervising)' : ''), a.name]; });
    var sup = {}; (f.support || []).forEach(function (a) { sup[a.key] = a.name; });
    var tm = f.times || {}, eng = sup.engineer || 'Pit wall engineer';
    var nm = function (id) { return name(ctx, id); };
    var rows = [];
    if (f.change) rows.push({ t: f.ts - 30 * MIN, title: 'Incoming driver gets ready', who: [['Driver in', nm(f.driverIn)]], what: 'Kit on, hydrate, at the pit wall by ' + U.clock(f.ts - 10 * MIN) + '.' });
    rows.push({ t: tm.prep, title: 'Refuel crew to the fuel bay', who: fuelCrew,
      what: 'Summoned 5 min before pit-in. Stage ' + cansText(f.cans, fp.canL) + ' = ' + f.add + ' L. 9 kg foam extinguisher at the bay.' + (f.change ? ' The incoming driver joins the zone to supervise, hands off; the outgoing driver goes straight to rest.' : '') });
    rows.push({ t: tm.notify, title: 'BOX BOX on the pit board', who: [['Engineer', eng]], what: 'Last lap of the stint: the call on the Race tab turns into NOTIFY DRIVER.' });
    rows.push({ t: tm.pitIn, step: 'pitin', title: 'Pit in', who: [['Engineer', eng]], what: 'The car is in the pit lane.' });
    rows.push({ t: tm.swap, step: 'driver', title: f.change ? 'Driver change' : 'Driver stays in', who: f.change ? [['Out', nm(f.driverOut)], ['In', nm(f.driverIn)], ['Mechanic', sup.mechanic, true]] : [['Driver', nm(f.driverOut)]],
      what: f.change ? (d.P.swapDuringFuel ? 'Can be done while fuelling.' : 'Before fuelling: no driver swap while the car is being fuelled.') : 'No change at this stop.' });
    rows.push({ t: tm.fuelOn, step: 'fuelon', title: 'Fuelling started', who: fuelCrew,
      what: 'Pour ' + f.add + ' L (' + f.cans.n + (f.cans.n === 1 ? ' can' : ' cans') + '). Minimum fuelling time ' + Math.round(d.P.fuelMinMs / MIN) + ' min; no other work on the car.' });
    rows.push({ t: tm.fuelOff, step: 'fuel', title: 'Fuel completed', who: [['Engineer', eng]], what: 'Record the litres and cans. The car leaves with ~' + U.L(f.fuelAfter) + ' L.' });
    rows.push({ t: tm.pitOut, step: 'pitout', title: 'Pit out', who: [['Engineer', eng]], what: 'The car is leaving the pit lane. Stationary ~' + U.mins(f.statMs) + '.' });
    var h = '<div class="vt">' + rows.map(function (r) {
      var x = r.step && gs[r.step], hs = '';
      if (x) hs = '<div class="vt-hs">' + (x.state === 'skip' ? '' : hsMarks(x, agileOn)) + ' ' + hsStatus(x, agileOn) + '</div>';
      else if (r.step) hs = '<div class="vt-hs"><span class="hs-marks">' + (r.step === 'driver' ? '<span class="hs na">GEO n/a</span>' : '<span class="hs pre" title="' + esc(STEP_GEO[r.step]) + '">GEO</span>') + '<span class="hs pre">ENG ' + STEP_ENG[r.step] + '</span></span>' + (r.step !== 'driver' ? ' <span class="tiny muted">' + esc(STEP_GEO[r.step]) + '</span>' : '') + '</div>';
      var cls = 'vt-row' + (r.step ? ' gate' : '') + (x ? ' m-' + x.mode : '') + (g && g.current && x && g.current.id === x.id ? ' cur' : '');
      return '<div class="' + cls + '"><span class="vt-t mono">' + U.clock(r.t) + '</span><div class="vt-title">' + esc(r.title) + '</div>' +
        (r.who.length ? '<div class="vt-who">' + r.who.map(function (w) { return '<span class="tag">' + esc(w[0]) + '</span> ' + (w[1] ? '<b>' + esc(w[1]) + '</b>' : w[2] ? '<span class="muted">none free</span>' : '<b class="crit-t">UNASSIGNED</b>'); }).join(' &nbsp; ') + '</div>' : '') +
        '<div class="vt-what small muted">' + r.what + '</div>' + hs + '</div>';
    }).join('') + '</div>';
    h += '<div class="tiny muted" style="margin-top:6px">' + (g ? 'Live: this stop is in progress - confirm the steps on the Race tab (Stop handshake card).' : 'Each step marked GEO / ENG is a handshake on the Race tab when the car comes in: the geofence and your button must agree.') + ' Times are planned estimates.</div>';
    return { id: 'fpsteps', html: card('F' + f.n + ' step by step', h, f.live ? 'in progress' : 'planned ' + U.clock(f.ts)) };
  }

  /* ================================================================== TEAM */
  V.team = function (ctx) {
    var col = [];
    var rc = ctx.d.refuelCrew;
    if (rc && rc.issues.length) col.push(panelCrewFix(ctx));
    return { layout: 'single', cols: [col.concat([panelRoster(ctx), panelGantt(ctx)])] };
  };

  function panelCrewFix(ctx) {
    var d = ctx.d, rc = d.refuelCrew, s = ctx.s, nf = d.nextFuel;
    var h = '<div class="small" style="margin-bottom:8px">Stop ' + (nf ? nf.k + ' at ~' + U.clock(nf.ts) : '') + ' needs every refuel role filled. Pick a fix - each one is logged.</div>';
    rc.assign.filter(function (a) { return !a.name; }).forEach(function (a) {
      h += '<div class="gline"><span class="gl-n" style="width:180px">' + esc(a.label.replace(' (9 kg foam)', '')) + '</span><div class="row" style="gap:6px">';
      (a.taggedIds || []).forEach(function (id) { h += '<button class="btn sm" data-act="crewwake" data-id="' + id + '">Wake ' + esc(name(ctx, id)) + ' (set Available)</button>'; });
      (a.suggestIds || []).forEach(function (id) { h += '<button class="btn sm primary" data-act="crewassign" data-id="' + id + '" data-role="' + a.key + '">Give ' + esc(name(ctx, id)) + ' this role</button>'; });
      if (!(a.taggedIds || []).length && !(a.suggestIds || []).length) h += '<span class="small muted">Nobody available - change someone\'s status below or add a member in Setup.</span>';
      h += '</div></div>';
    });
    return { id: 'crewfix', html: card('Fix the refuel crew', h, 'from the FIX button', 'gatecard') };
  }

  function panelRoster(ctx) {
    var d = ctx.d, s = ctx.s, q = s.drivers.queue || [];
    var byId = {}; d.crew.forEach(function (c) { byId[c.id] = c; });
    var members = q.map(function (id) { return byId[id]; }).filter(Boolean).concat(d.crew.filter(function (c) { return q.indexOf(c.id) < 0; }));
    var rows = members.map(function (c) {
      var qi = q.indexOf(c.id), st = d.driverStats[c.id];
      var rest = st && st.lastEndTs && s.drivers.activeId !== c.id ? d.now - st.lastEndTs : null;
      var ctl = ctx.eng ? '<select data-act-change="crewstatus" data-id="' + c.id + '">' + ['auto', 'available', 'resting', 'sleeping', 'offline', 'flag', 'unavailable'].map(function (k) { return '<option value="' + k + '"' + ((c.src === 'manual' && c.status === k) ? ' selected' : '') + '>' + (k === 'auto' ? 'Schedule' : U.STATUS_LABEL[k]) + '</option>'; }).join('') + '</select>' : '';
      var move = ctx.eng && qi >= 0 ? '<button class="btn sm" data-act="qmove" data-id="' + c.id + '" data-dir="-1"' + (qi === 0 ? ' disabled' : '') + '>Up</button> <button class="btn sm" data-act="qmove" data-id="' + c.id + '" data-dir="1"' + (qi === q.length - 1 ? ' disabled' : '') + '>Down</button>' : '';
      return '<tr' + (c.id === s.drivers.activeId ? ' class="current"' : '') + '><td class="num">' + (qi >= 0 ? qi + 1 : '') + '</td><td>' + U.presence(c.status) + '</td><td>' + (qi >= 0 ? '<span class="cdot" style="background:' + U.driverColour(s, c.id) + '"></span> ' : '') + '<b>' + esc(c.name) + '</b><div class="roles">' + c.roles.map(function (r) { return '<span class="role">' + esc(r) + '</span>'; }).join('') + '</div></td>' +
        '<td>' + esc(U.STATUS_LABEL[c.status] || c.status) + (c.reason ? '<div class="tiny muted">' + esc(c.reason) + '</div>' : '') + '</td>' +
        '<td class="num ' + (c.needsRest ? 'warn-t' : '') + '">' + (c.dutyMs ? (c.dutyMs / HOUR).toFixed(1) + ' h' : '-') + (c.overridden ? ' ovr' : '') + (ctx.eng && c.needsRest ? ' <button class="btn sm" data-act="override" data-id="' + c.id + '">+1 h</button>' : '') + '</td>' +
        '<td class="num">' + (st ? U.mins(st.driveMs) : '') + '</td><td class="num">' + (st ? st.stints : '') + '</td><td class="num">' + (st ? U.lap(st.best) : '') + '</td><td class="num">' + (rest != null ? U.mins(rest) : '') + '</td>' +
        '<td>' + ctl + '</td><td>' + move + '</td></tr>';
    }).join('');
    var body = '<div class="scroll"><table><thead><tr><th class="num">Rot.</th><th></th><th>Member</th><th>Status</th><th class="num">On duty</th><th class="num">Driven</th><th class="num">Stints</th><th class="num">Best</th><th class="num">Rest</th><th>' + (ctx.eng ? 'Set status' : '') + '</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    if (ctx.eng) body += '<div class="row" style="margin-top:8px"><input id="cs-reason" placeholder="Reason recorded with the next status change (flag post, sick...)" style="flex:1">' + (d.session.running ? '<select id="drv-set">' + q.map(function (id) { return '<option value="' + id + '"' + (id === s.drivers.activeId ? ' selected' : '') + '>' + esc(name(ctx, id)) + '</option>'; }).join('') + '</select><button class="btn sm" data-act="driverset">Correct driver in car</button>' : '') + '</div>';
    var P = d.P;
    body += '<div class="tiny muted" style="margin-top:6px">Drivers listed in rotation order; the planner skips unavailable/offline drivers' + (P.minRestMs ? ' and those under ' + P.minRestMs / HOUR + ' h rest' : '') + '. Rest alert after ' + P.dutyLimitMs / HOUR + ' h on duty. Refuel roles: ' + (P.method ? P.method.roles.map(function (r) { return r.label.replace(' (9 kg foam)', '') + (r.notOutgoing || r.notIncoming ? ' (not ' + [r.notOutgoing ? 'out' : null, r.notIncoming ? 'in' : null].filter(Boolean).join('/') + ' driver)' : ''); }).join(', ') : '-') + '.</div>';
    return { id: 'roster', html: card('Team', body, d.crew.length + ' members'), form: true };
  }

  function panelGantt(ctx) {
    var d = ctx.d, s = ctx.s, rs = d.raceSession;
    var t0 = rs.startTs, t1 = d.plan ? d.plan.raceEndTs : t0 + rs.durationMs, span = t1 - t0;
    var x = function (t) { return Math.max(0, Math.min(100, (t - t0) / span * 100)); };
    var rows = (s.config.members || []).map(function (m) {
      var bl = (s.crew.shifts[m.id] || []).map(function (b) { return '<div class="gblk g-' + (b.kind === 'duty' ? 'duty' : b.kind) + '" style="left:' + x(b.startTs) + '%;width:' + (x(b.endTs) - x(b.startTs)) + '%" title="' + esc(b.kind + ' ' + U.clock(b.startTs) + '-' + U.clock(b.endTs) + (b.note ? ' ' + b.note : '')) + '"></div>'; }).join('');
      if (m.driver) {
        s.drivers.stints.filter(function (st) { return st.driverId === m.id && st.sessionId === rs.id; }).forEach(function (st) { bl += '<div class="gblk g-drive" style="left:' + x(st.startTs) + '%;width:' + (x(st.endTs || d.now) - x(st.startTs)) + '%"></div>'; });
        if (d.plan) d.plan.stints.forEach(function (st) { if (st.driverId === m.id) bl += '<div class="gblk g-drive" style="opacity:.4;left:' + x(st.fromTs) + '%;width:' + (x(st.endTs) - x(st.fromTs)) + '%"></div>'; });
      }
      return '<div class="grow"><div class="small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(m.name) + (ctx.eng ? ' <a href="#" data-act="editshifts" data-id="' + m.id + '" class="tiny info-t">edit</a>' : '') + '</div><div class="gtrack">' + bl + (rs.started ? '<div class="g-now" style="left:' + x(d.now) + '%"></div>' : '') + '</div></div>';
    }).join('');
    var legend = '<div class="row tiny muted" style="margin-top:8px"><span><span class="lc g-duty"></span> duty</span><span><span class="lc g-sleeping"></span> sleeping</span><span><span class="lc g-resting"></span> resting</span><span><span class="lc g-flag"></span> flag duty</span><span><span class="lc g-unavailable"></span> unavailable</span><span><span class="lc g-offline"></span> offline</span><span><span class="lc g-drive"></span> driving (faded = planned)</span><span class="spacer"></span>' + U.clock(t0) + ' - ' + U.dayClock(t1) + '</div>';
    var acts = ctx.eng ? '<div class="row" style="margin-top:8px"><label class="f">Crew shift (h)<input id="gs-len" type="number" step="0.5" min="2" value="' + ((s.config.crewPolicy && s.config.crewPolicy.shiftH) || 6) + '" style="width:80px"></label><button class="btn sm" data-act="draftshifts" style="align-self:flex-end">Draft shifts from the plan</button></div>' : '';
    return { id: 'gantt', html: card('Shifts & sleep', rows + legend + acts) };
  }

  /* ================================================================== CAR */
  V.car = function (ctx) { return { layout: 'grid2', cols: [[panelTyres(ctx), panelIssues(ctx), panelPenalties(ctx)], [panelMap(ctx), panelAgile(ctx), panelSentinelDetail(ctx)]] }; };

  // Agile live timing: running lap, prediction, delta and the micro-sector breakdown for this lap and the last one
  function panelAgile(ctx) {
    var d = ctx.d, pl = ctx.live.agile || {}, lv = pl.live || {}, sx = pl.sectors, on = pl.status === 'connected';
    var sgn = function (ms) { return ms == null ? '-' : (ms > 0 ? '+' : '') + (ms / 1000).toFixed(2); };
    var dcls = function (ms) { return ms == null ? '' : ms > 0 ? ' crit-t' : ' ok-t'; };
    var h = '<div class="strip agile-strip">' +
      '<div><span class="lbl">Lap</span><span class="v">' + (lv.lap != null ? lv.lap : '-') + '</span></div>' +
      '<div><span class="lbl">Running</span><span class="v">' + U.lap(lv.el) + '</span></div>' +
      '<div><span class="lbl">Predicted</span><span class="v">' + U.lap(lv.est) + '</span></div>' +
      '<div data-tip="kpi:Delta"><span class="lbl">Delta</span><span class="v' + (lv.v ? dcls(lv.d) : '') + '">' + (lv.v ? sgn(lv.d) : '-') + '</span></div>' +
      '<div><span class="lbl">Last</span><span class="v">' + U.lap(d.lastLap && d.lastLap.ms) + '</span></div>' +
      '<div><span class="lbl">Best</span><span class="v">' + U.lap(d.bestLapMs) + '</span></div>' +
      '<div data-tip="kpi:Ref pace"><span class="lbl">Ref pace</span><span class="v">' + U.lap(d.refLap.ms) + '</span></div>' +
      '<div><span class="lbl">Speed</span><span class="v">' + (lv.spd != null ? Math.round(lv.spd) : '-') + ' <small>km/h</small></span></div></div>';
    if (sx && sx.n) {
      var COL = ['#2c2f34', '#00C846', '#E03030', '#8B5CF6'], cells = '', sum = 0, n = 0, last = sx.last || [], lsum = 0;
      for (var i = 0; i < sx.n; i++) {
        var c = sx.cells[i] || { c: 0 };
        if (c.done) { sum += c.d; n++; }
        cells += '<div class="msc' + (i === sx.cur ? ' cur' : '') + '" title="' + esc('Micro-sector ' + (i + 1) + (last[i] != null ? ', last lap ' + sgn(last[i]) + ' s' : '')) + '"><span class="bar" style="background:' + COL[c.c || 0] + '"></span><span class="n">' + (i + 1) + '</span><span class="dv' + (c.done ? dcls(c.d) : ' muted') + '">' + (c.done ? sgn(c.d) : i === sx.cur ? 'now' : '') + '</span></div>';
      }
      last.forEach(function (x) { if (x != null) lsum += x; });
      h += '<div class="sep"></div><div class="row tiny muted" style="margin-bottom:4px"><span>Micro-sectors vs reference</span><span class="spacer"></span><span>' + (sx.cur != null ? 'sector ' + (sx.cur + 1) + ' of ' + sx.n : sx.n + ' sectors') +
        (n ? ' | this lap <span class="' + dcls(sum).trim() + '">' + sgn(sum) + ' s</span>' : '') + (last.length ? ' | last lap ' + sgn(lsum) + ' s' : '') + '</span></div><div class="mscs">' + cells + '</div>' +
        '<div class="tiny muted" style="margin-top:4px"><span class="ok-t">green</span> faster, <span class="crit-t">red</span> slower, <span style="color:#8B5CF6">purple</span> best, grey not yet run. Hover a sector for its last-lap delta.</div>';
    } else h += '<div class="tiny muted" style="margin-top:6px">Micro-sectors appear once Agile has its recon lap.</div>';
    var age = lv.ts ? Date.now() - lv.ts : null;
    var hint = on ? (age != null && age > 3000 ? 'data ' + Math.round(age / 1000) + ' s old' : 'live, 10 Hz') : 'Agile ' + (pl.status || 'disabled');
    return { id: 'agile', html: card('Live timing (Agile)', h, hint) };
  }

  function issueRow(ctx, i) {
    var done = i.status === 'fixed' || i.status === 'closed';
    var acts = ctx.eng && !done ? '<div class="row" style="gap:4px">' + (i.nextStop ? '<button class="btn sm" data-act="issue" data-id="' + i.id + '" data-op="unflag">Unflag</button>' : '<button class="btn sm" data-act="issue" data-id="' + i.id + '" data-op="flag">Next stop</button>') +
      '<button class="btn sm go" data-act="issue" data-id="' + i.id + '" data-op="fixed">Fixed</button><button class="btn sm" data-act="issue" data-id="' + i.id + '" data-op="closed">Close</button></div>' : '';
    return '<div class="issue ' + (done ? 'done' : i.sev) + '"><div style="flex:1"><div>' + esc(i.text) + '</div><div class="row tiny muted" style="gap:6px;margin-top:2px"><span class="tag">' + esc(i.cat) + '</span>' + (i.corner ? '<span class="tag">' + esc(i.corner) + '</span>' : '') + (i.nextStop && !done ? '<span class="tag next">next stop</span>' : '') +
      '<span>' + esc(i.src) + ' ' + U.clock(i.ts) + '</span>' + (done ? '<span class="ok-t">' + esc(i.status) + ' ' + U.clock(i.closedTs) + '</span>' : '') + '</div></div>' + acts + '</div>';
  }

  function panelIssues(ctx) {
    var s = ctx.s;
    var open = s.issues.filter(function (i) { return i.status === 'open' || i.status === 'next-stop'; }).slice().reverse();
    var done = s.issues.filter(function (i) { return i.status === 'fixed' || i.status === 'closed'; }).slice().reverse();
    var form = ctx.eng ? '<div class="row" style="margin-bottom:10px"><input id="ci-text" placeholder="Describe the issue" style="flex:2;min-width:160px"><select id="ci-cat">' + ['brakes', 'tyres', 'engine', 'gearbox', 'suspension', 'body', 'impact', 'electrical', 'fuel', 'cooling', 'driver', 'other'].map(function (c) { return '<option>' + c + '</option>'; }).join('') + '</select><select id="ci-sev"><option value="warn">Warning</option><option value="crit">Critical</option><option value="info">Info</option></select><label class="chk"><input id="ci-next" type="checkbox" checked> Next stop</label><button class="btn sm" data-act="addissue" data-p="ci">Log</button></div>' : '';
    var body = form + (open.map(function (i) { return issueRow(ctx, i); }).join('') || '<div class="muted small">No open issues</div>');
    if (done.length) body += '<details style="margin-top:6px"><summary>' + done.length + ' resolved</summary>' + done.map(function (i) { return issueRow(ctx, i); }).join('') + '</details>';
    return { id: 'issues', html: card('Car status log', body, 'manual, Sentinel and IMU'), form: true };
  }

  function panelTyres(ctx) {
    var d = ctx.d, P = d.P;
    var rows = d.tyres.map(function (t) {
      var lifeCls = t.lifePct < 25 ? 'crit' : t.lifePct < 50 ? 'warn' : '';
      return '<tr' + (t.mounted ? ' class="current"' : '') + '><td><b>' + esc(t.name) + '</b>' + (t.mounted ? ' <span class="tag">on car</span>' : '') + '<div class="tiny muted">' + esc(t.status) + '</div></td><td class="num">' + U.mins(t.onMs) + '</td><td class="num">' + t.laps + '</td>' +
        '<td class="num small">' + (t.last ? t.last.depths.map(function (x) { return x == null ? '-' : (+x).toFixed(1); }).join(' / ') : P.newDepth + ' new') + '</td>' +
        '<td style="min-width:110px"><div class="track" style="margin:0"><div class="fill ' + lifeCls + '" style="width:' + t.lifePct + '%"></div></div><div class="tiny muted">' + t.lifePct + '%' + (t.hoursLeft != null ? ', ~' + t.hoursLeft.toFixed(1) + ' h left' : '') + '</div></td>' +
        (ctx.eng ? '<td class="row" style="gap:4px">' + (t.mounted ? '' : '<button class="btn sm" data-act="tyremount" data-id="' + t.id + '">Fit</button>') + '<button class="btn sm" data-act="tyremeasure" data-id="' + t.id + '">Measure</button>' + (t.status !== 'scrapped' ? '<button class="btn sm" data-act="tyrescrap" data-id="' + t.id + '">Scrap</button>' : '') + '</td>' : '') + '</tr>';
    }).join('');
    return { id: 'tyres', html: card('Tyre sets', '<div class="scroll"><table><thead><tr><th>Set</th><th class="num">On car</th><th class="num">Laps</th><th class="num">Tread FL/FR/RL/RR</th><th>Life</th>' + (ctx.eng ? '<th></th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div><div class="tiny muted" style="margin-top:6px">Life = (min tread - ' + P.minDepth + ') / (' + P.newDepth + ' - ' + P.minDepth + ' mm). Regs min treadwear ' + ((ctx.s.config.rules.tyres || {}).minTreadwear || '-') + '.</div>') };
  }

  function panelSentinelDetail(ctx) {
    var b = ctx.live.sentinel || {}, lv = b.live, h;
    if (!lv) h = '<div class="muted small">Sentinel ' + esc(b.status || 'disabled') + (b.host ? ' at ' + esc(b.host) : '') + '</div>';
    else {
      var t = lv.thresh || {};
      h = '<table><thead><tr><th></th><th class="num">Brake C</th><th class="num">Tyre C</th><th class="num">TPMS psi</th><th class="num">TPMS C</th></tr></thead><tbody>' + ['fl', 'fr', 'rl', 'rr'].map(function (c) {
        return '<tr><td><b>' + c.toUpperCase() + '</b></td><td class="num ' + U.band(lv.brake[c], t.br) + '">' + (lv.brake[c] == null ? '---' : Math.round(lv.brake[c])) + '</td><td class="num ' + U.band(lv.tyre[c], t.ty) + '">' + (lv.tyre[c] == null ? '---' : Math.round(lv.tyre[c])) + '</td><td class="num">' + (lv.press[c] == null ? '--' : lv.press[c].toFixed(1)) + '</td><td class="num">' + (lv.tpmsTemp[c] == null ? '--' : lv.tpmsTemp[c]) + '</td></tr>';
      }).join('') + '</tbody></table><div class="tiny muted" style="margin-top:6px">Full Sentinel bands - brake ' + (t.br || []).join('/') + ', tyre ' + (t.ty || []).join('/') + ' C. TPMS ' + (lv.tpmsTrusted ? 'trusted' : 'not trusted') + '.</div>';
    }
    var a = ctx.s.sentinelAlarms.slice(-10).reverse();
    h += '<div class="sep"></div><span class="lbl">Alarms</span>' + (a.length ? '<table><tbody>' + a.map(function (x) { return '<tr><td class="num">' + U.clock(x.ts, true) + '</td><td>' + x.corner.toUpperCase() + ' ' + x.kind + '</td><td class="num">' + Math.round(x.value) + '</td><td class="' + (x.level === 'crit' ? 'crit-t' : 'warn-t') + '">' + x.level + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="small muted">None</div>');
    return { id: 'sentinel', html: card('Brakes, tyres & TPMS (Sentinel)', h, 'red band = warning, flashing band = critical + car issue') };
  }

  function panelPenalties(ctx) {
    var s = ctx.s, r = s.config.rules || {}, counts = {};
    s.penalties.forEach(function (p) { if (p.blackFlag) { var k = p.driverId + ':' + new Date(p.ts).toDateString(); counts[k] = (counts[k] || 0) + 1; } });
    var rows = s.penalties.slice().reverse().map(function (p) { var k = p.driverId + ':' + new Date(p.ts).toDateString(); return '<tr><td class="num">' + U.clock(p.ts) + '</td><td>' + esc(p.kind) + (p.minutes ? ' ' + p.minutes + ' min' : '') + '</td><td>' + esc(name(ctx, p.driverId)) + '</td><td class="small">' + esc(p.reason) + '</td><td>' + (p.blackFlag ? 'BF #' + counts[k] : '') + '</td></tr>'; }).join('');
    var drivers = (s.config.members || []).filter(function (m) { return m.driver; });
    var body = ctx.eng ? '<div class="row"><select id="pn-kind"><option>Drive through</option><option>Stop and go</option><option>Sin bin</option><option>Black flag warning</option><option>Time penalty</option></select><input id="pn-min" type="number" min="0" placeholder="min" style="width:64px"><select id="pn-driver">' + drivers.map(function (m) { return '<option value="' + m.id + '"' + (m.id === s.drivers.activeId ? ' selected' : '') + '>' + esc(m.name) + '</option>'; }).join('') + '</select><input id="pn-reason" placeholder="Reason" style="flex:1;min-width:100px"><label class="chk"><input id="pn-bf" type="checkbox"> Black flag</label><button class="btn sm" data-act="penalty">Log</button></div>' : '';
    body += '<div class="scroll" style="margin-top:8px"><table><tbody>' + (rows || '<tr><td class="muted">No penalties</td></tr>') + '</tbody></table></div>';
    if (r.penalties && r.penalties.blackFlagProgression) body += '<div class="note" style="margin-top:8px">BEERS: black flags escalate per driver per day; the 5th may eject the team.</div>';
    if (r.penalties && r.penalties.contactSinBinMin) body += '<div class="note" style="margin-top:8px">B4B: contact = minimum ' + r.penalties.contactSinBinMin + ' min sin bin.</div>';
    return { id: 'penalties', html: card('Penalties', body), form: true };
  }

  /* ================================================================== PLANS A-F (scenarios) */
  var EV_LABEL = { sc: 'Safety car', red: 'Red flag', repair: 'Repair stop', sinbin: 'Sin bin' };   // what a scenario can assume (yellow is only ever real)
  V.plans = function (ctx) {
    var sc = ctx.scen, col = [panelPlansHead(ctx)];
    if (sc) sc.list.forEach(function (p) {
      col.push(panelPlanRow(ctx, p));
      if (ctx.planEdit === p.id && ctx.eng) col.push(panelPlanEdit(ctx, p));
    });
    return { layout: 'single', cols: [col] };
  };

  function panelPlansHead(ctx) {
    var s = ctx.s, has = s.scenarios && s.scenarios.order.length;
    var h = '<div class="small">Six what-could-happen scenarios side by side. Each bar is the full race: driven stints (dim), the plan from now (driver colours), stops (drag a stop to move it - every later stop re-plans), fuel windows (lilac) and the plan\'s assumed events on top (orange Safety Car, red Red flag, purple repair or sin bin).</div>' +
      '<div class="small" style="margin-top:4px">The past is the same on every bar: real flags (solid, yellow included), real stops and who drove. A red flag parks the car (RED in the driver lane) until the restart. An assumed Safety Car or red flag is used up when a real one comes out; one that did not happen when assumed moves forward to the next likely spot (dashed outline).</div>' +
      '<div class="small" style="margin-top:4px"><b>Run this scenario</b> makes it the live strategy: the call, the next stop, the timeline, the crew summons and the Garage display all follow it. <b>Assumptions</b> lets you drag the Safety Car, red flag or repair along the bar and stretch it from its right edge. <b>Undo</b> / <b>Redo</b> step back and forward through your changes to it, <b>Reset</b> returns it to its original. <b>Clone</b> copies a scenario as it is now into a branch underneath it (A1, A2 ...) so you can try a change and compare it against the main line.</div>';
    if (!has) h += ctx.eng ? '<div class="row" style="margin-top:10px"><button class="btn primary" data-act="plansinit">Create scenarios A-F from now</button><span class="small muted">Event times are fixed when created; Reset brings a scenario back to that original.</span></div>' : '<div class="small muted" style="margin-top:8px">The engineer has not created the scenarios yet.</div>';
    return { id: 'planshead', html: card('Scenarios', h, has ? 'running: Scenario ' + (s.scenarios.active || 'A') : '') };
  }

  V.planRow = function (ctx, p) { return panelPlanRow(ctx, p); };
  function panelPlanRow(ctx, p) {
    var d = p.d, pl = d.plan, s = ctx.s, rs = d.raceSession, run = p.active;
    var t0 = rs.startTs, t1 = pl.raceEndTs, span = Math.max(1, t1 - t0);
    var x = function (t) { return Math.max(0, Math.min(100, (t - t0) / span * 100)); };
    var h = '<div class="row" style="margin-bottom:6px"><span class="pletter' + (run ? ' run' : '') + '">' + p.id + '</span><div style="flex:1;min-width:200px"><b>' + esc(p.name) + '</b>' + (p.dirty ? ' <span class="tag next">edited</span>' : '') +
      (ctx.eng ? ' <button class="btn xs" data-act="planclone" data-id="' + p.id + '" title="Copy this scenario as it is now into a branch underneath it, to try a change and compare">Clone</button>' +
        (p.branch ? ' <button class="btn xs" data-act="planremove" data-id="' + p.id + '"' + (run ? ' disabled title="The running scenario cannot be removed"' : ' title="Remove this branch"') + '>Remove</button>' : '') : '') + '<div class="tiny muted">' + esc(p.desc) + '</div></div>' +
      '<div class="chips-sum" style="margin:0">' + [['Stops', pl.stops.length], ['Fuel', pl.fuelStops], ['Stationary', U.mins(pl.stationaryMs)], ['Finish fuel', U.L(pl.finishFuelL) + ' L']].map(function (c) { return '<div class="sumchip"><span class="lbl">' + c[0] + '</span><span class="v">' + c[1] + '</span></div>'; }).join('') + '</div>' +
      (ctx.eng ? '<div class="row" style="gap:4px">' + (run ? '<span class="tag strat" style="font-size:.8em;padding:4px 8px">RUNNING</span>' : '<button class="btn primary sm" data-act="planrun" data-id="' + p.id + '">Run this scenario</button>') +
        '<button class="btn sm" data-act="planundo" data-id="' + p.id + '" title="Undo the last change to this scenario"' + (p.canUndo ? '' : ' disabled') + '>&#8630; Undo</button>' +
        '<button class="btn sm" data-act="planredo" data-id="' + p.id + '" title="Redo the change you undid"' + (p.canRedo ? '' : ' disabled') + '>Redo &#8631;</button>' +
        '<button class="btn sm" data-act="planedit" data-id="' + p.id + '">' + (ctx.planEdit === p.id ? 'Close' : 'Assumptions') + '</button><button class="btn sm" data-act="planreset" data-id="' + p.id + '"' + (p.dirty ? '' : ' disabled') + '>Reset</button></div>' : (run ? '<span class="tag strat">RUNNING</span>' : '')) + '</div>';
    var editing = ctx.eng && ctx.planEdit === p.id;
    // estimated lap number above the bar, at the same positions as the clock ticks below it
    var raceLaps = s.laps.filter(function (l) { return l.sessionId === rs.id; });
    var lapAtTs = function (t) { if (t <= d.now) { var n = 0; raceLaps.forEach(function (l) { if (l.ts <= t) n = l.n; }); return n; } return d.lapAt(t); };
    var span0 = span / HOUR, step0 = span0 > 24 ? 3 : span0 > 12 ? 2 : 1, laps = '<div class="pb-laps">';
    for (var lh = 0; lh <= span0; lh += step0) laps += '<span style="left:' + x(t0 + lh * HOUR) + '%">L' + lapAtTs(t0 + lh * HOUR) + '</span>';
    laps += '</div>';
    var b = laps + '<div class="pbar' + (editing ? ' editing' : '') + '" data-plan="' + p.id + '" data-t0="' + t0 + '" data-t1="' + t1 + '" data-now="' + d.now + '">';
    if (rs.started) b += '<div class="pb-past" style="width:' + x(d.now) + '%"></div>';
    // what really happened (the same on every scenario), then this scenario's assumptions still to come
    (pl.events || []).forEach(function (e) {
      if (e.consumed || e.dropped) return;
      if (e.actual) {
        b += '<div class="pb-ev act ' + e.kind + (e.live ? ' live' : '') + '" style="left:' + x(e.from) + '%;width:' + Math.max(0.4, x(e.to) - x(e.from)) + '%" title="' + esc(e.label + ' ' + U.clock(e.from) + '-' + (e.live ? 'now' : U.clock(e.to)) + ' (happened)') + '"></div>';
        if (e.live && e.projTo > e.to) b += '<div class="pb-ev proj ' + e.kind + '" style="left:' + x(e.to) + '%;width:' + Math.max(0.4, x(e.projTo) - x(e.to)) + '%" title="' + esc(e.label + ' still out - assumed to end ~' + U.clock(e.projTo)) + '"></div>';
        // red flag: the car is parked, nobody drives - show it in the driver lane too
        if (e.kind === 'red') { var re = e.live ? Math.max(e.projTo || e.to, e.to) : e.to; b += '<div class="pb-hold" style="left:' + x(e.from) + '%;width:' + Math.max(0.4, x(re) - x(e.from)) + '%" title="' + esc('Red flag - race neutralised, car parked in the pits ' + U.clock(e.from) + '-' + (e.live ? '~' : '') + U.clock(re)) + '">' + (x(re) - x(e.from) > 3 ? 'RED' : '') + '</div>'; }
        return;
      }
      var ed = editing && e.i != null;
      b += '<div class="pb-ev ' + e.kind + (ed ? ' edit' : '') + (e.slid ? ' slid' : '') + '" data-plan="' + p.id + '"' + (e.i != null ? ' data-i="' + e.i + '" data-from="' + e.from + '" data-to="' + e.to + '"' : '') + ' style="left:' + x(e.from) + '%;width:' + Math.max(0.5, x(e.to) - x(e.from)) + '%" title="' + esc((EV_LABEL[e.kind] || e.kind) + ' ' + U.clock(e.from) + '-' + U.clock(e.to) + (e.slid ? ' (assumed at ' + U.clock(e.origFrom) + ', did not happen - moved to the next likely spot)' : ' (assumption)') + (ed ? ' - drag to move, drag the right edge to change the length' : '')) + '">' + (ed ? '<span class="pb-ev-h"></span>' : '') + '</div>';
    });
    if (rs.started) s.drivers.stints.filter(function (st) { return st.sessionId === rs.id; }).forEach(function (st) { var e = st.endTs || d.now; b += '<div class="pb-st done" style="left:' + x(st.startTs) + '%;width:' + (x(e) - x(st.startTs)) + '%;background:' + U.driverColour(s, st.driverId) + '"></div>'; });
    // stops really made (fuel, driver change, red-flag park): the same on every scenario
    if (rs.started) d.stops.list.forEach(function (st) { b += '<div class="pb-stop done' + (st.added ? ' fuel' : '') + (st.type === 'red' ? ' red' : '') + '" style="left:' + x(st.inTs) + '%" title="' + esc(st.id + ' ' + (st.type === 'red' ? 'red flag (parked)' : stopType(st.type)) + ' ' + U.clock(st.inTs) + (st.added ? ', ' + st.added + ' L' : '') + (st.driverIn && st.driverIn !== st.driverOut ? ', ' + name(ctx, st.driverOut) + ' to ' + name(ctx, st.driverIn) : '') + ' (done)') + '"></div>'; });
    pl.stints.forEach(function (st) { var w = x(st.endTs) - x(st.fromTs); if (w <= 0) return; b += '<div class="pb-st" style="left:' + x(st.fromTs) + '%;width:' + w + '%;border-color:' + U.driverColour(s, st.driverId) + ';color:' + U.driverColour(s, st.driverId) + '">' + (w > 3.5 ? esc(U.short(name(ctx, st.driverId))) : '') + '</div>'; });
    pl.stops.forEach(function (st) {
      var drag = ctx.eng && !st.event && st.ts > d.now + 60000;
      if (st.window) b += '<div class="pb-win' + (drag ? ' drag' : '') + '" data-plan="' + p.id + '" data-k="' + st.k + '" style="left:' + x(st.window.openTs) + '%;width:' + Math.max(0.6, x(st.window.closeTs) - x(st.window.openTs)) + '%" title="' + esc('Fuel window stop ' + st.k + ': ' + U.clock(st.window.openTs) + '-' + U.clock(st.window.closeTs) + (drag ? ' - drag to move this fuel stop, drop on another stop to move the fuel there' : '')) + '"></div>';
      b += '<div class="pb-stop' + (st.add ? ' fuel' : '') + (st.pinned ? ' pinned' : '') + (st.undersc ? ' undersc' : '') + (st.event ? ' ev' : '') + (drag ? ' drag' : '') + '" data-plan="' + p.id + '" data-k="' + st.k + '" style="left:' + x(st.ts) + '%" title="' + esc('Stop ' + st.k + ' ' + stopType(st.type) + (st.undersc ? ' (taken under the Safety Car)' : '') + ' ' + U.clock(st.ts) + (st.add ? ', ' + st.add + ' L' : '') + (st.change ? ', ' + name(ctx, st.driverOut) + ' to ' + name(ctx, st.driverIn) : '') + (drag ? ' - drag to move, click for options' : '')) + '"></div>';
    });
    if (rs.started) b += '<div class="pb-now" style="left:' + x(d.now) + '%"></div>';
    b += '<div class="pb-ghost" hidden></div></div>';
    var hours = span / HOUR, step = hours > 24 ? 3 : hours > 12 ? 2 : 1, ticks = '<div class="pb-ticks">';
    for (var hh = 0; hh <= hours; hh += step) ticks += '<span style="left:' + x(t0 + hh * HOUR) + '%">' + U.clock(t0 + hh * HOUR) + '</span>';
    ticks += '</div>';
    var warn = pl.warnings.length ? '<div class="note warn" style="margin-top:6px">' + pl.warnings.slice(0, 3).map(esc).join('<br>') + '</div>' : '';
    var nx = pl.stops.filter(function (st) { return st.ts > d.now; })[0];
    var next = nx ? '<div class="tiny muted" style="margin-top:4px">Next: stop ' + nx.k + ' ' + stopType(nx.type) + ' ' + U.clock(nx.ts) + (nx.add ? ', ' + nx.add + ' L' : '') + (nx.change ? ', ' + esc(name(ctx, nx.driverIn)) + ' in' : '') + (p.pins ? ' | ' + p.pins + ' stop' + (p.pins > 1 ? 's' : '') + ' pinned by dragging' : '') + '</div>' : '';
    return { id: 'plan-' + p.id, html: '<div class="card' + (run ? ' plan-running' : '') + (p.branch ? ' plan-branch' : '') + '">' + (p.branch ? '<div class="tiny muted plan-branch-of">branched from Scenario ' + esc(p.branch) + '</div>' : '') + h + b + ticks + next + warn + '</div>' };
  }

  function panelPlanEdit(ctx, p) {
    var def = p.def, s = ctx.s;
    var rows = (def.events || []).map(function (e, i) {
      return '<tr data-ev="' + i + '"><td><select class="ev-kind">' + Object.keys(EV_LABEL).map(function (k) { return '<option value="' + k + '"' + (k === e.kind ? ' selected' : '') + '>' + EV_LABEL[k] + '</option>'; }).join('') + '</select></td>' +
        '<td><input type="datetime-local" class="ev-from" value="' + U.toLocalInput(e.from) + '"></td><td><input type="number" class="ev-dur" min="1" step="1" value="' + Math.round((e.to - e.from) / MIN) + '" style="width:80px"></td><td><button class="btn sm" data-act="plandelev" data-id="' + p.id + '" data-i="' + i + '">Remove</button></td></tr>';
    }).join('');
    var drivers = (s.config.members || []).filter(function (m) { return m.driver; });
    var h = '<table><thead><tr><th>Event</th><th>Starts</th><th>Minutes</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="4" class="muted small">No events - a clean race.</td></tr>') + '</tbody></table>' +
      '<div class="row" style="margin-top:6px"><button class="btn sm" data-act="planaddev" data-id="' + p.id + '">Add event</button></div>' +
      '<div class="fgrid" style="margin-top:10px"><label class="f">Lap time change (s)<input id="pe-lap" type="number" step="0.5" value="' + (def.lapDeltaS || 0) + '"></label></div>' +
      '<div style="margin-top:8px"><span class="lbl">Drivers unavailable in this plan</span><div class="chips" style="margin-top:4px">' + drivers.map(function (m) { return '<label class="chk" style="margin-right:10px"><input type="checkbox" class="pe-x" value="' + m.id + '"' + ((def.excludeDrivers || []).indexOf(m.id) >= 0 ? ' checked' : '') + '> ' + esc(m.name) + '</label>'; }).join('') + '</div></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn primary sm" data-act="plansave" data-id="' + p.id + '">Save assumptions</button>' + ((def.pins || []).length ? '<button class="btn sm" data-act="planunpin" data-id="' + p.id + '">Clear dragged stops (' + def.pins.length + ')</button>' : '') + '<span class="tiny muted">Changes are logged; Reset returns to the original.</span></div>';
    return { id: 'planedit-' + p.id, html: card('Scenario ' + p.id + ' assumptions', h, 'drag events on the bar above'), form: true };
  }

  /* ================================================================== GARAGE DISPLAY (crew screen, big type) */
  function cd(ms) { var s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? h + 'h ' + U.pad(m) + 'm' : m + 'm ' + U.pad(x) + 's'; }
  V.garage = function (ctx) {
    var d = ctx.d, s = ctx.s, P = d.P, ns = d.nextStop, t = pitTarget(d), h = '';
    var left, right = '';
    if (t && t.open) {
      var fuelMs = t.fuelMs, lane = d.now - t.inTs;
      var fuelLeft = fuelMs != null ? P.fuelMinMs - fuelMs : null;
      left = '<div class="g-card ' + (fuelLeft != null && fuelLeft > 0 ? 'alert' : '') + '"><div class="g-label">Car in the pit - stop ' + t.id + '</div>' +
        (fuelMs != null ? '<div class="g-big">' + (fuelLeft > 0 ? cd(fuelLeft) : 'DONE') + '</div><div class="g-mid">' + (fuelLeft > 0 ? 'fuelling minimum to go' : 'fuelling minimum met') + '</div>'
          : '<div class="g-big">' + cd(lane) + '</div><div class="g-mid">in the pit lane' + (P.mandMinMs ? ' (' + Math.round(P.mandMinMs / MIN) + ' min to count)' : '') + '</div>') + '</div>';
    } else if (ns && d.session.running) {
      var to = ns.ts - d.now;
      left = '<div class="g-card ' + (to < 5 * MIN ? 'alert' : '') + '"><div class="g-label">Next stop - ' + stopType(ns.type) + '</div><div class="g-big">' + (to > 0 ? 'in ' + cd(to) : 'NOW') + '</div>' +
        '<div class="g-mid">at ' + U.clock(ns.ts) + ' &middot; lap ~' + d.lapAt(ns.ts) + '</div><div class="g-list" style="margin-top:12px">' + (ns.add ? 'Fuel: <b>' + (ns.brim ? 'BRIM ' : '') + ns.add + ' L</b> (' + ns.cans + ' cans)' : 'No fuel') + '<br>Stationary: <b>' + U.mins(ns.statMs) + '</b></div></div>';
    } else left = '<div class="g-card"><div class="g-label">' + esc(d.session.name) + '</div><div class="g-big">' + esc(d.call.title) + '</div><div class="g-mid">' + esc(d.call.detail) + '</div></div>';
    var stop = (t && t.open) ? plannedFor(d, t) : ns;
    if (stop && stop.add && d.refuelCrew) right += '<div class="g-card"><div class="g-label">Refuel crew</div><div class="g-list">' + d.refuelCrew.assign.map(function (a) { return esc(a.label.replace(' (9 kg foam)', '')) + ': <b class="' + (a.name ? '' : 'crit-t') + '">' + esc(a.name || 'UNASSIGNED') + '</b>' + (a.name ? '' : fixBtn(ctx)); }).join('<br>') + '</div></div>';
    if (stop && stop.change) right += '<div class="g-card" style="margin-top:12px"><div class="g-label">Driver change</div><div class="g-list">Out: <b>' + esc(name(ctx, stop.driverOut)) + '</b><br>In: <b>' + esc(name(ctx, stop.driverIn)) + '</b> - kit on by ' + U.clock(stop.ts - 15 * MIN) + '</div></div>';
    var nx = s.issues.filter(function (i) { return i.nextStop && (i.status === 'open' || i.status === 'next-stop'); });
    if (nx.length) right += '<div class="g-card" style="margin-top:12px"><div class="g-label">Check at this stop</div><div class="g-list" style="font-size:1.25em">' + nx.map(function (i) { return esc(i.text); }).join('<br>') + '</div></div>';
    if (!P.refuelAllowed[s.flag.current] && d.session.running) right += '<div class="g-card crit" style="margin-top:12px"><div class="g-mid">Refuelling CLOSED under ' + esc(s.flag.current) + '</div></div>';
    if (!right) right = '<div class="g-card"><div class="g-label">Crew</div><div class="g-list muted">Nothing to prepare yet.</div></div>';
    h = '<div class="garage"><div>' + left + '<div class="g-card" style="margin-top:12px"><div class="g-label">Driving</div><div class="g-mid">' + esc(d.stint.name || '-') + ' &middot; ' + U.dur(Math.max(0, d.stint.remainingMs), true) + ' stint left</div><div class="g-label" style="margin-top:12px">Fuel on board</div><div class="g-mid">' + U.L(d.fuel.nowL) + ' L &middot; ' + U.L(d.fuel.lapsToReserve, 0) + ' laps to reserve</div></div></div><div>' + right + '</div></div>';
    return { layout: 'single', cols: [[{ id: 'garage', html: h }]] };
  };

  /* ================================================================== LOG */
  V.log = function (ctx) { return { layout: 'grid2', cols: [[panelLog(ctx)], [panelReplay(ctx), panelExport(ctx)]] }; };

  V.summarise = function (ctx, e) {
    var p = e.payload || {};
    switch (e.type) {
      case 'lap': return 'Lap ' + p.n + ' ' + U.lap(p.ms) + (p.pitted ? ' (pit)' : '');
      case 'carstate': return 'Car ' + p.cs;
      case 'flag.set': return 'Flag ' + p.flag;
      case 'stop.service': return (p.auto ? 'Fuel stop applied from the plan (car left the fuel bay): ' : 'Fuel stop completed: ') + (p.fuelAdded ? p.fuelAdded + ' L' + (p.brimmed ? ' brim' : '') : 'no fuel') + (p.driverIn ? ', driver ' + name(ctx, p.driverIn) : '') + (p.tyreOn ? ', tyres ' + p.tyreOn : '') + (p.penalty ? ', ' + p.penalty : '');
      case 'session.start': return 'Session start ' + p.sessionId + ', ' + p.startFuelL + ' L, ' + name(ctx, p.driverId);
      case 'session.end': return 'Session end ' + p.sessionId;
      case 'alert': return p.text;
      case 'alert.ack': return 'Acknowledged: ' + p.key;
      case 'gate.ack': return 'Stop ' + p.stopId + ' ' + ({ pitin: 'pit in', driver: 'driver change' + (p.driverIn ? ' (' + name(ctx, p.driverIn) + ' in)' : ' (no change)'), fuelon: 'fuelling started', pitout: 'pit out' }[p.gate] || p.gate) + (p.auto ? ' applied from the plan - the geofence showed the car had moved on' : ' confirmed by the engineer');
      case 'stop.void': return 'Stop ' + p.stopId + ' rejected: ' + (p.reason || 'false geofence trigger');
      case 'scenario.activate': return 'Strategy switched to Scenario ' + p.id;
      case 'scenario.set': return 'Scenario ' + p.id + ' edited';
      case 'scenario.reset': return 'Scenario ' + p.id + ' reset to its original';
      case 'scenario.undo': return 'Scenario ' + p.id + ': last change undone';
      case 'scenario.redo': return 'Scenario ' + p.id + ': change redone';
      case 'scenario.clone': return 'Scenario ' + p.src + ' cloned into a branch';
      case 'scenario.remove': return 'Branch Scenario ' + p.id + ' removed';
      case 'scenario.init': return 'Scenarios A-F created';
      case 'issue.add': return 'Issue: ' + p.text + ' (' + p.cat + ')';
      case 'issue.update': return 'Issue ' + p.id + ' ' + (p.status || (p.nextStop ? 'next stop' : 'updated'));
      case 'fuel.check': return 'Gauge reading ' + p.litres + ' L';
      case 'fuel.refuel': return 'Fuel poured outside a stop: ' + p.litres + ' L' + (p.note ? ' (' + p.note + ')' : '');
      case 'stock.add': return 'Fuel bought for the stock: ' + p.litres + ' L' + (p.note ? ' (' + p.note + ')' : '');
      case 'stock.count': return 'Fuel stock recounted: ' + p.litres + ' L at the track' + (p.note ? ' (' + p.note + ')' : '');
      case 'pitmsg.send': return 'Pit board: ' + p.text + (p.kind === 'flag' ? (p.on ? ' ON' : ' OFF') : '') + (p.delivered === false ? ' (not delivered)' : '');
      case 'stint.extend': return 'Stint extended +' + p.laps + ' lap' + (p.laps > 1 ? 's' : '') + (p.stopK ? ' - stop ' + p.stopK : '') + ' moved to ~' + U.clock(p.untilTs);
      case 'pitmsg.ack': return 'Driver acknowledged pit board';
      case 'crew.status': return name(ctx, p.memberId) + ' now ' + (U.STATUS_LABEL[p.status] || p.status) + (p.reason ? ' (' + p.reason + ')' : '');
      case 'driver.queue': return 'Rotation: ' + (p.order || []).map(function (id) { return U.short(name(ctx, id)); }).join(', ');
      case 'driver.set': return 'Driver in car: ' + name(ctx, p.driverId);
      case 'sentinel.alarm': return 'Sentinel ' + p.corner + ' ' + p.kind + ' ' + Math.round(p.value) + ' (' + p.level + ')';
      case 'penalty.add': return 'Penalty ' + p.kind + (p.minutes ? ' ' + p.minutes + ' min' : '') + ' - ' + name(ctx, p.driverId);
      case 'tyre.mount': return 'Tyres fitted ' + p.setId;
      case 'tyre.measure': return 'Tread ' + p.setId + ': ' + (p.depths || []).join('/');
      case 'setup.update': return 'Setup changed: ' + Object.keys(p.patch || {}).join(', ');
      case 'note': return p.text;
      default: return JSON.stringify(p).slice(0, 120);
    }
  };

  function panelLog(ctx) {
    var s = ctx.s, f = ctx.logFilter || {}, ev = ctx.events, rs = s.sessions[(ctx.d.raceSession || {}).id];
    var list = ev.filter(function (e) {
      if (f.type && f.type !== 'all') { if (f.type === 'nolaps' ? e.type === 'lap' : e.type.indexOf(f.type) !== 0) return false; }
      if (f.q) { var t = (e.type + ' ' + V.summarise(ctx, e)).toLowerCase(); if (t.indexOf(f.q.toLowerCase()) < 0) return false; }
      return true;
    });
    var rows = list.slice(-(f.limit || 300)).reverse().map(function (e) {
      return '<tr><td class="num">' + e.seq + '</td><td class="num">' + U.clock(e.ts, true) + '</td><td class="num">' + (rs && e.ts >= rs.startTs ? U.dur(e.ts - rs.startTs) : '') + '</td><td class="small">' + esc(e.type) + '</td><td>' + esc(V.summarise(ctx, e)) + '</td><td class="small muted">' + esc(e.by || '') + '</td></tr>';
    }).join('');
    var types = ['all', 'nolaps', 'alert', 'lap', 'carstate', 'flag', 'stop', 'fuel', 'issue', 'crew', 'driver', 'pitmsg', 'sentinel', 'penalty', 'tyre', 'setup', 'session', 'note'];
    var head = '<div class="row" style="margin-bottom:8px"><select id="lg-type">' + types.map(function (t) { return '<option' + ((f.type || 'nolaps') === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select><input id="lg-q" placeholder="Search" value="' + esc(f.q || '') + '" style="flex:1"><button class="btn sm" data-act="logfilter">Filter</button><span class="tiny muted">' + list.length + ' events</span></div>';
    return { id: 'log', html: card('Event log', head + '<div class="scroll" style="max-height:72vh;overflow-y:auto"><table><thead><tr><th class="num">#</th><th class="num">Time</th><th class="num">Race</th><th>Type</th><th>Event</th><th>By</th></tr></thead><tbody>' + rows + '</tbody></table></div>', 'append-only'), form: true };
  }

  function panelReplay(ctx) {
    var r = ctx.replay, ev = ctx.allEvents;
    if (!ev.length) return { id: 'replay', html: card('Replay', '<div class="muted small">Nothing logged yet</div>') };
    var t0 = ev[0].ts, t1 = ev[ev.length - 1].ts, body;
    if (!r) body = '<div class="small muted">Re-runs the log through the same engine: every tab shows exactly what the pit wall saw at that moment.</div><div class="row" style="margin-top:8px"><button class="btn primary sm" data-act="replaystart">Start replay</button></div>';
    else body = '<div class="mono" style="font-size:1.3em;font-weight:700">' + U.dayClock(r.t) + ':' + U.pad(new Date(r.t).getSeconds()) + '</div><input id="rp-scrub" type="range" min="' + t0 + '" max="' + t1 + '" step="1000" value="' + r.t + '" style="width:100%;margin:10px 0" data-act-input="scrub">' +
      '<div class="row"><button class="btn sm" data-act="replayplay">' + (r.playing ? 'Pause' : 'Play') + '</button><select id="rp-speed" data-act-change="replayspeed">' + [1, 10, 60, 300, 1200].map(function (x) { return '<option value="' + x + '"' + (r.speed === x ? ' selected' : '') + '>' + x + 'x</option>'; }).join('') + '</select><button class="btn sm" data-act="replayjump" data-dt="-600000">-10 min</button><button class="btn sm" data-act="replayjump" data-dt="600000">+10 min</button><span class="spacer"></span><button class="btn danger sm" data-act="replaystop">Back to live</button></div>';
    return { id: 'replay', html: card('Replay', body), form: !!r };
  }

  function panelExport(ctx) {
    var m = ctx.meta || {};
    var evs = (m.events || []).map(function (e) { return '<tr' + (e.id === m.activeEventId ? ' class="current"' : '') + '><td>' + esc(e.name) + '<div class="tiny muted">' + esc(e.team || '') + ' | ' + esc(e.date || '') + ' | ' + e.events + ' events' + (e.fromPlanTs ? ' | from plan saved ' + esc(U.dayDate(e.fromPlanTs)) : '') + '</div></td><td>' + (ctx.eng && e.id !== m.activeEventId ? '<button class="btn sm" data-act="activate" data-id="' + e.id + '">Open</button>' : (e.id === m.activeEventId ? '<span class="ok-t small">active</span>' : '')) + ' <a class="btn sm" href="/api/export?id=' + encodeURIComponent(e.id) + '">Export</a></td></tr>'; }).join('');
    var body = '<div class="row"><a class="btn primary sm" href="/api/export">Download weekend file</a><a class="btn sm" href="/api/log.csv">Event log CSV</a></div>' +
      (ctx.eng ? '<div class="row" style="margin-top:10px"><label class="f" style="flex:1">Restore a weekend file<input id="imp-file" type="file" accept=".json,application/json"></label><button class="btn sm" data-act="import" style="align-self:flex-end">Import</button></div>' : '') +
      '<div class="scroll" style="margin-top:10px"><table><tbody>' + evs + '</tbody></table></div>' +
      '<div class="section-title" style="margin-top:14px">Saved plans</div>' +
      '<div class="tiny muted" style="margin-bottom:6px">A plan is this weekend as it stood before its first session: team, rotation, shifts, car, tyres and scenarios, without laps or anything logged during the race. Start a copy to run it again from the top; the weekend it came from is kept. Orb also saves one automatically when the first session starts.</div>' +
      (ctx.eng && m.activeEventId ? '<div class="row" style="margin-bottom:8px"><input id="plan-note" placeholder="Note (optional), e.g. agreed with team owner" style="flex:1" maxlength="200"><button class="btn primary sm" data-act="weekendplansave">Save plan</button></div>' : '') +
      U.plansTable(m.plans, ctx.eng);
    return { id: 'export', html: card('Weekend files', body), form: true };
  }

  window.OrbViews = V;
})();
