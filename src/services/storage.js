'use strict';
const { db, tx } = require('../db');
const { notify } = require('./notification');
const { audit } = require('./audit');

function ensureStorage(gamenetId){
  db.prepare(`INSERT OR IGNORE INTO storage_usage(gamenet_id) VALUES(?)`).run(gamenetId);
}
function recalcStorage(gamenetId){
  ensureStorage(gamenetId);
  const row = db.prepare(`SELECT COALESCE(SUM(size_bytes),0) used, COUNT(*) cnt
    FROM files WHERE gamenet_id=? AND deleted_at IS NULL`).get(gamenetId);
  db.prepare(`UPDATE storage_usage SET used_bytes=?, file_count=?, updated_at=datetime('now') WHERE gamenet_id=?`)
    .run(row.used, row.cnt, gamenetId);
  return getUsage(gamenetId);
}
function getUsage(gamenetId){
  ensureStorage(gamenetId);
  const g = db.prepare('SELECT storage_limit_bytes, owner_user_id, name FROM gamenets WHERE id=?').get(gamenetId);
  const u = db.prepare('SELECT * FROM storage_usage WHERE gamenet_id=?').get(gamenetId);
  const used = u ? u.used_bytes : 0;
  const limit = g ? g.storage_limit_bytes : 0;
  const ratio = limit > 0 ? used / limit : 0;
  // threshold alerts (80%, 95%)
  if(ratio >= 0.8 && g){
    const already = db.prepare(`SELECT id FROM notifications WHERE gamenet_id=? AND type='storage_warn' AND read_at IS NULL AND created_at > datetime('now','-1 day')`).get(gamenetId);
    if(!already){
      notify({ userId: g.owner_user_id, gamenetId, type: 'storage_warn', title: 'هشدار فضای ذخیره‌سازی', body: `مصرف فضا به ${Math.round(ratio*100)}% رسید.` });
    }
  }
  return { used_bytes: used, limit_bytes: limit, file_count: u ? u.file_count : 0, ratio, remaining_bytes: Math.max(0, limit - used) };
}
function canUpload(gamenetId, incomingBytes){
  const u = getUsage(gamenetId);
  return u.used_bytes + incomingBytes <= u.limit_bytes;
}
function registerFile({ gamenetId, uploaderUserId, filePath, originalName, sizeBytes, mime }){
  if(!canUpload(gamenetId, sizeBytes)) {
    const e = new Error('STORAGE_QUOTA_EXCEEDED'); e.status = 413; throw e;
  }
  return tx(()=>{
    const r = db.prepare(`INSERT INTO files(gamenet_id,uploader_user_id,path,original_name,size_bytes,mime)
      VALUES(?,?,?,?,?,?)`).run(gamenetId, uploaderUserId, filePath, originalName, sizeBytes, mime||'');
    recalcStorage(gamenetId);
    return db.prepare('SELECT * FROM files WHERE id=?').get(r.lastInsertRowid);
  });
}
function listFiles(gamenetId, { limit=100, offset=0, big=false } = {}){
  let sql = `SELECT * FROM files WHERE gamenet_id=? AND deleted_at IS NULL`;
  if(big) sql += ` AND size_bytes >= 10485760`;
  sql += ` ORDER BY size_bytes DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(gamenetId, limit, offset);
}
function deleteFile({ fileId, gamenetId, actor }){
  const f = db.prepare('SELECT * FROM files WHERE id=? AND gamenet_id=?').get(fileId, gamenetId);
  if(!f){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  db.prepare(`UPDATE files SET deleted_at=datetime('now') WHERE id=?`).run(fileId);
  recalcStorage(gamenetId);
  audit({ actorUserId: actor?.id, actorRole: actor?.roles?.join(',')||'', gamenetId, action: 'file.delete', entity: 'file', entityId: fileId });
  return true;
}
function globalStorageStats(){
  return db.prepare(`
    SELECT COUNT(DISTINCT su.gamenet_id) tenants,
           COALESCE(SUM(su.used_bytes),0) used,
           COALESCE(SUM(g.storage_limit_bytes),0) limit_bytes,
           COALESCE(SUM(su.file_count),0) files
    FROM storage_usage su JOIN gamenets g ON g.id=su.gamenet_id WHERE g.status!='deleted'
  `).get();
}
module.exports = { ensureStorage, recalcStorage, getUsage, canUpload, registerFile, listFiles, deleteFile, globalStorageStats };
