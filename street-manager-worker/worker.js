/* Fellgorithm — Street Manager catcher (Cloudflare Worker, free plan).
   Street Manager (DfT, OGL v3.0) only PUSHES roadworks/permit events to a web address you host (Amazon SNS). This Worker:
   POST /sns   ← Street Manager: confirms the subscription, verifies every message's Amazon signature, keeps only Cumbria
                 (Cumberland + Westmorland and Furness councils, or a point inside the Lakes box) and stores it in KV (binding WORKS).
   GET  /works.json → the hourly GitHub job: every stored work that has not finished (and not ended more than 2 days ago).
   Setup: see Street Manager Setup in the repo README. Remove-only use: works can only add warnings / take routes out. */
const TOPICS = ['arn:aws:sns:eu-west-2:287813576808:prod-permit-topic', 'arn:aws:sns:eu-west-2:287813576808:prod-activity-topic', 'arn:aws:sns:eu-west-2:287813576808:prod-section-58-topic'];
const AUTH = /cumberland|westmorland|cumbria/i;
const BOX = { e0: 280000, e1: 375000, n0: 470000, n1: 560000 };   // OSGB eastings/northings, Lakes + approaches

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
/* tiny DER walk: X.509 certificate → SubjectPublicKeyInfo bytes (what WebCrypto imports) */
function spkiFromCert(der) {
  const rd = (i) => { let len = der[i + 1], h = 2; if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = len * 256 + der[i + 2 + k]; h = 2 + n; } return { tag: der[i], h, len, end: i + h + len }; };
  const cert = rd(0), tbs = rd(cert.h); let i = cert.h + tbs.h, idx = 0;
  while (i < tbs.end) { const el = rd(i); if (idx === 0 && el.tag === 0xa0) { i = el.end; continue; } if (idx === 5) return der.slice(i, el.end); idx++; i = el.end; }
  throw new Error('no SPKI');
}
async function verify(m) {
  const u = new URL(m.SigningCertURL || m.SigningCertUrl || '');
  if (u.protocol !== 'https:' || !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) throw new Error('bad cert host');
  const pem = await (await fetch(u.toString())).text(), der = b64(pem.replace(/-----[^-]+-----|\s/g, ''));
  const keys = m.Type === 'Notification' ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const str = keys.filter(k => m[k] != null).map(k => k + '\n' + m[k] + '\n').join('');
  const hash = m.SignatureVersion === '2' ? 'SHA-256' : 'SHA-1';
  const key = await crypto.subtle.importKey('spki', spkiFromCert(der), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(m.Signature), new TextEncoder().encode(str))) throw new Error('bad signature');
}
const pick = (o, ...ks) => { for (const k of ks) if (o[k] != null && o[k] !== '') return o[k]; return null; };
function slim(ev, topic) {
  const o = ev.object_data || ev.data || ev, coords = String(pick(o, 'works_location_coordinates', 'activity_coordinates', 'location_coordinates') || '');
  const nums = (coords.match(/-?\d+(\.\d+)?/g) || []).map(Number), E = nums.filter((_, i) => i % 2 === 0), N = nums.filter((_, i) => i % 2 === 1);
  const e = E.length ? E.reduce((a, b) => a + b, 0) / E.length : null, n = N.length ? N.reduce((a, b) => a + b, 0) / N.length : null;
  const auth = String(pick(o, 'highway_authority', 'highway_authority_name') || '');
  if (!AUTH.test(auth) && !(e >= BOX.e0 && e <= BOX.e1 && n >= BOX.n0 && n <= BOX.n1)) return null;
  const tm = String(pick(o, 'traffic_management_type', 'traffic_management_type_ref') || '');
  return { ref: String(pick(o, 'work_reference_number', 'permit_reference_number', 'activity_reference_number', 'section_58_reference_number') || ev.event_reference || ''),
    topic: topic.split(':').pop(), event: ev.event_type || '', auth, street: pick(o, 'street_name', 'street', 'location_description') || '', area: pick(o, 'area_name', 'town') || '',
    usrn: pick(o, 'usrn'), road: pick(o, 'road_category') , tm, closure: /closure/i.test(tm) || /closure/i.test(String(pick(o, 'activity_type', 'section_58_restriction') || '')),
    status: pick(o, 'work_status', 'work_status_ref', 'permit_status', 'activity_status') || '', e: e && Math.round(e), n: n && Math.round(n),
    from: pick(o, 'actual_start_date_time', 'proposed_start_date', 'start_date', 'restriction_start_date'), to: pick(o, 'actual_end_date_time', 'proposed_end_date', 'end_date', 'restriction_end_date'),
    desc: String(pick(o, 'description_of_work', 'activity_name', 'works_category') || '').slice(0, 200), at: ev.event_time || new Date().toISOString() };
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/works.json') {
      const all = JSON.parse((await env.WORKS.get('works')) || '{}'), cut = new Date(Date.now() - 2 * 864e5).toISOString();
      const live = Object.values(all).filter(w => !/completed|closed|cancelled|revoked|refused/i.test(w.status) && !(w.to && w.to < cut));
      return new Response(JSON.stringify({ at: new Date().toISOString(), works: live, licence: 'Contains public sector information licensed under the Open Government Licence v3.0 (Street Manager, DfT).' }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
    if (req.method !== 'POST' || url.pathname !== '/sns') return new Response('Fellgorithm Street Manager catcher', { status: 404 });
    let m; try { m = JSON.parse(await req.text()); } catch { return new Response('bad json', { status: 400 }); }
    if (!TOPICS.includes(m.TopicArn)) return new Response('unknown topic', { status: 403 });
    try { await verify(m); } catch (e) { return new Response('rejected: ' + e.message, { status: 403 }); }
    if (m.Type === 'SubscriptionConfirmation') { const s = new URL(m.SubscribeURL); if (/amazonaws\.com$/.test(s.hostname)) await fetch(s.toString()); return new Response('confirmed'); }
    if (m.Type !== 'Notification') return new Response('ok');
    let ev; try { ev = JSON.parse(m.Message); } catch { return new Response('ok'); }
    const w = slim(ev, m.TopicArn); if (!w || !w.ref) return new Response('ok');
    const all = JSON.parse((await env.WORKS.get('works')) || '{}'), cut = new Date(Date.now() - 30 * 864e5).toISOString();
    all[w.ref] = Object.assign(all[w.ref] || {}, w);
    for (const k in all) if ((all[k].to && all[k].to < cut) || (all[k].at < cut && /completed|closed|cancelled/i.test(all[k].status))) delete all[k];
    await env.WORKS.put('works', JSON.stringify(all));
    return new Response('stored');
  }
};
