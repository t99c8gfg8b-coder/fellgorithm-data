#!/usr/bin/env node
/* Fellgorithm DAILY bus timetable build (owner, 7 Oct: daily, was weekly).
   BODS North West GTFS → our services only → the FG_BUSES file the app reads → pre-publish checks.
   Usage:
     node bus-build/build.mjs                 download from BODS (env BODS_API_KEY optional), build, check
     node bus-build/build.mjs --zip f.zip     use a GTFS zip you already have
     node bus-build/build.mjs --dir folder    use an unzipped GTFS folder (owner's Mac)
   Options: --prev site/buses.json (last good published file, default)  --hist site/history.json (run log the monitor page reads)  --out out  --today YYYYMMDD
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
const PR = createRequire(import.meta.url)('./problems.js');
const LEDGER = arg('problems', 'site/problems.json'), HOLDS = arg('holds', 'holds.json');
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/* kinds this job owns in the problem ledger (the hourly signals job owns the others) */
const SCOPE = ['build-fail', 'gap', 'conflict', 'stale-feed', 'service-gone', 'new-service', 'base-thin'];
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const M = JSON.parse(fs.readFileSync(path.join(HERE, 'places-manifest.json'), 'utf8'));
const tests = JSON.parse(fs.readFileSync(path.join(HERE, 'base-tests.json'), 'utf8'));
const OUT = arg('out', 'out'), PREV = arg('prev', 'site/buses.json'), HIST = arg('hist', 'site/history.json');
const now = new Date(), iso = now.toISOString().slice(0, 10), today = arg('today', iso.replace(/-/g, ''));
const log = (...a) => console.log('[buses]', ...a);
fs.mkdirSync(OUT, { recursive: true });
/* RUN LOG for Bus Data Monitor.dc.html: every run (pass, fail or error) appends one line to history.json (last 365) and writes status.json. */
function logRun(entry, status) {
  let h = []; try { h = JSON.parse(fs.readFileSync(HIST, 'utf8')); if (!Array.isArray(h)) h = []; } catch {}
  h.push(entry); fs.writeFileSync(path.join(OUT, 'history.json'), JSON.stringify(h.slice(-365)));
  fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify(Object.assign({ entry }, status || {})));
}
/* bus out (06:00–12:00) / buses home (13:00–22:00) at a base on date d; okHome = home buses NOT held for confirmation */
function baseDay(F, b, d) { let out = 0, home = 0, okHome = 0;
  F.services.forEach(s => { const ix = s.places.map((pl, i) => Math.hypot(pl.e - b.e, pl.n - b.n) <= (b.r || 300) ? i : -1).filter(i => i >= 0); if (!ix.length) return;
    s.journeys.forEach(j => { if (!C.runsOn(j, d, F.profiles)) return; const t0 = C.mins(j.start), c = j.calls.filter(c => ix.includes(c.p)); if (!c.length) return;
      const fi = j.calls.indexOf(c[0]), la = j.calls.indexOf(c[c.length - 1]);
      if (fi < j.calls.length - 1) { const t = t0 + c[0].off; if (t >= 360 && t <= 720) out++; }
      if (la > 0) { const t = t0 + c[c.length - 1].off; if (t >= 780 && t <= 1320) { home++; if (!C.inNh(j, d)) okHome++; } } }); });
  return { out, home, okHome }; }

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
  /* CONFIRMATION (owner, 7 Oct): new/changed journeys are held as buses home until the next feed confirms them; versions that disagree
     about whether a day has buses at all hold that service's buses home that day. Writes j.nh; the app's bus-home pickers skip held dates. */
  const P = fs.existsSync(PREV) ? JSON.parse(fs.readFileSync(PREV, 'utf8')) : null;
  const H0 = readJ(HOLDS) || {}, choices = {}, res0 = [];
  (H0.clashChoices || []).forEach(c => { if (c && c.service && /^\d{8}$/.test(c.date || '') && c.use) choices[c.service + '|' + c.date] = String(c.use); });
  const conf = C.confirm(data, P, today, Object.assign({}, cfg.confirm || {}, { choices }));
  /* OWNER CLASH CHOICES (holds.json clashChoices): the owner picked which official version to trust on a clash date.
     use = a version id → every OTHER version's journeys are switched off that date; use = 'none' → the whole service is off that date.
     Remove-only: a choice can only switch buses off, never add a time. */
  const chosenLog = [];
  conf.chosen.forEach(c => { const s = data.services.find(x => x.service === c.service); if (!s) return; let off = 0;
    s.journeys.forEach(j => { if (c.use !== 'none' && j._r === c.use) return; if (!C.runsOn(j, c.date, data.profiles)) return;
      if (j.dated) return; j.off = (j.off || []).concat(c.date).sort(); off++; });
    chosenLog.push(c.service + ' ' + c.date + ': owner chose ' + (c.use === 'none' ? 'no buses' : 'version ' + c.use) + ' (' + off + ' journeys of the other version switched off)'); });
  if (chosenLog.length) res0.push(...chosenLog.map(l => 'OWNER CHOICE: ' + l));
  data.services.forEach(s => s.journeys.forEach(j => delete j._r));
  data.confirm = { tolMin: conf.tol, against: P ? P.version : null, sameFeed: conf.sameFeed };
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
  const res = C.checks(fromJson, P, tests, today);
  res.fails.push(...extra); res.warns.push(...res0);
  if (built.report.newServices.length) res.warns.push('New service(s) in the feed with no places yet, left out: ' + built.report.newServices.map(s => s.service + ' (' + s.trips + ' trips)').join(', '));
  const missing = cfg.services.filter(s => !data.services.some(x => x.service === s) && !built.report.merged[s]);
  Object.entries(cfg.floor || {}).forEach(([n, min]) => { const have = cnt(n); if (have >= min) return;
    if (data.partial.some(p => p.service === n)) res.warns.push('KNOWN GAP: service ' + n + ' has ' + have + ' journeys (usual floor ' + min + ') — published with only the official journeys in the feed; the app tells users some ' + n + ' times are missing' + ((cfg.gapNotes || {})[n] ? ' (' + cfg.gapNotes[n] + ')' : ''));
    else res.fails.push('Service ' + n + ' has only ' + have + ' journeys (gap minimum ' + gapMin(n) + ', floor ' + min + ') — too few to publish; the feed looks broken; check BODS / the operator timetable'); });
  if (P) data.services.forEach(s => { const p = P.services.find(x => x.service === s.service);
    if (p && p.journeys.length >= 20 && s.journeys.length < p.journeys.length * 0.5) res.warns.push('Service ' + s.service + ' dropped from ' + p.journeys.length + ' to ' + s.journeys.length + ' journeys — check against the operator timetable'); });
  if (missing.length) res.warns.push('Not running in this feed (fine out of season): ' + missing.join(', '));
  Object.entries(conf.conflicts).forEach(([n, ds]) => res.warns.push('VERSIONS DISAGREE: service ' + n + ' — one timetable version says no buses, another says buses on ' + ds.length + ' day(s) (' + ds.slice(0, 6).join(', ') + (ds.length > 6 ? '…' : '') + ') — no ' + n + ' buses home those days; check with the operator'));
  let ok = res.fails.length === 0;

  /* 4 REPORT — plain English, for the owner (attached to every run; opened as an issue on failure). */
  const um = Object.entries(built.report.unmatchedStops), umN = {}; um.forEach(([k]) => { const s = k.split('|')[0]; umN[s] = (umN[s] || 0) + 1; });
  const md = [
    '# Bus timetable build ' + iso + ' — ' + (ok ? 'PASSED ✓ (ready to publish)' : 'FAILED ✗ (last week\'s file kept live)'),
    '', 'BODS feed ' + (feed.feed_version || '?') + ' (' + (feed.feed_start_date || '?') + ' → ' + (feed.feed_end_date || '?') + ') · ' + data.services.length + ' services · ' + journeys + ' journeys' + (P ? ' (last good: ' + P.generated + ', ' + res.stats.prevJourneys + ' journeys)' : ' (no previous file)'),
    'Timetable runs to ' + res.stats.lastDate + ' · ' + res.stats.stopsChecked + ' route stops checked · checksum ' + sha.slice(0, 12),
    '', '## Failures', ...(res.fails.length ? res.fails.map(f => '- ' + f) : ['- none']),
    '', '## Warnings', ...(res.warns.length ? res.warns.map(f => '- ' + f) : ['- none']),
    '', '## Changes since the last published build', ...C.diff(fromJson, P).map(l => '- ' + l),
    '', '## Buses home waiting for confirmation' + (conf.sameFeed ? ' (same BODS feed as the last published build — nothing new is confirmed today)' : ''),
    '- New or changed journeys are used as buses OUT straight away, but as buses HOME only once the next BODS feed shows them again (times within ±' + conf.tol + ' min count as the same bus).',
    ...(Object.keys(conf.held).length ? Object.entries(conf.held).map(([n, c]) => '- ' + n + ': ' + c + ' journeys held on some dates (' + conf.heldNew[n] + ' wholly new or changed)') : ['- none']),
    '', '## Days a service gained or lost ALL its buses (next 60 days, vs the last published build)',
    ...(conf.flips.length ? conf.flips.slice(0, 25).map(f => '- ' + f.service + ' ' + f.date + ': ' + f.was + ' → ' + f.now + (f.now ? ' (held as buses home until confirmed)' : ' (removed at once)')) : ['- none']), ...(conf.flips.length > 25 ? ['- … ' + (conf.flips.length - 25) + ' more'] : []),
    '', '## Per service', '- ' + res.stats.services,
    ...(Object.keys(built.report.merged).length ? ['', '## Renumbered buses built onto another service', ...Object.entries(built.report.merged).map(([n, m]) => '- ' + n + ' → built as ' + m.into + ': ' + m.kept + ' of ' + m.trips + ' trips kept (rest call at fewer than two ' + m.into + ' stops). Runs: ' + Object.entries(m.ends).sort((a, b) => b[1] - a[1]).map(([e, c]) => e + ' ×' + c).join('; '))] : []),
    '', '## Trips per service (in feed → kept; dropped: too few app stops / no running dates)', ...Object.entries(built.report.drop).map(([n, d]) => '- ' + n + ': ' + d.trips + ' → ' + d.kept + ' (dropped ' + d.places + ' / ' + d.dates + ')'),
    '', '## Routes in the feed with our numbers', ...routeDiag.map(r => '- ' + r.n + ' · ' + r.noc + ' ' + r.ag + ' · ' + r.trips + ' trips · ' + (r.ours ? 'TAKEN' : 'skipped (other operator)') + (r.long ? ' · ' + r.long : '')),
    '', '## Other Stagecoach routes naming a Lakes town (not pulled)', ...(otherSCCU.length ? otherSCCU : ['- none']),
    '', '## Build notes', '- Trips without two known places (dropped): ' + built.report.droppedTrips + ' · duplicates merged: ' + built.report.dupes,
    '- Stops on our buses that are not app places (ignored, normal): ' + Object.entries(umN).map(([s, n]) => s + ' ' + n).join(', '),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), md + '\n');
  fs.writeFileSync(path.join(OUT, 'gaps.md'), data.partial.length ? '# Known timetable gap(s) — published with the official journeys only\n\n' + data.partial.map(p => '- ' + p.service + ': ' + p.journeys + ' journeys (usual floor ' + p.floor + ')' + (p.note ? ' — ' + p.note : '')).join('\n') + '\n\nThis issue closes itself the first day every service is back to normal. Full report: report.md in the run artifacts.\n' : '');
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok, version: data.version, fails: res.fails, warns: res.warns }, null, 1));
  const per = {}; data.services.forEach(s => per[s.service] = s.journeys.length);
  const bases = tests.bases.map(b => ({ name: b.name, d: [0, 1].map(i => baseDay(data, b, C.addDays(today, i))) }));
  logRun({ at: now.toISOString(), feed: feed.feed_version || null, ok, published: ok ? data.version : null, live: ok ? data.version : (P ? P.version : null), journeys, services: per,
    held: conf.held, heldNew: conf.heldNew, conflicts: Object.fromEntries(Object.entries(conf.conflicts).map(([n, d]) => [n, d.length])), flips: conf.flips.length,
    gaps: data.partial.map(p => p.service), fails: res.fails.slice(0, 5), warns: res.warns.length, sameFeed: conf.sameFeed },
    { today, bases, heldList: conf.heldList, conflicts: conf.conflicts, conflictDetail: conf.conflictDetail, flips: conf.flips.slice(0, 60), partial: data.partial, warns: res.warns, fails: res.fails, tolMin: conf.tol });

  /* 5 PROBLEMS — what this run sees now; the ledger opens new ones and closes the ones that have gone, saying how. */
  const at = now.toISOString(), hist = readJ(HIST) || [], cur = [];
  if (!ok) cur.push({ id: 'build-fail', kind: 'build-fail', sev: 'high', source: 'timetable build', title: 'Timetable build failed — the last good timetable stays live',
    detail: res.fails.slice(0, 6).join(' · '), effect: 'keeps planning on the last good timetable (' + (P ? P.version : 'bundled') + ')' });
  data.partial.forEach(p => cur.push({ id: 'gap:' + p.service, kind: 'gap', sev: 'high', source: 'BODS timetable', service: p.service, title: 'Service ' + p.service + ' is thin in the BODS feed (' + p.journeys + ' journeys, usually at least ' + p.floor + ')',
    detail: p.note || 'Part of the operator timetable is missing from BODS.', effect: 'uses only the ' + p.journeys + ' official ' + p.service + ' journeys; routes needing the missing buses are not offered' }));
  Object.entries(conf.conflicts).forEach(([n, ds]) => cur.push({ id: 'conflict:' + n, kind: 'conflict', sev: 'med', source: 'BODS timetable', service: n,
    title: 'Two ' + n + ' timetable versions disagree on ' + ds.length + ' day(s)', detail: 'One version says no buses, another says buses: ' + ds.slice(0, 6).join(', ') + (ds.length > 6 ? '…' : ''),
    effect: 'no ' + n + ' buses home on those days', data: { dates: ds } }));
  const sameSince = (() => { let t = at; for (let i = hist.length - 1; i >= 0; i--) { if (hist[i].feed !== feed.feed_version) break; t = hist[i].at; } return t; })();
  if (feed.feed_version && (Date.parse(at) - Date.parse(sameSince)) > 3 * 864e5) cur.push({ id: 'stale-feed', kind: 'stale-feed', sev: 'med', source: 'BODS timetable',
    title: 'BODS has not published a new feed since ' + sameSince.slice(0, 10), detail: 'Feed ' + feed.feed_version + ' every day since then.', effect: 'nothing new can be confirmed as a bus home until BODS updates' });
  if (P) P.services.forEach(ps => { if (!data.services.some(s => s.service === ps.service)) cur.push({ id: 'service-gone:' + ps.service, kind: 'service-gone', sev: 'high', source: 'BODS timetable', service: ps.service,
    title: 'Service ' + ps.service + ' has gone from the feed (had ' + ps.journeys.length + ' journeys)', detail: 'Fine if it is a seasonal service that has ended; otherwise check BODS.', effect: 'no ' + ps.service + ' buses' }); });
  built.report.newServices.forEach(s => cur.push({ id: 'new-service:' + s.service, kind: 'new-service', sev: 'low', source: 'BODS timetable', service: s.service,
    title: 'New service ' + s.service + ' in the feed (' + s.trips + ' trips) — not used', detail: 'Add its places to places-manifest.json to use it.', effect: 'ignored' }));
  bases.forEach(b => { if (!(tests.mustPass || []).includes(b.name)) return; const a = b.d[0];
    if (a.okHome < 2) cur.push({ id: 'base-thin:' + b.name, kind: 'base-thin', sev: 'med', source: 'timetable build', title: b.name + ': only ' + a.okHome + ' confirmed bus(es) home today (' + a.home + ' in the timetable)',
      detail: 'Buses home 13:00–22:00 that the app may use.', effect: 'few or no bus-home routes from ' + b.name + ' today' }); });
  const cnt2 = n => data.services.filter(x => x.service === n || x.on === n).reduce((a, s) => a + s.journeys.length, 0);
  const how = p => p.kind === 'gap' ? 'Service ' + p.service + ' back to ' + cnt2(p.service) + ' journeys in BODS feed ' + feed.feed_version + ' — the operator timetable is complete again'
    : p.kind === 'build-fail' ? 'Build passed every check on ' + iso + ' and was published'
    : p.kind === 'conflict' ? 'The ' + p.service + ' timetable versions agree again in feed ' + feed.feed_version + ' (the clashing version was withdrawn or corrected)'
    : p.kind === 'stale-feed' ? 'BODS published a new feed: ' + feed.feed_version
    : p.kind === 'service-gone' ? 'Service ' + p.service + ' is back in the feed (' + cnt2(p.service) + ' journeys)'
    : p.kind === 'base-thin' ? 'Confirmed buses home are back' : null;
  const L = PR.reconcile(readJ(LEDGER), SCOPE, cur, at, how);
  fs.writeFileSync(path.join(OUT, 'problems.json'), JSON.stringify(L.ledger));
  fs.writeFileSync(path.join(OUT, 'summary.md'), PR.summary(L.ledger, at, '# Bus data ' + iso + ' — ' + (ok ? 'timetable published ✓' : 'timetable build FAILED ✗ (last good file kept live)') + '\n\nBODS feed ' + (feed.feed_version || '?') + ' · ' + journeys + ' journeys · held as buses home: ' + Object.values(conf.held).reduce((a, b) => a + b, 0) + ' · full report in the run artifacts'));
  /* 6 DAILY AUDIT (owner, 7 Oct): a frozen record of how the data stood today — what the app was told, which switches were on,
     every open problem, the rules in force. Hash-chained (each day names the previous day's hash) and committed to git, so a
     changed or missing day shows. Never contains anything about users. site/audit/YYYY-MM-DD.json + latest.json. */
  try {
    const SITE = path.dirname(PREV), h256 = s => crypto.createHash('sha256').update(s).digest('hex'), fileH = f => fs.existsSync(f) ? h256(fs.readFileSync(f)) : null;
    const A = readJ(path.join(SITE, 'alerts.json')) || {}, prevAud = readJ(path.join(SITE, 'audit', 'latest.json')), rules = readJ(path.join(HERE, '..', 'app-rules.json'));
    const day = d => (A.weather && A.weather.days && A.weather.days[d]) || null, tm = C.addDays(today, 1);
    const audit = { schema: 1, date: iso, at, prev: prevAud ? prevAud.hash : null,
      timetable: { published: ok, live: ok ? data.version : (P ? P.version : null), sha256: ok ? sha : (readJ(path.join(SITE, 'buses-meta.json')) || {}).sha256 || null, feed: feed.feed_version || null, journeys, services: per, held: conf.held, conflicts: conf.conflicts, gaps: data.partial },
      bases: bases.map(b => ({ name: b.name, today: b.d[0], tomorrow: b.d[1] })),
      switches: { notice: A.notice || { on: false }, holds: A.holds || [], clashChoices: (H0.clashChoices || []), autoHolds: A.autoHolds || [] },
      conditions: { alertsAt: A.generated || null, weather: { today: day(today), tomorrow: day(tm), highM: A.weather ? A.weather.highM : null, stale: !!(A.weather && A.weather.stale) },
        disruptions: (A.disruptions || []).map(d => ({ id: d.id, services: d.services, summary: d.summary, from: d.from, to: d.to })), floods: (A.floods || []).map(f => ({ area: f.area, level: f.level })),
        closures: (A.works || []).filter(w => w.closure).map(w => ({ ref: w.ref, street: w.street, area: w.area, from: w.from, to: w.to })), bankHolidays: (A.bankHolidays || []).slice(0, 3) },
      problemsOpen: L.ledger.items.filter(p => p.status === 'open').map(p => ({ id: p.id, sev: p.sev, title: p.title, effect: p.effect, first: p.first })),
      problemsResolvedToday: L.resolved.map(p => ({ id: p.id, title: p.title, how: p.how })),
      sources: (readJ(path.join(SITE, 'signals-status.json')) || {}).sources || {},
      appRules: rules, routes: readJ(path.join(SITE, 'audit', 'routes-' + iso + '.json')) || { note: 'Route counts come from the Mac control panel run (private pools) — not run today' },
      inputs: { config: fileH(path.join(HERE, 'config.json')), holds: fileH(HOLDS), tests: fileH(path.join(HERE, 'base-tests.json')), appRules: fileH(path.join(HERE, '..', 'app-rules.json')) } };
    audit.hash = h256(JSON.stringify(Object.assign({}, audit, { hash: undefined })));
    fs.mkdirSync(path.join(OUT, 'audit'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'audit', iso + '.json'), JSON.stringify(audit, null, 1));
    fs.writeFileSync(path.join(OUT, 'audit', 'latest.json'), JSON.stringify({ date: iso, hash: audit.hash }));
    const W = audit.conditions.weather.today;
    fs.appendFileSync(path.join(OUT, 'summary.md'), ['', '## Daily audit ' + iso, '- Timetable: ' + (ok ? 'published ' : 'NOT published, live = ') + audit.timetable.live + ' · ' + journeys + ' journeys · ' + Object.values(conf.held).reduce((a, b) => a + b, 0) + ' held as buses home',
      '- Your switches: banner ' + (audit.switches.notice.on ? 'ON' : 'off') + ' · ' + audit.switches.holds.length + ' holds · ' + audit.switches.autoHolds.length + ' automatic (closures)',
      '- Today: ' + (W ? (W.highOff ? 'high fells + scrambles OFF (' + W.highReasons.join(', ') + ')' : W.scrambleOff ? 'scrambles OFF (gusts ' + W.gustMph + ' mph)' : 'no weather removals') : 'no weather data') + ' · ' + audit.conditions.closures.length + ' road closures · ' + audit.conditions.disruptions.length + ' bus disruptions · ' + audit.conditions.floods.length + ' flood warnings',
      '- Bases (confirmed buses home today): ' + audit.bases.map(b => b.name + ' ' + b.today.okHome).join(', '),
      '- App rules: ' + (rules ? 'version ' + rules.version + ' (' + rules.appBuild + ')' : 'app-rules.json missing'),
      '- Audit file: site/audit/' + iso + '.json · hash ' + audit.hash.slice(0, 16) + '… · previous ' + (audit.prev ? audit.prev.slice(0, 16) + '…' : 'none (first day)'), ''].join('\n'));
  } catch (e) { fs.appendFileSync(path.join(OUT, 'summary.md'), '\n## Daily audit FAILED: ' + e.message + '\n'); }
  console.log('\n' + md + '\n');
  if (src.zip && !arg('zip')) fs.rmSync(src.zip, { force: true });
  process.exit(ok ? 0 : 2);
}
main().catch(e => { console.error('[buses] BUILD ERROR:', e.message);
  fs.writeFileSync(path.join(OUT, 'report.md'), '# Bus timetable build ' + iso + ' — ERROR ✗ (last week\'s file kept live)\n\n' + e.message + '\n');
  fs.writeFileSync(path.join(OUT, 'gaps.md'), '');
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: false, error: e.message }));
  try { logRun({ at: now.toISOString(), ok: false, error: e.message }); } catch {}
  try { const L = PR.reconcile(readJ(LEDGER), ['build-fail'], [{ id: 'build-fail', kind: 'build-fail', sev: 'high', source: 'timetable build', title: 'Timetable build errored — the last good timetable stays live', detail: e.message, effect: 'keeps planning on the last good timetable' }], now.toISOString());
    fs.writeFileSync(path.join(OUT, 'problems.json'), JSON.stringify(L.ledger)); fs.writeFileSync(path.join(OUT, 'summary.md'), PR.summary(L.ledger, now.toISOString(), '# Bus data ' + iso + ' — build ERROR ✗\n\n' + e.message)); } catch {}
  process.exit(1); });
