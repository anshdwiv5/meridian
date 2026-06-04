-- schema.sql — Meridian D1 (SQLite) schema
-- Apply with:  wrangler d1 execute meridian-db --remote --file=./schema.sql

DROP TABLE IF EXISTS screen_entries;
DROP TABLE IF EXISTS screens;
DROP TABLE IF EXISTS stocks;

-- The screens (metadata only; rankings live in screen_entries).
-- updated_at is stamped each time the screen's list is fetched/loaded, so the
-- UI can show how fresh the data is and decide when to re-fetch.
CREATE TABLE screens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  lens         TEXT NOT NULL,
  gauge        TEXT NOT NULL,
  formula      TEXT NOT NULL,        -- may contain light HTML (<b>…</b>)
  screener_url TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER               -- epoch ms of last data load (NULL = never)
);

-- One row per (screen, company). `rank` = position in that screen's ranked
-- output (1 = best). This is the single source of truth for intersections.
-- The matching key across screens is `symbol` = the Screener company code, so a
-- company that appears in two screens intersects correctly.
CREATE TABLE screen_entries (
  screen_id    TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  symbol       TEXT NOT NULL,        -- Screener company code, consistent across screens
  company      TEXT NOT NULL,        -- display name
  metric_label TEXT,                 -- e.g. "Piotski Scr" / "ROCE %"
  metric_value TEXT,                 -- e.g. "9.00"
  PRIMARY KEY (screen_id, symbol),
  FOREIGN KEY (screen_id) REFERENCES screens(id)
);
CREATE INDEX idx_entries_screen_rank ON screen_entries(screen_id, rank);
CREATE INDEX idx_entries_symbol      ON screen_entries(symbol);

-- Fundamentals + parsed detail for the Qualitative (judgement) view. Keyed by
-- the SAME `symbol` (Screener code) used in screen_entries so survivors join
-- cleanly. `ticker` drives live Yahoo Finance lookups (price + chart).
CREATE TABLE stocks (
  symbol         TEXT PRIMARY KEY,
  company        TEXT NOT NULL,
  ticker         TEXT,    -- NSE/BSE code -> RELIANCE.NS / 500325.BO for Yahoo
  sector         TEXT,
  mcap           REAL,    -- ₹ crore
  price          REAL,
  roce           REAL,
  roe            REAL,
  pe             REAL,
  pe_median      REAL,
  opm            REAL,
  de             REAL,
  profit_cagr    REAL,
  sales_cagr     REAL,
  div_yield      REAL,
  fscore         INTEGER,
  cfo_pat        REAL,
  promoter       REAL,
  pledge         REAL,
  fii            REAL,
  dii            REAL,
  earnings_yield REAL,
  detail_json    TEXT,    -- parsed sections (about, pros, cons, peers, shareholding…)
  fetched_at     INTEGER  -- epoch ms of last company-page fetch (NULL = never)
);
