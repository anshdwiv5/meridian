/* Meridian — frontend logic (classic script; functions are global for inline handlers).
   All data comes from the API (/api/*). The Worker fetches screens & company pages
   live from Screener on demand and live price/charts from Yahoo. Nothing is fabricated. */

const API = ''; // same origin (the Worker serves both UI and API)

const LENS = {
  integrity:{c:'#22D3EE', label:'Integrity'},
  value:    {c:'#5EE6F5', label:'Value'},
  quality:  {c:'#2FD4BF', label:'Quality'},
  garp:     {c:'#A78BFA', label:'GARP'},
  balance:  {c:'#E3B86A', label:'Balance-sheet'},
  growth:   {c:'#7AA8FF', label:'Growth'},
};

const I = {
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  arrow:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  compass:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z" fill="currentColor" stroke="none"/></svg>',
  intersect:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>',
  refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>',
  upload:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
  sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/></svg>',
  moon:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>',
};

const LS = { short:'meridian.shortlist.v1', thes:'meridian.theses.v1', theme:'meridian.theme.v1', tok:'meridian.admintoken.v1' };
const $ = s => document.querySelector(s);
function load(k, d){ try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
function save(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

const state = {
  view:'home', theme: load(LS.theme,'dark'),
  screens:null, screensLoading:false,
  openScreen:null,
  selected:new Set(),
  interN:null, inter:null,
  refresh:false,
  rowIndex:{},
  shortlist: load(LS.short, []),
  theses: load(LS.thes, {}),
  activeStock:null, activeSection:'snapshot',
  stockCache:{}, chartRange:'1y',
};

/* ---------- formatting ---------- */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const num = (v, suffix='') => (v===null||v===undefined||v==='') ? '—' : (v + suffix);
function cr(v){ if(v==null) return '—'; return v>=100000 ? '₹'+(v/100000).toFixed(2)+'L cr' : '₹'+Number(v).toLocaleString('en-IN')+' cr'; }
function fmtCr(v){ if(v==null) return '—'; return v>=100000 ? (v/100000).toFixed(1)+'L' : (v/1000).toFixed(1)+'k'; }
function ago(ms){ if(!ms) return 'never'; const s=(Date.now()-ms)/1000; if(s<90) return 'just now'; const m=s/60; if(m<90) return Math.round(m)+'m ago'; const h=m/60; if(h<36) return Math.round(h)+'h ago'; return Math.round(h/24)+'d ago'; }

/* ============================ NAVIGATION ============================ */
function goHome(){
  state.view='home'; state.activeStock=null;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('show'));
  $('#view-home').classList.add('show');
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  window.scrollTo({top:0, behavior:'smooth'});
}
function setView(v){
  state.view=v;
  document.querySelectorAll('.view').forEach(el=>el.classList.remove('show'));
  $('#view-'+v).classList.add('show');                 // hero (#view-home) is NOT shown here
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.view===v));
  window.scrollTo({top:0, behavior:'auto'});
  if(v==='quant') ensureScreens();
  if(v==='qual' && !state.activeStock){ $('#qualList').style.display='block'; $('#qualDetail').style.display='none'; renderShortlist(); }
}

