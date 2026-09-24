'use strict';
const { db } = require('../db');
const { licenseKey } = require('./ids');
const { audit } = require('./audit');

function issueLicense({ gamenetId, subscriptionId, expiresAt }){
  const key = licenseKey();
  db.prepare(`INSERT INTO licenses(gamenet_id,subscription_id,key,status,activated_at,expires_at)
    VALUES(?,?,?,'active',datetime('now'),?)`).run(gamenetId, subscriptionId, key, expiresAt);
  return db.prepare(`SELECT * FROM licenses WHERE gamenet_id=? AND status='active' ORDER BY id DESC LIMIT 1`).get(gamenetId);
}
function revokeAllLicenses(gamenetId, status='revoked'){
  db.prepare(`UPDATE licenses SET status=?, revoked_at=datetime('now') WHERE gamenet_id=? AND status='active'`).run(status, gamenetId);
}
function checkLicense(key){
  const lic = db.prepare(`SELECT l.*, g.name gamenet_name, g.status gamenet_status
    FROM licenses l JOIN gamenets g ON g.id=l.gamenet_id WHERE l.key=?`).get(key);
  if(!lic) return { valid:false, reason:'not_found' };
  if(lic.status !== 'active') return { valid:false, reason:lic.status, license:lic };
  if(lic.expires_at && lic.expires_at <= new Date().toISOString().slice(0,19).replace('T',' ')){
    db.prepare(`UPDATE licenses SET status='expired' WHERE id=?`).run(lic.id);
    return { valid:false, reason:'expired', license:lic };
  }
  if(lic.gamenet_status !== 'active') return { valid:false, reason:'tenant_'+lic.gamenet_status, license:lic };
  return { valid:true, license:lic };
}
function setLicenseStatus(licenseId, status, actor){
  const lic = db.prepare('SELECT * FROM licenses WHERE id=?').get(licenseId);
  if(!lic){ const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  db.prepare(`UPDATE licenses SET status=?, revoked_at=CASE WHEN ?='revoked' THEN datetime('now') ELSE revoked_at END WHERE id=?`).run(status, status, licenseId);
  audit({ actorUserId: actor?.id||null, actorRole: actor?.roles?.join(',')||'', gamenetId: lic.gamenet_id, action: 'license.status', entity: 'license', entityId: licenseId, meta:{ status } });
  return db.prepare('SELECT * FROM licenses WHERE id=?').get(licenseId);
}
module.exports = { issueLicense, revokeAllLicenses, checkLicense, setLicenseStatus };
