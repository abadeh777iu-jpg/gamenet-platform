'use strict';
const __helmetMod = require('helmet');
const helmet = typeof __helmetMod === 'function' ? __helmetMod : (__helmetMod && __helmetMod.default) || __helmetMod;
const config = require('../config');
const { sha256, randomToken } = require('../services/ids');

const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://accounts.google.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://lh3.googleusercontent.com'],
      connectSrc: ["'self'", 'https://accounts.google.com'],
      frameSrc: ["'self'", 'https://accounts.google.com'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  // API responses are fetched cross-origin by the GitHub Pages frontend.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

/**
 * CORS for the split-origin deployment (github.io frontend -> API host).
 * Only explicitly allowed origins get reflected, with credentials allowed.
 * OPTIONS preflight is answered here (204) before any other middleware.
 */
function cors(req, res, next){
  const origin = req.get('origin');
  if(origin && config.corsOrigins.includes(origin)){
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token,Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'X-CSRF-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    if(req.method === 'OPTIONS') return res.status(204).end();
  } else if(req.method === 'OPTIONS'){
    // preflight from a non-allowed origin: no CORS headers, short-circuit
    return res.status(204).end();
  }
  next();
}

function setAuthCookies(res, { access, refresh }){
  const common = { httpOnly: true, secure: config.cookieSecure, sameSite: config.cookieSameSite, path: '/' };
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
    res.cookie('gn_csrf', t, { httpOnly: false, secure: config.cookieSecure, sameSite: config.cookieSameSite, path: '/', maxAge: 8*3600*1000 });
    req.csrfToken = t;
  } else req.csrfToken = req.cookies.gn_csrf;
  next();
}
function csrfProtect(req, res, next){
  if(['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  // allow webhook endpoints (signed by provider, no cookie auth)
  if(req.path.startsWith('/api/payments/webhook')) return next();
  // Header-based requests (Authorization) cannot be forged cross-site: custom
  // headers require a CORS preflight that only allowlisted origins pass.
  if(req.get('authorization')) return next();
  const a = req.cookies && req.cookies.gn_csrf;
  const b = req.get('x-csrf-token');
  if(!a || !b || a !== b){
    return res.status(403).json({ error: 'csrf_failed', message: 'CSRF نامعتبر است' });
  }
  next();
}
module.exports = { securityHeaders, cors, setAuthCookies, clearAuthCookies, csrfIssue, csrfProtect, sha256 };
