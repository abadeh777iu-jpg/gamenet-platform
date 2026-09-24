'use strict';
const { db } = require('../db');
function notify({ userId, gamenetId=null, type, title, body='' }){
  db.prepare(`INSERT INTO notifications(user_id,gamenet_id,type,title,body) VALUES(?,?,?,?,?)`)
    .run(userId, gamenetId, type, title, body);
}
function myNotifications(userId, { unreadOnly=false, limit=50 } = {}){
  let sql = `SELECT * FROM notifications WHERE user_id=?`;
  if(unreadOnly) sql += ` AND read_at IS NULL`;
  sql += ` ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).run ? db.prepare(sql).all(userId, limit) : [];
}
function markRead(userId, id){
  db.prepare(`UPDATE notifications SET read_at=datetime('now') WHERE id=? AND user_id=? AND read_at IS NULL`).run(id, userId);
}
function markAllRead(userId){
  db.prepare(`UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL`).run(userId);
}
module.exports = { notify, myNotifications, markRead, markAllRead };
