'use strict';
const { db, tx } = require('../db');
const { publicId } = require('./ids');
const { audit } = require('./audit');
const { notify } = require('./notification');
const { activateSubscription } = require('./subscription');

/**
 * Idempotent order creation: same idempotency_key returns the same order.
 */
function createOrder({ userId, gamenetId, planId, idempotencyKey }){
  const plan = db.prepare('SELECT * FROM plans WHERE id=? AND active=1').get(planId);
  if(!plan){ const e = new Error('PLAN_NOT_FOUND'); e.status = 404; throw e; }
  if(idempotencyKey){
    const existing = db.prepare('SELECT * FROM orders WHERE idempotency_key=?').get(idempotencyKey);
    if(existing) return existing;
  }
  const r = db.prepare(`INSERT INTO orders(public_id,user_id,gamenet_id,plan_id,amount_cents,currency,status,idempotency_key)
    VALUES(?,?,?,?,?,?,'created',?)`)
    .run(publicId('ord'), userId, gamenetId, planId, plan.price_cents, plan.currency, idempotencyKey||null);
  return db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);
}
function markPending(orderId){
  db.prepare(`UPDATE orders SET status='pending', updated_at=datetime('now') WHERE id=? AND status='created'`).run(orderId);
  return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
}
/**
 * Mock provider "pay" — real gateways plug in behind same function.
 * Completing payment is idempotent per provider event.
 */
function mockPay(orderId){
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if(!order){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  if(order.status === 'paid') return { order, alreadyPaid:true };
  const providerRef = publicId('pay');
  return tx(()=>{
    markPending(orderId);
    db.prepare(`INSERT INTO payments(order_id,provider,provider_ref,amount_cents,currency,status,raw_json)
      VALUES(?,'mock',?,?,?, 'succeeded', ?)`)
      .run(orderId, providerRef, order.amount_cents, order.currency, JSON.stringify({ mock:true }));
    db.prepare(`UPDATE orders SET status='paid', updated_at=datetime('now') WHERE id=?`).run(orderId);
    // invoice
    const invCount = db.prepare('SELECT COUNT(*) c FROM invoices').get().c + 1;
    db.prepare(`INSERT INTO invoices(order_id,number,amount_cents,currency) VALUES(?,?,?,?)`)
      .run(orderId, `INV-${String(invCount).padStart(6,'0')}`, order.amount_cents, order.currency);
    // activate subscription (payment success)
    activateSubscription({ gamenetId: order.gamenet_id, planId: order.plan_id, actor: { id: order.user_id, roles: ['payment'] } });
    notify({ userId: order.user_id, gamenetId: order.gamenet_id, type: 'payment_success', title: 'پرداخت موفق', body: `سفارش ${order.public_id} پرداخت شد.` });
    audit({ actorUserId: order.user_id, actorRole: 'customer', gamenetId: order.gamenet_id, action: 'payment.succeeded', entity: 'order', entityId: order.id, meta:{ providerRef } });
    return { order: db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), alreadyPaid:false, providerRef };
  });
}
/**
 * Webhook processing with unique event_id — duplicate events are ignored.
 */
function processWebhook({ provider, eventId, type, payload }){
  try{
    db.prepare(`INSERT INTO webhook_events(provider,event_id,type,payload_json) VALUES(?,?,?,?)`)
      .run(provider, eventId, type, JSON.stringify(payload));
  }catch(e){
    if(String(e.message).includes('UNIQUE')){
      return { duplicate:true };
    }
    throw e;
  }
  try{
    if(type === 'payment.succeeded' || type === 'payment.completed'){
      const orderId = payload.order_id || payload.orderId;
      const order = db.prepare('SELECT * FROM orders WHERE id=? OR public_id=?').get(orderId, orderId);
      if(order && order.status !== 'paid'){
        db.prepare(`INSERT INTO payments(order_id,provider,provider_ref,amount_cents,currency,status)
          VALUES(?,?,?,?,?,'succeeded')`).run(order.id, provider, eventId, order.amount_cents, order.currency);
        db.prepare(`UPDATE orders SET status='paid', updated_at=datetime('now') WHERE id=?`).run(order.id);
        activateSubscription({ gamenetId: order.gamenet_id, planId: order.plan_id, actor:{ id: order.user_id, roles:['webhook'] } });
      }
    }
    db.prepare(`UPDATE webhook_events SET processed_at=datetime('now') WHERE provider=? AND event_id=?`).run(provider, eventId);
    return { duplicate:false, processed:true };
  }catch(e){
    db.prepare(`UPDATE webhook_events SET error=? WHERE provider=? AND event_id=?`).run(String(e.message).slice(0,500), provider, eventId);
    throw e;
  }
}
module.exports = { createOrder, markPending, mockPay, processWebhook };
