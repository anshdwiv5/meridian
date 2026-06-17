# Meridian — your turn (the only manual steps left)

Everything is built and verified. After you do these, it's live.

## 1. Provide the Gemini key (the one secret)
```bash
npx wrangler secret put GEMINI_API_KEY
```
Free key: https://aistudio.google.com/apikey
Until set, the app fully works and the **Agent Thesis** tab shows "add your key".

## 2. (Optional) Decide the data provider
Default is `screener` — needs nothing. To switch later: set `DATA_PROVIDER` in
`wrangler.toml`, implement the branch in `fetchCompanyRaw()` (one function in
`src/worker.js`), and `npx wrangler secret put STOCK_API_KEY`.

## 3. Database + deploy
```bash
npm install
# existing DB (deployed before the AI agent)? add the thesis-cache columns once:
npm run db:upgrade
# brand-new DB instead? use: npm run db:init
npx wrangler deploy
```

## That's it
Open the Worker URL → Step 1 Shortlist works exactly as before → Step 2 Research
shows the 6 data buckets → Agent Thesis generates a verdict (with web research).

---
### Optional knobs (wrangler.toml [vars])
- `THESIS_PROVIDER` = `gemini` (default) | `workers-ai` (no key, on-platform fallback)
- `THESIS_WEB_RESEARCH` = `true` (default) — lets Gemini fill gaps via Google Search
- `GEMINI_MODEL` = `gemini-2.5-flash` (default)

### Housekeeping
Delete the leftover `.git/` scaffold and empty `__wtest` file in this folder (created
during a failed clone attempt; I couldn't remove them from my side).
