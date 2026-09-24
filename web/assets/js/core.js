'use strict';
/**
 * Shared API client — dual-mode:
 *  - Same-origin (API_BASE empty): httpOnly cookies + double-submit CSRF (unchanged).
 *  - Cross-origin (API_BASE set, github.io): Bearer tokens in memory + refresh
 *    token in localStorage, credentials:'omit' — works in every browser
 *    (Safari blocks third-party cookies, so cookies are never relied on here).
 */
const API = {
  csrf: null,
  user: null,
  access: null,
  init(){
    this.access = null;
    this.rt = null;
    try{ this.rt = localStorage.getItem('gn_rt'); }catch(e){}
    const m = document.cookie.match(/(?:^|;\s*)gn_csrf=([^;]+)/);
    this.csrf = m ? decodeURIComponent(m[1]) : null;
  },
  base(){ return (window.GN_CONFIG && GN_CONFIG.API_BASE) || ''; },
  cross(){ return !!this.base(); },
  url(p){ const b = this.base(); return b ? b + p : p; },
  creds(){ return this.cross() ? 'omit' : 'same-origin'; },
  setTokens(d){
    if(!d) return;
    if(d.access) this.access = d.access;
    if(d.refresh){
      this.rt = d.refresh;
      try{ localStorage.setItem('gn_rt', d.refresh); }catch(e){}
    }
  },
  clearTokens(){
    this.access = null; this.rt = null;
    try{ localStorage.removeItem('gn_rt'); }catch(e){}
  },
  async ensureCsrf(){
    if(this.cross()) return ''; // Authorization header handles CSRF in cross mode
    const m = document.cookie.match(/(?:^|;\s*)gn_csrf=([^;]+)/);
    this.csrf = m ? decodeURIComponent(m[1]) : null;
    if(this.csrf) return this.csrf;
    // obtain gn_csrf cookie + token (returned in body — authoritative)
    try{
      const r = await fetch(this.url('/api/health'), { credentials: this.creds() });
      const d = await r.json();
      if(d && d.csrf) this.csrf = d.csrf;
    }catch(e){}
    if(!this.csrf){
      const m2 = document.cookie.match(/(?:^|;\s*)gn_csrf=([^;]+)/);
      this.csrf = m2 ? decodeURIComponent(m2[1]) : '';
    }
    return this.csrf || '';
  },
  async refreshSession(){
    if(this.cross()){
      if(!this.rt) return false;
      try{
        const r = await fetch(this.url('/api/auth/refresh'), {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer' },
          body: JSON.stringify({ refresh_token: this.rt }),
        });
        if(!r.ok){ this.clearTokens(); return false; }
        const d = await r.json();
        this.setTokens(d);
        return true;
      }catch(e){ return false; }
    }
    try{
      await this.ensureCsrf();
      const r = await fetch(this.url('/api/auth/refresh'), {
        method:'POST', credentials: this.creds(),
        headers:{ 'x-csrf-token': this.csrf || '' },
      });
      if(!r.ok) return false;
      const d = await r.json();
      this.setTokens(d);
      return true;
    }catch(e){ return false; }
  },
  async request(path, { method='GET', body, headers={}, raw=false, _retry=false } = {}){
    const isMut = !['GET','HEAD','OPTIONS'].includes(method);
    if(isMut && !this.cross()) await this.ensureCsrf();
    const opts = { method, headers: {}, credentials: this.creds() };
    if(this.cross()) opts.headers['Authorization'] = this.access ? 'Bearer ' + this.access : 'Bearer';
    if(isMut && !this.cross()) opts.headers['x-csrf-token'] = this.csrf || '';
    // logout needs the refresh token to revoke the session in cross mode
    if(path.includes('/auth/logout') && method === 'POST' && this.cross() && !body){
      body = { refresh_token: this.rt };
    }
    if(body !== undefined && !(body instanceof FormData)){
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if(body instanceof FormData) opts.body = body;
    Object.assign(opts.headers, headers);
    let res = await fetch(this.url(path), opts);
    // CSRF cookie missing/expired → bootstrap once and retry mutation (same-origin)
    if(res.status === 403 && isMut && !this.cross()){
      let d = null; try{ d = await res.clone().json(); }catch(e){}
      if(d && d.error === 'csrf_failed'){
        this.csrf = null;
        await this.ensureCsrf();
        opts.headers['x-csrf-token'] = this.csrf || '';
        res = await fetch(this.url(path), opts);
      }
    }
    if(res.status === 401 && !_retry && !path.includes('/auth/login') && !path.includes('/auth/register')){
      const ok = await this.refreshSession();
      if(ok){
        if(this.cross()) opts.headers['Authorization'] = 'Bearer ' + this.access;
        else opts.headers['x-csrf-token'] = this.csrf || '';
        res = await fetch(this.url(path), opts);
      }
    }
    if(raw) return res;
    let data = null;
    try{ data = await res.json(); }catch(e){ data = {}; }
    if(!res.ok){
      if(res.status === 401) this.clearTokens();
      const err = new Error(data.message || data.error || ('HTTP '+res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    if(data && (data.access || data.refresh)) this.setTokens(data);
    return data;
  },
  get(p, o){ return this.request(p, { ...o, method:'GET' }); },
  post(p, body, o){ return this.request(p, { ...o, method:'POST', body }); },
  put(p, body, o){ return this.request(p, { ...o, method:'PUT', body }); },
  del(p, o){ return this.request(p, { ...o, method:'DELETE' }); },
  async me(){
    if(this.cross() && !this.access && this.rt) await this.refreshSession();
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
