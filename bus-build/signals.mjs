#!/usr/bin/env node
/* Fellgorithm HOURLY signals job (owner, 7 Oct). Small and quick — the heavy timetable build stays daily at 05:30.
   Reads: holds.json (owner switches + urgent notice), site/buses.json (published timetable), site/problems.json + site/alerts.json (last run).
   Fetches: BODS disruptions (SIRI-SX, OGL), Environment Agency flood warnings (OGL), gov.uk bank holidays (OGL),
            National Highways incidents/closures (only once its key + address are set up).
   Writes:  out/alerts.json (what the app reads), out/problems.json (ledger), out/signals-status.json (source health for the monitor).
   Never fails the run because a source is down — a down source becomes a problem and its last good items are kept, marked stale. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)), req = createRequire(import.meta.url);
const C = req('./fg-bus-core.js'), PR = req('./problems.js');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SITE = arg('site', 'site'), OUT = arg('out', 'out'), HOLDS = arg('holds', 'holds.json');
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')), S = cfg.signals || {};
const M = JSON.parse(fs.readFileSync(path.join(HERE, 'places-manifest.json'), 'utf8'));
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const now = new Date(), at = now.toISOString(), today = at.slice(0, 10).replace(/-/g, '');
const ymd = s => (s || '').slice(0, 10).replace(/-/g, '');
fs.mkdirSync(OUT, { recursive: true });
const prevA = readJ(path.join(SITE, 'alerts.json')) || {}, B = readJ(path.join(SITE, 'buses.json'));
const SCOPE = ['disruption', 'flood', 'road', 'weather', 'source-retiring', 'source-dead', 'flood', 'road', 'bank-holiday', 'hold', 'notice', 'source-down', 'holds-invalid'];

async function get(url, opt = {}, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try { const ac = new AbortController(), t = setTimeout(() => ac.abort(), 45000);
      const r = await fetch(url, Object.assign({ signal: ac.signal, redirect: 'follow' }, opt)); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
    catch (e) { if (i === tries) throw e; await new Promise(r => setTimeout(r, 5000 * i)); } } }
const sources = {}, cur = [];
async function source(name, label, fn, keep) {
  try { const items = await fn(); sources[name] = { ok: true, at, n: items.length, label }; return items; }
  catch (e) { const old = (prevA[keep] || []).map(x => Object.assign({}, x, { stale: true }));
    sources[name] = Object.assign({ ok: false, at, label, err: String(e.message || e).slice(0, 200), keptOld: old.length }, e.setup ? { setup: false } : {});
    if (!e.setup) cur.push({ id: 'source-down:' + name, kind: 'source-down', sev: name === 'bods-sx' ? 'high' : 'med', source: label, title: label + ' could not be read',
      detail: String(e.message || e).slice(0, 200), effect: 'keeps the last ' + old.length + ' item(s) from ' + (sources[name].lastOk || 'the previous run') + ', marked stale' });
    return old; } }
const notSetUp = msg => { const e = new Error(msg); e.setup = true; return e; };

/* stop id (ATCO) → our services + place names */
const stopMap = {}; Object.entries(M.services).forEach(([svc, s]) => s.places.forEach(p => (p.ids || []).forEach(id => { const m = stopMap[id] = stopMap[id] || { svcs: new Set(), names: new Set() }; m.svcs.add(svc); m.names.add(p.name); })));
const OURS = new Set([...(cfg.services || []), ...Object.keys(cfg.merge || {})]);

