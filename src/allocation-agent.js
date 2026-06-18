/* ============================ allocation agent (step 3) ============================
 * Sizes a monthly buy plan across the names you flagged in Research, using the
 * scorecard the THESIS agent already cached in D1 (thesis_json). It does NOT
 * re-research — research is ground truth; this layer only allocates capital.
 *
 * Design choices (why this is cheap + stable month to month):
 *  - INPUT is a compact digest of each thesis (scores + verdict + 1 line + top
 *    risks), never the full essay -> far fewer tokens than re-sending theses.
 *  - The model reasons over the existing scores; grounding/tools are OFF and
 *    thinking is OFF, so one schema-locked JSON comes back fast and reliably.
 *  - Weights are anchored to total score (-5..30) + confidence, not vibes, so
 *    the same inputs give roughly the same plan each month.
 *  - normalizeAllocation() is a JS safety net: it enforces single-stock and
 *    sector caps and forces the weights to sum to exactly 100, even if the
 *    model's arithmetic drifts. The model proposes; JS guarantees invariants.
 *  - Default basis = FRESH MONTHLY CAPITAL (portfolio data ignored). Percentages
 *    are of this month's contribution; the route multiplies by monthly_capital
 *    to get rupee buys. Pass current_weights later to unlock ADD/HOLD/TRIM.
 *
 * INTEGRATION (3 small edits, all reviewable before you push):
 *  1) worker.js, top:        import { handleAllocationRoute } from './allocation-agent.js';
 *  2) worker.js, in handleApi (next to the /api/thesis branch):
 *        if (p === '/api/allocation' && request.method === 'POST')
 *          return handleAllocationRoute(request, env, db, json);
 *  3) public/app.js: add a "Generate allocation" button in renderAllocation()
 *     that POSTs { symbols: state.allocation, monthly_capital } to /api/allocation
 *     (mirror the thesis Generate button so it runs on click, not automatically).
 * No new secrets, no schema migration, no new dependency. Uses GEMINI_API_KEY.
 * ================================================================================ */

// Tunable defaults — override per request via the POST body.
export const ALLOCATION_DEFAULTS = {
  capital_basis: 'fresh_monthly_capital',
  max_single_pct: 25, // hard ceiling per stock (never let one name dominate)
  max_sector_pct: 35, // hard ceiling per sector (concentration guard)
  include_watch: true, // allow tiny toeholds in WATCH names
  watch_cap_pct: 5, // ...capped this small
  min_position_pct: 2, // below this, round to 0 (no dust positions)
};

