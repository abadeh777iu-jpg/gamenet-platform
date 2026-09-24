'use strict';
const { db } = require('../db');
const { verifyAccess, verifyRefresh, signAccess, signRefresh } = require('../services/jwt');
const { setAuthCookies, clearAuthCookies } = require('./security');
const { randomToken, sha256 } = require('../services/ids');
const config = require('../config');

function loadUser(userId){
  const u = db.prepare(`SELECT id,email,name,avatar_url,status,email_verified_at,created_at FROM users WHERE id=?`).get(userId);
  if(!u || u.status !== 'active') return null;
  const roles = db.prepare(`SELECT role_code FROM user_roles WHERE user_id=?`).all(userId).map(r=>r.role_code);
  return { ...u, roles };
}
function attachUser(req, res, next){
  req.user = null;
  const token = req.cookies && req.cookies.gn_at;
  if(token){
    const p = verifyAccess(token);
    if(p){
      const u = loadUser(p.sub);
      if(u) req.user = u;
    }
  }
  // silent refresh if access expired but refresh valid
  if(!req.user && req.cookies && req.cookies.gn_rt){
    const p = verifyRefresh(req.cookies.gn_rt);
    if(p && p.sid){
      const sess = db.prepare(`SELECT * FROM auth_sessions WHERE id=? AND revoked_at IS NULL AND expires_at > datetime('now')`).get(p.sid);
      if(sess && sha256(req.cookies.gn_rt) === sess.refresh_hash){
        const u = loadUser(p.sub);
        if(u){
          req.user = u;
          const access = signAccess(u);
          const newRefresh = signRefresh(u, sess.id);
          db.prepare(`UPDATE auth_sessions SET refresh_hash=?, last_seen_at=datetime('now') WHERE id=?`).run(sha256(newRefresh), sess.id);
          setAuthCookies(res, { access, refresh: newRefresh });
        }
      }
    }
  }
  next();
}
function requireAuth(req, res, next){
  if(!req.user) return res.status(401).json({ error: 'unauthorized', message: 'ابتدا وارد شوید' });
  next();
}
function requireEmailVerified(req, res, next){
  if(!req.user) return res.status(401).json({ error: 'unauthorized' });
  if(!req.user.email_verified_at){
    return res.status(403).json({ error: 'email_not_verified', message: 'ایمیل خود را تأیید کنید' });
  }
  next();
}
module.exports = { loadUser, attachUser, requireAuth, requireEmailVerified };
