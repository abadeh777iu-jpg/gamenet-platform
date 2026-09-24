'use strict';
const crypto = require('crypto');
const config = require('../config');

function b64url(buf){ return Buffer.from(buf).toString('base64url'); }
function sign(payload, secret, ttl){
  const header = b64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const now = Math.floor(Date.now()/1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttl }));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verify(token, secret){
  try{
    const [h,b,s] = String(token).split('.');
    if(!h||!b||!s) return null;
    const expect = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
    const a = Buffer.from(s); const c = Buffer.from(expect);
    if(a.length !== c.length || !crypto.timingSafeEqual(a,c)) return null;
    const payload = JSON.parse(Buffer.from(b,'base64url').toString('utf8'));
    if(payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  }catch(e){ return null; }
}
function signAccess(user){
  return sign({ sub: user.id, roles: user.roles }, config.jwt.accessSecret, config.jwt.accessTtl);
}
function signRefresh(user, sid){
  return sign({ sub: user.id, sid }, config.jwt.refreshSecret, config.jwt.refreshTtl);
}
function verifyAccess(t){ return verify(t, config.jwt.accessSecret); }
function verifyRefresh(t){ return verify(t, config.jwt.refreshSecret); }
module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh };
