# Pit Wall Pro2 - Mullaloo Motorsport Engineering Solutions

Offline, self-hosted pit wall strategist for endurance racing. Your PC runs the server. The browser on the PC is the engineer screen; any phone, tablet or laptop on the same network opens the same screens view-only.

Version 2.1.4 (Pro2): a UI overhaul of Pro1 with the same features, server, engine and data format. Pro1 stays available as the full classic layout. Both read the same `data` folder, so you can switch between them on the same weekend (run one at a time).

## What changed in Pro2 and why

The layout follows patterns that recur in established tools:

- **ISA-101 high-performance HMI** (industrial control rooms):
  - Neutral greys for structure and normal values.
  - Colour only for abnormal states (amber warning, red critical, lilac fuel, flags).
  - Flashing only for unacknowledged critical items.
  - Bars with limits instead of bare numbers.
  - A display hierarchy: overview, area, detail, diagnostics.
- **Endurance stint planners** (iRacePlan, the team spreadsheets): one stint table is the backbone of the plan.
- **Pro data systems** (Catapult RaceWatch): dedicated displays for the pit wall and the garage.
- **WEC-style pit walls:** a permanent status strip, and one feed for alerts and messages.

**Rule: every datum has one home.**
- The status bar carries time remaining, lap, car state, flag, devices and role. Nothing below repeats them.
- The Race screen has three columns, each with one job:
  - **Now:** the call, fuel gauge (reserve and planned-arrival marks, uncertainty band), the driver in the car with a stint gauge, up next, and the garage rotation.
  - **Next:** the next stop with fuel, driver swap, stationary time, a fuel-window bar against now, and the refuel crew. When the car enters the pit lane this column becomes **pit mode**: timers as bars against the minimums, jobs for this stop, refuel crew, and the stop log form.
  - **Feed:**
    - **Attention:** unacknowledged alerts with an Ack button, plus jobs for the next stop with a Fixed button.
    - **Race story:** flags, stops, pit board, issues, crew changes. Alerts move here only once acknowledged.
- **Plan:** one stint table (done, now and plan with stops inline), plus the fuel trace, fuel model, what-if and regulations. "Drop one fuel stop" now re-runs the real planner at reduced burn until a fuel stop actually disappears. Pro1's litres-only estimate could show "<0.01 L/lap" where the true figure was 8%.
- **Team:** one roster table (rotation order, presence, status control, duty hours, drive stats) and the shift plan.
- **Car:** issues, tyres with life bars, full BTTM detail with alarms, penalties.
- **Garage display:** big type for a crew TV or tablet:
  - next stop countdown, or the fuelling minimum countdown while the car is in
  - refuel crew names and the driver change
  - jobs for this stop, and refuelling-closed warnings
- **Setup** sits at the right of the tab bar. It is unchanged.
- **Timeline:** now has a legend and hover text on fuel windows.

### Where Pro1 items went

| Pro1 | Pro2 |
|---|---|
| The call, Fuel KPI tiles | Race > Now (call + fuel gauge; model detail in Plan > Fuel model) |
| Next stop tiles, refuel crew (Call card + Crew tab) | Race > Next (once) |
| Pit lane + Log stop panels | Race > Next becomes pit mode when the car is in |
| Timing panel, lap table, car state chip | Status bar (lap, car state) + Race > Timing strip; lap table in Plan > Laps |
| Drivers panel, Team status list | Race > Now (driver, up next, garage chips); full detail in Team |
| Car issues (Pit Wall) | Race > Feed (next-stop jobs); full log in Car |
| Race control | Race > Race control (same functions, compact) |
| Strategy plan + Stops completed | Plan > Stint table (single table) |
| Rotation + Roster tables | Team > one table |
| Alert toasts only | Toasts + Attention list with acknowledge (logged, replayable) |

## Run it (Windows 11)

1. Install Node.js 18+ (LTS) once. `node_modules` is included, so no internet is needed after that.
2. Double-click `start-pitwall.bat` (Pro2). It opens http://localhost:8080 and prints the address for other devices, for example `http://192.168.0.23:8080`.
3. The first time, Windows Firewall asks about Node.js: allow **Private networks**, or other devices cannot connect.
4. First launch shows the **Setup** form. Fill it in and press **Create race weekend**. Restarting the server resumes the weekend automatically.

### Try it now with the demo

```
make-demo.bat          (builds a BEERS 36h weekend, 6 h into the race - replaces only the DEMO weekend)
start-pitwall.bat
start-simulator.bat    (fake PLTD + BTTM; the sim driver obeys the pit board)
```

