/* ============================================================================
   REWIND — LOG TRADE
   Import on any page and call openLogTrade(). Injects its own styles and
   markup, writes straight to the real schema, and on a qualifying win asks
   whether to post it to Trading Ark.

   Writes a `trades` row shaped exactly like his existing data:
     { id text, user_id, trading_day date, journal, account_type,
       trade_data jsonb }
   and inside trade_data: sym, type, qty, entry, exit, stop, points, pnl, rr,
   grade, notes, session, confluences, images, account, accounts, market,
   date, created_at, id — PLUS `model`, which nothing was capturing before.
   ========================================================================== */

import { client, currentUser, signed } from './rewind-data.js';

/* contract point values — pnl is derived, never guessed */
const POINT_VALUE = {
  NQ: 20, MNQ: 2, ES: 50, MES: 5, YM: 5, MYM: 0.5,
  RTY: 50, M2K: 5, CL: 1000, MCL: 100, GC: 100, MGC: 10, NG: 10000, SI: 5000,
};
const SESSIONS = ['Asia', 'London', 'NY AM', 'NY PM'];
const MODELS   = ['OTE', 'CISD', 'FVG', 'Silver Bullet', 'Turtle Soup', '2022 Model', 'Unicorn', 'Judas Swing'];
const TFS      = ['1m', '5m', '15m', '1H', '4H', 'D'];
/* only these post to #wins — paper never does */
const POSTABLE = ['eval', 'funded', 'live'];

let mounted = false;

/* ---------------------------------------------------------------------------
   STYLES — the app's own language: black, ribbing, mono labels, Azeret money
   ------------------------------------------------------------------------- */
