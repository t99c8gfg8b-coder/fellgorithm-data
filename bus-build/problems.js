/* PROBLEM LEDGER (owner, 7 Oct). One list of every problem the jobs find — open first, then resolved with HOW it was resolved.
   Each job owns some kinds (its scope): it reports what it sees now; anything of its kinds that was open and is no longer seen is
   closed with a plain-English reason. Problem: {id, kind, sev 'high'|'med'|'low', title, detail, effect (what the app does), source}.
   Resolved problems are kept 180 days. Read by Bus Data Monitor and the daily summary. */
(function (root) {
  const SEV = { high: 0, med: 1, low: 2 };
  function reconcile(ledger, scope, current, nowIso, howFor) {
    ledger = ledger && Array.isArray(ledger.items) ? ledger : { schema: 1, items: [] };
    const cur = new Map(current.map(p => [p.id, p])), opened = [], resolved = [];
    current.forEach(p => { const ex = ledger.items.find(x => x.id === p.id && x.status === 'open');
      if (ex) { const first = ex.first, seen = (ex.seen || 1) + 1; Object.assign(ex, p, { first, last: nowIso, seen, status: 'open' }); }
      else { const n = Object.assign({}, p, { first: nowIso, last: nowIso, seen: 1, status: 'open' }); ledger.items.push(n); opened.push(n); } });
    ledger.items.forEach(p => { if (p.status !== 'open' || !scope.includes(p.kind) || cur.has(p.id)) return;
      p.status = 'resolved'; p.resolved = nowIso; p.how = (howFor && howFor(p)) || ('No longer found in the ' + (p.source || 'data') + ' on ' + nowIso.slice(0, 10)); resolved.push(p); });
    const cut = new Date(Date.parse(nowIso) - 180 * 864e5).toISOString();
    ledger.items = ledger.items.filter(p => p.status === 'open' || (p.resolved || '') >= cut)
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || SEV[a.sev] - SEV[b.sev] || (b.first < a.first ? -1 : 1));
    ledger.updated = nowIso; ledger.schema = 1;
    return { ledger, opened, resolved };
  }
  /* Daily summary for the one GitHub issue comment a day (= one email). */
  function summary(ledger, nowIso, head) {
    const since = new Date(Date.parse(nowIso) - 24 * 3600e3).toISOString(), I = (ledger && ledger.items) || [];
    const open = I.filter(p => p.status === 'open'), nu = open.filter(p => p.first >= since), fixed = I.filter(p => p.status === 'resolved' && p.resolved >= since);
    const line = p => '- **' + p.sev.toUpperCase() + '** ' + p.title + (p.effect ? ' — app: ' + p.effect : '') + ' (since ' + p.first.slice(0, 10) + ')';
    return [head || '', '', '## Open problems (' + open.length + ')', ...(open.length ? open.map(line) : ['- none']),
      '', '## New in the last 24 hours', ...(nu.length ? nu.map(line) : ['- none']),
      '', '## Resolved in the last 24 hours', ...(fixed.length ? fixed.map(p => '- ' + p.title + ' — ' + p.how) : ['- none']), ''].join('\n');
  }
  const api = { reconcile, summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FG_PROBLEMS = api;
})(typeof window !== 'undefined' ? window : globalThis);