export const ALLOCATION_SYSTEM_PROMPT = `You are the allocation agent for a long-term (10-15 year) Indian-equity portfolio that buys FRESH CAPITAL EVERY MONTH. You do NOT pick stocks and you do NOT re-research them. You take an already-approved set of stocks plus the thesis scorecard for each, and decide how this month's new capital should be split across them.

INPUT
A JSON object with "constraints" and a "stocks" array. Each stock carries the thesis agent's output: verdict (BUY/WATCH/REJECT), confidence 0-100, integer scores (growth_runway, moat, financial_quality, management_governance, valuation, industry_attractiveness each 0-5; risk_penalty 0-5 subtracted; total -5..30), a one-line thesis, top risks, a short valuation note, a sector, low_evidence flag, and optionally current_weight_pct. Treat these as ground truth; never invent new facts or re-score.

BASIS
Percentages are of THIS MONTH'S NEW CAPITAL and MUST sum to 100 across the names you fund. State this in portfolio_summary.capital_basis. Do not split equally.

ELIGIBILITY
- REJECT  -> action AVOID, target 0. Never fund.
- WATCH   -> at most a small Tier-C toehold, and only if constraints.include_watch is true; otherwise AVOID.
- BUY     -> eligible for any tier.
- confidence < 55 or low_evidence true -> cap at Tier C no matter how high the score (be conservative when evidence is thin).

TIERS (anchor on total/30 and confidence)
- Tier A — core compounders: total >= 22 AND confidence >= 70 AND financial_quality >= 3 AND management_governance >= 3 AND valuation >= 2.
- Tier B — good, size modestly: total 15-21, OR an A-grade business held back by rich valuation (valuation <= 1) or confidence 55-69.
- Tier C — small only: total < 15, or confidence < 55, or WATCH, or a notable governance/risk flag.

SIZING (bands of new capital; rank within each band, do not flatten)
- Tier A clearly the largest weights; Tier B moderate; Tier C small.
- Within a tier rank by total, then valuation (cheaper = higher), then confidence, then lower risk_penalty; higher rank sits at the top of its band.
- Tilt up for strong valuation (valuation >= 4); tilt down for weak valuation (<= 1) or high risk_penalty (>= 3).

CAPS & BALANCE
- No single stock above constraints.max_single_pct.
- No sector above constraints.max_sector_pct; if breached, trim the lowest-ranked names in that sector.
- Prefer at least ~5 funded names when the eligible set allows; if fewer are eligible, say so in concentration_notes rather than forcing diversification.
- Drop anything below constraints.min_position_pct to 0 (avoid dust).

OUTPUT — return ONLY one valid JSON object (no markdown, no preamble), EXACTLY these keys:
{
 "portfolio_summary": { "overall_style": "", "risk_posture": "", "concentration_notes": "", "capital_basis": "fresh_monthly_capital" },
 "tiers": { "A": ["TICKER"], "B": [], "C": [] },
 "allocations": [ { "ticker": "", "tier": "A|B|C", "target_weight_pct": 0, "current_weight_pct": null, "action": "BUY|AVOID", "justification": ["", ""] } ],
 "constraints_applied": [""],
 "final_notes": ""
}

JUSTIFICATION STYLE
- 2-3 short lines per stock, investment-committee tone, not prose.
- Name the ONE main reason for the weight and cite the number behind it.
- Examples: "Tier A: total 26, confidence 80, valuation still fair — core weight." / "Strong franchise but valuation rich (val 1/5) — keep it, size it down." / "WATCH + thin evidence — toehold only until the thesis firms up."

RULES
- Weights of funded names sum to 100. Use action AVOID (0%) for REJECT and skipped WATCH names. ADD/HOLD/TRIM are only valid when current_weight_pct is provided.
- Do not give generic investing advice, do not repeat the full thesis, do not use false-precision math. If inputs are insufficient, allocate small and say why.`;

// Canonical JSON Schema (lowercase) used to schema-lock the model's output.
export const ALLOCATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    portfolio_summary: {
      type: 'object',
      properties: {
        overall_style: { type: 'string' },
        risk_posture: { type: 'string' },
        concentration_notes: { type: 'string' },
        capital_basis: { type: 'string' },
      },
      required: ['overall_style', 'risk_posture', 'concentration_notes', 'capital_basis'],
    },
    tiers: {
      type: 'object',
      properties: {
        A: { type: 'array', items: { type: 'string' } },
        B: { type: 'array', items: { type: 'string' } },
        C: { type: 'array', items: { type: 'string' } },
      },
      required: ['A', 'B', 'C'],
    },
    allocations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ticker: { type: 'string' },
          tier: { type: 'string', enum: ['A', 'B', 'C'] },
          target_weight_pct: { type: 'number' },
          current_weight_pct: { type: 'number' },
          action: { type: 'string', enum: ['BUY', 'ADD', 'HOLD', 'TRIM', 'AVOID'] },
          justification: { type: 'array', items: { type: 'string' } },
        },
        required: ['ticker', 'tier', 'target_weight_pct', 'action', 'justification'],
      },
    },
    constraints_applied: { type: 'array', items: { type: 'string' } },
    final_notes: { type: 'string' },
  },
  required: ['portfolio_summary', 'tiers', 'allocations', 'constraints_applied', 'final_notes'],
};

