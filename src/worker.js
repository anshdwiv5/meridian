// src/worker.js — Meridian backend (Cloudflare Worker + Static Assets + D1)
//
// Personal, non-commercial stock picker.
//
// Data path (lightweight, on demand — nothing is pre-computed for a universe):
//   • Quantitative: when you view a screen or run an intersection, the Worker
//     fetches ONLY the selected screens from Screener.in, ONLY as deep as the
//     depth you chose (top-50 = one page each), parses the table, and computes
//     the exact overlap in SQL. Results are briefly cached in D1 so re-runs
//     don't re-fetch.
//   • Qualitative: a stock's sections are fetched ONLY when you open it — one
//     fetch of that company's Screener page + a live Yahoo Finance chart.
//
// Screener's ToS allows personal, non-commercial viewing and restricts copying/
// mirroring/public display/commercial use — so keep this private to you. If
// Screener blocks Cloudflare's IPs, the /api/admin/load fallback lets you paste
// or push lists from your own machine. See README.
//
// Routing: /api/* is handled here; everything else is served from /public
// (configured via run_worker_first = ["/api/*"] in wrangler.toml).

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SCREENER = 'https://www.screener.in';
const PER_PAGE = 50;                       // Screener supports ?limit=50 logged-out
const MAX_PAGES = 8;                       // safety cap → up to 400 rows/screen
const SCREEN_TTL_MS = 12 * 3600 * 1000;    // re-fetch a screen at most this often
const COMPANY_TTL_MS = 24 * 3600 * 1000;   // re-fetch a company page at most this often
const ALLOWED_LIMITS = [25, 50, 100, 150, 200];