Send `BOX BOX` from Race control and the simulated car pits at the end of the lap. The PLTD states then open and close the stop and the service form appears. Raising SC or YELLOW slows the simulated car.

## Who can change what

| Device | Can do |
|---|---|
| The main PC (any of its own IP addresses) | Everything |
| Any other device | View every tab, run what-if scenarios locally, browse the log and replay. No changes: the server rejects them (HTTP 403 / WebSocket error). |

To allow a second engineer laptop, add its IP to `engineerHosts` in `data/settings.json`. The server port is set there too.

## Devices

| Device | Protocol used (from your firmware) | Setup field |
|---|---|---|
| PLTD v0.17 | WebSocket client to `ws://IP/ws` (10 Hz `live`, `flagstate`, `pitshown`, `pitack`); completed lap time read from `GET /data` -> `last_lap` on every lap change | PLTD IP |
| BTTM v4.5 | `GET /data` polled at 1 Hz, colour bands from `GET /config` | BTTM IP |
| Anything else | JSON over UDP, port 47800 | UDP port |

The P52 must be on the device network (VDG / MME_AP, 192.168.0.x). Both devices use DHCP, so check their IPs on their screens.

How the data is used:
- PLTD car states (PIT ENTRY / PITS / FUELLING / PIT EXIT) open and close stops and run the stop timers.
- Pit board messages and the Yellow / SC / Red flags go back to the PLTD. The firmware caps messages at 16 characters.
- BTTM alarm levels:
  - Red band = warning, logged.
  - Flashing band = critical: a car issue is logged automatically, flagged for the next stop.
  - Each level re-alarms at most every 5 min.

UDP messages, one JSON object per datagram:

```
{"t":"lap","n":12,"ms":91234,"pitted":false}   {"t":"carstate","cs":"PITS"}   {"t":"flag","flag":"SC"}
{"t":"fuel","litres":32.5}                     {"t":"impact","g":4.2,"lat":-33.36,"lon":116.15}
{"t":"issue","cat":"engine","sev":"warn","text":"Oil temp high"}
```

PLTD v0.17 has no impact output. Sending `{"t":"impact",...}` from a future firmware build logs impacts as car issues.

## What changes the strategy (2.1)

- **STRATEGY** (changes the timeline):
  - geofence gates and stop service
  - track flags (fuel burn, refuelling rules, the call)
  - driver corrections and rotation
  - gauge readings
  - switching or editing Scenarios A-F
  - session start/end
- **MESSAGE** (driver only, no effect on the plan): the pit board. BOX BOX does not create a stop; the stop starts when the car crosses the pit-entry geofence.

The feed and log tag every item accordingly.

## Changes in 2.1.4

- **Scenarios:** fuel windows are thicker on both timelines. Drag a fuel stop, or its window, and the scenario re-plans live while you drag (stints, later stops, stop count, finish fuel); it is saved on release.
- **Durations:** always shown with units (1h 55m, 4m 52s). Clock times are 24 h by default, or 12 h am/pm (Setup, Clock format).
- **FIX:** an UNASSIGNED refuel role shows a FIX button (Race, Garage display). It opens Team, "Fix the refuel crew", with one-click fixes: wake a tagged person, or give an available person the role.
- **Icons:** double size. Car = driving, jerry can = next refuel crew, spanner = mechanic in the garage, bed = sleeping, moon = resting. Sleeping is a new status.
- **Layout:** the feed ends level with the left column and scrolls inside its card. Card titles are lighter, and Garage display titles are big and white.
- **Flags:** Yellow to SC no longer logs a phantom GREEN. The PLTD gets the new flag on before the old one off, and echoes are ignored briefly.
- **Simulator:**
  - the lap counts where the pit lane crosses the start/finish line, with no jump and no double lap
  - a no-fuel stop stays in the pits area
  - Yellow and SC slow the car at once
  - SAVE FUEL and PUSH change its pace

## Fixes in 2.1.3

- **Moving fuel between stops:** in Scenarios, drop a fuel stop onto another stop to move the fuel there. Both stops keep their times and driver changes. Dragging a stop elsewhere still moves the whole stop.
- **The stop in progress follows what you record.** After "No fuel this stop", the plan no longer suggests fuel for it. The Pit lane card shows "Planned at pit in" and "Recorded", and the fuelling minimum and fuel-bay geofence no longer apply.
- **Completion:** the stop is "complete" only after the pit-exit geofence. Before that, the card reads "waiting for the pit-exit geofence" and warns if the PLTD still shows the car in the fuel bay.
- **Simulator:** it follows the gates through `/api/sim/stop`. It fuels only if planned or recorded, stops fuelling on FUEL STOP COMPLETED, and leaves on PIT OUT.
- **Layout:** the Stop gates card and the Fuel stop card now sit in the centre column, above the Pit lane card.

