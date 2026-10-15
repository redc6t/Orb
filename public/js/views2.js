/* Pit Wall Pro2 views.
   Hierarchy (ISA-101 style): Race = overview (L1) | Plan, Team, Car = areas (L2) | detail in-place (L3) | Log = diagnostics (L4).
   Rule: every datum has one home. The status bar carries lap, car state, flag and clocks; nothing below repeats them. */
(function () {
  'use strict';
  var U = window.U, E = window.PWEngine;
  var V = {}, esc = U.esc, MIN = 60000, HOUR = 3600000;

  function name(ctx, id) { return id ? E.memberName(ctx.s, id) : '-'; }
  function dis(ctx) { return ctx.eng ? '' : ' disabled'; }
  function card(title, body, hint, cls) { return '<div class="card ' + (cls || '') + '"><h3><span>' + title + '</span>' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</h3>' + body + '</div>'; }
  function pct(v, max) { return Math.max(0, Math.min(100, v / max * 100)); }
  function stopType(t) { return { fuel: 'Fuel stop', driver: 'Driver change', mandatory: 'Mandatory stop', service: 'Service stop', penalty: 'Penalty', stop: 'Stop' }[t] || t; }
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
    colB.push(panelMap(ctx));
    var colC = [];
    if (ctx.eng) colC.push(panelControl(ctx));
    colC.push(panelFeed(ctx));
    var colA = [panelNow(ctx), panelTelemetry(ctx)];
    return { layout: 'race', cols: [colA, colB, colC] };
  };

  // NOW: the call, fuel, active driver, on deck, garage
  function panelNow(ctx) {
    var d = ctx.d, s = ctx.s, c = d.call, f = d.fuel, m = f.model, st = d.stint, P = d.P;
    var h = '<div class="call ' + c.level + '"><div class="title">' + esc(c.title) + '</div><div class="detail">' + esc(c.detail) + '</div>' +
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
    var manual = ctx.eng && d.session.running && !(ctx.devices.pltd && ctx.devices.pltd.status === 'connected') ? manualStates(ctx) : '';
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
    var pltdOn = ctx.devices.pltd && ctx.devices.pltd.status === 'connected';
    return '<div class="sep"></div><span class="lbl">Manual car state ' + (pltdOn ? '(override if a geofence is missed)' : '(PLTD offline)') + '</span><div class="seg" style="margin-top:4px">' + [['PIT ENTRY', 'Pit in'], ['FUELLING', 'Fuel on'], ['PITS', 'Fuel off'], ['PIT EXIT', 'Pit out'], ['RUNNING', 'Running']].map(function (b) {
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

  /* ---- stop gates: the engineer moves the stop forward; the geofences override only a step the car has already passed */
  var STEP_NAME = { pitin: 'Pit in', driver: 'Driver change', fuel: 'Fuel stop', pitout: 'Pit out' };
  function stopDue(d) { return d.session.running && d.nextStop && ['box', 'boxin', 'notify', 'opp'].indexOf(d.call.code) >= 0; }
  function panelGate(ctx) {
    var d = ctx.d, g = d.gates, s = ctx.s, P = d.P, pltdOn = ctx.devices.pltd && ctx.devices.pltd.status === 'connected';
    if (!g) {     // a stop is due but the car is not in yet: the engineer can open it by hand
      var ns = d.nextStop;
      var h0 = '<div class="small">Stop ' + ns.k + ' ' + stopType(ns.type) + ' due ' + U.clock(ns.ts) + (ns.add ? ', ' + (ns.brim ? 'brim ' : '') + ns.add + ' L' : '') + (ns.change ? ', ' + esc(name(ctx, ns.driverOut)) + ' out / ' + esc(name(ctx, ns.driverIn)) + ' in' : '') + '.</div>' +
        '<div class="tiny muted" style="margin-top:4px">The PLTD pit-entry geofence opens the stop by itself' + (pltdOn ? '' : ' (PLTD offline: press Pit in when the car enters the pit lane)') + '.</div>';
      if (ctx.eng) h0 += '<div class="row" style="margin-top:8px"><button class="btn primary" data-act="gatecmd" data-gate="pitin">PIT IN</button></div>';
      return { id: 'gate', html: card('Stop gates', h0, 'engineer controls each step'), form: true };
    }
    var st = g.stop, pl = g.planned || {};
    var strip = '<div class="gstrip">' + g.list.map(function (x) {
      var cls = x.state === 'done' ? (x.by === 'auto' ? 'auto' : 'ok') : (g.current && g.current.id === x.id ? 'now' : '');
      var mark = x.state === 'done' ? (x.by === 'auto' ? 'AUTO' : 'OK') : x.state === 'due' ? 'AUTO...' : '-';
      return '<div class="gstep ' + cls + '" title="' + esc(STEP_NAME[x.id] + (x.by === 'auto' ? ': applied from the plan because the geofence showed the car had moved on' : x.by === 'human' ? ': confirmed by the engineer' : '')) + '"><span class="gs-n">' + STEP_NAME[x.id] + '</span><span class="gs-m">' + mark + '</span></div>';
    }).join('') + '</div>';
    var h = strip, step = function (id) { return g.list.filter(function (x) { return x.id === id; })[0]; };
    var pi = step('pitin'), dr = step('driver'), fu = step('fuel'), po = step('pitout');
    var drivers = (s.config.members || []).filter(function (m) { return m.driver; });
    h += '<div class="gcard">';
    if (pi.state !== 'done') {
      h += '<div class="small">Stop ' + st.id + ' opened by the ' + (st.src === 'manual' ? 'engineer' : 'pit-entry geofence') + ' at ' + U.clock(st.inTs, true) + '. Planned: ' + stopType(pl.type || 'stop') + (pl.add ? ', ' + (pl.brim ? 'brim ' : '') + pl.add + ' L' : '') + (pl.change ? ', ' + esc(name(ctx, pl.driverIn)) + ' in' : '') + '.</div>';
      if (ctx.eng) h += '<div class="row" style="margin-top:8px"><button class="btn primary" data-act="gatecmd" data-gate="pitin">PIT IN</button><button class="btn danger sm" data-act="stopvoid" data-stop="' + st.id + '">Not a stop (false trigger)</button></div>';
    } else {
      // driver step
      var defIn = pl.change ? pl.driverIn : s.drivers.activeId;
      h += '<div class="gline"><span class="gl-n">Driver change</span>';
      if (dr.state === 'done') h += '<span class="' + (dr.by === 'auto' ? 'muted' : 'ok-t') + '">' + (g.driverAck && g.driverAck.driverIn ? esc(name(ctx, g.driverAck.driverIn)) + ' in' : 'no change') + (dr.by === 'auto' ? ' (AUTO)' : ' (OK)') + '</span>';
      else if (ctx.eng) h += '<select id="gt-driver">' + drivers.map(function (m) { return '<option value="' + m.id + '"' + (m.id === defIn ? ' selected' : '') + '>' + esc(m.name) + (m.id === s.drivers.activeId ? ' (stays)' : '') + '</option>'; }).join('') + '</select><button class="btn sm primary" data-act="gatedriver" data-stop="' + st.id + '">DRIVER CHANGE DONE</button>';
      else h += '<span class="muted">' + (pl.change ? esc(name(ctx, pl.driverIn)) + ' planned' : 'no change planned') + '</span>';
      h += '</div>';
      // fuel step summary (the form is the card below)
      h += '<div class="gline"><span class="gl-n">Fuel stop</span>' + (fu.state === 'done' ? '<span class="' + (fu.by === 'auto' ? 'muted' : 'ok-t') + '">' + (st.service && st.service.fuelAdded ? st.service.fuelAdded + ' L' + (st.service.brimmed ? ' brim' : '') : 'no fuel') + (fu.by === 'auto' ? ' (AUTO, from the plan)' : ' (OK)') + '</span>' + (ctx.eng && fu.by === 'auto' && ctx.svcFix !== st.id ? ' <button class="btn sm" data-act="svcfix" data-stop="' + st.id + '">Correct it</button>' : '') : '<span class="muted">' + (st.fuelInTs ? 'fuelling since ' + U.clock(st.fuelInTs, true) : 'not started') + ' - complete it in the card below</span>') + '</div>';
      // pit out
      h += '<div class="gline"><span class="gl-n">Pit out</span>' + (po.state === 'done' ? '<span class="' + (po.by === 'auto' ? 'muted' : 'ok-t') + '">' + (st.outTs ? 'out ' + U.clock(st.outTs, true) : 'confirmed, waiting for the exit geofence') + (po.by === 'auto' ? ' (AUTO)' : ' (OK)') + '</span>' : (ctx.eng ? '<button class="btn sm primary" data-act="gatecmd" data-gate="pitout" data-stop="' + st.id + '">PIT OUT</button>' : '<span class="muted">-</span>')) + '</div>';
      if (g.done) h += '<div class="small ok-t" style="margin-top:6px">Stop ' + st.id + ' complete - the car has left the pit lane.</div>';
      else if (g.allSteps) h += '<div class="small warn-t" style="margin-top:6px">All steps confirmed - waiting for the pit-exit geofence.</div>';
      if (g.stuckInFuel) h += '<div class="note warn" style="margin-top:6px">No fuel was recorded, but the PLTD still shows the car in the fuel bay. The stop closes when the car crosses the pit exit; if it has already left and the geofence missed it, use <b>Override car state</b> in the Pit lane card.</div>';
    }
    h += '</div><div class="tiny muted" style="margin-top:6px">You control each step. If the car moves past a step you have not confirmed (leaves the fuel bay or the pit lane), it is applied from the plan and marked AUTO.</div>';
    return { id: 'gate', html: card('Stop ' + st.id + ' gates', h, 'OK = engineer, AUTO = geofence'), form: true };
  }

  function panelGateFuel(ctx) {
    var d = ctx.d, s = ctx.s, P = d.P, g = d.gates, st = g.stop, pl = g.planned || {}, pltdOn = ctx.devices.pltd && ctx.devices.pltd.status === 'connected';
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
    h += '<div class="row" style="margin-top:10px">' + (!pltdOn && !st.fuelInTs ? '<button class="btn" data-act="gatecmd" data-gate="fuelstart" data-stop="' + st.id + '">FUELLING STARTED</button>' : '') +
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
  V.mapProjection = function (pts) {
    if (!pts.length) return null;
    var la0 = 1e9, la1 = -1e9, lo0 = 1e9, lo1 = -1e9;
    pts.forEach(function (p) { la0 = Math.min(la0, p[0]); la1 = Math.max(la1, p[0]); lo0 = Math.min(lo0, p[1]); lo1 = Math.max(lo1, p[1]); });
    var k = Math.cos((la0 + la1) / 2 * Math.PI / 180);
    var w = Math.max(1e-6, (lo1 - lo0) * k), h = Math.max(1e-6, la1 - la0);
    var W = 400, H = 220, pad = 24, sc = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    var ox = (W - w * sc) / 2, oy = (H - h * sc) / 2;
    return { W: W, H: H, f: function (lat, lon) { return [ox + (lon - lo0) * k * sc, oy + (la1 - lat) * sc]; } };
  };
  function metres(a, b) { var k = Math.cos(a[0] * Math.PI / 180); var dy = (a[0] - b[0]) * 111320, dx = (a[1] - b[1]) * 111320 * k; return Math.sqrt(dx * dx + dy * dy); }
  function panelMap(ctx) {
    var m = ctx.map, hist = ctx.posHist || [], tr = ctx.s.config.track || {};
    if (ctx.replay) return { id: 'map', html: card('Track', '<div class="muted small">Live only - positions are not stored in the race log.</div>') };
    // source of the outline: the PLTD reference lap if it has one, otherwise the track preset (e.g. Collie long circuit)
    var src = m && m.path.length ? 'pltd' : (tr.outline && tr.outline.length ? 'preset' : 'trail');
    var path = src === 'pltd' ? m.path : src === 'preset' ? tr.outline : [];
    var zones = m ? m.zones : [];
    var sf = (m && m.sf) || tr.sf || null;
    var pts = path.slice();
    zones.forEach(function (z) { pts = pts.concat(z.v); });
    if (sf) pts.push(sf);
    if (tr.pit) pts = pts.concat(tr.pit.pits, tr.pit.fuel);
    if (src === 'trail') pts = pts.concat(hist.map(function (p) { return [p.lat, p.lon]; }));
    if (pts.length < 3) return { id: 'map', html: card('Track', '<div class="muted small">Waiting for PLTD position. The outline appears once the PLTD has recorded its reference lap.</div>') };
    var pr = V.mapProjection(pts); window.PWMapProj = pr;
    var poly = function (arr) { return arr.map(function (p) { var q = pr.f(p[0], p[1]); return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' '); };
    var svg = '<svg viewBox="0 0 ' + pr.W + ' ' + pr.H + '" class="minimap" role="img" aria-label="Track map">';
    zones.forEach(function (z) {
      var c = zoneColour(z.colour);
      if (z.v.length >= 3) svg += '<polygon points="' + poly(z.v) + '" fill="' + c + '" fill-opacity="0.15" stroke="' + c + '" stroke-opacity="0.7"><title>' + esc(z.label || '') + '</title></polygon>';
      else if (z.v.length === 2) svg += '<polyline points="' + poly(z.v) + '" stroke="' + c + '" stroke-width="3"><title>' + esc(z.label || '') + '</title></polyline>';
    });
    // pit geometry from the track preset (pit lane, pits area, fuel area, entry/exit lines), drawn when it lines up with the circuit
    var pg = tr.pit;
    if (pg && path.length) {
      var nearPath = function (q) { var b = Infinity; for (var j = 0; j < path.length; j += 2) b = Math.min(b, metres(q, path[j])); return b; };
      if (nearPath(pg.lane[0]) < 60 && nearPath(pg.lane[pg.lane.length - 1]) < 60) {
        if (!zones.length) {
          svg += '<polygon points="' + poly(pg.pits) + '" fill="#4fc3f7" fill-opacity="0.18" stroke="#4fc3f7" stroke-opacity="0.8"><title>Pits</title></polygon>';
          svg += '<polygon points="' + poly(pg.fuel) + '" fill="#CE93D8" fill-opacity="0.22" stroke="#CE93D8" stroke-opacity="0.9"><title>Fuel area</title></polygon>';
          svg += '<polyline points="' + poly(pg.entry) + '" stroke="#FFA500" stroke-width="3"><title>Pit entry</title></polyline><polyline points="' + poly(pg.exit) + '" stroke="#FFD54F" stroke-width="3"><title>Pit exit</title></polyline>';
        }
        svg += '<polyline points="' + poly(pg.lane) + '" fill="none" stroke="#8a6fc0" stroke-width="2" stroke-dasharray="4 3"><title>Pit lane</title></polyline>';
      }
    }
    if (tr.sfLine && path.length) svg += '<polyline points="' + poly(tr.sfLine) + '" stroke="#fff" stroke-width="2"><title>Start / finish line</title></polyline>';
    if (path.length) { var loop = poly(path.concat([path[0]])); svg += '<polyline points="' + loop + '" fill="none" stroke="#2c2f34" stroke-width="9" stroke-linejoin="round"/><polyline points="' + loop + '" fill="none" stroke="#6a6f78" stroke-width="2" stroke-linejoin="round"/>'; }
    // turn numbers: only where the preset turn sits on the drawn outline (always true for the preset; true for the PLTD path when it matches)
    if (tr.turns && path.length) {
      var cxy = pr.f(pts.reduce(function (a, p) { return a + p[0]; }, 0) / pts.length, pts.reduce(function (a, p) { return a + p[1]; }, 0) / pts.length);
      tr.turns.forEach(function (t) {
        var best = Infinity; for (var i = 0; i < path.length; i += 2) best = Math.min(best, metres([t.lat, t.lon], path[i]));
        if (best > 40) return;
        var q = pr.f(t.lat, t.lon), dx = q[0] - cxy[0], dy = q[1] - cxy[1], dl = Math.sqrt(dx * dx + dy * dy) || 1;
        var lx = q[0] + dx / dl * 13, ly = q[1] + dy / dl * 13;
        svg += '<text x="' + lx.toFixed(1) + '" y="' + (ly + 3).toFixed(1) + '" text-anchor="middle" class="turn">' + esc(t.n) + '</text>';
      });
    }
    if (sf) { var q2 = pr.f(sf[0], sf[1]); svg += '<rect x="' + (q2[0] - 4) + '" y="' + (q2[1] - 4) + '" width="8" height="8" fill="#fff"><title>Start / finish</title></rect>'; }
    svg += '<polyline id="mm-trail" points="" fill="none" stroke="#9aa0aa" stroke-opacity="0.5" stroke-width="3" stroke-linecap="round"/><circle id="mm-car" cx="-20" cy="-20" r="7" fill="#00C846" stroke="#000" stroke-width="2"/></svg>';
    var hint = src === 'pltd' ? 'PLTD reference lap' : src === 'preset' ? esc(tr.name || 'track') + ' layout' : 'live trail';
    var foot = src === 'preset' ? '<div class="tiny muted">' + esc(tr.layout || '') + '. Replaced by the PLTD reference lap once recorded.</div>' : '';
    return { id: 'map', html: card('Track', svg + '<div class="tiny muted" id="mm-info" style="margin-top:4px">-</div>' + foot, hint) };
  }

  function panelTelemetry(ctx) {
    var d = ctx.d, pl = ctx.live.pltd || {}, lv = pl.live || {}, b = ctx.live.bttm || {}, bl = b.live;
    var h = '<div class="strip">' +
      '<div><span class="lbl">Last</span><span class="v">' + U.lap(d.lastLap && d.lastLap.ms) + '</span></div>' +
      '<div><span class="lbl">Best</span><span class="v">' + U.lap(d.bestLapMs) + '</span></div>' +
      '<div data-tip="kpi:Ref pace"><span class="lbl">Ref pace</span><span class="v">' + U.lap(d.refLap.ms) + '</span></div>' +
      '<div data-tip="kpi:Delta"><span class="lbl">Delta</span><span class="v' + (lv.v && lv.d > 500 ? ' warn-t' : '') + '">' + (lv.v ? (lv.d > 0 ? '+' : '') + (lv.d / 1000).toFixed(2) : '-') + '</span></div>' +
      '<div><span class="lbl">Speed</span><span class="v">' + (lv.spd != null ? Math.round(lv.spd) : '-') + '</span></div></div>';
    // micro-sectors from the PLTD (count set by its recon lap): green faster, red slower, purple best, grey not yet run
    var sx = pl.sectors;
    if (sx && sx.n) {
      var cells = '';
      for (var i = 0; i < sx.n; i++) {
        var c = sx.cells[i] || { c: 0 }, col = ['#2c2f34', '#00C846', '#E03030', '#8B5CF6'][c.c] || '#2c2f34';
        cells += '<span class="msec' + (i === sx.cur ? ' cur' : '') + '" style="background:' + col + '" title="' + esc('Micro-sector ' + (i + 1) + (c.done ? ': ' + (c.d > 0 ? '+' : '') + (c.d / 1000).toFixed(2) + ' s' : '')) + '"></span>';
      }
      var sum = 0, n = 0; sx.cells.forEach(function (c) { if (c.done) { sum += c.d; n++; } });
      h += '<div class="sep"></div><div class="row tiny muted" style="margin-bottom:4px"><span>Micro-sectors</span><span class="spacer"></span><span>' + (sx.cur != null ? 'sector ' + (sx.cur + 1) + ' of ' + sx.n : sx.n + ' sectors') + (n ? ' | this lap ' + (sum > 0 ? '+' : '') + (sum / 1000).toFixed(2) + ' s' : '') + '</span></div><div class="msecs">' + cells + '</div>';
    } else h += '<div class="tiny muted" style="margin-top:6px">Micro-sectors appear once the PLTD has its recon lap.</div>';
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
      h += '<div class="tiny muted" style="margin-top:4px">Brake / tyre C. Grey = in range, amber = red band, flashing red = over the top band.' + (age > 3000 ? ' <span class="warn-t">BTTM data ' + Math.round(age / 1000) + ' s old</span>' : '') + '</div>';
    } else h += '<div class="tiny muted" style="margin-top:8px">BTTM ' + esc(b.status || 'disabled') + '</div>';
    return { id: 'telemetry', html: card('Car feed summary', h, 'PLTD timing, BTTM corners') };
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
    if ({ 'flag.set': 1, 'stop.service': 1, 'gate.ack': 1, 'stop.void': 1, 'driver.set': 1, 'driver.queue': 1, 'scenario.activate': 1, 'scenario.set': 1, 'scenario.reset': 1, 'session.start': 1, 'session.end': 1, 'fuel.check': 1, 'carstate': 1, 'lap': 1, 'setup.update': 1 }[e.type]) return 'strat';
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
    h += '<span class="lbl">Race story</span><div class="feed" style="margin-top:4px">' + ev.map(function (e) {
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
    var stintRow = function (cls, n, drv, from, to, laps, fuel, note) {
      return '<tr class="' + cls + '"><td class="num">' + n + '</td><td><span class="cdot" style="background:' + U.driverColour(s, drv) + '"></span> ' + esc(name(ctx, drv)) + (note ? ' <span class="tag">' + note + '</span>' : '') + '</td>' +
        '<td class="num">' + U.clock(from) + '</td><td class="num">' + U.clock(to) + '</td><td class="num">' + U.dur(from - base, true) + '</td><td class="num">' + U.mins(to - from) + '</td><td class="num">' + laps + '</td><td class="num">' + fuel + '</td></tr>';
    };
    var n = 0;
    if (rs.started) {
      var actual = s.drivers.stints.filter(function (x) { return x.sessionId === rs.id && x.endTs; });
      var stops = d.stops.list.filter(function (x) { return !x.open; });
      var items = actual.map(function (x) { return { t: x.startTs, k: 'stint', x: x }; }).concat(stops.map(function (x) { return { t: x.inTs, k: 'stop', x: x }; })).sort(function (a, b) { return a.t - b.t; });
      items.forEach(function (it) {
        if (it.k === 'stint') { n++; rows += stintRow('past', n, it.x.driverId, it.x.startTs, it.x.endTs, lapsIn(it.x.startTs, it.x.endTs), '-', 'done'); }
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
    var legend = '<div class="row tiny muted" style="margin-top:8px"><span><span class="lc" style="background:rgba(140,146,156,.6)"></span> duty</span><span><span class="lc" style="background:#6D5BD0"></span> sleeping</span><span><span class="lc" style="background:#A78BFA"></span> resting</span><span><span class="lc" style="background:#FD6220"></span> flag duty</span><span><span class="lc" style="background:#2a2c30"></span> offline</span><span><span class="lc" style="background:#00BCD4"></span> driving (faded = planned)</span><span class="spacer"></span>' + U.clock(t0) + ' - ' + U.dayClock(t1) + '</div>';
    var acts = ctx.eng ? '<div class="row" style="margin-top:8px"><label class="f">Crew shift (h)<input id="gs-len" type="number" step="0.5" min="2" value="' + ((s.config.crewPolicy && s.config.crewPolicy.shiftH) || 6) + '" style="width:80px"></label><button class="btn sm" data-act="draftshifts" style="align-self:flex-end">Draft shifts from the plan</button></div>' : '';
    return { id: 'gantt', html: card('Shifts & sleep', rows + legend + acts) };
  }

  /* ================================================================== CAR */
  V.car = function (ctx) { return { layout: 'grid2', cols: [[panelIssues(ctx), panelPenalties(ctx)], [panelTyres(ctx), panelBttmDetail(ctx)]] }; };

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
    return { id: 'issues', html: card('Car status log', body, 'manual, BTTM and IMU'), form: true };
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

  function panelBttmDetail(ctx) {
    var b = ctx.live.bttm || {}, lv = b.live, h;
    if (!lv) h = '<div class="muted small">BTTM ' + esc(b.status || 'disabled') + (b.host ? ' at ' + esc(b.host) : '') + '</div>';
    else {
      var t = lv.thresh || {};
      h = '<table><thead><tr><th></th><th class="num">Brake C</th><th class="num">Tyre C</th><th class="num">TPMS psi</th><th class="num">TPMS C</th></tr></thead><tbody>' + ['fl', 'fr', 'rl', 'rr'].map(function (c) {
        return '<tr><td><b>' + c.toUpperCase() + '</b></td><td class="num ' + U.band(lv.brake[c], t.br) + '">' + (lv.brake[c] == null ? '---' : Math.round(lv.brake[c])) + '</td><td class="num ' + U.band(lv.tyre[c], t.ty) + '">' + (lv.tyre[c] == null ? '---' : Math.round(lv.tyre[c])) + '</td><td class="num">' + (lv.press[c] == null ? '--' : lv.press[c].toFixed(1)) + '</td><td class="num">' + (lv.tpmsTemp[c] == null ? '--' : lv.tpmsTemp[c]) + '</td></tr>';
      }).join('') + '</tbody></table><div class="tiny muted" style="margin-top:6px">Full BTTM bands - brake ' + (t.br || []).join('/') + ', tyre ' + (t.ty || []).join('/') + ' C. TPMS ' + (lv.tpmsTrusted ? 'trusted' : 'not trusted') + '.</div>';
    }
    var a = ctx.s.bttmAlarms.slice(-10).reverse();
    h += '<div class="sep"></div><span class="lbl">Alarms</span>' + (a.length ? '<table><tbody>' + a.map(function (x) { return '<tr><td class="num">' + U.clock(x.ts, true) + '</td><td>' + x.corner.toUpperCase() + ' ' + x.kind + '</td><td class="num">' + Math.round(x.value) + '</td><td class="' + (x.level === 'crit' ? 'crit-t' : 'warn-t') + '">' + x.level + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="small muted">None</div>');
    return { id: 'bttm', html: card('Brakes, tyres & TPMS (BTTM)', h, 'red band = warning, flashing band = critical + car issue') };
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
  var EV_LABEL = { sc: 'Safety car', red: 'Red flag', repair: 'Repair stop', sinbin: 'Sin bin' };
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
      '<div class="small" style="margin-top:4px"><b>Run this scenario</b> makes it the live strategy: the call, the next stop, the timeline, the crew summons and the Garage display all follow it. <b>Assumptions</b> lets you drag the Safety Car, red flag or repair along the bar and stretch it from its right edge. <b>Reset</b> undoes your changes to that scenario.</div>';
    if (!has) h += ctx.eng ? '<div class="row" style="margin-top:10px"><button class="btn primary" data-act="plansinit">Create scenarios A-F from now</button><span class="small muted">Event times are fixed when created; Reset brings a scenario back to that original.</span></div>' : '<div class="small muted" style="margin-top:8px">The engineer has not created the scenarios yet.</div>';
    return { id: 'planshead', html: card('Scenarios', h, has ? 'running: Scenario ' + (s.scenarios.active || 'A') : '') };
  }

  V.planRow = function (ctx, p) { return panelPlanRow(ctx, p); };
  function panelPlanRow(ctx, p) {
    var d = p.d, pl = d.plan, s = ctx.s, rs = d.raceSession, run = p.active;
    var t0 = rs.startTs, t1 = pl.raceEndTs, span = Math.max(1, t1 - t0);
    var x = function (t) { return Math.max(0, Math.min(100, (t - t0) / span * 100)); };
    var h = '<div class="row" style="margin-bottom:6px"><span class="pletter' + (run ? ' run' : '') + '">' + p.id + '</span><div style="flex:1;min-width:200px"><b>' + esc(p.name) + '</b>' + (p.dirty ? ' <span class="tag next">edited</span>' : '') + '<div class="tiny muted">' + esc(p.desc) + '</div></div>' +
      '<div class="chips-sum" style="margin:0">' + [['Stops', pl.stops.length], ['Fuel', pl.fuelStops], ['Stationary', U.mins(pl.stationaryMs)], ['Finish fuel', U.L(pl.finishFuelL) + ' L']].map(function (c) { return '<div class="sumchip"><span class="lbl">' + c[0] + '</span><span class="v">' + c[1] + '</span></div>'; }).join('') + '</div>' +
      (ctx.eng ? '<div class="row" style="gap:4px">' + (run ? '<span class="tag strat" style="font-size:.8em;padding:4px 8px">RUNNING</span>' : '<button class="btn primary sm" data-act="planrun" data-id="' + p.id + '">Run this scenario</button>') +
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
    (p.def.events || []).forEach(function (e, i) {
      b += '<div class="pb-ev ' + e.kind + (editing ? ' edit' : '') + '" data-plan="' + p.id + '" data-i="' + i + '" style="left:' + x(e.from) + '%;width:' + Math.max(0.5, x(e.to) - x(e.from)) + '%" title="' + esc((EV_LABEL[e.kind] || e.kind) + ' ' + U.clock(e.from) + '-' + U.clock(e.to) + (editing ? ' - drag to move, drag the right edge to change the length' : '')) + '">' + (editing ? '<span class="pb-ev-h"></span>' : '') + '</div>';
    });
    if (rs.started) s.drivers.stints.filter(function (st) { return st.sessionId === rs.id; }).forEach(function (st) { var e = st.endTs || d.now; b += '<div class="pb-st done" style="left:' + x(st.startTs) + '%;width:' + (x(e) - x(st.startTs)) + '%;background:' + U.driverColour(s, st.driverId) + '"></div>'; });
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
    return { id: 'plan-' + p.id, html: '<div class="card' + (run ? ' plan-running' : '') + '">' + h + b + ticks + next + warn + '</div>' };
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
      case 'gate.ack': return 'Stop ' + p.stopId + ' ' + ({ pitin: 'pit in', driver: 'driver change' + (p.driverIn ? ' (' + name(ctx, p.driverIn) + ' in)' : ' (no change)'), pitout: 'pit out' }[p.gate] || p.gate) + (p.auto ? ' applied from the plan - the geofence showed the car had moved on' : ' confirmed by the engineer');
      case 'stop.void': return 'Stop ' + p.stopId + ' rejected: ' + (p.reason || 'false geofence trigger');
      case 'scenario.activate': return 'Strategy switched to Scenario ' + p.id;
      case 'scenario.set': return 'Scenario ' + p.id + ' edited';
      case 'scenario.reset': return 'Scenario ' + p.id + ' reset to its original';
      case 'scenario.init': return 'Scenarios A-F created';
      case 'issue.add': return 'Issue: ' + p.text + ' (' + p.cat + ')';
      case 'issue.update': return 'Issue ' + p.id + ' ' + (p.status || (p.nextStop ? 'next stop' : 'updated'));
      case 'fuel.check': return 'Gauge reading ' + p.litres + ' L';
      case 'pitmsg.send': return 'Pit board: ' + p.text + (p.kind === 'flag' ? (p.on ? ' ON' : ' OFF') : '') + (p.delivered === false ? ' (not delivered)' : '');
      case 'pitmsg.ack': return 'Driver acknowledged pit board';
      case 'crew.status': return name(ctx, p.memberId) + ' now ' + (U.STATUS_LABEL[p.status] || p.status) + (p.reason ? ' (' + p.reason + ')' : '');
      case 'driver.queue': return 'Rotation: ' + (p.order || []).map(function (id) { return U.short(name(ctx, id)); }).join(', ');
      case 'driver.set': return 'Driver in car: ' + name(ctx, p.driverId);
      case 'bttm.alarm': return 'BTTM ' + p.corner + ' ' + p.kind + ' ' + Math.round(p.value) + ' (' + p.level + ')';
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
    var types = ['all', 'nolaps', 'alert', 'lap', 'carstate', 'flag', 'stop', 'fuel', 'issue', 'crew', 'driver', 'pitmsg', 'bttm', 'penalty', 'tyre', 'setup', 'session', 'note'];
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
    var evs = (m.events || []).map(function (e) { return '<tr' + (e.id === m.activeEventId ? ' class="current"' : '') + '><td>' + esc(e.name) + '<div class="tiny muted">' + esc(e.team || '') + ' | ' + esc(e.date || '') + ' | ' + e.events + ' events</div></td><td>' + (ctx.eng && e.id !== m.activeEventId ? '<button class="btn sm" data-act="activate" data-id="' + e.id + '">Open</button>' : (e.id === m.activeEventId ? '<span class="ok-t small">active</span>' : '')) + ' <a class="btn sm" href="/api/export?id=' + encodeURIComponent(e.id) + '">Export</a></td></tr>'; }).join('');
    var body = '<div class="row"><a class="btn primary sm" href="/api/export">Download weekend file</a><a class="btn sm" href="/api/log.csv">Event log CSV</a></div>' +
      (ctx.eng ? '<div class="row" style="margin-top:10px"><label class="f" style="flex:1">Restore a weekend file<input id="imp-file" type="file" accept=".json,application/json"></label><button class="btn sm" data-act="import" style="align-self:flex-end">Import</button></div>' : '') +
      '<div class="scroll" style="margin-top:10px"><table><tbody>' + evs + '</tbody></table></div>';
    return { id: 'export', html: card('Weekend files', body) };
  }

  window.PWViews = V;
})();
