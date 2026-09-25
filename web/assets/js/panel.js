'use strict';
let user=null, gamenets=[], current=null;
const $ = id => document.getElementById(id);

async function boot(){
  user = await requireAuth();
  if(!user) return;
  $('who').textContent = user.email;
  const d = await API.get('/api/gamenets');
  gamenets = d.gamenets || [];
  if(!gamenets.length){
    $('s-dash').innerHTML = `<div class="card empty">هنوز گیم‌نتی ندارید<br><br>
      <button class="btn btn-primary" onclick="createGamenet()">ساخت گیم‌نت</button></div>`;
    show('dash');
    return;
  }
  const saved = localStorage.getItem('gn_current');
  current = gamenets.find(g=>g.id==saved) || gamenets[0];
  $('g-select').classList.remove('hidden');
  $('gid').innerHTML = gamenets.map(g=>`<option value="${g.id}" ${g.id===current.id?'selected':''}>${esc(g.name)} (#${g.id})</option>`).join('');
  $('gid').onchange = ()=>{ current = gamenets.find(g=>g.id==$('gid').value); localStorage.setItem('gn_current', current.id); refreshAll(); };
  refreshAll();
}
async function refreshAll(){
  await Promise.all([loadDash(), loadSub(), loadTickets(), loadNotif(), loadGamenets(), loadSystems()]);
  initAI();
}
document.querySelectorAll('.side button').forEach(b=>{
  b.onclick = ()=>show(b.dataset.s);
});
function show(s){
  document.querySelectorAll('.side button').forEach(x=>x.classList.toggle('active', x.dataset.s===s));
  document.querySelectorAll('main section').forEach(x=>x.classList.toggle('hidden', x.id!=='s-'+s));
  if(s==='systems') loadSystems().catch(()=>{});
  if(s==='history') loadHistory().catch(()=>{});
  if(s==='pricing') loadPricing().catch(()=>{});
  if(s==='storage') loadStorage().catch(()=>{});
}
async function logout(){ await API.post('/api/auth/logout',{}); location.href='/'; }

async function createGamenet(){
  const name = prompt('نام گیم‌نت:');
  if(!name) return;
  try{
    await API.post('/api/gamenets', { name });
    toast('گیم‌نت ساخته شد');
    location.reload();
  }catch(e){ toast(e.message,'err'); }
}
window.createGamenet = createGamenet;