const CSS = `
.lt-back{position:fixed;inset:0;z-index:200;background:rgba(6,8,10,.72);backdrop-filter:blur(3px);
  display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 20px;}
.lt-back.on{display:flex;}
.lt{width:min(100%,940px);background:#14171B;border:1px solid rgba(255,255,255,.18);border-radius:4px;
  position:relative;overflow:hidden;}
.lt-ribs{position:absolute;inset:0;pointer-events:none;opacity:.16;
  background:repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, rgba(0,0,0,.16) 2px 9px);}
.lt-in{position:relative;}
.lt-head{display:flex;align-items:center;gap:14px;padding:17px 22px;border-bottom:1px solid rgba(255,255,255,.12);}
.lt-head b{font-family:"Instrument Sans",system-ui,sans-serif;font-weight:700;font-size:16px;letter-spacing:-.02em;color:#FFF;}
.lt-head span{font-family:"JetBrains Mono",monospace;font-size:8px;letter-spacing:.22em;text-transform:uppercase;color:#FFF;}
.lt-x{margin-left:auto;background:none;border:none;color:#FFF;font-size:20px;line-height:1;cursor:pointer;padding:0 4px;}
.lt-body{display:grid;grid-template-columns:1fr 296px;gap:0;}
.lt-main{padding:20px 22px;}
.lt-side{padding:20px 22px;border-left:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.018);}
@media(max-width:820px){.lt-body{grid-template-columns:1fr;}.lt-side{border-left:none;border-top:1px solid rgba(255,255,255,.12);}}

.lt-lab{display:block;font-family:"JetBrains Mono",monospace;font-size:8px;letter-spacing:.2em;
  text-transform:uppercase;color:#FFF;margin-bottom:9px;}
.lt-row{margin-bottom:19px;}
.lt-grid{display:grid;gap:12px;}
.lt-g3{grid-template-columns:repeat(3,1fr);} .lt-g2{grid-template-columns:repeat(2,1fr);}
.lt-g4{grid-template-columns:repeat(4,1fr);}

.lt input,.lt select,.lt textarea{width:100%;background:rgba(255,255,255,.05);color:#FFF;
  border:1px solid rgba(255,255,255,.16);border-radius:3px;padding:10px 12px;outline:none;
  font-family:"Azeret Mono",monospace;font-size:13px;letter-spacing:-.02em;}
.lt textarea{font-family:"Inter Tight",system-ui,sans-serif;font-size:13px;letter-spacing:0;resize:vertical;min-height:74px;}
.lt input:focus,.lt select:focus,.lt textarea:focus{border-color:rgba(255,255,255,.42);}
.lt input::placeholder{color:#FFF;opacity:.34;}
.lt select{appearance:none;cursor:pointer;font-family:"Inter Tight",system-ui,sans-serif;}

.lt-seg{display:flex;border:1px solid rgba(255,255,255,.16);border-radius:3px;overflow:hidden;}
.lt-seg button{flex:1;background:none;border:none;border-right:1px solid rgba(255,255,255,.12);
  color:#FFF;font-family:"JetBrains Mono",monospace;font-size:8.5px;letter-spacing:.16em;
  text-transform:uppercase;padding:11px 4px;cursor:pointer;}
.lt-seg button:last-child{border-right:none;}
.lt-seg button.on{background:#FFF;color:#0E1114;font-weight:500;}
.lt-seg.win button.on{background:#57BE8B;color:#08110C;}
.lt-seg.lose button.on{background:#DE6B62;color:#150807;}

.lt-chips{display:flex;flex-wrap:wrap;gap:6px;}
.lt-shot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.lt-shot input[type=file]{display:none;}
.lt-shotbtn{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);border-radius:2px;
  color:#FFF;font-family:"JetBrains Mono",monospace;font-size:8px;letter-spacing:.14em;
  text-transform:uppercase;padding:9px 13px;cursor:pointer;}
.lt-shotbtn:hover{border-color:rgba(255,255,255,.42);}
.lt-thumb{position:relative;width:104px;height:60px;border:1px solid rgba(255,255,255,.16);border-radius:2px;overflow:hidden;}
.lt-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.lt-thumb button{position:absolute;top:3px;right:3px;width:17px;height:17px;line-height:1;
  background:#0E1114;border:1px solid rgba(255,255,255,.28);border-radius:2px;color:#FFF;
  font-size:11px;cursor:pointer;padding:0;}
.lt-shotmsg{font-family:"JetBrains Mono",monospace;font-size:8px;letter-spacing:.14em;
  text-transform:uppercase;color:#FFF;}
.lt-chip{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);border-radius:2px;
  color:#FFF;font-family:"JetBrains Mono",monospace;font-size:8px;letter-spacing:.14em;
  text-transform:uppercase;padding:8px 11px;cursor:pointer;}
.lt-chip.on{background:#FFF;color:#0E1114;border-color:#FFF;}

.lt-step{display:flex;align-items:center;gap:0;border:1px solid rgba(255,255,255,.16);border-radius:3px;overflow:hidden;}
.lt-step button{background:rgba(255,255,255,.05);border:none;color:#FFF;font-size:15px;line-height:1;
  width:38px;padding:11px 0;cursor:pointer;}
.lt-step input{border:none;border-radius:0;text-align:center;background:transparent;}

/* confluence rows */
.lt-conf{display:flex;gap:8px;margin-bottom:8px;}
.lt-conf select{flex:0 0 88px;}
.lt-conf input{flex:1;}
.lt-conf button{flex:none;width:38px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);
  border-radius:3px;color:#FFF;cursor:pointer;}
.lt-add{background:none;border:1px dashed rgba(255,255,255,.28);border-radius:3px;color:#FFF;
  font-family:"JetBrains Mono",monospace;font-size:8px;letter-spacing:.16em;text-transform:uppercase;
  padding:9px 13px;cursor:pointer;}

/* derived readout */
.lt-out{border:1px solid rgba(255,255,255,.16);border-radius:3px;overflow:hidden;margin-bottom:18px;}
.lt-out div{display:flex;justify-content:space-between;align-items:baseline;padding:11px 13px;}
.lt-out div + div{border-top:1px solid rgba(255,255,255,.09);}
.lt-out span{font-family:"JetBrains Mono",monospace;font-size:8px;letter-spacing:.18em;text-transform:uppercase;color:#FFF;}
.lt-out b{font-family:"Azeret Mono",monospace;font-weight:600;font-size:15px;letter-spacing:-.04em;color:#FFF;}
.lt-out b.up{color:#7FD9AC;} .lt-out b.dn{color:#F09189;}
.lt-out .hero b{font-size:21px;}
.lt-note{font-family:"JetBrains Mono",monospace;font-size:7.5px;letter-spacing:.14em;text-transform:uppercase;
  color:#FFF;line-height:1.8;margin-bottom:16px;}

.lt-save{width:100%;background:#FFF;color:#0E1114;border:none;border-radius:2px;padding:14px 0;
  font-family:"JetBrains Mono",monospace;font-size:9.5px;font-weight:500;letter-spacing:.2em;
  text-transform:uppercase;cursor:pointer;}
.lt-save:disabled{opacity:.4;cursor:default;}
.lt-cancel{width:100%;background:none;border:1px solid rgba(255,255,255,.16);border-radius:2px;
  color:#FFF;padding:12px 0;margin-top:9px;font-family:"JetBrains Mono",monospace;font-size:9px;
  letter-spacing:.18em;text-transform:uppercase;cursor:pointer;}
.lt-err{margin-top:12px;padding:10px 12px;border:1px solid rgba(222,107,98,.5);
  font-family:"JetBrains Mono",monospace;font-size:8.5px;letter-spacing:.1em;color:#F09189;line-height:1.7;display:none;}
.lt-err.on{display:block;}

/* the wins consent step */
.lt-ask{padding:30px 26px;text-align:center;}
.lt-ask .fig{font-family:"Azeret Mono",monospace;font-weight:600;font-size:44px;letter-spacing:-.05em;color:#7FD9AC;}
.lt-ask h4{font-family:"Instrument Sans",system-ui,sans-serif;font-weight:700;font-size:19px;color:#FFF;margin:16px 0 8px;}
.lt-ask p{font-family:"Inter Tight",system-ui,sans-serif;font-size:13.5px;line-height:1.7;color:#FFF;max-width:430px;margin:0 auto 22px;}
.lt-ask .btns{display:flex;gap:10px;max-width:400px;margin:0 auto;}
.lt-ask .btns button{flex:1;}
`;

