/* Race weekend setup: first-run form, later edits are logged as setup.update events. */
(function () {
  'use strict';
  var U = window.U, R = window.PWReducer;
  var esc = U.esc;
  var ROLES = ['driver', 'mechanic', 'refueller', 'assistant', 'cutoff', 'pump', 'fire', 'raceceiver', 'engineer', 'timing', 'other'];
  var S = { draft: null, mode: 'new', app: null, baseline: null, saveCar: true };

  function get(o, path) { return path.split('.').reduce(function (a, k) { return a == null ? a : a[k]; }, o); }
  function set(o, path, v) { var ks = path.split('.'); var t = o; for (var i = 0; i < ks.length - 1; i++) { if (t[ks[i]] == null) t[ks[i]] = isNaN(+ks[i + 1]) ? {} : []; t = t[ks[i]]; } t[ks[ks.length - 1]] = v; }

  S.begin = function (app, mode) {
    S.app = app; S.mode = mode;
    if (mode === 'edit' && app.state) { S.draft = R.clone(app.state.config); S.baseline = R.clone(app.state.config); }
    else { S.draft = R.clone(app.meta.defaultConfig); S.baseline = null; }
  };

  function inp(path, label, type, extra) {
    var v = get(S.draft, path);
    var ro = S.app.role !== 'engineer' ? ' disabled' : '';
    if (type === 'checkbox') return '<label class="chk"><input type="checkbox" data-k="' + path + '"' + (v ? ' checked' : '') + ro + '> ' + label + '</label>';
    return '<label class="f">' + label + '<input type="' + (type || 'text') + '" data-k="' + path + '" data-type="' + (type || 'text') + '" value="' + esc(v == null ? '' : v) + '"' + (extra || '') + ro + '></label>';
  }
  function sel(path, label, opts, extra) {
    var v = get(S.draft, path);
    var ro = S.app.role !== 'engineer' ? ' disabled' : '';
    return '<label class="f">' + label + '<select data-k="' + path + '"' + (extra || '') + ro + '>' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(v) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
  }

  function warnings() {
    var c = S.draft, r = c.rules || {}, w = [];
    var nDrivers = (c.members || []).filter(function (m) { return m.driver; }).length;
    var longRace = c.race.mode === 'time' && c.race.durationMin >= 1440;
    var minD = longRace ? (r.drivers.minDrivers24h || r.drivers.minDrivers) : r.drivers.minDrivers;
    if (minD && nDrivers < minD) w.push('Only ' + nDrivers + ' drivers - ' + r.organiser.split(' ')[0] + ' requires at least ' + minD + (longRace ? ' for a 24 h+ event' : ''));
    if (r.drivers.maxDrivers && nDrivers > r.drivers.maxDrivers) w.push(nDrivers + ' drivers exceeds the maximum of ' + r.drivers.maxDrivers);
    var t = c.car.tanks || {};
    var tot = (+t.primaryL || 0) + (+t.secondaryL || 0);
    if (r.fuel && r.fuel.tankMaxL && tot > r.fuel.tankMaxL) w.push('Fuel system ' + tot + ' L exceeds the ' + r.fuel.tankMaxL + ' L maximum');
    if (!t.confirmed) w.push('Tank sizes not confirmed for this event (' + (t.primaryL || 0) + ' L primary + ' + (t.secondaryL || 0) + ' L secondary)');
    var method = (r.fuel.methods || []).filter(function (m) { return m.id === (c.car.refuel || {}).methodId; })[0];
    if (!method) w.push('Refuel method "' + ((c.car.refuel || {}).methodId || '-') + '" is not allowed by these regs - pick one');
    if (method) method.roles.forEach(function (ro) { if (!(c.members || []).some(function (m) { return (m.roles || []).indexOf(ro.key) >= 0; })) w.push('Nobody tagged as ' + ro.label + ' (role "' + ro.key + '")'); });
    if (r.crew && r.crew.raceceiverRequired && !(c.members || []).some(function (m) { return (m.roles || []).indexOf('raceceiver') >= 0; })) w.push('Raceceiver relay required at all times - tag at least one member "raceceiver" (two for long races)');
    var ms = c.strategy.maxStintMin;
    if (ms && ms > r.drivers.maxStintMin) w.push('Max stint ' + ms + ' min is above the regs limit of ' + r.drivers.maxStintMin);
    if (longRace && r.lights && r.lights.headlightsMinRaceH) w.push('Continuous ' + Math.round(c.race.durationMin / 60) + ' h race: low-beam headlights and the high-level brake light must work (add to scrutineering checks)');
    if (!c.team.name) w.push('Team name is empty');
    return w;
  }

  S.render = function (el) {
    var c = S.draft, m = S.app.meta, eng = S.app.role === 'engineer';
    var rulesOpts = Object.keys(m.rules).map(function (k) { var r = m.rules[k]; return [k, r.organiser.split(' (')[0].split(' - ')[0] + ' - ' + r.version]; });
    var r = c.rules;
    var trackOpts = m.tracks.map(function (t) { return [t.id, t.name]; }).concat([['custom', 'Other track...']]);
    var fmtOpts = m.formats.map(function (f) { return [f.id, f.label]; });
    var carOpts = m.cars.map(function (x) { return [x.id, x.make + ' ' + x.model]; }).concat([['__new', 'New car...']]);
    var methodOpts = (r.fuel.methods || []).map(function (x) { return [x.id, x.label]; });
    var trackId = c.track.id || 'collie-motorplex';
    var fp = (c.car.fuelProfiles && (c.car.fuelProfiles[trackId] || c.car.fuelProfiles['default'])) || {};
    if (!c.car.fuelProfiles) c.car.fuelProfiles = {};
    if (!c.car.fuelProfiles[trackId]) c.car.fuelProfiles[trackId] = { greenLph: fp.greenLph || 18, scLph: fp.scLph || 11 };

    var h = '<div class="grid2"><div class="col">';
    h += '<div class="card"><h3><span>' + (S.mode === 'new' ? 'New race weekend' : 'Race weekend setup') + '</span><span class="hint">' + (eng ? (S.mode === 'new' ? 'fill in once, edit any time' : 'changes are logged') : 'view only') + '</span></h3>';
    h += '<div class="section-title">Regulations</div><div class="fgrid">' + sel('rulesId', 'Rules profile', rulesOpts, ' data-rerender="rules"') + '</div>';
    h += '<div class="note" style="margin-top:8px"><b>' + esc(r.organiser) + '</b> - ' + esc(r.document) + ', ' + esc(r.version) + '<ul class="rules" style="margin-top:4px">' + r.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>';
    h += '<div class="small muted" style="margin-top:6px">Importing rules straight from an organiser PDF is not supported yet: profiles are JSON files in the rules folder (copy one to add another series).</div>';

    h += '<div class="section-title" style="margin-top:14px">Event</div><div class="fgrid">' + inp('name', 'Event name') + inp('date', 'Date', 'date') +
      sel('track.id', 'Track', trackOpts, ' data-rerender="track"') + (trackId === 'custom' || !m.tracks.some(function (t) { return t.id === trackId; }) ? inp('track.name', 'Track name') : '') +
      inp('track.lapLengthKm', 'Lap length (km)', 'number', ' step="0.001" placeholder="auto from PLTD"') + inp('track.pitLaneS', 'Pit lane transit (s)', 'number', ' step="1"') +
      sel('race.format', 'Race format', fmtOpts, ' data-rerender="format"') +
      (c.race.mode === 'time' ? inp('race.durationMin', 'Race length (min)', 'number') : c.race.mode === 'laps' ? inp('race.laps', 'Race laps', 'number') : inp('race.distanceKm', 'Race distance (km)', 'number')) +
      inp('race.expectedLapS', 'Expected lap (s)', 'number', ' step="0.1"') + '</div>';

    h += '<div class="section-title" style="margin-top:14px">Sessions</div><table><thead><tr><th>Type</th><th>Name</th><th>Planned start</th><th class="num">Minutes</th><th></th></tr></thead><tbody>' +
      c.sessions.map(function (x, i) {
        var ro = eng ? '' : ' disabled';
        return '<tr><td><select data-s="' + i + '" data-f="type"' + ro + '>' + ['practice', 'quali', 'race', 'warmup'].map(function (t) { return '<option' + (t === x.type ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select></td>' +
          '<td><input data-s="' + i + '" data-f="name" value="' + esc(x.name) + '"' + ro + '></td><td><input type="datetime-local" data-s="' + i + '" data-f="plannedStart" value="' + (x.plannedStart ? U.toLocalInput(Date.parse(x.plannedStart)) : '') + '"' + ro + '></td>' +
          '<td><input type="number" data-s="' + i + '" data-f="durationMin" value="' + (x.durationMin || '') + '" style="width:80px"' + ro + '></td><td>' + (eng ? '<button class="btn sm" data-sact="delsession" data-i="' + i + '">Remove</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' + (eng ? '<button class="btn sm" data-sact="addsession" style="margin-top:6px">Add session</button>' : '');
    h += '</div>';

    h += '<div class="card"><h3><span>Team & car</span><span class="hint">car profiles are saved for next time</span></h3><div class="fgrid">' + inp('team.name', 'Team name') + inp('team.carNumber', 'Car number') + '</div>';
    h += '<div class="fgrid" style="margin-top:10px">' + '<label class="f">Car profile<select id="su-car"' + (eng ? '' : ' disabled') + '>' + carOpts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === c.car.id ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>' +
      inp('car.make', 'Make') + inp('car.model', 'Model') + inp('car.year', 'Year') + '</div>';
    h += '<div class="fgrid" style="margin-top:10px">' + inp('car.tanks.primaryL', 'Primary tank (L)', 'number', ' step="0.5"') + inp('car.tanks.secondaryL', 'Surge / secondary (L)', 'number', ' step="0.5"') +
      inp('car.tanks.unusableL', 'Unusable fuel (L)', 'number', ' step="0.5"') + inp('strategy.reserveL', 'Reserve floor (L)', 'number', ' step="0.5"') + '</div>';
    h += '<div class="row" style="margin-top:6px">' + inp('car.tanks.confirmed', 'Tank sizes confirmed for this event', 'checkbox') + '</div>';
    h += '<div class="fgrid" style="margin-top:10px">' + inp('car.fuelProfiles.' + trackId + '.greenLph', 'Green burn here (L/h)', 'number', ' step="0.05"') + inp('car.fuelProfiles.' + trackId + '.scLph', 'Safety car burn (L/h)', 'number', ' step="0.05"') +
      sel('car.refuel.methodId', 'Refuel method', methodOpts) + inp('car.refuel.pourLpm', 'Pour rate (L/min)', 'number', ' step="1"') + inp('car.driverChangeS', 'Driver change (s)', 'number') + '</div>';
    h += '<div class="small muted" style="margin-top:6px">Fuel burn is the starting point only: every brim fill and visual check during the weekend recalibrates it, and the learned figures can be saved back to this car.</div>';
    if (eng) h += '<div class="row" style="margin-top:6px"><label class="chk"><input id="su-savecar" type="checkbox"' + (S.saveCar ? ' checked' : '') + '> Save this car to the library</label></div>';
    h += '</div>';
    h += '</div><div class="col">';

    // members
    h += '<div class="card"><h3><span>Team members</span><span class="hint">order of drivers = rotation</span></h3><div class="scroll"><table><thead><tr><th></th><th>Name</th><th>Driver</th><th>Roles</th><th></th></tr></thead><tbody>' +
      c.members.map(function (mm, i) {
        var ro = eng ? '' : ' disabled';
        return '<tr><td class="num">' + (i + 1) + '</td><td><input data-m="' + i + '" data-f="name" value="' + esc(mm.name) + '"' + ro + ' style="width:140px"></td><td><input type="checkbox" data-m="' + i + '" data-f="driver"' + (mm.driver ? ' checked' : '') + ro + '></td>' +
          '<td><div class="chips">' + ROLES.map(function (rl) { return '<span class="chip' + ((mm.roles || []).indexOf(rl) >= 0 ? ' on' : '') + '" data-role="' + rl + '" data-mi="' + i + '">' + rl + '</span>'; }).join('') + '</div></td>' +
          '<td>' + (eng ? '<button class="btn sm" data-sact="mup" data-i="' + i + '"' + (i ? '' : ' disabled') + '>Up</button> <button class="btn sm" data-sact="delmember" data-i="' + i + '">Remove</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' + (eng ? '<button class="btn sm" data-sact="addmember" style="margin-top:6px">Add member</button>' : '') +
      '<div class="small muted" style="margin-top:6px">Mid-event changes (new member, sick driver) go here or in Drivers &amp; Crew. Roles drive refuel-crew summons and Raceceiver coverage.</div></div>';

    h += '<div class="card"><h3><span>Tyres, policies & devices</span></h3><div class="fgrid">' +
      '<label class="f">Tyre sets this weekend<input id="su-nsets" type="number" min="1" max="20" value="' + c.tyres.sets.length + '"' + (eng ? '' : ' disabled') + '></label>' +
      inp('tyres.newDepthMm', 'New tread (mm)', 'number', ' step="0.1"') + inp('tyres.minDepthMm', 'Min tread (mm)', 'number', ' step="0.1"') +
      sel('tyres.startSetId', 'Starting set', c.tyres.sets.map(function (t) { return [t.id, t.name]; })) + '</div>';
    h += '<div class="fgrid" style="margin-top:10px">' + inp('crewPolicy.dutyLimitH', 'Rest after on duty (h)', 'number', ' step="0.5"') + inp('crewPolicy.minDriverRestH', 'Min driver rest (h)', 'number', ' step="0.5"') +
      inp('crewPolicy.shiftH', 'Crew shift length (h)', 'number', ' step="0.5"') + inp('strategy.maxStintMin', 'Max stint (min)', 'number', ' placeholder="' + r.drivers.maxStintMin + '"') +
      sel('strategy.driverChangeMode', 'Driver changes', [['max-stint', 'Only when needed'], ['every-stop', 'Every stop'], ['fuel-stops', 'At fuel stops']]) +
      inp('strategy.stintSafetyMin', 'Stint safety margin (min)', 'number') +
      sel('ui.clock24', 'Clock format', [['true', '24 hour (13:00)'], ['false', '12 hour (1:00 pm)']]) + '</div>';
    h += '<div class="row" style="margin-top:6px">' + inp('strategy.fillToBrim', 'Fill to brim at fuel stops (more margin, calibrates the model)', 'checkbox') + '</div>';
    h += '<div class="fgrid" style="margin-top:10px">' + inp('devices.pltd.enabled', 'PLTD lap timer', 'checkbox') + inp('devices.pltd.host', 'PLTD IP') +
      inp('devices.bttm.enabled', 'BTTM', 'checkbox') + inp('devices.bttm.host', 'BTTM IP') + inp('devices.bttm.pollMs', 'BTTM poll (ms)', 'number') +
      inp('devices.udp.enabled', 'UDP input', 'checkbox') + inp('devices.udp.port', 'UDP port', 'number') + '</div>';
    h += '<div class="small muted" style="margin-top:6px">The laptop must be on the same network as the devices (VDG / MME_AP, 192.168.0.x). PLTD: WebSocket ws://IP/ws. BTTM: HTTP /data.</div>';
    if (eng) h += '<div class="section-title" style="margin-top:14px">Branding</div><div class="row"><img src="/branding/logo?v=' + Date.now() + '" style="width:48px;height:48px;border-radius:8px;background:#0e0e0e;object-fit:contain"><label class="f" style="flex:1">Logo (default: ' + esc(window.PWBrand.line) + ' - upload PNG/SVG to replace)<input id="su-logo" type="file" accept="image/png,image/svg+xml,image/jpeg"></label><button class="btn sm" data-sact="logoreset" style="align-self:flex-end">Use default logo</button></div>';
    h += '</div>';

    var w = warnings();
    h += '<div class="card"><h3><span>Checks</span></h3>' + (w.length ? w.map(function (x) { return '<div class="note warn" style="margin-bottom:6px">' + esc(x) + '</div>'; }).join('') : '<div class="ok-t">All checks pass</div>') +
      (eng ? '<div class="row" style="margin-top:12px"><button class="btn primary" data-sact="save">' + (S.mode === 'new' ? 'Create race weekend' : 'Save changes') + '</button>' +
        (S.mode === 'edit' ? '<button class="btn" data-sact="newweekend">Start a new weekend instead</button>' : (S.app.state ? '<button class="btn" data-sact="cancelnew">Back to current weekend</button>' : '')) + '</div>' : '') + '</div>';
    h += '</div></div>';
    el.innerHTML = h;
    if (window.PWTips) window.PWTips.apply(el);
  };

  function readInputs(el) {
    el.querySelectorAll('[data-k]').forEach(function (i) {
      var k = i.getAttribute('data-k'), v;
      if (i.type === 'checkbox') v = i.checked;
      else if (i.getAttribute('data-type') === 'number') v = i.value === '' ? null : +i.value;
      else v = i.value;
      set(S.draft, k, v);
    });
    el.querySelectorAll('[data-s]').forEach(function (i) {
      var x = S.draft.sessions[+i.getAttribute('data-s')], f = i.getAttribute('data-f');
      if (f === 'plannedStart') x[f] = i.value ? new Date(i.value).toISOString() : null;
      else if (f === 'durationMin') x[f] = i.value === '' ? null : +i.value;
      else x[f] = i.value;
    });
    el.querySelectorAll('[data-m]').forEach(function (i) {
      var x = S.draft.members[+i.getAttribute('data-m')], f = i.getAttribute('data-f');
      x[f] = i.type === 'checkbox' ? i.checked : i.value;
      if (f === 'driver') { x.roles = x.roles || []; var has = x.roles.indexOf('driver'); if (x.driver && has < 0) x.roles.unshift('driver'); if (!x.driver && has >= 0) x.roles.splice(has, 1); }
    });
    var ns = el.querySelector('#su-nsets');
    if (ns) {
      var n = Math.max(1, Math.min(20, +ns.value || 1)), sets = S.draft.tyres.sets;
      while (sets.length < n) sets.push({ id: 'T' + (sets.length + 1), name: 'Set ' + (sets.length + 1) });
      if (sets.length > n && S.mode === 'new') sets.length = n;
    }
    var sc = el.querySelector('#su-savecar'); if (sc) S.saveCar = sc.checked;
    // keep race session in sync with format
    var c = S.draft;
    c.sessions.forEach(function (x) { if (x.type === 'race' && c.race.mode === 'time') x.durationMin = c.race.durationMin; });
  }

  function applyRerender(kind) {
    var c = S.draft, m = S.app.meta;
    if (kind === 'rules') {
      c.rules = R.clone(m.rules[c.rulesId]);
      if (!(c.rules.fuel.methods || []).some(function (x) { return x.id === c.car.refuel.methodId; })) c.car.refuel.methodId = c.rules.fuel.methods[0].id;
    }
    if (kind === 'format') {
      var f = m.formats.filter(function (x) { return x.id === c.race.format; })[0];
      c.race.mode = f.mode; c.race.durationMin = f.durationMin || null; c.race.distanceKm = f.distanceKm || null; c.race.laps = f.laps || null;
      if (f.durationMin) c.crewPolicy.minDriverRestH = f.durationMin >= 1440 ? 2 : 0;
    }
    if (kind === 'track') {
      var t = m.tracks.filter(function (x) { return x.id === c.track.id; })[0];
      if (t) c.track = R.clone(t); else c.track = { id: 'custom', name: c.track.name || 'Custom track', lapLengthKm: null, pitLaneS: 60 };
    }
  }

  function nextMemberId() { var n = 1; var ids = S.draft.members.map(function (m) { return m.id; }); while (ids.indexOf('m' + n) >= 0) n++; return 'm' + n; }

  S.onClick = function (e, el) {
    var chip = e.target.closest('[data-role]');
    if (chip && S.app.role === 'engineer') {
      readInputs(el);
      var mm = S.draft.members[+chip.getAttribute('data-mi')], rl = chip.getAttribute('data-role');
      mm.roles = mm.roles || [];
      var i = mm.roles.indexOf(rl); if (i >= 0) mm.roles.splice(i, 1); else mm.roles.push(rl);
      if (rl === 'driver') mm.driver = mm.roles.indexOf('driver') >= 0;
      S.render(el); return true;
    }
    var b = e.target.closest('[data-sact]');
    if (!b) return false;
    var act = b.getAttribute('data-sact'), idx = +b.getAttribute('data-i');
    readInputs(el);
    var c = S.draft;
    if (act === 'addmember') c.members.push({ id: nextMemberId(), name: 'New member', driver: false, roles: ['mechanic'] });
    if (act === 'delmember') c.members.splice(idx, 1);
    if (act === 'mup' && idx > 0) { var t = c.members[idx]; c.members[idx] = c.members[idx - 1]; c.members[idx - 1] = t; }
    if (act === 'addsession') c.sessions.push({ id: 's' + Date.now().toString(36), type: 'practice', name: 'Practice ' + (c.sessions.length + 1), plannedStart: null, durationMin: 30 });
    if (act === 'delsession') c.sessions.splice(idx, 1);
    if (act === 'newweekend') { S.begin(S.app, 'new'); }
    if (act === 'cancelnew') { S.begin(S.app, 'edit'); }
    if (act === 'save') { save(); return true; }
    if (act === 'logoreset') { fetch('/api/branding/logo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) }).then(function () { U.toast('Default logo restored', 'info'); S.render(el); }); return true; }
    S.render(el); return true;
  };

  S.onChange = function (e, el) {
    var t = e.target;
    if (t.id === 'su-car') {
      readInputs(el);
      var car = S.app.meta.cars.filter(function (x) { return x.id === t.value; })[0];
      if (car) S.draft.car = R.clone(car);
      else S.draft.car = { id: 'car-' + Date.now().toString(36), make: '', model: '', year: '', tanks: { primaryL: 50, secondaryL: 0, unusableL: 0, confirmed: false }, fuelProfiles: { 'default': { greenLph: 18, scLph: 11 } }, refuel: { methodId: S.draft.rules.fuel.methods[0].id, pourLpm: 25, handlingMin: 1 }, driverChangeS: 30 };
      S.render(el); return true;
    }
    if (t.id === 'su-logo' && t.files && t.files[0]) {
      var fr = new FileReader();
      fr.onload = function () {
        fetch('/api/branding/logo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: fr.result }) })
          .then(function (r) { return r.json(); }).then(function (j) { if (j.error) U.toast(j.error, 'warn'); else { U.toast('Logo saved', 'info'); S.render(el); } });
      };
      fr.readAsDataURL(t.files[0]); return true;
    }
    var rr = t.getAttribute && t.getAttribute('data-rerender');
    if (rr) { readInputs(el); applyRerender(rr); S.render(el); return true; }
    if (t.id === 'su-nsets' || t.getAttribute('data-f') === 'driver') { readInputs(el); S.render(el); return true; }
    return false;
  };

  function save() {
    var c = S.draft;
    c.driverOrder = c.members.filter(function (m) { return m.driver; }).map(function (m) { return m.id; });
    if (!c.name) { var fl = (S.app.meta.formats.filter(function (f) { return f.id === c.race.format; })[0] || {}).label || c.race.format; c.name = (c.rules.organiser || '').split(' ')[0] + ' ' + fl + ' - ' + (c.track.name || ''); }
    if (S.mode === 'new') {
      c.id = (c.date || '') + '-' + String(c.track.id || 'track') + '-' + String(c.race.format || '');
      c.createdTs = Date.now();
      fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: c, saveCar: S.saveCar }) })
        .then(function (r) { return r.json(); }).then(function (j) { if (j.error) U.toast(j.error, 'crit'); else { U.toast('Race weekend created', 'info'); S.app.afterCreate = true; } });
      return;
    }
    var patch = {};
    ['name', 'date', 'rulesId', 'rules', 'team', 'track', 'car', 'race', 'sessions', 'members', 'tyres', 'crewPolicy', 'strategy', 'devices'].forEach(function (k) {
      if (JSON.stringify(c[k]) !== JSON.stringify(S.baseline[k])) patch[k] = c[k];
    });
    if (patch.members) {
      var cur = S.app.state.drivers.queue || [];
      var drivers = c.members.filter(function (m) { return m.driver; }).map(function (m) { return m.id; });
      patch.driverOrder = cur.filter(function (id) { return drivers.indexOf(id) >= 0; }).concat(drivers.filter(function (id) { return cur.indexOf(id) < 0; }));
    }
    if (!Object.keys(patch).length) { U.toast('No changes to save', 'info'); return; }
    S.app.send('setup.update', { patch: patch, saveCar: S.saveCar && !!patch.car });
    S.baseline = R.clone(c);
    U.toast('Setup saved: ' + Object.keys(patch).join(', '), 'info');
  }

  window.PWSetup = S;
})();
