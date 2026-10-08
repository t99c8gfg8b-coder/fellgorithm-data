/* Fellgorithm bus timetable builder — core (no I/O). Runs in Node (the weekly GitHub Action) and in the browser (review tools).
   Input: parsed GTFS tables for OUR trips only + the places manifest. Output: the FG_BUSES object the app reads.
   Source: Bus Open Data Service GTFS (Open Government Licence v3.0). */
(function (root) {
  'use strict';
  function parseCSV(text) {
    const out = []; let i = 0, row = [], cell = '', q = false; const n = text.length;
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    for (; i < n; i++) { const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
      if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') out.push(row); row = []; }
      else cell += ch; }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    const h = out.shift() || []; return out.map(r => { const o = {}; h.forEach((k, j) => o[k.trim()] = r[j]); return o; });
  }
  /* WGS84 lat/lon → OSGB36 National Grid E/N (Helmert 7-parameter + Airy 1830 Transverse Mercator), ~5 m. */
  function toOSGB(lat, lon) {
    const rad = Math.PI / 180; let a = 6378137, b = 6356752.3141, e2 = 1 - b * b / (a * a);
    let p = lat * rad, l = lon * rad, nu = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    let x = nu * Math.cos(p) * Math.cos(l), y = nu * Math.cos(p) * Math.sin(l), z = (1 - e2) * nu * Math.sin(p);
    const tx = -446.448, ty = 125.157, tz = -542.060, s = 20.4894e-6, rx = -0.1502 / 3600 * rad, ry = -0.2470 / 3600 * rad, rz = -0.8421 / 3600 * rad;
    const x2 = tx + (1 + s) * x - rz * y + ry * z, y2 = ty + rz * x + (1 + s) * y - rx * z, z2 = tz - ry * x + rx * y + (1 + s) * z;
    a = 6377563.396; b = 6356256.909; e2 = 1 - b * b / (a * a);
    const pp = Math.sqrt(x2 * x2 + y2 * y2); let phi = Math.atan2(z2, pp * (1 - e2)), phiP = 2 * Math.PI;
    while (Math.abs(phi - phiP) > 1e-12) { nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2); phiP = phi; phi = Math.atan2(z2 + e2 * nu * Math.sin(phi), pp); }
    const lam = Math.atan2(y2, x2), F0 = 0.9996012717, phi0 = 49 * rad, lam0 = -2 * rad, N0 = -100000, E0 = 400000, n = (a - b) / (a + b);
    const sp = Math.sin(phi), cp = Math.cos(phi), tp = Math.tan(phi);
    nu = a * F0 / Math.sqrt(1 - e2 * sp * sp); const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sp * sp, 1.5), eta2 = nu / rho - 1;
    const Ma = (1 + n + 1.25 * n * n + 1.25 * n ** 3) * (phi - phi0), Mb = (3 * n + 3 * n * n + 21 / 8 * n ** 3) * Math.sin(phi - phi0) * Math.cos(phi + phi0);
    const Mc = (15 / 8 * n * n + 15 / 8 * n ** 3) * Math.sin(2 * (phi - phi0)) * Math.cos(2 * (phi + phi0)), Md = 35 / 24 * n ** 3 * Math.sin(3 * (phi - phi0)) * Math.cos(3 * (phi + phi0));
    const M = b * F0 * (Ma - Mb + Mc - Md), I = M + N0, II = nu / 2 * sp * cp, III = nu / 24 * sp * cp ** 3 * (5 - tp * tp + 9 * eta2), IIIA = nu / 720 * sp * cp ** 5 * (61 - 58 * tp * tp + tp ** 4);
    const IV = nu * cp, V = nu / 6 * cp ** 3 * (nu / rho - tp * tp), VI = nu / 120 * cp ** 5 * (5 - 18 * tp * tp + tp ** 4 + 14 * eta2 - 58 * tp * tp * eta2), dl = lam - lam0;
    return { e: Math.round(E0 + IV * dl + V * dl ** 3 + VI * dl ** 5), n: Math.round(I + II * dl * dl + III * dl ** 4 + IIIA * dl ** 6) };
  }
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], D3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const mins = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const dow = d => D3[(new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay() + 6) % 7];

  /* Which routes are ours: config.services (short names) run by config.nocs (operator codes, stable week to week). */
  function ourRoutes(T, cfg) {
    const noc = {}; (T.agency || []).forEach(a => noc[a.agency_id] = a.agency_noc);
    return (T.routes || []).filter(r => cfg.services.includes(r.route_short_name) && (!cfg.nocs || cfg.nocs.includes(noc[r.agency_id])));
  }
  function ourTripIds(T, cfg) { const rid = new Set(ourRoutes(T, cfg).map(r => r.route_id)); return new Set(T.trips.filter(t => rid.has(t.route_id)).map(t => t.trip_id)); }

  /* Build. T = {agency, routes, trips, calendar, calendar_dates, stops, stop_times (ours only)}; M = manifest {services:{name:{places:[…ids]}}}. */
  function build(T, M, cfg, opts) {
    opts = opts || {}; const rep = { warnings: [], newServices: [], unmatchedStops: {}, droppedTrips: 0, dupes: 0, addOnly: 0, merged: {}, drop: {} };
    const dropAs = (n, why) => { rep.droppedTrips++; const d = rep.drop[n] = rep.drop[n] || { places: 0, dates: 0, kept: 0, trips: 0 }; d[why]++; };
    const merge = cfg.merge || {};   /* e.g. {"755":"555"}: a renumbered bus on the same road is built onto that service's places; journeys keep num = the number on the bus */
    const routes = ourRoutes(T, cfg), rName = {}; routes.forEach(r => rName[r.route_id] = r.route_short_name);
    const cal = {}; (T.calendar || []).forEach(c => cal[c.service_id] = c);
    const cdAdd = {}, cdRem = {}; (T.calendar_dates || []).forEach(c => { const m = c.exception_type === '1' ? cdAdd : cdRem; (m[c.service_id] = m[c.service_id] || []).push(c.date); });
    const stByTrip = {}; T.stop_times.forEach(s => (stByTrip[s.trip_id] = stByTrip[s.trip_id] || []).push(s));
    const stopPos = {}; (T.stops || []).forEach(s => stopPos[s.stop_id] = s);
    const profiles = {}, out = [];
    const names = [...new Set(routes.map(r => r.route_short_name))].sort((a, b) => cfg.services.indexOf(a) - cfg.services.indexOf(b));
    const order = (cfg.order || []).concat(names.filter(n => !(cfg.order || []).includes(n)));
    for (const name of order) {
      if (merge[name]) continue;
      const ms = M.services[name]; const trips = T.trips.filter(t => rName[t.route_id] === name || merge[rName[t.route_id]] === name);
      if (!trips.length) continue;
      if (!ms) { rep.newServices.push({ service: name, trips: trips.length }); continue; }
      const place = {}; ms.places.forEach((p, i) => (p.ids || []).forEach(id => (place[id] = place[id] || []).push(i)));
      const seen = new Map(), js = [], jsM = {};
      for (const t of trips) {
        const st = (stByTrip[t.trip_id] || []).slice().sort((a, b) => +a.stop_sequence - +b.stop_sequence);
        const calls = [];
        st.forEach(s => { const ps = place[s.stop_id]; if (!ps) { if (s.stop_id) rep.unmatchedStops[name + '|' + s.stop_id] = (stopPos[s.stop_id] || {}).stop_name || ''; return; }
          const tm = mins(s.departure_time || s.arrival_time); ps.forEach(p => { if (!calls.some(c => c.p === p)) calls.push({ p, t: tm }); }); });
        const num = rName[t.route_id], mg = num !== name ? (rep.merged[num] = rep.merged[num] || { into: name, trips: 0, kept: 0, ends: {} }) : null;
        if (mg) { mg.trips++; const e = ((stopPos[st[0] && st[0].stop_id] || {}).stop_name || '?') + ' → ' + ((stopPos[st.length && st[st.length - 1].stop_id] || {}).stop_name || '?'); mg.ends[e] = (mg.ends[e] || 0) + 1; }
        (rep.drop[name] = rep.drop[name] || { places: 0, dates: 0, kept: 0, trips: 0 }).trips++;
        if (calls.length < 2) { dropAs(name, 'places'); continue; }
        if (mg) mg.kept++;
        const t0 = mins(st[0].departure_time || st[0].arrival_time), sid = t.service_id, c = cal[sid];
        const j = { start: hhmm(t0), days: [], from: '', to: '', calls: calls.map(x => ({ p: x.p, off: x.t - t0 })) };
        const rem = (cdRem[sid] || []).slice().sort(), add = (cdAdd[sid] || []).slice().sort();
        if (c && DAYS.some(d => c[d] === '1')) {
          j.days = D3.filter((d, i) => c[DAYS[i]] === '1'); j.from = c.start_date; j.to = c.end_date;
          j.off = rem.filter(d => d >= c.start_date && d <= c.end_date);
          if (add.length) rep.addOnly += add.length;
        } else if (add.length) {
          j.from = add[0]; j.to = add[add.length - 1]; j.dated = sid; j.onDays = D3.filter(d => add.some(x => dow(x) === d));
          if (!profiles[sid]) profiles[sid] = { note: null, onDays: j.onDays, from: j.from, to: j.to, on: add, off: rem };
        } else { dropAs(name, 'dates'); continue; }
        const key = JSON.stringify(j); if (seen.has(key)) { rep.dupes++; continue; } seen.set(key, 1); j._r = t.route_id; (mg ? (jsM[num] = jsM[num] || []) : js).push(j); rep.drop[name].kept++;
      }
      js.sort((a, b) => mins(a.start) - mins(b.start));
      const pl = () => ms.places.map(p => { const o = Object.assign({}, p); delete o.ids; delete o.fell; delete o.fellM; return o; });   /* never publish OSM-derived fields (owner, 7 Oct) */
      out.push({ service: name, places: pl(), journeys: js });
      /* a merged route (e.g. 755) is its OWN service on the host's stops, so the app shows the number on the bus */
      Object.keys(jsM).forEach(n => { jsM[n].sort((a, b) => mins(a.start) - mins(b.start)); out.push({ service: n, places: pl(), journeys: jsM[n], on: name }); });
    }
    return { data: { services: out, profiles }, report: rep };
  }
  /* One CSV line (for streaming stop_times.txt). */
  function parseLine(l) { const r = []; let c = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i];
    if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else if (ch === '"') q = true; else if (ch === ',') { r.push(c); c = ''; } else if (ch !== '\r') c += ch; }
    r.push(c); return r; }

  const addDays = (d, n) => { const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + n)); return x.getUTCFullYear() + String(x.getUTCMonth() + 1).padStart(2, '0') + String(x.getUTCDate()).padStart(2, '0'); };
  /* Does journey j run on date d (YYYYMMDD)? Same reading as the app. */
  function runsOn(j, d, profiles) {
    if (j.dated) { const p = profiles && profiles[j.dated]; return !!(p && p.on.indexOf(d) >= 0); }
    return j.days.indexOf(dow(d)) >= 0 && (!j.from || j.from <= d) && (!j.to || d <= j.to) && !(j.off && j.off.indexOf(d) >= 0); }

  /* Wrap the built services into the file the app reads. Journeys already over (to < generated) are dropped. */
  function finalize(built, meta) {
    const g = meta.generated, gy = g.replace(/-/g, ''), prof = {};
    const services = built.services.map(s => Object.assign({ service: s.service, places: s.places }, s.on ? { on: s.on } : {},
      { journeys: s.journeys.filter(j => !j.to || j.to >= gy) })).filter(s => s.journeys.length);
    services.forEach(s => s.journeys.forEach(j => { if (j.dated && built.profiles[j.dated]) { const p = built.profiles[j.dated];
      prof[j.dated] = Object.assign({}, p, { note: p.note || profileNote(p) }); } }));
    return { schema: 1, generated: g, version: g + '+bods-' + (meta.feedVersion || 'unknown'), feed: meta.feed || null,
      posFix: meta.posFix || '', source: 'Bus Open Data Service GTFS, North West region', licence: 'Open Government Licence v3.0',
      services, profiles: prof, notes: meta.notes || '' };
  }
  function profileNote(p) { const span = (Date.UTC(+p.to.slice(0, 4), +p.to.slice(4, 6) - 1, +p.to.slice(6, 8)) - Date.UTC(+p.from.slice(0, 4), +p.from.slice(4, 6) - 1, +p.from.slice(6, 8))) / 864e5;
    return span <= 21 ? 'Runs on these dates only' : 'Runs on set dates only (' + p.onDays.join(', ') + ')'; }

  /* PRE-PUBLISH CHECKS. N = new file, P = last good (published) file or null, tests = base-tests.json, today = YYYYMMDD.
     Returns {ok, fails:[…], warns:[…], stats}. Anything in fails keeps last week's file live. */
  function checks(N, P, tests, today) {
    const fails = [], warns = [], stats = {};
    const F = (m) => fails.push(m), W = (m) => warns.push(m);
    /* 1 shape */
    if (!N || !Array.isArray(N.services) || !N.services.length) { F('File has no services'); return { ok: false, fails, warns, stats }; }
    let bad = 0, nj = 0;
    N.services.forEach(s => s.journeys.forEach(j => { nj++;
      const okj = /^\d\d:\d\d$/.test(j.start) && Array.isArray(j.calls) && j.calls.length >= 2 && j.calls.every((c, i) => c.p >= 0 && c.p < s.places.length && c.off >= 0 && (i === 0 || c.off >= j.calls[i - 1].off))
        && /^\d{8}$/.test(j.from) && /^\d{8}$/.test(j.to) && j.from <= j.to && (!j.dated || (N.profiles[j.dated] && N.profiles[j.dated].on.length));
      if (!okj) bad++; }));
    stats.journeys = nj; stats.services = N.services.map(s => s.service + ':' + s.journeys.length).join(' ');
    if (bad) F(bad + ' journeys are malformed');
    /* 2 size vs last week */
    if (P) { const pj = P.services.reduce((a, s) => a + s.journeys.length, 0); stats.prevJourneys = pj;
      if (nj < pj * (1 - tests.maxDrop)) F('Journeys fell from ' + pj + ' to ' + nj + ' (more than ' + Math.round(tests.maxDrop * 100) + '%)');
      if (nj > pj * (1 + tests.maxRise)) W('Journeys rose from ' + pj + ' to ' + nj + ' — check');
      P.services.forEach(ps => { const ns = N.services.find(s => s.service === ps.service);
        if (!ns) W('Service ' + ps.service + ' has gone this week (was ' + ps.journeys.length + ' journeys)'); }); }
    /* 3 dates: regular buses must run at least tests.minDaysAhead days ahead */
    const lastTo = N.services.reduce((m, s) => s.journeys.reduce((mm, j) => j.to > mm ? j.to : mm, m), '');
    stats.lastDate = lastTo;
    if (lastTo < addDays(today, tests.minDaysAhead)) F('Timetable ends ' + lastTo + ', less than ' + tests.minDaysAhead + ' days ahead');
    if (N.generated > today) F('Generated date is in the future');
    /* expected-by-last-week: what P said would run on day d, per test */
    const days = []; for (let i = 0; i < 7; i++) days.push(addDays(today, i));
    const near = (pl, e, n, r) => Math.hypot(pl.e - e, pl.n - n) <= r;
    const callsAt = (F_, test, d) => { const out = []; F_.services.forEach(s => { const ix = s.places.map((pl, i) => near(pl, test.e, test.n, test.r || 300) ? i : -1).filter(i => i >= 0); if (!ix.length) return;
      s.journeys.forEach(j => { if (!runsOn(j, d, F_.profiles)) return; const t0 = mins(j.start); const c = j.calls.filter(c => ix.indexOf(c.p) >= 0); if (!c.length) return;
        const first = j.calls.indexOf(c[0]), last = j.calls.indexOf(c[c.length - 1]);
        if (first < j.calls.length - 1) out.push({ dep: t0 + c[0].off });
        if (last > 0) out.push({ arr: t0 + c[c.length - 1].off }); }); }); return out; };
    const dayOk = (F_, b, d) => { const c = callsAt(F_, b, d); const outN = c.filter(x => x.dep >= 360 && x.dep <= 720).length, backN = c.filter(x => x.arr >= 780 && x.arr <= 1320).length;
      return { out: outN, back: backN, ok: outN >= 1 && backN >= 2 }; };   /* back ≥ 2: never rely on the last bus */
    /* 4 the base test set: bus out + bus back for every bus base, next 7 days */
    tests.bases.forEach(b => days.forEach(d => { const n = dayOk(N, b, d);
      if (n.ok) return; const p = P ? dayOk(P, b, d) : null; const must = (tests.mustPass || []).indexOf(b.name) >= 0 && (b.mustDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']).indexOf(dow(d)) >= 0;
      const lost = p && p.ok;
      if (lost) F(b.name + ' ' + dow(d) + ' ' + d + ': last week planned bus out + back (' + p.out + ' out, ' + p.back + ' back), now ' + n.out + ' out, ' + n.back + ' back');
      else if (must && !(P && !p.ok)) F(b.name + ' ' + dow(d) + ' ' + d + ': no bus out + back (' + n.out + ' out, ' + n.back + ' back)');
      else W(b.name + ' ' + dow(d) + ' ' + d + ': no bus out + back (same as last week)'); }));
    /* 5 every stop the stored routes use still has buses (unless last week already expected none) */
    let lostStops = 0; const lostNames = [];
    (tests.stops || []).forEach(st => { const t = { e: st[1], n: st[2], r: 50 }; const has = F_ => days.some(d => callsAt(F_, t, d).length);
      if (!has(N) && (!P || has(P))) { lostStops++; if (lostNames.length < 12) lostNames.push(st[0]); } });
    stats.stopsChecked = (tests.stops || []).length;
    if (lostStops) F(lostStops + ' stops used by stored routes lost all buses this week: ' + lostNames.join(', ') + (lostStops > 12 ? '…' : ''));
    return { ok: !fails.length, fails, warns, stats };
  }

  /* Plain-English diff for the weekly report. */
  function diff(N, P) {
    if (!P) return ['First build — nothing to compare'];
    const out = [];
    const by = F_ => { const m = {}; F_.services.forEach(s => m[s.service] = s); return m; };
    const a = by(P), b = by(N);
    Object.keys(Object.assign({}, a, b)).forEach(k => { const x = a[k], y = b[k];
      if (!x) out.push('NEW service ' + k + ': ' + y.journeys.length + ' journeys');
      else if (!y) out.push('GONE service ' + k + ' (had ' + x.journeys.length + ')');
      else { const sig = j => j.start + j.days.join('') + (j.dated || '') + j.calls.map(c => c.p + ':' + c.off).join(',');
        const A = new Set(x.journeys.map(sig)), B = new Set(y.journeys.map(sig));
        const gone = [...A].filter(s => !B.has(s)).length, added = [...B].filter(s => !A.has(s)).length;
        const lastA = x.journeys.reduce((m, j) => j.to > m ? j.to : m, ''), lastB = y.journeys.reduce((m, j) => j.to > m ? j.to : m, '');
        if (gone || added || lastA !== lastB) out.push(k + ': ' + x.journeys.length + ' → ' + y.journeys.length + ' journeys (' + added + ' new/changed, ' + gone + ' gone)' + (lastA !== lastB ? ', runs to ' + lastB + ' (was ' + lastA + ')' : '')); } });
    return out.length ? out : ['No timetable changes'];
  }

  /* Is journey j held (NOT usable as a bus home) on date d? nh = 1 → every date; nh = [[from,to],…] → those dates. Same reading as the app. */
  const inNh = (j, d) => j.nh === 1 || (Array.isArray(j.nh) && j.nh.some(r => d >= r[0] && d <= r[1]));
  /* BUS-HOME CONFIRMATION + VERSION CONFLICTS (owner, 7 Oct). N = new build (journeys still carry _r = GTFS route_id = timetable version), P = last published.
     (1) TWO FEEDS AGREE: a journey on date d is usable as a bus home only if the last published build had the same bus on d —
         same service, same stops in order, every time within ±tol min (small retimes are still 'a bus there'), from an EARLIER BODS feed
         (same feed rebuilt confirms nothing new: it inherits P's held dates). Else the date goes into j.nh. Removals are never held.
     (2) VERSIONS DISAGREE: two versions of a service both covering a date, one explicitly says NO buses that day (date in its off list,
         none of its journeys run) while the other runs buses → every journey of that service is held as a bus home that date.
         Two versions running at slightly different times is NOT a conflict.
     (3) FLIPS: dates in the next 60 days where a service went from some buses to none, or none to some (report only; new ones are held by 1). */
  function confirm(N, P, today, opt) {
    opt = opt || {}; const tol = opt.tolMin != null ? opt.tolMin : 10, end = addDays(today, opt.horizonDays || 400);
    const sameFeed = !!(P && P.feed && N.feed && P.feed.version && P.feed.version === N.feed.version);
    const rep = { held: {}, heldNew: {}, heldList: {}, conflicts: {}, conflictDetail: {}, chosen: [], flips: [], sameFeed, tol };
    const datesOf = j => { const o = []; let d = j.from > today ? j.from : today; const last = j.to < end ? j.to : end; for (let g = 0; d <= last && g < 800; g++, d = addDays(d, 1)) if (runsOn(j, d, N.profiles)) o.push(d); return o; };
    N.services.forEach(s => { const byR = {}; s.journeys.forEach(j => (byR[j._r || ''] = byR[j._r || ''] || []).push(j));
      const rs = Object.keys(byR); if (rs.length < 2) return; const set = new Set();
      rs.forEach(r => { const offs = new Set(); byR[r].forEach(j => (j.off || []).forEach(d => { if (d >= today && d <= end && j.days.indexOf(dow(d)) >= 0) offs.add(d); }));
        offs.forEach(d => { if (byR[r].some(j => runsOn(j, d, N.profiles))) return;
          if (rs.some(r2 => r2 !== r && byR[r2].some(j => runsOn(j, d, N.profiles)))) { if ((opt.choices || {})[s.service + '|' + d]) rep.chosen.push({ service: s.service, date: d, use: opt.choices[s.service + '|' + d] }); else set.add(d); } }); });
      if (set.size) { rep.conflicts[s.service] = [...set].sort();
        /* side-by-side detail for the monitor (view only): what each version says on the first few clash dates */
        const nm = j => s.places[j.calls[0].p].name + ' → ' + s.places[j.calls[j.calls.length - 1].p].name;
        rep.conflictDetail[s.service] = rep.conflicts[s.service].slice(0, 4).map(d => ({ date: d, versions: rs.map(r => { const run = byR[r].filter(j => runsOn(j, d, N.profiles));
          const says = run.length ? run.length + ' buses' : (byR[r].some(j => (j.off || []).indexOf(d) >= 0) ? 'NO buses (date switched off)' : 'not running that day');
          return { version: r, says, buses: run.map(j => j.start + ' ' + nm(j)).slice(0, 40) }; }) })); } });
    const idx = {}; if (P) P.services.forEach(s => s.journeys.forEach(q => { const k = s.service + '|' + q.calls.map(c => c.p).join(','); (idx[k] = idx[k] || []).push(q); }));
    const close = (a, b) => { const ta = mins(a.start), tb = mins(b.start); return a.calls.every((c, i) => Math.abs(ta + c.off - tb - b.calls[i].off) <= tol); };
    N.services.forEach(s => { const cf = new Set(rep.conflicts[s.service] || []); let held = 0, heldNew = 0; const list = [];
      s.journeys.forEach(j => { delete j.nh; if (!P && !cf.size) return;
        const cands = P ? (idx[s.service + '|' + j.calls.map(c => c.p).join(',')] || []).filter(q => close(j, q)) : null;
        const ds = datesOf(j); if (!ds.length) return;
        const bad = ds.map(d => cf.has(d) || (P ? !cands.some(q => runsOn(q, d, P.profiles) && (!sameFeed || !inNh(q, d))) : false));
        if (!bad.some(Boolean)) return;
        held++; if (bad.every(Boolean)) { j.nh = 1; heldNew++; }
        else { const R = []; let st = null, lb = null; ds.forEach((d, i) => { if (bad[i]) { if (!st) st = d; lb = d; } else if (st) { R.push([st, lb]); st = null; } }); if (st) R.push([st, lb]); j.nh = R; }
        if (list.length < 40) list.push({ start: j.start, from: s.places[j.calls[0].p].name, to: s.places[j.calls[j.calls.length - 1].p].name, days: j.days.join(' ') || 'set dates', nh: j.nh }); });
      if (held) { rep.held[s.service] = held; rep.heldNew[s.service] = heldNew; rep.heldList[s.service] = list; } });
    if (P) { const pm = {}; P.services.forEach(s => pm[s.service] = s);
      N.services.forEach(s => { const p = pm[s.service]; if (!p) return; for (let i = 0; i < 60; i++) { const d = addDays(today, i);
        const n = s.journeys.filter(j => runsOn(j, d, N.profiles)).length, o = p.journeys.filter(j => runsOn(j, d, P.profiles)).length;
        if (!n !== !o) rep.flips.push({ service: s.service, date: d, was: o, now: n }); } }); }
    return rep;
  }

  const api = { inNh, confirm, parseCSV, parseLine, toOSGB, build, finalize, checks, diff, runsOn, addDays, ourRoutes, ourTripIds, mins, hhmm, dow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FG_BUS_CORE = api;
})(typeof window !== 'undefined' ? window : globalThis);
