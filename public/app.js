/* Meridian, frontend (classic script; inline handlers call these globals).
   Three steps: 1) Shortlist (screens → intersection), 2) Research (per-stock data
   + AI thesis), 3) Allocation (shell). All working state is session-only: kept in
   memory, mirrored to sessionStorage so a reload inside the tab is safe, and gone
   when the tab closes. The Worker fetches everything live (Screener + Yahoo) and
   the thesis comes from Gemini with web-search grounding. Nothing is fabricated. */

const API = '';

const LENS = {
  integrity:{c:'#0e9f8e', label:'Integrity'},
  value:    {c:'#3b82f6', label:'Value'},
  quality:  {c:'#0aa66e', label:'Quality'},
  growth:   {c:'#8b5cf6', label:'Growth'},
  garp:     {c:'#ec6f2b', label:'GARP'},
  balance:  {c:'#c98a12', label:'Balance sheet'},
};

// Icons, one consistent set (Lucide, MIT). 24px grid, 2px stroke, round joins,
// inlined so the PWA stays offline-capable. Same keys as before, so every call
// site updates at once. Sized by their container's `svg` CSS rule.
const LU = (p, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const I = {
  check: LU('<path d="M20 6 9 17l-5-5"/>', 2.4),
  plus: LU('<path d="M5 12h14M12 5v14"/>', 2.2),
  star: LU('<path d="M11.5 3.3a.55.55 0 0 1 1 0l2.16 4.5 4.95.66a.55.55 0 0 1 .31.95l-3.6 3.4.9 4.9a.55.55 0 0 1-.8.58L12 16.9l-4.42 2.4a.55.55 0 0 1-.8-.58l.9-4.9-3.6-3.4a.55.55 0 0 1 .31-.95l4.95-.66z"/>', 1.7),
  starF: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M11.5 3.3a.55.55 0 0 1 1 0l2.16 4.5 4.95.66a.55.55 0 0 1 .31.95l-3.6 3.4.9 4.9a.55.55 0 0 1-.8.58L12 16.9l-4.42 2.4a.55.55 0 0 1-.8-.58l.9-4.9-3.6-3.4a.55.55 0 0 1 .31-.95l4.95-.66z"/></svg>',
  refresh: LU('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>'),
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  sun: LU('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: LU('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
  doc: LU('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M16 13H8M16 17H8M10 9H8"/>', 1.9),
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l1.9 5.6a2 2 0 0 0 1.3 1.3l5.6 1.9-5.6 1.9a2 2 0 0 0-1.3 1.3L12 20.1l-1.9-5.6a2 2 0 0 0-1.3-1.3L3.2 11.3l5.6-1.9a2 2 0 0 0 1.3-1.3z"/></svg>',
  compass: LU('<circle cx="12" cy="12" r="10"/><path d="m15.5 8.5-2.6 6.1-6.1 2.6 2.6-6.1z"/>', 1.9),
  ext: LU('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  upload: LU('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>'),
};

const $ = (s) => document.querySelector(s);
const SKEY = 'meridian.session.v3';

const state = {
  step: 0, theme: 'light',
  // step 1
  screens: null, screensLoading: false, openScreen: null,
  selected: new Set(), interN: null, inter: null, rowIndex: {}, refresh: false,
  // step 2
  researchList: [], allocation: [], activeSymbol: null, activeTab: 'data',
  packetCache: {}, thesisCache: {}, thesisLoading: {}, chartRange: '1y',
  // live quote polling
  basePrice: {}, liveTimer: null, liveAt: 0, activeDocs: [],
  // step 3 (allocation)
  allocationResult: null, allocLoading: false, monthlyCapital: null,
};

/* ---------- session persistence (clears on tab close) ---------- */
function persist() {
  try {
    sessionStorage.setItem(SKEY, JSON.stringify({
      researchList: state.researchList, allocation: state.allocation, theses: state.thesisCache,
      activeSymbol: state.activeSymbol, activeTab: state.activeTab, step: state.step, theme: state.theme,
    }));
  } catch {}
}
function restore() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SKEY));
    if (!s) return;
    state.researchList = s.researchList || [];
    state.allocation = s.allocation || [];
    state.thesisCache = s.theses || {};
    state.activeSymbol = s.activeSymbol || null;
    state.activeTab = s.activeTab || 'data';
    state.step = (s.step != null ? s.step : 0);
    state.theme = s.theme || 'light';
  } catch {}
}

/* ---------- formatting ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Agent text can carry light markdown (**bold**). Escape first (no HTML injection),
// then promote **x** to real bold so users never see literal asterisks. Also drops a
// stray leading "; " / bullet the model sometimes prepends.
const mdBold = (s) => esc(String(s ?? '').replace(/^\s*[;:*-]\s+/, '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const has = (v) => v != null && v !== '' && !(typeof v === 'number' && !isFinite(v));
const num = (v, suf = '') => (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) ? '-' : (v + suf);
const n2 = (v) => v == null || !isFinite(v) ? '-' : (Math.round(v * 100) / 100).toLocaleString('en-IN');
function cr(v) { if (v == null || !isFinite(v)) return '-'; return v >= 100000 ? '₹' + (v / 100000).toFixed(2) + 'L cr' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' cr'; }
function inr(v) { return v == null || !isFinite(v) ? '-' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function abbr(v) { if (v == null || !isFinite(v)) return ''; const a = Math.abs(v); if (a >= 100000) return (v / 100000).toFixed(1) + 'L'; if (a >= 1000) return (v / 1000).toFixed(1) + 'k'; return Math.round(v).toString(); }
function ago(ms) { if (!ms) return 'never'; const s = (Date.now() - ms) / 1000; if (s < 90) return 'just now'; const m = s / 60; if (m < 90) return Math.round(m) + 'm ago'; const h = m / 60; if (h < 36) return Math.round(h) + 'h ago'; return Math.round(h / 24) + 'd ago'; }

/* ============================ NAVIGATION ============================ */
function goStep(n) {
  state.step = n; persist();
  const hero = $('#hero');
  document.body.classList.toggle('hero-on', n === 0);
  if (hero) hero.classList.toggle('show', n === 0);
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('show'));
  if (n >= 1) $('#view-' + n).classList.add('show');
  document.querySelectorAll('.step').forEach((b) => b.classList.toggle('on', +b.dataset.step === n));
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (n !== 2) stopLive();                          // live polling only while researching
  if (n === 1) ensureScreens();
  if (n === 2) { enterResearch(); const rn = $('#rsNext'); if (rn) rn.style.display = state.researchList.length ? 'flex' : 'none'; }
  if (n === 3) renderAllocation();
}
function renderBadges() {
  const set = (id, n) => { const el = $(id); el.textContent = n; el.classList.toggle('show', n > 0); };
  set('#badge1', state.selected.size);
  set('#badge2', state.researchList.length);
  set('#badge3', state.allocation.length);
}

