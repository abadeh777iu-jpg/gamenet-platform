'use strict';
const __helmetMod = require('helmet');
const helmet = typeof __helmetMod === 'function' ? __helmetMod : (__helmetMod && __helmetMod.default) || __helmetMod;
const config = require('../config');
const { sha256, randomToken } = require('../services/ids');

const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
});

function setAuthCookies(res, { access, refresh }){
  const common = { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' };
  res.cookie('gn_at', access, { ...common, maxAge: config.jwt.accessTtl * 1000 });
  if(refresh) res.cookie('gn_rt', refresh, { ...common, maxAge: config.jwt.refreshTtl * 1000, path: '/api/auth' });
}
function clearAuthCookies(res){
  res.clearCookie('gn_at', { path: '/' });
  res.clearCookie('gn_rt', { path: '/api/auth' });
}
/** Double-submit CSRF for cookie-authenticated mutations. */
function csrfIssue(req, res, next){
  if(!req.cookies.gn_csrf){
    const t = randomToken(24);
    res.cookie('gn_csrf', t, { httpOnly: false, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: 8*3600*1000 });
    req.csrfToken = t;
  } else req.csrfToken = req.cookies.gn_csrf;
  next();
}
function csrfProtect(req, res, next){
  if(['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  // allow webhook endpoints (signed by provider, no cookie auth)
  if(req.path.startsWith('/api/payments/webhook')) return next();
  const a = req.cookies && req.cookies.gn_csrf;
  const b = req.get('x-csrf-token');
  if(!a || !b || a !== b){
    return res.status(403).json({ error: 'csrf_failed', message: 'CSRF نامعتبر است' });
  }
  next();
}
module.exports = { securityHeaders, setAuthCookies, clearAuthCookies, csrfIssue, csrfProtect, sha256 };