// Gemini wants an uppercase OpenAPI dialect and rejects additionalProperties.
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (s && typeof s === 'object') {
    const o = {};
    for (const k in s) {
      if (k === 'additionalProperties') continue;
      if (k === 'type' && typeof s[k] === 'string') o[k] = s[k].toUpperCase();
      else o[k] = toGeminiSchema(s[k]);
    }
    return o;
  }
  return s;
}

// --- input shaping: turn cached theses into the compact digest the model sees ---
const firstSentence = (v, max) => {
  const t = String(v || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const cut = t.split(/(?<=[.!?])\s/)[0];
  const out = cut.length > max ? cut.slice(0, max - 1) + '…' : cut;
  return out;
};
const numOr = (v, d = null) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/**
 * @param {{symbol:string, ticker?:string, sector?:string, thesis:object, current_weight_pct?:number}[]} rows
 * @param {object} [opts] overrides for ALLOCATION_DEFAULTS
 */
export function buildAllocationInput(rows, opts = {}) {
  const constraints = { ...ALLOCATION_DEFAULTS, ...opts };
  const stocks = rows.map((r) => {
    const t = r.thesis || {};
    const s = (t.scores && typeof t.scores === 'object') ? t.scores : {};
    const conf = numOr(t.confidence);
    const total = numOr(s.total);
    return {
      ticker: r.symbol,
      sector: r.sector || 'Unknown',
      verdict: String(t.verdict || 'WATCH').toUpperCase(),
      confidence: conf,
      scores: {
        growth_runway: numOr(s.growth_runway), moat: numOr(s.moat),
        financial_quality: numOr(s.financial_quality), management_governance: numOr(s.management_governance),
        valuation: numOr(s.valuation), industry_attractiveness: numOr(s.industry_attractiveness),
        risk_penalty: numOr(s.risk_penalty), total,
      },
      thesis_line: firstSentence(t.executive_thesis, 220),
      top_risks: Array.isArray(t.key_risks) ? t.key_risks.slice(0, 2).map((x) => firstSentence(x, 120)) : [],
      valuation_note: firstSentence(t.valuation_assessment, 140),
      low_evidence: (conf != null && conf < 55) || total == null,
      current_weight_pct: numOr(r.current_weight_pct),
    };
  });
  return { constraints, stocks };
}

// --- the model call: schema-locked JSON, no grounding, no thinking, low temp ---
export async function runAllocation(input, env) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured — set it with: wrangler secret put GEMINI_API_KEY');
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const userContent = 'Allocate this month’s capital across these approved stocks (use ONLY this data):\n```json\n' + JSON.stringify(input) + '\n```';
  const u = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const generationConfig = {
    temperature: 0.2,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json',
    responseSchema: toGeminiSchema(ALLOCATION_JSON_SCHEMA),
  };
  if (/2[.\-]5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const reqBody = {
    systemInstruction: { parts: [{ text: ALLOCATION_SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig,
  };
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqBody) });
  if (!r.ok) { const tx = await r.text().catch(() => ''); throw new Error(`Gemini HTTP ${r.status}: ${tx.slice(0, 300)}`); }
  const j = await r.json();
  const cand = j?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned no content' + (cand?.finishReason ? ` (finishReason ${cand.finishReason})` : ''));
  let raw;
  try { raw = JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); raw = m ? JSON.parse(m[0]) : null; }
  if (!raw || typeof raw !== 'object') throw new Error('allocation JSON did not parse');
  return normalizeAllocation(raw, input);
}

