'use strict';
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole, requireTenant, isSuper } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/errorHandler');
const { rateLimit } = require('../middleware/rateLimit');
const { listAudit } = require('../services/audit');
const { globalStorageStats, getUsage, recalcStorage } = require('../services/storage');
const { activateSubscription, suspendSubscription, cancelSubscription, renewSubscription } = require('../services/subscription');
const { setLicenseStatus, checkLicense } = require('../services/license');
const { createBackup, listBackups, pruneBackups } = require('../services/backup');
const { myNotifications } = require('../services/notification');
const { listTickets } = require('../services/ticket');
const { expireDue } = require('../services/subscription');
const router = express.Router();
router.use(requireAuth, requireRole('super_admin','admin'));

router.get('/stats', (req,res)=>{
  res.json({
    users: db.prepare(`SELECT COUNT(*) c FROM users WHERE status='active'`).get().c,
    gamenets: db.prepare(`SELECT COUNT(*) c FROM gamenets WHERE status!='deleted'`).get().c,
    active_subs: db.prepare(`SELECT COUNT(*) c FROM subscriptions WHERE status='active'`).get().c,
    revenue_cents: db.prepare(`SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE status='succeeded'`).get().s,
    open_tickets: db.prepare(`SELECT COUNT(*) c FROM support_tickets WHERE status IN ('open','ai_handling','waiting_human')`).get().c,
    pending_orders: db.prepare(`SELECT COUNT(*) c FROM orders WHERE status IN ('created','pending')`).get().c,
    storage: (() => {
      const st = globalStorageStats();
      return { tenants: st.tenants, used: st.used, files: st.files, limit: st.limit_bytes || 0 };
    })(),
  });
});

const USER_STATUSES = ['active','suspended','deleted'];

router.get('/users', (req,res)=>{
  const status = (req.query.status || 'active');
  if(!USER_STATUSES.includes(status)) return res.status(400).json({ error:'bad_status', message:'دسته نامعتبر است' });
  const rows = db.prepare(`
    SELECT u.id,u.email,u.name,u.status,u.email_verified_at,u.created_at,
      (SELECT GROUP_CONCAT(role_code) FROM user_roles WHERE user_id=u.id) roles
    FROM users u WHERE u.status=? ORDER BY u.id DESC LIMIT 500`).all(status);
  const counts = { active:0, suspended:0, deleted:0 };
  for(const r of db.prepare(`SELECT status, COUNT(*) c FROM users GROUP BY status`).all()){
    if(r.status in counts) counts[r.status] = r.c;
  }
  res.json({ users: rows, counts, tab: status });
});

router.post('/users/:id/role', requireRole('super_admin'), asyncHandler(async (req,res)=>{
  const { role, action } = req.body || {};
  const uid = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if(!user) return res.status(404).json({ error:'not_found' });
  if(action === 'revoke'){
    db.prepare(`DELETE FROM user_roles WHERE user_id=? AND role_code=?`).run(uid, role);
  } else {
    db.prepare(`INSERT OR IGNORE INTO user_roles(user_id,role_code) VALUES(?,?)`).run(uid, role);
  }
  listAudit({}).slice(0,0);
  require('../services/audit').audit({ actorUserId:req.user.id, actorRole:req.user.roles.join(','), action:'admin.role_change', entity:'user', entityId:uid, meta:{ role, action }, ip:req.ip });
  res.json({ ok:true });
}));

