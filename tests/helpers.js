'use strict';
process.env.NODE_ENV = 'test';
process.env.DB_PATH = require('path').join(__dirname, '.test.db');
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret-please-change-0000000000000000';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-please-change-0000000000000';
process.env.COOKIE_SECURE = '0';
const fs = require('fs');
for(const f of [process.env.DB_PATH, process.env.DB_PATH+'-wal', process.env.DB_PATH+'-shm']){
  try{ fs.unlinkSync(f); }catch(e){}
}
const { migrate } = require('../src/db/migrate');
migrate();
const { seed } = require('../src/db/seed');
seed();
const app = require('../src/app');

function mergeJar(jar, setCookie){
  for(const c of setCookie||[]){
    const kv = c.split(';')[0];
    const name = kv.split('=')[0] + '=';
    if(jar.includes(name)) jar = jar.replace(new RegExp(name + '[^;]*'), kv);
    else jar = jar ? jar + '; ' + kv : kv;
  }
  return jar;
}
function csrfOfJar(jar){
  const m = /gn_csrf=([^;]+)/.exec(jar||'');
  return m ? m[1] : '';
}

async function req(app, method, path, { body, cookie, headers } = {}){
  const server = app.listen(0);
  try{
    const base = `http://127.0.0.1:${server.address().port}`;
    let jar = cookie || '';
    let setCookieAll = [];
    const isMut = !['GET','HEAD','OPTIONS'].includes(method);

    // Double-submit CSRF: ensure cookie exists before any mutation
    if(isMut){
      let need = !csrfOfJar(jar);
      if(need){
        const g = await fetch(base + '/api/health');
        const sc = g.headers.getSetCookie ? g.headers.getSetCookie() : [];
        setCookieAll.push(...sc);
        jar = mergeJar(jar, sc);
      }
    }

    const csrf = csrfOfJar(jar);
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(jar ? { Cookie: jar } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(headers || {}),
      },
      body: body !== undefined && body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const sc2 = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    setCookieAll.push(...sc2);
    jar = mergeJar(jar, sc2);
    const data = await res.json().catch(()=>({}));
    return { status: res.status, data, setCookie: setCookieAll, raw: res, jar, csrf };
  } finally {
    server.close();
  }
}

function cookieJar(setCookie){ return mergeJar('', setCookie||[]); }
function csrfOf(setCookie){
  const line = (setCookie||[]).find(c => c.startsWith('gn_csrf='));
  return line ? line.split(';')[0].split('=')[1] : '';
}
module.exports = { app, req, cookieJar, csrfOf };
