'use strict';
// Define-proof environment marker: wrangler may rewrite `process.env.NODE_ENV`
// expressions at build time, so production mode is published on globalThis and
// src/config.js reads it first. Set at module load — before anything requires config.
globalThis.__GN_ENV = 'production';
const Database = require('better-sqlite3');
const { expressHandler } = require('./express-fetch');

let ready = null;
let app = null;
let loadedVer = null;
let lastVerCheck = 0;

async function init(env){
  const hasKv = !!(env && env.DB);
  let ver = null;
  if(hasKv){
    // Version probe is only needed to notice writes from *other* isolates.
    // KV is eventually consistent anyway — a 2s bound is safe and saves a
    // round-trip on every request.
    if(ready && Date.now() - lastVerCheck < 2000) return ready;
    try{ ver = await env.DB.get('db:version', 'text'); }catch(e){ ver = null; }
    lastVerCheck = Date.now();
  }
  if(ready && ver === loadedVer) return ready;

  ready = (async () => {
    // Deployment runtime is production unless explicitly overridden — must be
    // set BEFORE src/config is required (prod gates, cookie flags, masking).
    globalThis.__GN_ENV = env.NODE_ENV || 'production';
    try{ process.env['NODE_ENV'] = globalThis.__GN_ENV; }catch(e){}
    if(env && env.JWT_ACCESS_SECRET) process.env.JWT_ACCESS_SECRET = env.JWT_ACCESS_SECRET;
    if(env && env.JWT_REFRESH_SECRET) process.env.JWT_REFRESH_SECRET = env.JWT_REFRESH_SECRET;
    if(env && env.APP_URL) process.env.APP_URL = env.APP_URL;
    if(env && env.AI_API_URL) process.env.AI_API_URL = env.AI_API_URL;
    if(env && env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
    if(env && env.RESEND_API_KEY) process.env.RESEND_API_KEY = env.RESEND_API_KEY;
    if(!process.env.APP_URL) process.env.APP_URL = 'https://gamenet-platform.pages.dev';

    const kvGet = hasKv ? (async (k) => env.DB.get(k, 'text')) : null;
    const kvPut = hasKv ? (async (k, v) => env.DB.put(k, v)) : null;
    const force = loadedVer !== null && ver !== loadedVer;
    await Database.__initSqlJs(kvGet, kvPut, force);

    const { migrate } = require('../src/db/migrate');
    try{ migrate(); }catch(e){ console.error('migrate', e); }
    const { seed } = require('../src/db/seed');
    try{ seed(); }catch(e){ console.error('seed', e); }

    app = require('../src/app');
    loadedVer = ver;
    return true;
  })().catch(e => { ready = null; throw e; });
  return ready;
}

async function handleApi(request, env, ctx){
  await init(env);
  const res = await expressHandler(app, request, env);
  if(!['GET','HEAD'].includes(request.method)){
    // Persist outside the critical path: the in-memory DB is already updated,
    // so the client does not wait for the KV snapshot round-trip.
    const p = persistCoalesced(env);
    if(ctx && typeof ctx.waitUntil === 'function'){
      ctx.waitUntil(p.catch(e => console.error('flush(bg)', e)));
    } else {
      try{ await p; }catch(e){ console.error('flush', e); }
    }
  }
  return res;
}

// Single-flight persistence: concurrent mutations share one export+put,
// with a trailing re-run if writes arrive mid-flush, and KV 429 retries.
let flushInflight = null;
let flushRerun = false;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function kvPutRetry(fn, tries){
  let lastErr = null;
  for(let i = 0; i < (tries || 4); i++){
    try{ return await fn(); }
    catch(e){ lastErr = e; await sleep(250 * (i + 1)); }
  }
  throw lastErr;
}

async function persistOnce(env){
  await Database.__flush();
  if(hasKvPut(env)){
    const nv = String(Date.now()) + '-' + Math.random().toString(36).slice(2,8);
    await kvPutRetry(() => env.DB.put('db:version', nv), 4);
    loadedVer = nv;
  }
}

function persistCoalesced(env){
  if(flushInflight){
    flushRerun = true;
    return flushInflight;
  }
  flushInflight = (async () => {
    try{
      do {
        flushRerun = false;
        await persistOnce(env);
      } while(flushRerun);
    } finally {
      flushInflight = null;
    }
  })();
  return flushInflight;
}

function hasKvPut(env){ return !!(env && env.DB && typeof env.DB.put === 'function'); }

module.exports = { handleApi, init };
