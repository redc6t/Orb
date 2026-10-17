# Accessibility

Orb is used by engineers, crew and drivers who are tired, in bright sun or a dark garage, wearing gloves or a helmet, and reading screens from across a garage. We want it to work for as many people as possible, including people with disabilities.

## Our commitment

- Accessibility barriers are treated as bugs, not feature requests.
- New screens and changes are designed for readability first: large type, clear contrast and calm layouts.
- We aim to meet [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level AA where it applies to a local, offline web app. We have **not** done a formal audit, so we do not claim conformance.

## What the app does today

- **Control-room design (ISA-101).** Screens stay grey by default and use colour only for state and alarms, so important changes stand out.
- **Text, not just colour.** The call, car state, alarms and stop steps carry words (for example **BOX IN 3 LAPS**, **UNASSIGNED**, **AUTO**, **VIEW ONLY**) alongside their colour.
- **Readable at a distance.** A 16 px base text size, high-contrast shift bars, and a **Garage display** in very large type for tablets and TVs.
- **Reduced motion.** Pulsing and blinking alarm animations are switched off when the operating system's "reduce motion" setting is on.
- **Keyboard use.** The app works with keyboard and mouse alone; interactive elements show a visible focus outline, and tooltips close with **Escape**.
- **Zoom.** The browser's zoom (Ctrl and plus or minus) works on every tab; narrow windows stack the columns instead of cutting them off.
- **Units on every number.** Durations always carry units (`1h 55m`) and clock times use `16:40`, with a 12-hour option in **Setup**.

## Supported environments

| | |
|---|---|
| Browsers | Current versions of Chrome, Edge, Firefox and Safari (desktop, Android and iPad/iPhone) |
| Server | Windows 10/11, macOS or Linux with Node.js 18 or newer |
| Screen | The Race tab is laid out for 1400 px or wider; other tabs and the Garage display work on tablets and phones |
| Assistive technology | Browser zoom and operating-system high-contrast and reduce-motion settings. Screen readers are not yet tested (see below). |

## Known limitations

- **Screen readers.** Only a few parts of the interface have ARIA labels and roles. Live values (the call, timers, fuel, alarms) are not yet announced reliably, and charts, the track map and the scenario bars have no text alternative.
- **Dark theme only.** There is no light or high-contrast theme yet, which can be hard to read in direct sunlight.
- **Drag interactions.** Moving stops and Safety Cars in **Scenarios** needs a mouse or touch drag; there is no keyboard equivalent yet.
- **Colour-coded charts.** Some charts and temperature readings rely mainly on colour, which can be hard to tell apart with colour vision deficiency.
- **Small labels.** A few labels on the track map and charts use small text.
- **Audio.** The app has no sound alerts; all alerts are visual.

## Reporting a barrier

If something stops you, or someone on your team, from using the app, please tell us:

1. Open an [issue](https://github.com/redc6t/Orb/issues/new?template=bug_report.yml) and put **Accessibility** at the start of the title.
2. Describe what you were trying to do, which screen you were on, and what got in the way.
3. Include your browser, device and any assistive technology you use (screen reader, magnifier, switch, high-contrast mode).

If you would rather not post publicly, contact the maintainer through the [@redc6t GitHub profile](https://github.com/redc6t).

We aim to reply within 7 days. Fixes for barriers that affect use during a race are given priority.
