'use strict';
const express = require('express');
const { db, tx } = require('../db');
const { hashPassword, verifyPassword } = require('../services/password');
const { randomToken, sha256, publicId } = require('../services/ids');
const { signAccess, signRefresh, verifyRefresh } = require('../services/jwt');
const { setAuthCookies, clearAuthCookies } = require('../middleware/security');
const { requireAuth, loadUser } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { sendEmail } = require('../services/email');
const { audit } = require('../services/audit');
const { notify } = require('../services/notification');
const config = require('../config');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createSession(res, user){
  const sid = publicId('sess');
  const access = signAccess(user);
  const refresh = signRefresh(user, sid);
  const expires = new Date(Date.now() + config.jwt.refreshTtl*1000).toISOString().slice(0,19).replace('T',' ');
  db.prepare(`INSERT INTO auth_sessions(id,user_id,refresh_hash,expires_at) VALUES(?,?,?,?)`)
    .run(sid, user.id, sha256(refresh), expires);
  setAuthCookies(res, { access, refresh });
  return { sid, access, refresh };
}

router.post('/register', rateLimit({ max: 10, windowMs: 60000 }), asyncHandler(async (req,res)=>{
  const { email, password, name } = req.body || {};
  if(!email || !EMAIL_RE.test(email)) return res.status(400).json({ error:'invalid_email', message:'ایمیل معتبر نیست' });
  if(!password || password.length < 8) return res.status(400).json({ error:'weak_password', message:'رمز باید حداقل ۸ کاراکتر باشد' });
  const emailNorm = String(email).toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(emailNorm);
  if(exists) return res.status(409).json({ error:'email_exists', message:'این ایمیل قبلاً ثبت شده' });
  // Without an SMTP provider no verification mail can ever be delivered —
  // auto-verify so customers are never blocked; with SMTP the strict flow applies.
  const autoVerify = !config.email.smtpUrl;
  const r = autoVerify
    ? db.prepare(`INSERT INTO users(email,password_hash,name,email_verified_at) VALUES(?,?,?,datetime('now'))`)
        .run(emailNorm, hashPassword(password), String(name||'').slice(0,80))
    : db.prepare(`INSERT INTO users(email,password_hash,name) VALUES(?,?,?)`)
        .run(emailNorm, hashPassword(password), String(name||'').slice(0,80));
  const uid = r.lastInsertRowid;
  // verify token
  const vt = randomToken(32);
  const exp = new Date(Date.now()+24*3600000).toISOString().slice(0,19).replace('T',' ');
  db.prepare(`INSERT INTO auth_tokens(user_id,purpose,token_hash,expires_at) VALUES(?,'verify_email',?,?)`)
    .run(uid, sha256(vt), exp);
  sendEmail({ to: email, subject: 'تأیید ایمیل — GameNet Platform', body: `کد/لینک تأیید: ${config.appUrl}/verify?token=${vt}` });
  audit({ actorUserId: uid, actorRole:'customer', action:'auth.register', entity:'user', entityId: uid, ip: req.ip });
  const user = loadUser(uid);
  const sess = createSession(res, user);
  res.status(201).json({ ok:true, user: publicUser(user), access: sess.access, refresh: sess.refresh, verify_token_dev: config.isProd ? undefined : vt });
}));

function publicUser(u){
  return { id:u.id, email:u.email, name:u.name, avatar_url:u.avatar_url, roles:u.roles, email_verified_at:u.email_verified_at };
}

router.post('/login', rateLimit({ max: 15, windowMs: 60000, keyFn: r => r.ip + '|login' }), asyncHandler(async (req,res)=>{
  const { email, password } = req.body || {};
  if(!email || !password) return res.status(400).json({ error:'missing_fields' });
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase());
  if(!u || !u.password_hash || !verifyPassword(password, u.password_hash)){
    audit({ action:'auth.login_fail', entity:'user', entityId: u?u.id:'', meta:{ email }, ip: req.ip });
    return res.status(401).json({ error:'invalid_credentials', message:'ایمیل یا رمز اشتباه است' });
  }
  if(u.status !== 'active') return res.status(403).json({ error:'account_suspended', message:'حساب معلق است' });
  const user = loadUser(u.id);
  const sess = createSession(res, user);
  db.prepare(`UPDATE auth_sessions SET user_agent=?, ip=? WHERE user_id=? AND revoked_at IS NULL AND id=(SELECT MAX(id) FROM auth_sessions WHERE user_id=?)`)
    .run(String(req.get('user-agent')||'').slice(0,200), req.ip, u.id, u.id);
  audit({ actorUserId: u.id, actorRole: user.roles.join(','), action:'auth.login', entity:'user', entityId: u.id, ip: req.ip });
  res.json({ ok:true, user: publicUser(user), access: sess.access, refresh: sess.refresh });
}));

