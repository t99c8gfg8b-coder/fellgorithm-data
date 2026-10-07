#!/usr/bin/env node
/* Fellgorithm weekly bus timetable build.
   BODS North West GTFS → our services only → the FG_BUSES file the app reads → pre-publish checks.
   Usage:
     node bus-build/build.mjs                 download from BODS (env BODS_API_KEY optional), build, check
     node bus-build/build.mjs --zip f.zip     use a GTFS zip you already have
     node bus-build/build.mjs --dir folder    use an unzipped GTFS folder (owner's Mac)
   Options: --prev site/buses.json (last good published file, default)  --out out  --today YYYYMMDD
   Exit codes: 0 = checks passed, ready to publish · 2 = checks FAILED, keep last week's file · 1 = build error.
   Source: Bus Open Data Service (Open Government Licence v3.0). Only timetable data is written — nothing else ships. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = createRequire(import.meta.url)('./fg-bus-core.js');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const M = JSON.parse(fs.readFileSync(path.join(HERE, 'places-manifest.json'), 'utf8'));
const tests = JSON.parse(fs.readFileSync(path.join(HERE, 'base-tests.json'), 'utf8'));
const OUT = arg('out', 'out'), PREV = arg('prev', 'site/buses.json');
const now = new Date(), iso = now.toISOString().slice(0, 10), today = arg('today', iso.replace(/-/g, ''));
const log = (...a) => console.log('[buses]', ...a);
fs.mkdirSync(OUT, { recursive: true });

/* 1 GET THE FEED — download to a temp file, retry, verify the zip before reading anything. */
async function download(to) {
  let url = cfg.gtfsUrl; if (process.env.BODS_API_KEY) url += (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(process.env.BODS_API_KEY);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log('download attempt', attempt);
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const tmp = to + '.part'; const ws = fs.createWriteStream(tmp);
      for await (const chunk of r.body) ws.write(chunk);
      await new Promise(res => ws.end(res));
      const len = +r.headers.get('content-length') || 0, size = fs.statSync(tmp).size;
      if (len && size !== len) throw new Error('truncated: ' + size + ' of ' + len + ' bytes');
      if (size < 5e6) throw new Error('feed only ' + size + ' bytes — too small for the North West region');
      execFileSync('unzip', ['-tqq', tmp]);                       /* CRC check of every file in the zip */
      fs.renameSync(tmp, to); return;
    } catch (e) { log('  failed:', e.message); if (attempt === 3) throw new Error('BODS download failed 3 times: ' + e.message); await new Promise(r => setTimeout(r, 30000 * attempt)); }
  }
}
function readTable(src, name) {
  if (src.dir) { const f = path.join(src.dir, name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; }
  try { return execFileSync('unzip', ['-p', src.zip, name], { maxBuffer: 1 << 30 }).toString('utf8'); } catch { return ''; }
}
/* stop_times.txt is the big one — stream it and keep only our trips. */
async function readStopTimes(src, ids) {
  const input = src.dir ? fs.createReadStream(path.join(src.dir, 'stop_times.txt')) : spawn('unzip', ['-p', src.zip, 'stop_times.txt']).stdout;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let head = null, ti = 0, rows = [], seen = 0;
  for await (let line of rl) {
    if (!head) { head = C.parseLine(line.replace(/^\uFEFF/, '')).map(s => s.trim()); ti = head.indexOf('trip_id'); continue; }
    seen++;
    const tid = ti === 0 ? line.slice(0, line.indexOf(',')).replace(/"/g, '') : C.parseLine(line)[ti];
    if (!ids.has(tid)) continue;
    const r = C.parseLine(line), o = {}; head.forEach((k, j) => o[k] = r[j]); rows.push(o);
  }
  return { rows, seen };
}

async function main() {
  let src;
  if (arg('dir')) src = { dir: arg('dir') };
  else if (arg('zip')) { src = { zip: arg('zip') }; execFileSync('unzip', ['-tqq', src.zip]); }
  else { const z = path.join(OUT, 'gtfs.zip'); await download(z); src = { zip: z }; }

  const T = {}; for (const t of ['agency', 'routes', 'trips', 'calendar', 'calendar_dates', 'stops', 'feed_info']) T[t] = C.parseCSV(readTable(src, t + '.txt'));
  if (!T.trips.length || !T.routes.length) throw new Error('feed has no trips/routes table');
  const feed = T.feed_info[0] || {};
  /* Diagnostics: every route in the feed carrying one of our numbers, who runs it, how many trips, and whether we took it. */
  const agOf = {}; T.agency.forEach(a => agOf[a.agency_id] = a); const tpr = {}; T.trips.forEach(t => tpr[t.route_id] = (tpr[t.route_id] || 0) + 1);
  const want = new Set([...cfg.services, ...Object.keys(cfg.merge || {})]), oursR = new Set(C.ourRoutes(T, cfg).map(r => r.route_id));
  const routeDiag = T.routes.filter(r => want.has(r.route_short_name)).map(r => ({ n: r.route_short_name, long: r.route_long_name || '', noc: (agOf[r.agency_id] || {}).agency_noc || '?', ag: (agOf[r.agency_id] || {}).agency_name || '?', trips: tpr[r.route_id] || 0, ours: oursR.has(r.route_id) }))
    .sort((x, y) => cfg.services.indexOf(x.n) - cfg.services.indexOf(y.n) || y.trips - x.trips);
  const lakes = /keswick|kendal|ambleside|grasmere|windermere|bowness|penrith|lancaster/i;
  const otherSCCU = T.routes.filter(r => !want.has(r.route_short_name) && (cfg.nocs || []).includes((agOf[r.agency_id] || {}).agency_noc) && (lakes.test(r.route_long_name || '') || /555/.test(r.route_short_name)))
    .map(r => '- ' + r.route_short_name + ' · ' + (tpr[r.route_id] || 0) + ' trips · ' + (r.route_long_name || '')).sort();
  const ids = C.ourTripIds(T, cfg);
  if (!ids.size) throw new Error('none of our services found in the feed (wrong region or operator code changed?)');
  T.trips = T.trips.filter(t => ids.has(t.trip_id));
  const st = await readStopTimes(src, ids); T.stop_times = st.rows;
  log('feed', feed.feed_version, '·', st.seen, 'stop times read,', st.rows.length, 'ours ·', ids.size, 'trips');

  const built = C.build(T, M, cfg);
  const data = C.finalize(built.data, { generated: iso, feedVersion: feed.feed_version, feed: { version: feed.feed_version || null, start: feed.feed_start_date || null, end: feed.feed_end_date || null },
    notes: 'Built ' + iso + ' by the weekly job from BODS feed ' + (feed.feed_version || '?') + '. Stops are the frozen place list (places-manifest.json); journeys call only at those places.' });

  /* KNOWN GAPS — ANY SERVICE (owner, 7 Oct): a service below its floor (half its reference size) is a GAP, not a failure, as long as
     it still has at least its gap minimum (15% of reference, cfg.gapMin) — the official journeys that ARE in the feed are published,
     flagged in the file (data.partial) so the app names the gap, and an issue tells the owner. Below the gap minimum (or gone) = FAIL.
     Clears itself the first week the service is back above its floor. Never expires. */
  /* a merged route on the same stops (e.g. 755 on the 555 stops, s.on) counts towards its host: it is the buses on that road */
  const cnt = n => data.services.filter(x => x.service === n || x.on === n).reduce((a, s) => a + s.journeys.length, 0);
  const gapMin = n => ((cfg.gapMin || {})[n] != null ? cfg.gapMin[n] : Math.max(1, Math.round(((cfg.floor || {})[n] || 0) * 0.3)));
  data.partial = Object.keys(cfg.floor || {}).filter(n => cnt(n) < cfg.floor[n] && cnt(n) >= gapMin(n) && cnt(n) > 0)
    .map(n => ({ service: n, journeys: cnt(n), floor: cfg.floor[n], note: ((cfg.gapNotes || {})[n]) || '' }));
  /* 2 WRITE — JSON (what the app fetches), JS (bundled fallback, same object), meta (version + checksum the app verifies). */
  const json = JSON.stringify(data);
  const js = '/* Real Cumbria timetables, compiled from the Bus Open Data Service GTFS feed\n   (Open Government Licence v3.0). Built ' + iso + ' by the weekly job. */\nwindow.FG_BUSES = ' + json + ';\n';
  const sha = crypto.createHash('sha256').update(json).digest('hex');
  const journeys = data.services.reduce((a, s) => a + s.journeys.length, 0);
  const meta = { schema: data.schema, version: data.version, generated: data.generated, bytes: Buffer.byteLength(json), sha256: sha, services: data.services.length, journeys, feed: data.feed };
  fs.writeFileSync(path.join(OUT, 'buses.json'), json);
  fs.writeFileSync(path.join(OUT, 'fellgorithm-buses.js'), js);
  fs.writeFileSync(path.join(OUT, 'buses-meta.json'), JSON.stringify(meta, null, 1));

  /* 3 CHECK — re-read what was WRITTEN (proves the files parse), then the pre-publish checks against last week. */
  const fromJson = JSON.parse(fs.readFileSync(path.join(OUT, 'buses.json'), 'utf8'));
  const box = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(OUT, 'fellgorithm-buses.js'), 'utf8'), box);
  const extra = [];
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, 'buses.json'))).digest('hex') !== sha) extra.push('Checksum of the written file does not match');
  if (JSON.stringify(box.window.FG_BUSES) !== JSON.stringify(fromJson)) extra.push('The .js and .json files disagree');
  const P = fs.existsSync(PREV) ? JSON.parse(fs.readFileSync(PREV, 'utf8')) : null;
  const res = C.checks(fromJson, P, tests, today);
  res.fails.push(...extra);
  if (built.report.newServices.length) res.warns.push('New service(s) in the feed with no places yet, left out: ' + built.report.newServices.map(s => s.service + ' (' + s.trips + ' trips)').join(', '));
  const missing = cfg.services.filter(s => !data.services.some(x => x.service === s) && !built.report.merged[s]);
  Object.entries(cfg.floor || {}).forEach(([n, min]) => { const have = cnt(n); if (have >= min) return;
    if (data.partial.some(p => p.service === n)) res.warns.push('KNOWN GAP: service ' + n + ' has ' + have + ' journeys (usual floor ' + min + ') — published with only the official journeys in the feed; the app tells users some ' + n + ' times are missing' + ((cfg.gapNotes || {})[n] ? ' (' + cfg.gapNotes[n] + ')' : ''));
    else res.fails.push('Service ' + n + ' has only ' + have + ' journeys (gap minimum ' + gapMin(n) + ', floor ' + min + ') — too few to publish; the feed looks broken; check BODS / the operator timetable'); });
  if (P) data.services.forEach(s => { const p = P.services.find(x => x.service === s.service);
    if (p && p.journeys.length >= 20 && s.journeys.length < p.journeys.length * 0.5) res.warns.push('Service ' + s.service + ' dropped from ' + p.journeys.length + ' to ' + s.journeys.length + ' journeys — check against the operator timetable'); });
  if (missing.length) res.warns.push('Not running in this feed (fine out of season): ' + missing.join(', '));
  let ok = res.fails.length === 0;

  /* 4 REPORT — plain English, for the owner (attached to every run; opened as an issue on failure). */
  const um = Object.entries(built.report.unmatchedStops), umN = {}; um.forEach(([k]) => { const s = k.split('|')[0]; umN[s] = (umN[s] || 0) + 1; });
  const md = [
    '# Bus timetable build ' + iso + ' — ' + (ok ? 'PASSED ✓ (ready to publish)' : 'FAILED ✗ (last week\'s file kept live)'),
    '', 'BODS feed ' + (feed.feed_version || '?') + ' (' + (feed.feed_start_date || '?') + ' → ' + (feed.feed_end_date || '?') + ') · ' + data.services.length + ' services · ' + journeys + ' journeys' + (P ? ' (last good: ' + P.generated + ', ' + res.stats.prevJourneys + ' journeys)' : ' (no previous file)'),
    'Timetable runs to ' + res.stats.lastDate + ' · ' + res.stats.stopsChecked + ' route stops checked · checksum ' + sha.slice(0, 12),
    '', '## Failures', ...(res.fails.length ? res.fails.map(f => '- ' + f) : ['- none']),
    '', '## Warnings', ...(res.warns.length ? res.warns.map(f => '- ' + f) : ['- none']),
    '', '## Changes since last week', ...C.diff(fromJson, P).map(l => '- ' + l),
    '', '## Per service', '- ' + res.stats.services,
    ...(Object.keys(built.report.merged).length ? ['', '## Renumbered buses built onto another service', ...Object.entries(built.report.merged).map(([n, m]) => '- ' + n + ' → built as ' + m.into + ': ' + m.kept + ' of ' + m.trips + ' trips kept (rest call at fewer than two ' + m.into + ' stops). Runs: ' + Object.entries(m.ends).sort((a, b) => b[1] - a[1]).map(([e, c]) => e + ' ×' + c).join('; '))] : []),
    '', '## Trips per service (in feed → kept; dropped: too few app stops / no running dates)', ...Object.entries(built.report.drop).map(([n, d]) => '- ' + n + ': ' + d.trips + ' → ' + d.kept + ' (dropped ' + d.places + ' / ' + d.dates + ')'),
    '', '## Routes in the feed with our numbers', ...routeDiag.map(r => '- ' + r.n + ' · ' + r.noc + ' ' + r.ag + ' · ' + r.trips + ' trips · ' + (r.ours ? 'TAKEN' : 'skipped (other operator)') + (r.long ? ' · ' + r.long : '')),
    '', '## Other Stagecoach routes naming a Lakes town (not pulled)', ...(otherSCCU.length ? otherSCCU : ['- none']),
    '', '## Build notes', '- Trips without two known places (dropped): ' + built.report.droppedTrips + ' · duplicates merged: ' + built.report.dupes,
    '- Stops on our buses that are not app places (ignored, normal): ' + Object.entries(umN).map(([s, n]) => s + ' ' + n).join(', '),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), md + '\n');
  fs.writeFileSync(path.join(OUT, 'gaps.md'), data.partial.length ? '# Known timetable gap(s) — published with the official journeys only\n\n' + data.partial.map(p => '- ' + p.service + ': ' + p.journeys + ' journeys (usual floor ' + p.floor + ')' + (p.note ? ' — ' + p.note : '')).join('\n') + '\n\nThis issue closes itself the first week every service is back to normal. Full report: report.md in the run artifacts.\n' : '');
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok, version: data.version, fails: res.fails, warns: res.warns }, null, 1));
  console.log('\n' + md + '\n');
  if (src.zip && !arg('zip')) fs.rmSync(src.zip, { force: true });
  process.exit(ok ? 0 : 2);
}
main().catch(e => { console.error('[buses] BUILD ERROR:', e.message);
  fs.writeFileSync(path.join(OUT, 'report.md'), '# Bus timetable build ' + iso + ' — ERROR ✗ (last week\'s file kept live)\n\n' + e.message + '\n');
  fs.writeFileSync(path.join(OUT, 'gaps.md'), data.partial.length ? '# Known timetable gap(s) — published with the official journeys only\n\n' + data.partial.map(p => '- ' + p.service + ': ' + p.journeys + ' journeys (usual floor ' + p.floor + ')' + (p.note ? ' — ' + p.note : '')).join('\n') + '\n\nThis issue closes itself the first week every service is back to normal. Full report: report.md in the run artifacts.\n' : '');
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: false, error: e.message }));
  process.exit(1); });
