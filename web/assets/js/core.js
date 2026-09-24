'use strict';
/** Shared API client: cookie auth + CSRF + refresh on 401 */
const API = {
  csrf: null,
  user: null,
  init(){
    const m = document.cookie.match(/(?:^|;\s*)gn_csrf=([^;]+)/);
    this.csrf = m ? decodeURIComponent(m[1]) : null;
  },
  async ensureCsrf(){
    this.init();
    if(this.csrf) return this.csrf;
    // obtain gn_csrf cookie via safe GET
    await fetch('/api/health', { credentials:'same-origin' });
    this.init();
    return this.csrf || '';
  },
  async request(path, { method='GET', body, headers={}, raw=false } = {}){
    const isMut = !['GET','HEAD','OPTIONS'].includes(method);
    if(isMut) await this.ensureCsrf();
    else if(!this.csrf) this.init();
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': this.csrf || '',
        ...headers,
      },
      credentials: 'same-origin',
    };
    if(body !== undefined && !(body instanceof FormData)) opts.body = JSON.stringify(body);
    if(body instanceof FormData){ delete opts.headers['Content-Type']; opts.body = body; }
    let res = await fetch(path, opts);
    // CSRF cookie missing/expired → bootstrap once and retry mutation
    if(res.status === 403 && isMut){
      let d = null; try{ d = await res.clone().json(); }catch(e){}
      if(d && d.error === 'csrf_failed'){
        this.csrf = null;
        await this.ensureCsrf();
        opts.headers['x-csrf-token'] = this.csrf || '';
        res = await fetch(path, opts);
      }
    }
    if(res.status === 401 && !path.includes('/auth/login') && !path.includes('/auth/register')){
      await this.ensureCsrf();
      const r = await fetch('/api/auth/refresh', { method:'POST', credentials:'same-origin', headers:{ 'x-csrf-token': this.csrf||'' }});
      if(r.ok){
        this.init();
        // re-issue opts headers with fresh csrf
        opts.headers['x-csrf-token'] = this.csrf || '';
        res = await fetch(path, opts);
      }
    }
    if(raw) return res;
    let data = null;
    try{ data = await res.json(); }catch(e){ data = {}; }
    if(!res.ok){
      const err = new Error(data.message || data.error || ('HTTP '+res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  },
  get(p, o){ return this.request(p, { ...o, method:'GET' }); },
  post(p, body, o){ return this.request(p, { ...o, method:'POST', body }); },
  put(p, body, o){ return this.request(p, { ...o, method:'PUT', body }); },
  del(p, o){ return this.request(p, { ...o, method:'DELETE' }); },
  async me(){
    try{
      const d = await this.get('/api/auth/me');
      this.user = d.user;
      return d.user;
    }catch(e){ this.user = null; return null; }
  },
};
function toast(msg, type='ok'){
  let el = document.getElementById('toast');
  if(!el){
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 18px;border-radius:12px;font-size:13px;font-weight:700;box-shadow:0 8px 30px rgba(0,0,0,.4);transition:.25s;max-width:90vw';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = type==='err' ? '#e11d48' : type==='warn' ? '#d97706' : '#059669';
  el.style.color = '#fff';
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.style.opacity='0'; }, 2800);
}
function fmtMoney(cents){
  return Number(cents||0).toLocaleString('fa-IR') + ' ریال';
}
function fmtBytes(b){
  if(b == null) return '—';
  const u = ['B','KB','MB','GB','TB']; let i=0; let n=Number(b);
  while(n>=1024 && i<u.length-1){ n/=1024; i++; }
  return n.toFixed(n<10 && i>0 ? 1 : 0) + ' ' + u[i];
}
function qs(name){ return new URLSearchParams(location.search).get(name); }
function requireAuth(roles){
  return API.me().then(u => {
    if(!u){ location.href = '/login?next=' + encodeURIComponent(location.pathname+location.search); return null; }
    if(roles && !roles.some(r => u.roles.includes(r))){
      toast('دسترسی ندارید', 'err');
      location.href = '/';
      return null;
    }
    return u;
  });
}
function esc(s){ return String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
API.init();