/* ---------------------------------------------------------------------------
   STATE
   ------------------------------------------------------------------------- */
const S = {
  outcome: 'win', sym: 'NQ', side: 'long', acct: 'funded',
  qty: 1, copies: 1,
  entry: '', exit: '', stop: '',
  pnlOverride: null,
  session: '', model: '', grade: '',
  conf: [], notes: '', images: [], tv: '',
  date: today(),
};
/* function declarations, not consts — S's initializer calls today() before
   these lines are reached, and a const would be in its temporal dead zone */
function pad(n){ return String(n).padStart(2,'0'); }
function today(){ const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function num(v){ const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

/* ---------------------------------------------------------------------------
   THE MATHS — every derived number, in one place
   ------------------------------------------------------------------------- */
export function derive(s = S){
  const entry = num(s.entry), exit = num(s.exit), stop = num(s.stop);
  const dir = s.side === 'long' ? 1 : -1;
  const pv  = POINT_VALUE[s.sym] ?? null;

  const points = (entry !== null && exit !== null) ? (exit - entry) * dir : null;
  const risk   = (entry !== null && stop !== null) ? Math.abs(entry - stop) : null;

  /* R is reward over risk, signed. break-even is exactly 0. */
  let rr = null;
  if (s.outcome === 'be') rr = 0;
  else if (points !== null && risk) rr = points / risk;

  const qty = Math.max(1, parseInt(s.qty) || 1);
  const copies = Math.max(1, parseInt(s.copies) || 1);

  let pnl = null;
  if (s.pnlOverride !== null && s.pnlOverride !== '') pnl = num(s.pnlOverride);
  else if (s.outcome === 'be') pnl = 0;
  else if (points !== null && pv) pnl = points * pv * qty * copies;

  return { entry, exit, stop, points, risk, rr, qty, copies, pnl, pv,
           computed: s.pnlOverride === null || s.pnlOverride === '' };
}

/* a win only reaches #wins if it made money on a real account */
export function isPostable(s = S){
  const d = derive(s);
  return s.outcome === 'win' && d.pnl !== null && d.pnl > 0 && POSTABLE.includes(s.acct);
}

/* ---------------------------------------------------------------------------
   MOUNT
   ------------------------------------------------------------------------- */
function mount(){
  if (mounted) return;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  const back = document.createElement('div');
  back.className = 'lt-back'; back.id = 'ltBack';
  back.innerHTML = `
    <div class="lt"><div class="lt-ribs"></div><div class="lt-in" id="ltIn"></div></div>`;
  document.body.appendChild(back);
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && back.classList.contains('on')) close(); });
  mounted = true;
}

