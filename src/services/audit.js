'use strict';
const { db } = require('../db');
function audit({ actorUserId=null, actorRole='', gamenetId=null, action, entity='', entityId='', meta={}, ip='' }){
  db.prepare(`INSERT INTO audit_logs(actor_user_id,actor_role,gamenet_id,action,entity,entity_id,meta_json,ip)
    VALUES(?,?,?,?,?,?,?,?)`).run(actorUserId, actorRole, gamenetId, action, entity, String(entityId), JSON.stringify(meta), ip||'');
}
function listAudit({ gamenetId=null, limit=100, offset=0, action='' }){
  let sql = `SELECT * FROM audit_logs WHERE 1=1`;
  const args = [];
  if(gamenetId != null){ sql += ` AND gamenet_id=?`; args.push(gamenetId); }
  if(action){ sql += ` AND action LIKE ?`; args.push(action + '%'); }
  sql += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
}
module.exports = { audit, listAudit };