router.post('/refresh', rateLimit({ max: 60 }), asyncHandler(async (req,res)=>{
  const rt = (req.body && req.body.refresh_token) || (req.cookies && req.cookies.gn_rt);
  if(!rt) return res.status(401).json({ error:'no_refresh' });
  const p = verifyRefresh(rt);
  if(!p || !p.sid) return res.status(401).json({ error:'bad_refresh' });
  const sess = db.prepare(`SELECT * FROM auth_sessions WHERE id=? AND revoked_at IS NULL AND expires_at > datetime('now')`).get(p.sid);
  if(!sess || sess.refresh_hash !== sha256(rt)) return res.status(401).json({ error:'session_invalid' });
  const user = loadUser(p.sub);
  if(!user) return res.status(401).json({ error:'user_inactive' });
  // rotate
  const newRefresh = signRefresh(user, sess.id);
  db.prepare(`UPDATE auth_sessions SET refresh_hash=?, last_seen_at=datetime('now') WHERE id=?`).run(sha256(newRefresh), sess.id);
  const access = signAccess(user);
  setAuthCookies(res, { access, refresh: newRefresh });
  res.json({ ok:true, user: publicUser(user), access, refresh: newRefresh });
}));

router.post('/logout', requireAuth, asyncHandler(async (req,res)=>{
  const rt = (req.body && req.body.refresh_token) || (req.cookies && req.cookies.gn_rt);
  if(rt){
    const p = verifyRefresh(rt);
    if(p && p.sid) db.prepare(`UPDATE auth_sessions SET revoked_at=datetime('now') WHERE id=?`).run(p.sid);
  }
  clearAuthCookies(res);
  audit({ actorUserId: req.user.id, actorRole:req.user.roles.join(','), action:'auth.logout', entity:'user', entityId:req.user.id, ip:req.ip });
  res.json({ ok:true });
}));

router.post('/logout-all', requireAuth, asyncHandler(async (req,res)=>{
  db.prepare(`UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`).run(req.user.id);
  clearAuthCookies(res);
  audit({ actorUserId: req.user.id, actorRole:req.user.roles.join(','), action:'auth.logout_all', entity:'user', entityId:req.user.id, ip:req.ip });
  res.json({ ok:true });
}));

router.get('/sessions', requireAuth, asyncHandler(async (req,res)=>{
  const rows = db.prepare(`SELECT id, user_agent, ip, created_at, last_seen_at, expires_at FROM auth_sessions
    WHERE user_id=? AND revoked_at IS NULL ORDER BY last_seen_at DESC`).all(req.user.id);
  res.json({ sessions: rows });
}));

router.post('/forgot', rateLimit({ max: 5, windowMs: 60000 }), asyncHandler(async (req,res)=>{
  const { email } = req.body || {};
  const u = db.prepare('SELECT id,email FROM users WHERE email=?').get(String(email||'').toLowerCase());
  // always OK to avoid enumeration
  if(u){
    const t = randomToken(32);
    const exp = new Date(Date.now()+3600000).toISOString().slice(0,19).replace('T',' ');
    db.prepare(`INSERT INTO auth_tokens(user_id,purpose,token_hash,expires_at) VALUES(?,'reset_password',?,?)`)
      .run(u.id, sha256(t), exp);
    sendEmail({ to: u.email, subject:'بازنشانی رمز', body:`بازنشانی: ${config.appUrl}/reset?token=${t}` });
    audit({ actorUserId:u.id, action:'auth.forgot', entity:'user', entityId:u.id, ip:req.ip });
  }
  res.json({ ok:true, message:'در صورت وجود حساب، لینک ارسال شد', dev_token: config.isProd?undefined:undefined });
}));

