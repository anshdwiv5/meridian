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

import { handleAllocationRoute } from './allocation-agent.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SCREENER = 'https://www.screener.in';
// Full browser-like headers — Screener (and many sites) reject bare requests.
const BROWSER_HEADERS = {
  'user-agent': UA,
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  'referer': 'https://www.screener.in/explore/',
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1',
  'sec-ch-ua': '"Chromium";v="124", "Not:A-Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
  'cache-control': 'no-cache', 'pragma': 'no-cache',
};
const PER_PAGE = 50;                       // Screener supports ?limit=50 logged-out
const MAX_PAGES = 8;                       // safety cap → up to 400 rows/screen
const SCREEN_TTL_MS = 3 * 24 * 3600 * 1000;   // serve cached screen rows for 3 days before re-fetching
const COMPANY_TTL_MS = 7 * 24 * 3600 * 1000;  // serve cached company data for 7 days before re-fetching
const ALLOWED_LIMITS = [25, 50, 100];

// The screens (single source of truth for the deployed Worker). `url` is the
// public Screener screen page we read on demand.
const SCREENS = [
  { id:'piotroski', name:'Piotroski Scan', lenses:['integrity','quality'],
    gauge:'Clean, improving books.',
    formula:'<b>Piotroski score &gt; 7.</b> F-Score adds nine pass/fail tests on profitability, leverage and efficiency; 9 is best.',
    url:'https://www.screener.in/screens/2/piotroski-scan/' },
  { id:'magic', name:'Magic Formula', lenses:['value','quality'],
    gauge:'Cheap and high-return together.',
    formula:'<b>Return on invested capital &gt; 25</b> AND <b>Earnings yield &gt; 15</b> AND Book value &gt; 0 AND Market Capitalization &gt; 15.',
    url:'https://www.screener.in/screens/59/magic-formula/' },
  { id:'growth', name:'Growth Stocks', lenses:['growth','quality'],
    gauge:'High growth at a fair price.',
    formula:'<b>G Factor &ge; 7</b> AND <b>Market Capitalization &gt; 1.</b><span style="display:block;margin-top:6px;color:var(--dim);font-weight:400">G Factor is Screener&rsquo;s growth-quality score out of 10: scored from recent quarterly sales &amp; profit growth and how clean and consistent those earnings are. Higher = stronger, better-quality growth.</span>',
    url:'https://www.screener.in/screens/178/growth-stocks/' },
  { id:'coffee', name:'Coffee Can Portfolio', lenses:['quality','growth'],
    gauge:'Decade-long consistent compounders.',
    formula:'<b>Sales growth &gt; 10%</b> AND <b>Sales growth 10Years &gt; 10%</b> AND <b>Return on equity &gt; 15%</b> AND <b>Average ROCE 10Years &gt; 15%</b> AND Market Capitalization &gt; 1000.',
    url:'https://www.screener.in/screens/57601/coffee-can-portfolio/' },
  { id:'capex', name:'Capacity Expansion', lenses:['growth','balance'],
    gauge:'Building big new capacity.',
    formula:'( (<b>Sales growth 3Years &gt; 12%</b> AND Net block &gt; Net block 3Years back &times; 2) OR (Net block + CWIP &gt; 1.5 &times; preceding-year Net block + CWIP) ) AND Sales last year &gt; 25 AND Debt to equity &lt; 3 AND Market Capitalization &gt; 25.',
    url:'https://www.screener.in/screens/97687/capacity-expansion/' },
  { id:'debt', name:'Debt Reduction', lenses:['balance','growth'],
    gauge:'Cutting debt while still investing.',
    formula:'<b>Debt &lt; Debt 3Years back</b> AND <b>Gross block &gt; 1.2 &times; Gross block preceding year.</b>',
    url:'https://www.screener.in/screens/126864/debt-reduction/' },
  { id:'graham', name:'Low on 10-Yr Avg Earnings', lenses:['value','quality'],
    gauge:'Cheap on 10-year earnings.',
    formula:'<b>Market Capitalization / Average Earnings 10Year &lt; 15</b> AND Average dividend payout 3years &gt; 20 AND Debt to equity &lt; 0.2 AND Average ROCE 7Years &gt; 20.',
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
  PROXY = env.SCRAPER_PROXY || '';
  ENV = env;                       // expose bindings/secrets to the helper layer
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
    return json({ screen: { id: meta.id, name: meta.name, lens: meta.lenses.join(','), gauge: meta.gauge, formula: meta.formula, screener_url: meta.url }, entries: results, source: status });
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
    const r = await buildPacket(db, symbol, force);
    if (r.error) return json({ error: r.error, symbol, source: r.status }, 404);
    return json({ stock: r.fields, detail: r.detail, packet: r.packet, live: r.live, source: r.status });
  }

  // POST /api/thesis/:symbol  { refresh?:bool }  -> run (or return cached) AI thesis
  const mThesis = p.match(/^\/api\/thesis\/([^/]+)$/);
  if (mThesis && request.method === 'POST') {
    const symbol = decodeURIComponent(mThesis[1]);
    const body = await request.json().catch(() => ({}));
    const force = !!body.refresh;
    // Serve the cached verdict unless the user asked to regenerate (saves quota).
    if (!force) {
      const cached = await db.prepare(`SELECT thesis_json, thesis_at FROM stocks WHERE symbol=?`).bind(symbol).first();
      if (cached && cached.thesis_json) {
        try {
          const cj = JSON.parse(cached.thesis_json);
          // Only serve a cache that actually has content — older builds could cache a
          // degenerate empty object, which rendered as a blank WATCH. Those fall
          // through and regenerate automatically.
          if (cj && (cj.executive_thesis || (cj.scores && cj.scores.total != null) || (Array.isArray(cj.bull_case) && cj.bull_case.length))) {
            return json({ symbol, thesis: cj, cached: true, thesis_at: cached.thesis_at });
          }
        } catch {}
      }
    }
    const r = await buildPacket(db, symbol, false);
    if (r.error) return json({ error: r.error, symbol }, 404);
    let thesis;
    try {
      thesis = await runThesis(r.packet, env);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // Soft-fail so the UI can show "add your key" instead of a hard error.
      return json({ symbol, error: msg, needsKey: /api key|GEMINI|not configured|no .*provider/i.test(msg) }, 200);
    }
    await db.prepare(`UPDATE stocks SET thesis_json=?, thesis_at=? WHERE symbol=?`).bind(JSON.stringify(thesis), Date.now(), symbol).run();
    return json({ symbol, thesis, cached: false, thesis_at: Date.now(), gaps: r.packet.gaps });
  }

  // POST /api/allocation  { symbols, monthly_capital?, max_single_pct?, max_sector_pct?, include_watch? }
  //   -> sizes this month's buy plan across the flagged names, from their cached theses.
  if (p === '/api/allocation' && request.method === 'POST') {
    return handleAllocationRoute(request, env, db, json);
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

  // GET /api/quote/:symbol  -> fresh live price for the research view (client polls ~5s).
  // Briefly edge-cached so many pollers don't hammer Yahoo, while staying near-live.
  const mQuote = p.match(/^\/api\/quote\/([^/]+)$/);
  if (mQuote && request.method === 'GET') {
    const symbol = decodeURIComponent(mQuote[1]);
    const s = await db.prepare(`SELECT ticker FROM stocks WHERE symbol = ?`).bind(symbol).first();
    const ticker = (s && s.ticker) || symbol;
    try {
      const q = await yahooLive(ticker);
      return json({ symbol, ticker, ...q });
    } catch (e) {
      return json({ symbol, ticker, error: String(e.message || e) }, 200);
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

  // GET /api/debug/:id  -> show EXACTLY what Cloudflare gets from Screener.
  // Used to tell apart an IP/bot block (403/503/challenge) from a parser miss
  // (200 with company links but 0 parsed rows). Remove once fetch is confirmed.
  const mDebug = p.match(/^\/api\/debug\/([^/]+)$/);
  if (mDebug && request.method === 'GET') {
    const meta = SCREEN_BY_ID[decodeURIComponent(mDebug[1])] || SCREENS[0];
    const direct = meta.url.replace(/\?.*$/, '');
    const target = PROXY ? PROXY + encodeURIComponent(direct) : direct;
    let proxyHost = null; try { if (PROXY) proxyHost = new URL(PROXY).host; } catch {}
    const info = { screen: meta.id, url: direct, viaProxy: !!PROXY, proxyHost };
    try {
      const r = await fetch(target, { headers: BROWSER_HEADERS, redirect: 'follow' });
      const body = await r.text();
      const rows = parseScreenTable(body);
      const ci = body.indexOf('/company/');
      Object.assign(info, {
        status: r.status, ok: r.ok, statusText: r.statusText,
        contentType: r.headers.get('content-type'), server: r.headers.get('server'),
        cfRay: r.headers.get('cf-ray'), cfMitigated: r.headers.get('cf-mitigated'),
        bodyLength: body.length,
        looksLikeChallenge: /just a moment|cf-browser-verification|challenge-platform|captcha/i.test(body),
        companyLinks: (body.match(/\/company\//g) || []).length,
        tableCount: (body.match(/<table/gi) || []).length,
        parsedRows: rows.length, sample: rows.slice(0, 2),
        bodyHead: body.slice(0, 1500),
        aroundCompany: ci >= 0 ? body.slice(Math.max(0, ci - 300), ci + 500) : '(no /company/ link in body)',
      });
    } catch (e) { info.error = String((e && e.message) || e); }
    return json(info);
  }

  return json({ error: 'not found' }, 404);
}

/* ============================ screen fetch / cache ============================ */

async function ensureScreensSeeded(db) {
  // Upsert current screen metadata (so formula/label/gauge edits apply on deploy)…
  const stmts = SCREENS.map((s, i) => db.prepare(
    `INSERT INTO screens (id,name,lens,gauge,formula,screener_url,sort_order) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, lens=excluded.lens, gauge=excluded.gauge,
       formula=excluded.formula, screener_url=excluded.screener_url, sort_order=excluded.sort_order`
  ).bind(s.id, s.name, s.lenses.join(','), s.gauge, s.formula, s.url, i));
  await db.batch(stmts);
  // …and purge any screens that have been removed from the set.
  const ids = SCREENS.map((s) => s.id);
  const ph = ids.map(() => '?').join(',');
  await db.prepare(`DELETE FROM screen_entries WHERE screen_id NOT IN (${ph})`).bind(...ids).run();
  await db.prepare(`DELETE FROM screens WHERE id NOT IN (${ph})`).bind(...ids).run();
}

// Serve cached rows if this screen was fetched within SCREEN_TTL_MS and we hold
// at least `limit` rows; otherwise fetch fresh. On a fetch/parse failure, fall
// back to whatever rows are already in D1 so the UI degrades instead of breaking.
async function ensureScreen(db, meta, limit) {
  const row = await db.prepare(`SELECT updated_at, (SELECT COUNT(*) FROM screen_entries WHERE screen_id=?) n FROM screens WHERE id=?`).bind(meta.id, meta.id).first();
  if (row && row.n > 0 && row.updated_at && (Date.now() - row.updated_at) < SCREEN_TTL_MS)
    return { from: 'cache', count: row.n, updated_at: row.updated_at };
  try {
    const entries = await fetchScreen(meta, limit);
    if (!entries.length) throw new Error('proxy/Screener returned a page but 0 rows parsed (see /api/debug)');
    await writeScreenEntries(db, meta, entries);
    return { from: 'live', count: entries.length, updated_at: Date.now() };
  } catch (e) {
    return { from: row && row.n ? 'stale' : 'none', count: (row && row.n) || 0, updated_at: row && row.updated_at, error: String(e.message || e) };
  }
}

// Fetch a screen's ranked list. Page 1 MUST be the bare screen URL: Screener
// serves results to anonymous visitors there, but bounces query-string requests
// (?limit=, ?page=) to its Register page. So we read page 1 (top ~25) from the
// bare URL, and only paginate deeper if those pages actually return rows — which
// they do once a logged-in SCREENER_COOKIE is supplied; anonymously page 1 is the cap.
async function fetchScreen(meta, depth) {
  const base = meta.url.replace(/\?.*$/, '');
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(depth / 25)));
  const out = [];
  for (let pg = 1; pg <= pages; pg++) {
    const url = pg === 1 ? base : `${base}?page=${pg}`;
    const rows = parseScreenTable(await fetchText(url));
    if (!rows.length) break;                 // pagination gated for anonymous -> stop
    out.push(...rows);
    if (out.length >= depth) break;
  }
  const seen = new Set(), uniq = [];
  for (const r of out) { if (r.symbol && !seen.has(r.symbol)) { seen.add(r.symbol); uniq.push(r); } }
  return uniq.map((r, i) => ({ ...r, rank: Number.isFinite(r.rank) ? r.rank : i + 1 }));
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
    const link = /href="\/company\/(?:id\/)?([^/"]+)\/?[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(tr);
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

// Load a symbol's fundamentals (Screener, cached) + one Yahoo call, then build
// the assembled 6-bucket packet. Shared by /api/stocks (research UI) and
// /api/thesis (agent input) so both see exactly the same data.
async function buildPacket(db, symbol, force) {
  const status = await ensureCompany(db, symbol, force);
  const s = await db.prepare(`SELECT * FROM stocks WHERE symbol = ?`).bind(symbol).first();
  if (!s) return { error: 'stock not found — add it from a screen first', status };
  let detail = {};
  if (s.detail_json) { try { detail = JSON.parse(s.detail_json) || {}; } catch { detail = {}; } }
  const { detail_json, thesis_json, thesis_at, ...fields } = s;
  Object.assign(fields, detail._scalars || {});             // book value, 52w, pledge — no dedicated column
  let chart = null;
  try { chart = await yahooChart(fields.ticker || symbol, '5y', '1mo'); } catch {}
  const market = chart ? {
    price: chart.price, prevClose: chart.prevClose, currency: chart.currency,
    high_52w: chart.high_52w, low_52w: chart.low_52w, volume: chart.volume, exchange: chart.exchange, points: chart.points,
  } : {};
  let live = null;
  if (chart && chart.price != null) { fields.price = chart.price; fields.live = true; live = { price: chart.price, prevClose: chart.prevClose, currency: chart.currency }; }
  const packet = assembleStockData(fields, detail, market);
  return { fields, detail, packet, live, status };
}

async function ensureCompany(db, symbol, force) {
  const row = await db.prepare(`SELECT symbol, ticker, fetched_at FROM stocks WHERE symbol=?`).bind(symbol).first();
  if (!row) return { from: 'none', error: 'unknown symbol, add it from a screen first' };
  if (row.fetched_at && (Date.now() - row.fetched_at) < COMPANY_TTL_MS) return { from: 'cache', fetched_at: row.fetched_at };
  try {
    const html = await fetchCompanyRaw(symbol);
    const d = parseCompany(html);
    // Derive D/E (and let the assembler reuse the same logic) so the step-1 cards
    // have leverage too; stash the extra parsed scalars in detail_json since they
    // have no dedicated column.
    const derived = assembleStockData(d, d.detail || {}, {});
    d.detail = d.detail || {};
    d.detail._scalars = {
      book_value: d.book_value ?? null, face_value: d.face_value ?? null,
      high_52w: d.high_52w ?? null, low_52w: d.low_52w ?? null, pledge: d.pledge ?? null,
    };
    await db.prepare(`
      UPDATE stocks SET company=COALESCE(?,company), sector=COALESCE(?,sector), mcap=COALESCE(?,mcap),
        price=COALESCE(?,price), roce=COALESCE(?,roce), roe=COALESCE(?,roe), pe=COALESCE(?,pe),
        opm=COALESCE(?,opm), de=COALESCE(?,de), div_yield=COALESCE(?,div_yield),
        promoter=COALESCE(?,promoter), fii=COALESCE(?,fii), dii=COALESCE(?,dii),
        sales_cagr=COALESCE(?,sales_cagr), profit_cagr=COALESCE(?,profit_cagr),
        detail_json=?, fetched_at=? WHERE symbol=?`)
      .bind(d.company ?? null, d.sector ?? null, d.mcap ?? null, d.price ?? null, d.roce ?? null, d.roe ?? null, d.pe ?? null,
            d.opm ?? null, derived.quality.debt_to_equity ?? null, d.div_yield ?? null,
            d.promoter ?? null, d.fii ?? null, d.dii ?? null, d.sales_cagr ?? null, d.profit_cagr ?? null,
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
  out.book_value = numOrNull(R('book value'));
  out.face_value = numOrNull(R('face value'));
  // "High / Low" holds TWO numbers in one <li>; grab both directly (the generic
  // value reader stops at the first </span> and would drop the low).
  const hlLi = (ulRatios.match(/high\s*\/\s*low[\s\S]*?<\/li>/i) || [])[0] || '';
  const hlNums = [...hlLi.matchAll(/class="number"[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => numOrNull(stripTags(m[1])));
  if (hlNums.length >= 2) { out.high_52w = hlNums[0]; out.low_52w = hlNums[1]; }
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
      const link = /href="\/company\/(?:id\/)?([^/"]+)\/?[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(tr[1]);
      if (!link) continue;
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => decodeEntities(stripTags(x[1])).trim());
      peers.push({ symbol: decodeURIComponent(link[1]), company: decodeEntities(stripTags(link[2])).trim(), cells: tds });
      if (peers.length >= 12) break;
    }
    if (peers.length) out.detail.peers = { headers: heads, rows: peers };
  }

  // --- FULL financial statements (annual P&L / Balance Sheet / Cash Flow, the
  //     quarterly table, and the ratios table). These live in <section id="…">
  //     blocks that the original parser ignored — they are the backbone of the
  //     research view and the single biggest input to the thesis agent. ---
  out.detail.financials = {
    quarters:      parseDataTable(sliceSection(html, 'quarters')),
    pnl:           parseDataTable(sliceSection(html, 'profit-loss')),
    balance_sheet: parseDataTable(sliceSection(html, 'balance-sheet')),
    cash_flow:     parseDataTable(sliceSection(html, 'cash-flow')),
    ratios:        parseDataTable(sliceSection(html, 'ratios')),
  };
  // Operating margin from the latest annual P&L "OPM %" row (used by step-1 cards).
  const pnlRows = out.detail.financials.pnl?.rows || {};
  const opmKey = Object.keys(pnlRows).find((k) => /opm/i.test(k));
  if (opmKey && pnlRows[opmKey]?.length) out.opm = pnlRows[opmKey].at(-1);

  // --- shareholding TREND (every reported period, not just the latest) + pledge ---
  const shSection = sliceSection(html, 'shareholding');
  const shTrend = parseDataTable(shSection);
  if (shTrend) {
    out.detail.shareholding_trend = shTrend;
    const pledgeKey = Object.keys(shTrend.rows).find((k) => /pledge/i.test(k));
    if (pledgeKey && shTrend.rows[pledgeKey]?.length) out.pledge = shTrend.rows[pledgeKey].at(-1);
  }

  // --- documents: concall transcripts, annual reports, credit ratings, with
  //     date / type / source captured so the UI can render real document cards ---
  out.detail.documents = parseDocuments(sliceSection(html, 'documents'));

  return out;
}

// Extract a single <section id="…">…</section> block. Screener wraps each
// statement in its own non-nested section, so a non-greedy match is safe.
function sliceSection(html, id) {
  const m = html.match(new RegExp('<section[^>]*\\sid="' + id + '"[\\s\\S]*?</section>', 'i'));
  return m ? m[0] : '';
}

// Generic parser for Screener's financial "data-table"s (P&L, Balance Sheet,
// Cash Flow, Quarters, Ratios). Returns { columns:[periods…], rows:{ label:[nums…] } }
// with values aligned to columns. Numbers are parsed; blanks become null.
function parseDataTable(scopeHtml) {
  if (!scopeHtml) return null;
  const tbl = (scopeHtml.match(/<table[^>]*>([\s\S]*?)<\/table>/i) || [])[1];
  if (!tbl) return null;
  const head = (tbl.match(/<thead[\s\S]*?<\/thead>/i) || [])[0] || '';
  let columns = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => decodeEntities(stripTags(m[1])).trim());
  if (columns.length) columns = columns.slice(1); // first header cell is the (empty) label column
  const body = (tbl.match(/<tbody[\s\S]*?<\/tbody>/i) || [])[0] || tbl;
  const rows = {};
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => decodeEntities(stripTags(c[1])).trim());
    if (cells.length < 2) continue;
    const label = cells[0].replace(/[+\-\s]+$/, '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    rows[label] = cells.slice(1).map((v) => numOrNull(v));
  }
  return (columns.length || Object.keys(rows).length) ? { columns, rows } : null;
}

// Parse Screener's "Documents" section into useful, openable items grouped by
// kind. Screener lays this out as headed sub-sections (Annual Reports, Concalls,
// Credit Ratings); within each, <li> rows carry a date label plus one or more
// links (Transcript / Notes / PPT / REC). We capture date + type + source so the
// UI can render real document cards instead of bare links. Degrades gracefully to
// classify-by-link-text when the heading/list structure isn't found.
function parseDocuments(section) {
  const out = { concalls: [], annual_reports: [], ratings: [] };
  if (!section) return out;
  let chunks = [];
  const re = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>([\s\S]*?)(?=<h[1-4][^>]*>|$)/gi;
  let m;
  while ((m = re.exec(section))) chunks.push({ head: decodeEntities(stripTags(m[1])).trim().toLowerCase(), html: m[2] });
  if (!chunks.length) chunks = [{ head: '', html: section }];

  for (const ch of chunks) {
    const bucket = /annual/.test(ch.head) ? 'annual'
      : /rating/.test(ch.head) ? 'rating'
      : /concall|earnings|transcript|presentation/.test(ch.head) ? 'concall' : '';
    const lis = [...ch.html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => x[1]);
    const rows = lis.length ? lis : [ch.html];
    for (const li of rows) {
      const links = [...li.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
        .map((a) => ({ href: decodeEntities(a[1]), label: decodeEntities(stripTags(a[2])).replace(/\s+/g, ' ').trim() }))
        .filter((l) => l.href && /^https?:|^\//i.test(l.href));
      if (!links.length) continue;
      const liText = decodeEntities(stripTags(li.replace(/<a[\s\S]*?<\/a>/gi, ' '))).replace(/\s+/g, ' ').trim();
      const date = matchDate(liText) || matchDate(links.map((l) => l.label).join(' '));
      const source = (liText.match(/from\s+([a-z]{2,5})\b/i) || [])[1] || '';
      for (const l of links) {
        const d = classifyDoc(l, bucket, date, source, liText);
        out[d._bucket].push({ kind: d.kind, type: d.type, title: d.title, date: d.date, source: d.source, href: l.href, isPdf: /\.pdf(\?|#|$)/i.test(l.href) });
      }
    }
  }
  out.concalls = out.concalls.slice(0, 12);
  out.annual_reports = out.annual_reports.slice(0, 8);
  out.ratings = out.ratings.slice(0, 6);
  return out;
}

function classifyDoc(l, bucket, date, source, liText) {
  const label = l.label || '';
  const hay = (label + ' ' + (liText || '')).toLowerCase();
  let kind = bucket || 'concall';
  if (!bucket) {
    if (/annual report|financial year/i.test(hay)) kind = 'annual';
    else if (/rating/i.test(hay)) kind = 'rating';
    else kind = 'concall';
  }
  if (kind === 'annual') {
    const yr = ((label.match(/\b(19|20)\d{2}\b/) || (liText || '').match(/\b(19|20)\d{2}\b/) || [])[0]) || '';
    return { _bucket: 'annual_reports', kind, type: 'Annual Report', title: yr ? `Annual Report ${yr}` : (label || 'Annual Report'), date: yr || date || '', source };
  }
  if (kind === 'rating') {
    return { _bucket: 'ratings', kind, type: 'Credit Rating', title: (label && !/^rating$/i.test(label)) ? label : (date ? `Credit Rating ${date}` : 'Credit Rating'), date, source };
  }
  let type;
  if (/transcript/i.test(label)) type = 'Transcript';
  else if (/notes?/i.test(label)) type = 'Notes';
  else if (/ppt|presentation/i.test(label)) type = 'PPT';
  else if (/\brec\b|recording|audio/i.test(label)) type = 'Recording';
  else if (/concall|earnings/i.test(label)) type = 'Concall';
  else type = label || 'Concall';
  return { _bucket: 'concalls', kind: 'concall', type, title: date ? `${date} ${type}` : type, date, source };
}

// Pull a human date out of free text: "Aug 2024", "Q1 FY24", "FY2024", a year.
function matchDate(s) {
  if (!s) return '';
  const t = String(s);
  let m = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*'?\s*(\d{2,4})\b/i);
  if (m) { const mon = m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase(); const y = m[2].length === 2 ? '20' + m[2] : m[2]; return `${mon} ${y}`; }
  m = t.match(/\bQ[1-4]\s*FY?\s*\d{2,4}\b/i); if (m) return m[0].toUpperCase().replace(/\s+/g, ' ');
  m = t.match(/\bFY\s*\d{2,4}\b/i); if (m) return m[0].toUpperCase().replace(/\s+/g, '');
  m = t.match(/\bFinancial Year\s+(\d{4})\b/i); if (m) return m[1];
  m = t.match(/\b(19|20)\d{2}\b/); if (m) return m[0];
  return '';
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
  return {
    ticker, currency: meta.currency || 'INR',
    price: meta.regularMarketPrice ?? null, prevClose: meta.chartPreviousClose ?? null,
    high_52w: meta.fiftyTwoWeekHigh ?? null, low_52w: meta.fiftyTwoWeekLow ?? null,
    volume: meta.regularMarketVolume ?? null, exchange: meta.exchangeName ?? null,
    points,
  };
}

async function yahooQuote(code) {
  // Use the chart endpoint's meta for a reliable last price without crumb auth.
  const d = await yahooChart(code, '5d', '1d');
  return { ticker: d.ticker, price: d.price ?? (d.points.at(-1)?.c ?? null), prevClose: d.prevClose, currency: d.currency };
}

// Near-live quote for the research view's 5s polling. 1-minute candles give the
// freshest regularMarketPrice; a tiny edge cache shields Yahoo from many pollers.
async function yahooLive(code) {
  const ticker = /\.(NS|BO)$/i.test(code) ? code : codeToTicker(code);
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
  const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, cf: { cacheTtl: 5, cacheEverything: true } });
  if (!r.ok) throw new Error('yahoo quote ' + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no quote for ' + ticker);
  const m = res.meta || {};
  const closes = (res.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
  const price = m.regularMarketPrice ?? (closes.length ? closes[closes.length - 1] : null);
  const prevClose = m.chartPreviousClose ?? m.previousClose ?? null;
  const changePct = (price != null && prevClose) ? (price / prevClose - 1) * 100 : null;
  return {
    ticker, price, prevClose,
    change: (price != null && prevClose != null) ? Math.round((price - prevClose) * 100) / 100 : null,
    changePct: changePct != null ? Math.round(changePct * 100) / 100 : null,
    dayHigh: m.regularMarketDayHigh ?? null, dayLow: m.regularMarketDayLow ?? null,
    high_52w: m.fiftyTwoWeekHigh ?? null, low_52w: m.fiftyTwoWeekLow ?? null,
    volume: m.regularMarketVolume ?? null, currency: m.currency || 'INR', ts: Date.now(),
  };
}

/* ============================ data packet assembly ============================ */
// Shape parsed Screener + Yahoo data into the six research buckets and compute
// derived metrics. PURE function: produces the ONE object the research UI renders
// and the thesis agent reasons over. Null-tolerant throughout; anything that
// can't be sourced for free is recorded in `gaps` so the agent flags it honestly.
function assembleStockData(stock, detail, market) {
  detail = detail || {}; market = market || {};
  const fin = detail.financials || {};
  const pnl = fin.pnl, bs = fin.balance_sheet, cf = fin.cash_flow, rat = fin.ratios, q = fin.quarters;

  const findRow = (t, ...res) => {
    if (!t || !t.rows) return null;
    const keys = Object.keys(t.rows);
    for (const re of res) { const k = keys.find((x) => re.test(x)); if (k) return { label: k, values: t.rows[k], columns: t.columns || [] }; }
    return null;
  };
  const clean = (v) => (v || []).filter((x) => x != null);
  const last = (v) => { const a = clean(v); return a.length ? a[a.length - 1] : null; };
  const first = (v) => { const a = clean(v); return a.length ? a[0] : null; };
  const cagr = (s, e, yrs) => (s > 0 && e > 0 && yrs > 0) ? Math.round((Math.pow(e / s, 1 / yrs) - 1) * 1000) / 10 : null;
  const r2 = (v, d = 2) => v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
  const series = (row) => row ? row.columns.map((c, i) => ({ p: c, v: row.values[i] ?? null })).filter((x) => x.v != null) : [];

  // ---- statement rows ----
  const rev = findRow(pnl, /^sales/i, /revenue/i, /total income/i);
  const op = findRow(pnl, /operating profit/i);
  const opmR = findRow(pnl, /opm/i);
  const dep = findRow(pnl, /depreciation/i);
  const intR = findRow(pnl, /interest/i);
  const pat = findRow(pnl, /net profit/i, /profit after tax/i);
  const eps = findRow(pnl, /eps/i);
  const borrow = findRow(bs, /borrowing/i);
  const eqCap = findRow(bs, /equity capital/i);
  const reserves = findRow(bs, /reserves/i);
  const totAssets = findRow(bs, /total assets/i);
  const cashRow = findRow(bs, /^cash/i, /cash & bank/i, /cash and bank/i);
  const cfo = findRow(cf, /operating activ/i);
  const cfi = findRow(cf, /investing activ/i);
  const roceR = findRow(rat, /roce/i);
  const debtorD = findRow(rat, /debtor days/i, /receivable days/i);
  const invD = findRow(rat, /inventory days/i);
  const payD = findRow(rat, /days payable/i, /payable days/i);
  const cccR = findRow(rat, /cash conversion/i);
  const wcD = findRow(rat, /working capital days/i);

  // ---- latest scalars ----
  const lRev = last(rev?.values), lOP = last(op?.values), lDep = last(dep?.values);
  const lPAT = last(pat?.values), lInt = last(intR?.values), lDebt = last(borrow?.values);
  const lCash = last(cashRow?.values), lAssets = last(totAssets?.values);
  const lCFO = last(cfo?.values), lCFI = last(cfi?.values);
  const equity = ((last(eqCap?.values) || 0) + (last(reserves?.values) || 0)) || null;
  // Screener "Operating Profit" excludes depreciation ⇒ ≈ EBITDA; EBIT = OP − Dep.
  const ebitda = lOP, ebit = (lOP != null) ? lOP - (lDep || 0) : null;
  const netDebt = (lDebt != null && lCash != null) ? lDebt - lCash : null;
  const de = (lDebt != null && equity) ? r2(lDebt / equity) : (stock.de ?? null);
  const fcf = (lCFO != null) ? lCFO + (lCFI || 0) : null; // CFI is net of capex (negative)
  const ev = (stock.mcap != null) ? stock.mcap + (netDebt != null ? netDebt : (lDebt || 0)) : null;

  // ---- CAGRs from the annual series ----
  const yrs = (v) => Math.max(1, clean(v).length - 1);
  const revCAGR = rev ? cagr(first(rev.values), last(rev.values), yrs(rev.values)) : null;
  const patCAGR = pat ? cagr(first(pat.values), last(pat.values), yrs(pat.values)) : null;
  const epsCAGR = eps ? cagr(first(eps.values), last(eps.values), yrs(eps.values)) : null;

  // ---- valuation ----
  const price = market.price ?? stock.price ?? null;
  const pb = (price != null && stock.book_value) ? r2(price / stock.book_value) : null;

  // ---- chart-ready paired series ----
  const fcfSeries = (cfo) ? cfo.columns.map((c, i) => {
    const o = cfo.values[i], inv = cfi ? cfi.values[i] : null;
    return { p: c, v: (o != null ? o + (inv || 0) : null) };
  }).filter((x) => x.v != null) : [];
  const npmSeries = (rev && pat) ? rev.columns.map((c, i) => {
    const s = rev.values[i], p = pat.values[i];
    return { p: c, v: (s ? Math.round((p / s) * 1000) / 10 : null) };
  }).filter((x) => x.v != null) : [];

  const packet = {
    as_of: new Date().toISOString().slice(0, 10),
    profile: {
      company: stock.company, symbol: stock.symbol, ticker: stock.ticker,
      exchange: market.exchange || (/^\d+$/.test(String(stock.symbol)) ? 'BSE' : 'NSE'),
      sector: stock.sector || null, about: detail.about || null,
      market_cap_cr: stock.mcap ?? null,
      shares_outstanding_cr: (stock.mcap != null && price) ? r2(stock.mcap / price) : null,
      promoter_pct: stock.promoter ?? null, pledge_pct: stock.pledge ?? null,
      fii_pct: stock.fii ?? null, dii_pct: stock.dii ?? null,
      public_pct: (stock.promoter != null && stock.fii != null && stock.dii != null) ? r2(Math.max(0, 100 - stock.promoter - stock.fii - stock.dii), 1) : null,
      face_value: stock.face_value ?? null, book_value: stock.book_value ?? null,
    },
    financials: {
      annual: { pnl, balance_sheet: bs, cash_flow: cf }, quarterly: q,
      charts: {
        revenue: series(rev), pat: series(pat), opm: series(opmR), net_margin: npmSeries,
        ocf: series(cfo), investing_cf: series(cfi), fcf: fcfSeries,
        debt: series(borrow), cash: series(cashRow), reserves: series(reserves),
      },
    },
    quality: {
      roce_pct: stock.roce ?? last(roceR?.values), roce_trend: series(roceR),
      roe_pct: stock.roe ?? null,
      roa_pct: (lPAT != null && lAssets) ? r2(lPAT / lAssets * 100) : null,
      asset_turnover: (lRev != null && lAssets) ? r2(lRev / lAssets) : null,
      interest_coverage: (ebit != null && lInt) ? r2(ebit / lInt) : null,
      debt_to_equity: de, debt_to_ebitda: (lDebt != null && ebitda) ? r2(lDebt / ebitda) : null,
      total_debt_cr: lDebt, net_debt_cr: r2(netDebt), ebitda_cr: r2(ebitda),
      debtor_days: last(debtorD?.values), inventory_days: last(invD?.values),
      payable_days: last(payD?.values), cash_conversion_cycle: last(cccR?.values), working_capital_days: last(wcD?.values),
      fcf_yield_pct: (fcf != null && stock.mcap) ? r2(fcf / stock.mcap * 100) : null,
      cfo_to_pat: (lCFO != null && lPAT) ? r2(lCFO / lPAT) : null,
      revenue_cagr_pct: revCAGR ?? stock.sales_cagr ?? null, pat_cagr_pct: patCAGR ?? stock.profit_cagr ?? null, eps_cagr_pct: epsCAGR,
    },
    valuation: {
      price, high_52w: market.high_52w ?? stock.high_52w ?? null, low_52w: market.low_52w ?? stock.low_52w ?? null,
      pe: stock.pe ?? null, pb, ev_ebitda: (ev != null && ebitda) ? r2(ev / ebitda) : null,
      ev_sales: (ev != null && lRev) ? r2(ev / lRev) : null, p_fcf: (stock.mcap != null && fcf) ? r2(stock.mcap / fcf) : null,
      dividend_yield_pct: stock.div_yield ?? null, returns: computeReturns(market.points || []),
      volume: market.volume ?? null, ranges: detail.ranges || null, peers: detail.peers || null,
    },
    industry: {
      sector: stock.sector || null, peers: detail.peers || null,
      industry_size: null, industry_growth: null, market_share: null, // not in free structured sources
    },
    governance: {
      promoter_pct: stock.promoter ?? null, pledge_pct: stock.pledge ?? null,
      shareholding_trend: detail.shareholding_trend || null,
      pros: detail.pros || [], cons: detail.cons || [], documents: detail.documents || null,
    },
    gaps: [],
  };

  const G = packet.gaps;
  if (packet.valuation.pe == null) G.push('current P/E');
  if (!packet.valuation.peers) G.push('peer comparison (Screener loads it dynamically; may be absent)');
  if (packet.profile.about == null) G.push('business description');
  if (netDebt == null) G.push('net debt (no explicit cash row on Screener; gross debt shown)');
  G.push('forward P/E & PEG (no free forward estimates)');
  G.push('beta');
  G.push('industry TAM / market share / regulatory detail (not in free structured sources)');
  G.push('concall transcript text & recent news (document links only in this build)');
  return packet;
}

// 1m/3m/6m/1y/3y/5y price returns (%) from a Yahoo close series [{t,c}].
function computeReturns(points) {
  if (!points || points.length < 2) return {};
  const now = points[points.length - 1];
  const at = (days) => {
    const target = now.t - days * 86400000; let best = points[0];
    for (const p of points) if (Math.abs(p.t - target) < Math.abs(best.t - target)) best = p;
    return best;
  };
  const r = (p) => (p && p.c) ? Math.round((now.c / p.c - 1) * 1000) / 10 : null;
  return { '1m': r(at(30)), '3m': r(at(91)), '6m': r(at(182)), '1y': r(at(365)), '3y': r(at(1095)), '5y': r(at(1825)) };
}

/* ============================ thesis agent ============================ */
// The equity-research system prompt (your spec). The model sees ONLY the data
// packet assembled above, so it can't invent facts and must flag what's missing.
const THESIS_SYSTEM_PROMPT = `You are an equity research analyst building a long-term (10-15 year) investment thesis for a monthly portfolio review system. You analyse ONE Indian-listed company at a time.

DATA YOU RECEIVE
A JSON "packet" of quantitative data fetched from Screener.in + Yahoo Finance: company profile, full historical financials (P&L, balance sheet, cash flow, quarterly results), efficiency/quality ratios, valuation multiples, ownership, peers, pros/cons, and a "gaps" array naming what could NOT be fetched.

HOW TO USE THE DATA
1. Treat the packet as your quantitative GROUND TRUTH. Quote its numbers; never contradict or invent them.
2. For anything in the "gaps" array or otherwise missing — industry size / TAM, industry growth rate, market share, competitive position, regulatory & commodity exposure, recent news, board/auditor/litigation events, concall & management commentary, forward estimates — USE GOOGLE SEARCH to research it from reputable, recent sources.
3. In your prose, clearly distinguish packet facts ("reported financials show…") from web-researched facts ("recent industry sources indicate…").
4. Do NOT fabricate. If neither the packet nor a credible web search gives a reliable answer, say so explicitly and lower your confidence.
5. Do NOT use short-term price action as a thesis driver. Focus on durable 10-15 year compounding.

The investor buys monthly, holds 10-15 years, and wants a disciplined process that can beat index funds over time. The output feeds both a human and a UI dashboard.

EVALUATE across: business quality, growth runway, moat, financial strength, cash generation, valuation, management/governance, industry structure, risks/bear case, catalysts/forward view.

SCORING (integers): growth_runway 0-5, moat 0-5, financial_quality 0-5, management_governance 0-5, valuation 0-5, industry_attractiveness 0-5, risk_penalty 0-5 (SUBTRACTED). total = (sum of the six positives) − risk_penalty, range −5 to 30.

DECISION RULES
- BUY only with durable quality, acceptable valuation, and a believable 10-year compounding path.
- WATCH if the business is good but valuation, evidence, or risk profile is incomplete.
- REJECT if the thesis leans on weak evidence, fragile economics, poor governance, or a broken balance sheet.

confidence is 0-100 and MUST be lower when packet gaps are large or web evidence is thin.

OUTPUT — return ONLY one valid JSON object (no markdown fences, no preamble) with EXACTLY these keys:
{
 "executive_thesis": "one paragraph",
 "bull_case": ["3-5 evidence-backed points"],
 "bear_case": ["3-5 evidence-backed points"],
 "moat_assessment": "",
 "financial_quality": "",
 "valuation_assessment": "",
 "industry_assessment": "",
 "management_assessment": "",
 "key_risks": [],
 "key_catalysts": [],
 "scores": { "growth_runway":0, "moat":0, "financial_quality":0, "management_governance":0, "valuation":0, "industry_attractiveness":0, "risk_penalty":0, "total":0 },
 "verdict": "BUY | WATCH | REJECT",
 "confidence": 0,
 "what_would_change_my_mind": []
}`;

// One canonical JSON Schema (standard / lowercase) used directly by Workers AI;
// converted to Gemini's uppercase OpenAPI dialect by toGeminiSchema().
const THESIS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    executive_thesis: { type: 'string' },
    bull_case: { type: 'array', items: { type: 'string' } },
    bear_case: { type: 'array', items: { type: 'string' } },
    moat_assessment: { type: 'string' },
    financial_quality: { type: 'string' },
    valuation_assessment: { type: 'string' },
    industry_assessment: { type: 'string' },
    management_assessment: { type: 'string' },
    key_risks: { type: 'array', items: { type: 'string' } },
    key_catalysts: { type: 'array', items: { type: 'string' } },
    scores: {
      type: 'object',
      properties: {
        growth_runway: { type: 'integer' }, moat: { type: 'integer' }, financial_quality: { type: 'integer' },
        management_governance: { type: 'integer' }, valuation: { type: 'integer' }, industry_attractiveness: { type: 'integer' },
        risk_penalty: { type: 'integer' }, total: { type: 'integer' },
      },
      required: ['growth_runway', 'moat', 'financial_quality', 'management_governance', 'valuation', 'industry_attractiveness', 'risk_penalty', 'total'],
    },
    verdict: { type: 'string', enum: ['BUY', 'WATCH', 'REJECT'] },
    confidence: { type: 'integer' },
    what_would_change_my_mind: { type: 'array', items: { type: 'string' } },
  },
  required: ['executive_thesis', 'bull_case', 'bear_case', 'moat_assessment', 'financial_quality', 'valuation_assessment',
    'industry_assessment', 'management_assessment', 'key_risks', 'key_catalysts', 'scores', 'verdict', 'confidence', 'what_would_change_my_mind'],
};

function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (s && typeof s === 'object') {
    const o = {};
    for (const k in s) {
      if (k === 'additionalProperties') continue;               // Gemini rejects this
      if (k === 'type' && typeof s[k] === 'string') o[k] = s[k].toUpperCase();
      else o[k] = toGeminiSchema(s[k]);
    }
    return o;
  }
  return s;
}

// Provider-abstracted entry point. Default = Google Gemini (best free quality +
// 1M context); Workers AI is the zero-key fallback. Swap with THESIS_PROVIDER.
async function runThesis(packet, env) {
  const provider = String(env.THESIS_PROVIDER || 'gemini').toLowerCase();
  const userContent = 'Company data packet (use ONLY this):\n```json\n' + JSON.stringify(packet) + '\n```';
  if (provider === 'gemini') return await runThesisGemini(env, userContent);
  if (provider === 'workers-ai' || provider === 'workersai' || provider === 'cf') return await runThesisWorkersAI(env, userContent);
  throw new Error(`unknown THESIS_PROVIDER "${provider}"`);
}

async function runThesisGemini(env, userContent) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured — set it with: wrangler secret put GEMINI_API_KEY');
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const webResearch = String(env.THESIS_WEB_RESEARCH ?? 'true').toLowerCase() !== 'false';

  // Attempt 1 — grounded (Google Search) for the richest thesis. JSON is enforced
  // by the prompt and parsed defensively. Gemini 2.5 "thinks" by default and those
  // tokens are billed against the output budget, so we cap thinking AND give a
  // generous output ceiling; otherwise large-company packets (e.g. Bajaj Auto)
  // truncate the JSON and the verdict comes back empty — the root cause of the
  // "works for some stocks, not others" bug.
  if (webResearch) {
    try {
      return await callGemini(key, model, userContent, { tools: [{ google_search: {} }], thinkingBudget: 6144, maxOutputTokens: 32768 });
    } catch (e) {
      console.log('thesis: grounded attempt failed, falling back to schema mode —', String((e && e.message) || e));
    }
  }
  // Attempt 2 (and the no-web-research path) — schema-locked JSON, tools off,
  // thinking off. This reliably returns one complete, valid object for every
  // stock, so a truncated or blocked grounded call never leaves the user with a
  // blank verdict.
  return await callGemini(key, model, userContent, {
    responseMimeType: 'application/json', responseSchema: toGeminiSchema(THESIS_JSON_SCHEMA),
    thinkingBudget: 0, maxOutputTokens: 16384,
  });
}

// One Gemini call → a validated, normalized thesis object (or throws). Centralises
// request shaping, finishReason handling, defensive JSON parsing and grounding.
async function callGemini(key, model, userContent, opts = {}) {
  const u = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const generationConfig = { temperature: 0.4, maxOutputTokens: opts.maxOutputTokens || 16384 };
  if (opts.responseMimeType) generationConfig.responseMimeType = opts.responseMimeType;
  if (opts.responseSchema) generationConfig.responseSchema = opts.responseSchema;
  // thinkingConfig is only valid on the 2.5 family — guard so custom models don't 400.
  if (opts.thinkingBudget != null && /2[.\-]5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
  const reqBody = {
    systemInstruction: { parts: [{ text: THESIS_SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig,
  };
  if (opts.tools) reqBody.tools = opts.tools;

  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqBody) });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Gemini HTTP ${r.status}: ${t.slice(0, 300)}`); }
  const j = await r.json();
  const cand = j?.candidates?.[0];
  const finish = cand?.finishReason;
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned no content' + (finish ? ` (finishReason ${finish})` : '') + (j?.promptFeedback ? ` ${JSON.stringify(j.promptFeedback)}` : ''));

  let thesis;
  try { thesis = normalizeThesis(safeParseThesis(text)); }
  catch (e) { throw new Error((finish === 'MAX_TOKENS' ? 'thesis JSON truncated (MAX_TOKENS) — ' : '') + String((e && e.message) || e)); }

  // Attach grounding citations (the web sources the model used) for transparency.
  const gm = cand?.groundingMetadata;
  if (gm) {
    const sources = (gm.groundingChunks || []).map((c) => (c.web ? { title: c.web.title || c.web.uri, uri: c.web.uri } : null)).filter(Boolean);
    const seen = new Set(), uniq = [];
    for (const s of sources) { if (s.uri && !seen.has(s.uri)) { seen.add(s.uri); uniq.push(s); } }
    if (uniq.length) thesis._sources = uniq.slice(0, 12);
    if (gm.webSearchQueries?.length) thesis._search_queries = gm.webSearchQueries;
  }
  return thesis;
}

async function runThesisWorkersAI(env, userContent) {
  if (!env.AI) throw new Error('no thesis provider configured — set GEMINI_API_KEY, or add the [ai] binding for the Workers AI fallback');
  const model = env.WORKERS_AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const res = await env.AI.run(model, {
    messages: [
      { role: 'system', content: THESIS_SYSTEM_PROMPT },
      { role: 'user', content: userContent + '\n\nReturn ONLY valid JSON matching the required schema.' },
    ],
    response_format: { type: 'json_schema', json_schema: THESIS_JSON_SCHEMA },
    max_tokens: 4096,
  });
  const out = res && (res.response ?? res);
  return normalizeThesis(typeof out === 'string' ? safeParseThesis(out) : out);
}

// Coerce whatever the model returned into the exact shape the UI expects, filling
// safe defaults and computing `total` when the model omits it. Throws on a
// degenerate/empty object so the caller can fall back instead of caching (and the
// UI rendering) a blank verdict.
function normalizeThesis(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('thesis is not a JSON object');
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim()).map((x) => String(x).trim()) : []);
  const str = (v) => (v == null ? '' : String(v).trim());
  const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; };
  const s = t.scores && typeof t.scores === 'object' ? t.scores : {};
  const pos = ['growth_runway', 'moat', 'financial_quality', 'management_governance', 'valuation', 'industry_attractiveness'];
  const scores = {};
  for (const k of pos) scores[k] = int(s[k]);
  scores.risk_penalty = int(s.risk_penalty);
  scores.total = int(s.total);
  if (scores.total == null && pos.some((k) => scores[k] != null)) {
    scores.total = pos.reduce((a, k) => a + (scores[k] || 0), 0) - (scores.risk_penalty || 0);
  }
  let verdict = str(t.verdict).toUpperCase();
  if (!['BUY', 'WATCH', 'REJECT'].includes(verdict)) verdict = 'WATCH';
  const exec = str(t.executive_thesis);
  const bull = arr(t.bull_case), bear = arr(t.bear_case);
  // Reject the empty shell that previously slipped through and rendered as a blank WATCH.
  if (!exec && !bull.length && !bear.length && scores.total == null) throw new Error('thesis came back empty');
  return {
    executive_thesis: exec, bull_case: bull, bear_case: bear,
    moat_assessment: str(t.moat_assessment), financial_quality: str(t.financial_quality),
    valuation_assessment: str(t.valuation_assessment), industry_assessment: str(t.industry_assessment),
    management_assessment: str(t.management_assessment),
    key_risks: arr(t.key_risks), key_catalysts: arr(t.key_catalysts),
    scores, verdict,
    confidence: Math.max(0, Math.min(100, int(t.confidence) ?? 0)),
    what_would_change_my_mind: arr(t.what_would_change_my_mind),
  };
}

function safeParseThesis(text) {
  const raw = String(text == null ? '' : text);
  const t = raw.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch {}
  const balanced = extractBalancedJson(t);
  if (balanced) { try { return JSON.parse(balanced); } catch {} }
  throw new Error('model did not return valid JSON');
}

// Return the first complete, brace-balanced {...} object, ignoring any prose or
// grounding text around it. Returns null if the braces never balance (truncated
// output), which signals the caller to retry/fallback rather than parse garbage.
function extractBalancedJson(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, escd = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (escd) escd = false; else if (c === '\\') escd = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/* ============================ helpers ============================ */

// Optional scraping-proxy escape hatch. Set the SCRAPER_PROXY secret to a
// template that takes a URL-encoded target (e.g. a ScrapingBee/ScraperAPI URL
// ending in "&url=") to route Screener fetches through residential/rotating IPs
// and bypass datacenter blocks. Set per request from env in handleApi.
let PROXY = '';
let ENV = null;                    // set per-request in handleApi; read by the helper layer
async function fetchText(u) {
  const target = PROXY ? PROXY + encodeURIComponent(u) : u;
  const r = await fetch(target, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!r.ok) throw new Error(`Screener returned HTTP ${r.status}`);
  return await r.text();
}

// ── Data-provider seam (the "finalise how to fetch stock info" hook) ──────────
// One place that decides WHERE a company's data comes from. Default = Screener
// (scrape the company page → parseCompany understands that HTML). To finalise a
// different source later, set DATA_PROVIDER + its key in wrangler/secrets and add
// a branch returning HTML the parser understands (or refactor parseCompany to
// accept JSON). Nothing else in the app needs to change.
async function fetchCompanyRaw(symbol) {
  const provider = (ENV && ENV.DATA_PROVIDER) || 'screener';
  if (provider === 'screener') {
    return await fetchText(`${SCREENER}/company/${encodeURIComponent(symbol)}/consolidated/`);
  }
  // Example skeleton for a structured fundamentals API (left as the finalise hook):
  //   if (provider === 'fmp') {
  //     const key = ENV.STOCK_API_KEY;
  //     const r = await fetch(`https://financialmodelingprep.com/api/v3/...&apikey=${key}`);
  //     return await r.text();   // then adapt parseCompany to read this shape
  //   }
  throw new Error(`unknown DATA_PROVIDER "${provider}" — implement its branch in fetchCompanyRaw()`);
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
export { SCREENS, parseScreenTable, parseCompany, parseDataTable, sliceSection, assembleStockData, computeReturns, toGeminiSchema, THESIS_JSON_SCHEMA, codeToTicker, numOrNull, clampLimit, stripTags, decodeEntities, BROWSER_HEADERS, parseDocuments, classifyDoc, matchDate, safeParseThesis, extractBalancedJson, normalizeThesis };
