'use strict';
const express = require('express');
const { db } = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const { checkLicense } = require('../services/license');
const { rateLimit } = require('../middleware/rateLimit');
const { processWebhook } = require('../services/payment');
const config = require('../config');
const router = express.Router();

router.get('/plans', (req,res)=>{
  const plans = db.prepare(`SELECT id,code,name,price_cents,currency,duration_days,storage_bytes,max_users,features_json
    FROM plans WHERE active=1 ORDER BY price_cents ASC`).all();
  res.json({ plans: plans.map(p => ({ ...p, features: JSON.parse(p.features_json||'[]') })) });
});
router.get('/health', (req,res)=> res.json({ ok:true, uptime: process.uptime(), ts: Date.now(), csrf: req.csrfToken, env: config.env }));
/** Public card-to-card instructions (set by admin in panel → تنظیمات). */
router.get('/payment-config', (req,res)=>{
  res.json({ card: require('../services/payment').paymentConfig() });
});
router.post('/license/check', (req,res)=>{
  const { key } = req.body || {};
  if(!key) return res.status(400).json({ error:'key_required' });
  res.json(checkLicense(String(key).trim()));
});
/**
 * Payment provider webhook (no cookie auth — providers cannot log in).
 * SECURITY: no signature verification is wired yet, so production rejects it
 * entirely; dev/test use it for idempotency tests. Real gateways plug a
 * signature check here before enabling it in production.
 */
router.post('/payments/webhook', rateLimit({ max: 120 }), asyncHandler(async (req,res)=>{
  if(config.isProd){
    return res.status(403).json({ error:'webhook_disabled', message:'وب‌هوک در محیط اجرایی غیرفعال است (بدون تأیید امضای درگاه)' });
  }
  const provider = String(req.body?.provider || 'mock');
  const eventId = String(req.body?.event_id || '');
  const type = String(req.body?.type || '');
  if(!eventId || !type) return res.status(400).json({ error:'invalid_event' });
  const result = processWebhook({ provider, eventId, type, payload: req.body?.data || {} });
  res.json({ ok:true, ...result });
}));
module.exports = router;