/* ============================ STEP 1 · SHORTLIST ============================ */
async function ensureScreens(force) {
  if (state.screens && !force) { renderScreens(); return; }
  if (state.screensLoading) return;
  state.screensLoading = true;
  $('#screenGrid').innerHTML = `<div class="loading"><span class="spinner"></span> Loading screens…</div>`;
  try {
    const r = await fetch(`${API}/api/screens`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load screens');
    state.screens = data.screens || [];
  } catch (e) {
    $('#screenGrid').innerHTML = apiError('Could not load screens', e.message);
    state.screensLoading = false; return;
  }
  state.screensLoading = false;
  renderScreens();
}
function apiError(title, msg) {
  return `<div class="empty big"><h3>${esc(title)}</h3><p>${esc(msg || '')}<br><span style="color:var(--dim)">Is the Worker deployed and the D1 database created? See the README.</span></p></div>`;
}
function renderLegend() {
  const used = [...new Set((state.screens || []).flatMap((s) => String(s.lens || '').split(',').filter(Boolean)))];
  $('#legend').innerHTML = used.map((l) => `<span><span class="lensdot" style="background:${LENS[l]?.c || '#888'}"></span>${LENS[l]?.label || l}</span>`).join('');
}
function renderScreens() {
  if (!state.screens) return;
  renderLegend();
  $('#screenGrid').innerHTML = state.screens.map((sc) => {
    const sel = state.selected.has(sc.id);
    const lenses = String(sc.lens || '').split(',').filter(Boolean);
    const lc = LENS[lenses[0]]?.c || '#888';
    const pills = lenses.map((l) => `<span class="lenspill"><span class="lensdot" style="background:${LENS[l]?.c || '#888'}"></span>${LENS[l]?.label || l}</span>`).join('');
    const cnt = sc.count > 0 ? `${sc.count} loaded · ${ago(sc.updated_at)} · view list →` : `tap to fetch live from Screener →`;
    return `<div class="screen ${sel ? 'sel' : ''}" onclick="onScreenClick('${sc.id}')">
      <div class="top">
        <div class="nm"><span class="lensdot" style="background:${lc}"></span>${esc(sc.name)}</div>
        <div class="chk" onclick="toggleSel('${sc.id}', event)">${I.check}</div>
      </div>
      <div class="lenspills">${pills}</div>
      <div class="gauge">${esc(sc.gauge)}</div>
      <div class="formula">${sc.formula || ''}</div>
      <div class="cnt"><span>${cnt}</span>${sc.screener_url ? `<a href="${esc(sc.screener_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Screener ↗</a>` : ''}</div>
    </div>`;
  }).join('');
  const n = state.selected.size;
  $('#selCount').textContent = n;
  const btn = $('#interBtn');
  btn.disabled = n < 2;
  btn.textContent = n < 2 ? 'Find intersection' : `Find intersection · ${n} screens`;
  renderBadges();
}
function onScreenClick(id) { openScreenList(id); }
function toggleSel(id, e) { if (e) e.stopPropagation(); state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id); renderScreens(); }
function clearSel() { state.selected.clear(); renderScreens(); }

async function openScreenList(id, force) {
  state.openScreen = id;
  const sc = (state.screens || []).find((s) => s.id === id) || { name: id, lens: 'value' };
  const lenses = String(sc.lens || '').split(',').filter(Boolean);
  const lc = LENS[lenses[0]]?.c || '#888';
  $('#interMount').innerHTML = '';
  $('#screenListMount').innerHTML = `<div class="listwrap"><div class="loading"><span class="spinner"></span> Fetching “${esc(sc.name)}” live from Screener…</div></div>`;
  $('#screenListMount').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  let data;
  try {
    const r = await fetch(`${API}/api/screens/${encodeURIComponent(id)}?limit=100${force ? '&refresh=1' : ''}`);
    data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
  } catch (e) { $('#screenListMount').innerHTML = `<div class="listwrap">${apiError('Could not load this screen', e.message)}</div>`; return; }
  const entries = data.entries || [], src = data.source || {};
  const card = (state.screens || []).find((s) => s.id === id);
  if (card) { card.count = Math.max(card.count || 0, entries.length); card.updated_at = src.updated_at || card.updated_at; renderScreens(); }
  entries.forEach((en) => { state.rowIndex[en.symbol] = state.rowIndex[en.symbol] || { symbol: en.symbol, company: en.company }; });
  const rows = entries.map((en) => screenRow(en)).join('');
  const srcNote = src.error ? `<span class="srcbad">Screener unavailable</span>` : `<span class="srcok">${src.from === 'cache' ? 'cached' : 'live'} · ${ago(src.updated_at)}</span>`;
  $('#screenListMount').innerHTML = `
    <div class="listwrap">
      <div class="listhead">
        <div class="ttl"><span class="lensdot" style="background:${lc}"></span>${esc(sc.name)}</div>
        <div class="meta">${srcNote} · ${entries.length} shown · <button class="add" style="padding:5px 10px" onclick="openScreenList('${id}', true)">${I.refresh} refresh</button> · <button class="add" style="padding:5px 10px" onclick="closeScreenList()">close ✕</button></div>
      </div>
      <div class="rowscroll">${rows || `<div class="empty"><h3>No entries</h3><p>${src.error ? 'Screener couldn’t be reached. Try refresh, or load this screen manually.' : 'This screen returned no rows.'}</p></div>`}</div>
    </div>`;
}
function closeScreenList() { state.openScreen = null; $('#screenListMount').innerHTML = ''; }
function screenRow(en) {
  const added = state.researchList.some((x) => x.symbol === en.symbol);
  return `<div class="row">
    <div class="rank">${en.rank}</div>
    <div class="co"><div class="t">${esc(en.company)}</div><div class="s">${esc(en.symbol)}</div></div>
    <div class="num hide-m">${esc(en.metric_label || '')}</div>
    <div class="num"><b>${esc(en.metric_value || '')}</b></div>
    <button class="add ${added ? 'added' : ''}" onclick="addToResearch('${esc(en.symbol)}', event)">${added ? I.check + ' Added' : I.plus + ' Research'}</button>
  </div>`;
}

/* ---------- intersection ---------- */
function openInterDialog() {
  if (state.selected.size < 2) return;
  const names = (state.screens || []).filter((s) => state.selected.has(s.id)).map((s) => s.name);
  $('#modal').className = 'modal';
  $('#modal').innerHTML = `
    <button class="close-x" onclick="closeOverlay()">✕</button>
    <div class="mh"><div class="ic">${I.compass}</div>
      <h3>How deep should we read?</h3>
      <p>Take the top N from each screen, then keep only companies in <b>every</b> selected screen. Tighter = higher conviction.</p>
    </div>
    <div class="selnote">Intersecting <b>${names.length} screens</b>: ${names.map(esc).join(' · ')}</div>
    <div class="mb"><div class="nopts">
      ${[25, 50, 100].map((n) => `<button class="nopt ${state.interN === n ? 'on' : ''}" data-n="${n}" onclick="pickN(${n})">${n}<small>entries</small></button>`).join('')}
    </div></div>
    <div class="mf">
      <button class="btn btn-ghost btn-sm" onclick="closeOverlay()">Cancel</button>
      <button class="btn btn-primary btn-sm" id="runInter" onclick="runIntersection()" ${state.interN ? '' : 'disabled'}>Show intersection</button>
    </div>`;
  showOverlay();
}
function pickN(n) { state.interN = n; document.querySelectorAll('.nopt').forEach((b) => b.classList.toggle('on', +b.dataset.n === n)); const r = $('#runInter'); if (r) r.disabled = false; }
async function runIntersection() {
  const ids = [...state.selected]; const limit = state.interN || 50;
  closeOverlay(); closeScreenList();
  $('#interMount').innerHTML = `<div class="listwrap"><div class="loading"><span class="spinner"></span> Computing exact overlap across ${ids.length} screens…</div></div>`;
  $('#interMount').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  let data;
  try {
    const r = await fetch(`${API}/api/intersection`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screenIds: ids, limit, refresh: state.refresh }) });
    data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
  } catch (e) { $('#interMount').innerHTML = `<div class="listwrap">${apiError('Intersection failed', e.message)}</div>`; return; }
  state.inter = data;
  (data.results || []).forEach((row) => { state.rowIndex[row.symbol] = row; });
  renderIntersection(data);
}
function renderIntersection(data) {
  const names = (state.screens || []).filter((s) => data.screenIds.includes(s.id)).map((s) => s.name);
  const warn = data.warning ? `<div class="warnbar">${I.refresh} ${esc(data.warning)}</div>` : '';
  if (!data.count) {
    $('#interMount').innerHTML = `<div class="listwrap"><div class="listhead"><div class="ttl">${I.compass} Intersection</div><div class="meta">Top ${data.limit} · ${names.length} screens</div></div>
      <div class="empty">${data.warning ? `<h3>Couldn’t fetch from Screener</h3><p>${esc(data.warning)}</p>` : `<h3>No intersection</h3><p>No company appears in all ${names.length} selected screens at this depth.</p>`}</div></div>`;
    return;
  }
  const rows = data.results.map((r, i) => {
    const added = state.researchList.some((x) => x.symbol === r.symbol);
    return `<div class="row">
      <div class="rank">${i + 1}</div>
      <div class="co"><div class="t">${esc(r.company)}</div><div class="s">${esc(r.symbol)}${r.sector ? ' · ' + esc(r.sector) : ''}</div></div>
      <div class="num hide-m">${cr(r.mcap)}</div>
      <div class="num"><span style="color:var(--dim)">ROCE·PE</span><br><b>${num(r.roce, '%')} · ${num(r.pe)}</b></div>
      <button class="add ${added ? 'added' : ''}" onclick="addToResearch('${esc(r.symbol)}', event)">${added ? I.check + ' Added' : I.plus + ' Research'}</button>
    </div>`;
  }).join('');
  $('#interMount').innerHTML = `<div class="listwrap" style="border-color:var(--accent)">
    <div class="listhead"><div class="ttl">${I.compass} Intersection · ${data.count} survivor${data.count === 1 ? '' : 's'}</div><div class="meta">Top ${data.limit} of each · ${names.length} screens · exact</div></div>
    ${warn}<div class="rowscroll">${rows}</div></div>`;
}

/* ---------- manual loader (fallback if Screener blocks the Worker IP) ---------- */
function openLoader() {
  const opts = (state.screens || []).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#modal').className = 'modal wide';
  $('#modal').innerHTML = `<button class="close-x" onclick="closeOverlay()">✕</button>
    <div class="mh"><div class="ic">${I.upload}</div><h3>Load a screen manually</h3>
      <p>Fallback for when Screener blocks the server. Paste the on-screen list (one company per line) or a CSV export. Row order = rank.</p></div>
    <div class="mb"><div class="loaderbody">
      <div><label>Which screen</label><select id="ldScreen">${opts}</select></div>
      <div><label>Admin token <span style="color:var(--dim)">(your ADMIN_TOKEN; blank if unset)</span></label><input type="password" id="ldTok" placeholder="optional"></div>
      <div><label>Paste list or CSV</label><textarea id="ldText" rows="7" placeholder="Reliance Industries
TCS
HDFC Bank
…"></textarea></div>
      <div id="ldMsg" class="ldmsg"></div>
    </div></div>
    <div class="mf"><button class="btn btn-ghost btn-sm" onclick="closeOverlay()">Cancel</button><button class="btn btn-primary btn-sm" onclick="submitLoader()">Load</button></div>`;
  showOverlay();
}
function parseLoaderText(text) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const isCsv = lines[0].includes(',') && /name|code|symbol|company/i.test(lines[0]);
  if (isCsv) {
    const header = splitCsv(lines[0]).map((h) => h.toLowerCase().trim());
    const nameI = header.findIndex((h) => h === 'name' || h.includes('company'));
    const codeI = header.findIndex((h) => h.includes('nse') || h.includes('bse') || h === 'symbol' || h.includes('code'));
    const out = [];
    for (let i = 1; i < lines.length; i++) { const c = splitCsv(lines[i]); const company = (nameI >= 0 ? c[nameI] : c[0] || '').trim(); if (!company) continue; const code = (codeI >= 0 && c[codeI] ? c[codeI] : company).trim(); out.push({ rank: out.length + 1, symbol: normKey(code), company, ticker: codeI >= 0 ? code : null }); }
    return out;
  }
  return lines.map((l, i) => { const company = l.replace(/^\s*\d+[.)]\s*/, '').trim(); return { rank: i + 1, symbol: normKey(company), company }; }).filter((x) => x.company);
}
function splitCsv(line) { const out = []; let f = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else { if (c === '"') q = true; else if (c === ',') { out.push(f); f = ''; } else f += c; } } out.push(f); return out.map((s) => s.trim()); }
function normKey(s) { return String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 40); }
async function submitLoader() {
  const screenId = $('#ldScreen').value, tok = $('#ldTok').value.trim(), entries = parseLoaderText($('#ldText').value), msg = $('#ldMsg');
  if (!entries.length) { msg.innerHTML = `<span class="srcbad">Nothing to load.</span>`; return; }
  msg.innerHTML = `<span class="spinner"></span> Loading ${entries.length} rows…`;
  try {
    const r = await fetch(`${API}/api/admin/load`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': tok }, body: JSON.stringify({ screenId, entries, replace: true }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    msg.innerHTML = `<span class="srcok">Loaded ${data.loaded} into ${esc(screenId)} (total ${data.total}).${data.protected ? '' : ' ⚠ No ADMIN_TOKEN set.'}</span>`;
    state.screens = null; await ensureScreens(true);
  } catch (e) { msg.innerHTML = `<span class="srcbad">${esc(e.message)}</span>`; }
}

/* ============================ RESEARCH LIST PLUMBING ============================ */
function addToResearch(symbol, e) {
  if (e) e.stopPropagation();
  if (!state.researchList.some((x) => x.symbol === symbol)) {
    const row = state.rowIndex[symbol] || { symbol, company: symbol };
    state.researchList.push({ symbol, company: row.company || symbol, sector: row.sector ?? null, mcap: row.mcap ?? null, roce: row.roce ?? null, pe: row.pe ?? null, de: row.de ?? null });
    persist();
    toast(`${row.company || symbol} added to research`);
  }
  if (state.openScreen) openScreenList(state.openScreen);
  if (state.inter) renderIntersection(state.inter);
  renderBadges();
}
function removeFromResearch(symbol) {
  state.researchList = state.researchList.filter((x) => x.symbol !== symbol);
  if (state.activeSymbol === symbol) state.activeSymbol = state.researchList[0]?.symbol || null;
  persist(); enterResearch();
}
function toggleAlloc(symbol, e) {
  if (e) e.stopPropagation();
  const i = state.allocation.indexOf(symbol);
  if (i >= 0) state.allocation.splice(i, 1); else state.allocation.push(symbol);
  state.allocationResult = null;        // the flagged set changed → any sized plan is stale
  persist(); renderSidebar(); renderBadges();
  toast(i >= 0 ? 'Removed from allocation' : 'Added to allocation');
}

/* ============================ STEP 2 · RESEARCH ============================ */
function enterResearch() {
  if (!state.researchList.length) {
    $('#sidebar').innerHTML = `<div class="sb-h">Research</div><div class="sb-empty">No stocks yet. Go to <b>Shortlist</b>, build an intersection and hit <b>Research</b> on the names you want to study.</div>`;
    $('#rsHead').innerHTML = '';
    $('#rsTabs').style.display = 'none';
    $('#rsBody').innerHTML = `<div class="empty big" style="margin-top:30px"><h3>Nothing to research yet</h3><p>Shortlisted stocks appear here with their full data and an AI thesis.</p></div>`;
    return;
  }
  if (!state.activeSymbol || !state.researchList.some((x) => x.symbol === state.activeSymbol)) state.activeSymbol = state.researchList[0].symbol;
  renderSidebar();
  $('#rsTabs').style.display = 'flex';
  selectStock(state.activeSymbol);
}
function renderSidebar() {
  const items = state.researchList.map((s) => {
    const on = s.symbol === state.activeSymbol;
    const alloc = state.allocation.includes(s.symbol);
    return `<div class="sl-item ${on ? 'on' : ''}" onclick="selectStock('${esc(s.symbol)}')">
      <div class="sl-body"><div class="sl-name">${esc(s.company)}</div><div class="sl-sub">${esc(s.symbol)}${s.sector ? ' · ' + esc(s.sector) : ''}</div></div>
      <button class="sl-alloc ${alloc ? 'on' : ''}" title="${alloc ? 'In allocation list' : 'Add to allocation'}" onclick="toggleAlloc('${esc(s.symbol)}', event)">${alloc ? I.starF : I.star}</button>
    </div>`;
  }).join('');
  $('#sidebar').innerHTML = `<div class="sb-h">Research · ${state.researchList.length}</div>${items}`;
}
async function selectStock(symbol) {
  state.activeSymbol = symbol; persist();
  renderSidebar();                  // re-highlight the active item
  setTab(state.activeTab, true);    // render the current tab for the new stock
  startLive(symbol);                // begin live-price polling for this name
}
function setTab(tab, keep) {
  state.activeTab = tab; persist();
  document.querySelectorAll('.rs-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'data') renderStockData();
  else renderThesisTab();
}
async function ensureStock(symbol, force) {
  if (state.packetCache[symbol] && !force) return state.packetCache[symbol];
  const r = await fetch(`${API}/api/stocks/${encodeURIComponent(symbol)}${force ? '?refresh=1' : ''}`);
  const data = await r.json();
  state.packetCache[symbol] = r.ok ? data : { error: data.error || 'not found', stock: null, packet: null };
  return state.packetCache[symbol];
}
function renderHead(d) {
  const st = (d && d.stock) || state.researchList.find((x) => x.symbol === state.activeSymbol) || { symbol: state.activeSymbol, company: state.activeSymbol };
  const live = d && d.live;
  const base = (live && live.price != null) ? live.price : (st.price != null ? st.price : null);
  if (base != null) state.basePrice[state.activeSymbol] = base;     // reference for live scaling
  let price = '';
  if (live && live.price != null) {
    const chg = live.prevClose != null ? (live.price / live.prevClose - 1) * 100 : null;
    price = `<div class="sd-pricewrap">
      <div class="sd-price" id="livePrice">${inr(live.price)}</div>
      <div class="sd-chg ${chg == null ? '' : (chg >= 0 ? 'up' : 'down')}" id="liveChg">${chg == null ? '-' : ((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%')}</div>
      <span class="livetag"><span class="livedot"></span><span id="liveAgo">live</span></span></div>`;
  } else if (st.price) price = `<div class="sd-pricewrap"><div class="sd-price" id="livePrice">${inr(st.price)}</div><div class="sd-chg" id="liveChg">last close</div></div>`;
  $('#rsHead').innerHTML = `<div class="sd-name">${esc(st.company)}</div>
    <div class="sd-sub">${esc(st.symbol)}${st.sector ? ' · ' + esc(st.sector) : ''}${st.mcap ? ' · <span data-live="mul" data-base="' + st.mcap + '" data-fmt="cr">' + cr(st.mcap) + '</span>' : ''}</div>${price}`;
}

/* ---------- Stock Data tab (6 buckets) ---------- */
async function renderStockData() {
  const sym = state.activeSymbol;
  $('#rsBody').innerHTML = `<div class="loading"><span class="spinner"></span> Fetching ${esc(sym)} from Screener &amp; Yahoo…</div>`;
  const d = await ensureStock(sym);
  if (state.activeSymbol !== sym) return;        // user switched while loading
  renderHead(d);
  if (d.error || !d.packet) { $('#rsBody').innerHTML = apiError('Could not load this stock', d.error || 'no data'); return; }
  const p = d.packet, src = d.source || {};
  const srcWarn = src.error ? `<div class="warnbar">${I.refresh} Couldn’t fully reach Screener (${esc(src.error)}). Showing what we have; live price still works.</div>` : '';
  $('#rsBody').innerHTML = srcWarn + bucketProfile(p) + bucketFinancials(p) + bucketQuality(p) + bucketValuation(p, sym) + bucketIndustry(p) + bucketGovernance(p);
  if ($('#nativeChart')) loadNativeChart(p.profile.ticker || sym);
}
function bH(n, title, hint) { return `<div class="bucket-h"><span class="bn">${n}</span><h3>${title}</h3>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`; }
function kpi(k, v, x, cls, attr) { return `<div class="card kpi"><div class="k">${k}</div><div class="v ${cls || ''}" ${attr || ''}>${v}</div>${x ? `<div class="x">${x}</div>` : ''}</div>`; }
// live-scaling attr: a price-derived number that should track the live price.
// dir 'mul' scales with price (P/E, mcap…), 'div' inversely (dividend yield).
function lv(base, fmt, dir) { return (base == null || !isFinite(base)) ? '' : `data-live="${dir || 'mul'}" data-base="${base}" data-fmt="${fmt}"`; }

function bucketProfile(p) {
  const a = p.profile;
  const owners = [['Promoter', a.promoter_pct], ['FII', a.fii_pct], ['DII', a.dii_pct], ['Public', a.public_pct]];
  const ownerRows = owners.filter(([, v]) => has(v)).map(([k, v]) => `<dt>${k}</dt><dd>${num(v, '%')}</dd>`).join('')
    + (has(a.pledge_pct) ? `<dt>Promoter pledge</dt><dd class="${a.pledge_pct > 0 ? 'down' : ''}">${num(a.pledge_pct, '%')}</dd>` : '');
  const ownerBar = ownerStack(owners);
  // Only render rows that actually have a value, so the panel never shows blank fields.
  const biz = [
    ['Ticker', `${esc(a.symbol)}${a.exchange ? ' · ' + esc(a.exchange) : ''}`],
    ['Sector', has(a.sector) ? esc(a.sector) : null],
    ['Market cap', has(a.market_cap_cr) ? `<span ${lv(a.market_cap_cr, 'cr')}>${cr(a.market_cap_cr)}</span>` : null],
    ['Shares out.', has(a.shares_outstanding_cr) ? n2(a.shares_outstanding_cr) + ' cr' : null],
    ['Book value', has(a.book_value) ? inr(a.book_value) : null],
    ['Face value', has(a.face_value) ? inr(a.face_value) : null],
  ].filter(([, v]) => v != null).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  return `<div class="bucket">${bH('A', 'Company profile')}
    <div class="twocol">
      <div class="panel"><h4>Business</h4>
        <dl class="kv">${biz}</dl>
        ${a.about ? `<p class="about" style="margin-top:12px">${esc(a.about)}</p>` : ''}
      </div>
      <div class="panel"><h4>Ownership</h4>
        ${ownerBar}
        ${ownerRows ? `<dl class="kv" style="margin-top:14px">${ownerRows}</dl>` : ''}
      </div>
    </div></div>`;
}
function ownerStack(owners) {
  const segs = owners.filter(([, v]) => v != null && v > 0);
  if (!segs.length) return '<p class="about">Shareholding not available.</p>';
  const cols = ['var(--accent)', '#3b82f6', '#8b5cf6', 'var(--dim)'];
  let acc = 0;
  const bar = segs.map(([k, v], i) => { const seg = `<div title="${k} ${v}%" style="width:${Math.min(100, v)}%;background:${cols[i % cols.length]}"></div>`; acc += v; return seg; }).join('');
  return `<div style="display:flex;height:14px;border-radius:7px;overflow:hidden;border:1px solid var(--line)">${bar}</div>`;
}

function bucketFinancials(p) {
  const c = p.financials.charts;
  const charts = [];
  if (c.revenue?.length) charts.push(chartCard('Revenue (₹ cr)', barsSVG(c.revenue, { color: 'var(--accent)', fmt: 'cr' })));
  if (c.pat?.length) charts.push(chartCard('Net profit (₹ cr)', barsSVG(c.pat, { color: '#3b82f6', allowNeg: true, fmt: 'cr' })));
  const marg = [];
  if (c.opm?.length) marg.push({ name: 'OPM %', color: 'var(--accent)', points: c.opm });
  if (c.net_margin?.length) marg.push({ name: 'Net margin %', color: '#8b5cf6', points: c.net_margin });
  if (marg.length) charts.push(chartCard('Margins', linesSVG(alignSeries(marg), { pct: true }), marg.map((m) => `<i><span class="sw" style="background:${m.color}"></span>${m.name}</i>`).join('')));
  const cfs = [];
  if (c.ocf?.length) cfs.push({ name: 'Operating CF', color: 'var(--accent)', points: c.ocf });
  if (c.fcf?.length) cfs.push({ name: 'Free CF', color: '#0aa66e', points: c.fcf });
  if (cfs.length) charts.push(chartCard('Cash flow (₹ cr)', groupedBarsSVG(alignSeries(cfs), { allowNeg: true, fmt: 'cr' }), cfs.map((m) => `<i><span class="sw" style="background:${m.color}"></span>${m.name}</i>`).join('')));
  const dc = [];
  if (c.debt?.length) dc.push({ name: 'Debt', color: 'var(--neg)', points: c.debt });
  if (c.cash?.length) dc.push({ name: 'Cash', color: 'var(--pos)', points: c.cash });
  if (dc.length) charts.push(chartCard('Debt vs cash (₹ cr)', groupedBarsSVG(alignSeries(dc), { fmt: 'cr' }), dc.map((m) => `<i><span class="sw" style="background:${m.color}"></span>${m.name}</i>`).join('')));

  const tables = ['pnl', 'balance_sheet', 'cash_flow'].map((k) => finTable(k === 'pnl' ? 'Profit & Loss' : k === 'balance_sheet' ? 'Balance Sheet' : 'Cash Flow', p.financials.annual[k]))
    .concat([finTable('Quarterly Results', p.financials.quarterly)]).filter(Boolean).join('');
  const chartsHtml = charts.length ? `<div class="chgrid2">${charts.join('')}</div>` : `<div class="gapnote">Financial statement tables weren’t captured from Screener for this name, try Refresh on the stock, or check the Screener link.</div>`;
  return `<div class="bucket">${bH('B', 'Historical financials')}${chartsHtml}${tables}</div>`;
}
function finTable(title, t) {
  if (!t || !t.columns || !Object.keys(t.rows || {}).length) return '';
  const head = `<tr><th>${esc(title)}</th>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const body = Object.entries(t.rows).map(([label, vals]) => `<tr><td>${esc(label)}</td>${vals.map((v) => `<td>${v == null ? '' : n2(v)}</td>`).join('')}</tr>`).join('');
  return `<details class="fin"><summary>${esc(title)}</summary><div class="dwrap"><table class="dtable"><thead>${head}</thead><tbody>${body}</tbody></table></div></details>`;
}

function bucketQuality(p) {
  const q = p.quality;
  const C = (raw, html) => (has(raw) ? html : '');     // drop a KPI card when its value is missing
  const cards = [
    C(q.roce_pct, kpi('ROCE', num(q.roce_pct, '%'), 'return on capital')),
    C(q.roe_pct, kpi('ROE', num(q.roe_pct, '%'), 'return on equity')),
    C(q.roa_pct, kpi('ROA', num(q.roa_pct, '%'), 'return on assets')),
    C(q.asset_turnover, kpi('Asset turnover', num(q.asset_turnover, '×'), 'sales / assets')),
    C(q.interest_coverage, kpi('Interest cover', num(q.interest_coverage, '×'), 'EBIT / interest')),
    C(q.debt_to_equity, kpi('Debt / Equity', num(q.debt_to_equity), q.debt_to_equity == null ? '' : (q.debt_to_equity < 0.3 ? 'low' : q.debt_to_equity < 1 ? 'moderate' : 'high'))),
    C(q.debt_to_ebitda, kpi('Debt / EBITDA', num(q.debt_to_ebitda, '×'), 'leverage')),
    C(q.fcf_yield_pct, kpi('FCF yield', num(q.fcf_yield_pct, '%'), 'FCF / mcap')),
    C(q.cfo_to_pat, kpi('CFO / PAT', num(q.cfo_to_pat, '×'), 'earnings quality')),
    C(q.revenue_cagr_pct, kpi('Revenue CAGR', num(q.revenue_cagr_pct, '%'), 'long-run')),
    C(q.pat_cagr_pct, kpi('PAT CAGR', num(q.pat_cagr_pct, '%'), 'long-run')),
    C(q.cash_conversion_cycle, kpi('Cash cycle', num(q.cash_conversion_cycle), 'days')),
  ].filter(Boolean).join('');
  const wc = [['Debtor', q.debtor_days], ['Inventory', q.inventory_days], ['Payable', q.payable_days], ['CCC', q.cash_conversion_cycle]].filter(([, v]) => has(v));
  const wcChart = q.roce_trend?.length ? chartCard('ROCE trend (%)', linesSVG(alignSeries([{ name: 'ROCE', color: 'var(--accent)', points: q.roce_trend }]), { pct: true })) : '';
  const wcCards = wc.length ? `<div class="chartcard"><h4>Working-capital cycle (days)</h4>${barsSVG(wc.map(([p2, v]) => ({ p: p2, v })), { color: 'var(--accent)', labelEach: true })}</div>` : '';
  const second = (wcChart || wcCards) ? `<div class="chgrid2" style="margin-top:14px">${wcChart}${wcCards}</div>` : '';
  if (!cards && !second) return '';                    // no efficiency data at all, drop the whole block
  const grid = cards ? `<div class="cardgrid c4">${cards}</div>` : '';
  return `<div class="bucket">${bH('C', 'Efficiency & quality')}${grid}${second}</div>`;
}

function bucketValuation(p, sym) {
  const v = p.valuation;
  const C = (raw, html) => (has(raw) ? html : '');     // drop a KPI card when its value is missing
  const cards = [
    C(v.pe, kpi('P/E', num(v.pe), 'price / earnings', '', lv(v.pe, 'num'))),
    C(v.pb, kpi('P/B', num(v.pb), 'price / book', '', lv(v.pb, 'num'))),
    C(v.ev_ebitda, kpi('EV/EBITDA', num(v.ev_ebitda, '×'), '', '', lv(v.ev_ebitda, 'x'))),
    C(v.ev_sales, kpi('EV/Sales', num(v.ev_sales, '×'), '', '', lv(v.ev_sales, 'x'))),
    C(v.p_fcf, kpi('P/FCF', num(v.p_fcf, '×'), '', '', lv(v.p_fcf, 'x'))),
    C(v.dividend_yield_pct, kpi('Div yield', num(v.dividend_yield_pct, '%'), 'trailing', '', lv(v.dividend_yield_pct, 'pct', 'div'))),
    C(v.high_52w, kpi('52w high', inr(v.high_52w), '', '', 'data-live="q_high" data-fmt="inr"')),
    C(v.low_52w, kpi('52w low', inr(v.low_52w), '', '', 'data-live="q_low" data-fmt="inr"')),
  ].filter(Boolean).join('');
  const ret = v.returns || {};
  const order = [['1m', '1m'], ['3m', '3m'], ['6m', '6m'], ['1y', '1y'], ['3y', '3y'], ['5y', '5y']];
  const heat = order.filter(([k]) => ret[k] != null).map(([k, lab]) => { const val = ret[k]; const cls = val >= 0 ? 'pos' : 'neg'; return `<div class="ret ${cls}"><div class="rk">${lab}</div><div class="rv">${(val >= 0 ? '+' : '') + val}%</div></div>`; }).join('');
  const heatHtml = heat ? `<div class="panel" style="margin-top:14px"><h4>Price returns</h4><div class="returns">${heat}</div></div>` : '';
  const price = `<div class="pricebox" style="margin-top:14px">
      <div class="pricebar"><div style="font-weight:700;font-size:13px" id="chTitle">${esc(sym)} · Price</div>
        <div class="rangebtns">${['6mo', '1y', '5y'].map((r) => `<button class="${state.chartRange === r ? 'on' : ''}" onclick="setChartRange('${r}')">${r.toUpperCase()}</button>`).join('')}</div></div>
      <div id="nativeChart"><div class="loading"><span class="spinner"></span> Loading price history…</div></div></div>`;
  const peers = peersTable(v.peers, sym);
  const cardgrid = cards ? `<div class="cardgrid c4">${cards}</div>` : '';
  return `<div class="bucket">${bH('D', 'Valuation & market')}${cardgrid}${heatHtml}${price}${peers ? `<div class="panel" style="margin-top:14px"><h4>Peer comparison (Screener)</h4>${peers}</div>` : ''}</div>`;
}
function peersTable(peers, sym) {
  if (!peers || !peers.rows?.length) return '';
  const h = peers.headers || [];
  return `<div class="dwrap"><table class="peers"><thead><tr>${h.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${peers.rows.map((r) => { const me = r.symbol === sym; return `<tr class="${me ? 'me' : ''}">${r.cells.map((c, i) => `<td>${i === 1 ? `<b>${esc(c)}</b>` : esc(c)}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>`;
}

function bucketIndustry(p) {
  const peers = peersTable(p.industry.peers, p.profile.symbol);
  return `<div class="bucket">${bH('E', 'Industry & competition')}
    <div class="panel"><dl class="kv"><dt>Sector</dt><dd>${esc(p.industry.sector || '-')}</dd></dl>
      ${peers ? `<div style="margin-top:12px">${peers}</div>` : ''}
      <div class="gapnote"><b>Industry size, growth, market share &amp; regulation</b> aren’t in free structured sources, the <b>Agent Thesis</b> researches these live from the web and cites its sources.</div>
    </div></div>`;
}

function bucketGovernance(p) {
  const g = p.governance;
  const sh = g.shareholding_trend;
  const trend = sh && sh.columns?.length ? finTableOpen('Shareholding trend (%)', sh) : '';
  const flags = (g.pros?.length || g.cons?.length) ? `<div class="twocol" style="margin-top:14px">
      <div class="panel"><h4>What’s working (Screener)</h4><div class="flags">${(g.pros || []).map((x) => `<div class="flag ok"><div class="ic">✓</div><div>${esc(x)}</div></div>`).join('') || '<p class="about">-</p>'}</div></div>
      <div class="panel"><h4>Watch-outs (Screener)</h4><div class="flags">${(g.cons || []).map((x) => `<div class="flag watch"><div class="ic">!</div><div>${esc(x)}</div></div>`).join('') || '<p class="about">-</p>'}</div></div>
    </div>` : '';
  const docHtml = renderDocsSection(g.documents);
  return `<div class="bucket">${bH('F', 'Management, governance & events')}
    ${trend}${flags}${docHtml}
    <div class="gapnote"><b>Board/auditor changes, related-party flags, litigation &amp; recent news</b> aren’t fetched here, the <b>Agent Thesis</b> researches material events live and flags governance risks.</div>
  </div>`;
}
function finTableOpen(title, t) {
  if (!t || !Object.keys(t.rows || {}).length) return '';
  const head = `<tr><th>${esc(title)}</th>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const body = Object.entries(t.rows).map(([label, vals]) => `<tr><td>${esc(label)}</td>${vals.map((v) => `<td>${v == null ? '' : n2(v)}</td>`).join('')}</tr>`).join('');
  return `<div class="dwrap"><table class="dtable"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- documents: filings & concalls as useful cards + in-app viewer ---------- */
// Accepts the worker's rich shape (concalls/annual_reports/ratings of objects) and
// the older {href,text} shape, and flattens to one openable card per document.
function normalizeDocs(docs) {
  if (!docs) return [];
  const out = [], seen = new Set();
  const isPdf = (h) => /\.pdf(\?|#|$)/i.test(h);
  const ok = (h) => /^https?:\/\//i.test(h);          // only links that actually open
  const add = (arr, kind) => (arr || []).forEach((d) => {
    if (!d) return;
    if (typeof d === 'string') { if (ok(d) && !seen.has(d)) { seen.add(d); out.push({ kind, type: 'Document', title: d, href: d, date: '', source: '', blurb: blurbFor(kind, ''), isPdf: isPdf(d) }); } return; }
    const href = d.href || d.url || ''; if (!ok(href) || seen.has(href)) return;
    seen.add(href);
    const type = d.type || d.label || d.text || 'Document';
    out.push({
      kind: d.kind || kind, type,
      title: d.title || d.text || d.label || type,
      date: d.date || '', source: d.source || '',
      blurb: d.blurb || blurbFor(d.kind || kind, type),
      href, isPdf: d.isPdf != null ? d.isPdf : isPdf(href),
    });
  });
  if (Array.isArray(docs)) { add(docs, 'concall'); return out; }
  add(docs.concalls, 'concall'); add(docs.annual_reports, 'annual'); add(docs.ratings, 'rating');
  return out;
}
function blurbFor(kind, type) {
  const t = (String(kind) + ' ' + String(type)).toLowerCase();
  if (/annual/.test(t)) return 'Full-year report to shareholders';
  if (/rating/.test(t)) return 'Agency credit-rating note';
  if (/transcript/.test(t)) return 'Earnings-call transcript';
  if (/note/.test(t)) return 'Concall notes / summary';
  if (/ppt|present|deck/.test(t)) return 'Investor presentation slides';
  if (/rec|audio/.test(t)) return 'Earnings-call recording';
  if (/concall|earnings/.test(t)) return 'Earnings-call document';
  return 'Company filing';
}
function docThumb(d) {
  const t = (d.type + ' ' + d.kind).toLowerCase();
  if (/annual/.test(t)) return 't-annual';
  if (/rating/.test(t)) return 't-rating';
  if (/note/.test(t)) return 't-notes';
  if (/ppt|present|deck/.test(t)) return 't-ppt';
  return 't-transcript';
}
function docCard(d, idx) {
  const cls = docThumb(d);
  const fmt = d.isPdf ? 'PDF' : 'WEB';
  const src = d.source ? `<span class="doc-src">${esc(String(d.source).toUpperCase())}</span>` : '';
  const date = d.date ? `<span class="doc-date">${esc(d.date)}</span>` : '';
  return `<button class="doccard" onclick="openDoc(${idx})" title="${esc(d.title)}, opens in a new tab">
    <div class="doc-thumb ${cls}">${I.doc}<span class="doc-fmt">${fmt}</span></div>
    <div class="doc-meta">
      <div class="doc-title">${esc(d.title)}</div>
      <div class="doc-blurb">${esc(d.blurb)}</div>
      <div class="doc-foot">${date}<span class="doc-open">Open &rarr;</span>${src}</div>
    </div>
  </button>`;
}
function renderDocsSection(docs) {
  const list = normalizeDocs(docs);
  state.activeDocs = list;
  if (!list.length) return '';
  return `<div class="panel" style="margin-top:14px"><h4>Filings &amp; concalls <span style="font-weight:500;color:var(--dim);font-size:12px">· ${list.length} document${list.length > 1 ? 's' : ''}</span></h4>
    <div class="docgrid">${list.map((d, i) => docCard(d, i)).join('')}</div></div>`;
}
// Open a document straight at the source (PDF or exchange page) in a new tab.
function openDoc(idx) {
  const d = (state.activeDocs || [])[idx];
  if (!d || !d.href) return;
  window.open(d.href, '_blank', 'noopener');
}

/* ---------- charts (SVG, themeable via currentColor / CSS vars) ---------- */
function chartCard(title, svg, legend) { return `<div class="chartcard"><h4>${esc(title)}${legend ? `<span class="leg">${legend}</span>` : ''}</h4>${svg}</div>`; }

/* Groww-style hover: wrap an SVG with a crosshair + dot(s) + tooltip overlay, and
   carry the per-column data as JSON. preserveAspectRatio="none" makes the viewBox
   map linearly to the box, so we position overlays with simple percentages. */
function iWrap(svg, w, h, cols, fmt) {
  let data = ''; try { data = encodeURIComponent(JSON.stringify({ w, h, fmt: fmt || 'num', cols })); } catch {}
  return `<div class="chartwrap" data-chart="${data}">${svg}<div class="cx"></div><div class="cdots"></div><div class="ctip"></div></div>`;
}
function fmtVal(v, fmt) {
  if (v == null || !isFinite(v)) return '-';
  if (fmt === 'inr') return inr(v);
  if (fmt === 'cr') return '₹' + n2(v) + ' cr';
  if (fmt === 'pct') return n2(v) + '%';
  if (fmt === 'x') return n2(v) + '×';
  return n2(v);
}
let _lastWrap = null;
function hideCross(w) { if (!w) return; const cx = w.querySelector('.cx'), tip = w.querySelector('.ctip'), dots = w.querySelector('.cdots'); if (cx) cx.style.display = 'none'; if (tip) tip.style.display = 'none'; if (dots) dots.innerHTML = ''; }
function chartHover(e) {
  const wrap = e.target && e.target.closest ? e.target.closest('.chartwrap') : null;
  if (wrap !== _lastWrap) { hideCross(_lastWrap); _lastWrap = wrap; }
  if (!wrap) return;
  let d = wrap._cd; if (!d) { try { d = JSON.parse(decodeURIComponent(wrap.dataset.chart)); } catch { return; } wrap._cd = d; }
  if (!d.cols || !d.cols.length) return;
  const rect = wrap.getBoundingClientRect(); if (!rect.width) return;
  const vbx = (e.clientX - rect.left) / rect.width * d.w;
  let best = null, bd = 1e9; for (const c of d.cols) { const dd = Math.abs(c.x - vbx); if (dd < bd) { bd = dd; best = c; } }
  if (!best) return;
  const cx = wrap.querySelector('.cx'), tip = wrap.querySelector('.ctip'), dots = wrap.querySelector('.cdots');
  const lx = best.x / d.w * 100;
  cx.style.left = lx + '%'; cx.style.display = 'block';
  dots.innerHTML = best.ys.map((s) => `<span class="cdot" style="display:block;left:${lx}%;top:${(s.y / d.h * 100)}%;background:${s.c || 'var(--accent)'}"></span>`).join('');
  tip.innerHTML = `<div class="tl">${esc(best.l || '')}</div>` + best.ys.map((s) => `<div class="ts">${s.n ? `<span class="sw" style="background:${s.c}"></span>${esc(s.n)}` : ''}<b>${fmtVal(s.v, d.fmt)}</b></div>`).join('');
  tip.style.display = 'block';
  tip.style.left = Math.max(14, Math.min(86, lx)) + '%';
}
document.addEventListener('pointermove', chartHover, { passive: true });
document.addEventListener('pointerdown', chartHover, { passive: true });
function alignSeries(list) {
  const labels = [];
  for (const s of list) for (const pt of s.points) if (!labels.includes(pt.p)) labels.push(pt.p);
  const rows = list.map((s) => { const map = Object.fromEntries(s.points.map((p) => [p.p, p.v])); return { name: s.name, color: s.color, vals: labels.map((l) => (l in map ? map[l] : null)) }; });
  return { labels, rows };
}
function xLabels(labels, W, pad, n) { const step = Math.max(1, Math.ceil(labels.length / n)); const out = []; for (let i = 0; i < labels.length; i += step) { const x = pad + (labels.length === 1 ? 0 : i / (labels.length - 1) * (W - pad * 1.4)); out.push(`<text x="${x.toFixed(0)}" y="${0}" class="axl" text-anchor="middle">${esc(shortLabel(labels[i]))}</text>`); } return out; }
function shortLabel(l) { const m = String(l).match(/([A-Za-z]{3}).*?(\d{2,4})/); return m ? m[1] + " '" + m[2].slice(-2) : String(l).slice(0, 6); }
function barsSVG(series, opts = {}) {
  const W = 360, H = 170, pad = 30, base = H - 24;
  const vals = series.map((s) => s.v);
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const range = (max - min) || 1;
  const y = (v) => base - (v - min) / range * (base - 16);
  const zeroY = y(0);
  const bw = (W - pad - 8) / series.length * 0.62;
  const cols = [];
  const bars = series.map((s, i) => {
    const cx = pad + (i + 0.5) * (W - pad - 8) / series.length;
    const yy = y(s.v), top = Math.min(yy, zeroY), h = Math.abs(yy - zeroY);
    const col = (opts.allowNeg && s.v < 0) ? 'var(--neg)' : (opts.color || 'var(--accent)');
    cols.push({ x: +cx.toFixed(1), l: String(s.p), ys: [{ y: +yy.toFixed(1), c: col, v: s.v }] });
    const lbl = opts.labelEach ? `<text class="val" x="${cx}" y="${top - 4}" text-anchor="middle">${abbr(s.v)}</text>` : (i === series.length - 1 ? `<text class="val" x="${cx}" y="${top - 4}" text-anchor="middle">${abbr(s.v)}</text>` : '');
    return `<rect class="bar" x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="${col}"/>${lbl}`;
  }).join('');
  const xl = xLabels(series.map((s) => s.p), W, pad, 6).map((t) => t.replace('y="0"', `y="${H - 6}"`)).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none"><line class="grid" x1="${pad}" y1="${zeroY}" x2="${W - 8}" y2="${zeroY}"/>${bars}${xl}</svg>`;
  return iWrap(svg, W, H, cols, opts.fmt || 'num');
}
function groupedBarsSVG(aligned, opts = {}) {
  const { labels, rows } = aligned;
  const W = 360, H = 170, pad = 30, base = H - 24;
  const all = rows.flatMap((r) => r.vals).filter((v) => v != null);
  const max = Math.max(0, ...all), min = Math.min(0, ...all), range = (max - min) || 1;
  const y = (v) => base - (v - min) / range * (base - 16);
  const zeroY = y(0);
  const groupW = (W - pad - 8) / labels.length, bw = groupW * 0.36 / Math.max(1, rows.length / 2);
  let bars = '';
  const cols = [];
  labels.forEach((lab, i) => {
    const gx = pad + i * groupW + groupW * 0.18;
    const ys = [];
    rows.forEach((r, j) => {
      const v = r.vals[i]; if (v == null) return;
      const x = gx + j * (bw + 2), yy = y(v), top = Math.min(yy, zeroY), h = Math.abs(yy - zeroY);
      const col = (opts.allowNeg && v < 0) ? 'var(--neg)' : r.color;
      bars += `<rect class="bar" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="${col}"/>`;
      ys.push({ y: +yy.toFixed(1), c: r.color, v, n: r.name });
    });
    if (ys.length) cols.push({ x: +(pad + i * groupW + groupW / 2).toFixed(1), l: String(lab), ys });
  });
  const xl = xLabels(labels, W, pad, 6).map((t) => t.replace('y="0"', `y="${H - 6}"`)).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none"><line class="grid" x1="${pad}" y1="${zeroY}" x2="${W - 8}" y2="${zeroY}"/>${bars}${xl}</svg>`;
  return iWrap(svg, W, H, cols, opts.fmt || 'num');
}
function linesSVG(aligned, opts = {}) {
  const { labels, rows } = aligned;
  const W = 360, H = 170, pad = 30, base = H - 24, top = 14;
  const all = rows.flatMap((r) => r.vals).filter((v) => v != null);
  if (!all.length) return '<div class="chartwrap"><svg viewBox="0 0 360 170" class="chart"></svg></div>';
  let max = Math.max(...all), min = Math.min(...all); if (opts.pct) { max = Math.max(max, 0); min = Math.min(min, 0); }
  const range = (max - min) || 1;
  const X = (i) => pad + (labels.length === 1 ? 0 : i / (labels.length - 1) * (W - pad * 1.4));
  const Y = (v) => base - (v - min) / range * (base - top);
  const grid = [0, 0.5, 1].map((f) => { const v = min + range * f, yy = Y(v); return `<line class="grid" x1="${pad}" y1="${yy.toFixed(1)}" x2="${W - 8}" y2="${yy.toFixed(1)}"/><text class="axl" x="4" y="${(yy + 3).toFixed(1)}">${Math.round(v)}</text>`; }).join('');
  const paths = rows.map((r) => {
    let d = '', started = false;
    r.vals.forEach((v, i) => { if (v == null) return; d += (started ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' '; started = true; });
    const last = r.vals.map((v, i) => [v, i]).filter(([v]) => v != null).pop();
    const dot = last ? `<circle cx="${X(last[1]).toFixed(1)}" cy="${Y(last[0]).toFixed(1)}" r="3" fill="${r.color}"/>` : '';
    return `<path d="${d}" fill="none" stroke="${r.color}" stroke-width="2" stroke-linejoin="round"/>${dot}`;
  }).join('');
  const cols = [];
  labels.forEach((lab, i) => { const ys = rows.map((r) => (r.vals[i] != null ? { y: +Y(r.vals[i]).toFixed(1), c: r.color, v: r.vals[i], n: r.name } : null)).filter(Boolean); if (ys.length) cols.push({ x: +X(i).toFixed(1), l: String(lab), ys }); });
  const xl = xLabels(labels, W, pad, 6).map((t) => t.replace('y="0"', `y="${H - 6}"`)).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none">${grid}${paths}${xl}</svg>`;
  return iWrap(svg, W, H, cols, opts.pct ? 'pct' : (opts.fmt || 'num'));
}

/* ---------- price chart (Yahoo via /api/chart) ---------- */
async function loadNativeChart(symbol) {
  const mount = document.getElementById('nativeChart'); if (!mount) return;
  try {
    const r = await fetch(`${API}/api/chart/${encodeURIComponent(symbol)}?range=${state.chartRange}`);
    const data = await r.json();
    if (!r.ok || data.error || !data.points?.length) throw new Error(data.error || 'no data');
    mount.innerHTML = priceChart(data.points);
    const t = document.getElementById('chTitle'); if (t && data.ticker) t.textContent = `${data.ticker} · Price (₹)`;
  } catch (e) { mount.innerHTML = `<div class="loading">Chart unavailable (${esc(String(e.message || e))}).</div>`; }
}
function setChartRange(r) { state.chartRange = r; document.querySelectorAll('.rangebtns button').forEach((b) => b.classList.toggle('on', b.textContent.toLowerCase() === r)); const d = state.packetCache[state.activeSymbol]; loadNativeChart((d && d.packet && d.packet.profile.ticker) || state.activeSymbol); }
function priceChart(points) {
  const W = 720, H = 260, pad = 34;
  const xs = points.map((p) => p.t), ys = points.map((p) => p.c);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const X = (t) => pad + (t - minX) / ((maxX - minX) || 1) * (W - pad * 1.4);
  const Y = (c) => (H - pad) - (c - minY) / ((maxY - minY) || 1) * (H - pad * 1.7);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.c).toFixed(1)}`).join(' ');
  const area = `${path} L ${X(maxX).toFixed(1)} ${H - pad} L ${X(minX).toFixed(1)} ${H - pad} Z`;
  const last = ys[ys.length - 1], firstV = ys[0], up = last >= firstV, col = up ? 'var(--pos)' : 'var(--neg)';
  const fmtD = (t) => { const d = new Date(t); return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); };
  const gl = []; for (let i = 0; i <= 4; i++) { const v = minY + (maxY - minY) * i / 4, yv = Y(v); gl.push(`<line x1="${pad}" y1="${yv.toFixed(1)}" x2="${W - pad * 0.4}" y2="${yv.toFixed(1)}" class="grid"/><text x="6" y="${(yv + 3).toFixed(1)}" class="axl">${Math.round(v)}</text>`); }
  const fmtFull = (t) => new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  const cols = points.map((p) => ({ x: +X(p.t).toFixed(1), l: fmtFull(p.t), ys: [{ y: +Y(p.c).toFixed(1), c: col, v: p.c }] }));
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="lchart" preserveAspectRatio="none">
    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".18"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    ${gl.join('')}<path d="${area}" fill="url(#cg)"/><path d="${path}" fill="none" stroke="${col}" stroke-width="2"/>
    <text x="${pad}" y="${H - 8}" class="axl">${fmtD(minX)}</text><text x="${W - pad}" y="${H - 8}" class="axl" text-anchor="end">${fmtD(maxX)}</text></svg>`;
  return iWrap(svg, W, H, cols, 'inr') +
    `<div class="chstat"><span>Low ₹${Math.round(minY)}</span><span>High ₹${Math.round(maxY)}</span><span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${((last / firstV - 1) * 100).toFixed(1)}% over range</span></div>`;
}

/* ---------- Agent Thesis tab ---------- */
function renderThesisTab() {
  const sym = state.activeSymbol;
  const d = state.packetCache[sym];
  if (!d) { ensureStock(sym).then(renderHead); }
  else renderHead(d);
  const t = state.thesisCache[sym];
  if (state.thesisLoading[sym]) { $('#rsBody').innerHTML = `<div class="loading"><span class="spinner"></span> The agent is reading the financials and researching the web… this takes a few seconds.</div>`; return; }
  if (t) { $('#rsBody').innerHTML = thesisView(t); return; }
  $('#rsBody').innerHTML = `<div class="thintro"><div class="tx">The agent reads this company’s fetched financials as ground truth, researches the gaps (industry, news, concall, forward view) live from the web, and returns a structured 10–15-year thesis.</div>
    <button class="btn btn-primary" onclick="generateThesis()">${I.spark} Generate thesis</button></div>
    <div class="empty big"><h3>No thesis yet</h3><p>Hit Generate to run the agent for ${esc(sym)}. The result is cached for this session.</p></div>`;
}
async function generateThesis(force) {
  const sym = state.activeSymbol;
  state.thesisLoading[sym] = true; renderThesisTab();
  try {
    const r = await fetch(`${API}/api/thesis/${encodeURIComponent(sym)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: !!force }) });
    const data = await r.json();
    state.thesisLoading[sym] = false;
    if (data.needsKey) { $('#rsBody').innerHTML = keyNote(data.error); return; }
    if (data.error || !data.thesis) { $('#rsBody').innerHTML = `${apiError('Thesis failed', data.error || 'no result')}<div style="margin-top:14px"><button class="btn btn-primary" onclick="generateThesis(true)">${I.refresh} Try again</button></div>`; return; }
    state.thesisCache[sym] = data.thesis; persist();
    if (state.activeSymbol === sym && state.activeTab === 'thesis') $('#rsBody').innerHTML = thesisView(data.thesis);
    renderAllocation();
  } catch (e) { state.thesisLoading[sym] = false; $('#rsBody').innerHTML = apiError('Thesis failed', e.message); }
}
function keyNote(msg) {
  return `<div class="keynote">${I.spark}<h3>Add your Gemini key to enable the agent</h3>
    <p>Everything else works. To turn on the thesis, set one secret and redeploy:</p>
    <p><code>npx wrangler secret put GEMINI_API_KEY</code></p>
    <p style="font-size:12px">${esc(msg || '')}</p></div>`;
}
function thesisView(t) {
  const verdict = String(t.verdict || 'WATCH').toUpperCase();
  const vcls = verdict === 'BUY' ? 'buy' : verdict === 'REJECT' ? 'reject' : 'watch';
  const sc = t.scores || {};
  const conf = Math.max(0, Math.min(100, +t.confidence || 0));
  const scoreRows = [
    ['Growth runway', sc.growth_runway, 5], ['Moat', sc.moat, 5], ['Financial quality', sc.financial_quality, 5],
    ['Management / governance', sc.management_governance, 5], ['Valuation', sc.valuation, 5], ['Industry', sc.industry_attractiveness, 5],
    ['Risk penalty', sc.risk_penalty, 5, true],
  ].map(([k, v, max, pen]) => `<div class="scorebar"><div class="sk">${k}</div><div class="st"><div class="sf ${pen ? 'pen' : ''}" style="width:${Math.max(0, Math.min(1, (v || 0) / max)) * 100}%"></div></div><div class="sv">${pen ? '−' : ''}${v ?? '-'}</div></div>`).join('');
  const list = (arr) => `<ul class="bblist">${(arr || []).map((x) => `<li>${mdBold(x)}</li>`).join('') || '<li>Not available.</li>'}</ul>`;
  const ass = (lab, body) => body ? `<div class="asscard"><div class="at">${lab}</div><div class="ab">${mdBold(body)}</div></div>` : '';
  const rc = (arr) => `<div class="rclist">${(arr || []).map((x) => `<div class="rcitem">${mdBold(x)}</div>`).join('') || '<div class="rcitem">Not available.</div>'}</div>`;
  const sources = (t._sources || []).length ? `<div class="sources"><h4>Researched from the web</h4><div class="srcchips">${t._sources.map((s) => `<a class="srcchip" href="${esc(s.uri)}" target="_blank" rel="noopener">${esc((s.title || s.uri).slice(0, 60))}</a>`).join('')}</div></div>` : '';
  return `
  <div class="verdictbar">
    <div class="verdict ${vcls}">${esc(verdict)}</div>
    <div class="vmeta"><div class="total">Score <b>${sc.total ?? '-'}</b> / 30</div><div class="conf">Confidence ${conf}/100</div></div>
    <div class="confbar"><div class="lab">Confidence</div><div class="track"><div class="fill" style="width:${conf}%"></div></div></div>
    <button class="btn btn-ghost btn-sm" onclick="generateThesis(true)">${I.refresh} Regenerate</button>
  </div>
  <div class="scoregrid">${scoreRows}</div>
  <div class="th-exec">${mdBold(t.executive_thesis || '')}</div>
  <div class="bbgrid">
    <div class="bbcard bull"><h4>${I.spark} Bull case</h4>${list(t.bull_case)}</div>
    <div class="bbcard bear"><h4>Bear case</h4>${list(t.bear_case)}</div>
  </div>
  <div class="assess">
    ${ass('Moat', t.moat_assessment)}${ass('Financial quality', t.financial_quality)}
    ${ass('Valuation', t.valuation_assessment)}${ass('Industry', t.industry_assessment)}
    ${ass('Management & governance', t.management_assessment)}
  </div>
  <div class="bbgrid">
    <div class="bbcard"><h4>Key risks</h4>${rc(t.key_risks)}</div>
    <div class="bbcard"><h4>Key catalysts</h4>${rc(t.key_catalysts)}</div>
  </div>
  <div class="asscard" style="margin-top:14px"><div class="at">What would change my mind</div>${list(t.what_would_change_my_mind)}</div>
  ${sources}`;
}

/* ============================ STEP 3 · ALLOCATION ============================ */
// Sizes this month's buy plan across the flagged names using the cached agent
// theses (server-side: POST /api/allocation). Runs on a button, like the thesis,
// so it never burns free-tier quota automatically.
function renderAllocation() {
  const mount = $('#allocMount');
  if (!state.allocation.length) {
    mount.innerHTML = `<div class="empty big"><h3>No stocks flagged for allocation</h3><p>In <b>Research</b>, hit the ☆ next to a name to add it here.</p></div>`;
    return;
  }
  const cap = state.monthlyCapital;
  const res = state.allocationResult;
  const btnLabel = (res && res.plan) ? 'Regenerate plan' : 'Generate allocation';
  const control = `<div class="alloc-bar" style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin-bottom:18px">
    <div style="display:flex;flex-direction:column;gap:5px">
      <label style="font-size:12px;color:var(--muted)">Monthly capital (optional)</label>
      <div style="display:flex;align-items:center;gap:6px;background:var(--surface);box-shadow:var(--nm-in-sm);border-radius:var(--r);padding:9px 12px">
        <span style="color:var(--muted)">₹</span>
        <input id="allocCapital" type="text" inputmode="numeric" placeholder="e.g. 50000" value="${cap ? esc(String(cap)) : ''}" style="border:0;background:transparent;outline:none;font:inherit;width:120px;color:inherit" onkeydown="if(event.key==='Enter')generateAllocation()">
      </div>
    </div>
    <button class="btn btn-primary" onclick="generateAllocation()">${I.spark} ${btnLabel}</button>
  </div>`;
  let body;
  if (state.allocLoading) body = `<div class="loading"><span class="spinner"></span> Sizing your allocation plan. Any flagged name without a thesis is researched first, so this can take a moment.</div>`;
  else if (res && res.keyError) body = keyNote(res.keyError);
  else if (res && res.error) body = `${apiError('Allocation failed', res.error)}${missingNote(res.missing)}`;
  else if (res && res.plan) body = allocationView(res.plan, res.monthly_capital, res.missing);
  else body = flaggedPreview();
  mount.innerHTML = control + body;
}

// Pre-generation view: the flagged names as cards, plus a hint to size them.
function flaggedPreview() {
  const hint = `<div style="font-size:13px;color:var(--muted);margin-bottom:12px">${state.allocation.length} name${state.allocation.length === 1 ? '' : 's'} flagged. Set your monthly amount and hit <b>Generate allocation</b> for a conviction-weighted plan. Any name without a thesis yet is researched automatically.</div>`;
  const grid = `<div class="alloc-grid">${state.allocation.map((sym) => {
    const meta = state.researchList.find((x) => x.symbol === sym) || { symbol: sym, company: sym };
    const pk = state.packetCache[sym]?.packet, t = state.thesisCache[sym];
    const v = t ? String(t.verdict || '').toUpperCase() : '';
    const vc = v === 'BUY' ? 'var(--pos-soft);color:var(--pos)' : v === 'REJECT' ? 'var(--neg-soft);color:var(--neg)' : v === 'WATCH' ? 'var(--warn-soft);color:var(--warn)' : '';
    const q = pk?.quality, val = pk?.valuation;
    return `<div class="alloc-card">
      ${v ? `<span class="verdict-chip" style="background:${vc}">${v}</span>` : ''}
      <div class="nm">${esc(meta.company)}</div><div class="sub">${esc(sym)}${meta.sector ? ' · ' + esc(meta.sector) : ''}</div>
      <div class="mini">
        <div>ROCE<b>${num(q?.roce_pct, '%')}</b></div><div>P/E<b>${num(val?.pe)}</b></div>
        <div>D/E<b>${num(q?.debt_to_equity)}</b></div><div>M-cap<b>${pk ? abbr(pk.profile.market_cap_cr) : '-'}</b></div>
      </div>
      <span class="rm" onclick="toggleAlloc('${esc(sym)}')">remove</span>
    </div>`;
  }).join('')}</div>`;
  return hint + grid;
}

async function generateAllocation() {
  if (!state.allocation.length) return;
  const capEl = $('#allocCapital');
  const cap = capEl ? Number(String(capEl.value).replace(/[,\s₹]/g, '')) : NaN;
  state.monthlyCapital = (Number.isFinite(cap) && cap > 0) ? cap : null;
  state.allocLoading = true; renderAllocation();
  try {
    const body = { symbols: state.allocation };
    if (state.monthlyCapital) body.monthly_capital = state.monthlyCapital;
    const r = await fetch(`${API}/api/allocation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    state.allocLoading = false;
    if (data.needsKey) state.allocationResult = { keyError: data.error };
    else if (!data.allocation) state.allocationResult = { error: data.error || 'no result', missing: data.missing || [] };
    else state.allocationResult = { plan: data.allocation, missing: data.missing || [], monthly_capital: data.monthly_capital };
  } catch (e) {
    state.allocLoading = false;
    state.allocationResult = { error: e.message };
  }
  renderAllocation();
}

function missingNote(missing) {
  if (!missing || !missing.length) return '';
  return `<div style="background:var(--warn-soft);border-radius:var(--r);padding:12px 14px;margin-top:14px;font-size:13px;color:var(--warn)">
    <b>Couldn't size:</b> ${missing.map(esc).join(', ')}. Their data couldn't be fetched, open them in <b>Research</b> and hit Refresh, then regenerate.</div>`;
}

function allocationView(plan, cap, missing) {
  const ps = plan.portfolio_summary || {};
  const rows = (plan.allocations || []).slice();
  const nameOf = (tk) => (state.researchList.find((x) => x.symbol === tk) || {}).company || tk;
  const rupee = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const funded = rows.filter((a) => a.target_weight_pct > 0).sort((a, b) => b.target_weight_pct - a.target_weight_pct);
  const avoided = rows.filter((a) => !(a.target_weight_pct > 0));
  const tierColor = { A: 'var(--pos)', B: 'var(--accent-deep)', C: 'var(--warn)' };
  const actBg = (x) => (x === 'BUY' || x === 'ADD') ? 'var(--pos-soft);color:var(--pos)' : (x === 'TRIM') ? 'var(--neg-soft);color:var(--neg)' : (x === 'HOLD') ? 'var(--warn-soft);color:var(--warn)' : 'var(--neg-soft);color:var(--neg)';

  const card = (a, dim) => {
    const w = a.target_weight_pct;
    const amtVal = (a.target_amount != null) ? a.target_amount : (cap ? Math.round(w / 100 * cap) : null);
    const amt = (amtVal != null) ? `<span style="color:var(--muted);font-weight:600;font-size:13px;margin-left:9px">${rupee(amtVal)}</span>` : '';
    return `<div style="background:var(--surface);box-shadow:var(--nm-out-sm);border-radius:var(--r);padding:14px 16px;margin-bottom:10px;${dim ? 'opacity:.6' : ''}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="font-family:var(--font-display);font-size:15px">${esc(nameOf(a.ticker))}</b>
        <span style="color:var(--muted);font-size:12.5px">${esc(a.ticker)}</span>
        <span style="margin-left:auto;display:inline-flex;gap:6px;align-items:center">
          <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;box-shadow:var(--nm-in-sm);color:${tierColor[a.tier] || 'var(--muted)'}">Tier ${esc(a.tier)}</span>
          <span style="font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;background:${actBg(a.action)}">${esc(a.action)}</span>
        </span>
      </div>
      ${w > 0 ? `<div style="display:flex;align-items:center;gap:10px;margin:9px 0 7px">
        <div style="font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--accent-deep);min-width:62px">${w}%</div>${amt}
        <div style="flex:1;height:7px;border-radius:999px;box-shadow:var(--nm-in-sm);overflow:hidden"><div style="height:100%;width:${Math.min(100, w)}%;background:var(--accent-deep)"></div></div>
      </div>` : ''}
      <div style="font-size:13px;line-height:1.5">${(a.justification || []).map((j) => mdBold(j)).join('<br>')}</div>
    </div>`;
  };

  const sumW = Math.round(funded.reduce((t, a) => t + a.target_weight_pct, 0));
  const head = `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;margin:2px 0 14px">
    <div style="font-family:var(--font-display);font-size:18px;font-weight:800">Allocation plan</div>
    <div style="color:var(--muted);font-size:13px">${funded.length} position${funded.length === 1 ? '' : 's'} · ${sumW}% of capital${cap ? ` · ${rupee(cap)} deployed` : ', add a monthly amount above for rupee splits'}</div>
  </div>`;
  const sumRow = (lab, val) => val ? `<div style="display:flex;gap:10px"><b style="flex:0 0 104px;color:var(--muted);font-weight:600">${lab}</b><span>${mdBold(val)}</span></div>` : '';
  const summary = (ps.overall_style || ps.risk_posture || ps.concentration_notes) ? `<div style="background:var(--surface);box-shadow:var(--nm-in-sm);border-radius:var(--r);padding:14px 16px;margin-bottom:16px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--accent-deep);margin-bottom:10px">Approach</div>
    <div style="display:grid;gap:9px;font-size:13.5px;line-height:1.55">
      ${sumRow('Style', ps.overall_style)}${sumRow('Risk', ps.risk_posture)}${sumRow('Concentration', ps.concentration_notes)}
    </div>
  </div>` : '';
  const avoidBlock = avoided.length ? `<div style="margin-top:6px"><div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:12px 0 9px">Skipped this month</div>${avoided.map((a) => card(a, true)).join('')}</div>` : '';
  return head + summary + missingNote(missing) + funded.map((a) => card(a, false)).join('') + avoidBlock;
}

/* ============================ CHROME ============================ */
function applyTheme() { document.documentElement.setAttribute('data-theme', state.theme === 'dark' ? 'dark' : ''); $('#themeBtn').innerHTML = state.theme === 'dark' ? I.moon : I.sun; const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', state.theme === 'dark' ? '#23272E' : '#E0E5EC'); }
function toggleTheme() { state.theme = state.theme === 'dark' ? 'light' : 'dark'; persist(); applyTheme(); if (state.step === 2 && state.activeTab === 'data') renderStockData(); }

/* ============================ LIVE QUOTE POLLING ============================ */
// Screener lists stay cached (they barely move); once you're researching a single
// name we poll its live quote every 5s and update the price + every price-derived
// number in place, without re-rendering the view.
function startLive(sym) {
  stopLive();
  if (!sym) return;
  pollQuote(sym);                                   // fire immediately, then every 5s
  state.liveTimer = setInterval(() => pollQuote(sym), 5000);
}
function stopLive() { if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; } }
async function pollQuote(sym) {
  if (state.step !== 2 || state.activeSymbol !== sym) { stopLive(); return; }
  if (document.hidden) return;                       // don't poll a backgrounded tab
  try {
    const r = await fetch(`${API}/api/quote/${encodeURIComponent(sym)}`);
    if (!r.ok) return;
    const q = await r.json();
    if (state.activeSymbol === sym && !q.error) updateLive(q);
  } catch {}
}
function updateLive(q) {
  if (!q || q.price == null) return;
  const sym = state.activeSymbol;
  let base = state.basePrice[sym];
  if (base == null || !isFinite(base)) { base = q.price; state.basePrice[sym] = base; }
  const ratio = base ? q.price / base : 1;
  const pe = $('#livePrice'); if (pe) pe.textContent = inr(q.price);
  const ce = $('#liveChg');
  if (ce) {
    const chg = q.changePct != null ? q.changePct : (q.prevClose ? (q.price / q.prevClose - 1) * 100 : null);
    ce.textContent = chg == null ? '-' : ((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%');
    ce.className = 'sd-chg ' + (chg == null ? '' : (chg >= 0 ? 'up' : 'down'));
  }
  const ago = $('#liveAgo'); if (ago) ago.textContent = 'live';
  document.querySelectorAll('[data-live]').forEach((el) => {
    const key = el.getAttribute('data-live'), fmt = el.getAttribute('data-fmt') || 'num';
    let val = null;
    if (key === 'mul') { const b = +el.getAttribute('data-base'); if (isFinite(b)) val = b * ratio; }
    else if (key === 'div') { const b = +el.getAttribute('data-base'); if (isFinite(b) && ratio) val = b / ratio; }
    else if (key === 'q_high') val = q.high_52w;
    else if (key === 'q_low') val = q.low_52w;
    else if (key === 'q_vol') val = q.volume;
    if (val == null || !isFinite(val)) return;
    const next = fmtVal(val, fmt);
    if (el.textContent !== next) { el.textContent = next; el.classList.add('liveflash'); setTimeout(() => el.classList.remove('liveflash'), 400); }
  });
  state.liveAt = Date.now();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.step === 2 && state.activeSymbol) pollQuote(state.activeSymbol); });
function showOverlay() { $('#overlay').classList.add('show'); }
function closeOverlay() { $('#overlay').classList.remove('show'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });
$('#overlay').addEventListener('click', (e) => { if (e.target === $('#overlay')) closeOverlay(); });

let toastT;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.innerHTML = `<span style="color:var(--pos)">${I.check}</span> ${esc(msg)}`;
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)'; });
  clearTimeout(toastT); toastT = setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(-50%) translateY(20px)'; }, 1900);
}

const INFO = {
  about: { title: 'About Meridian', body: `
    <p><b>My monthly investing process, automated.</b> Meridian is the offline routine I used to run by hand, turned into one quiet tool: screen the market, research the survivors, decide. Built by Ansh Dwivedi; personal and non-commercial.</p>
    <p>It's built for one kind of investing, buy quality businesses and hold them for years, without checking in unless something material changes. Done with discipline, that compounds in a way an index fund, a mutual fund, or any generic basket can't.</p>
    <h4>The proof, my Groww portfolio</h4>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0 10px">
      <div style="background:var(--surface);box-shadow:var(--nm-out-sm);border-radius:var(--r);padding:15px">
        <div style="font-size:12px;color:var(--muted)">My portfolio · XIRR</div>
        <div style="font-size:27px;font-weight:800;color:var(--pos);font-family:var(--font-display)">+19.32%</div>
      </div>
      <div style="background:var(--surface);box-shadow:var(--nm-out-sm);border-radius:var(--r);padding:15px">
        <div style="font-size:12px;color:var(--muted)">NIFTY 50 · XIRR</div>
        <div style="font-size:27px;font-weight:800;color:var(--neg);font-family:var(--font-display)">−0.95%</div>
      </div>
    </div>
    <div style="text-align:center;margin:2px 0 12px;padding:12px;border-radius:var(--r);box-shadow:var(--nm-in-sm);font-size:13.5px">Outperformed NIFTY 50 by <b style="color:var(--accent-deep)">+20.27%</b></div>
    <h4>How it works</h4>
    <p>Quantitative data from Screener.in; live price &amp; returns from Yahoo Finance; the long-term thesis is written by an AI agent (Google Gemini) that treats the fetched data as ground truth and researches the gaps from the live web. Nothing is fabricated, anything unreachable is shown as “-”.</p>
    <p class="muted">Past performance is historical and specific to one portfolio, not a promise of future returns. See Terms &amp; Disclaimer.</p>` },
  howto: { title: 'How to use Meridian', body: `
    <h4>1 · Shortlist</h4><p>Pick screens, set a depth, take the intersection. Hit <b>Research</b> on the survivors you want to study.</p>
    <h4>2 · Research</h4><p>Pick a stock on the left. <b>Stock Data</b> shows six buckets of fundamentals with live prices; <b>Agent Thesis</b> generates a structured 10–15-year verdict on demand. Tap the ☆ to flag a name for allocation.</p>
    <h4>3 · Allocation</h4><p>Your flagged names gather here. Enter your monthly amount (optional) and hit <b>Generate allocation</b>, the agent sizes a tiered buy plan from the theses, capped so no single name or sector dominates.</p>
    <p class="muted">Everything resets when you close the tab, Meridian is a once-a-month, use-and-close tool.</p>` },
  terms: { title: 'Terms & Disclaimer', body: `
    <p><b>Meridian is a personal research tool, not financial advice.</b> It is built by Ansh Dwivedi for his own use and shared with friends &amp; family. Nothing here is a recommendation to buy, sell, or hold any security.</p>
    <p>Ansh is not a SEBI-registered investment adviser or research analyst. Data is fetched from third parties (Screener.in, Yahoo Finance) and may be delayed, incomplete, or incorrect. The AI thesis is machine-generated decision support and can be wrong.</p>
    <p>Investing in equities carries risk, including loss of capital. Any performance figures shown (including past XIRR) are historical, specific to one portfolio, and not a promise of future returns. Do your own research and consult a registered adviser before investing.</p>
    <p class="muted">By using Meridian you accept that you are solely responsible for your own investment decisions.</p>` },
};
function openInfo(k) {
  const o = INFO[k];
  $('#modal').className = 'modal wide';
  $('#modal').innerHTML = `<button class="close-x" onclick="closeOverlay()">✕</button>
    <div class="mh"><div class="ic">${I.compass}</div><h3>${o.title}</h3></div>
    <div class="modalbody-scroll">${o.body}</div>
    <div class="mf"><button class="btn btn-primary btn-sm" onclick="closeOverlay()">Got it</button></div>`;
  showOverlay();
}

/* ============================ INIT ============================ */
function init() {
  restore();
  applyTheme();
  // Installed PWA (standalone) gets the mobile-tuned layout via body.pwa; the website is untouched.
  if ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone) document.body.classList.add('pwa');
  $('#footnote').innerHTML = '<button class="footlink" onclick="openInfo(\'terms\')">Terms &amp; Disclaimer</button>';
  renderBadges();
  goStep(state.step == null ? 0 : state.step);
}
init();
