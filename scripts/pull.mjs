// scripts/pull.mjs — fetch your screens from THIS machine's IP (Screener does
// not block residential IPs) and push them straight into your live Meridian
// database via /api/admin/load. Use this whenever the in-app fetch can't reach
// Screener from Cloudflare. Re-run anytime to refresh.
//
// Usage (either form):
//   MERIDIAN_URL=https://meridian.<you>.workers.dev ADMIN_TOKEN=yourtoken npm run pull
//   node scripts/pull.mjs https://meridian.<you>.workers.dev yourtoken
//
// It reuses the SAME parser as the Worker (imported from ../src/worker.js).

import { SCREENS, parseScreenTable } from '../src/worker.js';

const BASE = (process.env.MERIDIAN_URL || process.argv[2] || '').replace(/\/+$/, '');
const TOKEN = process.env.ADMIN_TOKEN || process.argv[3] || '';
if (!BASE) {
  console.error('Missing MERIDIAN_URL. Usage:\n  MERIDIAN_URL=https://meridian.<you>.workers.dev ADMIN_TOKEN=xxx npm run pull');
  process.exit(1);
}

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-IN,en;q=0.9',
};
const PER = 50, DEPTH = 200, MAX_PAGES = Math.ceil(DEPTH / PER);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Pulling ${SCREENS.length} screens → ${BASE}\n`);
let ok = 0;
for (const s of SCREENS) {
  const entries = [];
  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    const u = `${s.url.replace(/\?.*$/, '')}?limit=${PER}&page=${pg}`;
    let r;
    try { r = await fetch(u, { headers: HEADERS }); }
    catch (e) { console.warn(`  ${s.id} p${pg}: ${e.message}`); break; }
    if (!r.ok) { console.warn(`  ${s.id} p${pg}: HTTP ${r.status}`); break; }
    const rows = parseScreenTable(await r.text());
    if (!rows.length) break;
    entries.push(...rows);
    if (rows.length < PER) break;
    await sleep(800); // be gentle on Screener
  }
  if (!entries.length) { console.warn(`✗ ${s.name}: 0 rows parsed — skipped`); continue; }
  const payload = {
    screenId: s.id, replace: true,
    entries: entries.slice(0, DEPTH).map((e, i) => ({
      rank: e.rank || i + 1, symbol: e.symbol, company: e.company,
      metric_label: e.metric_label, metric_value: e.metric_value,
      ticker: e.ticker, pe: e.pe, mcap: e.mcap, roce: e.roce,
    })),
  };
  try {
    const res = await fetch(`${BASE}/api/admin/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { ok++; console.log(`✓ ${s.name}: loaded ${j.loaded} (db total ${j.total})`); }
    else console.warn(`✗ ${s.name}: ${j.error || ('HTTP ' + res.status)}`);
  } catch (e) { console.warn(`✗ ${s.name}: ${e.message}`); }
  await sleep(400);
}
console.log(`\nDone — ${ok}/${SCREENS.length} screens loaded. Reload Meridian and run an intersection.`);