/* 1 BODS DISRUPTIONS (SIRI-SX). Kept when a stop is one of ours, or the line is ours and run by our operator(s). */
const dec = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tagAll = (b, t) => [...b.matchAll(new RegExp('<(?:\\w+:)?' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + t + '>', 'g'))].map(m => dec(m[1]));
const tag1 = (b, t) => tagAll(b, t)[0] || '';
const disruptions = await source('bods-sx', 'BODS bus disruptions', async () => {
  const key = process.env.BODS_API_KEY; if (!key) throw notSetUp('BODS_API_KEY secret not set');
  const xml = await get((S.siriSx || 'https://data.bus-data.dft.gov.uk/api/v1/siri-sx/') + '?api_key=' + encodeURIComponent(key));
  if (!/PtSituationElement|Siri/i.test(xml)) throw new Error('reply is not SIRI-SX');
  const out = [];
  xml.split(/<(?:\w+:)?PtSituationElement[\s>]/).slice(1).forEach(b => {
    if (/^closed$/i.test(tag1(b, 'Progress'))) return;
    const ends = tagAll(b, 'EndTime'), starts = tagAll(b, 'StartTime'), to = ends.length ? ends.sort().slice(-1)[0] : '', from = starts.sort()[0] || '';
    if (to && ymd(to) < today) return;
    const lines = [...new Set([...tagAll(b, 'PublishedLineName'), ...tagAll(b, 'LineRef')].map(x => x.trim()))], ops = tagAll(b, 'OperatorRef'), stops = [...new Set(tagAll(b, 'StopPointRef'))];
    const mine = stops.filter(s => stopMap[s]), svcs = new Set();
    mine.forEach(s => stopMap[s].svcs.forEach(v => { if (!lines.length || lines.includes(v)) svcs.add(v); }));
    if (ops.some(o => (cfg.nocs || []).includes(o))) lines.filter(l => OURS.has(l)).forEach(l => svcs.add((cfg.merge || {})[l] ? l : l));
    if (!svcs.size && !mine.length) return;
    const places = [...new Set(mine.flatMap(s => [...stopMap[s].names]))].slice(0, 12);
    out.push({ id: 'sx:' + (tag1(b, 'SituationNumber') || from + lines.join('')), services: [...svcs], stops: mine.slice(0, 40), places, from: ymd(from), to: ymd(to), fromT: from, toT: to,
      summary: tag1(b, 'Summary').slice(0, 200), desc: tag1(b, 'Description').slice(0, 600), planned: tag1(b, 'Planned') === 'true', reason: tag1(b, 'MiscellaneousReason') || tag1(b, 'EnvironmentReason') || tag1(b, 'EquipmentReason') || '',
      who: tag1(b, 'ParticipantRef') || '' }); });
  return out; }, 'disruptions');
disruptions.forEach(d => cur.push({ id: d.id, kind: 'disruption', sev: d.services.length ? 'high' : 'med', source: 'BODS disruptions', services: d.services,
  title: (d.services.length ? d.services.join(', ') + ': ' : '') + (d.summary || 'Bus disruption') + (d.stale ? ' (stale)' : ''), detail: [d.places.join(', '), d.desc].filter(Boolean).join(' — ').slice(0, 400),
  effect: d.services.length ? 'no ' + d.services.join('/') + ' buses home ' + (d.from || 'now') + (d.to ? '–' + d.to : ' until withdrawn') + '; warning on routes using them' : 'warning on routes using ' + d.places.slice(0, 3).join(', ') }));

/* 2 ENVIRONMENT AGENCY FLOOD WARNINGS around the Lakes (no key). Level 1 severe, 2 warning, 3 alert; 4 = no longer in force (dropped). */
const F0 = S.floods || { lat: 54.5, long: -3.1, dist: 45 };
const floods = await source('ea-floods', 'Environment Agency flood warnings', async () => {
  const j = JSON.parse(await get('https://environment.data.gov.uk/flood-monitoring/id/floods?lat=' + F0.lat + '&long=' + F0.long + '&dist=' + F0.dist));
  return (j.items || []).filter(x => x.severityLevel && x.severityLevel <= 3).map(x => ({ id: 'flood:' + x.floodAreaID, area: x.description || x.eaAreaName || '', level: x.severityLevel, severity: x.severity || '',
    river: (x.floodArea && x.floodArea.riverOrSea) || '', raised: x.timeRaised || '', message: (x.message || '').replace(/\s+/g, ' ').slice(0, 500) })); }, 'floods');
floods.filter(f => f.level <= 2).forEach(f => cur.push({ id: f.id, kind: 'flood', sev: f.level === 1 ? 'high' : 'med', source: 'Environment Agency', title: f.severity + ': ' + f.area + (f.stale ? ' (stale)' : ''),
  detail: f.message.slice(0, 300), effect: 'flood warning on routes near ' + (f.river || f.area) }));

/* 3 NATIONAL HIGHWAYS (M6, A66, A590…) — only once set up: free developer account, key in secret NH_API_KEY, feed address in config signals.nh.url.
   Parser reads DATEX II situation records (XML or JSON) inside the bbox; UNVERIFIED until the first real reply — check the monitor after set-up. */