// The screens (single source of truth for the deployed Worker). `url` is the
// public Screener screen page we read on demand.
const SCREENS = [
  { id:'piotroski', name:'Piotroski Scan', lens:'integrity',
    gauge:'Financial strength & earnings integrity — are the books clean, profitable, and improving?',
    formula:'F-Score = Σ of 9 tests across <b>Profitability</b> (+ve PAT, +ve CFO, ↑ROA, CFO &gt; PAT), <b>Leverage</b> (↓LT-debt ratio, ↑current ratio, no dilution) &amp; <b>Efficiency</b> (↑gross margin, ↑asset turnover). Keep <b>F = 9</b>.',
    url:'https://www.screener.in/screens/2/piotroski-scan/' },
  { id:'magic', name:'Magic Formula', lens:'value',
    gauge:'Cheap and good at once — high return on capital bought at a high earnings yield.',
    formula:'Combined rank of <b>Earnings Yield = EBIT / EV</b> and <b>Return on Capital = EBIT / (Net WC + Net Fixed Assets)</b>. Lower combined rank = better.',
    url:'https://www.screener.in/screens/59/magic-formula/' },
  { id:'coffee', name:'Coffee Can Portfolio', lens:'quality',
    gauge:'Consistent compounders — a decade of steady growth and high returns, no bad years.',
    formula:'For each of last <b>10 years</b>: Sales growth ≥ <b>10%</b> AND ROCE ≥ <b>15%</b>. Market-cap filter applied.',
    url:'https://www.screener.in/screens/57601/coffee-can-portfolio/' },
  { id:'garp', name:'High Growth · High RoE · Low PE', lens:'garp',
    gauge:'Growth at a reasonable price — fast, profitable, and not yet expensive.',
    formula:'<b>Profit CAGR &gt; 20%</b> AND <b>ROE &gt; 18%</b> AND <b>PE &lt; median PE</b> (cheap vs its own history).',
    url:'https://www.screener.in/screens/18/high-growth-high-roe-low-pe/' },
  { id:'value', name:'Value Stocks (Quality)', lens:'quality',
    gauge:'Genuinely good businesses — fat margins, high returns, little debt.',
    formula:'<b>OPM &gt; 15%</b> AND <b>ROCE &gt; 18%</b> AND <b>Debt/Equity &lt; 0.5</b>.',
    url:'https://www.screener.in/screens/184/value-stocks/' },
  { id:'capex', name:'Capacity Expansion', lens:'balance',
    gauge:'Building for the future — heavy capex that should feed tomorrow’s growth.',
    formula:'Net block <b>doubled over 3 yrs</b> OR Gross block + CWIP <b>up &gt; 50% in 1 yr</b>.',
    url:'https://www.screener.in/screens/97687/capacity-expansion/' },
  { id:'debt', name:'Debt Reduction', lens:'balance',
    gauge:'De-leveraging stories — falling debt while the business keeps growing.',
    formula:'<b>Debt/Equity falling</b> across recent years; debt down even as profit / assets rise.',
    url:'https://www.screener.in/screens/126864/debt-reduction/' },
  { id:'graham', name:'Low on 10-Yr Avg Earnings', lens:'value',
    gauge:'Deep value, Graham-style — price low against normalised, decade-averaged earnings.',
    formula:'Price low vs <b>10-year average EPS</b> (normalised P/E). Sales &gt; <b>₹250 cr</b> filter.',
    url:'https://www.screener.in/screens/6994/low-on-10-year-average-earnings/' },
];
const SCREEN_BY_ID = Object.fromEntries(SCREENS.map((s, i) => [s.id, { ...s, sort_order: i }]));

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const p = url.pathname;
  const db = env.DB;
  if (!db) return json({ error: 'D1 binding "DB" is not configured. See README step 3.' }, 500);
  await ensureScreensSeeded(db);

  // GET /api/health
  if (p === '/api/health') return json({ ok: true, screens: SCREENS.length, ts: Date.now() });

  // GET /api/screens  -> all screens + cached match counts + freshness
  if (p === '/api/screens' && request.method === 'GET') {
    const { results } = await db.prepare(`
      SELECT s.id, s.name, s.lens, s.gauge, s.formula, s.screener_url, s.updated_at,
             (SELECT COUNT(*) FROM screen_entries e WHERE e.screen_id = s.id) AS count
      FROM screens s ORDER BY s.sort_order ASC, s.name ASC
    `).all();
    return json({ screens: results });
  }

  // GET /api/screens/:id?limit=N[&refresh=1]  -> ranked list (fetch on demand)
  const mScreen = p.match(/^\/api\/screens\/([^/]+)$/);
  if (mScreen && request.method === 'GET') {
    const id = decodeURIComponent(mScreen[1]);
    const meta = SCREEN_BY_ID[id];
    if (!meta) return json({ error: 'screen not found' }, 404);
    const limit = clampLimit(url.searchParams.get('limit'));
    const force = url.searchParams.get('refresh') === '1';
    const status = await ensureScreen(db, meta, limit, force);
    const { results } = await db.prepare(`
      SELECT rank, symbol, company, metric_label, metric_value
      FROM screen_entries WHERE screen_id = ? ORDER BY rank ASC LIMIT ?
    `).bind(id, limit).all();
    return json({ screen: { id: meta.id, name: meta.name, lens: meta.lens, gauge: meta.gauge, formula: meta.formula, screener_url: meta.url }, entries: results, source: status });
  }

  // POST /api/intersection  { screenIds: string[], limit: number, refresh?: bool }
  // EXACT overlap: a company must appear within the top-`limit` of EVERY selected
  // screen. Returns count:0 (not filler) when nothing overlaps.
  if (p === '/api/intersection' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body.screenIds)
      ? [...new Set(body.screenIds.filter((x) => typeof x === 'string' && SCREEN_BY_ID[x]))] : [];
    const limit = clampLimit(body.limit);
    if (ids.length < 2) return json({ error: 'select at least 2 screens' }, 400);

    // Fetch only the selected screens, only to the chosen depth.
    const sources = {};
    for (const id of ids) sources[id] = await ensureScreen(db, SCREEN_BY_ID[id], limit, !!body.refresh);

    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      SELECT e.symbol AS symbol, MAX(e.company) AS company,
             COUNT(DISTINCT e.screen_id) AS hits, AVG(e.rank) AS avg_rank
      FROM screen_entries e
      WHERE e.screen_id IN (${placeholders}) AND e.rank <= ?
      GROUP BY e.symbol
      HAVING COUNT(DISTINCT e.screen_id) = ?
      ORDER BY avg_rank ASC, company ASC`;
    const { results } = await db.prepare(sql).bind(...ids, limit, ids.length).all();

    const out = [];
    for (const r of results) {
      const s = await db.prepare(
        `SELECT symbol, company, ticker, sector, mcap, roce, pe, de FROM stocks WHERE symbol = ?`
      ).bind(r.symbol).first();
      out.push({
        symbol: r.symbol, company: s?.company || r.company, ticker: s?.ticker ?? r.symbol,
        sector: s?.sector ?? null, mcap: s?.mcap ?? null, roce: s?.roce ?? null,
        pe: s?.pe ?? null, de: s?.de ?? null,
        avg_rank: Math.round((r.avg_rank + Number.EPSILON) * 10) / 10,
      });
    }
    const failed = Object.values(sources).filter((s) => s.error);
    return json({
      count: out.length, limit, screenIds: ids, results: out, sources,
      warning: failed.length ? `Couldn't fetch ${failed.length} screen(s) from Screener — showing what we have. Try Refresh, or load manually.` : null,
    });
  }

  // GET /api/stocks/:symbol  -> fundamentals + parsed detail (fetch company page on demand)
  const mStock = p.match(/^\/api\/stocks\/([^/]+)$/);
  if (mStock && request.method === 'GET') {
    const symbol = decodeURIComponent(mStock[1]);
    const force = url.searchParams.get('refresh') === '1';
    const status = await ensureCompany(db, symbol, force);
    const s = await db.prepare(`SELECT * FROM stocks WHERE symbol = ?`).bind(symbol).first();
    if (!s) return json({ error: 'stock not found', symbol, source: status }, 404);
    let detail = null;
    if (s.detail_json) { try { detail = JSON.parse(s.detail_json); } catch { detail = null; } }
    const { detail_json, ...fields } = s;
    // live price (1 lightweight Yahoo call)
    let live = null;
    try { live = await yahooQuote(fields.ticker || symbol); } catch {}
    if (live && live.price != null) { fields.price = live.price; fields.live = true; }
    return json({ stock: fields, detail, live, source: status });
  }

  // GET /api/chart/:symbol?range=1y&interval=1wk  -> Yahoo history for the in-app chart
  const mChart = p.match(/^\/api\/chart\/([^/]+)$/);
  if (mChart && request.method === 'GET') {
    const symbol = decodeURIComponent(mChart[1]);
    const s = await db.prepare(`SELECT ticker FROM stocks WHERE symbol = ?`).bind(symbol).first();
    const ticker = (s && s.ticker) || symbol;
    const range = (url.searchParams.get('range') || '1y');
    const interval = (url.searchParams.get('interval') || (range === '5y' ? '1mo' : range === '1mo' ? '1d' : '1wk'));
    try {
      const data = await yahooChart(ticker, range, interval);
      return json({ symbol, ticker, ...data });
    } catch (e) {
      return json({ symbol, ticker, error: String(e.message || e), points: [] });
    }
  }

  // ---- Fallback / manual load (used only if Screener blocks the Worker IP) ----
  // POST /api/admin/load  header: x-admin-token
  // body: { screenId, entries:[{rank,symbol,company,metric_label?,metric_value?,ticker?,sector?}], replace?:true }
  if (p === '/api/admin/load' && request.method === 'POST') {
    const auth = checkAdmin(request, env);
    if (!auth.ok) return json({ error: auth.msg }, 401);
    const body = await request.json().catch(() => ({}));
    const meta = SCREEN_BY_ID[body.screenId];
    if (!meta) return json({ error: 'unknown screenId' }, 400);
    const rows = Array.isArray(body.entries) ? body.entries : [];
    if (!rows.length) return json({ error: 'no entries' }, 400);
    await writeScreenEntries(db, meta, rows.map((r, i) => ({
      rank: Number.isFinite(+r.rank) ? +r.rank : i + 1,
      symbol: String(r.symbol || r.ticker || r.company || '').trim(),
      company: String(r.company || r.symbol || '').trim(),
      metric_label: r.metric_label ?? null, metric_value: r.metric_value ?? null,
      ticker: r.ticker || r.symbol || null, sector: r.sector || null,
      pe: numOrNull(r.pe), mcap: numOrNull(r.mcap), roce: numOrNull(r.roce),
    })));
    const c = await db.prepare(`SELECT COUNT(*) n FROM screen_entries WHERE screen_id=?`).bind(meta.id).first();
    return json({ ok: true, screenId: meta.id, loaded: rows.length, total: c.n, protected: auth.protected });
  }

  return json({ error: 'not found' }, 404);
}

