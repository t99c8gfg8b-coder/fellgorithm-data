# fellgorithm-data

Weekly bus timetables for the Fellgorithm app, built from the Bus Open Data Service (BODS).

- `bus-build/` — the builder (`build.mjs`, `fg-bus-core.js`), which services to pull (`config.json`), the frozen stop list (`places-manifest.json`) and the pre-publish checks (`base-tests.json`).
- `site/` — what is published: `buses.json` (the app fetches this), `buses-meta.json` (version + checksum), `fellgorithm-buses.js` (same data, for bundling into an app release), `report.md`.
- `.github/workflows/buses-weekly.yml` — runs every Monday, publishes only if every check passes; otherwise last week's file stays live and an issue is opened.

Run by hand on a Mac (Node 20+): `node bus-build/build.mjs --zip north_west_gtfs.zip`

Licence: see LICENSE. Code: all rights reserved. Data: contains public sector information (BODS, NaPTAN) licensed under the Open Government Licence v3.0. Not endorsed by the Department for Transport.
Only timetable data and the stop list belong in this repository — never the path network or anything built from OpenStreetMap paths.
