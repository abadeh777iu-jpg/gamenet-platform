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
  db.prepare(`UPDATE orders SET status='pending', updated_at=datetime('now') WHERE id=? AND status IN ('created','failed')`).run(orderId);
  return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
}

/**
 * Single source of truth for "order is PAID": payment row + order + invoice +
 * subscription/license activation + notify + audit. Idempotent: an already-paid
 * order only refreshes its payment row and returns.
 */
function completeOrderPaid(order, { provider, providerRef, rawJson, paymentId = null, actor }){
  if(!order){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  return tx(()=>{
    if(paymentId){
      db.prepare(`UPDATE payments SET status='succeeded', provider_ref=?, raw_json=?, updated_at=datetime('now') WHERE id=?`)
        .run(providerRef||null, rawJson||'{}', paymentId);
    } else {
      db.prepare(`INSERT INTO payments(order_id,provider,provider_ref,amount_cents,currency,status,raw_json)
        VALUES(?,?,?,?,?, 'succeeded', ?)`)
        .run(order.id, provider, providerRef, order.amount_cents, order.currency, rawJson||'{}');
    }
    if(order.status !== 'paid'){
      db.prepare(`UPDATE orders SET status='paid', updated_at=datetime('now') WHERE id=?`).run(order.id);
      // invoice (one per order)
      const hasInv = db.prepare('SELECT id FROM invoices WHERE order_id=?').get(order.id);
      if(!hasInv){
        const invCount = db.prepare('SELECT COUNT(*) c FROM invoices').get().c + 1;
        db.prepare(`INSERT INTO invoices(order_id,number,amount_cents,currency) VALUES(?,?,?,?)`)
          .run(order.id, `INV-${String(invCount).padStart(6,'0')}`, order.amount_cents, order.currency);
      }
      activateSubscription({ gamenetId: order.gamenet_id, planId: order.plan_id, actor: actor || { id: order.user_id, roles: ['payment'] } });
      notify({ userId: order.user_id, gamenetId: order.gamenet_id, type: 'payment_success', title: 'پرداخت موفق', body: `سفارش ${order.public_id} پرداخت شد و اشتراک فعال شد.` });
      audit({ actorUserId: actor?.id || order.user_id, actorRole: actor?.roles?.join(',') || 'customer', gamenetId: order.gamenet_id, action: 'payment.succeeded', entity: 'order', entityId: order.id, meta:{ provider, providerRef } });
    }
    return {
      order: db.prepare('SELECT * FROM orders WHERE id=?').get(order.id),
      payment: paymentId
        ? db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId)
        : db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1').get(order.id),
    };
  });
}

/**
 * Mock provider "pay" — DEVELOPMENT/TEST ONLY. Blocked in production by the
 * route layer; real money flows through the manual card-to-card confirmation.
 */
