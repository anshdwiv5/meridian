/* Meridian — frontend (classic script; inline handlers call these globals).
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

const I = {
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z"/></svg>',
  starF:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z"/></svg>',
  refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>',
  back:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/></svg>',
  moon:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>',
  doc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>',
  spark:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6z"/></svg>',
  compass:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z" fill="currentColor" stroke="none"/></svg>',
  ext:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5h5v5M19 5l-9 9M11 5H5v14h14v-6"/></svg>',
  upload:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
};

const $ = (s) => document.querySelector(s);
const SKEY = 'meridian.session.v3';

const state = {
  step: 1, theme: 'light',
  // step 1
  screens: null, screensLoading: false, openScreen: null,
  selected: new Set(), interN: null, inter: null, rowIndex: {}, refresh: false,
  // step 2
  researchList: [], allocation: [], activeSymbol: null, activeTab: 'data',
  packetCache: {}, thesisCache: {}, thesisLoading: {}, chartRange: '1y',
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
    state.step = s.step || 1;
    state.theme = s.theme || 'light';
  } catch {}
}

/* ---------- formatting ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, suf = '') => (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) ? '—' : (v + suf);
const n2 = (v) => v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toLocaleString('en-IN');
function cr(v) { if (v == null || !isFinite(v)) return '—'; return v >= 100000 ? '₹' + (v / 100000).toFixed(2) + 'L cr' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' cr'; }
function inr(v) { return v == null || !isFinite(v) ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function abbr(v) { if (v == null || !isFinite(v)) return ''; const a = Math.abs(v); if (a >= 100000) return (v / 100000).toFixed(1) + 'L'; if (a >= 1000) return (v / 1000).toFixed(1) + 'k'; return Math.round(v).toString(); }
function ago(ms) { if (!ms) return 'never'; const s = (Date.now() - ms) / 1000; if (s < 90) return 'just now'; const m = s / 60; if (m < 90) return Math.round(m) + 'm ago'; const h = m / 60; if (h < 36) return Math.round(h) + 'h ago'; return Math.round(h / 24) + 'd ago'; }

/* ============================ NAVIGATION ============================ */
function goStep(n) {
  state.step = n; persist();
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('show'));
  $('#view-' + n).classList.add('show');
  document.querySelectorAll('.step').forEach((b) => b.classList.toggle('on', +b.dataset.step === n));
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (n === 1) ensureScreens();
  if (n === 2) enterResearch();
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
  let price = '';
  if (live && live.price != null) {
    const chg = live.prevClose != null ? (live.price / live.prevClose - 1) * 100 : null;
    price = `<div class="sd-pricewrap"><div class="sd-price">${inr(live.price)}</div><div class="sd-chg ${chg == null ? '' : (chg >= 0 ? 'up' : 'down')}">${chg == null ? 'live' : ((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%')}</div></div>`;
  } else if (st.price) price = `<div class="sd-pricewrap"><div class="sd-price">${inr(st.price)}</div><div class="sd-chg">last close</div></div>`;
  $('#rsHead').innerHTML = `<div class="sd-name">${esc(st.company)}</div>
    <div class="sd-sub">${esc(st.symbol)}${st.sector ? ' · ' + esc(st.sector) : ''}${st.mcap ? ' · ' + cr(st.mcap) : ''}</div>${price}`;
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
function kpi(k, v, x, cls) { return `<div class="card kpi"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div>${x ? `<div class="x">${x}</div>` : ''}</div>`; }

