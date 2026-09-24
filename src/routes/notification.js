'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { myNotifications, markRead, markAllRead } = require('../services/notification');
const router = express.Router();
router.use(requireAuth);
router.get('/', (req,res)=>{
  res.json({ notifications: myNotifications(req.user.id, { unreadOnly: req.query.unread === '1', limit: 50 }) });
});
router.post('/:id/read', (req,res)=>{ markRead(req.user.id, Number(req.params.id)); res.json({ ok:true }); });
router.post('/read-all', (req,res)=>{ markAllRead(req.user.id); res.json({ ok:true }); });
module.exports = router;