// Water-filling cap enforcement: holds capped names/sectors at their ceiling and
// redistributes the remainder, so a cap is never re-inflated by renormalization.
// Keeps the funded weights summing to `total` whenever the caps make that feasible;
// if caps are too tight to reach it (few names, one dominant sector), full
// deployment wins and the cap becomes best-effort rather than crashing.
function enforceCaps(funded, sectorOf, maxSingle, maxSector, total = 100) {
  const eps = 1e-7;
  const wsum = (xs) => xs.reduce((t, a) => t + a.target_weight_pct, 0);
  for (let outer = 0; outer < 10; outer++) {
    // single-stock water-fill
    const fixed = new Set();
    for (let i = 0; i < funded.length + 2; i++) {
      const free = funded.filter((a) => !fixed.has(a.ticker));
      if (!free.length) break;
      const tgt = total - wsum(funded.filter((a) => fixed.has(a.ticker)));
      const freeSum = wsum(free) || 1;
      let changed = false;
      for (const a of free) {
        a.target_weight_pct = tgt * (a.target_weight_pct / freeSum);
        if (a.target_weight_pct > maxSingle + eps) { a.target_weight_pct = maxSingle; fixed.add(a.ticker); changed = true; }
      }
      if (!changed) break;
    }
    // sector water-fill
    const groups = {};
    for (const a of funded) (groups[sectorOf(a.ticker)] ||= []).push(a);
    const secKeys = Object.keys(groups);
    const sFixed = new Set();
    for (let i = 0; i < secKeys.length + 2; i++) {
      const freeKeys = secKeys.filter((s) => !sFixed.has(s));
      if (!freeKeys.length) break;
      const tgt = total - secKeys.filter((s) => sFixed.has(s)).reduce((t, s) => t + wsum(groups[s]), 0);
      const freeSum = freeKeys.reduce((t, s) => t + wsum(groups[s]), 0) || 1;
      let changed = false;
      for (const s of freeKeys) {
        const g = groups[s]; const gsum = wsum(g) || 1;
        const scaled = tgt * (gsum / freeSum);
        const k = (scaled > maxSector + eps ? maxSector : scaled) / gsum;
        for (const a of g) a.target_weight_pct *= k;
        if (scaled > maxSector + eps) { sFixed.add(s); changed = true; }
      }
      if (!changed) break;
    }
    const overSingle = funded.some((a) => a.target_weight_pct > maxSingle + 1e-4);
    const sec = {};
    for (const a of funded) sec[sectorOf(a.ticker)] = (sec[sectorOf(a.ticker)] || 0) + a.target_weight_pct;
    const overSector = Object.values(sec).some((v) => v > maxSector + 1e-4);
    if (!overSingle && !overSector) break;
  }
}

// Round funded weights to a 0.1 grid that sums to EXACTLY 100.0 (largest-remainder,
// so rupee buy amounts are exact), then shave any cap overshoot created by rounding
// into the roomiest name — each move is 0.1 between two names, so the total never
// leaves 100.0. If no name has room (caps too tight to fit 100), it stops: caps are
// best-effort, full deployment wins.
function finalizeWeights(funded, sectorOf, maxSingle, maxSector) {
  if (!funded.length) return;
  const round1 = (n) => Math.round(n * 10) / 10;
  const u = funded.map((a) => { const x = a.target_weight_pct * 10; const base = Math.floor(x); return { a, base, rem: x - base }; });
  let need = Math.round(1000 - u.reduce((t, f) => t + f.base, 0));
  u.sort((p, q) => q.rem - p.rem);
  for (let i = 0; need > 0 && i < u.length; i++, need--) u[i].base++;
  for (let i = u.length - 1; need < 0 && i >= 0; i--) if (u[i].base > 0) { u[i].base--; need++; }
  for (const f of u) f.a.target_weight_pct = f.base / 10;

  const secSum = () => { const m = {}; for (const a of funded) { const k = sectorOf(a.ticker); m[k] = (m[k] || 0) + a.target_weight_pct; } return m; };
  for (let pass = 0; pass < 60; pass++) {
    const ss = secSum();
    let src = funded.find((a) => a.target_weight_pct > maxSingle + 1e-6)
      || funded.find((a) => a.target_weight_pct > 0 && ss[sectorOf(a.ticker)] > maxSector + 1e-6);
    if (!src) break;
    const dst = funded
      .filter((a) => a !== src && a.target_weight_pct + 0.1 <= maxSingle + 1e-6 && ss[sectorOf(a.ticker)] + 0.1 <= maxSector + 1e-6)
      .sort((x, y) => (maxSingle - x.target_weight_pct) - (maxSingle - y.target_weight_pct)).pop();
    if (!dst) break; // infeasible — leave best-effort, total stays 100
    src.target_weight_pct = round1(src.target_weight_pct - 0.1);
    dst.target_weight_pct = round1(dst.target_weight_pct + 0.1);
  }
}

