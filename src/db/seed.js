'use strict';
const crypto = require('crypto');
const { db, tx } = require('./index');
const { migrate } = require('./migrate');
const { hashPassword } = require('../services/password');
const { publicId } = require('../services/ids');
const { ensureStorage } = require('../services/storage');

migrate();

function seed(){
  const hasPlans = db.prepare('SELECT COUNT(*) c FROM plans').get().c > 0;
  if(!hasPlans){
    const ins = db.prepare(`INSERT INTO plans(code,name,price_cents,currency,duration_days,storage_bytes,max_users,features_json)
      VALUES(?,?,?,?,?,?,?,?)`);
    ins.run('basic','پایه',490000,'IRR',30,536870912,3,JSON.stringify(['داشبورد','تیکت','۵۱۲MB فضا']));
    ins.run('pro','حرفه‌ای',1290000,'IRR',30,5368709120,15,JSON.stringify(['همه امکانات پایه','۵GB فضا','اولویت پشتیبانی']));
    ins.run('business','کسب‌وکار',3990000,'IRR',30,21474836480,50,JSON.stringify(['۲۰GB فضا','چند کاربر','گزارش پیشرفته']));
    ins.run('pro_year','حرفه‌ای سالانه',12900000,'IRR',365,5368709120,15,JSON.stringify(['۲ ماه هدیه']));
    console.log('plans seeded');
  }
  const hasAdmin = db.prepare(`SELECT COUNT(*) c FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role_code='super_admin'`).get().c > 0;
  if(!hasAdmin){
    const email = 'admin@gamenet.local';
    const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    let uid;
    if(existing) uid = existing.id;
    else {
      const r = db.prepare(`INSERT INTO users(email,password_hash,name,email_verified_at) VALUES(?,?,?,datetime('now'))`)
        .run(email, hashPassword('Admin@12345'), 'مالک سیستم');
      uid = r.lastInsertRowid;
    }
    db.prepare('INSERT OR IGNORE INTO user_roles(user_id,role_code) VALUES(?,?)').run(uid,'super_admin');
    console.log('super admin seeded:', email, '/ Admin@12345 (change immediately)');
  }
  console.log('seed done');
}
if(require.main === module) seed();
module.exports = { seed };
