'use strict';
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isAdmin, isSupport } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/errorHandler');
const { createTicket, getTicket, listTickets, replyAndMaybeResolve, escalateToHuman } = require('../services/ticket');
const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req,res)=>{
  if(isSupport(req.user) && req.query.all === '1'){
    return res.json({ tickets: listTickets({ status: req.query.status || null, limit: 100 }) });
  }
  res.json({ tickets: listTickets({ userId: req.user.id, limit: 50 }) });
}));

router.post('/', asyncHandler(async (req,res)=>{
  const { subject, gamenet_id, priority } = req.body || {};
  if(!subject) return res.status(400).json({ error:'subject_required' });
  if(gamenet_id){
    const m = db.prepare(`SELECT 1 FROM gamenet_members WHERE gamenet_id=? AND user_id=?`).get(gamenet_id, req.user.id);
    const platform = isAdmin(req.user);
    if(!m && !platform) return res.status(403).json({ error:'tenant_forbidden' });
  }
  const t = createTicket({ userId: req.user.id, gamenetId: gamenet_id||null, subject, priority: priority||'normal' });
  res.status(201).json({ ticket: t });
}));

router.get('/:id', asyncHandler(async (req,res)=>{
  const staff = isSupport(req.user);
  const t = getTicket(Number(req.params.id), staff ? null : req.user.id, { forStaff: staff });
  if(!t) return res.status(404).json({ error:'not_found' });
  // tenant isolation for non-staff viewing staff ticket
  if(t.gamenet_id && !staff){
    const m = db.prepare(`SELECT 1 FROM gamenet_members WHERE gamenet_id=? AND user_id=?`).get(t.gamenet_id, req.user.id);
    if(!m) return res.status(403).json({ error:'tenant_forbidden' });
  }
  res.json({ ticket: t });
}));

router.post('/:id/reply', asyncHandler(async (req,res)=>{
  const { content, resolve } = req.body || {};
  if(!content) return res.status(400).json({ error:'content_required' });
  const staff = isSupport(req.user);
  const t = getTicket(Number(req.params.id), staff ? null : req.user.id, { forStaff: staff });
  if(!t) return res.status(404).json({ error:'not_found' });
  if(!staff){
    const m = t.gamenet_id ? db.prepare(`SELECT 1 FROM gamenet_members WHERE gamenet_id=? AND user_id=?`).get(t.gamenet_id, req.user.id) : t.user_id === req.user.id;
    if(!m) return res.status(403).json({ error:'tenant_forbidden' });
  }
  const updated = replyAndMaybeResolve({
    ticketId: t.id, actor: req.user, content,
    resolve: !!resolve && staff,
    asRole: staff ? 'agent' : 'user',
  });
  res.json({ ticket: updated });
}));

router.post('/:id/escalate', asyncHandler(async (req,res)=>{
  const staff = isSupport(req.user);
  const t = getTicket(Number(req.params.id), staff ? null : req.user.id, { forStaff: staff });
  if(!t) return res.status(404).json({ error:'not_found' });
  escalateToHuman({ ticketId: t.id, actorUserId: req.user.id });
  res.json({ ok:true });
}));
module.exports = router;