// --- JS safety net: enforce caps + sum-to-100 regardless of what the model returned ---
export function normalizeAllocation(raw, input) {
  const c = (input && input.constraints) || ALLOCATION_DEFAULTS;
  const sectorOf = {}; const verdictOf = {};
  for (const s of (input?.stocks || [])) { sectorOf[s.ticker] = s.sector || 'Unknown'; verdictOf[s.ticker] = s.verdict; }

  const allocs = Array.isArray(raw.allocations) ? raw.allocations.map((a) => ({
    ticker: String(a.ticker || '').trim(),
    tier: ['A', 'B', 'C'].includes(String(a.tier || '').toUpperCase()) ? String(a.tier).toUpperCase() : 'C',
    target_weight_pct: Math.max(0, numOr(a.target_weight_pct, 0)),
    current_weight_pct: numOr(a.current_weight_pct),
    action: String(a.action || '').toUpperCase(),
    justification: Array.isArray(a.justification) ? a.justification.map((x) => String(x).trim()).filter(Boolean).slice(0, 3) : [],
  })).filter((a) => a.ticker) : [];

  // Force REJECT names to AVOID/0 even if the model funded them.
  for (const a of allocs) if (verdictOf[a.ticker] === 'REJECT') { a.action = 'AVOID'; a.target_weight_pct = 0; }

  // Funded = positive weight and not explicitly avoided.
  let funded = allocs.filter((a) => a.target_weight_pct > 0 && a.action !== 'AVOID');
  const avoided = allocs.filter((a) => !(a.target_weight_pct > 0 && a.action !== 'AVOID'))
    .map((a) => ({ ...a, target_weight_pct: 0, action: 'AVOID' }));

  if (funded.length) {
    const sum = (xs) => xs.reduce((t, x) => t + x.target_weight_pct, 0);
    const renorm = () => { const s = sum(funded) || 1; for (const a of funded) a.target_weight_pct = (a.target_weight_pct / s) * 100; };

    renorm();
    // Drop dust below the floor, then renormalize what's left.
    funded = funded.filter((a) => a.target_weight_pct >= (c.min_position_pct || 0) - 1e-9);
    if (!funded.length) funded = allocs.filter((a) => a.target_weight_pct > 0).slice(0, 1); // never wipe everything
    renorm();

    // Cap enforcement by water-filling (single-stock, then sector). See enforceCaps.
    enforceCaps(funded, (t) => sectorOf[t] || 'Unknown', c.max_single_pct, c.max_sector_pct);

    // Round to a 0.1 grid summing to exactly 100, with caps held on that grid.
    finalizeWeights(funded, (t) => sectorOf[t] || 'Unknown', c.max_single_pct, c.max_sector_pct);
    for (const a of funded) a.action = a.action === 'ADD' || a.action === 'HOLD' || a.action === 'TRIM' ? a.action : 'BUY';
  }

  const finalAllocs = [...funded, ...avoided];
  // Reconcile: any flagged name the model dropped entirely is shown as AVOID, not lost.
  const seen = new Set(finalAllocs.map((a) => a.ticker));
  for (const s of (input?.stocks || [])) {
    if (!seen.has(s.ticker)) finalAllocs.push({ ticker: s.ticker, tier: 'C', target_weight_pct: 0, current_weight_pct: s.current_weight_pct ?? null, action: 'AVOID', justification: ['Not funded this month.'] });
  }
  // Rebuild tier lists from the funded set so they always match the table.
  const tiers = { A: [], B: [], C: [] };
  for (const a of funded) (tiers[a.tier] ||= []).push(a.ticker);

  const ps = (raw.portfolio_summary && typeof raw.portfolio_summary === 'object') ? raw.portfolio_summary : {};
  return {
    portfolio_summary: {
      overall_style: String(ps.overall_style || ''),
      risk_posture: String(ps.risk_posture || ''),
      concentration_notes: String(ps.concentration_notes || ''),
      capital_basis: String(ps.capital_basis || c.capital_basis || 'fresh_monthly_capital'),
    },
    tiers,
    allocations: finalAllocs,
    constraints_applied: Array.isArray(raw.constraints_applied) ? raw.constraints_applied.map(String) : [],
    final_notes: String(raw.final_notes || ''),
  };
}

