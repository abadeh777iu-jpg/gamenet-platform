'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');
const { audit } = require('./audit');

function createBackup(actor){
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const dest = path.join(config.backupsDir, `backup-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(dest);
  const jsonPath = path.join(config.backupsDir, `backup-${stamp}-meta.json`);
  const meta = {
    created_at: new Date().toISOString(),
    counts: {
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
      gamenets: db.prepare('SELECT COUNT(*) c FROM gamenets').get().c,
      subscriptions: db.prepare('SELECT COUNT(*) c FROM subscriptions').get().c,
      payments: db.prepare('SELECT COUNT(*) c FROM payments').get().c,
      tickets: db.prepare('SELECT COUNT(*) c FROM support_tickets').get().c,
    },
    file: path.basename(dest),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2));
  audit({ actorUserId: actor?.id||null, actorRole: actor?.roles?.join(',')||'system', action: 'backup.create', entity: 'backup', meta: meta.counts });
  return meta;
}
function listBackups(){
  if(!fs.existsSync(config.backupsDir)) return [];
  return fs.readdirSync(config.backupsDir)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const st = fs.statSync(path.join(config.backupsDir, f));
      return { name:f, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a,b)=> a.created_at < b.created_at ? 1 : -1);
}
/** Retention: keep last N backups */
function pruneBackups(keep=14){
  const all = listBackups();
  let removed = 0;
  for(const b of all.slice(keep)){
    try{ fs.unlinkSync(path.join(config.backupsDir, b.name)); removed++; }catch(e){}
  }
  return removed;
}
module.exports = { createBackup, listBackups, pruneBackups };