async function loadGamenets(){
  const d = await API.get('/api/gamenets');
  gamenets = d.gamenets||[];
  $('s-gamenets').innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3>گیم‌نت‌های من</h3>
        <button class="btn btn-primary btn-sm" onclick="createGamenet()">+ گیم‌نت جدید</button>
      </div>
      <div style="overflow:auto;margin-top:10px"><table>
        <tr><th>نام</th><th>اسلاگ</th><th>وضعیت</th><th>نقش</th></tr>
        ${gamenets.map(g=>`<tr><td>${esc(g.name)}</td><td>${esc(g.slug)}</td>
          <td><span class="badge ${g.status==='active'?'badge-green':'badge-red'}">${esc(g.status)}</span></td>
          <td>${esc(g.member_role||'—')}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">ندارید</td></tr>'}
      </table></div>
    </div>`;
}

async function loadDash(){
  if(!current) return;
  try{
    const d = await API.get('/api/gamenets/'+current.id);
    const sub = d.subscription;
    let dataSt = null, stLicensed = true;
    try{ dataSt = await API.get('/api/gamenets/'+current.id+'/play/storage'); }
    catch(e){ if(e.status===403) stLicensed = false; }
    const pct = dataSt ? Math.min(100, Math.round((dataSt.ratio||0)*100)) : 0;
    $('s-dash').innerHTML = `
      <div class="grid g4">
        <div class="stat"><div class="l">وضعیت اشتراک</div><div class="v">${sub?`<span class="badge badge-green">فعال</span>`:`<span class="badge badge-red">غیرفعال</span>`}</div></div>
        <div class="stat"><div class="l">تاریخ انقضا</div><div class="v" style="font-size:16px">${sub?esc(sub.ends_at||'—'):'—'}</div></div>
        <div class="stat"><div class="l">ذخیره‌سازی تنظیمات و فاکتور</div><div class="v" style="font-size:16px">${dataSt ? fmtBytes(dataSt.used_bytes)+' / '+fmtBytes(dataSt.limit_bytes) : (stLicensed?'—':'لایسنس فعال نشده')}</div></div>
        <div class="stat"><div class="l">تیکت‌های باز</div><div class="v">${(d.tickets||[]).filter(t=>t.status!=='resolved'&&t.status!=='closed').length}</div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>💾 ذخیره‌سازی تنظیمات و فاکتورها</h3>
        <div class="muted small">فضای شما صرف ذخیره سیستم‌های بازی، قیمت‌ها، بوفه و فاکتورهای بازی می‌شود (آپلود فایل ندارد).</div>
        ${dataSt ? `
        <div class="progress" style="margin:10px 0"><i style="width:${pct}%"></i></div>
        <div class="muted">${pct}% مصرف — ${fmtBytes(dataSt.used_bytes)} از ${fmtBytes(dataSt.limit_bytes)} · سیستم‌ها: ${dataSt.counts.systems} · تعرفه‌ها: ${dataSt.counts.tariffs} · فاکتورها: ${dataSt.counts.invoices} ${pct>=80?'<span class="badge badge-amber">هشدار</span>':''}</div>
        <div style="margin-top:8px"><button class="btn btn-secondary btn-sm" onclick="show('storage')">جزئیات و فاکتورها</button></div>`
        : `<div class="muted">${stLicensed?'—':'🔒 لایسنس فعال نشده است'}</div>`}
      </div>
      <div id="dash-play"></div>
      <div class="card" style="margin-top:14px">
        <h3>اعلان‌های اخیر</h3>
        ${(d.notifications||[]).slice(0,5).map(n=>`<div class="muted" style="padding:6px 0;border-bottom:1px solid var(--line)">
          <b>${esc(n.title)}</b> — ${esc(n.body)} <span class="small">${esc(n.created_at)}</span></div>`).join('') || '<div class="empty">اعلانی نیست</div>'}
      </div>
      <div class="card" style="margin-top:14px">
        <h3>فعالیت‌های اخیر</h3>
        ${(d.recent_activity||[]).map(a=>`<div class="muted small" style="padding:4px 0">${esc(a.created_at)} · <span class="kbd">${esc(a.action)}</span></div>`).join('')||'<div class="empty">—</div>'}
      </div>`;
    try{
      const p = await API.get('/api/gamenets/'+current.id+'/play/dashboard');
      renderDashPlay(p);
    }catch(e){
      const box = $('dash-play');
      if(box && e.status===403) box.innerHTML = licenseLockCard();
    }
  }catch(e){ $('s-dash').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
}

async function loadSub(){
  if(!current) return;
  try{
    const d = await API.get('/api/subscriptions/gamenets/'+current.id+'/subscription');
    $('s-sub').innerHTML = `
      <div class="card">
        <h3>وضعیت اشتراک و License</h3>
        ${d.subscription ? `
          <div class="pill-row">
            <span class="badge badge-green">${esc(d.subscription.plan_name)}</span>
            <span class="badge badge-blue">تا ${esc(d.subscription.ends_at||'')}</span>
          </div>
          <p class="muted">وضعیت: ${esc(d.subscription.status)}</p>
          <button class="btn btn-secondary btn-sm" onclick="cancelSub()">لغو تمدید خودکار</button>
        ` : `<div class="empty">اشتراک فعالی ندارید — <a href="/plans">خرید اشتراک</a></div>`}
        <h3 style="margin-top:18px">لایسنس‌ها</h3>
        <div style="overflow:auto"><table>
          <tr><th>کلید</th><th>وضعیت</th><th>انقضا</th></tr>
          ${(d.licenses||[]).map(l=>`<tr><td><code>${esc(l.key.slice(0,12))}…${esc(l.key.slice(-4))}</code></td>
            <td><span class="badge ${l.status==='active'?'badge-green':'badge-red'}">${esc(l.status)}</span></td>
            <td>${esc(l.expires_at||'—')}</td></tr>`).join('')||'<tr><td colspan="3" class="empty">ندارد</td></tr>'}
        </table></div>
        <h3 style="margin-top:18px">فاکتورها</h3>
        <div style="overflow:auto"><table>
          <tr><th>شماره</th><th>مبلغ</th><th>تاریخ</th></tr>
          ${(d.invoices||[]).map(i=>`<tr><td>${esc(i.number)}</td><td>${fmtMoney(i.amount_cents)}</td><td>${esc(i.issued_at)}</td></tr>`).join('')||'<tr><td colspan="3" class="empty">ندارد</td></tr>'}
        </table></div>
      </div>`;
  }catch(e){ $('s-sub').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
}
async function cancelSub(){
  if(!confirm('اشتراک لغو شود؟')) return;
  try{ await API.post(`/api/subscriptions/gamenets/${current.id}/subscription/cancel`,{}); toast('لغو شد'); loadSub(); }
  catch(e){ toast(e.message,'err'); }
}



async function loadTickets(){
  try{
    const d = await API.get('/api/tickets');
    $('s-tickets').innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <h3>تیکت‌های من</h3>
          <button class="btn btn-primary btn-sm" onclick="newTicket()">+ تیکت جدید</button>
        </div>
        <div style="overflow:auto;margin-top:10px"><table>
          <tr><th>#</th><th>موضوع</th><th>وضعیت</th><th>اولویت</th><th></th></tr>
          ${(d.tickets||[]).map(t=>`<tr>
            <td>${t.id}</td><td>${esc(t.subject)}</td>
            <td><span class="badge ${t.status==='resolved'?'badge-green':t.status==='waiting_human'?'badge-amber':'badge-blue'}">${esc(t.status)}</span></td>
            <td>${esc(t.priority)}</td>
            <td><button class="btn btn-secondary btn-sm" onclick="openTicket(${t.id})">باز</button></td>
          </tr>`).join('')||'<tr><td colspan="5" class="empty">تیکتی نیست</td></tr>'}
        </table></div>
        <div id="tk-view" style="margin-top:14px"></div>
      </div>`;
  }catch(e){ $('s-tickets').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
}
async function newTicket(){
  const s = prompt('موضوع تیکت:');
  if(!s) return;
  try{
    await API.post('/api/tickets', { subject:s, gamenet_id: current?current.id:null });
    toast('تیکت ساخته شد');
    loadTickets();
  }catch(e){ toast(e.message,'err'); }
}
async function openTicket(id){
  try{
    const d = await API.get('/api/tickets/'+id);
    const t = d.ticket;
    $('tk-view').innerHTML = `
      <div class="card" style="background:#0a1324">
        <h4>تیکت #${t.id} — ${esc(t.subject)}</h4>
        <div class="chat-box" id="cv">${(t.messages||[]).map(m=>`<div class="msg ${esc(m.role)}">${esc(m.content)}</div>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <input id="rp" placeholder="پیام…">
          <button class="btn btn-primary btn-sm" onclick="replyTk(${t.id})">ارسال</button>
          <button class="btn btn-secondary btn-sm" onclick="escTk(${t.id})">انتقال به انسان</button>
        </div>
      </div>`;
    const cv=$('cv'); cv.scrollTop=cv.scrollHeight;
  }catch(e){ toast(e.message,'err'); }
}
async function replyTk(id){
  const c=$('rp').value.trim(); if(!c) return;
  try{ await API.post(`/api/tickets/${id}/reply`,{content:c}); openTicket(id); }
  catch(e){ toast(e.message,'err'); }
}
async function escTk(id){
  try{ await API.post(`/api/tickets/${id}/escalate`,{}); toast('به پشتیبان منتقل شد'); openTicket(id); loadTickets(); }
  catch(e){ toast(e.message,'err'); }
}
window.newTicket=newTicket; window.openTicket=openTicket; window.replyTk=replyTk; window.escTk=escTk;

let aiInited=false, aiTicket=null;
function initAI(){
  if(aiInited) return; aiInited=true;
  $('s-ai').innerHTML = `
    <div class="card">
      <h3>🤖 پشتیبان هوش مصنوعی</h3>
      <p class="muted">AI فقط به داده‌های همین گیم‌نت و همین حساب دسترسی دارد (Tool Layer امن).</p>
      <div class="chat-box" id="aibox"><div class="msg system">سلام! درباره اشتراک، لایسنس، فضا یا تیکت بپرس.</div></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <input id="aiin" placeholder="پیام خود را بنویسید…" onkeydown="if(event.key==='Enter')sendAI()">
        <button class="btn btn-primary btn-sm" onclick="sendAI()">ارسال</button>
      </div>
      <div class="pill-row">
        <button class="btn btn-ghost btn-sm" onclick="quickAI('وضعیت اشتراک من چیست؟')">وضعیت اشتراک</button>
        <button class="btn btn-ghost btn-sm" onclick="quickAI('لایسنس من چطور است؟')">لایسنس</button>
        <button class="btn btn-ghost btn-sm" onclick="quickAI('فضای ذخیره‌سازی؟')">فضا</button>
        <button class="btn btn-ghost btn-sm" onclick="quickAI('به انسان وصل کن')">اتصال به انسان</button>
      </div>
    </div>`;
}
async function sendAI(){
  const inp=$('aiin'); const msg=inp.value.trim(); if(!msg) return;
  inp.value='';
  const box=$('aibox');
  box.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(msg)}</div>`);
  box.scrollTop=box.scrollHeight;
  try{
    const r = await API.post('/api/ai/chat', {
      message: msg,
      gamenet_id: current?current.id:null,
      ticket_id: aiTicket,
    });
    if(r.ticket_id) aiTicket = r.ticket_id;
    box.insertAdjacentHTML('beforeend', `<div class="msg assistant">${esc(r.reply)}</div>`);
    box.scrollTop=box.scrollHeight;
  }catch(e){
    box.insertAdjacentHTML('beforeend', `<div class="msg system">${esc(e.message)}</div>`);
  }
}
function quickAI(m){ $('aiin').value=m; sendAI(); }
window.sendAI=sendAI; window.quickAI=quickAI;

async function loadNotif(){
  try{
    const d = await API.get('/api/notifications');
    $('s-notif').innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>اعلان‌ها</h3>
          <button class="btn btn-secondary btn-sm" onclick="readAll()">خواندن همه</button>
        </div>
        <div style="margin-top:10px">
        ${(d.notifications||[]).map(n=>`
          <div style="padding:10px;border-bottom:1px solid var(--line);${n.read_at?'opacity:.6':''}">
            <b>${esc(n.title)}</b> <span class="badge badge-blue">${esc(n.type)}</span>
            <div class="muted small">${esc(n.body)}</div>
            <div class="small muted">${esc(n.created_at)}</div>
          </div>`).join('')||'<div class="empty">اعلانی نیست</div>'}
        </div>
      </div>`;
  }catch(e){ $('s-notif').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
}
async function readAll(){ await API.post('/api/notifications/read-all',{}); loadNotif(); }
window.readAll=readAll;
window.cancelSub=cancelSub;

/* ═══════════════════════════════════════════════════════════════════
   PLAY SESSIONS — live systems, timestamp timers, history, tariffs, buffet
   All authoritative time/cost math happens on the server; the UI only
   renders server timestamps + the SAME integer formula for live preview.
   ═══════════════════════════════════════════════════════════════════ */
let live = null, serverSkew = 0, lastReceipt = null, histSearched = false;
const lf = { q:'', status:'', type:'', sort:'number' };
const SYS_META = {
  available:  { label:'آزاد',        dot:'🟢', badge:'badge-green'  },
  in_use:     { label:'در حال بازی', dot:'🔵', badge:'badge-blue'   },
  reserved:   { label:'رزرو شده',    dot:'🟡', badge:'badge-amber'  },
  paused:     { label:'متوقف موقت',  dot:'🟠', badge:'badge-amber'  },
  maintenance:{ label:'در تعمیر',    dot:'🔧', badge:'badge-purple' },
  broken:     { label:'خراب',        dot:'🔴', badge:'badge-red'    },
  disabled:   { label:'غیرفعال',     dot:'⚫', badge:''             },
};
const TYPE_LABEL = { pc:'PC', console:'کنسول', playstation:'PlayStation', xbox:'Xbox', vip:'VIP', other:'سایر' };
const SES_META = { active:'در حال بازی', paused:'متوقف', stopped:'پایان‌یافته', canceled:'لغو شده' };
const isOwner = () => !current || current.member_role !== 'staff';
function hmsUI(sec){
  sec = Math.max(0, Math.floor(Number(sec)||0));
  return String(Math.floor(sec/3600)).padStart(2,'0')+':'+String(Math.floor((sec%3600)/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');
}
function fmtTimeMs(ms){ return ms ? new Date(ms).toLocaleString('fa-IR',{ month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }) : '—'; }
function fmtClockMs(ms){ return ms ? new Date(ms).toLocaleTimeString('fa-IR',{ hour12:false }) : '—'; }

async function loadSystems(){
  if(!current) return;
  try{
    const d = await API.get('/api/gamenets/'+current.id+'/play/live');
    live = d;
    serverSkew = (d.server_now||Date.now()) - Date.now();
    const active = document.activeElement;
    const typing = active && $('s-systems').contains(active) && ['INPUT','SELECT','TEXTAREA'].includes(active.tagName);
    if(!typing) renderSystems();
    else tickTimers();
  }catch(e){
    if(e.status===403){ live=null; $('s-systems').innerHTML = licenseLockCard(); return; }
    if(!live) $('s-systems').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

function filteredSystems(){
  if(!live) return [];
  let arr = (live.systems||[]).slice();
  if(lf.q){ const q = lf.q.toLowerCase(); arr = arr.filter(s => (s.number+' '+s.name).toLowerCase().includes(q)); }
  if(lf.status) arr = arr.filter(s => s.status === lf.status);
  if(lf.type) arr = arr.filter(s => s.type === lf.type);
  const statusOrder = { in_use:0, paused:1, reserved:2, available:3, maintenance:4, broken:5, disabled:6 };
  if(lf.sort === 'status') arr.sort((a,b)=> (statusOrder[a.status]??9) - (statusOrder[b.status]??9) || a.number.localeCompare(b.number));
  else if(lf.sort === 'cost') arr.sort((a,b)=> (b.open_session?b.open_session.total_cents:-1) - (a.open_session?a.open_session.total_cents:-1));
  else arr.sort((a,b)=> a.number.localeCompare(b.number, undefined, { numeric:true }));
  return arr;
}

function renderSystems(){
  if(!live){ $('s-systems').innerHTML = '<div class="empty">در حال بارگذاری…</div>'; return; }
  const owner = isOwner();
  const list = filteredSystems();
  const sysCount = (live.systems||[]).length;
  let html = '';

  if(lastReceipt){
    const r = lastReceipt;
    html += `<div class="card" style="border-color:rgba(52,211,153,.5);margin-bottom:12px">
      <div class="pay-head"><h3 style="color:#10b981">🧾 رسید پایان بازی — ${esc(r.public_id)}</h3>
        <button class="btn btn-ghost btn-sm" onclick="clearReceipt()">بستن</button></div>
      <div class="grid g2" style="gap:6px;margin-top:6px">
        <div class="muted">سیستم: <b>${esc(r.system_number)}</b> · شروع: <b>${esc(fmtClockMs(Date.parse(r.started_at.replace(' ','T')+'Z')))}</b> · پایان: <b>${esc(fmtClockMs(Date.parse(r.ended_at.replace(' ','T')+'Z')))}</b></div>
        <div class="muted">مدت: <b>${hmsUI(r.duration_sec)}</b> · تعرفه: <b>${esc(r.tariff_name||'—')}</b></div>
      </div>
      <div style="overflow:auto;margin-top:8px"><table>
        <tr><th>شرح</th><th>مبلغ</th></tr>
        <tr><td>هزینه بازی (${hmsUI(r.duration_sec)} × ${fmtMoney(r.rate_per_hour)}/ساعت)</td><td>${fmtMoney(r.game_cents)}</td></tr>
        ${(r.lines||[]).map(l=>`<tr><td>${esc(l.name)} × ${l.qty}</td><td>${fmtMoney(l.total)}</td></tr>`).join('')}
        <tr><th>جمع کل</th><th>${fmtMoney(r.total_cents)}</th></tr>
      </table></div>
    </div>`;
  }

  html += `<div class="card" style="margin-bottom:12px">
    <div class="pay-head">
      <h3>🟢 Live Sessions — سیستم‌های ${esc(current?current.name:'')}</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="loadSystems()">🔄 بروزرسانی</button>
        ${owner?'<button class="btn btn-primary btn-sm" onclick="toggleAddSys()">+ افزودن سیستم</button>':''}
      </div>
    </div>
    ${live.has_tariff?'':'<div class="alert alert-info">هنوز تعریفی برای «تعرفه» ندارید — <a href="#" onclick="show(\'pricing\');return false">تعرفه و بوفه</a> را باز کنید و تعرفه بسازید تا امکان شروع بازی فعال شود.</div>'}
    <div id="add-sys-box" class="hidden" style="margin-top:10px;border:1px solid var(--line);border-radius:12px;padding:12px">
      <div class="grid g3" style="gap:10px">
        <div><label>شماره سیستم</label><input id="ns-num" dir="ltr" placeholder="PC-07" style="text-align:left"></div>
        <div><label>نام (اختیاری)</label><input id="ns-name" placeholder="کنار پنجره"></div>
        <div><label>نوع سیستم</label><select id="ns-type">${Object.entries(TYPE_LABEL).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="createSystem()">ثبت سیستم</button>
    </div>
    <div class="grid g3" style="margin-top:12px;gap:8px">
      <input id="lf-q" placeholder="جستجو: شماره یا نام…" value="${esc(lf.q)}" oninput="lf.q=this.value;refilter()">
      <select onchange="lf.status=this.value;refilter()">
        <option value="">همه وضعیت‌ها</option>
        ${Object.entries(SYS_META).map(([k,v])=>`<option value="${k}" ${lf.status===k?'selected':''}>${v.dot} ${v.label}</option>`).join('')}
      </select>
      <div style="display:flex;gap:8px">
        <select onchange="lf.type=this.value;refilter()" style="flex:1">
          <option value="">همه انواع</option>
          ${Object.entries(TYPE_LABEL).map(([k,v])=>`<option value="${k}" ${lf.type===k?'selected':''}>${v}</option>`).join('')}
        </select>
        <select onchange="lf.sort=this.value;refilter()" style="flex:1">
          <option value="number" ${lf.sort==='number'?'selected':''}>مرتب: شماره</option>
          <option value="status" ${lf.sort==='status'?'selected':''}>مرتب: وضعیت</option>
          <option value="cost" ${lf.sort==='cost'?'selected':''}>مرتب: هزینه</option>
        </select>
      </div>
    </div>
    <div class="muted small" id="sys-count" style="margin-top:8px">${list.length} از ${sysCount} سیستم</div>
  </div>
  <div class="grid g3" id="sys-grid" style="gap:12px"></div>`;

  $('s-systems').innerHTML = html;
  paintGrid();
}

/** Re-paint only the cards grid (keeps toolbar DOM + focus intact). */
function refilter(){ if(live) paintGrid(); }
function paintGrid(){
  const grid = $('sys-grid'); if(!grid || !live) return;
  const owner = isOwner();
  const list = filteredSystems();
  const sysCount = (live.systems||[]).length;
  const count = $('sys-count');
  if(count) count.textContent = `${list.length} از ${sysCount} سیستم`;
  grid.innerHTML = list.length
    ? list.map(s=>sysCard(s, owner)).join('')
    : `<div class="card empty">${sysCount ? 'سیستمی با این فیلتر یافت نشد' : 'هنوز سیستمی ثبت نشده — از «+ افزودن سیستم» شروع کنید'}</div>`;
  tickTimers();
}

function sysCard(s, owner){
  const meta = SYS_META[s.status] || SYS_META.available;
  const ses = s.open_session;
  let html = `<div class="card" style="border-color:${s.status==='in_use'?'rgba(56,189,248,.45)':s.status==='paused'?'rgba(251,191,36,.45)':s.status==='broken'?'rgba(251,113,133,.45)':'var(--line)'}">
    <div class="pay-head">
      <div>
        <b style="font-size:17px" dir="ltr">${esc(s.number)}</b>
        <span class="badge badge-purple">${esc(TYPE_LABEL[s.type]||s.type)}</span>
        ${s.name?`<div class="muted small">${esc(s.name)}</div>`:''}
      </div>
      <span class="badge ${meta.badge}">${meta.dot} ${meta.label}</span>
    </div>`;

  if(ses){
    html += `
    <div class="grid g2" style="gap:8px;margin-top:10px">
      <div class="stat"><div class="l">زمان شروع بازی</div><div class="v" style="font-size:14px" dir="ltr">${esc(fmtClockMs(ses.started_at_ms))}</div></div>
      <div class="stat"><div class="l">تعرفه فعلی</div><div class="v" style="font-size:14px">${fmtMoney(ses.rate_per_hour)}/ساعت</div>
        <div class="muted small">${esc(ses.tariff_name||'—')}</div></div>
    </div>
    <div class="timer card" style="margin-top:8px;padding:12px;text-align:center;background:#0a1324"
         data-start="${ses.started_at_ms||0}" data-paused="${ses.paused_total_sec||0}"
         data-pstatus="${ses.status}" data-pat="${ses.paused_at_ms||0}"
         data-rate="${ses.rate_per_hour||0}" data-buffet="${ses.buffet_cost_cents||0}">
      <div class="muted small">مدت زمان سپری‌شده (HH:MM:SS)</div>
      <div class="v" data-f="elapsed" style="font-size:30px;font-weight:900;letter-spacing:2px" dir="ltr">00:00:00</div>
      <div class="grid g2" style="gap:8px;margin-top:8px;text-align:right">
        <div class="stat"><div class="l">هزینه لحظه‌ای بازی</div><div class="v" data-f="cost" style="font-size:17px">0</div></div>
        <div class="stat"><div class="l">مبلغ نهایی هنگام پایان (بازی + بوفه)</div><div class="v" data-f="total" style="font-size:17px">0</div></div>
      </div>
      ${ses.status==='paused'?'<div class="alert alert-info" style="margin:8px 0 0">⏸ سشن متوقف است — زمان و هزینه محاسبه نمی‌شود</div>':''}
    </div>
    <div class="muted small" style="margin-top:6px">شروع‌کننده: ${esc(ses.started_by_name||'—')} · <span dir="ltr">${esc(ses.public_id)}</span></div>`;

    if((ses.lines||[]).length){
      html += `<div style="margin-top:8px">${ses.lines.map(l=>`
        <div class="pay-head" style="padding:4px 0;border-bottom:1px dashed var(--line)">
          <span class="muted small">${esc(l.item_name)} × ${l.qty} — ${fmtMoney(l.line_total_cents)}</span>
          <button class="btn btn-ghost btn-sm" onclick="delLine(${ses.id},${l.id})" title="حذف سفارش">✕</button>
        </div>`).join('')}</div>`;
    }

    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      ${ses.status==='active'?`<button class="btn btn-secondary btn-sm" onclick="pauseS(${ses.id})">⏸ توقف موقت</button>`:''}
      ${ses.status==='paused'?`<button class="btn btn-primary btn-sm" onclick="resumeS(${ses.id})">▶ ادامه</button>`:''}
      <button class="btn btn-danger btn-sm" onclick="stopS(${ses.id})">■ پایان بازی</button>
    </div>
    <div style="display:flex;gap:6px;margin-top:8px">
      <select id="bf-${ses.id}" style="flex:1;min-width:0">
        ${live.buffet.map(b=>`<option value="${b.id}">${esc(b.name)} — ${fmtMoney(b.price_cents)}${b.stock!=null?` (${b.stock})`:''}</option>`).join('') || '<option value="">بوفه خالی است</option>'}
      </select>
      <input id="bq-${ses.id}" type="number" min="1" max="99" value="1" style="width:64px;flex:none" dir="ltr">
      <button class="btn btn-primary btn-sm" onclick="addBuffet(${ses.id})" ${(live.buffet||[]).length?'':'disabled'}>افزودن سفارش</button>
    </div>`;
  } else {
    html += `<div class="muted small" style="margin-top:10px">شروع بازی: — · مدت: 00:00:00 · تعرفه: — · هزینه: 0</div>`;
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      ${['available','reserved'].includes(s.status)
        ? `<button class="btn btn-primary btn-sm" onclick="startSys(${s.id})">▶ شروع بازی</button>`
        : `<span class="muted small">با وضعیت فعلی قابل شروع نیست</span>`}
    </div>`;
  }

  if(owner && !ses){
    html += `<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
      <select style="flex:1;min-width:120px" onchange="setSysStatus(${s.id}, this.value)" title="تغییر وضعیت دستی">
        ${['available','reserved','maintenance','broken','disabled'].map(k=>`<option value="${k}" ${s.db_status===k?'selected':''}>${SYS_META[k].dot} ${SYS_META[k].label}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" onclick="editSys(${s.id})">✏︎</button>
      <button class="btn btn-ghost btn-sm" onclick="delSys(${s.id})">🗑</button>
    </div>`;
  }
  return html + '</div>';
}

/* — session actions (server-authoritative) — */
async function startSys(id){
  try{
    const r = await API.post(`/api/gamenets/${current.id}/play/systems/${id}/start`, {});
    toast('بازی شروع شد — ' + r.session.hms);
    await loadSystems();
  }catch(e){ toast(e.message,'err'); }
}
async function pauseS(id){
  try{ await API.post(`/api/gamenets/${current.id}/play/sessions/${id}/pause`, {}); toast('متوقف شد'); await loadSystems(); }
  catch(e){ toast(e.message,'err'); }
}
async function resumeS(id){
  try{ await API.post(`/api/gamenets/${current.id}/play/sessions/${id}/resume`, {}); toast('ادامه یافت'); await loadSystems(); }
  catch(e){ toast(e.message,'err'); }
}
async function stopS(id){
  if(!confirm('بازی پایان یابد؟ مبلغ نهایی محاسبه و ثبت می‌شود.')) return;
  try{
    const r = await API.post(`/api/gamenets/${current.id}/play/sessions/${id}/stop`, {});
    lastReceipt = r.receipt;
    toast(`پایان بازی — جمع کل: ${fmtMoney(r.receipt.total_cents)}`);
    await loadSystems();
    loadDash().catch(()=>{});
  }catch(e){ toast(e.message,'err'); }
}
function clearReceipt(){ lastReceipt = null; renderSystems(); }
async function addBuffet(sid){
  const itemId = Number((document.getElementById('bf-'+sid)||{}).value);
  const qty = Number((document.getElementById('bq-'+sid)||{}).value)||1;
  if(!itemId) return toast('آیتمی انتخاب نکرده‌اید','err');
  try{
    await API.post(`/api/gamenets/${current.id}/play/sessions/${sid}/buffet`, { item_id: itemId, qty });
    toast('سفارش ثبت شد'); await loadSystems();
  }catch(e){ toast(e.message,'err'); }
}
async function delLine(sid, lineId){
  if(!confirm('سفارش حذف شود؟')) return;
  try{ await API.del(`/api/gamenets/${current.id}/play/sessions/${sid}/buffet/${lineId}`); await loadSystems(); }
  catch(e){ toast(e.message,'err'); }
}
function toggleAddSys(){ const b=$('add-sys-box'); if(b) b.classList.toggle('hidden'); }
async function createSystem(){
  try{
    await API.post(`/api/gamenets/${current.id}/play/systems`, {
      number: $('ns-num').value, name: $('ns-name').value, type: $('ns-type').value,
    });
    toast('سیستم افزوده شد'); $('ns-num').value=''; $('ns-name').value='';
    await loadSystems();
  }catch(e){ toast(e.message,'err'); }
}
async function editSys(id){
  const s = (live.systems||[]).find(x=>x.id===id); if(!s) return;
  const name = prompt('نام سیستم:', s.name); if(name===null) return;
  try{ await API.put(`/api/gamenets/${current.id}/play/systems/${id}`, { name }); toast('بروزرسانی شد'); await loadSystems(); }
  catch(e){ toast(e.message,'err'); }
}
async function setSysStatus(id, status){
  try{ await API.request(`/api/gamenets/${current.id}/play/systems/${id}`, { method:'PATCH', body:{ status } }); toast('وضعیت تغییر کرد'); await loadSystems(); }
  catch(e){ toast(e.message,'err'); loadSystems(); }
}
async function delSys(id){
  if(!confirm('سیستم حذف شود؟ (فقط اگر تاریخچه نداشته باشد)')) return;
  try{ await API.del(`/api/gamenets/${current.id}/play/systems/${id}`); toast('حذف شد'); await loadSystems(); }
  catch(e){ toast(e.message,'err'); }
}

/* — live tick: 1 Hz, driven by server timestamps (+ measured skew) — */
function tickTimers(){
  if(!live) return;
  const now = Date.now() + serverSkew;
  document.querySelectorAll('#s-systems .timer').forEach(el=>{
    const d = el.dataset;
    let sec;
    if(d.pstatus === 'paused') sec = Math.max(0, Math.floor(((Number(d.pat)||0) - Number(d.start))/1000) - Number(d.paused||0));
    else sec = Math.max(0, Math.floor((now - Number(d.start))/1000) - Number(d.paused||0));
    const cost = Math.floor(Number(d.rate||0) * sec / 3600); // same integer formula as server
    const q = f => el.querySelector(`[data-f="${f}"]`);
    if(q('elapsed')) q('elapsed').textContent = hmsUI(sec);
    if(q('cost')) q('cost').textContent = fmtMoney(cost);
    if(q('total')) q('total').textContent = fmtMoney(cost + Number(d.buffet||0));
  });
}
setInterval(tickTimers, 1000);
// silent live-poll while the systems tab is open (offline → next fetch resyncs from server)
setInterval(()=>{ if(current && $('s-systems') && !$('s-systems').classList.contains('hidden')) loadSystems().catch(()=>{}); }, 8000);

/* — dashboard play stats — */
function renderDashPlay(p){
  const box = $('dash-play'); if(!box) return;
  if(!p.systems_total){
    box.innerHTML = `<div class="card"><h3>🎮 سیستم‌های بازی</h3>
      <p class="muted">هنوز سیستمی ثبت نکرده‌اید. از بخش «سیستم‌ها (زنده)» سیستم‌ها را اضافه و از «تعرفه و بوفه» تعرفه تعریف کنید.</p>
      <button class="btn btn-primary btn-sm" onclick="show('systems')">شروع کنید</button></div>`;
    return;
  }
  box.innerHTML = `
    <div class="grid g4" style="margin-top:14px">
      <div class="stat"><div class="l">سیستم‌های فعال</div><div class="v">${p.systems_active} <span class="muted small">/ ${p.systems_total}</span></div></div>
      <div class="stat"><div class="l">در حال بازی</div><div class="v" style="color:#7dd3fc">${p.systems_in_use} 🔵</div></div>
      <div class="stat"><div class="l">آزاد</div><div class="v" style="color:#6ee7b7">${p.systems_available} 🟢</div></div>
      <div class="stat"><div class="l">سشن‌های امروز</div><div class="v">${p.sessions_today}</div></div>
    </div>
    <div class="grid g4" style="margin-top:10px">
      <div class="stat"><div class="l">مجموع زمان بازی امروز</div><div class="v" dir="ltr" style="font-size:19px">${hmsUI(p.play_time_today_sec)}</div></div>
      <div class="stat"><div class="l">درآمد بازی امروز</div><div class="v" style="font-size:17px;color:#6ee7b7">${fmtMoney(p.game_revenue_today)}</div></div>
      <div class="stat"><div class="l">درآمد بوفه امروز</div><div class="v" style="font-size:17px">${fmtMoney(p.buffet_revenue_today)}</div></div>
      <div class="stat"><div class="l">درآمد کل امروز</div><div class="v" style="font-size:17px;color:#fcd34d">${fmtMoney(p.total_revenue_today)}</div></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>درآمد هر سیستم (امروز)</h3>
      <div style="overflow:auto"><table>
        <tr><th>سیستم</th><th>سشن</th><th>زمان بازی</th><th>بازی</th><th>بوفه</th><th>جمع</th></tr>
        ${p.per_system.map(r=>`<tr><td dir="ltr">${esc(r.system_number)}</td><td>${r.sessions}</td>
          <td dir="ltr">${hmsUI(r.play_sec)}</td><td>${fmtMoney(r.game_cents)}</td>
          <td>${fmtMoney(r.buffet_cents)}</td><th>${fmtMoney(r.total_cents)}</th></tr>`).join('')
          ||'<tr><td colspan="6" class="empty">امروز سشنی ثبت نشده</td></tr>'}
      </table></div>
      ${p.top_systems.length?`<h3 style="margin-top:16px">🏆 پرفروش‌ترین سیستم‌ها (امروز)</h3>
      <div>${p.top_systems.map((r,i)=>`<div class="pay-head" style="padding:6px 0;border-bottom:1px solid var(--line)">
        <span>${['🥇','🥈','🥉'][i]||'▫️'} <b dir="ltr">${esc(r.system_number)}</b> <span class="muted small">${r.sessions} سشن</span></span>
        <b>${fmtMoney(r.total_cents)}</b></div>`).join('')}</div>`:''}
    </div>`;
}

/* — license gate (shared lock card) — */
function licenseLockCard(){
  return `<div class="card" style="text-align:center;border-color:rgba(251,191,36,.5)">
    <div style="font-size:42px">🔒</div>
    <h3>لایسنس فعال نشده</h3>
    <p class="muted">تا <b>لایسنس گیم‌نت</b> شما فعال نشود، استفاده از سیستم بازی، تعرفه‌ها، بوفه و فاکتورها امکان‌پذیر نیست.</p>
    <p class="muted small">لایسنس با خرید اشتراک یا با «ایونت لایسنس» رایگان از طرف مدیر سایت فعال می‌شود.</p>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px">
      <button class="btn btn-primary btn-sm" onclick="show('sub')">اشتراک و لایسنس</button>
      <button class="btn btn-ghost btn-sm" onclick="show('dash')">بازگشت به داشبورد</button>
    </div>
  </div>`;
}

/* — repurposed storage: settings + game invoices (no file uploads) — */
async function loadStorage(){
  if(!current) return;
  try{
    const d = await API.get('/api/gamenets/'+current.id+'/play/storage');
    const pct = Math.min(100, Math.round((d.ratio||0)*100));
    const inv = (d.invoices||[]);
    $('s-storage').innerHTML = `
      <div class="card">
        <h3>💾 ذخیره‌سازی تنظیمات و فاکتورها</h3>
        <div class="alert alert-info">فضای اختصاص‌یافته شما صرف ذخیره‌ی <b>تنظیمات پنل</b> می‌شود: سیستم‌های بازی که اضافه می‌کنید، قیمت‌ها و تعرفه‌ها، آیتم‌های بوفه و <b>فاکتورهای بازی</b> — نه آپلود فایل.</div>
        <div class="progress" style="margin:10px 0"><i style="width:${pct}%"></i></div>
        <div class="muted">${pct}% مصرف — ${fmtBytes(d.used_bytes)} از ${fmtBytes(d.limit_bytes)}</div>
        <div class="grid g4" style="margin-top:12px">
          <div class="stat"><div class="l">سیستم‌های بازی</div><div class="v">${d.counts.systems}</div></div>
          <div class="stat"><div class="l">تعرفه‌ها</div><div class="v">${d.counts.tariffs}</div></div>
          <div class="stat"><div class="l">آیتم‌های بوفه</div><div class="v">${d.counts.buffet_items}</div></div>
          <div class="stat"><div class="l">فاکتورهای بازی</div><div class="v">${d.counts.invoices}</div></div>
        </div>
        <div class="grid g4" style="margin-top:10px">
          <div class="stat"><div class="l">سشن‌های ذخیره‌شده</div><div class="v">${d.counts.sessions}</div></div>
          <div class="stat"><div class="l">سفارش‌های بوفه</div><div class="v">${d.counts.buffet_lines}</div></div>
          <div class="stat"><div class="l">رکوردهای Audit</div><div class="v">${d.counts.audit}</div></div>
          <div class="stat"><div class="l">حجم کل داده‌ها</div><div class="v" style="font-size:17px">${fmtBytes(d.used_bytes)}</div></div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="pay-head">
          <h3>🧾 فاکتورهای ذخیره‌شده بازی</h3>
          <span class="muted small">${inv.length} فاکتور اخیر</span>
        </div>
        <div style="overflow:auto;margin-top:8px"><table>
          <tr><th>شماره فاکتور</th><th>سیستم</th><th>تاریخ</th><th>مدت</th><th>هزینه بازی</th><th>بوفه</th><th>جمع</th></tr>
          ${inv.map(i=>`<tr>
            <td dir="ltr">${esc(i.public_id||('F-'+i.id))}</td>
            <td dir="ltr"><b>${esc(i.system_number||'—')}</b></td>
            <td class="small">${esc(i.sold_date||'—')}</td>
            <td dir="ltr">${hmsUI(i.duration_sec||0)}</td>
            <td>${fmtMoney(i.game_cents)}</td>
            <td>${fmtMoney(i.buffet_cents)}</td>
            <th>${fmtMoney(i.total_cents)}</th>
          </tr>`).join('') || '<tr><td colspan="7" class="empty">هنوز فاکتوری ثبت نشده</td></tr>'}
        </table></div>
      </div>`;
  }catch(e){
    $('s-storage').innerHTML = e.status===403
      ? licenseLockCard()
      : `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

/* — session history — */
async function loadHistory(){
  if(!current) return;
  if(histSearched){ return searchHistory(); }
  $('s-history').innerHTML = `<div class="card">
    <h3>تاریخچه Sessionها</h3>
    <div class="grid g4" style="gap:8px;margin-top:8px">
      <div><label>از تاریخ</label><input type="date" id="h-from"></div>
      <div><label>تا تاریخ</label><input type="date" id="h-to"></div>
      <div><label>سیستم</label><input id="h-sys" placeholder="PC-07 یا نام" dir="ltr" style="text-align:left"></div>
      <div><label>وضعیت</label><select id="h-st">
        <option value="">همه</option><option value="stopped">پایان‌یافته</option>
        <option value="active">در حال بازی</option><option value="paused">متوقف</option><option value="canceled">لغو شده</option>
      </select></div>
    </div>
    <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="searchHistory()">جستجو</button>
    <div id="hist-rows" style="margin-top:12px"><div class="empty">در حال بارگذاری…</div></div>
  </div>`;
  searchHistory().catch(()=>{});
}
async function searchHistory(){
  if(!current) return;
  try{
    const q = new URLSearchParams();
    const f = $('h-from'), t = $('h-to'), s = $('h-sys'), st = $('h-st');
    if(f && f.value) q.set('from', f.value);
    if(t && t.value) q.set('to', t.value);
    if(s && s.value.trim()) q.set('system', s.value.trim());
    if(st && st.value) q.set('status', st.value);
    const d = await API.get('/api/gamenets/'+current.id+'/play/sessions?'+q.toString());
    histSearched = true;
    const rows = d.sessions.map(ses=>`<tr>
      <td dir="ltr">${esc(ses.public_id)}</td>
      <td dir="ltr"><b>${esc(ses.system_number)}</b></td>
      <td class="small">${esc(fmtTimeMs(ses.started_at_ms))}</td>
      <td class="small">${ses.ended_at?esc(fmtTimeMs(Date.parse(ses.ended_at.replace(' ','T')+'Z'))):'—'}</td>
      <td dir="ltr">${hmsUI(ses.duration_sec || ses.elapsed_sec)}</td>
      <td class="small">${esc(ses.started_by_name||'—')}${ses.ended_by_name?` ← ${esc(ses.ended_by_name)}`:''}</td>
      <td><span class="badge ${ses.status==='stopped'?'badge-green':ses.status==='canceled'?'badge-red':'badge-blue'}">${SES_META[ses.status]||ses.status}</span></td>
      <td>${fmtMoney(ses.game_cost_cents)}</td>
      <td>${fmtMoney(ses.buffet_cost_cents)}</td>
      <th>${fmtMoney(ses.total_cents)}</th>
    </tr>`).join('');
    $('hist-rows').innerHTML = `<div class="muted small" style="margin-bottom:6px">${d.total} سشن${d.total>200?' (۲۰۰ مورد آخر)':''}</div>
      <div style="overflow:auto"><table>
        <tr><th>شماره سشن</th><th>سیستم</th><th>شروع</th><th>پایان</th><th>مدت</th><th>کاربر</th><th>وضعیت</th><th>بازی</th><th>بوفه</th><th>جمع</th></tr>
        ${rows || '<tr><td colspan="10" class="empty">سشنی یافت نشد</td></tr>'}
      </table></div>`;
  }catch(e){
    if(e.status===403){ $('s-history').innerHTML = licenseLockCard(); return; }
    toast(e.message,'err');
  }
}

/* — tariffs, holidays, buffet catalog — */
async function loadPricing(){
  if(!current) return;
  const owner = isOwner();
  if(!owner){ $('s-pricing').innerHTML = '<div class="card empty">مدیریت تعرفه و بوفه فقط برای مالک گیم‌نت است.</div>'; return; }
  try{
    const [tp, bf] = await Promise.all([
      API.get('/api/gamenets/'+current.id+'/play/tariffs'),
      API.get('/api/gamenets/'+current.id+'/play/buffet'),
    ]);
    const dowLabel = d => d==null ? 'هر روز' : ['یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه','شنبه'][d];
    const mToTime = m => m==null ? '—' : String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
    $('s-pricing').innerHTML = `
    <div class="card">
      <div class="pay-head"><h3>💰 تعرفه‌ها (نرخ هر ساعت)</h3>
        <button class="btn btn-secondary btn-sm" onclick="createSamples()">ایجاد تعرفه‌های نمونه</button></div>
      <div class="muted small">تعرفه با بیشترین اولویت که با نوع سیستم، روز و بازه زمانی «الان» همخوانی داشته باشد انتخاب می‌شود. بازه‌های شب (مثلاً ۲۲ تا ۰۲) هم پشتیبانی می‌شود.</div>
      <div style="overflow:auto;margin-top:10px"><table>
        <tr><th>نام</th><th>نوع</th><th>روز</th><th>بزه</th><th>تعطیلی</th><th>نرخ/ساعت</th><th>اولویت</th><th></th></tr>
        ${tp.tariffs.map(t=>`<tr>
          <td>${esc(t.name)}</td>
          <td>${t.system_type?esc(TYPE_LABEL[t.system_type]||t.system_type):'همه'}</td>
          <td>${dowLabel(t.day_of_week)}</td>
          <td dir="ltr">${mToTime(t.start_minute)} – ${mToTime(t.end_minute)}</td>
          <td>${t.is_holiday?'🟢 بله':'—'}</td>
          <th>${fmtMoney(t.rate_per_hour)}</th>
          <td>${t.priority}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="delTariff(${t.id})">🗑</button></td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">تعرفه‌ای ثبت نشده</td></tr>'}
      </table></div>
      <div style="border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:12px">
        <b>افزودن تعرفه</b>
        <div class="grid g4" style="gap:8px;margin-top:6px">
          <div><label>نام</label><input id="t-name" placeholder="عصرگاهی"></div>
          <div><label>نوع سیستم</label><select id="t-type"><option value="">همه</option>${Object.entries(TYPE_LABEL).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
          <div><label>روز هفته</label><select id="t-day"><option value="">هر روز</option>${['یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه','شنبه'].map((n,i)=>`<option value="${i}">${n}</option>`).join('')}</select></div>
          <div><label>اولویت</label><input id="t-prio" type="number" value="0" dir="ltr"></div>
          <div><label>از ساعت</label><input id="t-start" type="time" dir="ltr"></div>
          <div><label>تا ساعت</label><input id="t-end" type="time" dir="ltr"></div>
          <div><label>نرخ (ریال/ساعت)</label><input id="t-rate" type="number" min="1000" step="1000" dir="ltr"></div>
          <div><label>فقط تعطیلات</label><select id="t-hol"><option value="0">خیر</option><option value="1">بله</option></select></div>
        </div>
        <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="addTariff()">ثبت تعرفه</button>
      </div>
      <div style="border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:12px">
        <b>تقویم تعطیلات</b>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <input type="date" id="hd-date" style="flex:1;min-width:150px">
          <input id="hd-name" placeholder="نام تعطیلی (اختیاری)" style="flex:2;min-width:150px">
          <button class="btn btn-secondary btn-sm" onclick="addHoliday()">ثبت</button>
        </div>
        <div class="pill-row">${tp.holidays.map(h=>`<span class="badge badge-purple">${esc(h.holiday_date)} ${esc(h.name)} <a href="#" onclick="delHoliday(${h.id});return false" style="color:#fb7185">✕</a></span>`).join('') || '<span class="muted small">تقویم خالی است</span>'}</div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>🥤 آیتم‌های بوفه</h3>
      <div style="overflow:auto;margin-top:8px"><table>
        <tr><th>نام</th><th>قیمت</th><th>موجودی</th><th>وضعیت</th><th></th></tr>
        ${bf.items.map(i=>`<tr>
          <td>${esc(i.name)}</td><th>${fmtMoney(i.price_cents)}</th>
          <td>${i.stock==null?'نامحدود':i.stock}</td>
          <td><span class="badge ${i.active?'badge-green':'badge-red'}">${i.active?'فعال':'غیرفعال'}</span></td>
          <td><button class="btn btn-ghost btn-sm" onclick="delBuffet(${i.id})">🗑</button></td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">آیتمی ثبت نشده</td></tr>'}
      </table></div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <input id="b-name" placeholder="نام (نوشابه، چیپس…)" style="flex:2;min-width:140px">
        <input id="b-price" type="number" min="0" step="1000" placeholder="قیمت (ریال)" dir="ltr" style="flex:1;min-width:110px">
        <input id="b-stock" type="number" min="0" placeholder="موجودی (∞)" dir="ltr" style="flex:1;min-width:90px">
        <button class="btn btn-primary btn-sm" onclick="addBuffetItem()">افزودن</button>
      </div>
    </div>`;
  }catch(e){
    $('s-pricing').innerHTML = e.status===403
      ? licenseLockCard()
      : `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function addTariff(){
  try{
    await API.post(`/api/gamenets/${current.id}/play/tariffs`, {
      name: $('t-name').value,
      system_type: $('t-type').value || null,
      day_of_week: $('t-day').value === '' ? null : Number($('t-day').value),
      start_time: $('t-start').value || null,
      end_time: $('t-end').value || null,
      rate_per_hour: Number($('t-rate').value),
      priority: Number($('t-prio').value)||0,
      is_holiday: $('t-hol').value === '1',
    });
    toast('تعرفه ثبت شد'); loadPricing(); loadSystems().catch(()=>{});
  }catch(e){ toast(e.message,'err'); }
}
async function delTariff(id){
  if(!confirm('تعرفه حذف شود؟')) return;
  try{ await API.del(`/api/gamenets/${current.id}/play/tariffs/${id}`); loadPricing(); loadSystems().catch(()=>{}); }
  catch(e){ toast(e.message,'err'); }
}
async function createSamples(){
  if(!confirm('۴ تعرفه نمونه (PC پایه، VIP، عصرگاهی، تعطیلات) ساخته شود؟ بعداً قابل ویرایش/حذف است.')) return;
  const samples = [
    { name:'PC — پایه', system_type:'pc', rate_per_hour:300000, priority:0 },
    { name:'کنسول/پلی‌استیشن — پایه', system_type:'playstation', rate_per_hour:500000, priority:0 },
    { name:'VIP — پایه', system_type:'vip', rate_per_hour:700000, priority:0 },
    { name:'عصرگاهی (۱۸ تا ۲۴)', system_type:null, start_time:'18:00', end_time:'00:00', rate_per_hour:400000, priority:5 },
  ];
  try{
    for(const s of samples) await API.post(`/api/gamenets/${current.id}/play/tariffs`, s);
    toast('تعرفه‌های نمونه ساخته شد'); loadPricing(); loadSystems().catch(()=>{});
  }catch(e){ toast(e.message,'err'); }
}
async function addHoliday(){
  try{
    await API.post(`/api/gamenets/${current.id}/play/holidays`, { holiday_date: $('hd-date').value, name: $('hd-name').value });
    toast('تعطیلی ثبت شد'); loadPricing();
  }catch(e){ toast(e.message,'err'); }
}
async function delHoliday(id){
  try{ await API.del(`/api/gamenets/${current.id}/play/holidays/${id}`); loadPricing(); }
  catch(e){ toast(e.message,'err'); }
}
async function addBuffetItem(){
  try{
    const stock = $('b-stock').value;
    await API.post(`/api/gamenets/${current.id}/play/buffet`, {
      name: $('b-name').value, price_cents: Number($('b-price').value),
      stock: stock === '' ? null : Number(stock),
    });
    toast('آیتم افزوده شد'); loadPricing(); loadSystems().catch(()=>{});
  }catch(e){ toast(e.message,'err'); }
}
async function delBuffet(id){
  if(!confirm('آیتم حذف شود؟')) return;
  try{ await API.del(`/api/gamenets/${current.id}/play/buffet/${id}`); loadPricing(); loadSystems().catch(()=>{}); }
  catch(e){ toast(e.message,'err'); }
}

Object.assign(window, {
  show, loadSystems, renderSystems, refilter, licenseLockCard, loadStorage, startSys, pauseS, resumeS, stopS, clearReceipt,
  addBuffet, delLine, toggleAddSys, createSystem, editSys, setSysStatus, delSys,
  searchHistory, addTariff, delTariff, createSamples, addHoliday, delHoliday,
  addBuffetItem, delBuffet,
});

boot().catch(e=>{ console.error(e); toast(e.message||'خطا','err'); });
