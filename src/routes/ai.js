'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { rateLimit } = require('../middleware/rateLimit');
const { chat } = require('../services/ai');
const { db } = require('../db');
const { isAdmin } = require('../middleware/rbac');
const router = express.Router();
router.use(requireAuth);

router.post('/chat', rateLimit({ max: 30, windowMs: 60000 }), asyncHandler(async (req,res)=>{
  const { message, ticket_id, gamenet_id } = req.body || {};
  if(!message) return res.status(400).json({ error:'message_required' });
  let gamenetId = gamenet_id ? Number(gamenet_id) : null;
  if(gamenetId){
    const m = db.prepare(`SELECT 1 FROM gamenet_members WHERE gamenet_id=? AND user_id=?`).get(gamenetId, req.user.id);
    if(!m && !isAdmin(req.user)) return res.status(403).json({ error:'tenant_forbidden' });
  }
  const result = await chat({
    userId: req.user.id,
    roles: req.user.roles,
    gamenetId,
    ticketId: ticket_id ? Number(ticket_id) : null,
    message,
  });
  res.json(result);
}));
module.exports = router;
