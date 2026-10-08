#!/usr/bin/env node
/* Fellgorithm NIGHTLY AUDIT (owner, 7 Oct). Seals one UK day: which timetable was live, every safety state the app was given that day
   (hour by hour, from audit/<date>.jsonl), the app's own safety rules (site/app-rules.json — published with each app release), open and
   resolved problems, data-source health. Writes audit/<date>.md (readable) + audit/<date>.json, and chains each day to the day before with
   a SHA-256 hash (audit/chain.txt) so any later edit to an old day breaks the chain. Committed to git = a dated public record.
   NO personal data. Routes themselves are not stored: any day's routes can be re-created exactly from the timetable checksum + safety
   state + app version recorded here (the planner is deterministic). Usage: node bus-build/audit.mjs [--date YYYY-MM-DD] */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const date = arg('date', new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const lines = (() => { try { return fs.readFileSync(path.join('audit', date + '.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } })();
const meta = readJ('site/buses-meta.json') || {}, hist = (readJ('site/history.json') || []).filter(e => (e.at || '').slice(0, 10) === date);
const AL = readJ('site/alerts.json') || {}, termsV = (AL.terms && +AL.terms.version) || 1;
const termsSince = (() => { let since = null; for (const l of (fs.existsSync('audit') ? fs.readdirSync('audit').filter(f => /\.json$/.test(f) && f !== date + '.json').sort() : [])) { const d = readJ(path.join('audit', l)); if (d && d.terms && d.terms.version === termsV) { since = since || d.terms.since || d.date; } else since = null; } return since || date; })();
const rules = readJ('site/app-rules.json'), probs = (readJ('site/problems.json') || {}).items || [], sig = readJ('site/signals-status.json') || {};
const dayStart = date + 'T00:00:00Z', dayEnd = date + 'T23:59:59Z';
const openToday = probs.filter(p => p.first <= dayEnd && (p.status === 'open' || (p.resolved || '') >= dayStart));
const chain = (() => { try { return fs.readFileSync(path.join('audit', 'chain.txt'), 'utf8').trim().split('\n'); } catch { return []; } })();
const prev = chain.length ? chain[chain.length - 1].split(' ')[1] : 'genesis';
const rec = { schema: 1, date, sealed: new Date().toISOString(), prevHash: prev,
  timetable: { version: meta.version || null, sha256: meta.sha256 || null, feed: meta.feed || null, builds: hist.map(e => ({ at: e.at, ok: e.ok, published: e.published, journeys: e.journeys, held: e.held, gaps: e.gaps, fails: e.fails })) },
  terms: { version: termsV, since: termsSince, wording: AL.terms || 'bundled v1 (in the app)' },
  appRules: rules || 'MISSING — publish site/app-rules.json with each app release', safetyStates: lines, problems: openToday, sources: sig.sources || {} };
const body = JSON.stringify(rec), hash = sha(body);
const st = lines.length ? lines[lines.length - 1].state : null, fmt = t => (t || '').slice(11, 16);
const md = [`# Fellgorithm daily audit — ${date}`, '', `Sealed ${rec.sealed} · this day's hash ${hash.slice(0, 16)}… · previous day ${prev.slice(0, 16)}…`, '',
  '## Terms in use', `- Terms v${termsV} — in use since ${termsSince}. Every phone must accept this whole version before planning; margins can only be switched off under it.`, '',
  '## Timetable live', `- ${rec.timetable.version || '?'} (checksum ${(rec.timetable.sha256 || '?').slice(0, 12)})`, ...rec.timetable.builds.map(b => `- build ${fmt(b.at)}: ${b.ok ? 'published' : 'FAILED — previous kept live'} · ${b.journeys ?? '?'} journeys${(b.gaps || []).length ? ' · gaps ' + b.gaps.join(', ') : ''}`),
  '', '## App safety rules in force', ...(rules ? Object.entries(rules).map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`) : ['- MISSING: site/app-rules.json not published']),
  '', `## Safety state through the day (${lines.length} change${lines.length === 1 ? '' : 's'})`,
  ...(lines.length ? lines.map(l => { const s = l.state; return `- ${fmt(l.at)} UTC · banner ${s.notice && s.notice.on ? 'ON “' + s.notice.text + '”' : 'off'} · your switches ${(s.holds || []).length} · auto road drops ${(s.autoHolds || []).length} · bus disruptions ${(s.disruptions || []).length} · closures ${(s.closures || []).length} · flood warnings ${(s.floods || []).length} · weather ${s.weather ? Object.entries(s.weather.days || {}).map(([d, D]) => d + ': ' + (D.highOff ? 'high fells + scrambles out' : D.scrambleOff ? 'scrambles out' : 'no removals')).join(', ') : 'not set up'} · sources ${Object.entries(s.sources || {}).map(([k, v]) => k + ' ' + v).join(', ')}`; }) : ['- no hourly record for this day']),
  ...(st ? ['', '## Detail at end of day', ...(st.holds || []).map(h => `- your switch: ${h.kind} ${h.service || h.carpark || h.road || h.stop || ''} ${h.from || ''}–${h.to || ''} ${h.reason || ''}`), ...(st.autoHolds || []).map(h => `- auto: ${h.service ? 'bus ' + h.service : h.carpark || 'car parks near closure'} — ${h.reason}`), ...(st.disruptions || []).map(d => `- disruption: ${(d.services || []).join(', ')} ${d.summary}`), ...(st.closures || []).map(c => `- closure: ${c.street} ${c.area || ''}`)] : []),
  '', '## Problems open during the day', ...(openToday.length ? openToday.map(p => `- [${p.sev}] ${p.title}${p.status === 'resolved' ? ' — RESOLVED ' + fmt(p.resolved) + ': ' + p.how : ''}`) : ['- none']),
  '', 'Routes are not stored: they can be re-created exactly from the timetable checksum, the safety states and the app rules above.', ''].join('\n');
fs.mkdirSync('audit', { recursive: true });
fs.writeFileSync(path.join('audit', date + '.json'), body);
fs.writeFileSync(path.join('audit', date + '.md'), md);
fs.appendFileSync(path.join('audit', 'chain.txt'), `${date} ${hash} ${prev}\n`);
fs.writeFileSync('audit-email.md', md);
console.log('[audit]', date, hash);
