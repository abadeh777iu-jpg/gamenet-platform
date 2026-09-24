'use strict';
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireTenant, requireTenantOwner } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/errorHandler');
const { activeSub } = require('../services/subscription');
const { getUsage, listFiles, deleteFile, registerFile } = require('../services/storage');
const { listTickets, createTicket } = require('../services/ticket');
const { myNotifications } = require('../services/notification');
const { audit } = require('../services/audit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const router = express.Router();
router.use(requireAuth);

const storage = multer.diskStorage({
  destination(req, file, cb){
    const dir = path.join(config.uploadsDir, String(req.gamenet.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb){
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2,8) + path.extname(file.originalname).slice(0,12));
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

/** Create gamenet (owner becomes member owner) */
router.post('/', asyncHandler(async (req,res)=>{
  const { name, slug } = req.body || {};
  if(!name || String(name).trim().length < 2) return res.status(400).json({ error:'invalid_name' });
  let finalSlug = String(slug || name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40) || publicSlug();
  if(db.prepare('SELECT id FROM gamenets WHERE slug=?').get(finalSlug)){
    // explicit slug conflict → 409; auto-derived from name → uniquify
    if(slug) return res.status(409).json({ error:'slug_exists' });
    finalSlug = (finalSlug.slice(0,32) + '-' + Math.random().toString(36).slice(2,6)).slice(0,40);
    if(db.prepare('SELECT id FROM gamenets WHERE slug=?').get(finalSlug)){
      return res.status(409).json({ error:'slug_exists' });
    }
  }
  const r = db.prepare(`INSERT INTO gamenets(slug,name,owner_user_id) VALUES(?,?,?)`).run(finalSlug, String(name).trim().slice(0,80), req.user.id);
  const gid = r.lastInsertRowid;
  db.prepare(`INSERT INTO gamenet_members(gamenet_id,user_id,member_role) VALUES(?,'?',?)`.replace("'?'","?")).run(gid, req.user.id, 'owner');
  const { ensureStorage } = require('../services/storage');
  ensureStorage(gid);
  audit({ actorUserId: req.user.id, actorRole: req.user.roles.join(','), gamenetId: gid, action:'gamenet.create', entity:'gamenet', entityId: gid, ip: req.ip });
  const g = db.prepare('SELECT * FROM gamenets WHERE id=?').get(gid);
  res.status(201).json({ gamenet: g });
  function publicSlug(){ return 'g-' + Math.random().toString(36).slice(2,8); }
}));

router.get('/', asyncHandler(async (req,res)=>{
  if(req.user.roles.some(r=>r==='super_admin'||r==='admin')){
    const all = db.prepare(`SELECT * FROM gamenets WHERE status!='deleted' ORDER BY id DESC`).all();
    return res.json({ gamenets: all, scope:'platform' });
  }
  const rows = db.prepare(`SELECT g.*, m.member_role FROM gamenets g
    JOIN gamenet_members m ON m.gamenet_id=g.id WHERE m.user_id=? AND g.status!='deleted' ORDER BY g.id DESC`).all(req.user.id);
  res.json({ gamenets: rows, scope:'mine' });
}));

router.get('/:gamenetId', requireTenant(), asyncHandler(async (req,res)=>{
  const g = req.gamenet;
  const sub = activeSub(g.id);
  const usage = getUsage(g.id);
  const tickets = listTickets({ gamenetId: g.id, limit: 5 });
  const notifications = myNotifications(req.user.id, { limit: 10 });
  const members = db.prepare(`SELECT u.id,u.name,u.email,m.member_role FROM gamenet_members m JOIN users u ON u.id=m.user_id WHERE m.gamenet_id=?`).all(g.id);
  const recentAudit = db.prepare(`SELECT action,entity,created_at FROM audit_logs WHERE gamenet_id=? ORDER BY id DESC LIMIT 10`).all(g.id);
  const licenses = db.prepare(`SELECT id,status,expires_at,key FROM licenses WHERE gamenet_id=? AND status='active' ORDER BY id DESC LIMIT 1`).all(g.id);
  res.json({
    gamenet: g,
    subscription: sub || null,
    license: licenses[0] || null,
    storage: usage,
    tickets,
    notifications,
    members,
    recent_activity: recentAudit,
  });
}));

router.put('/:gamenetId', requireTenant(), requireTenantOwner, asyncHandler(async (req,res)=>{
  const { name } = req.body || {};
  if(name) db.prepare(`UPDATE gamenets SET name=?, updated_at=datetime('now') WHERE id=?`).run(String(name).trim().slice(0,80), req.gamenet.id);
  audit({ actorUserId:req.user.id, actorRole:req.user.roles.join(','), gamenetId:req.gamenet.id, action:'gamenet.update', entity:'gamenet', entityId:req.gamenet.id, ip:req.ip });
  res.json({ gamenet: db.prepare('SELECT * FROM gamenets WHERE id=?').get(req.gamenet.id) });
}));

router.get('/:gamenetId/files', requireTenant(), asyncHandler(async (req,res)=>{
  const usage = getUsage(req.gamenet.id);
  res.json({
    files: listFiles(req.gamenet.id, { big: req.query.big === '1' }),
    used_bytes: usage.used_bytes,
    limit_bytes: usage.limit_bytes,
    remaining_bytes: usage.remaining_bytes,
    file_count: usage.file_count,
    ratio: usage.ratio,
  });
}));

/** Dashboard aggregate (same data as GET /:gamenetId — explicit path for panel) */
router.get('/:gamenetId/dashboard', requireTenant(), asyncHandler(async (req,res)=>{
  const g = req.gamenet;
  const sub = activeSub(g.id);
  const usage = getUsage(g.id);
  const tickets = listTickets({ gamenetId: g.id, limit: 10 });
  const notifications = myNotifications(req.user.id, { limit: 10, gamenetId: g.id });
  const members = db.prepare(`SELECT u.id,u.name,u.email,m.member_role FROM gamenet_members m JOIN users u ON u.id=m.user_id WHERE m.gamenet_id=?`).all(g.id);
  const recentAudit = db.prepare(`SELECT action,entity,created_at FROM audit_logs WHERE gamenet_id=? ORDER BY id DESC LIMIT 10`).all(g.id);
  const licenses = db.prepare(`SELECT id,status,expires_at,key FROM licenses WHERE gamenet_id=? AND status='active' ORDER BY id DESC LIMIT 1`).all(g.id);
  const pay = db.prepare(`SELECT p.id,p.amount_cents,p.status,p.created_at FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.gamenet_id=? ORDER BY p.id DESC LIMIT 5`).all(g.id);
  res.json({
    gamenet: g,
    subscription: sub || null,
    license: licenses[0] || null,
    storage: usage,
    tickets,
    notifications,
    members,
    payments: pay,
    recent_activity: recentAudit,
  });
}));

router.post('/:gamenetId/files', requireTenant(), upload.single('file'), asyncHandler(async (req,res)=>{
  if(!req.file) return res.status(400).json({ error:'file_required' });
  try{
    // Buffer mode (Workers): persist bytes in KV if env available; else keep path from disk multer
    let rel;
    if(req.file.buffer && (!req.file.path || req.file.path === '')){
      const key = 'files/' + req.gamenet.id + '/' + req.file.filename;
      const env = req.env || (req.app && req.app.get && req.app.get('env_obj'));
      if(env && env.DB && env.DB.put){
        await env.DB.put(key, req.file.buffer, { expirationTtl: 60*60*24*365 });
      }
      rel = key;
    } else {
      rel = path.join(String(req.gamenet.id), req.file.filename || path.basename(req.file.path||''));
    }
    const f = registerFile({
      gamenetId: req.gamenet.id,
      uploaderUserId: req.user.id,
      filePath: String(rel).split('\\').join('/'),
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
      mime: req.file.mimetype,
    });
    res.status(201).json({ file: f });
  }catch(e){
    if(req.file && req.file.path){
      try{ fs.unlinkSync(req.file.path); }catch(_){}
    }
    res.status(e.status||500).json({ error: e.message });
  }
}));

router.delete('/:gamenetId/files/:fileId', requireTenant(), asyncHandler(async (req,res)=>{
  deleteFile({ fileId: req.params.fileId, gamenetId: req.gamenet.id, actor: req.user });
  res.json({ ok:true });
}));

router.get('/:gamenetId/tickets', requireTenant(), asyncHandler(async (req,res)=>{
  res.json({ tickets: listTickets({ gamenetId: req.gamenet.id, limit: 50 }) });
}));

router.post('/:gamenetId/tickets', requireTenant(), asyncHandler(async (req,res)=>{
  const { subject, priority } = req.body || {};
  if(!subject) return res.status(400).json({ error:'subject_required' });
  const t = createTicket({ userId: req.user.id, gamenetId: req.gamenet.id, subject, priority });
  res.status(201).json({ ticket: t });
}));
module.exports = router;
