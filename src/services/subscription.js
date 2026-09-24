'use strict';
const { db, tx } = require('../db');
const { audit } = require('./audit');
const { notify } = require('./notification');
const { revokeAllLicenses, issueLicense } = require('./license');
const { sha256 } = require('./ids');

function activeSub(gamenetId){
  return db.prepare(`SELECT s.*, p.code plan_code, p.name plan_name, p.storage_bytes, p.max_users, p.duration_days
    FROM subscriptions s JOIN plans p ON p.id=s.plan_id
    WHERE s.gamenet_id=? AND s.status='active' AND (s.ends_at IS NULL OR s.ends_at > datetime('now'))
    ORDER BY s.id DESC LIMIT 1`).get(gamenetId);
}
function activateSubscription({ gamenetId, planId, actor, days=null }){
  const plan = db.prepare('SELECT * FROM plans WHERE id=? AND active=1').get(planId);
  if(!plan){ const e = new Error('PLAN_NOT_FOUND'); e.status = 404; throw e; }
  const dur = days || plan.duration_days;
  return tx(()=>{
    // suspend other active subs for this tenant (one active at a time)
    db.prepare(`UPDATE subscriptions SET status='expired', updated_at=datetime('now')
      WHERE gamenet_id=? AND status='active'`).run(gamenetId);
    const starts = new Date();
    const ends = new Date(starts.getTime() + dur*86400000);
    const r = db.prepare(`INSERT INTO subscriptions(gamenet_id,plan_id,status,starts_at,ends_at)
      VALUES(?,?, 'active', ?, ?)`)
      .run(gamenetId, planId, starts.toISOString().slice(0,19).replace('T',' '), ends.toISOString().slice(0,19).replace('T',' '));
    const subId = r.lastInsertRowid;
    // expand storage
    db.prepare(`UPDATE gamenets SET storage_limit_bytes=?, updated_at=datetime('now') WHERE id=?`).run(plan.storage_bytes, gamenetId);
    // license
    revokeAllLicenses(gamenetId);
    issueLicense({ gamenetId, subscriptionId: subId, expiresAt: ends.toISOString().slice(0,19).replace('T',' ') });
    // notify owner
    const g = db.prepare('SELECT owner_user_id,name FROM gamenets WHERE id=?').get(gamenetId);
    if(g) notify({ userId: g.owner_user_id, gamenetId, type: 'subscription_active', title: 'اشتراک فعال شد', body: `پلن ${plan.name} تا ${ends.toISOString().slice(0,10)} فعال است.` });
    audit({ actorUserId: actor?.id||null, actorRole: actor?.roles?.join(',')||'system', gamenetId, action: 'subscription.activate', entity: 'subscription', entityId: subId, meta: { plan: plan.code } });
    return db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId);
  });
}
function suspendSubscription(subId, actor){
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId);
  if(!sub){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  return tx(()=>{
    db.prepare(`UPDATE subscriptions SET status='suspended', updated_at=datetime('now') WHERE id=?`).run(subId);
    revokeAllLicenses(sub.gamenet_id, 'suspended');
    audit({ actorUserId: actor?.id||null, actorRole: actor?.roles?.join(',')||'', gamenetId: sub.gamenet_id, action: 'subscription.suspend', entity: 'subscription', entityId: subId });
    return true;
  });
}
function cancelSubscription(subId, actor, { atPeriodEnd=true } = {}){
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId);
  if(!sub){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  db.prepare(`UPDATE subscriptions SET cancel_at_period_end=?, status=CASE WHEN ? THEN status ELSE 'canceled' END, updated_at=datetime('now') WHERE id=?`)
    .run(atPeriodEnd?1:0, atPeriodEnd?1:0, subId);
  if(!atPeriodEnd){ revokeAllLicenses(sub.gamenet_id, 'revoked'); }
  audit({ actorUserId: actor?.id||null, actorRole: actor?.roles?.join(',')||'', gamenetId: sub.gamenet_id, action: 'subscription.cancel', entity: 'subscription', entityId: subId, meta:{ atPeriodEnd } });
  return true;
}
function renewSubscription(subId, actor){
  const sub = db.prepare('SELECT s.*, p.duration_days FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=?').get(subId);
  if(!sub){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  const base = sub.ends_at && new Date(sub.ends_at) > new Date() ? new Date(sub.ends_at) : new Date();
  const ends = new Date(base.getTime() + sub.duration_days*86400000);
  db.prepare(`UPDATE subscriptions SET status='active', ends_at=?, cancel_at_period_end=0, updated_at=datetime('now') WHERE id=?`)
    .run(ends.toISOString().slice(0,19).replace('T',' '), subId);
  db.prepare(`UPDATE licenses SET expires_at=?, status='active' WHERE subscription_id=? AND status!='revoked'`).run(ends.toISOString().slice(0,19).replace('T',' '), subId);
  audit({ actorUserId: actor?.id||null, actorRole: actor?.roles?.join(',')||'', gamenetId: sub.gamenet_id, action: 'subscription.renew', entity: 'subscription', entityId: subId });
  return db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId);
}
/** Background job: expire past-due subscriptions & licenses */
function expireDue(){
  const due = db.prepare(`SELECT * FROM subscriptions WHERE status='active' AND ends_at IS NOT NULL AND ends_at <= datetime('now')`).all();
  for(const sub of due){
    db.prepare(`UPDATE subscriptions SET status='expired', updated_at=datetime('now') WHERE id=?`).run(sub.id);
    revokeAllLicenses(sub.gamenet_id, 'expired');
    const g = db.prepare('SELECT owner_user_id FROM gamenets WHERE id=?').get(sub.gamenet_id);
    if(g) notify({ userId: g.owner_user_id, gamenetId: sub.gamenet_id, type: 'subscription_expired', title: 'اشتراک منقضی شد', body: 'برای ادامه استفاده تمدید کنید.' });
    audit({ action: 'subscription.auto_expire', gamenetId: sub.gamenet_id, entity: 'subscription', entityId: sub.id, actorRole: 'system' });
  }
  return due.length;
}
module.exports = { activeSub, activateSubscription, suspendSubscription, cancelSubscription, renewSubscription, expireDue };
