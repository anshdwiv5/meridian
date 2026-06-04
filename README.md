# Meridian

**A fixed direction in a noisy market** — a personal, long-term Indian-equity stock picker.

You intersect real [Screener.in](https://www.screener.in) screens to get an **exact** shortlist, then judge each survivor across twelve research sections — business, peers, financials, ownership, management, risks, a live chart — before writing your thesis.

It runs as a single **Cloudflare Worker** that serves the UI from `/public` and an API from `/api/*`, backed by a **D1 (SQLite)** database. One deploy, one URL, no CORS, no separate server.

---

## How the data works (read this)

Meridian is **lightweight and on demand** — it never pre-computes a universe.

- **Quantitative.** When you view a screen or run an intersection, the Worker fetches **only the selected screens**, **only as deep as the depth you chose** (top-50 = one page each), parses the ranked table, and computes the overlap. A company survives only if it appears in the top-N of **every** selected screen — computed in SQL, so you get an honest **0** when nothing overlaps (the old HTML mock fabricated rows; this does not). Results are cached in D1 for ~12h so re-runs don't re-fetch.
- **Qualitative.** A stock's sections are fetched **only when you open it** — one read of that company's Screener page (cached ~24h) plus a **live Yahoo Finance** price and chart. Selected stocks only.

**Source & terms.** Screen and company data are read from Screener.in; price/charts from Yahoo Finance. Screener's Terms grant *personal, non-commercial transitory viewing* and restrict copying, mirroring, public display and commercial use — so **keep this deploy private to you and non-commercial**, and treat the brief D1 cache as a personal convenience. Be a good citizen: the design fetches little and infrequently.

**The one risk you can't know until you deploy:** Screener may rate-limit or block Cloudflare's datacenter IPs. If a screen shows *"couldn't reach Screener,"* use the built-in fallbacks below — you'll never be stuck with fake data.

---

## Get it online (≈10 minutes)

You need **Node 18+** (22 recommended), npm, and a free **Cloudflare account**. D1 and Workers are on the free tier.

```bash
# 1. install
npm install

# 2. log in (opens a browser to authorise Wrangler)
npx wrangler login

# 3. create the database — this prints a database_id (a UUID)
npx wrangler d1 create meridian-db
#    paste that UUID into wrangler.toml -> [[d1_databases]] database_id

# 4. create the tables (remote)
npm run db:init

# 5. (recommended) lock the manual-load fallback with a secret
npx wrangler secret put ADMIN_TOKEN      # type any strong string when prompted

# 6. deploy
npx wrangler deploy
```

Wrangler prints your live URL, e.g. `https://meridian.<your-subdomain>.workers.dev`. Open it → home screen, eight screens under **Quantitative**. Tap a screen to pull it live, tick two and intersect.

> No seeding step. The eight screens self-register on first load; their lists fill in on demand.

### Run locally first (optional)
```bash
npm run db:init:local
npx wrangler dev          # http://localhost:8787
```

---

## If Screener blocks the Worker's IP

Two fallbacks, both keep the app fully accurate:

**A) Load in the app (no terminal).** On the **Quantitative** tab click **“Load a screen manually.”** Pick the screen, paste the on-screen list (one company per line — row order = rank) or a CSV export, enter your `ADMIN_TOKEN`, and load. Repeat per screen. Intersections then run against this data.

**B) Push from your own machine (runs on your residential IP, not Cloudflare's).**
1. Export each screen from Screener (or save the page list) into `./data/` using the `file` names in `scripts/screens.js` (e.g. `data/piotroski.csv`).
2. `npm run ingest` → writes `seed.real.sql`. Then `npm run db:seed:real` to load it.

Your CSVs and `seed.real.sql` are git-ignored.

---

## The twelve judgement sections

Snapshot · Business & Moat · **Industry & Peers** · Growth & Profitability · Financial Health & Earnings Quality · Valuation · Ownership & Smart Money · Management & Governance · Concall & Filings Digest · Charts (live) · Risks & Bear Case · My Thesis.

Most fields come from the company's Screener page (ratios, pros/cons, compounded growth, shareholding, peers); price and the in-app chart come from Yahoo. Anything not reachable shows *"loads when reachable"* — never a fabricated number. Your thesis and conviction are saved per device (localStorage).

---

## API reference

| Method | Route | Returns |
|---|---|---|
| GET | `/api/screens` | All screens + cached counts + freshness |
| GET | `/api/screens/:id?limit=N[&refresh=1]` | One screen's ranked list, fetched to depth N (25/50/100/150/200) |
| POST | `/api/intersection` | Exact overlap. Body `{ "screenIds":["piotroski","value"], "limit":50, "refresh":false }`. `count` is `0` when nothing overlaps. |
| GET | `/api/stocks/:symbol?refresh=1` | Fundamentals + parsed detail + live price for the Qualitative view |
| GET | `/api/chart/:symbol?range=1y` | Yahoo price history for the in-app chart |
| POST | `/api/admin/load` | Fallback manual load (header `x-admin-token`) |

---

## Project layout

```
src/worker.js          API + Screener/Yahoo fetch + parsing + exact intersection (the backend)
public/                UI — index.html, styles.css, app.js
schema.sql             D1 tables
scripts/screens.js     the eight screens (name, lens, formula, Screener URL)
scripts/ingest.mjs     optional: turn CSV exports into seed.real.sql
wrangler.toml          Cloudflare config (paste your database_id here)
```

## Notes
- **Tune freshness** in `src/worker.js`: `SCREEN_TTL_MS` (12h) and `COMPANY_TTL_MS` (24h).
- **Custom domain:** Cloudflare dashboard → Workers & Pages → meridian → Settings → Domains & Routes.
- **Concall summaries** are intentionally a stub — wire an AI step over transcripts later if you want them.
- **Insights** is a deliberate placeholder ("available to you soon") until you decide what belongs there.
- Personal, non-commercial tool. You are responsible for your own use of third-party data under their terms.