const NH = S.nh || {}, BB = S.bbox || [54.0, -3.7, 54.95, -2.35];
const inBox = (la, lo) => la >= BB[0] && la <= BB[2] && lo >= BB[1] && lo <= BB[3];
const roads = await source('nh', 'National Highways', async () => {
  const key = process.env[NH.keyEnv || 'NH_API_KEY']; if (!NH.url || !key) throw notSetUp('Not set up yet — needs a free National Highways developer account, secret NH_API_KEY and signals.nh.url in config.json');
  const txt = await get(NH.url, { headers: { 'Ocp-Apim-Subscription-Key': key, Accept: 'application/json, application/xml' } }), out = [];
  if (/^\s*[\[{]/.test(txt)) { const walk = (o, d) => { if (!o || typeof o !== 'object' || d > 12) return; const la = +(o.latitude ?? o.lat), lo = +(o.longitude ?? o.lon ?? o.lng);
      if (isFinite(la) && isFinite(lo) && inBox(la, lo) && (o.id || o.situationRecordId)) out.push({ id: 'nh:' + (o.id || o.situationRecordId), lat: la, lon: lo, road: o.roadName || o.roadNumber || '', text: String(o.comment || o.description || o.cause || '').slice(0, 300), from: ymd(o.startTime || o.overallStartTime), to: ymd(o.endTime || o.overallEndTime), closure: /clos/i.test(JSON.stringify(o).slice(0, 2000)) });
      Object.values(o).forEach(v => walk(v, d + 1)); }; walk(JSON.parse(txt), 0); }
  else txt.split(/<(?:\w+:)?situationRecord[\s>]/).slice(1).forEach(b => { const la = +tag1(b, 'latitude'), lo = +tag1(b, 'longitude'); if (!inBox(la, lo)) return;
    out.push({ id: 'nh:' + ((b.match(/id="([^"]+)"/) || [])[1] || la + ',' + lo), lat: la, lon: lo, road: tag1(b, 'roadNumber') || tag1(b, 'roadName'), text: tagAll(b, 'value').join(' ').slice(0, 300), from: ymd(tag1(b, 'overallStartTime')), to: ymd(tag1(b, 'overallEndTime')), closure: /roadClosed|closure|carriagewayClosures/i.test(b) }); });
  return out.filter(x => !x.to || x.to >= today); }, 'roads');
roads.filter(r => r.closure).forEach(r => cur.push({ id: r.id, kind: 'road', sev: 'med', source: 'National Highways', title: (r.road || 'Road') + ' closure' + (r.stale ? ' (stale)' : ''), detail: r.text, effect: 'warning on routes driving or riding the bus on ' + (r.road || 'that road') }));

/* 3b STREET MANAGER (council roads: Kirkstone, Honister, Whinlatter, Wrynose…) — read from the owner's Cloudflare catcher (street-manager-worker/).
   Road CLOSURES on a watched road = med problem + warning; other works listed only. Remove-only: can never add a route. */
const SM = S.streetManager || {};
const works = await source('street-manager', 'Street Manager roadworks', async () => {
  if (!SM.url) throw notSetUp('Not set up yet \u2014 needs the Cloudflare catcher (street-manager-worker) and signals.streetManager.url in config.json');
  const j = JSON.parse(await get(SM.url.replace(/\/works\.json$/, '').replace(/\/?$/, '') + '/works.json'));
  return (j.works || []).map(w => Object.assign({ id: 'sm:' + w.ref }, w)); }, 'works');
const WATCH = (SM.watch || []).map(x => new RegExp(x, 'i'));
/* CLOSURE → AUTO-DROP (owner, 7 Oct): a closure on a watched road automatically switches off, for the closure dates, every car park
   within carparkM of the closure point and every bus service config.signals.roads ties to that road (+ car parks listed there, which also
   covers car parks you can only drive to over that road). Published as alerts.autoHolds; when the closure ends they vanish and the routes return. */
const ROADS = S.roads || {}, autoHolds = [];
const roadOf = txt => Object.keys(ROADS).filter(k => (ROADS[k].match || [k]).some(x => new RegExp(x, 'i').test(txt)));
works.filter(w => w.closure).forEach(w => { const txt = [w.street, w.area].join(' '), rk = roadOf(txt), watched = rk.length > 0 || WATCH.some(r => r.test(txt));
  const from = ymd(w.from) || today, to = ymd(w.to) || '', why = 'Road closure: ' + (w.street || 'road') + (w.area ? ', ' + w.area : '');
  if (watched && !(to && to < today)) {
    if (w.e && w.n) autoHolds.push({ id: 'auto:' + w.ref + ':near', kind: 'carparkNear', e: w.e, n: w.n, r: S.carparkM || 400, from, to, reason: why, auto: true });
    rk.forEach(k => { (ROADS[k].services || []).forEach(sv => autoHolds.push({ id: 'auto:' + w.ref + ':' + sv, kind: 'service', service: sv, from, to, reason: why, auto: true }));
      (ROADS[k].carparks || []).forEach(cp => autoHolds.push({ id: 'auto:' + w.ref + ':' + cp, kind: 'carpark', carpark: cp, from, to, reason: why, auto: true })); }); }
  const off = autoHolds.filter(h => h.id.startsWith('auto:' + w.ref + ':')).map(h => h.service ? 'bus ' + h.service : h.carpark ? h.carpark : 'car parks within ' + h.r + ' m').join(', ');
  cur.push({ id: w.id, kind: 'road', sev: watched ? 'high' : 'low', source: 'Street Manager', title: 'Road closure: ' + (w.street || 'road') + (w.area ? ', ' + w.area : '') + (w.stale ? ' (stale)' : ''),
    detail: [w.desc, (w.from || '').slice(0, 10) + (w.to ? ' \u2192 ' + String(w.to).slice(0, 10) : ''), w.auth].filter(Boolean).join(' \u00b7 '),
    effect: off ? 'routes using ' + off + ' dropped ' + (w.from ? String(w.from).slice(0, 10) : 'now') + (w.to ? ' \u2192 ' + String(w.to).slice(0, 10) : ' until it reopens') + '; they come back when it reopens' : 'listed only' }); });

/* 3c MET OFFICE (Weather DataHub, Site Specific Global Spot, free plan: 360 calls/day/API). REMOVE-ONLY (owner, 7 Oct): summit points
   every metEveryH hours (12 points × 12 runs = 144 calls/day). Per day (08:00–20:00): max gust ≥ scrambleGustMph → graded scrambles out;
   ≥ highGustMph, or snow at a summit, or feels-like ≤ highFeelsC → fells above highM out. Never a 'good conditions' signal.
   Model point forecasts read LOW on exposed summits (model ground is smoothed) — thresholds are deliberately cautious. */
const MO = S.met || {}, prevW = prevA.weather || null;
const weather = await (async () => {
  const key = process.env[MO.keyEnv || 'MET_API_KEY'];
  if (!key) { sources['met'] = { ok: false, setup: false, at, label: 'Met Office (DataHub)', err: 'Not set up yet \u2014 needs a free Weather DataHub account (Site Specific Global Spot) and secret MET_API_KEY' }; return null; }
  if (prevW && prevW.at && Date.parse(at) - Date.parse(prevW.at) < (MO.everyH || 2) * 3600e3 - 300e3) { sources['met'] = Object.assign({}, (readJ(path.join(SITE, 'signals-status.json')) || { sources: {} }).sources.met || {}, { ok: true, label: 'Met Office (DataHub)', at: prevW.at, skipped: true }); return prevW; }
  const pts = MO.points || [], days = {}, errs = [];
  for (const p of pts) { try {
    const j = JSON.parse(await get('https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly?latitude=' + p.lat + '&longitude=' + p.lon, { headers: { apikey: key, accept: 'application/json' } }, 2));
    ((((j.features || [])[0] || {}).properties || {}).timeSeries || []).forEach(t => { const d = ymd(t.time), h = +String(t.time).slice(11, 13); if (h < 7 || h > 19) return;   // ~08:00–20:00 UK summer
      const D = days[d] = days[d] || { gustMph: 0, feelsC: 99, snow: [], where: {} }, g = (t.windGustSpeed10m || 0) * 2.237;
      if (g > D.gustMph) { D.gustMph = Math.round(g); D.where.gust = p.name; }
      if (t.feelsLikeTemperature != null && t.feelsLikeTemperature < D.feelsC) { D.feelsC = Math.round(t.feelsLikeTemperature); D.where.cold = p.name; }
      if ([22, 23, 24, 25, 26, 27].includes(t.significantWeatherCode) && !D.snow.includes(p.name)) D.snow.push(p.name); }); }
    catch (e) { errs.push(p.name + ': ' + e.message); } }
  if (!Object.keys(days).length) throw new Error(errs[0] || 'no forecast returned');
  Object.values(days).forEach(D => { const r = [];
    if (D.gustMph >= (MO.highGustMph || 55)) r.push('very strong gusts forecast');
    if (D.snow.length) r.push('snow forecast on the high fells');
    if (D.feelsC <= (MO.highFeelsC != null ? MO.highFeelsC : -8)) r.push('severe cold forecast');
    D.highOff = r.length > 0; D.highReasons = r; D.scrambleOff = D.highOff || D.gustMph >= (MO.scrambleGustMph || 40);
    if (D.scrambleOff && !D.highOff) D.highReasons = ['strong gusts forecast'];
    /* MET OFFICE LICENCE 3.2 (checked 8 Oct): the public site may carry only our DECISIONS, never the forecast values themselves */
    delete D.gustMph; delete D.feelsC; delete D.snow; delete D.where; });
  sources['met'] = { ok: true, at, n: pts.length - errs.length, label: 'Met Office (DataHub)', calls: pts.length, err: errs.length ? errs.join(' \u00b7 ').slice(0, 200) : undefined };
  return { at, highM: MO.highM || 750, days, credit: 'Weather data supplied by the Met Office' };
})().catch(e => { sources['met'] = { ok: false, at, label: 'Met Office (DataHub)', err: String(e.message || e).slice(0, 200) };
  cur.push({ id: 'source-down:met', kind: 'source-down', sev: 'med', source: 'Met Office', title: 'Met Office forecast could not be read', detail: String(e.message || e).slice(0, 200), effect: 'keeps the last forecast rules, marked stale' });
  return prevW ? Object.assign({}, prevW, { stale: true }) : null; });
if (weather) Object.entries(weather.days).forEach(([d, D]) => { if (d < today || !D.scrambleOff) return;
  cur.push({ id: 'weather:' + d, kind: 'weather', sev: D.highOff ? 'high' : 'med', source: 'Met Office', title: d + ': ' + (D.highOff ? 'fells above ' + weather.highM + ' m and scrambles out' : 'graded scrambles out') + (weather.stale ? ' (stale)' : ''),
    detail: (D.highReasons.length ? D.highReasons : ['strong gusts forecast']).join(' \u00b7 '), effect: 'routes dropped that day; they come back if the forecast eases' }); });

/* 3d SOURCE HEALTH (owner, 7 Oct): once a day, look for any source being retired — HTTP Deprecation / Sunset headers, retirement words
   on each source's own announcement page (config.signals.watchPages), and any source down 3 days running (likely moved or switched off). */
const SCAN = new Date().getUTCHours() === (S.healthHourUtc != null ? S.healthHourUtc : 6) || process.argv.includes('--health');
const healthPrev = (readJ(path.join(SITE, 'signals-status.json')) || {}).health || {}, health = SCAN ? {} : healthPrev;
if (SCAN) for (const w of (S.watchPages || [])) { try {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 30000), r = await fetch(w.url, { signal: ac.signal, redirect: 'follow' }); clearTimeout(t);
  const hdr = ['deprecation', 'sunset'].map(h => r.headers.get(h) ? h + ': ' + r.headers.get(h) : '').filter(Boolean), body = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const hits = [...body.matchAll(/[^.]{0,120}\b(deprecat\w*|retir(?:e|ed|ing|ement)|decommission\w*|switch(?:ed|ing)? off|end of life|no longer (?:be )?(?:available|supported)|will close|being replaced)\b[^.]{0,120}/gi)].map(m => m[0].trim()).filter(s => (w.about || []).length ? (w.about).some(a => new RegExp(a, 'i').test(s)) : true).slice(0, 3);
  health[w.source] = { at, ok: r.ok, status: r.status, hdr, hits }; } catch (e) { health[w.source] = { at, ok: false, err: String(e.message || e).slice(0, 120) }; } }
Object.entries(health).forEach(([src, h]) => { if (h.hdr && h.hdr.length || h.hits && h.hits.length) cur.push({ id: 'source-retiring:' + src, kind: 'source-retiring', sev: 'high', source: src,
  title: src + ' may be retiring or changing', detail: [...(h.hdr || []), ...(h.hits || []).map(x => '\u201c' + x.slice(0, 200) + '\u201d')].join(' \u00b7 '), effect: 'nothing yet \u2014 read the notice and plan a new source before it switches off' }); });
const stPrev = (readJ(path.join(SITE, 'signals-status.json')) || {}).sources || {};
Object.entries(sources).forEach(([k, s]) => { if (s.ok || s.setup === false) return; const lastOk = (stPrev[k] || {}).lastOk;
  if (lastOk && Date.parse(at) - Date.parse(lastOk) > 3 * 864e5) cur.push({ id: 'source-dead:' + k, kind: 'source-dead', sev: 'high', source: s.label, title: s.label + ' has failed for over 3 days (last good ' + lastOk.slice(0, 10) + ')',
    detail: (s.err || '') + ' \u2014 it may have moved or been switched off', effect: 'running on its last good data, marked stale; hook up a replacement' }); });

/* 4 BANK HOLIDAYS (gov.uk, England and Wales). A service's buses count on a bank holiday only if its timetable NAMES the date
   (switched off, or a dated run on it). Silent services are left out that day; the next 21 days become problems. */
const bank = await source('bank-holidays', 'gov.uk bank holidays', async () => {
  const j = JSON.parse(await get('https://www.gov.uk/bank-holidays.json')), ev = ((j['england-and-wales'] || {}).events || []).map(e => ({ date: ymd(e.date), title: e.title })).filter(e => e.date >= today && e.date <= C.addDays(today, 400));
  if (!B) throw new Error('no published timetable to check');
  return ev.map(e => { const conf = [], unconf = [];
    B.services.forEach(s => { const would = s.journeys.some(j => !j.dated && j.days.includes(C.dow(e.date)) && j.from <= e.date && e.date <= j.to);
      const named = s.journeys.some(j => (j.off || []).includes(e.date)) || s.journeys.some(j => j.dated && B.profiles[j.dated] && B.profiles[j.dated].on.includes(e.date));
      if (named) conf.push(s.service); else if (would) unconf.push(s.service); });
    return { id: 'bh:' + e.date, date: e.date, title: e.title, confirmed: conf, unconfirmed: unconf }; }); }, 'bankHolidays');
bank.filter(b => b.unconfirmed.length && b.date <= C.addDays(today, 21)).forEach(b => cur.push({ id: 'bank-holiday:' + b.date, kind: 'bank-holiday', sev: 'med', source: 'gov.uk + BODS',
  title: b.title + ' ' + b.date + ': ' + b.unconfirmed.join(', ') + ' silent on the date', detail: 'These timetables do not mention the bank holiday, so we cannot tell what runs.', effect: 'leaves out ' + b.unconfirmed.join(', ') + ' that day' }));

/* 5 OWNER SWITCHES (holds.json) — REMOVE-ONLY: hide a service / its buses home / a stop / a car park / a road (its car parks + services) on dates,
   plus the urgent notice. Anything that tries to add a time is rejected. */
const H = readJ(HOLDS) || {}, KINDS = ['service', 'busHome', 'stop', 'carpark', 'road', 'allBuses'], bad = [];
const okD = d => !d || /^\d{8}$/.test(d);
const holds = (H.holds || []).filter((h, i) => {
  const why = !h || !KINDS.includes(h.kind) ? 'unknown kind' : ['start', 'times', 'journeys', 'calls', 'dep', 'arr'].some(k => k in h) ? 'holds can only switch things OFF, never add times' : !okD(h.from) || !okD(h.to) ? 'dates must be YYYYMMDD' : '';
  if (why) bad.push('#' + (i + 1) + ' ' + why); return !why && !(h.to && h.to < today); })
  .map((h, i) => Object.assign({ id: 'hold:' + (h.id || h.kind + ':' + (h.service || h.carpark || h.road || h.stop || 'all') + ':' + (h.from || '') ) }, h));
if (bad.length) cur.push({ id: 'holds-invalid', kind: 'holds-invalid', sev: 'high', source: 'holds.json', title: 'holds.json has ' + bad.length + ' entr' + (bad.length > 1 ? 'ies' : 'y') + ' that were ignored', detail: bad.join(' · '), effect: 'those entries are not applied — fix holds.json' });
holds.forEach(h => cur.push({ id: h.id, kind: 'hold', sev: 'low', source: 'holds.json (you)', title: 'You switched off ' + ({ service: 'service ' + h.service, busHome: h.service + ' buses home', stop: 'stop ' + h.stop, carpark: 'car park ' + h.carpark, road: 'road ' + h.road, allBuses: 'all buses' })[h.kind] + (h.from ? ' ' + h.from + (h.to ? '–' + h.to : ' onwards') : ''),
  detail: h.reason || '', effect: h.kind === 'road' ? 'leaves out ' + [...(h.carparks || []), ...(h.services || [])].join(', ') : 'left out' }));
const N0 = H.notice || {}, notice = N0.on && N0.text && !(N0.until && N0.until < today) ? { on: true, text: String(N0.text).slice(0, 300), until: N0.until || '', busHomeOff: !!N0.busHomeOff } : { on: false };
if (notice.on) cur.push({ id: 'notice', kind: 'notice', sev: notice.busHomeOff ? 'high' : 'low', source: 'holds.json (you)', title: 'Urgent banner is ON: "' + notice.text + '"', detail: notice.until ? 'Until ' + notice.until : 'Until you switch it off', effect: 'scrolling banner in the app' + (notice.busHomeOff ? ' + ALL bus-home routes switched off' : '') });

/* 5b RISKS WORDING (terms.json, owner-edited / Mac app). Published as alerts.terms; the app replaces its bundled wording only when the version is HIGHER,
   and every phone must accept again. Checked here: versions only go up, nothing blank, every item has a title + text. A bad file is NOT published (last good kept). */
const TJ = readJ('terms.json'), prevT = prevA.terms || null, tBad = [];
const tOk = t => t && Number.isInteger(+t.version) && Array.isArray(t.general) && t.general.length && t.general.every(x => x && String(x.t || '').trim() && String(x.d || '').trim())
  && Object.values(t.risks || {}).every(r => r && String(r.title || '').trim() && Array.isArray(r.items) && r.items.length && r.items.every(x => String(x.t || '').trim() && String(x.d || '').trim()));
if (TJ && !tOk(TJ)) tBad.push('terms.json is incomplete (every item needs a title and text, every version a whole number)');
if (TJ && prevT && +TJ.version < +prevT.version) tBad.push('terms.json version went DOWN (' + prevT.version + ' → ' + TJ.version + ')');
/* ONE DOCUMENT, ONE VERSION (owner, 7 Oct): any wording change anywhere (general or a margin risk) must raise the single version */
if (TJ && prevT && +TJ.version === +prevT.version && JSON.stringify([TJ.general, TJ.risks]) !== JSON.stringify([prevT.general, prevT.risks])) tBad.push('wording changed but version not raised — phones would NOT be asked to accept again; raise version');
const terms = TJ && !tBad.length ? (({ note, ...t }) => t)(TJ) : prevT;
/* TERMS HISTORY (owner, 8 Oct): every published version is archived once in terms-history/v<N>.json — never overwritten */
if (TJ && !tBad.length) { try { const fs0 = await import('node:fs'), hp = 'terms-history/v' + (+TJ.version) + '.json';
  if (!fs0.existsSync(hp)) { fs0.mkdirSync('terms-history', { recursive: true }); fs0.writeFileSync(hp, JSON.stringify(Object.assign({ saved: new Date().toISOString().slice(0, 10) }, terms), null, 1)); } } catch (e) {} }
if (tBad.length) cur.push({ id: 'terms-invalid', kind: 'holds-invalid', sev: 'high', source: 'terms.json', title: 'Risks wording NOT sent out', detail: tBad.join(' · '), effect: 'phones keep the last good wording (v' + (prevT ? prevT.version : 'bundled') + ')' });
if (terms && prevT && +terms.version > +prevT.version) cur.push({ id: 'terms-sent:' + terms.version, kind: 'notice', sev: 'low', source: 'terms.json (you)', title: 'Terms v' + terms.version + ' sent out — every phone must accept the whole document again', detail: '', effect: 'opening screen shown again on every phone' });

/* 6 WRITE */
const alerts = { schema: 1, generated: at, terms, notice, holds, autoHolds, weather, disruptions, floods, roads, works, bankHolidays: bank,
  licence: 'Contains public sector information licensed under the Open Government Licence v3.0 (BODS, Street Manager, Environment Agency, gov.uk). Contains Met Office data © Crown copyright. Not endorsed by any of them.' };
const how = p => p.kind === 'disruption' ? 'The notice was withdrawn or its end time passed (BODS, ' + at.slice(0, 16).replace('T', ' ') + ')'
  : p.kind === 'flood' ? 'The Environment Agency lifted or downgraded the warning'
  : p.kind === 'source-down' ? p.source + ' is readable again' : p.kind === 'bank-holiday' ? 'The timetables now name the date, or the day has passed'
  : p.kind === 'hold' ? 'Your switch ended or was removed from holds.json' : p.kind === 'notice' ? 'You switched the banner off (or its end date passed)'
  : p.kind === 'weather' ? 'The Met Office forecast eased (or the day passed) \u2014 routes back'
  : p.kind === 'source-retiring' ? 'The retirement notice is no longer on ' + p.source + '\u2019s page'
  : p.kind === 'source-dead' ? p.source + ' is readable again'
  : p.kind === 'road' ? (p.source === 'Street Manager' ? 'Street Manager marks the works finished or past their end date \u2014 routes back' : 'National Highways no longer lists the closure') : p.kind === 'holds-invalid' ? 'holds.json fixed' : null;
const L = PR.reconcile(readJ(path.join(SITE, 'problems.json')), SCOPE, cur, at, how);
fs.writeFileSync(path.join(OUT, 'alerts.json'), JSON.stringify(alerts));
/* AUDIT TRAIL (owner, 7 Oct): every hour that the safety state CHANGED, one line is appended to audit/<UK date>.jsonl — what the app was
   switching off at that moment. No personal data. The nightly audit job seals the day. */
{ const ukDate = new Date(Date.now() + (/BST|\+01/.test(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' })) ? 3600e3 : 0)).toISOString().slice(0, 10);
  const snap = { notice: alerts.notice, holds: alerts.holds, autoHolds: alerts.autoHolds, weather: alerts.weather && { at: alerts.weather.at, stale: !!alerts.weather.stale, days: Object.fromEntries(Object.entries(alerts.weather.days || {}).filter(([d]) => d >= today && d <= C.addDays(today, 1))) },
    disruptions: disruptions.map(d => ({ id: d.id, services: d.services, from: d.from, to: d.to, summary: d.summary, stale: !!d.stale })), floods: floods.map(f => ({ id: f.id, level: f.level, area: f.area })),
    closures: works.filter(w => w.closure).map(w => ({ id: w.id, street: w.street, area: w.area, from: w.from, to: w.to })), sources: Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, s.ok ? 'ok' : s.setup === false ? 'not set up' : 'DOWN'])) };
  const h = crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex'), dir = path.join(OUT, 'audit'); fs.mkdirSync(dir, { recursive: true });
  let lastH = ''; try { const L = fs.readFileSync(path.join('audit', ukDate + '.jsonl'), 'utf8').trim().split('\n'); lastH = JSON.parse(L[L.length - 1]).hash; } catch {}
  if (h !== lastH) fs.writeFileSync(path.join(dir, ukDate + '.line'), JSON.stringify({ at, hash: h, state: snap }) + '\n'); }
fs.writeFileSync(path.join(OUT, 'problems.json'), JSON.stringify(L.ledger));
const prevS = readJ(path.join(SITE, 'signals-status.json')) || {};
Object.keys(sources).forEach(k => { sources[k].lastOk = sources[k].ok ? at : ((prevS.sources || {})[k] || {}).lastOk || null; });
fs.writeFileSync(path.join(OUT, 'signals-status.json'), JSON.stringify({ at, sources, health, counts: { disruptions: disruptions.length, floods: floods.length, roads: roads.length, works: works.length, holds: holds.length, notice: notice.on } }));
const strip = o => JSON.stringify(Object.assign({}, o, { generated: 0, updated: 0 }));
fs.writeFileSync(path.join(OUT, 'changed'), strip(alerts) !== strip(prevA) || strip(L.ledger) !== strip(readJ(path.join(SITE, 'problems.json')) || {}) ? '1' : '');
console.log('[signals]', JSON.stringify(sources), '· opened', L.opened.length, '· resolved', L.resolved.length);
