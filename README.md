# Meridian

**A fixed direction in a noisy market** — a personal, long-term Indian-equity stock picker.

A once-a-month, **use-and-close** tool in three steps:

1. **Shortlist** — intersect real [Screener.in](https://www.screener.in) screens to an *exact* shortlist (a name survives only if it’s in the top-N of **every** selected screen).
2. **Research** — for each survivor, six buckets of fetched fundamentals (profile, financials, quality, valuation, industry, governance) **plus an AI thesis**: a structured 10–15-year BUY/WATCH/REJECT verdict written by **Google Gemini**, which uses the fetched data as ground truth and **researches the gaps live from the web**.
3. **Allocation** — the names you flag in research gather here. Sizing & the monthly buy-plan are intentionally out of scope for now.

It runs as a single **Cloudflare Worker** that serves the UI from `/public` and an API from `/api/*`, backed by **D1 (SQLite)**. One deploy, one URL, no CORS, no separate server. All of *your* working state (shortlist, allocation, generated theses) lives only in the browser session — close the tab and it’s gone.

---

## How the data works (read this)

Meridian is **lightweight and on demand** — it never pre-computes a universe.

- **Shortlist (quantitative).** When you view a screen or run an intersection, the Worker fetches **only the selected screens**, **only as deep as the depth you chose**, parses the ranked table, and computes the overlap in SQL — an honest **0** when nothing overlaps. Cached briefly in D1.
- **Research data (quantitative).** A stock’s six data buckets are fetched **only when you open it** — one read of its Screener page (full financial statements, ratios, ownership, peers, docs) plus one **Yahoo Finance** call (live price, 52-week range, return series). Parsed into a clean JSON “packet”.
- **Thesis (qualitative + quantitative).** On **Generate**, the packet is sent to **Gemini 2.5 Flash** with **Google Search grounding** turned on. Gemini treats the packet as ground truth and researches what we *can’t* fetch (industry size, market share, regulation, recent news, concall highlights, forward view), then returns a structured JSON verdict with **cited web sources**. Cached per stock for the session.

### What gets fetched vs not (Screener + Yahoo, the max-coverage free combo)

No single free API covers this whole spec for Indian equities — Screener is the richest free structured source; Yahoo supplies price/returns. The rest is filled by the agent’s web research, never fabricated.

| Your requested data | Source | Status |
|---|---|---|
| Company name, ticker, exchange, sector, market cap, business description | Screener | ✅ Fetched |
| Shares outstanding, free float, promoter %, FII/DII, pledge | Screener (+ computed) | ✅ Fetched |
| Income statement, balance sheet, cash flow (5y annual + 12 quarters) | Screener | ✅ Fetched |
| EBITDA, net debt, FCF, working capital, margins | computed from statements | ✅ Derived |
| ROE / ROCE / ROA, asset turnover, interest cover, D/E, debt/EBITDA, days, CCC, FCF yield, CFO/PAT, CAGRs | Screener (+ computed) | ✅ Fetched/Derived |
| Price, 52-week H/L, 1m–5y returns, volume | Yahoo (+ computed) | ✅ Fetched |
| P/E, P/B, EV/EBITDA, EV/Sales, P/FCF, dividend yield, peer valuation | Screener + Yahoo (+ computed) | ✅ Derived |
| HQ, fiscal year-end, listing date, top *named* institutional holders | — | ⚠️ Not fetched (agent may research) |
| Forward P/E, PEG, beta | — | ⚠️ Not fetched (no free forward estimates) |
| Industry size / TAM / SAM, industry growth, penetration, market share, regulatory & commodity exposure, cyclicality | **Agent web research** | 🔎 Researched live by Gemini, cited |
| Board/auditor changes, related-party, litigation, M&A, product launches, guidance, **recent news** | **Agent web research** | 🔎 Researched live by Gemini, cited |
| Concall transcript **text/summary**, investor-presentation highlights | Screener gives links; **agent researches content** | 🔎 Links fetched, narrative researched |

The thesis prompt is explicit: quote the packet for anything quantitative, research the gaps from the web, label which is which, and **lower confidence when evidence is thin**.

---

## What you must provide (the only things left)

Everything is built. To go live, do these once:

1. **A Google Gemini API key** (free tier) → set it as a Worker secret:
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   ```
   Get one at https://aistudio.google.com/apikey. Until it’s set, the whole app works and the Agent Thesis tab simply shows “add your key”.
2. **(Decision) the data provider.** Default is `screener` and needs nothing. If you later want a structured fundamentals API instead, set `DATA_PROVIDER` in `wrangler.toml` and implement its branch in `fetchCompanyRaw()` (a documented one-function seam) plus `wrangler secret put STOCK_API_KEY`.
3. **Deploy** (and, if your D1 predates the AI agent, run the one-time column upgrade):
   ```bash
   npm install
   npm run db:upgrade      # adds thesis-cache columns to an existing DB (skip on a fresh db:init)
   npx wrangler deploy
   ```

That’s it — after step 1 + deploy the thesis is live.

---

## First-time setup (≈10 minutes)

Node 18+ (22 recommended), npm, a free **Cloudflare account**. D1, Workers, and Workers AI are on the free tier.

```bash
npm install
npx wrangler login
npx wrangler d1 create meridian-db        # prints a database_id (UUID)
#   paste that UUID into wrangler.toml -> [[d1_databases]] database_id
npm run db:init                            # create tables (remote)
npx wrangler secret put ADMIN_TOKEN        # optional: locks the manual-load fallback
npx wrangler secret put GEMINI_API_KEY     # the thesis agent
npx wrangler deploy
```

Run locally: `npm run db:init:local && npx wrangler dev` → http://localhost:8787

### Config knobs (`wrangler.toml` → `[vars]`)
- `THESIS_PROVIDER` — `gemini` (default) or `workers-ai` (no key, on-platform Llama fallback).
- `THESIS_WEB_RESEARCH` — `true` (default) to let Gemini fill gaps via Google Search; `false` for packet-only with strict JSON schema.
- `DATA_PROVIDER` — `screener` (default). The finalise hook for an alternative source.
- `GEMINI_MODEL` / `WORKERS_AI_MODEL` — override model names.

---

## If Screener blocks the Worker’s IP

Screener may rate-limit Cloudflare datacenter IPs. Two fallbacks keep the app accurate:

**A) Load in the app.** Step 1 → **Load a screen manually** → paste the on-screen list / CSV → optional `ADMIN_TOKEN` → load. Intersections then run on that data.

**B) Push from your machine.** Export each screen to `./data/*.csv` (names in `scripts/screens.js`), `npm run ingest` → `seed.real.sql`, then `npm run db:seed:real`.

For a permanent fix, set `SCRAPER_PROXY` (a ScrapingBee/ScraperAPI-style URL template) to route Screener fetches through residential IPs.

---

## API reference

| Method | Route | Returns |
|---|---|---|
| GET | `/api/screens` | All screens + cached counts + freshness |
| GET | `/api/screens/:id?limit=N[&refresh=1]` | One screen’s ranked list (depth 25/50/100) |
| POST | `/api/intersection` | Exact overlap. Body `{ screenIds, limit, refresh }`. `count` is `0` when nothing overlaps. |
| GET | `/api/stocks/:symbol?refresh=1` | Fundamentals + parsed detail + **assembled 6-bucket packet** + live price |
| GET | `/api/chart/:symbol?range=1y` | Yahoo price history for the in-app chart |
| POST | `/api/thesis/:symbol` | Run (or return cached) AI thesis. Body `{ refresh }`. Returns the structured verdict + web sources; `needsKey:true` if `GEMINI_API_KEY` is unset. |
| POST | `/api/admin/load` | Manual fallback load (header `x-admin-token`) |

---

## Project layout

```
src/worker.js          API + Screener/Yahoo fetch & parse + 6-bucket assembler + Gemini thesis agent
public/index.html      3-step UI shell (Shortlist · Research · Allocation)
public/styles.css      light/flat Groww-Zerodha styling (dark mode included)
public/app.js          session state, step nav, data buckets + charts, thesis rendering
schema.sql             D1 tables (now incl. thesis cache)
migrations/0001_*.sql  in-place upgrade for an existing DB
wrangler.toml          Cloudflare config + [ai] binding + vars; paste your database_id
```

### Where to “finalise how stock info is fetched”
`fetchCompanyRaw(symbol)` in `src/worker.js` is the single seam. Default returns the Screener company page (which `parseCompany` understands). To switch sources later, add a branch there keyed on `DATA_PROVIDER` and wire your `STOCK_API_KEY`.

## Notes
- Personal, non-commercial. Screener data under their terms (personal viewing) — keep this deploy private to you.
- The thesis is AI-generated decision *support*, grounded in fetched data + cited web research. Verify before you act; it is not advice.