/* ============================ screen fetch / cache ============================ */

async function ensureScreensSeeded(db) {
  // Insert the 8 screen metadata rows once; harmless if they already exist.
  const stmts = SCREENS.map((s, i) => db.prepare(
    `INSERT OR IGNORE INTO screens (id,name,lens,gauge,formula,screener_url,sort_order) VALUES (?,?,?,?,?,?,?)`
  ).bind(s.id, s.name, s.lens, s.gauge, s.formula, s.url, i));
  await db.batch(stmts);
}

// Ensure a screen has fresh-enough data to depth `limit`. Returns a status obj.
async function ensureScreen(db, meta, limit, force) {
  const row = await db.prepare(`SELECT updated_at, (SELECT COUNT(*) FROM screen_entries WHERE screen_id=?) n FROM screens WHERE id=?`).bind(meta.id, meta.id).first();
  const fresh = row && row.updated_at && (Date.now() - row.updated_at) < SCREEN_TTL_MS;
  const deep = row && row.n >= limit;
  if (!force && fresh && deep) return { from: 'cache', count: row.n, updated_at: row.updated_at };
  try {
    const entries = await fetchScreen(meta, limit);
    if (!entries.length) throw new Error('no rows parsed from Screener (markup may have changed, or page is empty)');
    await writeScreenEntries(db, meta, entries);
    return { from: 'screener', count: entries.length, updated_at: Date.now() };
  } catch (e) {
    // Fall back to whatever is cached (possibly stale / empty).
    return { from: row && row.n ? 'stale-cache' : 'none', count: (row && row.n) || 0, updated_at: row && row.updated_at, error: String(e.message || e) };
  }
}

