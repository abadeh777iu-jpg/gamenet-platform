'use strict';
const { expireDue } = require('../services/subscription');
const { flushOutbox } = require('../services/email');
const { recalcStorage } = require('../services/storage');
const { pruneBackups, createBackup } = require('../services/backup');
const { db } = require('../db');
const config = require('../config');
const { notify } = require('../services/notification');

let timer = null;

function jobExpireSubs(){
  try{
    const n = expireDue();
    if(n) console.log('[job] expired subscriptions:', n);
  }catch(e){ console.error('[job] expire', e); }
}
function jobEmailFlush(){
  try{ flushOutbox(); }catch(e){ console.error('[job] email', e); }
}
function jobStorageRecalc(){
  try{
    const ids = db.prepare(`SELECT id FROM gamenets WHERE status='active'`).all();
    for(const g of ids) recalcStorage(g.id);
  }catch(e){ console.error('[job] storage', e); }
}
function jobBackupDaily(){
  try{
    if(config.isProd || process.env.ENABLE_DAILY_BACKUP === '1'){
      createBackup({ id:null, roles:['system'] });
      pruneBackups(14);
      console.log('[job] backup done');
    }
  }catch(e){ console.error('[job] backup', e); }
}
function jobStorageNotify(){
  try{
    const rows = db.prepare(`SELECT g.id, g.owner_user_id, su.used_bytes, g.storage_limit_bytes
      FROM storage_usage su JOIN gamenets g ON g.id=su.gamenet_id
      WHERE g.status='active' AND su.used_bytes > g.storage_limit_bytes * 0.95`).all();
    for(const r of rows){
      notify({ userId:r.owner_user_id, gamenetId:r.id, type:'storage_critical', title:'فضا تقریباً پر است', body:'بیش از ۹۵٪ فضا مصرف شده است.' });
    }
  }catch(e){ console.error('[job] storage-notify', e); }
}

function startJobs(){
  if(timer) return;
  // every minute: lightweight
  timer = setInterval(()=>{ jobExpireSubs(); jobEmailFlush(); }, 60000);
  timer.unref?.();
  setInterval(jobStorageRecalc, 300000).unref?.();   // 5 min
  setInterval(jobStorageNotify, 600000).unref?.();   // 10 min
  setInterval(jobBackupDaily, 6*3600000).unref?.();  // 6h (daily backup also on boot in prod)
  // run once on boot
  jobExpireSubs(); jobEmailFlush();
  if(config.isProd || process.env.ENABLE_DAILY_BACKUP === '1') jobBackupDaily();
  console.log('[jobs] scheduler started');
}
function stopJobs(){ if(timer){ clearInterval(timer); timer=null; } }
module.exports = { startJobs, stopJobs, jobExpireSubs, jobStorageRecalc, jobBackupDaily };