function mockPay(orderId){
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if(!order){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  if(order.status === 'paid') return { order, alreadyPaid:true };
  const providerRef = publicId('pay');
  markPending(orderId);
  const fresh = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const r = completeOrderPaid(fresh, { provider:'mock', providerRef, rawJson: JSON.stringify({ mock:true }) });
  return { order: r.order, alreadyPaid:false, providerRef };
}

/* ── Manual card-to-card (کارت به کارت) ─────────────────────────────────── */

function getSetting(key){
  const r = db.prepare('SELECT value FROM system_settings WHERE key=?').get(key);
  return r ? r.value : '';
}
/** Public payment instructions (card info is public by nature — it's an IN-bound account). */
function paymentConfig(){
  return {
    card_number: getSetting('card_number'),
    cardholder_name: getSetting('cardholder_name'),
    card_bank: getSetting('card_bank'),
  };
}

const TRACKING_RE = /^[0-9A-Za-z\u0600-\u06FF-]{5,40}$/;
const RECEIPT_RE = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * Customer submits proof of a bank transfer (tracking code + optional receipt).
 * Never activates anything — only flips order to 'pending' for admin review.
 */
function submitManualPayment({ order, userId, trackingCode, receipt }){
  if(order.status === 'paid'){
    const e = new Error('ALREADY_PAID'); e.status = 409; e.publicMessage = 'این سفارش قبلاً پرداخت شده است'; throw e;
  }
  const tracking = String(trackingCode||'').trim();
  if(!TRACKING_RE.test(tracking)){
    const e = new Error('BAD_TRACKING'); e.status = 400; e.publicMessage = 'شماره پیگیری نامعتبر است (۵ تا ۴۰ کاراکتر)'; throw e;
  }
  let receiptVal = '';
  if(receipt){
    receiptVal = String(receipt);
    if(!RECEIPT_RE.test(receiptVal) || receiptVal.length > 700000){
      const e = new Error('BAD_RECEIPT'); e.status = 400; e.publicMessage = 'رسید باید عکس (JPG/PNG/WebP) و کمتر از ۵۰۰ کیلوبایت باشد'; throw e;
    }
  }
  return tx(()=>{
    markPending(order.id);
    const raw = JSON.stringify({
      tracking_code: tracking,
      receipt: receiptVal,
      submitted_by: userId,
      submitted_at: new Date().toISOString().slice(0,19).replace('T',' '),
    });
    let payment = db.prepare(`SELECT * FROM payments WHERE order_id=? AND status='pending' ORDER BY id DESC LIMIT 1`).get(order.id);
    if(payment){
      db.prepare(`UPDATE payments SET raw_json=?, amount_cents=?, updated_at=datetime('now') WHERE id=?`)
        .run(raw, order.amount_cents, payment.id);
    } else {
      const r = db.prepare(`INSERT INTO payments(order_id,provider,provider_ref,amount_cents,currency,status,raw_json)
        VALUES(?,'manual',NULL,?,?, 'pending', ?)`)
        .run(order.id, order.amount_cents, order.currency, raw);
      payment = db.prepare('SELECT * FROM payments WHERE id=?').get(r.lastInsertRowid);
    }
    audit({ actorUserId: userId, actorRole: 'customer', gamenetId: order.gamenet_id, action: 'payment.submitted', entity: 'order', entityId: order.id, meta:{ tracking, paymentId: payment.id }, ip: null });
    // notify platform admins
    const admins = db.prepare(`SELECT DISTINCT user_id FROM user_roles WHERE role_code IN ('super_admin','admin')`).all();
    for(const a of admins){
      notify({ userId: a.user_id, type: 'payment_submitted', title: 'رسید پرداخت جدید', body: `سفارش ${order.public_id} — کد پیگیری ${tracking} — در انتظار تأیید شما.` });
    }
    return payment;
  });
}

function paymentWithMeta(paymentId){
  const p = db.prepare(`SELECT p.*, o.public_id order_public, o.status order_status, u.email user_email
    FROM payments p JOIN orders o ON o.id=p.order_id JOIN users u ON u.id=o.user_id WHERE p.id=?`).get(paymentId);
  if(!p) return null;
  let raw = {}; try{ raw = JSON.parse(p.raw_json||'{}'); }catch(e){}
  return { ...p, raw };
}

/** Admin confirms → money received → order paid → subscription + license activated. */
function confirmManualPayment(paymentId, admin){
  const p = paymentWithMeta(paymentId);
  if(!p){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  if(p.provider !== 'manual'){ const e = new Error('NOT_MANUAL'); e.status = 400; e.publicMessage = 'فقط پرداخت‌های دستی (کارت به کارت) قابل تأیید هستند'; throw e; }
  if(p.status === 'succeeded') return { alreadyConfirmed:true, payment: p };
  if(p.status !== 'pending'){ const e = new Error('NOT_PENDING'); e.status = 409; e.publicMessage = 'این پرداخت قبلاً رد شده است'; throw e; }
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(p.order_id);
  if(!order){ const e = new Error('ORDER_NOT_FOUND'); e.status = 404; throw e; }
  const raw = { ...p.raw, confirmed_by: admin.id, confirmed_at: new Date().toISOString().slice(0,19).replace('T',' ') };
  const r = completeOrderPaid(order, {
    provider: 'manual',
    providerRef: `MAN-${p.raw.tracking_code || p.id}`,
    rawJson: JSON.stringify(raw),
    paymentId: p.id,
    actor: { id: admin.id, roles: ['admin'] },
  });
  audit({ actorUserId: admin.id, actorRole: admin.roles.join(','), gamenetId: order.gamenet_id, action: 'payment.confirmed', entity: 'payment', entityId: p.id, meta:{ order: order.public_id, tracking: p.raw.tracking_code } });
  return { alreadyConfirmed:false, ...r };
}

/** Admin rejects → payment failed, order reopens for a new submission. */
function rejectManualPayment(paymentId, admin, reason){
  const p = paymentWithMeta(paymentId);
  if(!p){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  if(p.provider !== 'manual'){ const e = new Error('NOT_MANUAL'); e.status = 400; e.publicMessage = 'فقط پرداخت‌های دستی قابل رد هستند'; throw e; }
  if(p.status === 'succeeded'){ const e = new Error('ALREADY_CONFIRMED'); e.status = 409; e.publicMessage = 'پرداخت قبلاً تأیید شده و قابل رد نیست'; throw e; }
  if(p.status === 'failed') return { alreadyRejected:true, payment: p };
  return tx(()=>{
    const raw = { ...p.raw, rejected_by: admin.id, reject_reason: String(reason||'').slice(0,300), rejected_at: new Date().toISOString().slice(0,19).replace('T',' ') };
    db.prepare(`UPDATE payments SET status='failed', raw_json=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(raw), p.id);
    db.prepare(`UPDATE orders SET status='created', updated_at=datetime('now') WHERE id=? AND status='pending'`).run(p.order_id);
    notify({ userId: db.prepare('SELECT user_id FROM orders WHERE id=?').get(p.order_id).user_id, type: 'payment_rejected', title: 'رسید پرداخت رد شد', body: `سفارش ${p.order_public}${reason ? ' — دلیل: ' + String(reason).slice(0,200) : ''}. می‌توانید دوباره ارسال کنید.` });
    audit({ actorUserId: admin.id, actorRole: admin.roles.join(','), action: 'payment.rejected', entity: 'payment', entityId: p.id, meta:{ reason: String(reason||'').slice(0,200) } });
    return { alreadyRejected:false, payment: paymentWithMeta(p.id) };
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
        completeOrderPaid(order, { provider, providerRef: eventId, rawJson: JSON.stringify({ webhook:true }) });
      }
    }
    db.prepare(`UPDATE webhook_events SET processed_at=datetime('now') WHERE provider=? AND event_id=?`).run(provider, eventId);
    return { duplicate:false, processed:true };
  }catch(e){
    db.prepare(`UPDATE webhook_events SET error=? WHERE provider=? AND event_id=?`).run(String(e.message).slice(0,500), provider, eventId);
    throw e;
  }
}
module.exports = {
  createOrder, markPending, mockPay, processWebhook,
  paymentConfig, submitManualPayment, confirmManualPayment, rejectManualPayment, paymentWithMeta,
};
