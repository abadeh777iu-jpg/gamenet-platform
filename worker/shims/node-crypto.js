'use strict';
// WebCrypto-backed subset for Workers — enough for sql.js randomFillSync and app hashes
const subtle = globalThis.crypto;

function toBuf(n){
  const b = new Uint8Array(n);
  subtle.getRandomValues(b);
  return Buffer.from(b);
}

module.exports = {
  randomFillSync(buf, offset, size){
    if(offset === undefined){
      subtle.getRandomValues(buf);
      return buf;
    }
    const end = size === undefined ? buf.byteLength : offset + size;
    const view = new Uint8Array(buf.buffer, buf.byteOffset + offset, end - offset);
    subtle.getRandomValues(view);
    return buf;
  },
  randomFill(buf, offset, size, cb){
    try{
      module.exports.randomFillSync(buf, offset, typeof size === 'number' ? size : undefined);
      if(typeof size === 'function') size(null, buf);
      else if(typeof offset === 'function') offset(null, buf);
      else if(cb) cb(null, buf);
    }catch(e){
      if(typeof size === 'function') size(e);
      else if(typeof offset === 'function') offset(e);
      else if(cb) cb(e);
    }
    return buf;
  },
  randomBytes(size){
    return toBuf(size);
  },
  randomUUID(){
    return subtle.randomUUID();
  },
  // Prefer real node:crypto when available (nodejs_compat), else fail loudly for missing APIs
  ...(() => {
    try {
      // eslint-disable-next-line
      const nc = require('node:crypto');
      if(nc && nc.createHash) return nc;
    } catch(e) {}
    return {};
  })(),
};
