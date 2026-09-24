'use strict';
const express = require('express');
const { db } = require('../db');
const { requireAuth, requireEmailVerified } = require('../middleware/auth');
const { requireTenant, requireTenantOwner, isAdmin } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/errorHandler');
const { createOrder, markPending, mockPay, processWebhook } = require('../services/payment');
const { activeSub, activateSubscription, suspendSubscription, cancelSubscription, renewSubscription } = require('../services/subscription');
const { rateLimit } = require('../middleware/rateLimit');
const { audit } = require('../services/audit');
const router = express.Router();

router.use(requireAuth);

/** Create order (idempotent via Idempotency-Key header) */
router.post('/orders', requireEmailVerified, rateLimit({ max: 30 }), asyncHandler(async (req,res)=>{
  const { gamenet_id, plan_id } = req.body || {};
  const idem = req.get('idempotency-key') || null;
  if(!gamenet_id || !plan_id) return res.status(400).json({ error:'missing_fields' });
  // tenant check
  const g = db.prepare('SELECT * FROM gamenets WHERE id=? AND status!=?').get(gamenet_id,'deleted');
  if(!g) return res.status(404).json({ error:'tenant_not_found' });
  const member = db.prepare(`SELECT * FROM gamenet_members WHERE gamenet_id=? AND user_id=?`).get(gamenet_id, req.user.id);
  const platform = isAdmin(req.user);
  if(!member && !platform) return res.status(403).json({ error:'tenant_forbidden' });
  const order = createOrder({ userId: req.user.id, gamenetId: gamenet_id, planId: plan_id, idempotencyKey: idem });
  res.status(201).json({ order });
}));

router.get('/orders', asyncHandler(async (req,res)=>{
  const rows = db.prepare(`SELECT o.*, p.name plan_name FROM orders o JOIN plans p ON p.id=o.plan_id
    WHERE o.user_id=? ORDER BY o.id DESC LIMIT 50`).all(req.user.id);
  res.json({ orders: rows });
}));

/** Pay (mock provider — swap with real gateway adapter) */
router.post('/orders/:id/pay', rateLimit({ max: 20 }), asyncHandler(async (req,res)=>{
  const order = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if(!order) return res.status(404).json({ error:'not_found' });
  if(order.status === 'paid') return res.json({ order, alreadyPaid:true });
  const result = mockPay(order.id);
  res.json(result);
}));

router.get('/gamenets/:gamenetId/subscription', requireTenant(), asyncHandler(async (req,res)=>{
  const sub = activeSub(req.gamenet.id);
  const licenses = db.prepare(`SELECT id,key,status,expires_at,activated_at FROM licenses WHERE gamenet_id=? ORDER BY id DESC LIMIT 5`).all(req.gamenet.id);
  const orders = db.prepare(`SELECT * FROM orders WHERE gamenet_id=? ORDER BY id DESC LIMIT 20`).all(req.gamenet.id);
  const invoices = db.prepare(`SELECT i.* FROM invoices i JOIN orders o ON o.id=i.order_id WHERE o.gamenet_id=? ORDER BY i.id DESC LIMIT 20`).all(req.gamenet.id);
  res.json({ subscription: sub || null, licenses, orders, invoices });
}));

router.post('/gamenets/:gamenetId/subscription/cancel', requireTenant(), requireTenantOwner, asyncHandler(async (req,res)=>{
  const sub = activeSub(req.gamenet.id);
  if(!sub) return res.status(404).json({ error:'no_active_sub' });
  cancelSubscription(sub.id, req.user, { atPeriodEnd: req.body?.at_period_end !== false });
  res.json({ ok:true });
}));

/** Webhook — no cookie auth; in prod verify provider signature (extension point). */
router.post('/payments/webhook', rateLimit({ max: 120 }), asyncHandler(async (req,res)=>{
  const provider = String(req.body?.provider || 'mock');
  const eventId = String(req.body?.event_id || '');
  const type = String(req.body?.type || '');
  if(!eventId || !type) return res.status(400).json({ error:'invalid_event' });
  const result = processWebhook({ provider, eventId, type, payload: req.body?.data || {} });
  res.json({ ok:true, ...result });
}));
module.exports = router;
