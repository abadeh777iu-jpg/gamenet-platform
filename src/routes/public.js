'use strict';
const express = require('express');
const { db } = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const { checkLicense } = require('../services/license');
const router = express.Router();

router.get('/plans', (req,res)=>{
  const plans = db.prepare(`SELECT id,code,name,price_cents,currency,duration_days,storage_bytes,max_users,features_json
    FROM plans WHERE active=1 ORDER BY price_cents ASC`).all();
  res.json({ plans: plans.map(p => ({ ...p, features: JSON.parse(p.features_json||'[]') })) });
});
router.get('/health', (req,res)=> res.json({ ok:true, uptime: process.uptime(), ts: Date.now() }));
router.post('/license/check', (req,res)=>{
  const { key } = req.body || {};
  if(!key) return res.status(400).json({ error:'key_required' });
  res.json(checkLicense(String(key).trim()));
});
module.exports = router;
