'use strict';
let user=null;
const $=id=>document.getElementById(id);
const sections=['stats','users','gamenets','subs','licenses','events','payments','tickets','storage','audit','backups','settings'];
document.querySelectorAll('.side button').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('.side button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    sections.forEach(s=>$('s-'+s).classList.toggle('hidden', s!==b.dataset.s));
    loaders[b.dataset.s]();
  };
});
async function logout(){ await API.post('/api/auth/logout',{}).catch(()=>{}); location.href='/admin'; }
window.logout=logout;

function adErr(msg){
  const e = $('ad-err');
  if(!e) return;
  e.textContent = msg || '';
  e.classList.toggle('hidden', !msg);
}
function enterPanel(u){
  user = u;
  meId = u.id || null;
  $('admin-nav').style.display = '';
  $('admin-gate').classList.add('hidden');
  $('panel').classList.remove('hidden');
  $('who').textContent = u.email;
  loaders.stats();
}
async function adLogin(){
  adErr('');
  const btn = $('ad-btn'); btn.disabled = true; btn.classList.add('loading');
  try{
    const email = $('ad-email').value.trim(), password = $('ad-pass').value;
    if(!email || !password){ adErr('ایمیل و رمز را وارد کنید'); return; }
    const r = await API.post('/api/auth/login', { email, password });
    const roles = (r.user && r.user.roles) || [];
    if(!roles.some(x => x === 'super_admin' || x === 'admin')){
      adErr('این حساب دسترسی مدیریت ندارد');
      await API.post('/api/auth/logout', {}).catch(()=>{});
      return;
    }
    enterPanel(r.user);
    toast('خوش آمدید');
  }catch(e){
    adErr(e.message);
  }finally{
    btn.disabled = false; btn.classList.remove('loading');
  }
}
window.adLogin = adLogin;

let usersTab = 'active';
let meId = null;
const USER_STATUS_FA = { active:'فعال', suspended:'غیرفعال', deleted:'حذف‌شده' };
function setUsersTab(t){ usersTab = t; loaders.users(); }