export function openLogTrade(){ mount(); renderForm(); document.getElementById('ltBack').classList.add('on'); }
export function close(){ const b = document.getElementById('ltBack'); if (b) b.classList.remove('on'); }

/* ---------------------------------------------------------------------------
   THE FORM
   ------------------------------------------------------------------------- */
function renderForm(){
  const d = derive();
  const seg = (name, opts, cur, cls='') =>
    `<div class="lt-seg ${cls}" data-seg="${name}">` +
    opts.map(([v,l]) => `<button data-v="${v}" class="${cur===v?'on':''}">${l}</button>`).join('') + `</div>`;

  document.getElementById('ltIn').innerHTML = `
    <div class="lt-head">
      <b>Log a trade</b>
      <span>${S.date}</span>
      <button class="lt-x" id="ltX" aria-label="Close">&times;</button>
    </div>

    <div class="lt-body">
      <div class="lt-main">

        <div class="lt-row">
          <span class="lt-lab">Outcome</span>
          ${seg('outcome', [['win','Win'],['loss','Loss'],['be','Break even']], S.outcome,
                S.outcome==='win'?'win':S.outcome==='loss'?'lose':'')}
        </div>

        <div class="lt-row lt-grid lt-g3">
          <div>
            <span class="lt-lab">Symbol</span>
            <select data-f="sym">${Object.keys(POINT_VALUE).map(k=>`<option ${S.sym===k?'selected':''}>${k}</option>`).join('')}</select>
          </div>
          <div>
            <span class="lt-lab">Side</span>
            ${seg('side', [['long','Long'],['short','Short']], S.side)}
          </div>
          <div>
            <span class="lt-lab">Date</span>
            <input type="date" data-f="date" value="${S.date}">
          </div>
        </div>

        <div class="lt-row lt-grid lt-g3">
          <div><span class="lt-lab">Entry</span><input data-f="entry" inputmode="decimal" value="${S.entry}" placeholder="0.00"></div>
          <div><span class="lt-lab">Exit</span><input data-f="exit" inputmode="decimal" value="${S.exit}" placeholder="0.00"></div>
          <div><span class="lt-lab">Stop</span><input data-f="stop" inputmode="decimal" value="${S.stop}" placeholder="0.00"></div>
        </div>

        <div class="lt-row lt-grid lt-g3">
          <div>
            <span class="lt-lab">Account</span>
            <select data-f="acct">
              ${[['funded','Funded'],['eval','Eval'],['live','Live'],['paper','Paper']]
                .map(([v,l])=>`<option value="${v}" ${S.acct===v?'selected':''}>${l}</option>`).join('')}
            </select>
          </div>
          <div>
            <span class="lt-lab">Contracts</span>
            <div class="lt-step"><button data-step="qty,-1">–</button><input data-f="qty" value="${S.qty}"><button data-step="qty,1">+</button></div>
          </div>
          <div>
            <span class="lt-lab">Copy accounts</span>
            <div class="lt-step"><button data-step="copies,-1">–</button><input data-f="copies" value="${S.copies}"><button data-step="copies,1">+</button></div>
          </div>
        </div>

        <div class="lt-row">
          <span class="lt-lab">Session</span>
          <div class="lt-chips">${SESSIONS.map(x=>`<button class="lt-chip ${S.session===x?'on':''}" data-pick="session" data-v="${x}">${x}</button>`).join('')}</div>
        </div>

        <div class="lt-row">
          <span class="lt-lab">Model</span>
          <div class="lt-chips">${MODELS.map(x=>`<button class="lt-chip ${S.model===x?'on':''}" data-pick="model" data-v="${x}">${x}</button>`).join('')}</div>
        </div>

        <div class="lt-row">
          <span class="lt-lab">Confluences</span>
          <div id="ltConf">${S.conf.map((c,i)=>confRow(c,i)).join('')}</div>
          <button class="lt-add" id="ltAddConf">+ Add confluence</button>
        </div>

        <div class="lt-row">
          <span class="lt-lab">Grade</span>
          <div class="lt-chips">${['A','B','C','D'].map(x=>`<button class="lt-chip ${S.grade===x?'on':''}" data-pick="grade" data-v="${x}">${x}</button>`).join('')}</div>
        </div>

        <div class="lt-row">
          <span class="lt-lab">Notes</span>
          <textarea data-f="notes" placeholder="What did you see, and what would you do differently?">${S.notes}</textarea>
        </div>

        <div class="lt-row">
          <span class="lt-lab">Chart screenshot</span>
          <div class="lt-shot">
            <input type="file" id="ltShotIn" accept="image/png,image/jpeg,image/webp,image/gif">
            <button type="button" class="lt-shotbtn" id="ltShotBtn">${S.images.length?'Replace':'Attach chart'}</button>
            ${S.images.map((u,i)=>`<span class="lt-thumb"><img src="${u}" alt=""><button type="button" data-shotdel="${i}">×</button></span>`).join('')}
            <span class="lt-shotmsg" id="ltShotMsg"></span>
          </div>
        </div>

        <div class="lt-row">
          <span class="lt-lab">TradingView link</span>
          <input data-f="tv" value="${S.tv}" placeholder="https://www.tradingview.com/x/...">
        </div>
      </div>

      <div class="lt-side">
        <span class="lt-lab">Derived</span>
        <div class="lt-out">
          <div class="hero"><span>Net</span><b id="oPnl" class="${d.pnl>0?'up':d.pnl<0?'dn':''}">${d.pnl===null?'—':signed(d.pnl)}</b></div>
          <div><span>Points</span><b id="oPts">${d.points===null?'—':(d.points>0?'+':'')+d.points.toFixed(2)}</b></div>
          <div><span>R multiple</span><b id="oR">${d.rr===null?'—':(d.rr>=0?'+':'−')+Math.abs(d.rr).toFixed(2)+'R'}</b></div>
          <div><span>Risk</span><b id="oRisk">${d.risk===null?'—':d.risk.toFixed(2)+' pts'}</b></div>
        </div>

        <div class="lt-note" id="ltCalc"></div>

        <div>
          <span class="lt-lab">Override net</span>
          <input data-f="pnlOverride" inputmode="decimal" value="${S.pnlOverride ?? ''}" placeholder="leave blank to compute">
        </div>

        <div style="margin-top:20px;">
          <button class="lt-save" id="ltSave">Save trade</button>
          <button class="lt-cancel" id="ltCancel">Cancel</button>
          <div class="lt-err" id="ltErr"></div>
        </div>
      </div>
    </div>`;

  wire();
  refresh();
}

