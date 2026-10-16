/* Pit Wall client core */
(function () {
  'use strict';
  var U = window.U, R = window.PWReducer, E = window.PWEngine, V = window.PWViews, SU = window.PWSetup;
  var MIN = 60000;
  var App = window.PWApp = {
    role: 'viewer', meta: null, config0: null, events: [], state: null, live: {}, devices: {}, offset: 0,
    tab: (function () { var t = localStorage.getItem('pw2.tab'); return ['race', 'plan', 'fuel', 'plans', 'team', 'car', 'garage', 'log', 'setup'].indexOf(t) >= 0 ? t : 'race'; })(), whatIf: null, replay: null, logFilter: { type: 'nolaps' }, dirty: {}, formSeq: {}, ws: null, layoutKey: null, debrief: {}
  };
  var viewEl = document.getElementById('view');

  App.now = function () { return Date.now() + App.offset; };
  App.send = function (type, payload) {
    if (App.role !== 'engineer') { U.toast('View-only device: make changes on the pit wall laptop', 'warn', null, false); return; }
    if (App.replay) { U.toast('Leave replay before making changes', 'warn', null, false); return; }
    if (!App.ws || App.ws.readyState !== 1) { U.toast('Not connected', 'crit'); return; }
    App.ws.send(JSON.stringify({ t: 'action', type: type, payload: payload || {} }));
  };
  // the fuel stop selected on the Fuel Plan tab (by time, so it survives re-numbering as stops are completed)
  App.fuelSelTs = function () { var c = App.lastCtx, f = c && c.fp ? V.fuelSelected(c) : null; return f ? f.ts : null; };
  App.goTab = function (t) { App.tab = t; try { localStorage.setItem('pw2.tab', t); } catch (e) { /* private mode */ } App.layoutKey = null; renderAll(true); };

  /* ------------------------------------------------------------ connection */
  function connect() {
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    App.ws = ws;
    ws.onopen = function () { document.getElementById('conn').hidden = true; };
    ws.onclose = function () { document.getElementById('conn').hidden = false; setTimeout(connect, 1500); };
    ws.onmessage = function (m) {
      var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (msg.t === 'init') {
        App.role = msg.role; App.meta = msg.meta; document.getElementById('brandver').textContent = msg.meta && msg.meta.version ? 'v' + msg.meta.version : ''; App.map = msg.map || null; App.config0 = msg.config0; App.events = msg.events || []; App.devices = msg.devices || {};
        App.offset = msg.now - Date.now();
        App.state = App.config0 ? R.reduce(App.config0, App.events) : null;
        if (App.state) U.setClock24(!(App.state.config.ui && App.state.config.ui.clock24 === false || (App.state.config.ui && App.state.config.ui.clock24 === 'false')));
        App.replay = null; App.dirty = {}; App.layoutKey = null;
        if (!App.state) { SU.begin(App, 'new'); App.tab = 'setup'; }
        else if (App.afterCreate) { App.afterCreate = false; App.tab = 'race'; SU.draft = null; }
        else if (App.tab === 'setup') SU.begin(App, 'edit');
        renderAll(true);
      } else if (msg.t === 'evt') {
        App.events.push(msg.e);
        if (App.state) R.apply(App.state, msg.e);
        if (msg.e.type === 'alert' && !App.replay) U.toast(msg.e.payload.text, msg.e.payload.level, msg.e.ts);
        if (msg.e.type === 'setup.update' && App.tab === 'setup' && !App.dirty.setup) SU.begin(App, 'edit');
        if (msg.e.type === 'setup.update' && App.state) U.setClock24(String((App.state.config.ui || {}).clock24) !== 'false');
        App.formSeq.changed = true;
        scheduleRender();
      } else if (msg.t === 'live') { App.live = { pltd: msg.pltd, bttm: msg.bttm }; App.devices.pltd = msg.pltd; updateMapDot(); }
      else if (msg.t === 'map') { App.map = msg.map; }
      else if (msg.t === 'devices') { App.devices = msg.devices; renderHeader(); }
      else if (msg.t === 'tick') { App.offset = msg.now - Date.now(); }
      else if (msg.t === 'reset') { fetch('/api/meta').then(function () { ws.close(); }); }
      else if (msg.t === 'logo') { document.getElementById('logo').src = '/branding/logo?v=' + Date.now(); }
      else if (msg.t === 'error') U.toast(msg.msg, 'warn', null, false);
    };
  }

  /* ------------------------------------------------------------ rendering */
  var pending = false;
  function scheduleRender() { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; renderAll(false); }); }

  function viewState() { return App.replay ? App.replay.state : App.state; }
  function ctx() {
    var s = viewState();
    var now = App.replay ? App.replay.t : App.now();
    var wantTrace = App.tab === 'plan';
    var d = E.derive(s, now, App.whatIf, { trace: wantTrace });
    // "drop a fuel stop": re-run the real planner at reduced burn until a fuel stop disappears (Plan tab only, every 15 s)
    if (App.tab === 'plan' && d.plan && d.plan.fuelStops > 0 && (!App.dropCache || now - App.dropCache.at > 15000 || App.dropCache.seq !== s.seq || App.dropCache.wi !== JSON.stringify(App.whatIf))) {
      var found = null, baseG = (App.whatIf && App.whatIf.greenMult) || 1;
      [0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.92, 0.90, 0.88, 0.85].some(function (m) {
        var d2 = E.derive(s, now, Object.assign({}, App.whatIf || {}, { greenMult: baseG * m }));
        if (d2.plan && d2.plan.fuelStops < d.plan.fuelStops) { found = { pct: (1 - m) * 100, perLapL: d.fuel.model.G * baseG * (1 - m) * d.refLap.ms / 3600000 }; return true; }
        return false;
      });
      App.dropCache = { at: now, seq: s.seq, wi: JSON.stringify(App.whatIf), val: found || { none: true } };
    }
    var base = App.whatIf && App.tab === 'strategy' ? E.derive(s, now, null) : null;
    var fp = App.tab === 'fuel' && d.plan ? E.fuelPlan(s, d) : null;
    return { s: s, d: d, base: base, fp: fp, fuelSel: App.fuelSel, fuelEdit: App.fuelEdit || null, fpPreview: fp && !App.replay ? fuelPreview(s, now, d) : null, eng: App.role === 'engineer' && !App.replay, live: App.replay ? {} : App.live, devices: App.devices, now: now,
      whatIf: App.whatIf, whatIfOn: !!App.whatIf, replay: App.replay, events: App.replay ? App.events.filter(function (e) { return e.ts <= App.replay.t; }) : App.events,
      scen: App.tab === 'plans' ? scenarios(s, now) : null, planEdit: App.planEdit || null, svcFix: App.svcFix || null, debrief: App.debrief,
      drop: App.tab === 'plan' && App.dropCache ? App.dropCache.val : null, allEvents: App.events, logFilter: App.logFilter, meta: App.meta, map: App.map, posHist: App.posHist };
  }

  /* ------------------------------------------------------------ fuel plan: litres per stop, re-planned through the running scenario */
  // pin stops 1..k at their times; stop k gets `litres` (null = back to the planner's litres); litres set earlier stay set
  function litresPins(stops, k, litres) {
    var now = App.now();
    return stops.filter(function (x) { return x.k <= k && !x.event && x.ts > now - 60000; }).map(function (x) {
      var a = x.k === k ? litres : x.litresSet;
      var p = { ts: x.ts, fuel: x.k === k ? (litres == null ? true : litres > 0) : x.add > 0, driverIn: x.change ? x.driverIn : null };
      if (a > 0) p.add = a;
      return p;
    });
  }
  function fuelPreview(s, now, d) {
    var e = App.fuelEdit; if (!e || !d.plan) return null;
    var st = d.plan.stops.filter(function (x) { return Math.abs(x.ts - e.ts) < 60000; })[0];
    if (!st) return null;
    var key = s.seq + ':' + e.ts + ':' + e.litres + ':' + Math.floor(now / 5000);
    if (!App.fpCache || App.fpCache.key !== key) {
      var dd = E.derive(s, now, { pins: litresPins(d.plan.stops, st.k, e.litres) });
      App.fpCache = { key: key, val: { litres: e.litres, fromTs: st.ts, plan: dd.plan } };
    }
    return App.fpCache.val;
  }
  // the running strategy is the active scenario; if scenarios were never created, create them first (A = clean race)
  function setRunningPins(pins) {
    var s = App.state, sc = s.scenarios || {};
    if (!sc.order || !sc.order.length) {
      var tpl = E.scenarioTemplates(s, App.now());
      App.send('scenario.init', { plans: tpl });
      var defA = R.clone(tpl.filter(function (p) { return p.id === 'A'; })[0].def); defA.pins = pins;
      App.send('scenario.set', { id: 'A', def: defA });
      return 'A';
    }
    var id = sc.active && sc.plans[sc.active] ? sc.active : sc.order[0];
    var def = R.clone(sc.plans[id].cur); def.pins = pins;
    App.send('scenario.set', { id: id, def: def });
    return id;
  }
  function fuelStopAt(ts) { var d = E.derive(App.state, App.now(), App.whatIf); return d.plan ? { d: d, st: d.plan.stops.filter(function (x) { return Math.abs(x.ts - ts) < 60000; })[0] } : null; }

  function scenarios(s, now) {
    if (!s.scenarios || !s.scenarios.order.length) return null;
    var key = s.seq + ':' + Math.floor(now / 3000);
    if (!App.scenCache || App.scenCache.key !== key) {
      App.scenCache = { key: key, val: { list: s.scenarios.order.map(function (id) {
        var pl = s.scenarios.plans[id];
        var dd = E.derive(s, now, Object.assign({ noScenario: true }, E.defToWhatIf(pl.cur)));
        return { id: id, name: pl.name, desc: pl.desc, def: pl.cur, d: dd, active: s.scenarios.active === id, dirty: JSON.stringify(pl.cur) !== JSON.stringify(pl.orig), pins: (pl.cur.pins || []).length };
      }) } };
    }
    return App.scenCache.val;
  }

  function renderHeader(c) {
    var s = c ? c.s : viewState();
    var role = document.getElementById('hdr-role');
    role.textContent = App.role === 'engineer' ? 'ENGINEER' : 'VIEW ONLY';
    role.className = 'role-badge role-' + App.role;
    var dv = App.devices || {};
    var st = function (x) { return !x || x.status === 'disabled' ? 'off' : (x.status === 'connected' || x.status === 'listening') ? 'ok' : (x.status === 'stale' || x.status === 'connecting') ? 'warn' : 'bad'; };
    document.getElementById('hdr-devices').innerHTML = [['PLTD', dv.pltd], ['BTTM', dv.bttm], ['UDP', dv.udp]].map(function (x) {
      return '<span class="dev" title="' + U.esc(x[0] + ': ' + ((x[1] && x[1].status) || 'disabled') + (x[1] && x[1].host ? ' ' + x[1].host : '')) + '"><span class="dot ' + st(x[1]) + '"></span>' + x[0] + '</span>';
    }).join('');
    if (!s) { document.getElementById('hdr-team').textContent = window.PWBrand.product; document.getElementById('hdr-car').textContent = ''; return; }
    var cfg = s.config;
    document.getElementById('hdr-team').textContent = (cfg.team.carNumber ? '#' + cfg.team.carNumber + ' ' : '') + (cfg.team.name || 'Team');
    document.getElementById('hdr-car').textContent = [cfg.car.year, cfg.car.make, cfg.car.model].filter(Boolean).join(' ') + ' | ' + (cfg.track.name || '');
    if (!c) return;
    var d = c.d, ss = d.session;
    document.getElementById('hdr-session').textContent = ss.name + (ss.running ? ' - remaining' : ss.finished ? ' - finished' : ' - starts in') + ' | ' + (cfg.rules.organiser || '').split(' (')[0].split(' - ')[0];
    var dur = ss.isRace && d.plan ? d.plan.raceEndTs - ss.startTs : ss.durationMs;
    document.getElementById('hdr-elapsed').textContent = U.dur(ss.started ? ss.elapsedMs : 0);
    document.getElementById('hdr-remaining').textContent = ss.started ? U.dur(Math.max(0, dur - ss.elapsedMs - ss.pausedMs)) : (ss.plannedStart ? U.dur(Math.max(0, ss.plannedStart - c.now)) : U.dur(dur));
    document.getElementById('hdr-local').textContent = U.clock(c.now, true);
    document.getElementById('hdr-lap').textContent = ss.running ? (d.lastLap ? d.lastLap.n + 1 : 1) : '-';
    var ap = (s.scenarios && s.scenarios.active) || 'A', hp = document.getElementById('hdr-plan');
    hp.textContent = 'SCENARIO ' + ap; hp.className = 'plan-pill' + (ap !== 'A' ? ' alt' : '');
    var csEl = document.getElementById('hdr-cs'); csEl.textContent = s.carState.current; csEl.className = V.csClass(s.carState.current);
    var f = document.getElementById('hdr-flag');
    f.textContent = s.flag.current; f.className = 'flag-pill flag-' + s.flag.current.split(' ')[0];
    var top = document.getElementById('top');
    top.className = d.call.level === 'crit' ? 'alert-crit' : (d.call.level === 'warn' ? 'alert-warn' : '');
  }

  function renderTimeline(c) {
    var el = document.getElementById('timeline');
    if (!c || !c.d.plan) { el.innerHTML = ''; return; }
    var d = c.d, s = c.s, rs = d.raceSession, pl = d.plan;
    var t0 = rs.startTs, t1 = pl.raceEndTs;
    var x = function (t) { return Math.max(0, Math.min(100, (t - t0) / (t1 - t0) * 100)); };
    var h = '';
    if (rs.started) s.drivers.stints.filter(function (st) { return st.sessionId === rs.id; }).forEach(function (st) {
      var end = st.endTs || c.now, w = x(end) - x(st.startTs);
      h += '<div class="tl-seg' + (st.endTs ? '' : ' now') + '" style="left:' + x(st.startTs) + '%;width:' + w + '%;background:' + U.driverColour(s, st.driverId) + '">' + (w > 3 ? U.esc(U.short(E.memberName(s, st.driverId))) : '') + '</div>';
    });
    pl.stints.forEach(function (st) {
      var w = x(st.endTs) - x(st.fromTs);
      if (w <= 0) return;
      h += '<div class="tl-seg plan" style="left:' + x(st.fromTs) + '%;width:' + w + '%;color:' + U.driverColour(s, st.driverId) + '">' + (w > 3 ? U.esc(U.short(E.memberName(s, st.driverId))) : '') + '</div>';
    });
    (pl.events || []).forEach(function (e) { h += '<div class="tl-ev ' + e.kind + '" style="left:' + x(e.from) + '%;width:' + Math.max(0.3, x(e.to) - x(e.from)) + '%" title="' + U.esc(e.kind + ' (plan assumption) ' + U.clock(e.from) + '-' + U.clock(e.to)) + '"></div>'; });
    d.stops.list.forEach(function (st) { h += '<div class="tl-stop' + (st.added ? ' fuel' : '') + '" style="left:' + x(st.inTs) + '%" title="' + U.esc(st.id + ' ' + U.clock(st.inTs)) + '"></div>'; });
    pl.stops.forEach(function (st) {
      h += '<div class="tl-stop plan' + (st.add ? ' fuel' : '') + '" style="left:' + x(st.ts) + '%" title="' + U.esc('Planned ' + st.type + ' ' + U.clock(st.ts)) + '"></div>';
      if (st.window) h += '<div class="tl-win" title="' + U.esc('Fuel window for stop ' + st.k + ': ' + U.clock(st.window.openTs) + '-' + U.clock(st.window.closeTs) + ' (laps ' + c.d.lapAt(st.window.openTs) + '-' + c.d.lapAt(st.window.closeTs) + ')') + '" style="left:' + x(st.window.openTs) + '%;width:' + Math.max(0.4, x(st.window.closeTs) - x(st.window.openTs)) + '%"></div>';
    });
    var hours = (t1 - t0) / 3600000, step = hours > 24 ? 3 : hours > 12 ? 2 : 1;
    for (var hh = 0; hh <= hours; hh += step) { var xx = x(t0 + hh * 3600000); h += '<div class="tl-tickline" style="left:' + xx + '%"></div><div class="tl-tick" style="left:' + xx + '%">' + hh + 'h ' + U.clock(t0 + hh * 3600000) + '</div>'; }
    if (rs.started) h += '<div class="tl-now" style="left:' + x(c.now) + '%"></div>';
    h += '<div class="tl-finish" title="Chequered ' + U.dayClock(t1) + '"></div>';
    el.innerHTML = h;
    var lg = document.getElementById('tl-legend');
    if (lg && !lg.innerHTML) lg.innerHTML = '<span><i style="background:#9aa0aa"></i>driven (driver colour)</span><span><i style="border:1px dashed #9aa0aa"></i>planned stint</span><span><i style="background:#CE93D8;width:3px"></i>fuel stop</span><span><i style="background:#b9bcc2;width:3px"></i>other stop</span><span><i style="background:rgba(206,147,216,.5);height:5px"></i>fuel window: earliest to latest time for that stop</span><span><i style="background:#fff;width:2px"></i>now</span>';
  }

  function isEditing(panelEl) {
    var a = document.activeElement;
    return a && panelEl.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName);
  }

  function renderAll(force) {
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === App.tab); });
    var rb = document.getElementById('replay-banner');
    if (App.replay) { rb.hidden = false; rb.innerHTML = 'REPLAY ' + U.dayClock(App.replay.t) + ':' + U.pad(new Date(App.replay.t).getSeconds()) + ' (' + App.replay.speed + 'x)<span class="spacer"></span><button class="btn sm" data-act="replaystop">Back to live</button>'; }
    else rb.hidden = true;
    if (!App.state) { renderHeader(null); document.getElementById('timeline-wrap').hidden = true; }
    if (App.tab === 'setup') {
      document.getElementById('timeline-wrap').hidden = true;
      if (force || App.layoutKey !== 'setup') { App.layoutKey = 'setup'; if (!SU.draft) SU.begin(App, App.state ? 'edit' : 'new'); SU.render(viewEl); }
      if (App.state) { var c0 = ctx(); renderHeader(c0); }
      return;
    }
    if (!App.state) { App.tab = 'setup'; return renderAll(true); }
    if (App.dragging && !force) return;
    document.getElementById('timeline-wrap').hidden = App.tab === 'garage';
    var c = ctx(); App.lastCtx = c;
    renderHeader(c); renderTimeline(c);
    var v = V[App.tab](c), top = v.top || [], movable = !!CARD_TABS[App.tab];
    if (movable) v.cols = arrangeCards(App.tab, v.cols);
    var key = layoutKeyOf(App.tab, top.map(function (p) { return p.id; }), v.cols.map(function (col) { return col.map(function (p) { return p.id; }); }));
    if (force || key !== App.layoutKey) {
      App.layoutKey = key; App.dirty = {};
      viewEl.innerHTML = top.map(function (p) { return '<div class="toppanel" data-panel="' + p.id + '"></div>'; }).join('') +
        '<div class="' + v.layout + '">' + v.cols.map(function (col) { return '<div class="col">' + col.map(function (p) { return '<div data-panel="' + p.id + '"></div>'; }).join('') + '</div>'; }).join('') + '</div>' +
        (movable ? '<div class="cards-foot tiny muted">Drag a card by its <span class="grip-ico">' + GRIP_SVG + '</span> to rearrange this page (saved in this browser). <a href="#" data-act="resetcards">Reset layout</a></div>' : '');
    }
    App.formSeq.changed = false;
    [top].concat(v.cols).forEach(function (col, ci) {
      col.forEach(function (p) {
        var el = viewEl.querySelector('[data-panel="' + p.id + '"]');
        if (!el) return;
        if (el.innerHTML && isEditing(el)) return;
        if (p.form && el.innerHTML && App.dirty[p.id] && Date.now() - App.dirty[p.id] < 60000) return;
        if (el._html !== p.html) { el.innerHTML = p.html; el._html = p.html; if (movable && ci > 0) addGrip(el); if (window.PWTips) PWTips.apply(el); if (p.id === 'map') updateMapDot(); }
      });
    });
    if (App.tab === 'race') fitFeed();
  }

  function fitFeed() {
    var cols = [].slice.call(viewEl.querySelectorAll('.race > .col')); if (cols.length < 3) return;
    var feed = viewEl.querySelector('.race .feed'); if (!feed) return;
    var fc = feed.closest('.col'), others = cols.filter(function (x) { return x !== fc; }).map(function (x) { return x.getBoundingClientRect(); });
    var c = fc.getBoundingClientRect(), a = cols[0].getBoundingClientRect();
    if (cols[2].getBoundingClientRect().top > a.top + 40 || window.innerWidth < 1400) { feed.style.maxHeight = ''; return; }   // stacked layout: leave it
    var cap = window.innerHeight * 0.23;   // matches .feed max-height: only shrink to fit, never grow past it
    var over = c.bottom - Math.max(others[0].bottom, others[1].bottom), h = Math.min(cap, Math.max(160, feed.clientHeight - over));
    if (Math.abs(over) > 2) feed.style.maxHeight = h + 'px';
  }
  window.addEventListener('resize', function () { if (App.tab === 'race') fitFeed(); });

  /* ------------------------------------------------------------ movable cards: drag the grip to rearrange a page (saved per browser) */
  var CARD_TABS = { race: 1, car: 1 };
  var GRIP_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><g fill="currentColor"><circle cx="2" cy="2" r="1.3"/><circle cx="6" cy="2" r="1.3"/><circle cx="10" cy="2" r="1.3"/><circle cx="2" cy="6" r="1.3"/><circle cx="6" cy="6" r="1.3"/><circle cx="10" cy="6" r="1.3"/><circle cx="2" cy="10" r="1.3"/><circle cx="6" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/></g></svg>';
  function layoutKeyOf(tab, topIds, colIds) { return tab + ':' + topIds.join(',') + '/' + colIds.map(function (ids) { return ids.join(','); }).join('|'); }
  function loadCards(tab) { try { var v = JSON.parse(localStorage.getItem('pw2.cards.' + tab)); return Array.isArray(v) ? v : null; } catch (e) { return null; } }
  function saveCards(tab, cols) { try { if (cols) localStorage.setItem('pw2.cards.' + tab, JSON.stringify(cols)); else localStorage.removeItem('pw2.cards.' + tab); } catch (e) { /* private mode */ } }
  // insert item into list right after prev (when prev is there), otherwise at index i
  function placeAfter(list, item, prev, i, idOf) {
    var at = -1; if (prev != null) list.forEach(function (x, j) { if (idOf(x) === prev) at = j + 1; });
    list.splice(at >= 0 ? at : Math.min(i, list.length), 0, item);
  }
  // the saved order wins; a card never placed by the user (e.g. a pit-stop card that just appeared) keeps its default column, next to its default neighbour
  function arrangeCards(tab, cols) {
    var saved = loadCards(tab);
    if (!saved || saved.length !== cols.length) return cols;
    var byId = {}, placed = {};
    cols.forEach(function (col) { col.forEach(function (p) { byId[p.id] = p; }); });
    var out = saved.map(function (ids) { return ids.filter(function (id) { if (byId[id] && !placed[id]) { placed[id] = 1; return true; } return false; }).map(function (id) { return byId[id]; }); });
    cols.forEach(function (col, ci) { col.forEach(function (p, i) { if (!placed[p.id]) placeAfter(out[ci], p, i ? col[i - 1].id : null, i, function (x) { return x.id; }); }); });
    return out;
  }
  // save the order now on screen, keeping where the user put cards that are hidden at the moment
  function storeCards(tab, colIds) {
    var old = loadCards(tab), seen = {};
    colIds.forEach(function (ids) { ids.forEach(function (id) { seen[id] = 1; }); });
    if (old && old.length === colIds.length) old.forEach(function (ids, ci) { ids.forEach(function (id, i) { if (!seen[id]) { seen[id] = 1; placeAfter(colIds[ci], id, i ? ids[i - 1] : null, i, function (x) { return x; }); } }); });
    saveCards(tab, colIds);
  }
  function addGrip(el) {
    var g = '<span class="grip" title="Drag to move this card">' + GRIP_SVG + '</span>', h = el.querySelector('.card > h3');
    if (h) { h.classList.add('has-grip'); h.insertAdjacentHTML('beforeend', g); }
    else { el.classList.add('grip-abs'); el.insertAdjacentHTML('afterbegin', g); }
  }
  function domCols(grid) { return [].slice.call(grid.children).filter(function (c) { return c.classList.contains('col'); }); }
  // layout position (ignores the FLIP transforms still running, so the drop target does not jitter)
  function layoutTop(child, col, colRect) { return colRect.top + (child.offsetParent === col.offsetParent ? child.offsetTop - col.offsetTop : child.offsetTop); }
  var cardDrag = null;
  viewEl.addEventListener('pointerdown', function (e) {
    var g = e.target.closest('.grip'); if (!g || e.button !== 0 || !CARD_TABS[App.tab] || cardDrag) return;
    var el = g.closest('[data-panel]'); if (!el || !el.parentNode.classList.contains('col')) return;
    var r = el.getBoundingClientRect(), grid = el.parentNode.parentNode;
    var ghost = el.cloneNode(true);
    ghost.removeAttribute('data-panel'); ghost.querySelectorAll('[id]').forEach(function (x) { x.removeAttribute('id'); });
    ghost.className = 'card-ghost'; ghost.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px';
    document.body.appendChild(ghost);
    el.classList.add('card-ph'); grid.classList.add('cards-dragging'); document.body.classList.add('cards-grabbing');
    cardDrag = { el: el, grid: grid, ghost: ghost, x0: e.clientX, y0: e.clientY, left: r.left, top: r.top, x: e.clientX, y: e.clientY, sy: window.scrollY };
    App.dragging = true; e.preventDefault();
    cardDrag.scroll = setInterval(function () {   // scroll the page while the card is held near the top or bottom edge
      if (!cardDrag) return;
      var y = cardDrag.y, H = window.innerHeight, v = y < 70 ? -(70 - y) / 3 : y > H - 70 ? (y - H + 70) / 3 : 0;
      if (v) { window.scrollBy(0, v); cardMove(); }
    }, 16);
  });
  function cardMove() {
    var d = cardDrag, x = d.x, y = d.y;
    d.ghost.style.transform = 'translate(' + (x - d.x0) + 'px,' + (y - d.y0) + 'px) rotate(1deg)';
    var best = null, bd = Infinity;
    domCols(d.grid).forEach(function (c) {
      var r = c.getBoundingClientRect(), dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom), dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = c; }
    });
    if (!best) return;
    var cr = best.getBoundingClientRect(), ref = null;
    [].slice.call(best.children).some(function (k) {
      if (k === d.el) return false;
      if (layoutTop(k, best, cr) + k.offsetHeight / 2 > y) { ref = k; return true; }
      return false;
    });
    if (d.el.parentNode === best && (d.el.nextSibling === ref || (ref === null && d.el === best.lastElementChild))) return;
    // FLIP: remember where every card was, move the placeholder, then slide each card from its old spot to the new one
    var cards = [].slice.call(d.grid.querySelectorAll('.col > [data-panel]')), before = cards.map(function (k) { return k.getBoundingClientRect(); });
    best.insertBefore(d.el, ref);
    cards.forEach(function (k, i) {
      var a = before[i], b = k.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) return;
      k.style.transition = 'none'; k.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      k.getBoundingClientRect();
      k.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1)'; k.style.transform = '';
    });
  }
  document.addEventListener('pointermove', function (e) { if (!cardDrag) return; cardDrag.x = e.clientX; cardDrag.y = e.clientY; cardMove(); });
  function cardDrop() {
    if (!cardDrag) return;
    var d = cardDrag; cardDrag = null; clearInterval(d.scroll);
    var r = d.el.getBoundingClientRect();
    d.ghost.style.transition = 'transform 180ms ease, box-shadow 180ms ease';
    d.ghost.style.transform = 'translate(' + (r.left - d.left) + 'px,' + (r.top - d.top) + 'px)';
    setTimeout(function () {
      d.ghost.remove(); d.el.classList.remove('card-ph'); d.grid.classList.remove('cards-dragging'); document.body.classList.remove('cards-grabbing');
      var cols = domCols(d.grid).map(function (c) { return [].slice.call(c.children).map(function (k) { return k.getAttribute('data-panel'); }); });
      var top = [].slice.call(viewEl.querySelectorAll('.toppanel')).map(function (k) { return k.getAttribute('data-panel'); });
      storeCards(App.tab, cols.map(function (ids) { return ids.slice(); }));
      App.layoutKey = layoutKeyOf(App.tab, top, cols);   // the DOM already matches: no rebuild
      App.dragging = false; renderAll(false);
    }, 180);
  }
  document.addEventListener('pointerup', cardDrop);
  document.addEventListener('pointercancel', cardDrop);

  setInterval(function () { if (App.replay && App.replay.playing) stepReplay(1000 * App.replay.speed); if (App.tab !== 'setup' || App.state) renderAll(false); }, 1000);

  /* ------------------------------------------------------------ mini map live dot */
  App.posHist = [];
  function updateMapDot() {
    var lp = App.live.pltd || {}, lb = (App.live.bttm || {}).live || {};
    var pos = lp.pos && Date.now() - lp.pos.ts < 3000 ? lp.pos : (lb.lat ? { lat: lb.lat, lon: lb.lon, ts: lb.ts, src: 'BTTM' } : lp.pos);
    if (!pos) return;
    var last = App.posHist[App.posHist.length - 1];
    if (!last || last.ts !== pos.ts) { App.posHist.push(pos); if (App.posHist.length > 600) App.posHist.shift(); }
    var car = document.getElementById('mm-car'), pr = window.PWMapProj;
    if (!car || !pr || App.replay) return;
    var q = pr.f(pos.lat, pos.lon);
    var stale = Date.now() - pos.ts > 3000;
    car.setAttribute('cx', q[0].toFixed(1)); car.setAttribute('cy', q[1].toFixed(1));
    car.setAttribute('fill', stale ? '#555' : (V.CS_COLOUR[App.state && App.state.carState.current] || '#00C846'));
    var tr = App.posHist.slice(-40).filter(function (p) { return Date.now() - p.ts < 25000; }).map(function (p) { var z = pr.f(p.lat, p.lon); return z[0].toFixed(1) + ',' + z[1].toFixed(1); }).join(' ');
    document.getElementById('mm-trail').setAttribute('points', tr);
    var info = document.getElementById('mm-info');
    if (info) info.textContent = (stale ? 'Position ' + Math.round((Date.now() - pos.ts) / 1000) + ' s old' : (pos.src === 'BTTM' ? 'BTTM GNSS' : 'PLTD GNSS')) + (pos.sats != null ? ' | ' + pos.sats + ' sats' : '') + (pos.spd != null ? ' | ' + Math.round(pos.spd) + ' km/h' : '');
  }

  /* ------------------------------------------------------------ replay */
  function replayAt(t) {
    var r = App.replay; r.t = t;
    r.state = R.reduce(App.config0, App.events, t);
  }
  function stepReplay(dt) {
    var r = App.replay, last = App.events[App.events.length - 1].ts;
    var to = Math.min(last, r.t + dt);
    for (var i = 0; i < App.events.length; i++) { var e = App.events[i]; if (e.ts > r.t && e.ts <= to) { R.apply(r.state, e); if (e.type === 'alert') U.toast(e.payload.text, e.payload.level, e.ts, false); } }
    r.t = to;
    if (to >= last) r.playing = false;
  }

  /* ------------------------------------------------------------ actions */
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function numv(id) { var v = val(id); return v === '' ? null : +v; }
  function checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }

  var A = {
    resetcards: function () { saveCards(App.tab, null); App.layoutKey = null; renderAll(true); },
    savemodel: function () {
      var s = App.state, d = E.derive(s, App.now()), tid = s.config.track.id || 'default';
      var fp = R.clone(s.config.car.fuelProfiles || {});
      fp[tid] = { greenLph: +d.fuel.model.G.toFixed(2), scLph: +d.fuel.model.S.toFixed(2), note: 'learned ' + new Date().toISOString().slice(0, 10) + ' from ' + d.fuel.model.nCal + ' stints' };
      if (!confirm('Save ' + fp[tid].greenLph + ' L/h green / ' + fp[tid].scLph + ' L/h SC as the ' + (s.config.track.name || tid) + ' baseline for ' + s.config.car.make + ' ' + s.config.car.model + '? The live model keeps learning either way.')) return;
      App.send('setup.update', { patch: { car: { fuelProfiles: fp } }, saveCar: true });
    },
    fuelcheck: function () { var l = numv('fc-l'); if (l == null) return U.toast('Enter litres', 'warn', null, false); App.send('fuel.check', { litres: l, weight: 0.5 }); U.closeModal(); },
    gauge: function () {
      U.modal('<h3 class="section-title">Gauge reading</h3><p class="small muted">Litres you read on the gauge or dipstick right now. It re-anchors the fuel estimate and calibrates the burn model (half the weight of a brim fill).</p>' +
        '<div class="row" style="margin-top:10px"><label class="f" style="flex:1">Litres in the tank<input id="fc-l" type="number" step="0.5" min="0"></label></div><div class="row" style="margin-top:12px"><button class="btn primary" data-act="fuelcheck">Log reading</button><button class="btn" data-act="modalclose">Cancel</button></div>');
      setTimeout(function () { var i = document.getElementById('fc-l'); if (i) i.focus(); }, 50);
    },
    makeondeck: function (b) {
      var id = b.getAttribute('data-id'), q = (App.state.drivers.queue || []).filter(function (x) { return x !== id; }), act = App.state.drivers.activeId;
      q.splice(q.indexOf(act) + 1, 0, id);
      App.send('driver.queue', { order: q });
    },
    ack: function (b) { App.send('alert.ack', { key: b.getAttribute('data-key') }); },
    gotab: function (b) { App.goTab(b.getAttribute('data-tab')); },
    crewfix: function () { App.goTab('team'); setTimeout(function () { var p = document.querySelector('[data-panel=crewfix]'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 120); },
    crewwake: function (b) { App.send('crew.status', { memberId: b.getAttribute('data-id'), status: 'available', reason: 'called in for the refuel crew' }); },
    crewassign: function (b) {
      var id = b.getAttribute('data-id'), role = b.getAttribute('data-role'), members = R.clone(App.state.config.members || []);
      members.forEach(function (m) { if (m.id === id && (m.roles || []).indexOf(role) < 0) m.roles = (m.roles || []).concat([role]); });
      App.send('setup.update', { patch: { members: members } });
    },
    gateack: function (b) {
      var g = E.derive(App.state, App.now()).gates;
      App.send('gate.ack', { stopId: b.getAttribute('data-stop'), gate: b.getAttribute('data-gate'), plan: b.getAttribute('data-gate') === 'entry' && g ? g.planned : undefined });
    },
    stopvoid: function (b) { if (confirm('Reject stop ' + b.getAttribute('data-stop') + ' as a false geofence trigger? It will be removed from the strategy.')) App.send('stop.void', { stopId: b.getAttribute('data-stop'), reason: 'false geofence trigger' }); },
    gatecmd: function (b) { App.send('gate.cmd', { gate: b.getAttribute('data-gate'), stopId: b.getAttribute('data-stop') }); },
    gatedriver: function (b) {
      var din = val('gt-driver'); if (din === App.state.drivers.activeId) din = null;
      App.send('gate.cmd', { gate: 'driver', stopId: b.getAttribute('data-stop'), driverIn: din }); App.dirty.gate = false;
    },
    gatefuel: function (b) {
      var P = E.params(App.state), noFuel = b.getAttribute('data-nofuel') === '1';
      var fuel = numv('ps-fuel'), cans = numv('ps-cans');
      if (fuel == null && cans) fuel = cans * (P.method ? P.method.canL : 20);
      if (noFuel) fuel = 0;
      var fixes = []; document.querySelectorAll('.ps-fix:checked').forEach(function (i) { fixes.push(i.value); });
      var tyreOn = val('ps-tyre') || null, depths = ['FL', 'FR', 'RL', 'RR'].map(function (c) { return numv('ps-d-' + c); });
      if (fuel > P.maxPerStop) U.toast(fuel + ' L exceeds the ' + P.maxPerStop + ' L per-stop limit', 'crit');
      App.send('gate.cmd', { gate: 'fuel', stopId: b.getAttribute('data-stop'), service: { fuelAdded: fuel || 0, cans: noFuel ? 0 : cans, brimmed: !noFuel && checked('ps-brim'), capacityL: P.capacity,
        fuelBeforeL: numv('ps-before'), tyreOn: tyreOn, tyreOffDepths: tyreOn && depths.some(function (x) { return x != null; }) ? depths : null, issuesFixed: fixes, penalty: val('ps-pen') || null } });
      App.dirty.gatefuel = false; App.svcFix = null;
    },
    fpsel: function (b) { App.fuelSel = +b.getAttribute('data-ts'); App.fuelEdit = null; App.dirty.fpstop = 0; renderAll(false); },
    fpstep: function (b) {
      var i = document.getElementById('fp-l'); if (!i) return;
      var v = Math.max(0, Math.min(+i.max || 999, (+i.value || 0) + +b.getAttribute('data-d')));
      App.fuelEdit = { ts: App.fuelSelTs(), litres: v }; App.dirty.fpstop = 0; renderAll(false);
    },
    fpbrim: function (b) { App.fuelEdit = { ts: App.fuelSelTs(), litres: +b.getAttribute('data-l') }; App.dirty.fpstop = 0; renderAll(false); },
    fpcancel: function () { App.fuelEdit = null; App.dirty.fpstop = 0; renderAll(false); },
    fpapply: function (b) {
      var ts = +b.getAttribute('data-ts'), x = fuelStopAt(ts); if (!x || !x.st) return U.toast('That stop is no longer in the plan', 'warn', null, false);
      var l = App.fuelEdit && App.fuelEdit.ts === ts ? App.fuelEdit.litres : numv('fp-l');
      if (l == null || isNaN(l)) return U.toast('Enter the litres first', 'warn', null, false);
      var id = setRunningPins(litresPins(x.d.plan.stops, x.st.k, l));
      U.toast('Scenario ' + id + ': fuel stop at ' + U.clock(ts) + ' set to ' + l + ' L - later stops re-planned', 'info', null, false);
      App.fuelEdit = null; App.dirty.fpstop = 0;
    },
    fpauto: function (b) {
      var ts = +b.getAttribute('data-ts'), x = fuelStopAt(ts); if (!x || !x.st) return;
      setRunningPins(litresPins(x.d.plan.stops, x.st.k, null)); App.fuelEdit = null; App.dirty.fpstop = 0;
    },
    debrief: function (b) { var k = b.getAttribute('data-k'); App.debrief[k] = !App.debrief[k]; renderAll(false); },
    svcfix: function (b) { App.svcFix = b.getAttribute('data-stop'); App.layoutKey = null; renderAll(true); },
    plansinit: function () { App.send('scenario.init', { plans: E.scenarioTemplates(App.state, App.now()) }); },
    planrun: function (b) { App.send('scenario.activate', { id: b.getAttribute('data-id') }); },
    planedit: function (b) { var id = b.getAttribute('data-id'); App.planEdit = App.planEdit === id ? null : id; App.layoutKey = null; renderAll(true); },
    planreset: function (b) { var id = b.getAttribute('data-id'); if (confirm('Reset Scenario ' + id + ' to its original assumptions and remove every dragged stop and event change?')) App.send('scenario.reset', { id: id }); },
    plansave: function (b) {
      var id = b.getAttribute('data-id'), def = R.clone(App.state.scenarios.plans[id].cur);
      def.events = []; document.querySelectorAll('[data-panel="planedit-' + id + '"] tr[data-ev]').forEach(function (row, i) {
        var from = U.fromLocalInput(row.querySelector('.ev-from').value), dur = +row.querySelector('.ev-dur').value || 10, kind = row.querySelector('.ev-kind').value;
        if (from) def.events.push({ id: id + (i + 1), kind: kind, from: from, to: from + dur * MIN, label: { sc: 'Safety car', red: 'Red flag', repair: 'Repair', sinbin: 'Sin bin' }[kind] });
      });
      def.lapDeltaS = numv('pe-lap') || 0;
      def.excludeDrivers = []; document.querySelectorAll('.pe-x:checked').forEach(function (c) { def.excludeDrivers.push(c.value); });
      App.send('scenario.set', { id: id, def: def }); App.dirty['planedit-' + id] = false;
    },
    planaddev: function (b) {
      var id = b.getAttribute('data-id'), def = R.clone(App.state.scenarios.plans[id].cur), t = Math.round((App.now() + 60 * MIN) / MIN) * MIN;
      def.events = (def.events || []).concat([{ id: id + Date.now(), kind: 'sc', from: t, to: t + 15 * MIN, label: 'Safety car' }]);
      App.send('scenario.set', { id: id, def: def });
    },
    plandelev: function (b) { var id = b.getAttribute('data-id'), def = R.clone(App.state.scenarios.plans[id].cur); def.events.splice(+b.getAttribute('data-i'), 1); App.send('scenario.set', { id: id, def: def }); },
    planunpin: function (b) { var id = b.getAttribute('data-id'), def = R.clone(App.state.scenarios.plans[id].cur); def.pins = []; App.send('scenario.set', { id: id, def: def }); },
    planstopfuel: function (b) { pinStops(b.getAttribute('data-id'), +b.getAttribute('data-k'), null, b.getAttribute('data-fuel') === '1'); U.closeModal(); },
    planstopunpin: function (b) {
      var id = b.getAttribute('data-id'), ts = +b.getAttribute('data-ts'), def = R.clone(App.state.scenarios.plans[id].cur);
      def.pins = (def.pins || []).filter(function (p) { return p.ts < ts - 1000; }); App.send('scenario.set', { id: id, def: def }); U.closeModal();
    },
    carstate: function (b) { App.send('carstate', { cs: b.getAttribute('data-cs') }); },
    service: function (b) {
      var s = App.state, P = E.params(s);
      var fuel = numv('ps-fuel'), cans = numv('ps-cans');
      if (fuel == null && cans) fuel = cans * (P.method ? P.method.canL : 20);
      var fixes = []; document.querySelectorAll('.ps-fix:checked').forEach(function (i) { fixes.push(i.value); });
      var tyreOn = val('ps-tyre') || null;
      var depths = ['FL', 'FR', 'RL', 'RR'].map(function (c) { return numv('ps-d-' + c); });
      var p = { stopId: b.getAttribute('data-stop'), fuelAdded: fuel || 0, cans: cans, brimmed: checked('ps-brim'), capacityL: P.capacity, fuelBeforeL: numv('ps-before'),
        driverIn: val('ps-driver') || null, tyreOn: tyreOn, tyreOffDepths: tyreOn && depths.some(function (x) { return x != null; }) ? depths : null, issuesFixed: fixes, penalty: val('ps-pen') || null };
      if (p.fuelAdded > P.maxPerStop) U.toast(p.fuelAdded + ' L exceeds the ' + P.maxPerStop + ' L per-stop limit', 'crit');
      App.send('stop.service', p); App.dirty.pitstop = false; App.dirty.gateform = false; App.svcFix = null;
    },
    manuallap: function () {
      var s = App.state, laps = s.laps.filter(function (l) { return l.sessionId === s.activeSessionId; });
      var last = laps.length ? laps[laps.length - 1].ts : s.sessions[s.activeSessionId].startTs;
      App.send('lap', { n: (laps.length ? laps[laps.length - 1].n : 0) + 1, ms: App.now() - last, pitted: !!s.stops.some(function (st) { return st.inTs > last; }) });
    },
    setondeck: function () {
      var id = val('ondeck-sel'), q = (App.state.drivers.queue || []).slice(), act = App.state.drivers.activeId;
      q = q.filter(function (x) { return x !== id; });
      var ai = q.indexOf(act);
      q.splice(ai + 1, 0, id);
      App.send('driver.queue', { order: q });
    },
    addissue: function (b) {
      var p = b.getAttribute('data-p'), text = val(p + '-text').trim();
      if (!text) return U.toast('Describe the issue first', 'warn', null, false);
      App.send('issue.add', { text: text, cat: val(p + '-cat') || 'other', sev: val(p + '-sev') || 'warn', nextStop: document.getElementById(p + '-next') ? checked(p + '-next') : true, src: 'manual' });
      document.getElementById(p + '-text').value = ''; App.dirty.nextissues = false; App.dirty.issues = false;
    },
    issue: function (b) {
      var op = b.getAttribute('data-op'), id = b.getAttribute('data-id');
      if (op === 'flag') App.send('issue.update', { id: id, nextStop: true, status: 'next-stop' });
      else if (op === 'unflag') App.send('issue.update', { id: id, nextStop: false, status: 'open' });
      else App.send('issue.update', { id: id, status: op });
    },
    startsession: function () {
      App.send('session.start', { sessionId: val('ss-id'), startFuelL: numv('ss-fuel'), driverId: val('ss-driver'), tyreSetId: val('ss-tyre') });
    },
    endsession: function () { if (confirm('End the session now (chequered flag)?')) App.send('session.end', { sessionId: App.state.activeSessionId }); },
    flag: function (b) { App.send('flag.set', { flag: b.getAttribute('data-flag') }); },
    extendlap: function () {
      var c = E.derive(App.state, App.now()).call, x = c.extend;
      if (c.code !== 'notify' || !x) return;
      if (!x.ok) return U.toast('Cannot extend: ' + x.why, 'warn', null, false);
      App.send('stint.extend', { untilTs: x.untilTs, laps: x.laps, add: x.add, driverIn: x.driverIn, stopK: x.stopK });
    },
    pitmsg: function (b) { App.send('pitmsg.send', { text: b.getAttribute('data-text'), pri: 1 }); },
    pitmsgcustom: function () { var t = val('pm-text').trim(); if (!t) return; App.send('pitmsg.send', { text: t, pri: checked('pm-pri') ? 1 : 0 }); document.getElementById('pm-text').value = ''; },
    whatif: function () {
      var gm = numv('wi-gm');
      App.whatIf = { lapDeltaS: numv('wi-lap') || 0, scMin: numv('wi-sc') || 0, scPct: numv('wi-scpct'), greenMult: gm ? 1 + gm / 100 : null };
      App.dirty.whatif = false; App.formSeq.changed = true; renderAll(false);
    },
    whatifclear: function () { App.whatIf = null; App.dirty.whatif = false; App.formSeq.changed = true; renderAll(true); },
    qmove: function (b) {
      var q = (App.state.drivers.queue || []).slice(), id = b.getAttribute('data-id'), dir = +b.getAttribute('data-dir');
      var i = q.indexOf(id), j = i + dir; if (j < 0 || j >= q.length) return;
      q[i] = q[j]; q[j] = id; App.send('driver.queue', { order: q });
    },
    driverset: function () { App.send('driver.set', { driverId: val('drv-set') }); },
    override: function (b) { App.send('crew.override', { memberId: b.getAttribute('data-id'), untilTs: App.now() + 3600000, reason: 'contingency' }); },
    draftshifts: function () {
      if (!confirm('Replace all shift blocks with a draft built from the current plan?')) return;
      App.send('crew.shiftsAll', { shifts: E.draftShifts(App.state, App.now(), numv('gs-len') || 6) });
    },
    editshifts: function (b) { openShiftEditor(b.getAttribute('data-id')); },
    shiftsave: function (b) {
      var id = b.getAttribute('data-id'), blocks = [];
      document.querySelectorAll('[data-blk]').forEach(function (row) {
        var st = U.fromLocalInput(row.querySelector('.b-s').value), en = U.fromLocalInput(row.querySelector('.b-e').value), k = row.querySelector('.b-k').value, note = row.querySelector('.b-n').value;
        if (st && en && en > st) blocks.push({ startTs: st, endTs: en, kind: k, note: note });
      });
      blocks.sort(function (a, b2) { return a.startTs - b2.startTs; });
      App.send('crew.shifts', { memberId: id, blocks: blocks }); U.closeModal();
    },
    shiftadd: function () {
      var t = document.getElementById('shift-rows'), now = App.now();
      t.insertAdjacentHTML('beforeend', shiftRow({ startTs: now, endTs: now + 6 * 3600000, kind: 'resting', note: '' }));
    },
    shiftdel: function (b) { b.closest('[data-blk]').remove(); },
    modalclose: function () { U.closeModal(); },
    tyremount: function (b) { App.send('tyre.mount', { setId: b.getAttribute('data-id') }); },
    tyrescrap: function (b) { if (confirm('Mark this set as scrapped?')) App.send('tyre.status', { setId: b.getAttribute('data-id'), status: 'scrapped' }); },
    tyremeasure: function (b) {
      var id = b.getAttribute('data-id');
      U.modal('<h3 class="section-title">Tread depth - ' + U.esc(App.state.tyres.sets[id].name) + '</h3><div class="fgrid">' + ['FL', 'FR', 'RL', 'RR'].map(function (c) { return '<label class="f">' + c + ' (mm)<input id="tm-' + c + '" type="number" step="0.1" min="0"></label>'; }).join('') +
        '</div><label class="f" style="margin-top:8px">Note<input id="tm-note"></label><div class="row" style="margin-top:12px"><button class="btn primary" data-act="tyremeasuresave" data-id="' + id + '">Save</button><button class="btn" data-act="modalclose">Cancel</button></div>');
    },
    tyremeasuresave: function (b) {
      App.send('tyre.measure', { setId: b.getAttribute('data-id'), depths: ['FL', 'FR', 'RL', 'RR'].map(function (c) { return numv('tm-' + c); }), note: val('tm-note') });
      U.closeModal();
    },
    penalty: function () {
      App.send('penalty.add', { kind: val('pn-kind'), minutes: numv('pn-min') || 0, driverId: val('pn-driver'), reason: val('pn-reason'), blackFlag: checked('pn-bf') });
      App.dirty.penalties = false;
    },
    logfilter: function () { App.logFilter = { type: val('lg-type'), q: val('lg-q') }; App.dirty.log = false; App.formSeq.changed = true; renderAll(false); },
    replaystart: function () {
      if (!App.events.length) return;
      var rs = App.events.filter(function (e) { return e.type === 'session.start'; }).slice(-1)[0];
      var t = rs ? rs.ts : App.events[0].ts;
      App.replay = { t: t, playing: false, speed: 60, state: null }; replayAt(t); App.layoutKey = null; renderAll(true); },
    replaystop: function () { App.replay = null; App.layoutKey = null; renderAll(true); },
    replayplay: function () { App.replay.playing = !App.replay.playing; App.dirty.replay = false; App.formSeq.changed = true; renderAll(false); },
    replayjump: function (b) { var r = App.replay, t0 = App.events[0].ts, t1 = App.events[App.events.length - 1].ts; replayAt(Math.max(t0, Math.min(t1, r.t + +b.getAttribute('data-dt')))); App.formSeq.changed = true; renderAll(false); },
    activate: function (b) { fetch('/api/events/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.getAttribute('data-id') }) }); },
    'import': function () {
      var f = document.getElementById('imp-file'); if (!f || !f.files[0]) return U.toast('Choose a .pitwall.json file', 'warn', null, false);
      var fr = new FileReader();
      fr.onload = function () { fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fr.result }).then(function (r) { return r.json(); }).then(function (j) { U.toast(j.error ? j.error : 'Weekend restored', j.error ? 'crit' : 'info'); }); };
      fr.readAsText(f.files[0]);
    }
  };

  function shiftRow(b) {
    return '<div class="row" data-blk style="margin-bottom:6px"><input type="datetime-local" class="b-s" value="' + U.toLocalInput(b.startTs) + '"><input type="datetime-local" class="b-e" value="' + U.toLocalInput(b.endTs) + '">' +
      '<select class="b-k">' + ['duty', 'resting', 'sleeping', 'offline', 'flag', 'unavailable'].map(function (k) { return '<option value="' + k + '"' + (k === b.kind ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select><input class="b-n" placeholder="note" value="' + U.esc(b.note || '') + '" style="flex:1"><button class="btn sm" data-act="shiftdel">Remove</button></div>';
  }
  function openShiftEditor(id) {
    var bl = App.state.crew.shifts[id] || [];
    U.modal('<h3 class="section-title">Shifts - ' + U.esc(E.memberName(App.state, id)) + '</h3><div id="shift-rows">' + bl.map(shiftRow).join('') + '</div>' +
      '<div class="row" style="margin-top:8px"><button class="btn" data-act="shiftadd">Add block</button><span class="spacer"></span><button class="btn primary" data-act="shiftsave" data-id="' + id + '">Save</button><button class="btn" data-act="modalclose">Cancel</button></div>');
  }

  /* ------------------------------------------------------------ plan bars: drag a stop to move it */
  function planStops(id) { var l = App.scenCache && App.scenCache.val.list.filter(function (p) { return p.id === id; })[0]; return l ? l.d.plan.stops : []; }
  // drop a fuel stop onto another stop: the fuel moves there, both stops keep their times (driver changes untouched)
  function fuelMoveDef(id, fromK, toK, stops) {
    stops = stops || planStops(id); var now = App.now(), last = Math.max(fromK, toK);
    var pins = stops.filter(function (x) { return x.k <= last && !x.event && x.ts > now - 60000; }).map(function (x) {
      var p = { ts: x.ts, fuel: x.k === fromK ? false : x.k === toK ? true : x.add > 0, driverIn: x.change ? x.driverIn : null };
      if (x.litresSet && x.k !== fromK && x.k !== toK) p.add = x.litresSet;
      return p;
    });
    var def = R.clone(App.state.scenarios.plans[id].cur); def.pins = pins; return def;
  }
  function pinDef(id, k, newTs, fuelK, stops) {
    stops = stops || planStops(id); var now = App.now();
    var pins = stops.filter(function (x) { return x.k <= k && !x.event && x.ts > now - 60000; }).map(function (x) {
      var p = { ts: x.k === k && newTs ? newTs : x.ts, fuel: x.k === k && fuelK != null ? fuelK : x.add > 0, driverIn: x.change ? x.driverIn : null };
      if (x.litresSet && !(x.k === k && fuelK === false)) p.add = x.litresSet;
      return p;
    });
    var def = R.clone(App.state.scenarios.plans[id].cur); def.pins = pins; return def;
  }
  function moveFuel(id, fromK, toK, stops) {
    App.send('scenario.set', { id: id, def: fuelMoveDef(id, fromK, toK, stops) });
    U.toast('Scenario ' + id + ': fuel moved from stop ' + fromK + ' to stop ' + toK, 'info', null, false);
  }
  function dropTarget(d) {
    var stops = planStops(d.id), src = stops.filter(function (x) { return x.k === d.k; })[0];
    if (!src || !(src.add > 0)) return null;
    var tol = Math.max(4 * MIN, (d.t1 - d.t0) * 0.012);
    return stops.filter(function (x) { return x.k !== d.k && !x.event && Math.abs(x.ts - d.ts) <= tol; })[0] || null;
  }
  // pin stops 1..k (k moved to newTs and/or fuel toggled); every later stop is re-planned
  function pinStops(id, k, newTs, fuelK, stops) { App.send('scenario.set', { id: id, def: pinDef(id, k, newTs, fuelK, stops) }); }
  // live preview while dragging: re-plan with the would-be pins and redraw that scenario row (nothing is saved yet)
  function previewDrag(d) {
    if (!App.lastCtx || !App.scenCache) return;
    var base = App.scenCache.val.list.filter(function (p) { return p.id === d.id; })[0]; if (!base) return;
    var def = d.target ? fuelMoveDef(d.id, d.k, d.target.k, d.stops) : pinDef(d.id, d.k, d.ts, null, d.stops);
    var dd = E.derive(App.state, App.now(), Object.assign({ noScenario: true }, E.defToWhatIf(def)));
    var p = Object.assign({}, base, { def: def, d: dd, dirty: true, pins: (def.pins || []).length });
    var panel = viewEl.querySelector('[data-panel="plan-' + d.id + '"]'); if (!panel) return;
    panel.innerHTML = V.planRow(App.lastCtx, p).html; panel._html = null;
    d.bar = panel.querySelector('.pbar'); d.rect = d.bar.getBoundingClientRect();
    var pct = (d.ts - d.t0) / (d.t1 - d.t0) * 100, gh = d.bar.querySelector('.pb-ghost');
    gh.hidden = false; gh.style.left = pct + '%';
    gh.textContent = d.target ? 'drop: move the fuel to stop ' + d.target.k : U.clock(d.ts) + ' - ' + dd.plan.stops.length + ' stops, finish ' + U.L(dd.plan.finishFuelL) + ' L' + (dd.plan.warnings.length ? ' (!)' : '');
    var mk = d.bar.querySelector('.pb-stop[data-k="' + d.k + '"]'); if (mk) mk.classList.add('dragging');
  }
  var evd = null;
  document.addEventListener('pointerdown', function (e) {
    var el = e.target.closest && e.target.closest('.pb-ev.edit');
    if (!el || App.role !== 'engineer' || App.replay) return;
    var bar = el.closest('.pbar'), r = bar.getBoundingClientRect(), id = el.getAttribute('data-plan'), i = +el.getAttribute('data-i');
    var ev = App.state.scenarios.plans[id].cur.events[i];
    evd = { el: el, bar: bar, rect: r, id: id, i: i, mode: e.target.classList.contains('pb-ev-h') ? 'len' : 'move', x0: e.clientX, from: ev.from, to: ev.to,
      t0: +bar.getAttribute('data-t0'), t1: +bar.getAttribute('data-t1'), now: +bar.getAttribute('data-now') };
    App.dragging = true; el.classList.add('dragging'); el.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (!evd) return;
    var span = evd.t1 - evd.t0, dt = Math.round((e.clientX - evd.x0) / evd.rect.width * span / MIN) * MIN;
    var from = evd.from, to = evd.to;
    if (evd.mode === 'move') { from = Math.max(evd.now, Math.min(evd.t1 - (to - from), evd.from + dt)); to = from + (evd.to - evd.from); }
    else to = Math.max(from + 2 * MIN, Math.min(evd.t1, evd.to + dt));
    evd.nf = from; evd.nt = to;
    evd.el.style.left = ((from - evd.t0) / span * 100) + '%'; evd.el.style.width = ((to - from) / span * 100) + '%';
    var gh = evd.bar.querySelector('.pb-ghost'); gh.hidden = false; gh.style.left = ((from - evd.t0) / span * 100) + '%';
    gh.textContent = U.clock(from) + '-' + U.clock(to) + ' (' + Math.round((to - from) / MIN) + ' min)';
  });
  document.addEventListener('pointerup', function () {
    if (!evd) return;
    var d = evd; evd = null; App.dragging = false; d.el.classList.remove('dragging');
    if (d.nf == null) return;
    var def = R.clone(App.state.scenarios.plans[d.id].cur);
    def.events[d.i].from = d.nf; def.events[d.i].to = d.nt;
    App.send('scenario.set', { id: d.id, def: def });
  });
  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    var hit = e.target.closest && e.target.closest('.pb-stop.drag, .pb-win.drag');
    var el = hit && hit.classList.contains('pb-win') ? hit.closest('.pbar').querySelector('.pb-stop[data-k="' + hit.getAttribute('data-k') + '"]') : hit;
    if (!el || App.role !== 'engineer' || App.replay) return;
    var bar = el.closest('.pbar'), r = bar.getBoundingClientRect();
    drag = { el: el, bar: bar, rect: r, id: el.getAttribute('data-plan'), k: +el.getAttribute('data-k'), x0: e.clientX, moved: false,
      t0: +bar.getAttribute('data-t0'), t1: +bar.getAttribute('data-t1'), now: +bar.getAttribute('data-now') };
    App.dragging = true; el.classList.add('dragging'); el.setPointerCapture(e.pointerId); e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
    var f = Math.max(0, Math.min(1, (e.clientX - drag.rect.left) / drag.rect.width));
    var ts = Math.max(drag.now + 2 * MIN, Math.min(drag.t1 - 5 * MIN, drag.t0 + f * (drag.t1 - drag.t0)));
    drag.ts = Math.round(ts / MIN) * MIN;
    var pct = (drag.ts - drag.t0) / (drag.t1 - drag.t0) * 100;
    drag.el.style.left = pct + '%';
    var gh = drag.bar.querySelector('.pb-ghost'); gh.hidden = false; gh.style.left = pct + '%';
    var tg = dropTarget(drag); drag.target = tg;
    gh.textContent = tg ? 'drop: move the fuel to stop ' + tg.k : U.clock(drag.ts);
    if (!drag.stops) drag.stops = planStops(drag.id);
    if (drag.moved && Date.now() - (drag.pvAt || 0) > 150) { drag.pvAt = Date.now(); previewDrag(drag); }
  });
  document.addEventListener('pointerup', function () {
    if (!drag) return;
    var d = drag; drag = null; App.dragging = false; d.el.classList.remove('dragging');
    if (d.moved && d.target) { moveFuel(d.id, d.k, d.target.k, d.stops); App.layoutKey = null; return; }
    if (d.moved && d.ts) { pinStops(d.id, d.k, d.ts, null, d.stops); App.layoutKey = null; return; }
    var st = planStops(d.id).filter(function (x) { return x.k === d.k; })[0];
    if (!st) return;
    U.modal('<h3 class="section-title">Scenario ' + d.id + ' - stop ' + st.k + ' at ' + U.clock(st.ts) + '</h3><p class="small muted">' + (st.add ? 'Fuel stop, ' + st.add + ' L' : 'No fuel') + (st.change ? ', ' + U.esc(E.memberName(App.state, st.driverOut)) + ' to ' + U.esc(E.memberName(App.state, st.driverIn)) : ', no driver change') + '. Drag the stop on the bar to move it; later stops re-plan.</p>' +
      '<div class="row" style="margin-top:10px">' + (st.add ? '<button class="btn" data-act="planstopfuel" data-id="' + d.id + '" data-k="' + st.k + '" data-fuel="0">Make it a stop without fuel</button>' : '<button class="btn" data-act="planstopfuel" data-id="' + d.id + '" data-k="' + st.k + '" data-fuel="1">Make it a fuel stop</button>') +
      (st.pinned ? '<button class="btn" data-act="planstopunpin" data-id="' + d.id + '" data-ts="' + st.ts + '">Unpin this and later stops</button>' : '') + '<button class="btn" data-act="modalclose">Cancel</button></div>');
  });

  /* ------------------------------------------------------------ DOM events */
  document.getElementById('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]'); if (!b) return;
    var t = b.getAttribute('data-tab');
    if (t === 'setup') SU.begin(App, App.state ? 'edit' : 'new');
    App.goTab(t);
  });
  document.body.addEventListener('click', function (e) {
    if (App.tab === 'setup' && viewEl.contains(e.target) && SU.onClick(e, viewEl)) return;
    var b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    var a = A[b.getAttribute('data-act')];
    if (a) { e.preventDefault(); a(b); }
  });
  viewEl.addEventListener('input', function (e) {
    var p = e.target.closest('[data-panel]'); if (p) App.dirty[p.getAttribute('data-panel')] = Date.now();
    if (App.tab === 'setup') App.dirty.setup = Date.now();
    if (e.target.getAttribute('data-act-input') === 'scrub') { replayAt(+e.target.value); App.formSeq.changed = true; }
    if (e.target.id === 'fp-l' && e.target.value !== '') { App.fuelEdit = { ts: App.fuelSelTs(), litres: Math.max(0, +e.target.value) }; scheduleRender(); }
  });
  viewEl.addEventListener('change', function (e) {
    if (App.tab === 'setup' && SU.onChange(e, viewEl)) return;
    var t = e.target, act = t.getAttribute('data-act-change');
    if (act === 'crewstatus') {
      var reason = val('cs-reason');
      App.send('crew.status', { memberId: t.getAttribute('data-id'), status: t.value, reason: reason });
      App.dirty.roster = false;
    }
    if (act === 'replayspeed') { App.replay.speed = +t.value; App.dirty.replay = false; }
  });
  document.getElementById('btn-mute').addEventListener('click', function () {
    var m = this.getAttribute('aria-pressed') !== 'true';
    this.setAttribute('aria-pressed', String(m)); this.textContent = m ? 'Sound off' : 'Sound on'; U.setMuted(m);
  });
  document.getElementById('modal').addEventListener('click', function (e) { if (e.target.id === 'modal') U.closeModal(); });
  document.getElementById('brandprod').textContent = window.PWBrand.product;
  document.getElementById('brandline').textContent = window.PWBrand.line;
  document.getElementById('logo').addEventListener('error', function () { this.src = '/assets/mullaloo-logo.png'; });

  connect();
})();
