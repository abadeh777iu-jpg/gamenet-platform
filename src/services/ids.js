'use strict';
const crypto = require('crypto');
function publicId(prefix=''){
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(9).toString('base64url');
}
function randomToken(bytes=32){ return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(s){ return crypto.createHash('sha256').update(s).digest('hex'); }
function licenseKey(){
  const part = () => crypto.randomBytes(4).toString('hex').toUpperCase();
  return `GN-${part()}-${part()}-${part()}`;
}
module.exports = { publicId, randomToken, sha256, licenseKey };
