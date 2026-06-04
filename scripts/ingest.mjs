// scripts/ingest.mjs
// Turns your real Screener.in CSV exports into seed.real.sql.
//
// HOW TO USE
//   1. On Screener.in, open each of your 8 screens and click "Export to Excel"
//      (or save as CSV). Save each file into ./data/ using the screen's `file`
//      name from scripts/screens.js, e.g.:
//          data/piotroski.csv   data/magic.csv   data/coffee.csv  ... etc.
//      The ROW ORDER in the export = the screen's ranking (sort your screen
//      by the column you care about before exporting).
//   2. (Optional) Export a fundamentals sheet covering the same companies and
//      save it as ./data/fundamentals.csv to power the Qualitative view.
//   3. Run:  node scripts/ingest.mjs
//   4. Apply: wrangler d1 execute meridian-db --remote --file=./seed.real.sql
//
// The matching key across screens is a normalised company name, so a company
// that appears in two screens will intersect correctly. If your export has an
// "NSE Code"/"BSE Code"/"Symbol" column, that is used as the key instead.

import { SCREENS } from './screens.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, '..', 'data');
const OUT = join(__dir, '..', 'seed.real.sql');

// --- tiny RFC-4180-ish CSV parser (handles quoted fields, commas, newlines) ---
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^\uFEFF/, ''); // strip BOM
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 40);
const sqlStr = v => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const sqlNum = v => {
  if (v === null || v === undefined || v === '') return 'NULL';
  const x = parseFloat(String(v).replace(/[, %₹]/g, ''));
  return Number.isFinite(x) ? x : 'NULL';
};

function findCol(header, candidates) {
  const lower = header.map(h => String(h).trim().toLowerCase());
  for (const cand of candidates) {
    const i = lower.findIndex(h => h === cand || h.includes(cand));
    if (i !== -1) return i;
  }
  return -1;
}

let sql = `-- seed.real.sql  (GENERATED from your Screener exports)\n`;
sql += `-- Apply with:  wrangler d1 execute meridian-db --remote --file=./seed.real.sql\n\n`;
sql += `DELETE FROM screen_entries;\nDELETE FROM screens;\nDELETE FROM stocks;\n\n`;

// screens metadata
SCREENS.forEach((s, i) => {
  sql += `INSERT INTO screens (id,name,lens,gauge,formula,screener_url,sort_order) VALUES (${sqlStr(s.id)},${sqlStr(s.name)},${sqlStr(s.lens)},${sqlStr(s.gauge)},${sqlStr(s.formula)},${sqlStr(s.screener_url)},${i});\n`;
});
sql += `\n`;

// entries from each screen CSV
let totalEntries = 0, missing = [];
for (const s of SCREENS) {
  const path = join(DATA, s.file);
  if (!existsSync(path)) { missing.push(s.file); continue; }
  const rows = parseCSV(readFileSync(path, 'utf8'));
  if (rows.length < 2) { missing.push(`${s.file} (empty)`); continue; }
  const header = rows[0];
  const nameCol = findCol(header, ['name', 'company']);
  const codeCol = findCol(header, ['nse code', 'bse code', 'symbol', 'ticker', 'code']);
  // a numeric metric column to display (first numeric-ish col after name), best-effort
  const metricCol = header.findIndex((h, idx) =>
    idx !== nameCol && idx !== codeCol && !/^s\.?no/i.test(String(h).trim()));
  let rank = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const company = nameCol !== -1 ? String(cells[nameCol]).trim() : String(cells[0]).trim();
    if (!company) continue;
    const keyRaw = codeCol !== -1 && cells[codeCol] ? cells[codeCol] : company;
    const symbol = norm(keyRaw);
    if (!symbol) continue;
    rank++;
    const mLabel = metricCol !== -1 ? String(header[metricCol]).trim() : null;
    const mValue = metricCol !== -1 ? String(cells[metricCol]).trim() : null;
    sql += `INSERT INTO screen_entries (screen_id,rank,symbol,company,metric_label,metric_value) VALUES (${sqlStr(s.id)},${rank},${sqlStr(symbol)},${sqlStr(company)},${sqlStr(mLabel)},${sqlStr(mValue)});\n`;
    totalEntries++;
  }
}
sql += `\n`;

