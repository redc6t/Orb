# Contributing to Pitwall Strategy Manager

Thanks for helping. Pitwall Strategy Manager is built for club and endurance teams, and the most useful contributions come from people who have used it on a real pit wall: bug reports from a race weekend, new series rule profiles, track presets and fixes.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

| You have... | Do this |
|---|---|
| Found a bug | Open a [bug report](https://github.com/redc6t/PWSM_Pit_Wall_Stategy_Manager/issues/new?template=bug_report.yml). Attach the weekend export from **Log** if you can. |
| An idea or a missing feature | Open a [feature request](https://github.com/redc6t/PWSM_Pit_Wall_Stategy_Manager/issues/new?template=feature_request.yml) and describe the race situation it would help with. |
| A rules profile for your series | Open a [rules profile request](https://github.com/redc6t/PWSM_Pit_Wall_Stategy_Manager/issues/new?template=rules_profile.yml), or send the JSON file as a pull request. |
| A security problem | Do **not** open a public issue. See [SECURITY.md](SECURITY.md). |
| An accessibility barrier | Open an issue and see [ACCESSIBILITY.md](ACCESSIBILITY.md). |

## Before you start

For anything larger than a small fix, open an issue first so we can agree on the approach. The app is used live during races, so changes to the strategy engine, the state reducer or the log format are reviewed carefully.

## Development setup

You need [Node.js 18 or newer](https://nodejs.org). There is no build step and the only dependency (`ws`) is already in the repo.

```bash
git clone https://github.com/redc6t/PWSM_Pit_Wall_Stategy_Manager.git
cd PWSM_Pit_Wall_Stategy_Manager
npm run demo
npm start
npm run sim
```

`npm run demo` builds the DEMO weekend, `npm start` runs the server on `http://localhost:8080` and `npm run sim` plays a simulated PLTD lap timer and BTTM temperature monitor, so no hardware is needed.

## Project layout

| Path | What it holds |
|---|---|
| `server.js` | The HTTP and WebSocket server |
| `lib/` | Storage, defaults, track presets and the device adapters (PLTD, BTTM, UDP) |
| `public/js/shared/` | The strategy engine and the state reducer. They run identically on the server and in every browser. |
| `public/js/`, `public/css/` | The browser UI |
| `rules/` | Series regulations, one JSON file per profile |
| `tools/` | Demo builder, simulator and the engine tests |
| `data/` | Runtime data: settings, car library, weekends. Do not commit your own race data. |

## Guidelines

- **Run the tests.** `npm test` runs pre-race plans and full simulated races against every included rule set. It must pass before a pull request is merged.
- **Keep it offline.** The app must run with no internet: no CDNs, no external fonts, no telemetry, no new runtime dependencies unless there is no reasonable alternative.
- **Keep the log compatible.** `events.jsonl` is append-only and must replay in later versions. If you add an event type, older logs must still load.
- **Engine code stays shared.** Anything in `public/js/shared/` must work in both Node.js and the browser without changes.
- **Match the existing style.** Plain JavaScript, no framework, no transpiler. Follow the naming and formatting of the file you are editing.
- **UI follows control-room practice.** Grey by default, colour only for state and alarms, durations always with units (`1h 55m`), clock times as `16:40`.
- **Update the docs.** If you change something a user sees, update the README (and its release notes) and the tooltips in `public/js/tips.js`.
- **Bump the version** in `package.json` and the README badge for user-visible changes.

## Adding a rules profile

1. Copy an existing file in `rules/` and give it a clear name, for example `myseries-2026-01.json`.
2. Set the stint limit, minimum fuel stop time, mandatory stops and flag rules from your series' regulations.
3. Run `npm test`; the tests pick up every profile in the folder.
4. In the pull request, link the regulations document (or name its version and date) so the numbers can be checked.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests where it touches the engine.
3. Run `npm test`.
4. Open the pull request and fill in the template.

## License

Pitwall Strategy Manager is released under the [GNU GPL v3](LICENSE). By submitting a contribution you agree that it is licensed under the same terms.
