-- Adds the thesis-cache columns to an EXISTING meridian-db (run once if you
-- deployed Meridian before the AI agent existed). Fresh installs already get
-- these from schema.sql, so you only need this when upgrading in place.
--
-- Apply (remote):  npm run db:upgrade
-- Apply (local):   npm run db:upgrade:local
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS"; if a column already exists the
-- statement errors harmlessly — ignore "duplicate column name".

ALTER TABLE stocks ADD COLUMN thesis_json TEXT;
ALTER TABLE stocks ADD COLUMN thesis_at INTEGER;