const confRow = (c,i) => `
  <div class="lt-conf" data-i="${i}">
    <select data-cf="timeframe">${TFS.map(t=>`<option ${c.timeframe===t?'selected':''}>${t}</option>`).join('')}</select>
    <input data-cf="name" value="${(c.name||'').replace(/"/g,'&quot;')}" placeholder="e.g. order block">
    <button data-del="${i}" aria-label="Remove">&times;</button>
  </div>`;

/* ---------------------------------------------------------------------------
   WIRING
   ------------------------------------------------------------------------- */
function wire(){
  const $ = s => document.querySelectorAll(s);
  $('.lt [data-f]').forEach(el => el.addEventListener('input', e => {
    const f = e.target.dataset.f;
    S[f] = f === 'pnlOverride' ? (e.target.value === '' ? null : e.target.value) : e.target.value;
    refresh();
  }));
  $('.lt [data-seg] button').forEach(b => b.addEventListener('click', () => {
    S[b.parentElement.dataset.seg] = b.dataset.v; renderForm();
  }));
  $('.lt [data-pick]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.pick;
    S[k] = S[k] === b.dataset.v ? '' : b.dataset.v;      /* click again to clear */
    renderForm();
  }));
  $('.lt [data-step]').forEach(b => b.addEventListener('click', () => {
    const [f, delta] = b.dataset.step.split(',');
    S[f] = Math.max(1, (parseInt(S[f]) || 1) + parseInt(delta)); renderForm();
  }));
  const add = document.getElementById('ltAddConf');
  if (add) add.addEventListener('click', () => { S.conf.push({ timeframe:'5m', name:'' }); renderForm(); });
  $('.lt [data-del]').forEach(b => b.addEventListener('click', () => {
    S.conf.splice(+b.dataset.del, 1); renderForm();
  }));
  $('.lt [data-cf]').forEach(el => el.addEventListener('input', e => {
    const i = +e.target.closest('[data-i]').dataset.i;
    S.conf[i][e.target.dataset.cf] = e.target.value;
  }));
  const shotBtn = document.getElementById('ltShotBtn');
  const shotIn  = document.getElementById('ltShotIn');
  if (shotBtn && shotIn){
    shotBtn.addEventListener('click', () => shotIn.click());
    shotIn.addEventListener('change', () => { if (shotIn.files && shotIn.files[0]) uploadShot(shotIn.files[0]); });
  }
  $('.lt [data-shotdel]').forEach(b => b.addEventListener('click', () => {
    S.images.splice(+b.dataset.shotdel, 1); renderForm();
  }));
  document.getElementById('ltX').addEventListener('click', close);
  document.getElementById('ltCancel').addEventListener('click', close);
  document.getElementById('ltSave').addEventListener('click', save);
}