// Fetch a screen's ranked list to at least `depth` rows by paginating Screener.
async function fetchScreen(meta, depth) {
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(depth / PER_PAGE)));
  const base = meta.url.replace(/\?.*$/, '');
  const out = [];
  for (let pg = 1; pg <= pages; pg++) {
    const html = await fetchText(`${base}?limit=${PER_PAGE}&page=${pg}`);
    const rows = parseScreenTable(html);
    if (!rows.length) break;
    for (const r of rows) out.push(r);
    if (rows.length < PER_PAGE) break; // last page
    if (out.length >= depth) break;
  }
  // Normalise rank to overall position (Screener's S.No already does this, but be safe).
  return out.map((r, i) => ({ ...r, rank: Number.isFinite(r.rank) ? r.rank : i + 1 }));
}

async function writeScreenEntries(db, meta, entries) {
  const stmts = [db.prepare(`DELETE FROM screen_entries WHERE screen_id=?`).bind(meta.id)];
  const seen = new Set();
  for (const e of entries) {
    const symbol = String(e.symbol || '').trim();
    if (!symbol || seen.has(symbol)) continue;   // PK is (screen_id,symbol)
    seen.add(symbol);
    stmts.push(db.prepare(
      `INSERT INTO screen_entries (screen_id,rank,symbol,company,metric_label,metric_value) VALUES (?,?,?,?,?,?)`
    ).bind(meta.id, e.rank, symbol, e.company || symbol, e.metric_label ?? null, e.metric_value ?? null));
    // upsert a minimal stock row so the Judgement card + intersection metrics work
    stmts.push(db.prepare(
      `INSERT INTO stocks (symbol,company,ticker,sector,mcap,pe,roce) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(symbol) DO UPDATE SET company=excluded.company,
         ticker=COALESCE(excluded.ticker,stocks.ticker),
         sector=COALESCE(excluded.sector,stocks.sector),
         mcap=COALESCE(excluded.mcap,stocks.mcap),
         pe=COALESCE(excluded.pe,stocks.pe),
         roce=COALESCE(excluded.roce,stocks.roce)`
    ).bind(symbol, e.company || symbol, e.ticker || symbol, e.sector ?? null,
           e.mcap ?? null, e.pe ?? null, e.roce ?? null));
  }
  stmts.push(db.prepare(`UPDATE screens SET updated_at=? WHERE id=?`).bind(Date.now(), meta.id));
  // D1 batch is limited; chunk to be safe.
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

/* ============================ Screener HTML parsing ============================ */

function parseScreenTable(html) {
  // Choose the table that actually holds the results — the one with the most
  // /company/ links — regardless of its CSS class.
  const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1]);
  let table = '', best = -1;
  for (const t of tables) { const n = (t.match(/\/company\//g) || []).length; if (n > best) { best = n; table = t; } }
  if (!table || best <= 0) return [];

  // Column headers from the FIRST header row only (Screener repeats the header
  // row inside the table; counting it twice would misplace the score column).
  const headRow = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[0]).find((r) => /<th[\s>]/.test(r)) || '';
  const headerCells = [...headRow.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => stripTags(m[1]).toLowerCase());
  const findCol = (...names) => headerCells.findIndex((h) => names.some((n) => h.includes(n)));
  const peIdx = findCol('p/e', 'pe');
  const mcapIdx = findCol('mar cap', 'market cap');
  const roceIdx = findCol('roce', 'return on capital');
  const scoreIdx = headerCells.length ? headerCells.length - 1 : -1;
  const scoreLabel = scoreIdx >= 0 ? (headerCells[scoreIdx] || 'metric') : 'metric';

  const rows = [];
  for (const m of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tr = m[1];
    const link = /href="\/company\/([^/"]+)\/?[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(tr);
    if (!link) continue;                       // header / spacer rows have no company link
    const code = decodeURIComponent(link[1]).trim();
    const company = decodeEntities(stripTags(link[2])).trim();
    if (!code || !company) continue;
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => decodeEntities(stripTags(c[1])).trim());
    const rank = parseInt((cells[0] || '').replace(/[^\d]/g, ''), 10);
    const val = (i) => (i >= 0 && i < cells.length ? cells[i] : '');
    const scoreVal = scoreIdx >= 0 ? val(scoreIdx) : '';
    rows.push({
      rank: Number.isFinite(rank) ? rank : undefined,
      symbol: code, company,
      pe: numOrNull(val(peIdx)), mcap: numOrNull(val(mcapIdx)), roce: numOrNull(val(roceIdx)),
      ticker: code,
      metric_label: titleCase(scoreLabel), metric_value: scoreVal || null,
    });
  }
  return rows;
}