const loaders = {
  async stats(){
    const d = await API.get('/api/admin/stats');
    $('s-stats').innerHTML = `
      <div class="grid g4">
        <div class="stat"><div class="l">کاربران</div><div class="v">${d.users}</div></div>
        <div class="stat"><div class="l">گیم‌نت‌ها</div><div class="v">${d.gamenets}</div></div>
        <div class="stat"><div class="l">اشتراک فعال</div><div class="v">${d.active_subs}</div></div>
        <div class="stat"><div class="l">درآمد</div><div class="v" style="font-size:16px">${fmtMoney(d.revenue_cents)}</div></div>
        <div class="stat"><div class="l">تیکت باز</div><div class="v">${d.open_tickets}</div></div>
        <div class="stat"><div class="l">سفارش معلق</div><div class="v">${d.pending_orders}</div></div>
        <div class="stat"><div class="l">فضای مصرفی</div><div class="v" style="font-size:16px">${fmtBytes(d.storage.used)}</div></div>
        <div class="stat"><div class="l">فایل‌ها</div><div class="v">${d.storage.files}</div></div>
      </div>`;
  },
  async users(){
    const d = await API.get('/api/admin/users?status='+encodeURIComponent(usersTab));
    const c = d.counts || { active:0, suspended:0, deleted:0 };
    const tabBtn = (k,label)=>`<button class="btn btn-sm ${usersTab===k?'btn-primary':'btn-secondary'}" onclick="setUsersTab('${k}')">${label} (${c[k]||0})</button>`;
    $('s-users').innerHTML = `<div class="card"><h3>کاربران</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        ${tabBtn('active','فعال')}${tabBtn('suspended','غیرفعال')}${tabBtn('deleted','حذف‌شده')}
      </div>
      <div style="overflow:auto"><table>
      <tr><th>#</th><th>ایمیل</th><th>نام</th><th>نقش‌ها</th><th>وضعیت</th><th>ایمیل</th><th>عملیات</th></tr>
      ${d.users.map(u=>{
        const isMe = meId !== null && u.id === meId;
        const badge = u.status==='active'?'badge-green':u.status==='suspended'?'badge-amber':'badge-red';
        let actions = '';
        if(isMe){
          actions = '<span class="badge badge-purple">حساب شما</span>';
        } else if(u.status==='active'){
          actions = `<button class="btn btn-secondary btn-sm" onclick="uStatus(${u.id},'suspended')">غیرفعال</button>
            <button class="btn btn-danger btn-sm" onclick="uStatus(${u.id},'deleted')">حذف</button>`;
        } else if(u.status==='suspended'){
          actions = `<button class="btn btn-primary btn-sm" onclick="uStatus(${u.id},'active')">فعال</button>
            <button class="btn btn-danger btn-sm" onclick="uStatus(${u.id},'deleted')">حذف</button>`;
        } else {
          actions = `<button class="btn btn-primary btn-sm" onclick="uStatus(${u.id},'active')">بازگردانی</button>`;
        }
        if(!isMe && !u.email_verified_at) actions += ` <button class="btn btn-secondary btn-sm" onclick="uVerify(${u.id})">تأیید ایمیل</button>`;
        return `<tr>
        <td>${u.id}</td><td>${esc(u.email)}</td><td>${esc(u.name)}</td>
        <td><span class="badge badge-purple">${esc(u.roles||'—')}</span></td>
        <td><span class="badge ${badge}">${USER_STATUS_FA[u.status]||esc(u.status)}</span></td>
        <td>${u.email_verified_at ? '<span class="badge badge-green">تأیید</span>' : '<span class="badge badge-amber">در انتظار</span>'}</td>
        <td>${actions}</td></tr>`;
      }).join('')||'<tr><td colspan="7" class="empty">موردی نیست</td></tr>'}
    </table></div></div>`;
  },
  async gamenets(){
    const d = await API.get('/api/admin/gamenets');
    $('s-gamenets').innerHTML = `<div class="card"><h3>گیم‌نت‌ها</h3><div style="overflow:auto"><table>
      <tr><th>#</th><th>نام</th><th>مالک</th><th>اشتراک</th><th>فضا</th><th>وضعیت</th><th></th></tr>
      ${d.gamenets.map(g=>`<tr>
        <td>${g.id}</td><td>${esc(g.name)}</td><td class="small">${esc(g.owner_email)}</td>
        <td><span class="badge ${g.sub_status==='active'?'badge-green':'badge-amber'}">${g.sub_status||'—'}</span></td>
        <td class="small">${fmtBytes(g.storage?.used_bytes||0)}</td>
        <td><span class="badge ${g.status==='active'?'badge-green':'badge-red'}">${esc(g.status)}</span></td>
        <td>
          ${g.status==='active'
            ? `<button class="btn btn-danger btn-sm" onclick="gStatus(${g.id},'suspended')">تعلیق</button>`
            : `<button class="btn btn-primary btn-sm" onclick="gStatus(${g.id},'active')">فعال</button>`}
        </td></tr>`).join('')||'<tr><td colspan="7" class="empty">موردی نیست</td></tr>'}
    </table></div></div>`;
  },
  async subs(){
    const d = await API.get('/api/admin/subscriptions');
    $('s-subs').innerHTML = `<div class="card"><h3>اشتراک‌ها</h3><div style="overflow:auto"><table>
      <tr><th>#</th><th>گیم‌نت</th><th>پلن</th><th>وضعیت</th><th>انقضا</th><th>عملیات</th></tr>
      ${d.subscriptions.map(s=>`<tr>
        <td>${s.id}</td><td>${esc(s.gamenet_name)}</td><td>${esc(s.plan_name)}</td>
        <td><span class="badge ${s.status==='active'?'badge-green':s.status==='expired'?'badge-red':'badge-amber'}">${esc(s.status)}</span></td>
        <td class="small">${esc(s.ends_at||'—')}</td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="subAct(${s.id},'suspend')">تعلیق</button>
          <button class="btn btn-primary btn-sm" onclick="subAct(${s.id},'renew')">تمدید</button>
          <button class="btn btn-danger btn-sm" onclick="subAct(${s.id},'cancel')">لغو</button>
        </td></tr>`).join('')||'<tr><td colspan="6" class="empty">موردی نیست</td></tr>'}
    </table></div></div>`;
  },
  async licenses(){
    const d = await API.get('/api/admin/licenses');
    $('s-licenses').innerHTML = `<div class="card"><h3>Licenseها</h3><div style="overflow:auto"><table>
      <tr><th>#</th><th>کلید</th><th>گیم‌نت</th><th>وضعیت</th><th>انقضا</th><th>عملیات</th></tr>
      ${d.licenses.map(l=>`<tr>
        <td>${l.id}</td><td><code class="small">${esc(l.key.slice(0,14))}…</code></td>
        <td>${esc(l.gamenet_name)}</td>
        <td><span class="badge ${l.status==='active'?'badge-green':'badge-red'}">${esc(l.status)}</span></td>
        <td class="small">${esc(l.expires_at||'—')}</td>
        <td>
          ${l.status==='active'
            ? `<button class="btn btn-danger btn-sm" onclick="licSet(${l.id},'revoked')">ابطال</button>`
            : `<button class="btn btn-primary btn-sm" onclick="licSet(${l.id},'active')">فعال‌سازی</button>`}
        </td></tr>`).join('')||'<tr><td colspan="6" class="empty">موردی نیست</td></tr>'}
    </table></div></div>`;
  },
  async events(){
    const [d, gs] = await Promise.all([
      API.get('/api/admin/license-events'),
      API.get('/api/admin/gamenets'),
    ]);
    const gOpts = (gs.gamenets||[]).filter(g=>g.status==='active')
      .map(g=>`<option value="${g.id}">#${g.id} — ${esc(g.name)}</option>`).join('');
    $('s-events').innerHTML = `
      <div class="card">
        <h3>🎪 ایونت‌های لایسنس رایگان</h3>
        <p class="muted small">هر ایونت یک مهلت مشخص (پیش‌فرض ۳۰ روز = یک ماه) دارد. با «صدور لایسنس» برای هر گیم‌نت، لایسنس رایگان صادر می‌شود. با <b>غیرفعال کردن ایونت</b>، همه لایسنس‌های صادرشده از آن ایونت بلافاصله باطل می‌شوند (لایسنس‌های خریداری‌شده دست‌نخورده می‌مانند).</p>
        <div class="grid g4" style="gap:8px;margin-top:8px">
          <div><label>نام ایونت</label><input id="ev-name" placeholder="مثلاً جشنواره پاییز"></div>
          <div><label>مدت (روز)</label><input id="ev-days" type="number" min="1" max="3650" value="30" dir="ltr"></div>
          <div style="display:flex;align-items:flex-end"><button class="btn btn-primary btn-sm" style="width:100%" onclick="evCreate()">ایجاد ایونت</button></div>
        </div>
        <div style="overflow:auto;margin-top:14px"><table>
          <tr><th>#</th><th>نام</th><th>مدت</th><th>وضعیت</th><th>صادرشده</th><th>فعال</th><th>صدور لایسنس</th><th></th></tr>
          ${(d.events||[]).map(e=>`<tr>
            <td>${e.id}</td>
            <td><b>${esc(e.name)}</b></td>
            <td>${e.duration_days} روز</td>
            <td><span class="badge ${e.active?'badge-green':'badge-red'}">${e.active?'فعال':'غیرفعال'}</span></td>
            <td>${e.issued}</td>
            <td>${e.active_issued}</td>
            <td>
              <div style="display:flex;gap:6px">
                <select id="ev-gid-${e.id}" style="min-width:150px">${gOpts||'<option value="">گیم‌نتی نیست</option>'}</select>
                <button class="btn btn-primary btn-sm" onclick="evIssue(${e.id})" ${e.active?'':'disabled'}>صدور</button>
              </div>
            </td>
            <td>${e.active
              ? `<button class="btn btn-danger btn-sm" onclick="evToggle(${e.id},0)">غیرفعال کردن</button>`
              : `<button class="btn btn-secondary btn-sm" onclick="evToggle(${e.id},1)">فعال کردن</button>`}</td>
          </tr>`).join('')||'<tr><td colspan="8" class="empty">ایونتی ساخته نشده</td></tr>'}
        </table></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>لایسنس‌های صادرشده از ایونت‌ها</h3>
        <div style="overflow:auto;margin-top:8px"><table>
          <tr><th>ایونت</th><th>گیم‌نت</th><th>کلید</th><th>وضعیت</th><th>انقضا</th></tr>
          ${(d.issued||[]).map(l=>`<tr>
            <td>${esc((d.events||[]).find(e=>e.id===l.event_id)?.name||('#'+l.event_id))}</td>
            <td>${esc(l.gamenet_name)}</td>
            <td><code class="small">${esc(String(l.key).slice(0,14))}…</code></td>
            <td><span class="badge ${l.status==='active'?'badge-green':'badge-red'}">${esc(l.status)}</span></td>
            <td class="small">${esc(l.expires_at||'—')}</td>
          </tr>`).join('')||'<tr><td colspan="5" class="empty">موردی نیست</td></tr>'}
        </table></div>
      </div>`;
  },
  async payments(){
    const d = await API.get('/api/admin/payments');
    const pend = (d.payments||[]).filter(p => p.status==='pending' && p.provider==='manual');
    const pendHtml = pend.map(p=>{
      let raw={}; try{ raw=JSON.parse(p.raw_json||'{}'); }catch(e){}
      const rec = raw.receipt || '';
      return `<div class="card" style="margin-top:12px;border:1px solid #f59e0b">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center">
          <div>
            <span class="badge badge-amber">در انتظار تأیید</span>
            <b style="margin-right:8px">${esc(p.order_public)}</b>
            <span class="muted small">${esc(p.user_name||'')} — ${esc(p.email)}</span>
          </div>
          <div style="font-weight:900">${fmtMoney(p.amount_cents)}</div>
        </div>
        <div class="grid g3" style="margin-top:10px;gap:8px;text-align:right">
          <div><label>پلن</label><div>${esc(p.plan_name||'—')}</div></div>
          <div><label>کد پیگیری</label><div dir="ltr" style="text-align:left;font-weight:700">${esc(raw.tracking_code||'—')}</div></div>
          <div><label>ارسال</label><div class="small">${esc(raw.submitted_at||p.created_at||'')}</div></div>
        </div>
        ${rec ? `<div style="margin-top:10px;text-align:center"><img src="${rec}" alt="رسید" style="max-width:100%;max-height:340px;border-radius:10px;border:1px solid var(--line);cursor:zoom-in" onclick="window.open(this.src,'_blank')"></div>`
              : '<div class="muted small" style="margin-top:8px">رسید عکسی ارسال نشده — فقط کد پیگیری</div>'}
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-primary" onclick="confirmPay(${p.id})">✅ تأیید و فعال‌سازی اشتراک</button>
          <button class="btn btn-danger" onclick="rejectPay(${p.id})">❌ رد رسید</button>
        </div>
      </div>`;
    }).join('') || '<div class="muted small" style="margin-top:10px">رسید در انتظار تأییدی نیست ✅</div>';

    $('s-payments').innerHTML = `
      <div class="card"><h3>رسیدهای در انتظار تأیید</h3>${pendHtml}</div>
      <div class="card" style="margin-top:14px"><h3>پرداخت‌ها</h3><div style="overflow:auto"><table>
        <tr><th>#</th><th>سفارش</th><th>کاربر</th><th>پلن</th><th>مبلغ</th><th>روش</th><th>وضعیت</th></tr>
        ${d.payments.map(p=>`<tr>
          <td>${p.id}</td><td>${esc(p.order_public)}</td><td>${esc(p.email)}</td>
          <td>${esc(p.plan_name||'—')}</td>
          <td>${fmtMoney(p.amount_cents)}</td>
          <td class="small">${p.provider==='manual'?'کارت به کارت':esc(p.provider)}</td>
          <td><span class="badge ${p.status==='succeeded'?'badge-green':p.status==='failed'?'badge-red':'badge-amber'}">${esc(p.status==='succeeded'?'تأیید شد':p.status==='failed'?'رد شد':'در انتظار')}</span></td>
        </tr>`).join('')||'<tr><td colspan="7" class="empty">موردی نیست</td></tr>'}
      </table></div></div>
      <div class="card" style="margin-top:14px"><h3>فاکتورها</h3><div style="overflow:auto"><table>
        <tr><th>شماره</th><th>مبلغ</th><th>تاریخ</th></tr>
        ${d.invoices.map(i=>`<tr><td>${esc(i.number)}</td><td>${fmtMoney(i.amount_cents)}</td><td class="small">${esc(i.issued_at)}</td></tr>`).join('')||'<tr><td colspan="3" class="empty">موردی نیست</td></tr>'}
      </table></div></div>`;
  },
  async tickets(){
    const d = await API.get('/api/admin/tickets');
    $('s-tickets').innerHTML = `<div class="card"><h3>تیکت‌ها</h3><div style="overflow:auto"><table>
      <tr><th>#</th><th>موضوع</th><th>وضعیت</th><th>اولویت</th><th></th></tr>
      ${d.tickets.map(t=>`<tr>
        <td>${t.id}</td><td>${esc(t.subject)}</td>
        <td><span class="badge ${t.status==='resolved'?'badge-green':t.status==='waiting_human'?'badge-amber':'badge-blue'}">${esc(t.status)}</span></td>
        <td>${esc(t.priority)}</td>
        <td><button class="btn btn-secondary btn-sm" onclick="openTicketAdmin(${t.id})">باز</button></td>
      </tr>`).join('')||'<tr><td colspan="5" class="empty">موردی نیست</td></tr>'}
    </table></div><div id="tk-admin"></div></div>`;
  },
  async storage(){
    const d = await API.get('/api/admin/storage');
    $('s-storage').innerHTML = `
      <div class="grid g3">
        <div class="stat"><div class="l">مستأجرها</div><div class="v">${d.global.tenants}</div></div>
        <div class="stat"><div class="l">مصرف کل</div><div class="v" style="font-size:16px">${fmtBytes(d.global.used)}</div></div>
        <div class="stat"><div class="l">سقف کل</div><div class="v" style="font-size:16px">${fmtBytes(d.global.limit)}</div></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>مصرف هر گیم‌نت</h3><div style="overflow:auto"><table>
        <tr><th>#</th><th>نام</th><th>مصرف</th><th>سقف</th><th>فایل</th><th></th></tr>
        ${d.tenants.map(t=>`<tr>
          <td>${t.id}</td><td>${esc(t.name)}</td>
          <td>${fmtBytes(t.used_bytes||0)}</td><td>${fmtBytes(t.storage_limit_bytes)}</td>
          <td>${t.file_count||0}</td>
          <td><button class="btn btn-secondary btn-sm" onclick="recalc(${t.id})">بازمحاسبه</button></td>
        </tr>`).join('')||'<tr><td colspan="6" class="empty">موردی نیست</td></tr>'}
      </table></div></div>`;
  },
  async audit(){
    const d = await API.get('/api/admin/audit');
    $('s-audit').innerHTML = `<div class="card"><h3>Audit Log</h3><div style="overflow:auto;max-height:600px"><table>
      <tr><th>زمان</th><th>کاربر</th><th>نقش</th><th>عملیات</th><th>شیء</th></tr>
      ${d.logs.map(l=>`<tr>
        <td class="small">${esc(l.created_at)}</td>
        <td>${l.actor_user_id||'—'}</td>
        <td class="small">${esc(l.actor_role||'')}</td>
        <td><span class="kbd">${esc(l.action)}</span></td>
        <td class="small">${esc(l.entity)} ${esc(l.entity_id)}</td>
      </tr>`).join('')||'<tr><td colspan="5" class="empty">موردی نیست</td></tr>'}
    </table></div></div>`;
  },
  async backups(){
    const d = await API.get('/api/admin/backups');
    $('s-backups').innerHTML = `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3>بکاپ و بازیابی</h3>
        <div>
          <button class="btn btn-primary btn-sm" onclick="createBackup()">ایجاد بکاپ</button>
          <button class="btn btn-danger btn-sm" onclick="pruneBackup()">پاکسازی (نگه‌داشتن ۱۴)</button>
        </div>
      </div>
      <div style="overflow:auto;margin-top:12px"><table>
        <tr><th>فایل</th><th>حجم</th><th>تاریخ</th></tr>
        ${d.backups.map(b=>`<tr><td>${esc(b.name)}</td><td>${fmtBytes(b.size)}</td><td class="small">${esc(b.created_at)}</td></tr>`).join('')||'<tr><td colspan="3" class="empty">بکاپی نیست</td></tr>'}
      </table></div>
    </div>`;
  },
  async settings(){
    const d = await API.get('/api/admin/settings');
    const map = {}; (d.settings||[]).forEach(s=>map[s.key]=s.value);
    $('s-settings').innerHTML = `
    <div class="card">
      <h3>💳 اطلاعات کارت به کارت (نمایش به مشتری)</h3>
      <p class="muted small">این اطلاعات در صفحهٔ پرداخت مشتری نمایش داده می‌شود. شماره کارت عمومی است و رمز/CVV هرگز اینجا نرود.</p>
      <div class="grid g2">
        <div><label>به نام (نام صاحب کارت)</label><input id="c-name" value="${esc(map.cardholder_name||'')}" placeholder="مثال: علی رضایی"></div>
        <div><label>شماره کارت</label><input id="c-no" dir="ltr" style="text-align:left" value="${esc(map.card_number||'')}" placeholder="6219-8610-XXXX-XXXX" maxlength="30"></div>
        <div><label>بانک (اختیاری)</label><input id="c-bank" value="${esc(map.card_bank||'')}" placeholder="مثال: بانک سامان"></div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="saveCard()">ذخیره اطلاعات کارت</button>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>تنظیمات سیستم</h3>
      <div class="grid g2">
        <div><label>کلید</label><input id="set-key" placeholder="maintenance_mode"></div>
        <div><label>مقدار</label><input id="set-val" placeholder="1"></div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="saveSetting()">ذخیره</button>
      <div style="overflow:auto;margin-top:14px"><table>
        <tr><th>کلید</th><th>مقدار</th></tr>
        ${d.settings.map(s=>`<tr><td>${esc(s.key)}</td><td class="small">${esc(s.value)}</td></tr>`).join('')||'<tr><td colspan="2" class="empty">موردی نیست</td></tr>'}
      </table></div>
    </div>`;
  },
};

