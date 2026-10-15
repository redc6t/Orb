/* Tooltips: what a field is, and what raising / lowering it does.
   Keys: setup data-k paths, element ids (#id), KPI tile labels (kpi:Label). */
(function () {
  'use strict';
  var T = {
    // ---------------- setup: regulations / event
    'rulesId': { d: 'Regulation profile the whole app enforces: fuel stop minimum, per-stop litres, mandatory stops, refuelling under flags, stint limit, crew roles.', note: 'Changing it mid-event re-plans immediately.' },
    'name': { d: 'Event name shown in the weekend list and export file name.' },
    'date': { d: 'Event date (used for the weekend file and per-day black-flag counts).' },
    'track.id': { d: 'Track preset. Selects the fuel baseline for this car at this track.' },
    'track.lapLengthKm': { d: 'Lap length, only needed for distance races (e.g. 1000 km).', up: 'Fewer laps to complete a distance race.', down: 'More laps to complete a distance race.' },
    'track.pitLaneS': { d: 'Time to drive the pit lane from entry line to exit line, excluding the stationary time.', up: 'Each stop costs more race time; the planner prefers fewer stops.', down: 'Stops are cheaper; more stops become acceptable.' },
    'race.format': { d: 'Race length preset (time, distance or laps).' },
    'race.durationMin': { d: 'Race length in minutes.', up: 'More fuel and driver stints needed: more stops.', down: 'Fewer stops.' },
    'race.laps': { d: 'Race length in laps (lap-based races).' },
    'race.distanceKm': { d: 'Race length in km (distance races). Needs the lap length.' },
    'race.expectedLapS': { d: 'Expected green-flag lap time before live laps exist. Replaced by the live median lap once laps come in.', up: 'Fewer laps per stint and lower burn per lap in pre-race estimates.', down: 'More laps per stint, higher burn per lap.' },
    // ---------------- team & car
    'team.name': { d: 'Team name shown in the header on every screen.' },
    'team.carNumber': { d: 'Car number shown in the header.' },
    '#su-car': { d: 'Car profile from the library. Profiles keep tank sizes and learned fuel burn per track between events.' },
    'car.tanks.primaryL': { d: 'Primary tank capacity in litres.', up: 'Longer fuel range per stint, fewer fuel stops.', down: 'Shorter fuel range, more fuel stops.' },
    'car.tanks.secondaryL': { d: 'Surge / secondary tank that refills the primary. Counted as usable capacity.', up: 'More range.', down: 'Less range.' },
    'car.tanks.unusableL': { d: 'Fuel the pickup cannot draw (sloshing, pickup height). Subtracted from capacity.', up: 'Less usable range: earlier stops, safer.', down: 'More usable range: later stops, less margin.' },
    'strategy.reserveL': { d: 'Litres the planner never plans to go below. Fuel stops are timed to arrive with at least this much.', up: 'Safer, but earlier stops and possibly an extra fuel stop.', down: 'Longer stints, higher fuel-out risk if the model is off.' },
    'car.tanks.confirmed': { d: 'Tick once the tank sizes are physically checked for this event. Clears the setup warning.' },
    'car.fuelProfiles.*.greenLph': { d: 'Starting green-flag burn at this track in litres per hour. Every brim fill and visual check recalibrates it live.', up: 'Plan assumes higher burn: earlier and more fuel stops.', down: 'Plan assumes lower burn: later stops, risk if optimistic.' },
    'car.fuelProfiles.*.scLph': { d: 'Starting burn under Safety Car / Yellow in L/h (typically ~40% below green).', up: 'Caution periods save less fuel in the plan.', down: 'Caution periods save more fuel in the plan.' },
    'car.refuel.methodId': { d: 'Refuelling method allowed by the regs. Sets can size, fuel-area limit and the 3-person crew roles.' },
    'car.refuel.pourLpm': { d: 'How fast the crew gets fuel in (litres per minute). Only matters if pouring takes longer than the minimum fuel stop.', up: 'Shorter estimated fuel stops for big fills.', down: 'Big fills may exceed the minimum stop time.' },
    'car.driverChangeS': { d: 'Seconds for a driver swap (out, in, belts, radio). Added after fuelling when swaps are not allowed during it.', up: 'Driver-change stops cost more.', down: 'Driver changes are cheaper.' },
    '#su-savecar': { d: 'Store this car (tanks, burn per track, refuel method) in the library for future weekends.' },
    // ---------------- tyres / policies / devices
    '#su-nsets': { d: 'Number of tyre sets available this weekend.' },
    'tyres.newDepthMm': { d: 'Tread depth of a new tyre (life = 100%).', up: 'Same measurement reads as more wear used.', down: 'Same measurement reads as less wear used.' },
    'tyres.minDepthMm': { d: 'Tread depth treated as end of life (life = 0%).', up: 'Tyres reach end of life sooner.', down: 'More usable life, closer to the legal/safe limit.' },
    'tyres.startSetId': { d: 'Set fitted at the start of the first session.' },
    'crewPolicy.dutyLimitH': { d: 'Hours on duty before a rest alert is raised for a crew member (overridable for contingencies).', up: 'Fewer rest alerts, more fatigue risk.', down: 'More frequent rest alerts.' },
    'crewPolicy.minDriverRestH': { d: 'Minimum rest between stints for the same driver. The planner skips drivers who have not rested enough.', up: 'Fresher drivers, but rotation may need more drivers.', down: 'Tighter rotation, more fatigue risk.' },
    'crewPolicy.shiftH': { d: 'Length of the alternating A/B crew shifts used by "Draft shifts" for races of 12 h+.', up: 'Longer shifts, fewer handovers.', down: 'Shorter shifts, more handovers and more rest windows.' },
    'strategy.maxStintMin': { d: 'Max continuous time behind the wheel. Empty = the regulation limit. Can only be set at or below the regs.', up: 'Longer stints, fewer driver changes (never above the regs).', down: 'More driver changes, fresher drivers.' },
    'strategy.driverChangeMode': { d: 'When the planner swaps drivers: only when the stint limit forces it, at every stop, or at fuel stops.' },
    'strategy.stintSafetyMin': { d: 'Margin kept below the max stint so a slow in-lap or traffic does not break the limit.', up: 'Safer, slightly shorter stints.', down: 'Stints run closer to the limit.' },
    'strategy.fillToBrim': { d: 'Fill the tank to full at every fuel stop. Costs no time when pouring fits inside the minimum stop, adds margin, and each brim fill calibrates the fuel model.' },
    'ui.clock24': { d: 'How clock times are shown everywhere: 24 hour (13:00, 00:00) or 12 hour with am/pm (1:00 pm). Durations always show units (1h 55m).' },
    'devices.pltd.enabled': { d: 'Connect to the PLTD lap timer (laps, car state from geofences, pit board, flags, map).' },
    'devices.pltd.host': { d: 'PLTD IP address (shown on its screen; DHCP from the VDG). Add :port only for the simulator.' },
    'devices.bttm.enabled': { d: 'Poll the BTTM for brake/tyre temperatures, TPMS and alarms.' },
    'devices.bttm.host': { d: 'BTTM IP address (shown on its screen).' },
    'devices.bttm.pollMs': { d: 'How often the BTTM is polled.', up: 'Less load on the BTTM, slower updates.', down: 'Faster updates, more load on the BTTM web server.' },
    'devices.udp.enabled': { d: 'Listen for JSON over UDP (simulator, future IMU impact node, other devices).' },
    'devices.udp.port': { d: 'UDP port to listen on.' },
    '#su-logo': { d: 'Logo shown in the header and on every device. The Mullaloo Motorsport Engineering Solutions logo is built in; upload a PNG/SVG only to replace it (kept for every weekend).' },
    // ---------------- pit wall inputs
    '#fc-l': { d: 'Litres you read on the gauge or dipstick right now. Anchors the fuel estimate and calibrates the model (half weight of a brim fill).' },
    '#ps-fuel': { d: 'Litres actually poured at this stop. Pre-filled from the plan.', up: 'Longer next stint.', down: 'Earlier next fuel stop.' },
    '#ps-cans': { d: 'Number of cans poured. Used to compute litres if the litre field is empty.' },
    '#ps-before': { d: 'Optional gauge reading before fuelling. Gives the model a measurement even without a brim fill.' },
    '#ps-driver': { d: 'Driver who leaves the box. Pre-filled from the plan. Same as the current driver = no change (continuous time keeps counting).' },
    '#ps-tyre': { d: 'Tyre set fitted at this stop (not allowed during fuelling). Enter the removed set tread below if measured.' },
    '#ps-pen': { d: 'Mark this stop as serving a penalty. Penalty stops do not count toward mandatory stops.' },
    '#ps-brim': { d: 'Tick only if the tank was filled until full. A brim fill is the strongest fuel measurement: it recalibrates the burn model.' },
    '#ss-id': { d: 'Session to start on the green flag.' },
    '#ss-fuel': { d: 'Fuel in the car at the green flag. Starting anchor for the fuel estimate.', up: 'First stop later.', down: 'First stop earlier.' },
    '#ss-driver': { d: 'Driver starting the session.' },
    '#ss-tyre': { d: 'Tyre set fitted for the start.' },
    '#pm-text': { d: 'Custom pit board text sent to the PLTD display (16 characters maximum, firmware limit).' },
    '#pm-pri': { d: 'High priority messages stay up until the driver acknowledges them on the PLTD.' },
    '#ondeck-sel': { d: 'Driver to put next in the rotation. The planner and prepare-alerts follow it.' },
    // ---------------- strategy what-if
    '#wi-lap': { d: 'Change in lap time vs the current pace, e.g. +5 s for rain.', up: 'Slower laps: fewer laps per stint; burn per hour drops once laps are much slower.', down: 'Faster laps: more laps per stint.' },
    '#wi-sc': { d: 'Assume a Safety Car starting now for this many minutes.', up: 'More fuel saved, stops move later.', down: 'Less effect.' },
    '#wi-scpct': { d: 'Fuel saving during that Safety Car vs green running.', up: 'More fuel saved per SC minute.', down: 'Less saving.' },
    '#wi-gm': { d: 'Change green-flag burn by a percentage (e.g. -5 to test fuel saving, +8 for a heavy-footed driver).', up: 'More fuel used: earlier / extra fuel stops.', down: 'Less fuel used: can drop a fuel stop if large enough.' },
    // ---------------- crew / car / log
    '#gs-len': { d: 'Shift length for the drafted crew rota (alternating groups A and B).', up: 'Longer shifts, fewer handovers.', down: 'Shorter shifts, more rest windows.' },
    '#cs-reason': { d: 'Reason recorded with the next status change (e.g. "Marshal post 3", "sick").' },
    '#drv-set': { d: 'Correct who is in the car if a swap was not logged. Starts a new continuous stint for that driver.' },
    '#pn-kind': { d: 'Penalty type. Sin bin and stop-go stops are excluded from mandatory stop counts.' },
    '#pn-bf': { d: 'Counts as a black flag for this driver today (BEERS escalation).' },
    '#lg-type': { d: 'Filter the log by event type. "nolaps" hides lap events.' },
    // ---------------- KPI tiles
    'kpi:Stint': { d: 'Continuous time behind the wheel for the driver in the car, against the max stint. The mark is the 15 min warning; prepare alerts go to the next driver at 30 and 15 min.' },
    'kpi:Fuel on board': { d: 'Estimated litres now: last anchor (start fill, brim fill or check) plus fuel added minus modelled burn. The +/- grows since the last measurement.' },
    'kpi:To reserve': { d: 'Laps and time until the tank reaches the reserve floor at current green pace.' },
    'kpi:Burn model': { d: 'Current green and Safety Car burn rates. Starts from the car baseline and is refitted after every brim fill or check.' },
    'kpi:Per lap': { d: 'Green-flag fuel per lap at the current reference pace.' },
    'kpi:Fuel stops left': { d: 'Fuel stops in the current plan to the flag.' },
    'kpi:Mandatory': { d: 'Stops that count toward the mandatory minimum (B4B: 5 stops of at least 5 min).' },
    'kpi:Next stop': { d: 'Type and clock time of the next planned stop.' },
    'kpi:Lap': { d: 'Estimated lap number at that time.' },
    'kpi:Fuel': { d: 'Litres to add and cans. "Brim" means fill to full.' },
    'kpi:Driver': { d: 'Driver getting in at that stop (or "Stays").' },
    'kpi:Stationary': { d: 'Planned time stopped in the box (fuel minimum, swap, mandatory minimum).' },
    'kpi:Window': { d: 'Earliest time you can stop and still reach the next fuel stop after filling, to the latest before reserve or the stint limit.' },
    'kpi:Ref pace': { d: 'Median of recent clean green laps. Used for laps-to-go and per-lap fuel.' },
    'kpi:Delta': { d: 'Live delta from the PLTD against its reference lap. Red = slower.' },
    'kpi:In pit lane': { d: 'Time since pit entry. Mandatory stops are timed entry to exit.' },
    'kpi:Fuelling': { d: 'Time in the fuel zone (PLTD geofence). Must reach the regulation minimum.' }
  };

  function keyFor(el) {
    var k = el.getAttribute('data-k');
    if (k) return k.replace(/^car\.fuelProfiles\.[^.]+\./, 'car.fuelProfiles.*.');
    if (el.id && T['#' + el.id]) return '#' + el.id;
    if (el.classList.contains('lbl')) return 'kpi:' + el.textContent.trim();
    return null;
  }

  function apply(root) {
    (root || document).querySelectorAll('[data-k], [id], .kv .lbl, .nextstop .lbl').forEach(function (el) {
      var k = keyFor(el);
      if (!k || !T[k]) return;
      var target = el.classList.contains('lbl') ? el.parentElement : (el.closest('label.f, label.chk') || el);
      target.setAttribute('data-tip', k);
    });
  }

  var box = null, timer = null, current = null, hideTimer = null;
  function show(target) {
    var t = T[target.getAttribute('data-tip')];
    if (!t) return;
    if (!box) { box = document.createElement('div'); box.id = 'tip'; box.setAttribute('role', 'tooltip'); document.body.appendChild(box); }
    box.innerHTML = '<div>' + U.esc(t.d) + '</div>' + (t.up ? '<div class="tip-up"><b>Higher:</b> ' + U.esc(t.up) + '</div>' : '') + (t.down ? '<div class="tip-down"><b>Lower:</b> ' + U.esc(t.down) + '</div>' : '') + (t.note ? '<div class="tip-note">' + U.esc(t.note) + '</div>' : '');
    box.style.display = 'block';
    var r = target.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
    var x = Math.min(window.innerWidth - bw - 8, Math.max(8, r.left));
    var y = r.bottom + 8;
    if (y + bh > window.innerHeight - 8) y = Math.max(8, r.top - bh - 8);
    box.style.left = x + 'px'; box.style.top = y + 'px';
    current = target;
  }
  function hide() { clearTimeout(timer); if (box) box.style.display = 'none'; current = null; }

  document.addEventListener('mouseover', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (t === current) return;
    clearTimeout(timer);
    if (!t) { hide(); return; }
    timer = setTimeout(function () { show(t); }, 450);
  });
  document.addEventListener('focusin', function (e) { var t = e.target.closest && e.target.closest('[data-tip]'); if (t) show(t); });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch') { hide(); return; }
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (t && !/INPUT|SELECT|BUTTON|TEXTAREA/.test(e.target.tagName)) { show(t); clearTimeout(hideTimer); hideTimer = setTimeout(hide, 5000); }
    else hide();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });

  window.PWTips = { apply: apply, TIPS: T };
})();