router.post('/users/:id/status', requireRole('super_admin'), asyncHandler(async (req,res)=>{
  const { status } = req.body || {};
  if(!USER_STATUSES.includes(status)) return res.status(400).json({ error:'bad_status', message:'وضعیت نامعتبر است' });
  const uid = Number(req.params.id);
  if(uid === req.user.id) return res.status(400).json({ error:'cannot_change_self', message:'نمی‌توانید وضعیت حساب خودتان را تغییر دهید' });
  const user = db.prepare('SELECT id, status FROM users WHERE id=?').get(uid);
  if(!user) return res.status(404).json({ error:'not_found', message:'کاربر پیدا نشد' });
  db.prepare('UPDATE users SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(status, uid);
  if(status !== 'active'){
    db.prepare(`UPDATE auth_sessions SET revoked_at=datetime('now') WHERE user_id=?`).run(uid);
  }
  require('../services/audit').audit({ actorUserId:req.user.id, actorRole:req.user.roles.join(','), action:'admin.user_status', entity:'user', entityId:uid, meta:{ from:user.status, to:status }, ip:req.ip });
  res.json({ ok:true, status });
}));

router.get('/gamenets', (req,res)=>{
  const rows = db.prepare(`
    SELECT g.*, u.email owner_email,
      (SELECT status FROM subscriptions s WHERE s.gamenet_id=g.id ORDER BY id DESC LIMIT 1) sub_status,
      (SELECT ends_at FROM subscriptions s WHERE s.gamenet_id=g.id AND s.status='active' ORDER BY id DESC LIMIT 1) sub_ends
    FROM gamenets g JOIN users u ON u.id=g.owner_user_id
    WHERE g.status!='deleted' ORDER BY g.id DESC`).all();
  res.json({ gamenets: rows.map(g => ({ ...g, storage: getUsage(g.id) })) });
});

router.post('/gamenets/:id/status', asyncHandler(async (req,res)=>{
  const { status } = req.body || {};
  if(!['active','suspended'].includes(status)) return res.status(400).json({ error:'bad_status' });
  db.prepare(`UPDATE gamenets SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, Number(req.params.id));
  if(status === 'suspended'){
    db.prepare(`UPDATE subscriptions SET status='suspended' WHERE gamenet_id=? AND status='active'`).run(Number(req.params.id));
    db.prepare(`UPDATE licenses SET status='suspended' WHERE gamenet_id=? AND status='active'`).run(Number(req.params.id));
  }
  require('../services/audit').audit({ actorUserId:req.user.id, actorRole:req.user.roles.join(','), gamenetId:req.params.id, action:'admin.gamenet_status', entity:'gamenet', entityId:req.params.id, meta:{ status }, ip:req.ip });
  res.json({ ok:true });
}));

router.get('/subscriptions', (req,res)=>{
  res.json({ subscriptions: db.prepare(`
    SELECT s.*, g.name gamenet_name, p.name plan_name FROM subscriptions s
    JOIN gamenets g ON g.id=s.gamenet_id JOIN plans p ON p.id=s.plan_id
    ORDER BY s.id DESC LIMIT 200`).all() });
});
router.post('/subscriptions/:id/suspend', asyncHandler(async (req,res)=>{
  suspendSubscription(Number(req.params.id), req.user); res.json({ ok:true });
}));
router.post('/subscriptions/:id/renew', asyncHandler(async (req,res)=>{
  renewSubscription(Number(req.params.id), req.user); res.json({ ok:true });
}));
router.post('/subscriptions/:id/cancel', asyncHandler(async (req,res)=>{
  cancelSubscription(Number(req.params.id), req.user, { atPeriodEnd:false }); res.json({ ok:true });
}));

router.get('/licenses', (req,res)=>{
  res.json({ licenses: db.prepare(`
    SELECT l.*, g.name gamenet_name FROM licenses l JOIN gamenets g ON g.id=l.gamenet_id
    ORDER BY l.id DESC LIMIT 200`).all() });
});
router.post('/licenses/:id/status', asyncHandler(async (req,res)=>{
  const { status } = req.body || {};
  if(!['active','revoked','suspended','expired'].includes(status)) return res.status(400).json({ error:'bad_status' });
  res.json({ license: setLicenseStatus(Number(req.params.id), status, req.user) });
}));

router.get('/payments', (req,res)=>{
  res.json({ payments: db.prepare(`
    SELECT p.*, o.public_id order_public, o.user_id, o.status order_status, o.gamenet_id,
           u.email, u.name user_name, pl.name plan_name
    FROM payments p
    JOIN orders o ON o.id=p.order_id JOIN users u ON u.id=o.user_id JOIN plans pl ON pl.id=o.plan_id
    ORDER BY (p.status='pending') DESC, p.id DESC LIMIT 300`).all(),
    invoices: db.prepare(`SELECT * FROM invoices ORDER BY id DESC LIMIT 100`).all() });
});

/** Admin confirms a card-to-card payment → order paid + subscription/license activated. */
router.post('/payments/:id/confirm', asyncHandler(async (req,res)=>{
  const r = require('../services/payment').confirmManualPayment(Number(req.params.id), req.user);
  res.json({ ok:true, ...r });
}));
/** Admin rejects a submission → customer may resubmit. */
router.post('/payments/:id/reject', asyncHandler(async (req,res)=>{
  const r = require('../services/payment').rejectManualPayment(Number(req.params.id), req.user, req.body?.reason);
  res.json({ ok:true, ...r });
}));
/** Manually verify a user's email (customer support flow). */
router.post('/users/:id/verify-email', asyncHandler(async (req,res)=>{
  const uid = Number(req.params.id);
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(uid);
  if(!u) return res.status(404).json({ error:'not_found' });
  db.prepare('UPDATE users SET email_verified_at=COALESCE(email_verified_at, datetime(\'now\')) WHERE id=?').run(uid);
  require('../services/audit').audit({ actorUserId:req.user.id, actorRole:req.user.roles.join(','), action:'admin.verify_email', entity:'user', entityId:uid, ip:req.ip });
  res.json({ ok:true });
}));

router.get('/tickets', (req,res)=>{
  res.json({ tickets: listTickets({ limit: 100, status: req.query.status || null }) });
});

router.get('/storage', (req,res)=>{
  const rows = db.prepare(`
    SELECT g.id, g.name, g.storage_limit_bytes, su.used_bytes, su.file_count, su.updated_at
    FROM gamenets g LEFT JOIN storage_usage su ON su.gamenet_id=g.id
    WHERE g.status!='deleted' ORDER BY su.used_bytes DESC`).all();
  res.json({ tenants: rows, global: globalStorageStats() });
});
router.post('/storage/:id/recalc', asyncHandler(async (req,res)=>{
  res.json({ usage: recalcStorage(Number(req.params.id)) });
}));

router.get('/audit', (req,res)=>{
  res.json({ logs: listAudit({ gamenetId: req.query.gamenet_id ? Number(req.query.gamenet_id) : null, limit: 200, action: req.query.action || '' }) });
});

router.get('/notifications', (req,res)=>{
  res.json({ notifications: myNotifications(req.user.id, { limit: 100 }) });
});

router.get('/backups', (req,res)=> res.json({ backups: listBackups() }));
router.post('/backups', requireRole('super_admin'), (req,res)=>{
  const meta = createBackup(req.user);
  res.status(201).json({ backup: meta });
});
router.post('/backups/prune', requireRole('super_admin'), (req,res)=>{
  res.json({ removed: pruneBackups(Number(req.body?.keep)||14) });
});

router.get('/settings', requireRole('super_admin'), (req,res)=>{
  res.json({ settings: db.prepare('SELECT * FROM system_settings').all() });
});
router.put('/settings', requireRole('super_admin'), asyncHandler(async (req,res)=>{
  const { key, value } = req.body || {};
  if(!key) return res.status(400).json({ error:'key_required' });
  db.prepare(`INSERT INTO system_settings(key,value,updated_at) VALUES(?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, String(value));
  require('../services/audit').audit({ actorUserId:req.user.id, actorRole:req.user.roles.join(','), action:'admin.settings', entity:'setting', entityId:key, ip:req.ip });
  res.json({ ok:true });
}));

router.post('/jobs/expire-subs', requireRole('super_admin'), (req,res)=>{
  res.json({ expired: expireDue() });
});

/** Admin view any tenant dashboard data (audited) */
router.get('/gamenets/:gamenetId/overview', requireTenant(), (req,res)=>{
  require('../services/audit').audit({ actorUserId:req.user.id, actorRole:req.user.roles.join(','), gamenetId:req.gamenet.id, action:'admin.view_tenant', entity:'gamenet', entityId:req.gamenet.id, ip:req.ip });
  const { activeSub } = require('../services/subscription');
  res.json({
    gamenet: req.gamenet,
    subscription: activeSub(req.gamenet.id),
    storage: getUsage(req.gamenet.id),
    tickets: listTickets({ gamenetId: req.gamenet.id, limit: 20 }),
    audit: listAudit({ gamenetId: req.gamenet.id, limit: 50 }),
  });
});
/* ═══════════ License Events — free N-day (default 1 month) grants ═══════════
 * Admin creates an event, issues free licenses from it to any gamenet,
 * and can deactivate the event anytime → all its active licenses revoke.
 */
router.get('/license-events', (req, res) => {
  const events = db.prepare(`
    SELECT e.*,
      (u.email || '') created_by_email,
      (SELECT COUNT(*) FROM licenses l WHERE l.event_id=e.id) issued,
      (SELECT COUNT(*) FROM licenses l WHERE l.event_id=e.id AND l.status='active') active_issued
    FROM license_events e LEFT JOIN users u ON u.id=e.created_by
    ORDER BY e.id DESC LIMIT 200`).all();
  const issued = db.prepare(`
    SELECT l.id, l.event_id, l.key, l.status, l.expires_at, l.activated_at, g.name gamenet_name, g.id gamenet_id
    FROM licenses l JOIN gamenets g ON g.id=l.gamenet_id
    WHERE l.event_id IS NOT NULL ORDER BY l.id DESC LIMIT 200`).all();
  res.json({ events, issued });
});

router.post('/license-events', requireRole('super_admin', 'admin'), rateLimit({ windowMs: 60000, max: 30 }), asyncHandler(async (req, res) => {
  const { name, duration_days } = req.body || {};
  const nm = String(name || '').trim().slice(0, 100);
  if(!nm) return res.status(400).json({ error: 'name_required', message: 'نام ایونت الزامی است' });
  let days = Math.floor(Number(duration_days));
  if(!Number.isFinite(days) || days < 1 || days > 3650) days = 30; // default: one month
  const r = db.prepare(`INSERT INTO license_events(name,duration_days,created_by) VALUES(?,?,?)`)
    .run(nm, days, req.user.id);
  require('../services/audit').audit({ actorUserId: req.user.id, actorRole: req.user.roles.join(','),
    action: 'admin.license_event_create', entity: 'license_event', entityId: r.lastInsertRowid, meta: { name: nm, days }, ip: req.ip });
  res.status(201).json({ event: db.prepare('SELECT * FROM license_events WHERE id=?').get(r.lastInsertRowid) });
}));

router.post('/license-events/:id/status', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const ev = db.prepare('SELECT * FROM license_events WHERE id=?').get(req.params.id);
  if(!ev) return res.status(404).json({ error: 'not_found', message: 'ایونت یافت نشد' });
  const active = !!(req.body && req.body.active);
  let revoked = 0;
  if(active){
    db.prepare(`UPDATE license_events SET active=1, updated_at=datetime('now') WHERE id=?`).run(ev.id);
  } else {
    // deactivate → revoke every still-active license this event granted
    db.prepare(`UPDATE license_events SET active=0, updated_at=datetime('now') WHERE id=?`).run(ev.id);
    const r = db.prepare(`UPDATE licenses SET status='revoked', revoked_at=datetime('now')
      WHERE event_id=? AND status='active'`).run(ev.id);
    revoked = r.changes;
  }
  require('../services/audit').audit({ actorUserId: req.user.id, actorRole: req.user.roles.join(','),
    action: active ? 'admin.license_event_activate' : 'admin.license_event_deactivate',
    entity: 'license_event', entityId: ev.id, meta: { revoked }, ip: req.ip });
  res.json({ event: db.prepare('SELECT * FROM license_events WHERE id=?').get(ev.id), revoked });
}));