async function uStatus(id,status){
  const how = status==='deleted' ? 'حذف شود؟ (حذف نرم است — داده‌ها می‌ماند و بعداً قابل بازگردانی)'
    : status==='suspended' ? 'غیرفعال شود؟ (از سیستم خارج می‌شود تا دوباره فعالش کنید)'
    : 'دوباره فعال شود؟';
  if(!confirm('کاربر '+id+' '+how)) return;
  try{ await API.post('/api/admin/users/'+id+'/status',{status}); toast('انجام شد'); loaders.users(); }
  catch(e){ toast(e.message,'err'); }
}
async function gStatus(id,status){
  if(!confirm('وضعیت گیم‌نت '+id+' → '+status+'؟')) return;
  try{ await API.post('/api/admin/gamenets/'+id+'/status',{status}); toast('انجام شد'); loaders.gamenets(); }
  catch(e){ toast(e.message,'err'); }
}
async function subAct(id,act){
  if(!confirm(act+' اشتراک '+id+'؟')) return;
  try{ await API.post('/api/admin/subscriptions/'+id+'/'+act,{}); toast('انجام شد'); loaders.subs(); }
  catch(e){ toast(e.message,'err'); }
}
async function licSet(id,status){
  if(!confirm('وضعیت لایسنس → '+status+'؟')) return;
  try{ await API.post('/api/admin/licenses/'+id+'/status',{status}); toast('انجام شد'); loaders.licenses(); }
  catch(e){ toast(e.message,'err'); }
}
async function createBackup(){
  try{ const r=await API.post('/api/admin/backups',{}); toast('بکاپ ساخته شد'); loaders.backups(); }
  catch(e){ toast(e.message,'err'); }
}
async function pruneBackup(){
  if(!confirm('حذف بکاپ‌های اضافی؟')) return;
  try{ await API.post('/api/admin/backups/prune',{keep:14}); toast('انجام شد'); loaders.backups(); }
  catch(e){ toast(e.message,'err'); }
}
async function recalc(id){
  try{ await API.post('/api/admin/storage/'+id+'/recalc',{}); toast('بازمحاسبه شد'); loaders.storage(); }
  catch(e){ toast(e.message,'err'); }
}
async function saveSetting(){
  try{
    await API.put('/api/admin/settings',{key:$('set-key').value.trim(),value:$('set-val').value});
    toast('ذخیره شد'); loaders.settings();
  }catch(e){ toast(e.message,'err'); }
}
async function saveCard(){
  const no = $('c-no').value.trim();
  if(no && !/^[0-9\- ]{10,25}$/.test(no)){ toast('شماره کارت فقط رقم و خط تیره/فاصله', 'err'); return; }
  try{
    await Promise.all([
      API.put('/api/admin/settings',{key:'cardholder_name',value:$('c-name').value.trim()}),
      API.put('/api/admin/settings',{key:'card_number',value:no}),
      API.put('/api/admin/settings',{key:'card_bank',value:$('c-bank').value.trim()}),
    ]);
    toast('اطلاعات کارت ذخیره شد'); loaders.settings();
  }catch(e){ toast(e.message,'err'); }
}
async function confirmPay(id){
  if(!confirm('پرداخت '+id+' تأیید شود؟ اشتراک و لایسنس بلافاصله فعال می‌شود.')) return;
  try{
    const r = await API.post('/api/admin/payments/'+id+'/confirm',{});
    toast(r.alreadyConfirmed ? 'قبلاً تأیید شده بود' : 'تأیید شد — اشتراک فعال شد ✅');
    loaders.payments();
  }catch(e){ toast(e.message,'err'); }
}
async function rejectPay(id){
  const reason = prompt('دلیل رد رسید (برای مشتری نمایش داده می‌شود):');
  if(reason === null) return;
  try{
    await API.post('/api/admin/payments/'+id+'/reject',{reason});
    toast('رسید رد شد'); loaders.payments();
  }catch(e){ toast(e.message,'err'); }
}
async function uVerify(id){
  try{ await API.post('/api/admin/users/'+id+'/verify-email',{}); toast('ایمیل تأیید شد'); loaders.users(); }
  catch(e){ toast(e.message,'err'); }
}
async function openTicketAdmin(id){
  try{
    const d = await API.get('/api/tickets/'+id);
    const t = d.ticket;
    $('tk-admin').innerHTML = `
      <div class="card" style="margin-top:12px;background:#0a1324">
        <h4>تیکت #${t.id} — ${esc(t.subject)}</h4>
        <div class="chat-box" id="adm-cv">${(t.messages||[]).map(m=>`<div class="msg ${esc(m.role)}">${esc(m.content)}</div>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <input id="adm-rp" placeholder="پاسخ پشتیبان…">
          <button class="btn btn-primary btn-sm" onclick="replyAdm(${t.id})">ارسال</button>
          <button class="btn btn-secondary btn-sm" onclick="replyAdm(${t.id},true)">ارسال و بستن</button>
        </div>
      </div>`;
    const cv=$('adm-cv'); cv.scrollTop=cv.scrollHeight;
  }catch(e){ toast(e.message,'err'); }
}
async function replyAdm(id,resolve){
  const c=$('adm-rp').value.trim(); if(!c) return;
  try{
    await API.post('/api/tickets/'+id+'/reply',{content:c,resolve:!!resolve});
    openTicketAdmin(id); loaders.tickets();
  }catch(e){ toast(e.message,'err'); }
}
async function evCreate(){
  try{
    await API.post('/api/admin/license-events', { name: $('ev-name').value, duration_days: Number($('ev-days').value)||30 });
    toast('ایونت ساخته شد'); $('ev-name').value=''; loaders.events();
  }catch(e){ toast(e.message,'err'); }
}
async function evToggle(id, active){
  if(!active && !confirm('ایونت غیرفعال شود؟ همه لایسنس‌های صادرشده از آن بلافاصله باطل می‌شوند.')) return;
  try{
    const r = await API.post('/api/admin/license-events/'+id+'/status', { active: !!active });
    toast(active ? 'ایونت فعال شد' : ('ایونت غیرفعال شد — '+(r.revoked||0)+' لایسنس باطل شد'));
    loaders.events(); loaders.licenses();
  }catch(e){ toast(e.message,'err'); }
}
async function evIssue(id){
  const sel = $('ev-gid-'+id);
  if(!sel || !sel.value) return toast('گیم‌نتی انتخاب نکرده‌اید','err');
  try{
    const r = await API.post('/api/admin/license-events/'+id+'/issue', { gamenet_id: Number(sel.value) });
    toast('لایسنس رایگان صادر شد — تا '+esc(r.license.expires_at||''));
    loaders.events(); loaders.licenses();
  }catch(e){ toast(e.message,'err'); }
}
Object.assign(window,{uStatus,gStatus,subAct,licSet,createBackup,pruneBackup,recalc,saveSetting,saveCard,confirmPay,rejectPay,uVerify,openTicketAdmin,replyAdm,evCreate,evToggle,evIssue,setUsersTab});

(async()=>{
  // Dedicated admin gate: NO redirect to the customer /login page.
  const gateForm = document.getElementById('ad-form');
  if(gateForm) gateForm.addEventListener('submit', e=>{ e.preventDefault(); adLogin(); });
  const u = await API.me();
  if(!u){ return; } // gate (login card) stays visible
  const roles = u.roles || [];
  if(!roles.some(r => r === 'super_admin' || r === 'admin')){
    document.getElementById('gate-box').innerHTML = `
      <div style="text-align:center;font-size:40px">🚫</div>
      <h3 style="text-align:center">دسترسی ندارید</h3>
      <p class="muted" style="text-align:center">این حساب، مدیر نیست. فقط حساب مدیر می‌تواند وارد شود.</p>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:14px">
        <button class="btn btn-secondary" onclick="logout()">خروج از حساب</button>
        <a class="btn btn-primary" href="/">بازگشت به سایت</a>
      </div>`;
    document.getElementById('admin-nav').style.display = '';
    $('who').textContent = u.email;
    return;
  }
  enterPanel(u);
})().catch(e=>{
  const el = document.getElementById('ad-err');
  if(el){ el.textContent = e.message; el.classList.remove('hidden'); }
});