/* ============================ QUANTITATIVE ============================ */
async function ensureScreens(force){
  if(state.screens && !force){ renderScreens(); return; }
  if(state.screensLoading) return;
  state.screensLoading=true;
  $('#screenGrid').innerHTML = `<div class="loading"><span class="spinner"></span> Loading screens…</div>`;
  try{
    const r = await fetch(`${API}/api/screens`);
    const data = await r.json();
    if(!r.ok) throw new Error(data.error || 'Failed to load screens');
    state.screens = data.screens || [];
  }catch(e){
    $('#screenGrid').innerHTML = apiError('Could not load screens', e.message);
    state.screensLoading=false; return;
  }
  state.screensLoading=false;
  renderScreens();
}
function apiError(title, msg){
  return `<div class="empty big"><h3>${esc(title)}</h3><p>${esc(msg||'')}<br><span style="color:var(--dim)">Is the Worker deployed and the D1 database created? See the README.</span></p></div>`;
}
function renderLegend(){
  const used = [...new Set((state.screens||[]).map(s=>s.lens))];
  $('#legend').innerHTML = used.map(l=>`<span><span class="lensdot" style="background:${LENS[l]?.c||'#888'}"></span>${LENS[l]?.label||l}</span>`).join('');
}
function renderScreens(){
  if(!state.screens) return;
  renderLegend();
  $('#screenGrid').innerHTML = state.screens.map(sc=>{
    const sel = state.selected.has(sc.id);
    const lc = LENS[sc.lens]?.c || '#888';
    const loaded = sc.count>0;
    const cnt = loaded ? `${sc.count} loaded · ${ago(sc.updated_at)} · view list →` : `tap to fetch live from Screener →`;
    return `<div class="screen ${sel?'sel':''}" onclick="onScreenClick('${sc.id}')">
      <div class="top">
        <div class="nm"><span class="lensdot" style="background:${lc}"></span>${esc(sc.name)}</div>
        <div class="chk" onclick="toggleSel('${sc.id}', event)">${I.check}</div>
      </div>
      <span class="lenspill"><span class="lensdot" style="background:${lc}"></span>${LENS[sc.lens]?.label||sc.lens}</span>
      <div class="gauge">${esc(sc.gauge)}</div>
      <div class="formula">${sc.formula||''}</div>
      <div class="cnt"><span>${cnt}</span>${sc.screener_url?`<a href="${esc(sc.screener_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Screener ↗</a>`:''}</div>
    </div>`;
  }).join('');
  const n = state.selected.size;
  $('#selCount').textContent = n;
  $('#pipQuant').textContent = n;
  const btn = $('#interBtn');
  btn.disabled = n < 2;
  btn.textContent = n < 2 ? 'Find intersection' : `Find intersection · ${n} screens`;
}
function onScreenClick(id){ openScreenList(id); }
function toggleSel(id, e){ if(e) e.stopPropagation();
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  renderScreens();
}
function clearSel(){ state.selected.clear(); renderScreens(); }

async function openScreenList(id, force){
  state.openScreen=id;
  const sc = (state.screens||[]).find(s=>s.id===id) || {name:id, lens:'value'};
  const lc = LENS[sc.lens]?.c || '#888';
  $('#interMount').innerHTML='';
  $('#screenListMount').innerHTML = `<div class="listwrap"><div class="loading"><span class="spinner"></span> Fetching “${esc(sc.name)}” live from Screener… <span style="color:var(--dim)">(first load can take a few seconds)</span></div></div>`;
  $('#screenListMount').scrollIntoView({behavior:'smooth', block:'nearest'});
  let data;
  try{
    const r = await fetch(`${API}/api/screens/${encodeURIComponent(id)}?limit=200${force?'&refresh=1':''}`);
    data = await r.json();
    if(!r.ok) throw new Error(data.error||'Failed');
  }catch(e){
    $('#screenListMount').innerHTML = `<div class="listwrap">${apiError('Could not load this screen', e.message)}</div>`; return;
  }
  const entries = data.entries || [];
  const src = data.source || {};
  // reflect updated counts on the card
  const card = (state.screens||[]).find(s=>s.id===id); if(card){ card.count = Math.max(card.count||0, entries.length); card.updated_at = src.updated_at || card.updated_at; renderScreens(); }
  entries.forEach(en => { state.rowIndex[en.symbol] = state.rowIndex[en.symbol] || {symbol:en.symbol, company:en.company}; });
  const rows = entries.map(en => screenRow(en)).join('');
  const srcNote = src.error
    ? `<span class="srcbad">Screener unavailable. ${esc(src.error)}</span>`
    : `<span class="srcok">${src.from==='cache'?'cached':'live from Screener'} · ${ago(src.updated_at)}</span>`;
  $('#screenListMount').innerHTML = `
    <div class="listwrap">
      <div class="listhead">
        <div class="ttl"><span class="lensdot" style="background:${lc}"></span>${esc(sc.name)}<span class="meta" style="margin-left:6px">${LENS[sc.lens]?.label||sc.lens}</span></div>
        <div class="meta">${srcNote} · ${entries.length} shown · <button class="add" style="padding:5px 10px" onclick="openScreenList('${id}', true)">${I.refresh} refresh</button> · <button class="add" style="padding:5px 10px" onclick="closeScreenList()">close ✕</button></div>
      </div>
      <div class="rowscroll">${rows || `<div class="empty"><h3>No entries</h3><p>${src.error?'Screener couldn’t be reached. Try refresh, or load this screen manually.':'This screen returned no rows.'}</p></div>`}</div>
    </div>`;
}
function closeScreenList(){ state.openScreen=null; $('#screenListMount').innerHTML=''; }
function screenRow(en){
  const added = state.shortlist.some(x=>x.symbol===en.symbol);
  return `<div class="row">
    <div class="rank">${en.rank}</div>
    <div class="co"><div class="t">${esc(en.company)}</div><div class="s">${esc(en.symbol)}</div></div>
    <div class="num hide-m">${esc(en.metric_label||'')}</div>
    <div class="num"><b>${esc(en.metric_value||'')}</b></div>
    <button class="add ${added?'added':''}" onclick="addForAnalysis('${esc(en.symbol)}', event)">${added?I.check+' Added':I.plus+' Analyse'}</button>
  </div>`;
}

/* ---------- intersection dialog ---------- */
function openInterDialog(){
  if(state.selected.size < 2) return;
  const names = (state.screens||[]).filter(s=>state.selected.has(s.id)).map(s=>s.name);
  $('#modal').className='modal';
  $('#modal').innerHTML = `
    <button class="close-x" onclick="closeOverlay()">✕</button>
    <div class="mh"><div class="ic">${I.intersect}</div>
      <h3>How deep should we read?</h3>
      <p>Take the top N entries from each screen, then keep only the companies that appear in <b>every</b> selected screen. Tighter = higher conviction; looser = wider net.</p>
    </div>
    <div class="selnote">Intersecting <b>${names.length} screens</b>: ${names.map(esc).join(' · ')}</div>
    <div class="mb"><div class="nopts">
      ${[25,50,100,150,200].map(n=>`<button class="nopt ${state.interN===n?'on':''}" data-n="${n}" onclick="pickN(${n})">${n}<small>entries</small></button>`).join('')}
    </div></div>
    <div class="mf">
      <button class="btn-sm btn-clear" onclick="closeOverlay()">Cancel</button>
      <button class="btn-sm btn-go" id="runInter" onclick="runIntersection()" ${state.interN?'':'disabled'}>Show intersection</button>
    </div>`;
  showOverlay();
}
function pickN(n){ state.interN=n;
  document.querySelectorAll('.nopt').forEach(b=>b.classList.toggle('on', +b.dataset.n===n));
  const r=$('#runInter'); if(r) r.disabled=false;
}
async function runIntersection(){
  const ids=[...state.selected]; const limit=state.interN||50;
  closeOverlay(); closeScreenList();
  $('#interMount').innerHTML = `<div class="listwrap"><div class="loading"><span class="spinner"></span> Fetching ${ids.length} screens from Screener &amp; computing exact overlap… <span style="color:var(--dim)">(first run can take a few seconds)</span></div></div>`;
  $('#interMount').scrollIntoView({behavior:'smooth', block:'nearest'});
  let data;
  try{
    const r = await fetch(`${API}/api/intersection`, {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ screenIds:ids, limit, refresh: state.refresh })
    });
    data = await r.json();
    if(!r.ok) throw new Error(data.error||'Failed');
  }catch(e){
    $('#interMount').innerHTML = `<div class="listwrap">${apiError('Intersection failed', e.message)}</div>`; return;
  }
  state.inter=data;
  (data.results||[]).forEach(row=>{ state.rowIndex[row.symbol]=row; });
  renderIntersection(data);
}
function renderIntersection(data){
  const names = (state.screens||[]).filter(s=>data.screenIds.includes(s.id)).map(s=>s.name);
  const warn = data.warning ? `<div class="warnbar">${I.refresh} ${esc(data.warning)}</div>` : '';
  if(!data.count){
    const failed = !!data.warning;
    $('#interMount').innerHTML = `
      <div class="listwrap" style="border-color:var(--line-2)">
        <div class="listhead">
          <div class="ttl">${I.compass}&nbsp; Intersection</div>
          <div class="meta">Top ${data.limit} of each · ${names.length} screens</div>
        </div>
        <div class="empty">
          ${ failed
            ? `<h3>Couldn’t fetch from Screener</h3><p>${esc(data.warning)}</p>`
            : `<h3>No intersection</h3><p>No company appears in all ${names.length} selected screens at this depth.</p>` }
        </div>
      </div>`;
    return;
  }
  const rows = data.results.map((r,i)=>{
    const added = state.shortlist.some(x=>x.symbol===r.symbol);
    return `<div class="row">
      <div class="rank">${i+1}</div>
      <div class="co"><div class="t">${esc(r.company)}</div><div class="s">${esc(r.symbol)}${r.sector?' · '+esc(r.sector):''}</div></div>
      <div class="num hide-m">${cr(r.mcap)}</div>
      <div class="num"><span style="color:var(--dim)">ROCE · PE</span><br><b>${num(r.roce,'%')} · ${num(r.pe)}</b></div>
      <button class="add ${added?'added':''}" onclick="addForAnalysis('${esc(r.symbol)}', event)">${added?I.check+' Added':I.plus+' Analyse'}</button>
    </div>`;
  }).join('');
  $('#interMount').innerHTML = `
    <div class="listwrap" style="border-color:var(--line-2); box-shadow:var(--shadow-glow)">
      <div class="listhead">
        <div class="ttl">${I.compass}&nbsp; Intersection · ${data.count} survivor${data.count===1?'':'s'}</div>
        <div class="meta">Top ${data.limit} of each · ${names.length} screens · exact overlap</div>
      </div>
      ${warn}
      <div class="rowscroll">${rows}</div>
    </div>`;
}

/* ---------- manual loader (fallback if Screener blocks the Worker IP) ---------- */
function openLoader(){
  const tok = load(LS.tok,'');
  const opts = SCREENS_META().map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#modal').className='modal wide';
  $('#modal').innerHTML = `<button class="close-x" onclick="closeOverlay()">✕</button>
    <div class="mh"><div class="ic">${I.upload}</div><h3>Load a screen manually</h3>
      <p>Fallback for if Screener blocks the server. Paste the on-screen list (one company per line) or a CSV export. Row order = rank. This writes straight to your database.</p></div>
    <div class="loaderbody">
      <div class="field"><label>Which screen</label>
        <select id="ldScreen">${opts}</select></div>
      <div class="field"><label>Admin token <span style="color:var(--dim)">(the ADMIN_TOKEN secret you set; blank if you didn't set one)</span></label>
        <input type="password" id="ldTok" value="${esc(tok)}" placeholder="optional"></div>
      <div class="field"><label>Paste list or CSV</label>
        <textarea id="ldText" rows="8" placeholder="Reliance Industries
TCS
HDFC Bank
…

or paste a CSV with Name / NSE Code columns"></textarea></div>
      <div id="ldMsg" class="ldmsg"></div>
    </div>
    <div class="mf">
      <button class="btn-sm btn-clear" onclick="closeOverlay()">Cancel</button>
      <button class="btn-sm btn-go" onclick="submitLoader()">Load into database</button>
    </div>`;
  showOverlay();
}
function SCREENS_META(){ return state.screens || []; }
function parseLoaderText(text){
  const lines = text.replace(/\r/g,'').split('\n').map(l=>l.trim()).filter(Boolean);
  if(!lines.length) return [];
  const isCsv = lines[0].includes(',') && /name|code|symbol|company/i.test(lines[0]);
  if(isCsv){
    const header = splitCsv(lines[0]).map(h=>h.toLowerCase().trim());
    const nameI = header.findIndex(h=>h==='name'||h.includes('company'));
    const codeI = header.findIndex(h=>h.includes('nse')||h.includes('bse')||h==='symbol'||h.includes('code'));
    const out=[];
    for(let i=1;i<lines.length;i++){ const c=splitCsv(lines[i]); const company=(nameI>=0?c[nameI]:c[0]||'').trim(); if(!company) continue;
      const code=(codeI>=0&&c[codeI]?c[codeI]:company).trim(); out.push({rank:out.length+1, symbol:normKey(code), company, ticker: codeI>=0?code:null}); }
    return out;
  }
  // plain: one company per line (strip a leading "12." rank if present)
  return lines.map((l,i)=>{ const company=l.replace(/^\s*\d+[.)]\s*/,'').trim(); return {rank:i+1, symbol:normKey(company), company}; }).filter(x=>x.company);
}
function splitCsv(line){ const out=[]; let f='',q=false; for(let i=0;i<line.length;i++){const c=line[i]; if(q){ if(c==='"'){ if(line[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; } else { if(c==='"')q=true; else if(c===','){out.push(f);f='';} else f+=c; } } out.push(f); return out.map(s=>s.trim()); }
function normKey(s){ return String(s).toUpperCase().replace(/[^A-Z0-9]+/g,'').slice(0,40); }
async function submitLoader(){
  const screenId = $('#ldScreen').value;
  const tok = $('#ldTok').value.trim();
  const entries = parseLoaderText($('#ldText').value);
  const msg = $('#ldMsg');
  if(!entries.length){ msg.innerHTML = `<span class="srcbad">Nothing to load. Paste at least one company.</span>`; return; }
  save(LS.tok, tok);
  msg.innerHTML = `<span class="spinner"></span> Loading ${entries.length} rows…`;
  try{
    const r = await fetch(`${API}/api/admin/load`, { method:'POST', headers:{'content-type':'application/json','x-admin-token':tok}, body: JSON.stringify({screenId, entries, replace:true}) });
    const data = await r.json();
    if(!r.ok) throw new Error(data.error||'Failed');
    msg.innerHTML = `<span class="srcok">Loaded ${data.loaded} into ${esc(screenId)} (total ${data.total}).${data.protected?'':' ⚠ No ADMIN_TOKEN set, anyone can write. Set one (README) to lock this.'}</span>`;
    state.screens=null; await ensureScreens(true);
  }catch(e){ msg.innerHTML = `<span class="srcbad">${esc(e.message)}</span>`; }
}

/* ============================ SHORTLIST / QUALITATIVE ============================ */
function addForAnalysis(symbol, e){ if(e) e.stopPropagation();
  if(!state.shortlist.some(x=>x.symbol===symbol)){
    const row = state.rowIndex[symbol] || {symbol, company:symbol};
    state.shortlist.push({ symbol, company:row.company||symbol, sector:row.sector??null, mcap:row.mcap??null, roce:row.roce??null, pe:row.pe??null, de:row.de??null });
    save(LS.short, state.shortlist);
    toast(`${row.company||symbol} added to Judgement`);
  }
  if(state.openScreen) openScreenList(state.openScreen);
  if(state.inter) renderIntersection(state.inter);
  $('#pipQual').textContent = state.shortlist.length;
}
function renderShortlist(){
  $('#pipQual').textContent = state.shortlist.length;
  const mount = $('#slMount');
  if(!state.shortlist.length){
    mount.innerHTML = `<div class="empty big">${I.compass}<h3>No stocks under analysis yet</h3><p>Go to the Quantitative tab, build an intersection, and hit <b>Analyse</b> on the names you want to dig into.</p></div>`;
    return;
  }
  mount.innerHTML = `<div class="sl-grid">${ state.shortlist.map(s=>{
    const conv = state.theses[s.symbol]?.conviction;
    return `<div class="slcard" onclick="openStock('${esc(s.symbol)}')">
      ${conv?`<span class="conv">Conviction ${conv}/10</span>`:''}
      <div class="nm">${esc(s.company)}</div>
      <div class="sec">${esc(s.symbol)}${s.sector?' · '+esc(s.sector):''}</div>
      <div class="mini" data-sym="${esc(s.symbol)}">
        <div>ROCE<b>${num(s.roce,'%')}</b></div>
        <div>PE<b>${num(s.pe)}</b></div>
        <div>D/E<b>${s.de==null?'—':Number(s.de).toFixed(2)}</b></div>
        <div>M-cap<b>${fmtCr(s.mcap)}</b></div>
      </div>
      <span class="open">Open judgement ${I.arrow}</span>
      <span class="rm" onclick="removeStock('${esc(s.symbol)}', event)">remove</span>
    </div>`;
  }).join('')}</div>`;
  state.shortlist.filter(s=>s.mcap==null).forEach(s=>enrichCard(s.symbol));
}
async function enrichCard(symbol){
  try{
    const st = await ensureStock(symbol);
    if(!st || !st.stock) return;
    const s = state.shortlist.find(x=>x.symbol===symbol); if(!s) return;
    Object.assign(s, { company:st.stock.company||s.company, sector:st.stock.sector??s.sector, mcap:st.stock.mcap, roce:st.stock.roce, pe:st.stock.pe, de:st.stock.de });
    save(LS.short, state.shortlist);
    const el = document.querySelector(`.mini[data-sym="${CSS.escape(symbol)}"]`);
    if(el) el.innerHTML = `<div>ROCE<b>${num(s.roce,'%')}</b></div><div>PE<b>${num(s.pe)}</b></div><div>D/E<b>${s.de==null?'—':Number(s.de).toFixed(2)}</b></div><div>M-cap<b>${fmtCr(s.mcap)}</b></div>`;
  }catch{}
}
function removeStock(symbol, e){ if(e) e.stopPropagation();
  state.shortlist = state.shortlist.filter(x=>x.symbol!==symbol);
  save(LS.short, state.shortlist);
  renderShortlist();
  if(state.openScreen) openScreenList(state.openScreen);
  if(state.inter) renderIntersection(state.inter);
}

async function ensureStock(symbol, force){
  if(state.stockCache[symbol] && !force) return state.stockCache[symbol];
  const r = await fetch(`${API}/api/stocks/${encodeURIComponent(symbol)}${force?'?refresh=1':''}`);
  const data = await r.json();
  state.stockCache[symbol] = r.ok ? data : { error:data.error||'not found', stock:null, detail:null };
  return state.stockCache[symbol];
}

const SECTIONS = [
  ['snapshot','Snapshot'],['business','Business & Moat'],['peers','Industry & Peers'],
  ['growth','Growth & Profitability'],['health','Financial Health'],['valuation','Valuation'],
  ['ownership','Ownership'],['mgmt','Management'],['concall','Concall Digest'],
  ['charts','Charts'],['risks','Risks & Bear Case'],['thesis','My Thesis'],
];
async function openStock(symbol, force){
  state.activeStock=symbol; state.activeSection='snapshot';
  $('#qualList').style.display='none';
  $('#qualDetail').style.display='block';
  $('#qualDetail').innerHTML = `<button class="back" onclick="backToList()">${I.back} All stocks under analysis</button><div class="loading"><span class="spinner"></span> Fetching the latest for ${esc(symbol)} from Screener &amp; Yahoo…</div>`;
  window.scrollTo({top:0, behavior:'smooth'});
  await ensureStock(symbol, force);
  renderDetail();
}
function backToList(){ state.activeStock=null; $('#qualDetail').style.display='none'; $('#qualList').style.display='block'; renderShortlist(); }
function setSection(id){ state.activeSection=id;
  document.querySelectorAll('.secnav button').forEach(b=>b.classList.toggle('on', b.dataset.s===id));
  renderDetailBody();
}
function renderDetail(){
  const sym = state.activeStock;
  const cached = state.stockCache[sym] || {};
  const fallback = state.shortlist.find(x=>x.symbol===sym) || {symbol:sym, company:sym};
  const st = cached.stock || { symbol:sym, company:fallback.company, sector:fallback.sector, mcap:fallback.mcap, roce:fallback.roce, pe:fallback.pe, de:fallback.de };
  const conv = state.theses[sym]?.conviction;
  const enriched = !!cached.stock;
  const live = cached.live;
  const srcErr = cached.source && cached.source.error;
  let priceBlock = '';
  if(live && live.price!=null){
    const chg = (live.prevClose!=null) ? ((live.price/live.prevClose-1)*100) : null;
    priceBlock = `<div class="price"><div class="p">₹${Number(live.price).toLocaleString('en-IN')}</div><div class="d ${chg==null?'':(chg>=0?'up':'down')}">${chg==null?'live':((chg>=0?'+':'')+chg.toFixed(2)+'% · live')}</div></div>`;
  } else if(st.price){ priceBlock = `<div class="price"><div class="p">₹${Number(st.price).toLocaleString('en-IN')}</div><div class="d">last close</div></div>`; }
  $('#qualDetail').innerHTML = `
    <button class="back" onclick="backToList()">${I.back} All stocks under analysis</button>
    <div class="dhead">
      <div>
        <div class="nm">${esc(st.company)}</div>
        <div class="sub">${esc(st.symbol)}${st.sector?' · '+esc(st.sector):''}${st.mcap?' · '+cr(st.mcap)+' market cap':''}</div>
        <div class="convbig"><span class="lab">Meridian view</span><span class="sc">${conv?conv+'/10 conviction':'awaiting your thesis'}</span>
          <button class="add" style="margin-left:auto;padding:5px 10px" onclick="openStock('${esc(sym)}', true)">${I.refresh} refresh</button></div>
      </div>
      ${priceBlock}
    </div>
    ${srcErr?`<div class="warnbar">${I.refresh} Couldn’t fully reach Screener for ${esc(st.symbol)} (${esc(srcErr)}). Showing what we have; live price/chart still work.</div>`:''}
    <div class="secnav">${SECTIONS.map(([id,lab])=>`<button class="${id===state.activeSection?'on':''}" data-s="${id}" onclick="setSection('${id}')">${lab}</button>`).join('')}</div>
    <div id="detailBody"></div>`;
  renderDetailBody();
}
function smallTable(obj){
  const keys = Object.keys(obj||{});
  if(!keys.length) return '';
  return `<table class="mtab"><tbody>${keys.map(k=>`<tr><td>${esc(k)}</td><td><b>${esc(obj[k])}</b></td></tr>`).join('')}</tbody></table>`;
}
function renderDetailBody(){
  const sym = state.activeStock;
  const cached = state.stockCache[sym] || {};
  const st = cached.stock || (state.shortlist.find(x=>x.symbol===sym) || {symbol:sym});
  const d = cached.detail || {};
  const sec = state.activeSection;
  const W = c => `<div class="dsec">${c}</div>`;
  const pending = t => `<p class="bodytext muted">${t}</p>`;
  let html='';

  if(sec==='snapshot'){
    html = W(`<h3>Snapshot</h3><p class="note">The one-screen read before you go deeper.</p>
      <div class="ratio-grid">
        <div class="rt"><div class="k">ROCE</div><div class="v">${num(st.roce,'%')}</div><div class="x">return on capital</div></div>
        <div class="rt"><div class="k">ROE</div><div class="v">${num(st.roe,'%')}</div><div class="x">return on equity</div></div>
        <div class="rt"><div class="k">PE</div><div class="v">${num(st.pe)}</div><div class="x">price/earnings</div></div>
        <div class="rt"><div class="k">Debt / Equity</div><div class="v">${st.de==null?'—':Number(st.de).toFixed(2)}</div><div class="x">leverage</div></div>
        <div class="rt"><div class="k">OPM</div><div class="v">${num(st.opm,'%')}</div><div class="x">operating margin</div></div>
        <div class="rt"><div class="k">Profit CAGR</div><div class="v">${num(st.profit_cagr,'%')}</div><div class="x">5-yr</div></div>
        <div class="rt"><div class="k">Div. Yield</div><div class="v">${num(st.div_yield,'%')}</div><div class="x">trailing</div></div>
        <div class="rt"><div class="k">Promoter</div><div class="v">${num(st.promoter,'%')}</div><div class="x">holding</div></div>
      </div>
      <div class="bodytext" style="margin-top:20px"><p>${d.about?esc(d.about):'<span class="muted">Business overview loads from the company’s Screener page when reachable.</span>'}</p></div>`);
  }
  else if(sec==='business'){
    html = W(`<h3>Business &amp; Moat</h3><p class="note">What they do, how they earn, and what protects it.</p>
      <div class="bodytext">${d.about?`<p>${esc(d.about)}</p>`:pending('Business description loads from Screener when reachable.')}</div>
      ${d.pros?.length?`<h4 class="subh">What’s working</h4><div class="flags">${d.pros.map(p=>`<div class="flag ok"><div class="ic">✓</div><div class="tx">${esc(p)}</div></div>`).join('')}</div>`:''}`);
  }
  else if(sec==='peers'){
    if(d.peers && d.peers.rows?.length){
      const h = d.peers.headers||[];
      html = W(`<h3>Industry &amp; Peers</h3><p class="note">How it stacks up against companies in the same business.</p>
        <div class="rowscroll" style="max-height:none"><table class="ptab"><thead><tr>${h.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead>
        <tbody>${d.peers.rows.map(r=>{const me=r.symbol===sym; return `<tr class="${me?'me':''}">${r.cells.map((c,i)=>`<td>${i===1?`<b>${esc(c)}</b>`:esc(c)}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>
        <p class="bodytext muted" style="margin-top:12px">Peer set & sector medians as listed on Screener.</p>`);
    } else {
      html = W(`<h3>Industry &amp; Peers</h3><p class="note">How it stacks up against companies in the same business.</p>
        ${st.sector?`<p class="bodytext">Sector: <b>${esc(st.sector)}</b></p>`:''}
        ${pending('Peer comparison loads from the company’s Screener page. Screener builds it dynamically, so it may not always be captured. Open the Screener link on the card, or hit refresh.')}`);
    }
  }
  else if(sec==='growth'){
    const r = d.ranges||{};
    const blocks = ['Compounded Sales Growth','Compounded Profit Growth','Return on Equity','Stock Price CAGR']
      .filter(k=>r[k]).map(k=>`<div class="growthcard"><h4 class="subh">${esc(k)}</h4>${smallTable(r[k])}</div>`).join('');
    html = W(`<h3>Growth &amp; Profitability</h3><p class="note">Is it growing, and does that growth earn returns?</p>
      <div class="ratio-grid">
        <div class="rt"><div class="k">Sales CAGR</div><div class="v">${num(st.sales_cagr,'%')}</div></div>
        <div class="rt"><div class="k">Profit CAGR</div><div class="v">${num(st.profit_cagr,'%')}</div></div>
        <div class="rt"><div class="k">ROCE</div><div class="v">${num(st.roce,'%')}</div></div>
        <div class="rt"><div class="k">ROE</div><div class="v">${num(st.roe,'%')}</div></div>
      </div>
      ${blocks?`<div class="growthgrid" style="margin-top:18px">${blocks}</div>`:pending('Compounded growth tables load from Screener when reachable.')}`);
  }
  else if(sec==='health'){
    html = W(`<h3>Financial Health &amp; Earnings Quality</h3><p class="note">Can you trust the numbers? Leverage, margins, cash.</p>
      <div class="ratio-grid">
        <div class="rt"><div class="k">Debt / Equity</div><div class="v">${st.de==null?'—':Number(st.de).toFixed(2)}</div><div class="x">${st.de==null?'':(st.de<0.3?'low':st.de<1?'moderate':'high')}</div></div>
        <div class="rt"><div class="k">ROCE</div><div class="v">${num(st.roce,'%')}</div><div class="x">capital efficiency</div></div>
        <div class="rt"><div class="k">OPM</div><div class="v">${num(st.opm,'%')}</div><div class="x">operating margin</div></div>
        <div class="rt"><div class="k">Div Yield</div><div class="v">${num(st.div_yield,'%')}</div><div class="x">payout signal</div></div>
      </div>
      ${(d.pros?.length||d.cons?.length)?`<div class="flags" style="margin-top:18px">
        ${(d.pros||[]).map(p=>`<div class="flag ok"><div class="ic">✓</div><div class="tx">${esc(p)}</div></div>`).join('')}
        ${(d.cons||[]).map(c=>`<div class="flag watch"><div class="ic">!</div><div class="tx">${esc(c)}</div></div>`).join('')}
      </div>`:pending('Screener’s pros & cons load here when reachable.')}`);
  }
  else if(sec==='valuation'){
    html = W(`<h3>Valuation</h3><p class="note">What the price implies, against the business.</p>
      <div class="ratio-grid">
        <div class="rt"><div class="k">Current PE</div><div class="v">${num(st.pe)}</div></div>
        <div class="rt"><div class="k">ROCE</div><div class="v">${num(st.roce,'%')}</div></div>
        <div class="rt"><div class="k">Div Yield</div><div class="v">${num(st.div_yield,'%')}</div></div>
        <div class="rt"><div class="k">Market cap</div><div class="v">${st.mcap?cr(st.mcap):'—'}</div></div>
      </div>
      <div class="bodytext" style="margin-top:16px">${st.pe!=null?`<p>At <b>${st.pe}×</b> earnings with ROCE of <b>${num(st.roce,'%')}</b>, weigh the multiple against the ${num(st.profit_cagr,'%')} profit CAGR it has delivered. Compare with the peer set under Industry &amp; Peers before deciding if it's cheap.</p>`:pending('Valuation ratios load from Screener when reachable.')}</div>`);
  }
  else if(sec==='ownership'){
    const sh = d.shareholding||{};
    const pub = (st.promoter!=null&&st.fii!=null&&st.dii!=null) ? Math.max(0,(100-st.promoter-st.fii-st.dii)).toFixed(0) : null;
    html = W(`<h3>Ownership &amp; Smart Money</h3><p class="note">Who owns it, and which way the institutions lean.</p>
      <dl class="kv">
        <dt>Promoter holding</dt><dd>${num(st.promoter,'%')}</dd>
        <dt>FII holding</dt><dd>${num(st.fii,'%')}</dd>
        <dt>DII holding</dt><dd>${num(st.dii,'%')}</dd>
        <dt>Public &amp; others</dt><dd>${pub==null?'—':pub+'%'}</dd>
      </dl>
      ${Object.keys(sh).length?`<h4 class="subh">Latest shareholding (Screener)</h4>${smallTable(sh)}`:pending('Shareholding pattern loads from Screener when reachable.')}`);
  }
  else if(sec==='mgmt'){
    html = W(`<h3>Management &amp; Governance</h3><p class="note">Integrity, capital allocation, and delivery vs promises.</p>
      ${pending('Management quality is a judgement call. Use the pros/cons (Financial Health), the shareholding trend (Ownership), and the concall notes, plus the company’s annual report on Screener, to assess capital allocation and governance. Capture your read in My Thesis.')}
      ${st.promoter!=null?`<div class="flags"><div class="flag ${st.promoter>=50?'ok':'watch'}"><div class="ic">${st.promoter>=50?'✓':'!'}</div><div class="tx">Promoter holding ${num(st.promoter,'%')}. ${st.promoter>=50?'skin in the game.':'lower promoter stake; check trend & pledging.'}</div></div></div>`:''}`);
  }
  else if(sec==='concall'){
    html = W(`<h3>Concall &amp; Filings Digest</h3><p class="note">Earnings-call & annual-report highlights.</p>
      ${pending('Concall transcript summaries need a separate text pipeline (the transcripts live as PDFs on Screener/BSE). Pros & cons under Financial Health already capture Screener’s auto-generated highlights. You can wire an AI summary step here later. See the README.')}`);
  }
  else if(sec==='charts'){
    html = W(`<h3>Charts</h3><p class="note">Live price from Yahoo Finance, shown in app.</p>
      <div class="chartbox">
        <div class="chartbar">
          <div style="font-weight:700;font-size:14px" id="chTitle">${esc(st.symbol)} · Price</div>
          <div class="rangebtns">${['6mo','1y','5y'].map(r=>`<button class="${state.chartRange===r?'on':''}" onclick="setChartRange('${r}')">${r.toUpperCase()}</button>`).join('')}</div>
        </div>
        <div id="nativeChart" class="nativechart"><div class="loading"><span class="spinner"></span> Loading price history…</div></div>
        <div class="tvnote">Data: Yahoo Finance (${esc(st.symbol)}). For a full interactive chart, <button class="linklike" onclick="mountTV('${esc(st.symbol)}')">load TradingView ↗</button></div>
      </div>`);
  }
  else if(sec==='risks'){
    html = W(`<h3>Risks &amp; Bear Case</h3><p class="note">What would make this a bad investment.</p>
      ${d.cons?.length?`<div class="flags">${d.cons.map(r=>`<div class="flag watch"><div class="ic">!</div><div class="tx">${esc(r)}</div></div>`).join('')}</div>`:pending('Screener’s cons (the bear flags) load here when reachable.')}`);
  }
  else if(sec==='thesis'){
    const t = state.theses[sym] || {thesis:'', wrong:'', conviction:6};
    html = W(`<h3>My Thesis &amp; Conviction</h3><p class="note">Your call, in your words. Saved on this device.</p>
      <div class="field"><label>In one paragraph: what am I buying, and why is it mispriced?</label>
        <textarea id="th_thesis" rows="4" placeholder="e.g. A debt-free compounder where the market is under-pricing the specialty ramp…">${esc(t.thesis)}</textarea></div>
      <div class="field"><label>What would prove me wrong? (2–3 triggers)</label>
        <textarea id="th_wrong" rows="3" placeholder="e.g. USFDA action at a key plant; launches slip two quarters…">${esc(t.wrong)}</textarea></div>
      <div class="field"><label>Conviction</label>
        <div class="slider-row"><input type="range" min="1" max="10" value="${t.conviction}" id="th_conv" oninput="document.getElementById('convOut').textContent=this.value"><span class="convval" id="convOut">${t.conviction}</span></div>
      </div>
      <div style="margin-top:20px"><button class="btn btn-primary" onclick="saveThesis('${esc(sym)}')">Save judgement</button></div>`);
  }
  $('#detailBody').innerHTML = html;
  if(sec==='charts') loadNativeChart(st.ticker || st.symbol);
}
function setChartRange(r){ state.chartRange=r; document.querySelectorAll('.rangebtns button').forEach(b=>b.classList.toggle('on', b.textContent.toLowerCase()===r)); const st=(state.stockCache[state.activeStock]||{}).stock||{symbol:state.activeStock}; loadNativeChart(st.ticker||st.symbol); }
function saveThesis(sym){
  state.theses[sym] = { thesis:$('#th_thesis').value, wrong:$('#th_wrong').value, conviction:+$('#th_conv').value };
  save(LS.thes, state.theses);
  toast('Judgement saved');
  renderDetail();
}

/* ---------- native chart (SVG line from Yahoo, via our /api/chart) ---------- */
async function loadNativeChart(symbol){
  const mount = document.getElementById('nativeChart'); if(!mount) return;
  try{
    const r = await fetch(`${API}/api/chart/${encodeURIComponent(symbol)}?range=${state.chartRange}`);
    const data = await r.json();
    if(!r.ok || data.error || !data.points?.length) throw new Error(data.error||'no data');
    mount.innerHTML = svgLineChart(data.points);
    const t = document.getElementById('chTitle'); if(t && data.ticker) t.textContent = `${data.ticker} · Price (₹)`;
  }catch(e){
    mount.innerHTML = `<div class="loading">Chart unavailable for this ticker (${esc(String(e.message||e))}). Yahoo may not list it under ${esc(symbol)}.NS.</div>`;
  }
}
function svgLineChart(points){
  const W=720,H=320,pad=34;
  const xs=points.map(p=>p.t), ys=points.map(p=>p.c);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const X=t=> pad + (t-minX)/((maxX-minX)||1)*(W-pad*1.4);
  const Y=c=> (H-pad) - (c-minY)/((maxY-minY)||1)*(H-pad*1.7);
  const path = points.map((p,i)=>`${i?'L':'M'}${X(p.t).toFixed(1)} ${Y(p.c).toFixed(1)}`).join(' ');
  const area = `${path} L ${X(maxX).toFixed(1)} ${H-pad} L ${X(minX).toFixed(1)} ${H-pad} Z`;
  const last=ys[ys.length-1], first=ys[0], upd=last>=first;
  const col = upd? 'var(--pos)' : 'var(--neg)';
  const fmtD=t=>{const d=new Date(t); return d.toLocaleDateString('en-IN',{month:'short',year:'2-digit'});};
  const ticks=4, gl=[];
  for(let i=0;i<=ticks;i++){ const v=minY+(maxY-minY)*i/ticks; const y=Y(v); gl.push(`<line x1="${pad}" y1="${y.toFixed(1)}" x2="${W-pad*0.4}" y2="${y.toFixed(1)}" class="grid"/><text x="6" y="${(y+3).toFixed(1)}" class="axl">${Math.round(v)}</text>`); }
  return `<svg viewBox="0 0 ${W} ${H}" class="lchart" preserveAspectRatio="none">
    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    ${gl.join('')}
    <path d="${area}" fill="url(#cg)"/>
    <path d="${path}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round"/>
    <text x="${pad}" y="${H-8}" class="axl">${fmtD(minX)}</text>
    <text x="${W-pad}" y="${H-8}" class="axl" text-anchor="end">${fmtD(maxX)}</text>
    <circle cx="${X(maxX).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="3.4" fill="${col}"/>
  </svg>
  <div class="chstat"><span>Low ₹${Math.round(minY)}</span><span>High ₹${Math.round(maxY)}</span><span class="${upd?'up':'down'}">${upd?'▲':'▼'} ${((last/first-1)*100).toFixed(1)}% over range</span></div>`;
}

/* ---------- TradingView (optional, on demand) ---------- */
function mountTV(symbol){
  const note = document.querySelector('.tvnote'); if(note) note.outerHTML = `<div class="tvnote">Loading TradingView…</div>`;
  const box = document.querySelector('.chartbox'); if(!box) return;
  const holder = document.createElement('div'); holder.id='tvchart'; holder.style.height='420px'; holder.style.marginTop='10px'; box.appendChild(holder);
  const sym = 'NSE:' + String(symbol).replace(/[^A-Za-z0-9_]/g,'');
  const build=()=>{ if(!window.TradingView) return; try{ new window.TradingView.widget({symbol:sym, container_id:'tvchart', autosize:true, interval:'W', timezone:'Asia/Kolkata', theme: state.theme==='light'?'light':'dark', style:'1', locale:'in', hide_side_toolbar:true, allow_symbol_change:true, backgroundColor:'rgba(0,0,0,0)'}); }catch(e){ holder.innerHTML='Chart unavailable: '+esc(sym); } };
  if(window.TradingView){ build(); return; }
  const s=document.createElement('script'); s.src='https://s3.tradingview.com/tv.js'; s.onload=build; s.onerror=()=>{holder.innerHTML='Couldn’t load TradingView (network/adblock).';}; document.head.appendChild(s);
}

/* ============================ CHROME ============================ */
function applyTheme(){
  document.documentElement.setAttribute('data-theme', state.theme==='light'?'light':'');
  $('#themeBtn').innerHTML = state.theme==='dark' ? I.moon : I.sun;
}
function toggleTheme(){
  state.theme = state.theme==='dark' ? 'light' : 'dark';
  save(LS.theme, state.theme);
  applyTheme();
  if(state.activeStock && state.activeSection==='charts') renderDetailBody();
}
function showOverlay(){ $('#overlay').classList.add('show'); }
function closeOverlay(){ $('#overlay').classList.remove('show'); }
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeOverlay(); });
$('#overlay').addEventListener('click', e=>{ if(e.target===$('#overlay')) closeOverlay(); });

let toastT;
function toast(msg){
  let el = $('#toast');
  if(!el){ el=document.createElement('div'); el.id='toast'; document.body.appendChild(el); }
  el.innerHTML = `<span style="color:var(--pos)">${I.check}</span> ${esc(msg)}`;
  requestAnimationFrame(()=>{ el.style.opacity='1'; el.style.transform='translateX(-50%) translateY(0)'; });
  clearTimeout(toastT); toastT=setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateX(-50%) translateY(20px)'; }, 1900);
}

const INFO = {
  about:{ title:'About Meridian', body:`
    <p><b>A fixed direction in a noisy market.</b> A meridian is the line navigators steer by, whatever the weather. Same idea here: stay oriented toward quality instead of reacting to the ticker.</p>
    <p>I built this for myself. Every month I put money to work, and I was running the same routine by hand across a dozen tabs. Meridian puts that whole process in one place: screen, intersect, judge, decide. It started as a fun side project and is now something I and a few friends and family use every month.</p>
    <p>Always open to feedback, whether that is a better way to run the monthly plan or a feature or bug in the picker.</p>
    <p class="muted">Built by Ansh Dwivedi. Personal and non-commercial. Screen and company data from Screener.in; price and charts from Yahoo Finance.</p>` },
  howto:{ title:'How to use Meridian', body:`
    <h4>1 · Screen</h4><p>Open <b>Quantitative</b>. Each card shows its exact formula. Tap one to pull its live ranked list.</p>
    <h4>2 · Intersect</h4><p>Tick two or more screens, hit <b>Find intersection</b>, and pick how deep to read (25 to 200). You get the names in <b>every</b> selected screen, computed exactly, and <b>0</b> when nothing overlaps.</p>
    <h4>3 · Analyse</h4><p>Hit <b>Analyse</b> on a name to send it to <b>Qualitative</b>.</p>
    <h4>4 · Judge</h4><p>Open a stock for the full picture on demand: business, peers, financials, valuation, ownership, management, a live chart, risks. Write your thesis, set a conviction score, decide.</p>` },
};
function openInfo(k){
  const o=INFO[k];
  $('#modal').className='modal wide';
  $('#modal').innerHTML = `<button class="close-x" onclick="closeOverlay()">✕</button>
    <div class="mh"><div class="ic">${I.compass}</div><h3>${o.title}</h3></div>
    <div class="modalbody-scroll">${o.body}</div>
    <div class="mf"><button class="btn-sm btn-go" onclick="closeOverlay()">Got it</button></div>`;
  showOverlay();
}

/* ============================ INIT ============================ */
function init(){
  applyTheme();
  $('#pipQuant').textContent = state.selected.size;
  $('#pipQual').textContent = state.shortlist.length;
  $('#footnote').textContent = 'Meridian · personal stock picker · data from Screener.in & Yahoo Finance';
}
init();