function refresh(){
  const d = derive();
  const set = (id, txt, cls) => { const el = document.getElementById(id); if (!el) return;
    el.textContent = txt; if (cls !== undefined) el.className = cls; };
  set('oPnl', d.pnl === null ? '—' : signed(d.pnl), d.pnl > 0 ? 'up' : d.pnl < 0 ? 'dn' : '');
  set('oPts', d.points === null ? '—' : (d.points > 0 ? '+' : '') + d.points.toFixed(2));
  set('oR',   d.rr === null ? '—' : (d.rr >= 0 ? '+' : '−') + Math.abs(d.rr).toFixed(2) + 'R');
  set('oRisk',d.risk === null ? '—' : d.risk.toFixed(2) + ' pts');

  /* show the arithmetic, so a wrong number is obvious rather than mysterious */
  const c = document.getElementById('ltCalc');
  if (c) {
    if (!d.computed) c.textContent = 'Net entered by hand — points and R still derived from your prices.';
    else if (d.points === null) c.textContent = 'Enter an entry and exit to compute.';
    else if (!d.pv) c.textContent = `No point value known for ${S.sym} — enter the net by hand.`;
    else c.textContent = `${d.points.toFixed(2)} pts × $${d.pv} × ${d.qty} contract${d.qty>1?'s':''}`
                       + (d.copies > 1 ? ` × ${d.copies} accounts` : '');
  }
}

/* ---------------------------------------------------------------------------
   SAVE
   ------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
   CHART SCREENSHOT
   Uploads straight to the existing public `trade-images` bucket — the same
   one the old app uses — and stores the public URL in S.images. The upload
   happens on FILE SELECT, not on save, so the URL is already in state by the
   time the row is written. UPLOADING guards save() against the race.
   ------------------------------------------------------------------------- */
const SHOT_MAX  = 5 * 1024 * 1024;                       /* bucket's own limit */
const SHOT_MIME = ['image/png','image/jpeg','image/jpg','image/webp','image/gif'];
let UPLOADING = false;

function shotMsg(t){ const el = document.getElementById('ltShotMsg'); if (el) el.textContent = t || ''; }

