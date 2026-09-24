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
  await Promise.all([loadDash(), loadSub(), loadFiles(), loadTickets(), loadNotif(), loadGamenets()]);
  initAI();
}
document.querySelectorAll('.side button').forEach(b=>{
  b.onclick = ()=>show(b.dataset.s);
});
function show(s){
  document.querySelectorAll('.side button').forEach(x=>x.classList.toggle('active', x.dataset.s===s));
  document.querySelectorAll('main section').forEach(x=>x.classList.toggle('hidden', x.id!=='s-'+s));
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
    const st = d.storage;
    const pct = st.limit_bytes ? Math.min(100, Math.round(st.ratio*100)) : 0;
    $('s-dash').innerHTML = `
      <div class="grid g4">
        <div class="stat"><div class="l">وضعیت اشتراک</div><div class="v">${sub?`<span class="badge badge-green">فعال</span>`:`<span class="badge badge-red">غیرفعال</span>`}</div></div>
        <div class="stat"><div class="l">تاریخ انقضا</div><div class="v" style="font-size:16px">${sub?esc(sub.ends_at||'—'):'—'}</div></div>
        <div class="stat"><div class="l">فضای مصرفی</div><div class="v" style="font-size:16px">${fmtBytes(st.used_bytes)} / ${fmtBytes(st.limit_bytes)}</div></div>
        <div class="stat"><div class="l">تیکت‌های باز</div><div class="v">${(d.tickets||[]).filter(t=>t.status!=='resolved'&&t.status!=='closed').length}</div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>فضای ذخیره‌سازی</h3>
        <div class="progress" style="margin:10px 0"><i style="width:${pct}%"></i></div>
        <div class="muted">${pct}% مصرف — ${st.file_count} فایل ${pct>=80?'<span class="badge badge-amber">هشدار</span>':''}</div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>اعلان‌های اخیر</h3>
        ${(d.notifications||[]).slice(0,5).map(n=>`<div class="muted" style="padding:6px 0;border-bottom:1px solid var(--line)">
          <b>${esc(n.title)}</b> — ${esc(n.body)} <span class="small">${esc(n.created_at)}</span></div>`).join('') || '<div class="empty">اعلانی نیست</div>'}
      </div>
      <div class="card" style="margin-top:14px">
        <h3>فعالیت‌های اخیر</h3>
        ${(d.recent_activity||[]).map(a=>`<div class="muted small" style="padding:4px 0">${esc(a.created_at)} · <span class="kbd">${esc(a.action)}</span></div>`).join('')||'<div class="empty">—</div>'}
      </div>`;
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

async function loadFiles(){
  if(!current) return;
  try{
    const d = await API.get('/api/gamenets/'+current.id+'/files');
    $('s-files').innerHTML = `
      <div class="card">
        <h3>فایل‌ها</h3>
        <label>آپلود فایل (حداکثر ۲۵MB)</label>
        <input type="file" id="fup">
        <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="uploadFile()">آپلود</button>
        <div style="overflow:auto;margin-top:14px"><table>
          <tr><th>نام</th><th>حجم</th><th>تاریخ</th><th></th></tr>
          ${(d.files||[]).map(f=>`<tr>
            <td>${esc(f.original_name)}</td><td>${fmtBytes(f.size_bytes)}</td><td class="small">${esc(f.created_at)}</td>
            <td><button class="btn btn-danger btn-sm" onclick="delFile(${f.id})">حذف</button></td></tr>`).join('')
            ||'<tr><td colspan="4" class="empty">فایلی نیست</td></tr>'}
        </table></div>
      </div>`;
  }catch(e){ $('s-files').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
}
async function uploadFile(){
  const inp = $('fup');
  if(!inp.files[0]) return toast('فایلی انتخاب نکرده‌اید','err');
  const fd = new FormData();
  fd.append('file', inp.files[0]);
  try{
    const m = document.cookie.match(/(?:^|;\s*)gn_csrf=([^;]+)/);
    const res = await fetch(`/api/gamenets/${current.id}/files`, {
      method:'POST', body: fd, credentials:'same-origin',
      headers: { 'x-csrf-token': m?decodeURIComponent(m[1]):'' }
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.message||data.error);
    toast('آپلود شد');
    loadFiles(); loadDash();
  }catch(e){ toast(e.message,'err'); }
}
async function delFile(id){
  if(!confirm('حذف فایل؟')) return;
  try{ await API.del(`/api/gamenets/${current.id}/files/${id}`); loadFiles(); loadDash(); }
  catch(e){ toast(e.message,'err'); }
}
window.uploadFile=uploadFile; window.delFile=delFile;

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

boot().catch(e=>{ console.error(e); toast(e.message||'خطا','err'); });