function bucketProfile(p) {
  const a = p.profile;
  const owners = [['Promoter', a.promoter_pct], ['FII', a.fii_pct], ['DII', a.dii_pct], ['Public', a.public_pct]];
  const ownerRows = owners.map(([k, v]) => `<dt>${k}</dt><dd>${num(v, '%')}</dd>`).join('') + (a.pledge_pct != null ? `<dt>Promoter pledge</dt><dd class="${a.pledge_pct > 0 ? 'down' : ''}">${num(a.pledge_pct, '%')}</dd>` : '');
  const ownerBar = ownerStack(owners);
  return `<div class="bucket">${bH('A', 'Company profile')}
    <div class="twocol">
      <div class="panel"><h4>Business</h4>
        <dl class="kv">
          <dt>Ticker</dt><dd>${esc(a.symbol)} · ${esc(a.exchange || '—')}</dd>
          <dt>Sector</dt><dd>${esc(a.sector || '—')}</dd>
          <dt>Market cap</dt><dd>${cr(a.market_cap_cr)}</dd>
          <dt>Shares out.</dt><dd>${a.shares_outstanding_cr != null ? n2(a.shares_outstanding_cr) + ' cr' : '—'}</dd>
          <dt>Book value</dt><dd>${inr(a.book_value)}</dd>
          <dt>Face value</dt><dd>${inr(a.face_value)}</dd>
        </dl>
        ${a.about ? `<p class="about" style="margin-top:12px">${esc(a.about)}</p>` : ''}
      </div>
      <div class="panel"><h4>Ownership</h4>
        ${ownerBar}
        <dl class="kv" style="margin-top:14px">${ownerRows}</dl>
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
  if (c.revenue?.length) charts.push(chartCard('Revenue (₹ cr)', barsSVG(c.revenue, { color: 'var(--accent)' })));
  if (c.pat?.length) charts.push(chartCard('Net profit (₹ cr)', barsSVG(c.pat, { color: '#3b82f6', allowNeg: true })));
  const marg = [];
  if (c.opm?.length) marg.push({ name: 'OPM %', color: 'var(--accent)', points: c.opm });
  if (c.net_margin?.length) marg.push({ name: 'Net margin %', color: '#8b5cf6', points: c.net_margin });
  if (marg.length) charts.push(chartCard('Margins', linesSVG(alignSeries(marg), { pct: true }), marg.map((m) => `<i><span class="sw" style="background:${m.color}"></span>${m.name}</i>`).join('')));
  const cfs = [];
  if (c.ocf?.length) cfs.push({ name: 'Operating CF', color: 'var(--accent)', points: c.ocf });
  if (c.fcf?.length) cfs.push({ name: 'Free CF', color: '#0aa66e', points: c.fcf });
  if (cfs.length) charts.push(chartCard('Cash flow (₹ cr)', groupedBarsSVG(alignSeries(cfs), { allowNeg: true }), cfs.map((m) => `<i><span class="sw" style="background:${m.color}"></span>${m.name}</i>`).join('')));
  const dc = [];
  if (c.debt?.length) dc.push({ name: 'Debt', color: 'var(--neg)', points: c.debt });
  if (c.cash?.length) dc.push({ name: 'Cash', color: 'var(--pos)', points: c.cash });
  if (dc.length) charts.push(chartCard('Debt vs cash (₹ cr)', groupedBarsSVG(alignSeries(dc), {}), dc.map((m) => `<i><span class="sw" style="background:${m.color}"></span>${m.name}</i>`).join('')));

  const tables = ['pnl', 'balance_sheet', 'cash_flow'].map((k) => finTable(k === 'pnl' ? 'Profit & Loss' : k === 'balance_sheet' ? 'Balance Sheet' : 'Cash Flow', p.financials.annual[k]))
    .concat([finTable('Quarterly Results', p.financials.quarterly)]).filter(Boolean).join('');
  const chartsHtml = charts.length ? `<div class="chgrid2">${charts.join('')}</div>` : `<div class="gapnote">Financial statement tables weren’t captured from Screener for this name — try Refresh on the stock, or check the Screener link.</div>`;
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
  const cards = [
    kpi('ROCE', num(q.roce_pct, '%'), 'return on capital'),
    kpi('ROE', num(q.roe_pct, '%'), 'return on equity'),
    kpi('ROA', num(q.roa_pct, '%'), 'return on assets'),
    kpi('Asset turnover', num(q.asset_turnover, '×'), 'sales / assets'),
    kpi('Interest cover', num(q.interest_coverage, '×'), 'EBIT / interest'),
    kpi('Debt / Equity', num(q.debt_to_equity), q.debt_to_equity == null ? '' : (q.debt_to_equity < 0.3 ? 'low' : q.debt_to_equity < 1 ? 'moderate' : 'high')),
    kpi('Debt / EBITDA', num(q.debt_to_ebitda, '×'), 'leverage'),
    kpi('FCF yield', num(q.fcf_yield_pct, '%'), 'FCF / mcap'),
    kpi('CFO / PAT', num(q.cfo_to_pat, '×'), 'earnings quality'),
    kpi('Revenue CAGR', num(q.revenue_cagr_pct, '%'), 'long-run'),
    kpi('PAT CAGR', num(q.pat_cagr_pct, '%'), 'long-run'),
    kpi('Cash cycle', num(q.cash_conversion_cycle), 'days'),
  ].join('');
  const wc = [['Debtor', q.debtor_days], ['Inventory', q.inventory_days], ['Payable', q.payable_days], ['CCC', q.cash_conversion_cycle]].filter(([, v]) => v != null);
  const wcChart = q.roce_trend?.length ? chartCard('ROCE trend (%)', linesSVG(alignSeries([{ name: 'ROCE', color: 'var(--accent)', points: q.roce_trend }]), { pct: true })) : '';
  const wcCards = wc.length ? `<div class="chartcard"><h4>Working-capital cycle (days)</h4>${barsSVG(wc.map(([p2, v]) => ({ p: p2, v })), { color: 'var(--accent)', labelEach: true })}</div>` : '';
  const second = (wcChart || wcCards) ? `<div class="chgrid2" style="margin-top:14px">${wcChart}${wcCards}</div>` : '';
  return `<div class="bucket">${bH('C', 'Efficiency & quality')}<div class="cardgrid c4">${cards}</div>${second}</div>`;
}

function bucketValuation(p, sym) {
  const v = p.valuation;
  const cards = [
    kpi('P/E', num(v.pe), 'price / earnings'),
    kpi('P/B', num(v.pb), 'price / book'),
    kpi('EV/EBITDA', num(v.ev_ebitda, '×'), ''),
    kpi('EV/Sales', num(v.ev_sales, '×'), ''),
    kpi('P/FCF', num(v.p_fcf, '×'), ''),
    kpi('Div yield', num(v.dividend_yield_pct, '%'), 'trailing'),
    kpi('52w high', inr(v.high_52w), ''),
    kpi('52w low', inr(v.low_52w), ''),
  ].join('');
  const ret = v.returns || {};
  const order = [['1m', '1m'], ['3m', '3m'], ['6m', '6m'], ['1y', '1y'], ['3y', '3y'], ['5y', '5y']];
  const heat = order.filter(([k]) => ret[k] != null).map(([k, lab]) => { const val = ret[k]; const cls = val >= 0 ? 'pos' : 'neg'; return `<div class="ret ${cls}"><div class="rk">${lab}</div><div class="rv">${(val >= 0 ? '+' : '') + val}%</div></div>`; }).join('');
  const heatHtml = heat ? `<div class="panel" style="margin-top:14px"><h4>Price returns</h4><div class="returns">${heat}</div></div>` : '';
  const price = `<div class="pricebox" style="margin-top:14px">
      <div class="pricebar"><div style="font-weight:700;font-size:13px" id="chTitle">${esc(sym)} · Price</div>
        <div class="rangebtns">${['6mo', '1y', '5y'].map((r) => `<button class="${state.chartRange === r ? 'on' : ''}" onclick="setChartRange('${r}')">${r.toUpperCase()}</button>`).join('')}</div></div>
      <div id="nativeChart"><div class="loading"><span class="spinner"></span> Loading price history…</div></div></div>`;
  const peers = peersTable(v.peers, sym);
  return `<div class="bucket">${bH('D', 'Valuation & market')}<div class="cardgrid c4">${cards}</div>${heatHtml}${price}${peers ? `<div class="panel" style="margin-top:14px"><h4>Peer comparison (Screener)</h4>${peers}</div>` : ''}</div>`;
}
function peersTable(peers, sym) {
  if (!peers || !peers.rows?.length) return '';
  const h = peers.headers || [];
  return `<div class="dwrap"><table class="peers"><thead><tr>${h.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${peers.rows.map((r) => { const me = r.symbol === sym; return `<tr class="${me ? 'me' : ''}">${r.cells.map((c, i) => `<td>${i === 1 ? `<b>${esc(c)}</b>` : esc(c)}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>`;
}

function bucketIndustry(p) {
  const peers = peersTable(p.industry.peers, p.profile.symbol);
  return `<div class="bucket">${bH('E', 'Industry & competition')}
    <div class="panel"><dl class="kv"><dt>Sector</dt><dd>${esc(p.industry.sector || '—')}</dd></dl>
      ${peers ? `<div style="margin-top:12px">${peers}</div>` : ''}
      <div class="gapnote"><b>Industry size, growth, market share &amp; regulation</b> aren’t in free structured sources — the <b>Agent Thesis</b> researches these live from the web and cites its sources.</div>
    </div></div>`;
}

function bucketGovernance(p) {
  const g = p.governance;
  const sh = g.shareholding_trend;
  const trend = sh && sh.columns?.length ? finTableOpen('Shareholding trend (%)', sh) : '';
  const flags = (g.pros?.length || g.cons?.length) ? `<div class="twocol" style="margin-top:14px">
      <div class="panel"><h4>What’s working (Screener)</h4><div class="flags">${(g.pros || []).map((x) => `<div class="flag ok"><div class="ic">✓</div><div>${esc(x)}</div></div>`).join('') || '<p class="about">—</p>'}</div></div>
      <div class="panel"><h4>Watch-outs (Screener)</h4><div class="flags">${(g.cons || []).map((x) => `<div class="flag watch"><div class="ic">!</div><div>${esc(x)}</div></div>`).join('') || '<p class="about">—</p>'}</div></div>
    </div>` : '';
  const docs = g.documents;
  const docLinks = docs ? [...(docs.concalls || []), ...(docs.annual_reports || [])].slice(0, 8) : [];
  const docHtml = docLinks.length ? `<div class="panel" style="margin-top:14px"><h4>Filings &amp; concalls</h4><div class="docs">${docLinks.map((l) => `<a class="doclink" href="${esc(l.href)}" target="_blank" rel="noopener">${I.doc}<span>${esc(l.text)}</span>${I.ext}</a>`).join('')}</div></div>` : '';
  return `<div class="bucket">${bH('F', 'Management, governance & events')}
    ${trend}${flags}${docHtml}
    <div class="gapnote"><b>Board/auditor changes, related-party flags, litigation &amp; recent news</b> aren’t fetched here — the <b>Agent Thesis</b> researches material events live and flags governance risks.</div>
  </div>`;
}
function finTableOpen(title, t) {
  if (!t || !Object.keys(t.rows || {}).length) return '';
  const head = `<tr><th>${esc(title)}</th>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const body = Object.entries(t.rows).map(([label, vals]) => `<tr><td>${esc(label)}</td>${vals.map((v) => `<td>${v == null ? '' : n2(v)}</td>`).join('')}</tr>`).join('');
  return `<div class="dwrap"><table class="dtable"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- charts (SVG, themeable via currentColor / CSS vars) ---------- */
function chartCard(title, svg, legend) { return `<div class="chartcard"><h4>${esc(title)}${legend ? `<span class="leg">${legend}</span>` : ''}</h4>${svg}</div>`; }
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
  const bars = series.map((s, i) => {
    const cx = pad + (i + 0.5) * (W - pad - 8) / series.length;
    const yy = y(s.v), top = Math.min(yy, zeroY), h = Math.abs(yy - zeroY);
    const col = (opts.allowNeg && s.v < 0) ? 'var(--neg)' : (opts.color || 'var(--accent)');
    const lbl = opts.labelEach ? `<text class="val" x="${cx}" y="${top - 4}" text-anchor="middle">${abbr(s.v)}</text>` : (i === series.length - 1 ? `<text class="val" x="${cx}" y="${top - 4}" text-anchor="middle">${abbr(s.v)}</text>` : '');
    return `<rect class="bar" x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="${col}"/>${lbl}`;
  }).join('');
  const xl = xLabels(series.map((s) => s.p), W, pad, 6).map((t) => t.replace('y="0"', `y="${H - 6}"`)).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none"><line class="grid" x1="${pad}" y1="${zeroY}" x2="${W - 8}" y2="${zeroY}"/>${bars}${xl}</svg>`;
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
  labels.forEach((lab, i) => {
    const gx = pad + i * groupW + groupW * 0.18;
    rows.forEach((r, j) => {
      const v = r.vals[i]; if (v == null) return;
      const x = gx + j * (bw + 2), yy = y(v), top = Math.min(yy, zeroY), h = Math.abs(yy - zeroY);
      const col = (opts.allowNeg && v < 0) ? 'var(--neg)' : r.color;
      bars += `<rect class="bar" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="${col}"/>`;
    });
  });
  const xl = xLabels(labels, W, pad, 6).map((t) => t.replace('y="0"', `y="${H - 6}"`)).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none"><line class="grid" x1="${pad}" y1="${zeroY}" x2="${W - 8}" y2="${zeroY}"/>${bars}${xl}</svg>`;
}
function linesSVG(aligned, opts = {}) {
  const { labels, rows } = aligned;
  const W = 360, H = 170, pad = 30, base = H - 24, top = 14;
  const all = rows.flatMap((r) => r.vals).filter((v) => v != null);
  if (!all.length) return '<svg viewBox="0 0 360 170" class="chart"></svg>';
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
  const xl = xLabels(labels, W, pad, 6).map((t) => t.replace('y="0"', `y="${H - 6}"`)).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none">${grid}${paths}${xl}</svg>`;
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
  return `<svg viewBox="0 0 ${W} ${H}" class="lchart" preserveAspectRatio="none">
    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".18"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    ${gl.join('')}<path d="${area}" fill="url(#cg)"/><path d="${path}" fill="none" stroke="${col}" stroke-width="2"/>
    <text x="${pad}" y="${H - 8}" class="axl">${fmtD(minX)}</text><text x="${W - pad}" y="${H - 8}" class="axl" text-anchor="end">${fmtD(maxX)}</text></svg>
    <div class="chstat"><span>Low ₹${Math.round(minY)}</span><span>High ₹${Math.round(maxY)}</span><span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${((last / firstV - 1) * 100).toFixed(1)}% over range</span></div>`;
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
  ].map(([k, v, max, pen]) => `<div class="scorebar"><div class="sk">${k}</div><div class="st"><div class="sf ${pen ? 'pen' : ''}" style="width:${Math.max(0, Math.min(1, (v || 0) / max)) * 100}%"></div></div><div class="sv">${pen ? '−' : ''}${v ?? '—'}</div></div>`).join('');
  const list = (arr) => `<ul class="bblist">${(arr || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>—</li>'}</ul>`;
  const ass = (lab, body) => body ? `<div class="asscard"><div class="at">${lab}</div><div class="ab">${esc(body)}</div></div>` : '';
  const rc = (arr) => `<div class="rclist">${(arr || []).map((x) => `<div class="rcitem">${esc(x)}</div>`).join('') || '<div class="rcitem">—</div>'}</div>`;
  const sources = (t._sources || []).length ? `<div class="sources"><h4>Researched from the web</h4><div class="srcchips">${t._sources.map((s) => `<a class="srcchip" href="${esc(s.uri)}" target="_blank" rel="noopener">${esc((s.title || s.uri).slice(0, 60))}</a>`).join('')}</div></div>` : '';
  return `
  <div class="verdictbar">
    <div class="verdict ${vcls}">${esc(verdict)}</div>
    <div class="vmeta"><div class="total">Score <b>${sc.total ?? '—'}</b> / 30</div><div class="conf">Confidence ${conf}/100</div></div>
    <div class="confbar"><div class="lab">Confidence</div><div class="track"><div class="fill" style="width:${conf}%"></div></div></div>
    <button class="btn btn-ghost btn-sm" onclick="generateThesis(true)">${I.refresh} Regenerate</button>
  </div>
  <div class="scoregrid">${scoreRows}</div>
  <div class="th-exec">${esc(t.executive_thesis || '')}</div>
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
function renderAllocation() {
  const mount = $('#allocMount');
  if (!state.allocation.length) {
    mount.innerHTML = `<div class="empty big"><h3>No stocks flagged for allocation</h3><p>In <b>Research</b>, hit the ☆ next to a name to add it here.</p></div>`;
    return;
  }
  mount.innerHTML = `<div class="alloc-grid">${state.allocation.map((sym) => {
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
        <div>D/E<b>${num(q?.debt_to_equity)}</b></div><div>M-cap<b>${pk ? abbr(pk.profile.market_cap_cr) : '—'}</b></div>
      </div>
      <span class="rm" onclick="toggleAlloc('${esc(sym)}')">remove</span>
    </div>`;
  }).join('')}</div>
  <div class="gapnote" style="margin-top:16px">Position sizing, a monthly buy plan and conviction-weighting live here next — <b>out of scope for this build</b>.</div>`;
}

/* ============================ CHROME ============================ */
function applyTheme() { document.documentElement.setAttribute('data-theme', state.theme === 'dark' ? 'dark' : ''); $('#themeBtn').innerHTML = state.theme === 'dark' ? I.moon : I.sun; const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', state.theme === 'dark' ? '#0f1216' : '#ffffff'); }
function toggleTheme() { state.theme = state.theme === 'dark' ? 'light' : 'dark'; persist(); applyTheme(); if (state.step === 2 && state.activeTab === 'data') renderStockData(); }
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
    <p><b>A fixed direction in a noisy market.</b> Meridian runs my monthly routine in one place: screen, intersect, research, decide. Built by Ansh Dwivedi — personal and non-commercial.</p>
    <p>Quantitative data is read from Screener.in; price &amp; returns from Yahoo Finance; the long-term thesis is written by an AI agent (Google Gemini) that uses that data as ground truth and researches the gaps from the live web.</p>
    <p class="muted">Nothing is fabricated — anything unreachable is shown as “—” or flagged by the agent.</p>` },
  howto: { title: 'How to use Meridian', body: `
    <h4>1 · Shortlist</h4><p>Pick screens, set a depth, take the intersection. Hit <b>Research</b> on the survivors you want to study.</p>
    <h4>2 · Research</h4><p>Pick a stock on the left. <b>Stock Data</b> shows six buckets of fetched fundamentals; <b>Agent Thesis</b> generates a structured 10–15-year verdict on demand. Tap the ☆ to flag a name for allocation.</p>
    <h4>3 · Allocation</h4><p>Your flagged names gather here. Sizing &amp; the monthly buy plan come later.</p>
    <p class="muted">Everything resets when you close the tab — Meridian is a once-a-month, use-and-close tool.</p>` },
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
  $('#footnote').textContent = 'Meridian · personal stock picker · data from Screener.in & Yahoo Finance · thesis by Gemini';
  renderBadges();
  goStep(state.step || 1);
}
init();