/* ============================ company-page fetch / parse ============================ */

async function ensureCompany(db, symbol, force) {
  const row = await db.prepare(`SELECT symbol, ticker, fetched_at FROM stocks WHERE symbol=?`).bind(symbol).first();
  if (!row) return { from: 'none', error: 'unknown symbol — add it from a screen first' };
  const fresh = row.fetched_at && (Date.now() - row.fetched_at) < COMPANY_TTL_MS;
  if (!force && fresh) return { from: 'cache', fetched_at: row.fetched_at };
  try {
    const html = await fetchText(`${SCREENER}/company/${encodeURIComponent(symbol)}/consolidated/`);
    const d = parseCompany(html);
    await db.prepare(`
      UPDATE stocks SET company=COALESCE(?,company), sector=COALESCE(?,sector), mcap=COALESCE(?,mcap),
        price=COALESCE(?,price), roce=COALESCE(?,roce), roe=COALESCE(?,roe), pe=COALESCE(?,pe),
        opm=COALESCE(?,opm), de=COALESCE(?,de), div_yield=COALESCE(?,div_yield),
        promoter=COALESCE(?,promoter), fii=COALESCE(?,fii), dii=COALESCE(?,dii),
        sales_cagr=COALESCE(?,sales_cagr), profit_cagr=COALESCE(?,profit_cagr),
        detail_json=?, fetched_at=? WHERE symbol=?`)
      .bind(d.company, d.sector, d.mcap, d.price, d.roce, d.roe, d.pe, d.opm, d.de, d.div_yield,
            d.promoter, d.fii, d.dii, d.sales_cagr, d.profit_cagr,
            JSON.stringify(d.detail || {}), Date.now(), symbol).run();
    return { from: 'screener', fetched_at: Date.now() };
  } catch (e) {
    return { from: row.fetched_at ? 'stale-cache' : 'none', fetched_at: row.fetched_at, error: String(e.message || e) };
  }
}