## The call near a stop (2.1.2)

From 5 min before the planned stop (the end of the driver's allocated stint), the call counts laps: BOX IN 3 LAPS, then 2, then 1. On the last lap it becomes **NOTIFY DRIVER: BOX BOX**, with a one-click send and a notification. Once sent, it shows the time sent and the driver's acknowledgement.

During a stop the outgoing driver's time is frozen at the moment the car stops. After the driver change is confirmed, the new driver shows as "In the car - timer starts at pit out". No stint-limit or fuel-window alerts are raised while the car is in the pits.

## Stop gates (2.1.1)

The engineer is the gate controller. The **Stop gates** card at the top of the Race tab's centre column has four steps, with no countdowns:

| Step | Button | Geofence override (only if you have not confirmed it) |
|---|---|---|
| Pit in | **PIT IN** (also opens the stop by hand if the PLTD missed it) | Fuelling starts or the car leaves the fuel bay or pit lane |
| Driver change | Pick the driver, **DRIVER CHANGE DONE** | The car leaves the fuel bay or pit lane: the planned driver is applied |
| Fuel stop | Fuel card, pre-filled from the plan and editable while fuelling: **FUEL STOP COMPLETED** (or **No fuel this stop**) | The car leaves the fuel bay or pit lane: the planned litres are recorded (not used to calibrate the fuel model) |
| Pit out | **PIT OUT** | The pit-exit geofence |

- **OK** means confirmed by the engineer. **AUTO** means the geofence overtook the step.
- **Correct it** reopens an AUTO fuel stop.
- **PLTD offline:** the buttons also set the car state (Pit in, Fuelling started, Fuel stop completed, Pit out), so the stop timers keep working.
- A manual car-state override sits under the pit lane card if a geofence is missed.

## Scenarios (2.1.1)

The **Scenarios** tab (previously Plans A-F) holds six saved scenarios: clean, Safety Car, early SC + sin bin, mechanical, chaos (red flag + 2 SC), driver down.

- **Stops:**
  - **drag a stop** to move it. Earlier stops are pinned and later stops re-plan.
  - **click a stop** to toggle fuel or unpin it.
- **Events:** in **Assumptions** mode, drag a Safety Car, red flag, repair or sin bin along the bar, or drag its right edge to change its length. Everything after it cascades.
- **Lap numbers:** each bar shows the estimated lap number above it, and clock time and race hour below.
- **Reset** returns a scenario to its original.
- **Run this scenario** makes it the live strategy; the status bar shows SCENARIO X.

## Track preset: Collie Motorplex long circuit

- **Layout:** 2.55 km, 13 turns, run anti-clockwise. The outline was traced from the official layout diagram and scaled to 2.55 km. It is stored in `lib/tracks/collie-long.json` with T1 to T13 and the start/finish line.
- **On the map:** the Race map shows this outline with turn numbers until the PLTD has recorded its own reference lap. After that the PLTD outline is used.
- **Simulator:** it drives this layout, with a simulated pit lane on the infield side of the start/finish straight.
- **Geometry (2.1.2):** the centreline is fitted to satellite imagery (true shape, north-up). The pit lane (about 460 m), pits area, fuel area, pit entry/exit and start/finish line come from the team's mark-ups. Only the absolute GPS position is approximate.
- **Branding:** the company and owner name live in `public/js/brand.js`, and the default logo is `public/assets/mullaloo-logo.png`.

## Mini map (Pit Wall, centre column)

- **Offline vector map, no tiles.** It is drawn from the PLTD itself: `/refpath` gives the track outline (available once the PLTD has recorded its reference lap), `/geozones` the pit and fuel polygons and lines, and `/sf/get` the start/finish.
- **Position.** The car position comes from PLTD `/data` lat/lon at 2 Hz, the same rate the PLTD's own web page polls. If the PLTD position is stale, BTTM GNSS takes over.
- **Car dot.** Coloured by PLTD car state, with a 20 s trail. It turns grey when the position is more than 3 s old.
- **Before the reference lap exists,** the map draws the live trail instead.
- **Positions are live only.** They are not written to the race log, so Replay shows no map.

## Tooltips

Hover a field or KPI tile for about half a second, focus it with the keyboard, or tap its label on a tablet. The tip explains the parameter and what raising or lowering it does. Tip texts are in `public/js/tips.js`.

## Regulations

Profiles live in `rules/` and are chosen in Setup. The profile in force and its version are shown on the Strategy tab.

- **B4B Events** - Standing Regulations, March 2026, plus the 7 h supplementary rules:
  - 5 stops of at least 5 min each.
  - 5 min fuel stop, 80 L per stop.
  - Fuel area open under SC.
- **BEERS** - Standing Regulations V4, 09/02/2025:
  - 8 min fuel stop.
  - No mandatory stop count.
  - No refuelling under Yellow or Red; SC treated as Yellow.
  - Fuel-method crew rules.
  - Raceceiver relay required at all times.
  - 5 drivers minimum for 24 h+.

PDF import is not built. To add a series, copy a JSON profile, edit it and restart.

## How the strategy works

**Fuel model.**
- Burn starts from the car baseline for the track: Collie 18.75 L/h, Wanneroo 17.5 L/h.
- Each lap is classed by its time against the live median green lap (push / green / slow / SC / pit). Stationary pit time burns nothing.
- Each brim fill or visual check is a measured stint. A regression refits the green and SC rates, with the baseline as the prior.
- A stint that differs by more than 10% raises an alert. **Save learned ... to this car** stores the result for next time.

**Planner.**
- Searches stop count, fuel-stop count and fuel-stop placement to minimise total stationary time within:
  - fuel range and the reserve floor
  - the 120 min continuous stint
  - the per-stop fuel cap
  - the mandatory stops
- On BEERS it alternates driver-only stops with fuel stops instead of fuelling at every stop.

**The call.** STAY OUT, WINDOW OPEN, BOX NEXT LAP, BOX THIS LAP, BOX NOW under caution, or STAY OUT when refuelling is closed. It is recomputed every second.

**Windows.**
- Opens: the earliest stop from which filling still reaches the next fuel stop.
- Closes: reserve reached or stint limit.

**Driver time.**
- The outgoing driver's time stops when the car stops, and the incoming driver's starts when it leaves the box.
- A driver who stays in through a non-fuel stop keeps counting continuous time.

**Crew.**
- Presence states: Available, Driving, Resting, Offline, Flag duty, Unavailable, each with a reason.
- Shift plan drafted from the strategy: drivers rest between stints, other crew run alternating groups.
- Rest alert after 7 h on duty, with a 1 h contingency override.
- Prepare alerts for the next driver at 30 and 15 min.
- Refuel crew summoned by name 5 min before a fuel stop.
  - Only members **tagged** with the role and currently **Available** are assigned.
  - Out/in driver rules are applied, and people not involved in the swap are preferred.
  - If nobody qualifies the slot shows UNASSIGNED with the reason, and available untagged crew are listed as suggestions, never assigned silently.

**Tyres.** Life = (min tread - min depth) / (new - min). Wear rate comes from measurements against time on the car during sessions only.

## Files and recovery

```
data/settings.json                      port, engineerHosts, last weekend (auto-resume)
data/cars/*.json                        car library, including learned fuel profiles
data/events/<id>/config.json            weekend as created
data/events/<id>/events.jsonl           every change, append-only - the race log and replay source
data/events/<id>/car_config.json        readable snapshot
data/events/<id>/driver_schedule.json   readable snapshot (roster, rotation, shifts)
data/branding/logo.*                    your logo (upload in Setup)
```

**Log & Replay** gives:
- the weekend file (`.pitwall.json`: setup plus full log)
- a CSV of every event
- Import, which restores a weekend on any machine
- Replay, which re-runs the log through the same engine, so every tab shows what the pit wall saw at that moment.

## Assumptions to confirm before Collie

- The 36 h race is continuous and the clock runs under Red (`clock.stopsOnRed` in the profile).
- Mandatory stops are timed pit entry to exit. Fuel stops are timed on the PLTD fuel zone.
- Lancer tanks are 45 L primary + 30 L secondary, from the Wanneroo campaign. Tick "confirmed" in Setup once checked.
- Pit lane transit is 60 s, and a driver change is 30 s.

## Development

```
npm test        engine checks: pre-race plans + full simulated races on both rulesets
npm run demo    same as make-demo.bat
```

Shared logic lives in `public/js/shared/`. The reducer and engine run identically on the server (alert logging) and in every browser (live view, what-if, replay).