router.post('/reset', rateLimit({ max: 10, windowMs: 60000 }), asyncHandler(async (req,res)=>{
  const { token, password } = req.body || {};
  if(!token || !password || password.length < 8) return res.status(400).json({ error:'invalid_input' });
  const row = db.prepare(`SELECT * FROM auth_tokens WHERE token_hash=? AND purpose='reset_password' AND used_at IS NULL AND expires_at > datetime('now')`).get(sha256(token));
  if(!row) return res.status(400).json({ error:'invalid_token', message:'لینک نامعتبر یا منقضی' });
  tx(()=>{
    db.prepare(`UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?`).run(hashPassword(password), row.user_id);
    db.prepare(`UPDATE auth_tokens SET used_at=datetime('now') WHERE id=?`).run(row.id);
    db.prepare(`UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`).run(row.user_id);
  });
  audit({ actorUserId: row.user_id, action:'auth.reset_password', entity:'user', entityId: row.user_id, ip: req.ip });
  notify({ userId: row.user_id, type:'security', title:'رمز عبور تغییر کرد', body:'در صورتی که شما نبودید، فوراً با پشتیبانی تماس بگیرید.' });
  res.json({ ok:true });
}));

router.post('/verify-email', rateLimit({ max: 20 }), asyncHandler(async (req,res)=>{
  const { token } = req.body || {};
  const row = db.prepare(`SELECT * FROM auth_tokens WHERE token_hash=? AND purpose='verify_email' AND used_at IS NULL AND expires_at > datetime('now')`).get(sha256(String(token||'')));
  if(!row) return res.status(400).json({ error:'invalid_token' });
  db.prepare(`UPDATE users SET email_verified_at=datetime('now') WHERE id=?`).run(row.user_id);
  db.prepare(`UPDATE auth_tokens SET used_at=datetime('now') WHERE id=?`).run(row.id);
  audit({ actorUserId: row.user_id, action:'auth.email_verified', entity:'user', entityId: row.user_id, ip:req.ip });
  res.json({ ok:true });
}));

router.get('/me', requireAuth, asyncHandler(async (req,res)=>{
  const sessions = db.prepare(`SELECT COUNT(*) c FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL`).get(req.user.id).c;
  res.json({ user: publicUser(req.user), session_count: sessions });
}));

/** Google Login — verifies ID token when GOOGLE_CLIENT_ID configured. */
router.post('/google', rateLimit({ max: 10 }), asyncHandler(async (req,res)=>{
  if(!config.googleClientId) return res.status(501).json({ error:'google_disabled', message:'ورود گوگل پیکربندی نشده (GOOGLE_CLIENT_ID)' });
  const { credential } = req.body || {};
  if(!credential) return res.status(400).json({ error:'missing_credential' });
  // Verify via Google tokeninfo (no secret in code)
  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
  const resp = await fetch(url);
  if(!resp.ok) return res.status(401).json({ error:'google_invalid' });
  const info = await resp.json();
  if(info.aud !== config.googleClientId) return res.status(401).json({ error:'google_aud_mismatch' });
  const email = info.email;
  let u = db.prepare('SELECT id FROM users WHERE email=? OR google_sub=?').get(email, info.sub);
  if(!u){
    const r = db.prepare(`INSERT INTO users(email,name,google_sub,email_verified_at) VALUES(?,?,?,datetime('now'))`)
      .run(email, info.name||email, info.sub);
    u = { id: r.lastInsertRowid };
    audit({ actorUserId:u.id, action:'auth.register_google', entity:'user', entityId:u.id, ip:req.ip });
  } else if(!u.google_sub){
    db.prepare('UPDATE users SET google_sub=? WHERE id=?').run(info.sub, u.id);
  }
  const user = loadUser(u.id);
  if(user.status !== 'active') return res.status(403).json({ error:'account_suspended' });
  const sess = createSession(res, user);
  res.json({ ok:true, user: publicUser(user), access: sess.access, refresh: sess.refresh });
}));

module.exports = router;
module.exports.publicUser = publicUser;
