'use strict';
const { db, tx } = require('../db');
const { publicId } = require('./ids');
const { audit } = require('./audit');
const { notify } = require('./notification');

function createTicket({ userId, gamenetId=null, subject, priority='normal' }){
  const pid = publicId('tk');
  const r = db.prepare(`INSERT INTO support_tickets(public_id,gamenet_id,user_id,subject,status,priority)
    VALUES(?,?,?,?,'open',?)`).run(pid, gamenetId, userId, subject, priority);
  const tid = r.lastInsertRowid;
  db.prepare(`INSERT INTO conversations(ticket_id,channel) VALUES(?,'ai')`).run(tid);
  audit({ actorUserId: userId, actorRole: 'customer', gamenetId, action: 'ticket.create', entity: 'ticket', entityId: tid });
  return getTicket(tid, userId);
}
function getTicket(id, forUserId=null, { forStaff=false } = {}){
  let sql = `SELECT * FROM support_tickets WHERE id=?`;
  const args = [id];
  if(!forStaff && forUserId != null){ sql += ` AND user_id=?`; args.push(forUserId); }
  const t = db.prepare(sql).get(...args);
  if(!t) return null;
  const conv = db.prepare(`SELECT * FROM conversations WHERE ticket_id=? ORDER BY id DESC LIMIT 1`).get(id);
  const messages = conv ? db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC`).all(conv.id) : [];
  return { ...t, conversation: conv, messages };
}
function listTickets({ userId=null, gamenetId=null, status=null, limit=50 }={}){
  let sql = `SELECT * FROM support_tickets WHERE 1=1`;
  const args = [];
  if(userId != null){ sql += ` AND user_id=?`; args.push(userId); }
  if(gamenetId != null){ sql += ` AND gamenet_id=?`; args.push(gamenetId); }
  if(status){ sql += ` AND status=?`; args.push(status); }
  sql += ` ORDER BY updated_at DESC, id DESC LIMIT ?`; args.push(limit);
  return db.prepare(sql).all(...args);
}
function addMessage({ ticketId, role, content, meta={} }){
  let conv = db.prepare(`SELECT * FROM conversations WHERE ticket_id=? ORDER BY id DESC LIMIT 1`).get(ticketId);
  if(!conv){
    const r = db.prepare(`INSERT INTO conversations(ticket_id,channel) VALUES(?, 'ai')`).run(ticketId);
    conv = { id: r.lastInsertRowid };
  }
  db.prepare(`INSERT INTO messages(conversation_id,role,content,meta_json) VALUES(?,?,?,?)`)
    .run(conv.id, role, content, JSON.stringify(meta));
  db.prepare(`UPDATE support_tickets SET updated_at=datetime('now') WHERE id=?`).run(ticketId);
  return true;
}
function escalateToHuman({ ticketId, actorUserId, reason='unresolved' }){
  const t = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(ticketId);
  if(!t){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  return tx(()=>{
    db.prepare(`UPDATE support_tickets SET status='waiting_human', escalated_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(ticketId);
    db.prepare(`INSERT INTO conversations(ticket_id,channel) VALUES(?,'human')`).run(ticketId);
    // notify support users
    const staff = db.prepare(`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role_code IN ('support','admin','super_admin') AND u.status='active'`).all();
    for(const s of staff){
      notify({ userId: s.id, gamenetId: t.gamenet_id, type: 'ticket_escalated', title: 'تیکت نیاز به انسان دارد', body: t.subject });
    }
    audit({ actorUserId, actorRole: 'system+user', gamenetId: t.gamenet_id, action: 'ticket.escalate', entity: 'ticket', entityId: ticketId, meta:{ reason } });
    return true;
  });
}
function replyAndMaybeResolve({ ticketId, actor, content, resolve=false, asRole='agent' }){
  const t = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(ticketId);
  if(!t){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  addMessage({ ticketId, role: asRole, content, meta:{ by: actor?.id||null } });
  if(resolve){
    db.prepare(`UPDATE support_tickets SET status='resolved', updated_at=datetime('now') WHERE id=?`).run(ticketId);
    notify({ userId: t.user_id, gamenetId: t.gamenet_id, type: 'ticket_resolved', title: 'تیکت بسته شد', body: t.subject });
  } else if(t.status === 'open'){
    db.prepare(`UPDATE support_tickets SET status='ai_handling', updated_at=datetime('now') WHERE id=?`).run(ticketId);
  }
  audit({ actorUserId: actor?.id||null, actorRole: actor?.roles?.join(',')||'', gamenetId: t.gamenet_id, action: resolve?'ticket.resolve':'ticket.reply', entity: 'ticket', entityId: ticketId });
  return getTicket(ticketId, null, { forStaff:true });
}
module.exports = { createTicket, getTicket, listTickets, addMessage, escalateToHuman, replyAndMaybeResolve };