// optional fundamentals.csv -> stocks
const fpath = join(DATA, 'fundamentals.csv');
let stockCount = 0;
if (existsSync(fpath)) {
  const rows = parseCSV(readFileSync(fpath, 'utf8'));
  const h = rows[0];
  const col = names => findCol(h, names);
  const c = {
    name: col(['name', 'company']), code: col(['nse code', 'bse code', 'symbol', 'ticker', 'code']),
    sector: col(['sector', 'industry']), mcap: col(['market cap', 'market capitalization', 'mcap']),
    price: col(['cmp', 'current price', 'price']), roce: col(['roce']), roe: col(['roe']),
    pe: col(['p/e', 'pe ratio', 'price to earning', 'pe']), opm: col(['opm', 'operating margin']),
    de: col(['debt / equity', 'debt to equity', 'd/e']), pcagr: col(['profit growth', 'profit cagr']),
    scagr: col(['sales growth', 'sales cagr']), div: col(['dividend yield', 'div yield']),
    fscore: col(['piotroski', 'f-score', 'fscore']), promoter: col(['promoter holding', 'promoter']),
    pledge: col(['pledged', 'pledge']), fii: col(['fii', 'fpi']), dii: col(['dii']),
  };
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const company = c.name !== -1 ? String(cells[c.name]).trim() : String(cells[0]).trim();
    if (!company) continue;
    const symbol = norm(c.code !== -1 && cells[c.code] ? cells[c.code] : company);
    const g = i => i !== -1 ? cells[i] : null;
    sql += `INSERT INTO stocks (symbol,company,sector,mcap,price,roce,roe,pe,opm,de,profit_cagr,sales_cagr,div_yield,fscore,promoter,pledge,fii,dii) VALUES (`
      + `${sqlStr(symbol)},${sqlStr(company)},${sqlStr(g(c.sector))},${sqlNum(g(c.mcap))},${sqlNum(g(c.price))},${sqlNum(g(c.roce))},${sqlNum(g(c.roe))},${sqlNum(g(c.pe))},${sqlNum(g(c.opm))},${sqlNum(g(c.de))},${sqlNum(g(c.pcagr))},${sqlNum(g(c.scagr))},${sqlNum(g(c.div))},${sqlNum(g(c.fscore))},${sqlNum(g(c.promoter))},${sqlNum(g(c.pledge))},${sqlNum(g(c.fii))},${sqlNum(g(c.dii))})`
      + ` ON CONFLICT(symbol) DO UPDATE SET company=excluded.company,sector=excluded.sector,mcap=excluded.mcap,price=excluded.price,roce=excluded.roce,roe=excluded.roe,pe=excluded.pe,opm=excluded.opm,de=excluded.de;\n`;
    stockCount++;
  }
} else {
  // No fundamentals sheet: create minimal stock rows from screen entries so the
  // Qualitative view still opens (numbers will be sparse until you add fundamentals.csv).
  sql += `INSERT OR IGNORE INTO stocks (symbol, company)\n  SELECT symbol, MAX(company) FROM screen_entries GROUP BY symbol;\n`;
}

writeFileSync(OUT, sql);
console.log(`Wrote ${OUT}`);
console.log(`Screen entries ingested: ${totalEntries}`);
console.log(`Fundamentals rows: ${stockCount}${existsSync(fpath) ? '' : ' (no data/fundamentals.csv — created minimal stock rows)'}`);
if (missing.length) console.warn(`\n⚠ Missing/empty screen files (skipped): ${missing.join(', ')}\n  Export them from Screener.in into ./data/ and re-run.`);
