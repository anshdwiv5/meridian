// scripts/screens.js
// Single source of truth for the 8 screens' metadata.
// Used by gen-sample.mjs (sample data) and ingest.mjs (your real Screener exports).
//
// IMPORTANT: the `file` field is the CSV filename you drop into ./data/ when you
// export that screen from Screener.in. e.g. export the Piotroski screen -> data/piotroski.csv

export const SCREENS = [
  {
    id: 'piotroski', file: 'piotroski.csv', name: 'Piotroski Scan', lens: 'integrity',
    gauge: 'Financial strength & earnings integrity — are the books clean, profitable, and improving?',
    formula: 'F-Score = Σ of 9 tests across <b>Profitability</b> (+ve PAT, +ve CFO, ↑ROA, CFO &gt; PAT), <b>Leverage</b> (↓LT-debt ratio, ↑current ratio, no dilution) &amp; <b>Efficiency</b> (↑gross margin, ↑asset turnover). Keep <b>F = 9</b>.',
    screener_url: 'https://www.screener.in/screens/2/piotroski-scan/',
  },
  {
    id: 'magic', file: 'magic.csv', name: 'Magic Formula', lens: 'value',
    gauge: 'Cheap and good at once — high return on capital bought at a high earnings yield.',
    formula: 'Combined rank of <b>Earnings Yield = EBIT / EV</b> and <b>Return on Capital = EBIT / (Net WC + Net Fixed Assets)</b>. Lower combined rank = better.',
    screener_url: 'https://www.screener.in/screens/59/magic-formula/',
  },
  {
    id: 'coffee', file: 'coffee.csv', name: 'Coffee Can Portfolio', lens: 'quality',
    gauge: 'Consistent compounders — a decade of steady growth and high returns, no bad years.',
    formula: 'For each of last <b>10 years</b>: Sales growth ≥ <b>10%</b> AND ROCE ≥ <b>15%</b>. Market-cap filter applied.',
    screener_url: 'https://www.screener.in/screens/57601/coffee-can-portfolio/',
  },
  {
    id: 'garp', file: 'garp.csv', name: 'High Growth · High RoE · Low PE', lens: 'garp',
    gauge: 'Growth at a reasonable price — fast, profitable, and not yet expensive.',
    formula: '<b>Profit CAGR &gt; 20%</b> AND <b>ROE &gt; 18%</b> AND <b>PE &lt; median PE</b> (cheap vs its own history).',
    screener_url: 'https://www.screener.in/screens/18/high-growth-high-roe-low-pe/',
  },
  {
    id: 'value', file: 'value.csv', name: 'Value Stocks (Quality)', lens: 'quality',
    gauge: 'Genuinely good businesses — fat margins, high returns, little debt.',
    formula: '<b>OPM &gt; 15%</b> AND <b>ROCE &gt; 18%</b> AND <b>Debt/Equity &lt; 0.5</b>.',
    screener_url: 'https://www.screener.in/screens/184/value-stocks/',
  },
  {
    id: 'capex', file: 'capex.csv', name: 'Capacity Expansion', lens: 'balance',
    gauge: 'Building for the future — heavy capex that should feed tomorrow’s growth.',
    formula: 'Net block <b>doubled over 3 yrs</b> OR Gross block + CWIP <b>up &gt; 50% in 1 yr</b>.',
    screener_url: 'https://www.screener.in/screens/97687/capacity-expansion/',
  },
  {
    id: 'debt', file: 'debt.csv', name: 'Debt Reduction', lens: 'balance',
    gauge: 'De-leveraging stories — falling debt while the business keeps growing.',
    formula: '<b>Debt/Equity falling</b> across recent years; debt down even as profit / assets rise.',
    screener_url: 'https://www.screener.in/screens/126864/debt-reduction/',
  },
  {
    id: 'graham', file: 'graham.csv', name: 'Low on 10-Yr Avg Earnings', lens: 'value',
    gauge: 'Deep value, Graham-style — price low against normalised, decade-averaged earnings.',
    formula: 'Price low vs <b>10-year average EPS</b> (normalised P/E). Sales &gt; <b>₹250 cr</b> filter.',
    screener_url: 'https://www.screener.in/screens/6994/low-on-10-year-average-earnings/',
  },
];

// The lens legend (kept in sync with the UI).
export const LENSES = {
  integrity: { c: '#22D3EE', label: 'Integrity' },
  value:     { c: '#5EE6F5', label: 'Value' },
  quality:   { c: '#2FD4BF', label: 'Quality' },
  growth:    { c: '#7AA8FF', label: 'Growth' },
  garp:      { c: '#A78BFA', label: 'GARP' },
  balance:   { c: '#E3B86A', label: 'Balance-sheet' },
};