async function uploadShot(file){
  if (!SHOT_MIME.includes(file.type)) return shotMsg('PNG, JPEG, WEBP or GIF only');
  if (file.size > SHOT_MAX)           return shotMsg('Too large — 5 MB maximum');

  const c = client();
  const user = await currentUser();
  if (!c || !user) return shotMsg('Signed out');

  UPLOADING = true; shotMsg('Uploading…');
  try{
    /* userId/ prefix: the standard Supabase convention, and what a
       foldername[1] = auth.uid() storage policy expects */
    const ext  = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g,'');
    const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2,7)}.${ext}`;
    const { error } = await c.storage.from('trade-images')
      .upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw new Error(error.message);
    const { data } = c.storage.from('trade-images').getPublicUrl(path);
    if (!data || !data.publicUrl) throw new Error('no public URL returned');
    S.images = [data.publicUrl];        /* one chart per trade, replaces */
    UPLOADING = false;
    renderForm();
  }catch(e){
    UPLOADING = false;
    shotMsg('Upload failed — ' + ((e && e.message) || e));
  }
}

async function save(){
  const err = document.getElementById('ltErr');
  const btn = document.getElementById('ltSave');
  const fail = m => { err.textContent = m; err.classList.add('on'); btn.disabled = false; btn.textContent = 'Save trade'; };

  err.classList.remove('on'); btn.disabled = true; btn.textContent = 'Saving…';

  if (UPLOADING) return fail('The chart is still uploading — one moment.');
  const d = derive();
  if (d.entry === null || d.exit === null) return fail('Entry and exit are required.');
  if (d.pnl === null)                      return fail('Net could not be computed — enter it by hand.');
  if (S.outcome === 'win'  && d.pnl <= 0)  return fail('Marked as a win but the net is not positive.');
  if (S.outcome === 'loss' && d.pnl >= 0)  return fail('Marked as a loss but the net is not negative.');

  const c = client();
  const user = await currentUser();
  if (!c || !user) return fail('You are signed out — sign in again to save.');

  const id = `${Date.now()}.${Math.random().toString().slice(2,6)}`;
  const row = {
    id,
    user_id: user.id,
    trading_day: S.date,
    journal: 'main',
    account_type: S.acct,
    trade_data: {
      id, date: S.date, created_at: new Date().toISOString(),
      sym: S.sym, type: S.side, market: 'Futures',
      qty: d.qty, accounts: d.copies,
      entry: d.entry, exit: d.exit, stop: d.stop,
      points: d.points === null ? null : round2(d.points),
      pnl: round2(d.pnl),
      rr:  d.rr === null ? null : round2(d.rr),
      grade: S.grade || null,
      session: S.session || '',
      /* the field nothing was capturing before */
      model: S.model || '',
      confluences: S.conf.filter(x => x.name && x.name.trim())
                         .map(x => ({ timeframe: x.timeframe, name: x.name.trim() })),
      notes: S.notes || '',
      images: S.images,
      tradingview_link: S.tv || null,
      account_type: S.acct,
    },
  };

  const { error } = await c.from('trades').insert(row);
  if (error) return fail('Could not save: ' + error.message);

  if (isPostable()) askToPost(row);
  else { close(); location.reload(); }
}
const round2 = n => Math.round(n * 100) / 100;

/* ---------------------------------------------------------------------------
   THE WINS CONSENT STEP
   Never posts without being asked. Paper and losses never get here.
   ------------------------------------------------------------------------- */
function askToPost(row){
  const t = row.trade_data;
  document.getElementById('ltIn').innerHTML = `
    <div class="lt-head"><b>Trade saved</b><span>${row.trading_day}</span></div>
    <div class="lt-ask">
      <div class="fig">${signed(t.pnl)}</div>
      <h4>Post this to Trading Ark?</h4>
      <p>It goes in <b>#wins</b> and on the Rewind community feed —
         ${t.sym} ${t.type}${t.model ? ' · ' + t.model : ''}${t.rr !== null ? ' · ' + (t.rr>=0?'+':'−') + Math.abs(t.rr).toFixed(2) + 'R' : ''}.
         Your notes stay private.</p>
      <div class="btns">
        <button class="lt-save" id="ltPost">Post it</button>
        <button class="lt-cancel" id="ltSkip" style="margin-top:0;">Keep it private</button>
      </div>
      <div class="lt-err" id="ltPostErr"></div>
    </div>`;

  document.getElementById('ltSkip').addEventListener('click', () => { close(); location.reload(); });
  document.getElementById('ltPost').addEventListener('click', async () => {
    const b = document.getElementById('ltPost');
    b.disabled = true; b.textContent = 'Posting…';
    try{
      const { data: { session } } = await client().auth.getSession();
      const r = await fetch('/api/wins/post', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + session.access_token },
        body: JSON.stringify({ trade_id: row.id }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'post failed');
      close(); location.reload();
    }catch(e){
      const pe = document.getElementById('ltPostErr');
      pe.textContent = 'Saved, but posting failed: ' + e.message;
      pe.classList.add('on');
      b.disabled = false; b.textContent = 'Try again';
    }
  });
}

/* any page can wire its own button */
export function attachLogButtons(sel = '.btn-w'){
  mount();
  document.querySelectorAll(sel).forEach(b => {
    if (/log trade/i.test(b.textContent)) b.addEventListener('click', openLogTrade);
  });
}