function parseCompany(html) {
  const out = { detail: {} };
  // --- top ratios list ---
  const ratios = {};
  const ulRatios = (html.match(/id="top-ratios"[\s\S]*?<\/ul>/i) || [])[0] || '';
  for (const li of ulRatios.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const name = stripTags((li[1].match(/class="name"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '').trim();
    const valBlock = (li[1].match(/class="(?:nowrap )?value"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || li[1];
    const num = (valBlock.match(/class="number"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
    const value = decodeEntities(stripTags(num != null ? num : valBlock)).trim();
    if (name) ratios[name.toLowerCase()] = value;
  }
  const R = (...keys) => { for (const k of keys) { for (const key in ratios) if (key.includes(k)) return ratios[key]; } return null; };
  out.mcap = numOrNull(R('market cap'));
  out.price = numOrNull(R('current price'));
  out.pe = numOrNull(R('stock p/e', 'p/e'));
  out.roce = numOrNull(R('roce'));
  out.roe = numOrNull(R('roe'));
  out.div_yield = numOrNull(R('dividend yield'));
  out.detail.ratios = ratios;

  // --- about / sector ---
  const about = decodeEntities(stripTags(((html.match(/class="company-profile[\s\S]*?<p>([\s\S]*?)<\/p>/i) || [])[1] || ''))).trim();
  if (about) out.detail.about = about.slice(0, 1200);
  const peersTitle = (html.match(/<p[^>]*class="[^"]*sub[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
  // sector often appears as a "Sector / Industry" link in the peers heading
  out.sector = decodeEntities(stripTags((html.match(/sector:?\s*<[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '')) || null;

  // --- pros & cons ---
  out.detail.pros = liItems(html.match(/class="pros"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i)?.[1]);
  out.detail.cons = liItems(html.match(/class="cons"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i)?.[1]);

  // --- compounded growth ranges tables (sales / profit / ROE / price) ---
  const ranges = {};
  for (const t of html.matchAll(/<table[^>]*class="[^"]*ranges-table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)) {
    const body = t[1];
    const title = decodeEntities(stripTags((body.match(/<th[^>]*>([\s\S]*?)<\/th>/i) || [])[1] || '')).trim();
    const pairs = {};
    for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => decodeEntities(stripTags(x[1])).trim());
      if (tds.length >= 2) pairs[tds[0].replace(':', '')] = tds[1];
    }
    if (title) ranges[title] = pairs;
  }
  out.detail.ranges = ranges;
  const sg = ranges['Compounded Sales Growth'] || {};
  const pg = ranges['Compounded Profit Growth'] || {};
  out.sales_cagr = numOrNull(sg['5 Years'] || sg['3 Years'] || sg['TTM']);
  out.profit_cagr = numOrNull(pg['5 Years'] || pg['3 Years'] || pg['TTM']);

  // --- shareholding (latest column) ---
  const shTable = (html.match(/id="shareholding"[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i) || [])[1];
  if (shTable) {
    const sh = {};
    for (const tr of shTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => decodeEntities(stripTags(x[1])).trim());
      if (tds.length >= 2) { const label = tds[0].toLowerCase(); sh[label] = tds[tds.length - 1]; }
    }
    out.detail.shareholding = sh;
    out.promoter = numOrNull(sh['promoters'] ?? sh['promoter']);
    out.fii = numOrNull(sh['fiis'] ?? sh['fii']);
    out.dii = numOrNull(sh['diis'] ?? sh['dii']);
  }

  // --- peers (often AJAX-loaded; parse if present) ---
  const peersTable = (html.match(/id="peers"[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i) || [])[1]
    || (html.match(/<table[^>]*class="[^"]*data-table[^"]*"[^>]*>([\s\S]*?)<\/table>/i) || [])[1];
  if (peersTable) {
    const heads = [...(peersTable.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => decodeEntities(stripTags(m[1])).trim());
    const peers = [];
    for (const tr of peersTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const link = /href="\/company\/([^/"]+)\/?[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(tr[1]);
      if (!link) continue;
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => decodeEntities(stripTags(x[1])).trim());
      peers.push({ symbol: decodeURIComponent(link[1]), company: decodeEntities(stripTags(link[2])).trim(), cells: tds });
      if (peers.length >= 12) break;
    }
    if (peers.length) out.detail.peers = { headers: heads, rows: peers };
  }
  return out;
}

/* ============================ Yahoo Finance (live price + chart) ============================ */

function codeToTicker(code) {
  const c = String(code || '').trim();
  if (/^\d+$/.test(c)) return c + '.BO';      // numeric = BSE code
  return c.toUpperCase() + '.NS';             // alpha = NSE symbol
}

async function yahooChart(code, range = '1y', interval = '1wk') {
  const ticker = /\.(NS|BO)$/i.test(code) ? code : codeToTicker(code);
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
  const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, cf: { cacheTtl: 600, cacheEverything: true } });
  if (!r.ok) throw new Error('yahoo chart ' + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no chart data for ' + ticker);
  const ts = res.timestamp || [];
  const close = res.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) if (close[i] != null) points.push({ t: ts[i] * 1000, c: Math.round(close[i] * 100) / 100 });
  const meta = res.meta || {};
  return { ticker, currency: meta.currency || 'INR', price: meta.regularMarketPrice ?? null, prevClose: meta.chartPreviousClose ?? null, points };
}

async function yahooQuote(code) {
  // Use the chart endpoint's meta for a reliable last price without crumb auth.
  const d = await yahooChart(code, '5d', '1d');
  return { ticker: d.ticker, price: d.price ?? (d.points.at(-1)?.c ?? null), prevClose: d.prevClose, currency: d.currency };
}

/* ============================ helpers ============================ */

async function fetchText(u) {
  const r = await fetch(u, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-IN,en;q=0.9' },
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`Screener returned ${r.status} (it may be rate-limiting or blocking server IPs)`);
  return await r.text();
}

function checkAdmin(request, env) {
  const token = request.headers.get('x-admin-token') || '';
  if (!env.ADMIN_TOKEN) return { ok: true, protected: false };     // unset = open (warn in response)
  if (token && token === env.ADMIN_TOKEN) return { ok: true, protected: true };
  return { ok: false, msg: 'bad or missing x-admin-token' };
}

function clampLimit(v) {
  const n = parseInt(v, 10);
  return ALLOWED_LIMITS.includes(n) ? n : 50;
}
function stripTags(s) { return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '); }
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}
function liItems(htmlList) {
  if (!htmlList) return [];
  return [...htmlList.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => decodeEntities(stripTags(m[1])).trim()).filter(Boolean);
}
function numOrNull(v) {
  if (v == null || v === '') return null;
  const x = parseFloat(String(v).replace(/[, %₹]/g, '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(x) ? x : null;
}
function titleCase(s) { return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase()); }

// Named exports for unit tests (no effect on the Worker runtime — these are pure).
export { parseScreenTable, parseCompany, codeToTicker, numOrNull, clampLimit, stripTags, decodeEntities };
