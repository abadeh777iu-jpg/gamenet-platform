'use strict';
const crypto = require('crypto');
const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1, KEYLEN = 64;
function hashPassword(password){
  if(typeof password !== 'string' || password.length < 8) throw new Error('PASSWORD_TOO_SHORT');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored){
  try{
    if(!stored || !stored.startsWith('scrypt$')) return false;
    const [, n, saltB64, hashB64] = stored.split('$');
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: Number(n), r: SCRYPT_r, p: SCRYPT_p });
    return crypto.timingSafeEqual(actual, expected);
  }catch(e){ return false; }
}
module.exports = { hashPassword, verifyPassword };
