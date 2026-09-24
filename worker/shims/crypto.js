'use strict';
// Workers crypto shim — sql.js only needs randomFillSync from node:crypto
const webcrypto = globalThis.crypto;
module.exports = {
  randomFillSync(buf, offset, size){
    if(offset === undefined){ webcrypto.getRandomValues(buf); return buf; }
    const end = size === undefined ? buf.byteLength : offset + size;
    const view = new Uint8Array(buf.buffer, buf.byteOffset + offset, end - offset);
    webcrypto.getRandomValues(view);
    return buf;
  },
  randomFill(buf, offset, size, cb){
    try{
      module.exports.randomFillSync(buf, offset, size);
      if(typeof offset === 'function') offset(null, buf);
      else if(typeof size === 'function') size(null, buf);
      else if(cb) cb(null, buf);
    }catch(e){
      if(typeof offset === 'function') offset(e);
      else if(typeof size === 'function') size(e);
      else if(cb) cb(e);
    }
  },
  randomBytes(n){
    const b = new Uint8Array(n);
    webcrypto.getRandomValues(b);
    return Buffer.from(b);
  },
  randomUUID(){ return webcrypto.randomUUID(); },
  webcrypto: webcrypto,
  // Prefer Node's crypto APIs under nodejs_compat when available via createRequire fallback:
  // For digest/hmac the app uses require('crypto') (not node:crypto) → still external node builtin under nodejs_compat.
};
