'use strict';
/** Express (req,res) ↔ Fetch Request/Response adapter — no Node stream dependency. */

function headersToNode(request){
  const out = {};
  for(const [k,v] of request.headers){
    out[k.toLowerCase()] = v;
  }
  return out;
}

async function expressHandler(app, request, env){
  const url = new URL(request.url);

  let rawBody = null;
  if(request.method !== 'GET' && request.method !== 'HEAD'){
    const buf = await request.arrayBuffer();
    rawBody = Buffer.from(buf);
  }

  const ct = request.headers.get('content-type') || '';

  const req = {
    method: request.method,
    url: url.pathname + url.search,
    originalUrl: url.pathname + url.search,
    path: url.pathname,
    baseUrl: '',
    params: {},
    query: Object.fromEntries(url.searchParams),
    headers: headersToNode(request),
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    connection: {},
    socket: { encrypted: true },
    ip: request.headers.get('cf-connecting-ip') || '0.0.0.0',
    ips: [],
    env: env,
    app: {
      get: (k) => (k === 'env_obj' ? env : undefined),
      set(){}, use(){},
    },
    body: {},
    cookies: {},
    signedCookies: {},
    get(name){ return this.headers[String(name).toLowerCase()]; },
    set(){},
    accepts(){ return 'json'; },
    is(){ return ct; },
    param(){ return undefined; },
    range(){ return undefined; },
    // streams for multer shim
    async arrayBuffer(){
      if(!rawBody) return new ArrayBuffer(0);
      return rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength);
    },
  };
  if(rawBody && rawBody.length){
    req.headers['content-length'] = String(rawBody.length);
    req.rawBody = rawBody;
    req._body = true; /* body-parser skip */
    req._body = true; /* body-parser skip */
    req._body = true; /* body-parser skip */
    req._body = true; /* body-parser skip */
    req._body = true; /* body-parser skip */
    req._body = true; /* body-parser skip when pre-parsed */
    req._body = true; /* body-parser skip */
    if(ct.includes('application/json')){
      try{ req.body = JSON.parse(rawBody.toString('utf8')); }catch(e){ req.body = {}; }
    } else if(ct.includes('application/x-www-form-urlencoded')){
      req.body = Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')));
    } else if(!ct.includes('multipart/form-data')){
      req.body = rawBody;
    } else {
      req.body = {};
    }
    req._body = true;
  } else if (ct.includes('application/json') || ct.includes('application/x-www-form-urlencoded')) {
    req._body = true;
  } else {
    req._body = true;
  }

  if (typeof req._body === 'undefined') req._body = true; /* body already materialized or empty */
  // parse cookies simply
  if(req.headers.cookie){
    for(const part of String(req.headers.cookie).split(';')){
      const i = part.indexOf('=');
      if(i > 0) req.cookies[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
    }
  }

  if (req._body !== true) req._body = true; /*force—body already materialized*/
  let statusCode = 200;
  const resHeaders = [];
  let chunks = [];
  let finished = false;

  const res = {
    statusCode: 200,
    get headersSent(){ return finished; },
    set headersSent(v){},
    writableEnded: false,
    finished: false,
    locals: {},
    setHeader(name, value){
      resHeaders.push([String(name).toLowerCase(), value]);
      return this;
    },
    getHeader(name){
      const n = String(name).toLowerCase();
      const h = resHeaders.find(x => x[0] === n);
      return h ? h[1] : undefined;
    },
    getHeaders(){
      const o = {};
      for(const [k,v] of resHeaders) o[k] = v;
      return o;
    },
    removeHeader(name){
      const n = String(name).toLowerCase();
      const i = resHeaders.findIndex(x => x[0] === n);
      if(i >= 0) resHeaders.splice(i,1);
    },
    writeHead(code, msg, hdrs){
      statusCode = code;
      this.statusCode = code;
      const h = (msg && typeof msg === 'object') ? msg : hdrs;
      if(h) for(const [k,v] of Object.entries(h)) this.setHeader(k, v);
      return this;
    },
    write(chunk, enc, cb){
      if(chunk) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8') : chunk);
      if(typeof enc === 'function') enc();
      if(typeof cb === 'function') cb();
      return true;
    },
    end(chunk, enc, cb){
      if(chunk && typeof chunk !== 'function') this.write(chunk, typeof enc === 'string' ? enc : 'utf8');
      finished = true;
      this.writableEnded = true;
      this.finished = true;
      const done = typeof chunk === 'function' ? chunk : (typeof enc === 'function' ? enc : cb);
      if(done) done();
      return this;
    },
    send(body){
      if(body != null && typeof body !== 'function'){
        if(typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)){
          if(!this.getHeader('content-type')) this.setHeader('content-type', 'application/json; charset=utf-8');
          this.end(JSON.stringify(body));
        } else {
          this.end(body);
        }
      } else this.end();
    },
    json(obj){
      this.setHeader('content-type', 'application/json; charset=utf-8');
      this.end(JSON.stringify(obj));
    },
    status(code){ statusCode = code; this.statusCode = code; return this; },
    sendStatus(code){ statusCode = code; this.statusCode = code; this.end(); },
    type(t){ this.setHeader('content-type', t); return this; },
    cookie(name, value, opts){
      let c = `${name}=${encodeURIComponent(value)}`;
      if(opts){
        if(opts.maxAge != null) c += `; Max-Age=${Math.floor(opts.maxAge/1000)}`;
        if(opts.expires) c += `; Expires=${new Date(opts.expires).toUTCString()}`;
        if(opts.path) c += `; Path=${opts.path}`;
        if(opts.httpOnly) c += '; HttpOnly';
        if(opts.secure) c += '; Secure';
        if(opts.sameSite) c += `; SameSite=${opts.sameSite === true ? 'Lax' : opts.sameSite}`;
        if(opts.domain) c += `; Domain=${opts.domain}`;
      }
      resHeaders.push(['set-cookie', c]);
      return this;
    },
    clearCookie(name, opts={}){
      return this.cookie(name, '', { ...opts, maxAge: 0, expires: new Date(0) });
    },
    redirect(codeOrLoc, loc){
      let code = 302;
      let location = loc;
      if(typeof codeOrLoc === 'string'){ location = codeOrLoc; }
      else code = codeOrLoc;
      statusCode = code; this.statusCode = code;
      this.setHeader('location', location);
      this.end();
    },
    render(){ this.end(); },
    format(){ this.end(); },
    append(name, value){ this.setHeader(name, value); return this; },
    set(...args){
      if(args.length >= 2) this.setHeader(args[0], args[1]);
      else if(args[0]) for(const [k,v] of Object.entries(args[0])) this.setHeader(k,v);
      return this;
    },
    get(name){ return this.getHeader(name); },
    vary(){ return this; },
    flushHeaders(){},
    writeProcessing(){},
    attachment(){ return this; },
    sendFile(){ this.end(); },
    download(){ this.end(); },
    links(){ return this; },
    location(){ return this; },
    toString(){ return ''; },
  };
  req.res = res;
  res.req = req;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if(!settled){ settled = true; resolve(); } };
    const origEnd = res.end;
    res.end = function(...args){
      const r = origEnd.apply(this, args);
      finish();
      return r;
    };
    try{
      const ret = app(req, res, (err) => {
        if(err && !settled){
          statusCode = err.status || err.statusCode || 500;
          chunks = [Buffer.from(JSON.stringify({ error: err.message || 'internal' }))];
          if(!resHeaders.some(h => h[0]==='content-type')){
            resHeaders.push(['content-type','application/json; charset=utf-8']);
          }
        }
        finish();
      });
      if(ret && typeof ret.then === 'function'){
        ret.then(() => finish()).catch(err => {
          if(!settled){
            statusCode = err.status || 500;
            chunks = [Buffer.from(JSON.stringify({ error: err.message }))];
            finish();
          }
        });
      }
    } catch(err){
      statusCode = err.status || 500;
      chunks = [Buffer.from(JSON.stringify({ error: err.message }))];
      finish();
    }
    setTimeout(finish, 25000);
  });

  const bodyBuf = Buffer.concat(chunks.map(c => (typeof c === 'string' ? Buffer.from(c) : c)));
  const headerBag = new Headers();
  const setCookies = [];
  for(const [k, v] of resHeaders){
    if(k === 'set-cookie'){
      if(Array.isArray(v)) setCookies.push(...v);
      else setCookies.push(v);
    } else if(v !== undefined && v !== null){
      try{ headerBag.set(k, Array.isArray(v) ? v.join(', ') : String(v)); }catch(e){}
    }
  }
  for(const sc of setCookies) headerBag.append('set-cookie', sc);
  const st = (statusCode >= 200 && statusCode <= 599) ? statusCode : 200;
  let respBody = null;
  if (bodyBuf.length) {
    respBody = bodyBuf.toString('utf8');
  }
  try {
    return new Response(respBody, { status: st, headers: headerBag });
  } catch (e) {
    return new Response(null, { status: st, headers: headerBag });
  }
}

module.exports = { expressHandler };