router.post('/license-events/:id/issue', requireRole('super_admin', 'admin'), rateLimit({ windowMs: 60000, max: 60 }), asyncHandler(async (req, res) => {
  const ev = db.prepare('SELECT * FROM license_events WHERE id=?').get(req.params.id);
  if(!ev) return res.status(404).json({ error: 'not_found', message: 'ایونت یافت نشد' });
  if(!ev.active) return res.status(409).json({ error: 'event_inactive', message: 'ایونت غیرفعال است — ابتدا آن را فعال کنید' });
  const gid = Number(req.body && req.body.gamenet_id);
  const g = db.prepare(`SELECT * FROM gamenets WHERE id=? AND status='active'`).get(gid);
  if(!g) return res.status(404).json({ error: 'gamenet_not_found', message: 'گیم‌نت یافت نشد' });
  // free grant on top of any existing license; deactivating the event later
  // revokes ONLY event-issued licenses (paid subscription licenses stay intact)
  const { issueLicense } = require('../services/license');
  const ends = new Date(Date.now() + ev.duration_days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const lic = issueLicense({ gamenetId: g.id, subscriptionId: null, expiresAt: ends, eventId: ev.id });
  require('../services/audit').audit({ actorUserId: req.user.id, actorRole: req.user.roles.join(','), gamenetId: g.id,
    action: 'admin.license_event_issue', entity: 'license', entityId: lic.id, meta: { event: ev.name, days: ev.duration_days }, ip: req.ip });
  res.status(201).json({ license: lic, event: ev });
}));

module.exports = router;
