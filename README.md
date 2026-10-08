# fellgorithm-data

Daily bus timetables for the Fellgorithm app, built from the Bus Open Data Service (BODS).

- `bus-build/` — the builder (`build.mjs`, `fg-bus-core.js`), which services to pull (`config.json`), the frozen stop list (`places-manifest.json`) and the pre-publish checks (`base-tests.json`).
- `site/` — what is published: `buses.json` (the app fetches this), `buses-meta.json` (version + checksum), `fellgorithm-buses.js` (same data, for bundling into an app release), `report.md`, plus `history.json` / `status.json` (the run log — updated every run, pass or fail).
- `holds.json` — YOUR switches (remove-only): hide a service / buses home / a stop / a car park / a road, pick a version when two clash, and the urgent banner text. Commit a change and it is live within minutes.
- `bus-build/signals.mjs` + `.github/workflows/signals-hourly.yml` — hourly: BODS disruptions, Environment Agency flood warnings, gov.uk bank holidays, National Highways (once set up) → `site/alerts.json`; every problem found goes in `site/problems.json` (open → resolved, with how).
- `.github/workflows/buses-weekly.yml` — runs every day at 04:30 UTC, publishes the timetable only if every check passes; otherwise the last good file stays live and one failure issue is kept up to date. New or changed journeys are held as buses home (`nh`) until a later BODS feed confirms them.

Run by hand on a Mac (Node 20+): `node bus-build/build.mjs --zip north_west_gtfs.zip`

Licence: see LICENSE. Code: all rights reserved. Data: contains public sector information (BODS, NaPTAN, Environment Agency flood data, gov.uk bank holidays; National Highways once added) licensed under the Open Government Licence v3.0. Not endorsed by the Department for Transport.
Only timetable data and the stop list belong in this repository — never the path network or anything built from OpenStreetMap paths.

## Street Manager set-up (council roads — Kirkstone, Honister, Whinlatter…)
Street Manager only pushes events to a web address you host, so a small free Cloudflare Worker catches them (street-manager-worker/worker.js).
1. Free Cloudflare account → Workers & Pages → Create Worker (name e.g. fellgorithm-roadworks) → paste worker.js → Deploy.
2. Storage → KV → Create namespace (e.g. ROADWORKS). Worker → Settings → Bindings → add KV namespace, variable name **WORKS**.
3. Note the Worker address (https://fellgorithm-roadworks.<you>.workers.dev). Sign up at the Street Manager open data onboarding page and give it <address>/sns for the permit, activity and section 58 topics.
4. Put the address in bus-build/config.json → signals.streetManager.url and commit. The hourly job then reads <address>/works.json.