/**
 * Route handler — POST /api/allocation
 * body: { symbols: string[], monthly_capital?: number,
 *         max_single_pct?, max_sector_pct?, include_watch?,
 *         current_weights?: { [symbol]: pct } }
 * Pulls each flagged symbol's cached thesis from D1, runs the agent, and (if
 * monthly_capital is given) attaches deterministic rupee buy amounts in JS.
 */
export async function handleAllocationRoute(request, env, db, json) {
  const body = await request.json().catch(() => ({}));
  const symbols = Array.isArray(body.symbols) ? body.symbols.map((s) => String(s).trim()).filter(Boolean) : [];
  if (!symbols.length) return json({ error: 'no symbols flagged for allocation' }, 400);

  const opts = {};
  for (const k of ['max_single_pct', 'max_sector_pct', 'watch_cap_pct', 'min_position_pct']) {
    if (body[k] != null && Number.isFinite(+body[k])) opts[k] = +body[k];
  }
  if (typeof body.include_watch === 'boolean') opts.include_watch = body.include_watch;

  const rows = [];
  const missing = []; // flagged names with no usable thesis yet -> UI should prompt to Generate
  for (const symbol of symbols) {
    const rec = await db.prepare(`SELECT symbol, ticker, sector, thesis_json FROM stocks WHERE symbol=?`).bind(symbol).first();
    let thesis = null;
    if (rec && rec.thesis_json) { try { thesis = JSON.parse(rec.thesis_json); } catch {} }
    const usable = thesis && (thesis.verdict || (thesis.scores && thesis.scores.total != null));
    if (!usable) { missing.push(symbol); continue; }
    rows.push({
      symbol, ticker: (rec && rec.ticker) || symbol, sector: rec && rec.sector,
      thesis, current_weight_pct: body.current_weights ? body.current_weights[symbol] : undefined,
    });
  }
  if (!rows.length) return json({ error: 'no flagged names have a thesis yet — generate theses first', missing }, 200);

  const input = buildAllocationInput(rows, opts);
  let allocation;
  try {
    allocation = await runAllocation(input, env);
  } catch (e) {
    const msg = String((e && e.message) || e);
    return json({ error: msg, needsKey: /api key|GEMINI|not configured/i.test(msg), missing }, 200);
  }

  // Deterministic rupee buys (JS, not the model) when a monthly amount is given.
  const cap = Number(body.monthly_capital);
  if (Number.isFinite(cap) && cap > 0) {
    for (const a of allocation.allocations) a.target_amount = Math.round((a.target_weight_pct / 100) * cap);
  }
  return json({ basis: allocation.portfolio_summary.capital_basis, monthly_capital: Number.isFinite(cap) ? cap : null, missing, allocation, generated_at: Date.now() });
}
