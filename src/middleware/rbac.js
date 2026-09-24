'use strict';
const { db } = require('../db');
const { audit } = require('../services/audit');

const ROLE_RANK = { staff:1, owner:2, support:3, admin:4, super_admin:5 };
function hasRole(user, ...roles){
  if(!user) return false;
  return roles.some(r => user.roles.includes(r));
}
function requireRole(...roles){
  return (req, res, next) => {
    if(!req.user) return res.status(401).json({ error:'unauthorized' });
    if(!hasRole(req.user, ...roles)){
      audit({ actorUserId: req.user.id, actorRole: req.user.roles.join(','), action: 'rbac.denied', entity: 'route', entityId: req.originalUrl, ip: req.ip });
      return res.status(403).json({ error:'forbidden', message: 'دسترسی ندارید' });
    }
    next();
  };
}
const isSuper = u => hasRole(u,'super_admin');
const isAdmin = u => hasRole(u,'super_admin','admin');
const isSupport = u => hasRole(u,'super_admin','admin','support');
const isOwnerish = u => hasRole(u,'super_admin','admin','owner');

/**
 * Tenant isolation: resolve :gamenetId (or body/query) and ensure
 * current user is owner/staff of that tenant OR platform admin.
 * NEVER trusts client-only tenant ids without this check.
 */
function requireTenant(param='gamenetId'){
  return (req, res, next) => {
    const id = Number(req.params[param] || req.body[param] || req.query[param]);
    if(!id) return res.status(400).json({ error:'tenant_required' });
    const g = db.prepare('SELECT * FROM gamenets WHERE id=? AND status!=?').get(id, 'deleted');
    if(!g) return res.status(404).json({ error:'tenant_not_found' });
    if(isAdmin(req.user)){
      req.gamenet = g; req.tenantAccess = 'platform'; return next();
    }
    const member = db.prepare(`SELECT * FROM gamenet_members WHERE gamenet_id=? AND user_id=?`).get(id, req.user.id);
    if(member){
      req.gamenet = g; req.tenantAccess = member.member_role; req.member = member; return next();
    }
    audit({ actorUserId: req.user.id, actorRole: req.user.roles.join(','), gamenetId: id, action: 'tenant.isolation_denied', entity: 'gamenet', entityId: id, ip: req.ip });
    return res.status(403).json({ error:'tenant_forbidden', message: 'به داده‌های این گیم‌نت دسترسی ندارید' });
  };
}
/** Extra guard: only owner+ can mutate tenant settings */
function requireTenantOwner(req, res, next){
  if(req.tenantAccess === 'platform' || req.tenantAccess === 'owner') return next();
  return res.status(403).json({ error:'forbidden', message: 'فقط مالک گیم‌نت می‌تواند این عمل را انجام دهد' });
}
module.exports = { hasRole, requireRole, isSuper, isAdmin, isSupport, isOwnerish, requireTenant, requireTenantOwner };
